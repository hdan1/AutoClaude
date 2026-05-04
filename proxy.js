const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./lib/logger');
const claudeDetector = require('./lib/claude-detector');
const { runPtyCommand, classifyPtyRun, normalizePtyError } = require('./lib/pty-executor');
const { parseLine, appendFullText } = require('./lib/stream-parser');
const {
  startHookWatcher, flushHookLog, stopHookWatcher, startWorktreeHookWatcher,
} = require('./lib/hook-watcher');
const {
  resolveExecutionPlan, buildPrintModeArgs, buildSDKModeArgs,
  normalizeCliResultError, parsePluginSlashCommand, parseSlashCommand,
  normalizePrompt, shouldPassSessionModel, mapSlashCommandToCliArgs,
  getSlashFallbackConfig,
} = require('./lib/proxy-args');
const {
  RETRYABLE_PATTERNS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_SECONDS,
  PROCESS_CLOSE_FLUSH_MS,
  RING_BUFFER_TOOL_CALLS,
  SDK_MIN_VERSION,
  SDK_KEEPALIVE_INTERVAL_MS,
} = require('./lib/constants');

class ClaudeProxy extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.aborted = false;
    this.hookWatcher = null;
    this.hookByteOffset = 0;
    this.worktreeHookWatcher = null;
    this.worktreeHookByteOffset = 0;
    this.worktreeDir = null;
    this._readCounts = new Map();
    this.sdkMode = false;
    this._keepAliveTimer = null;
  }

  run(projectDir, options) {
    return this._runWithRetry(projectDir, options, 0);
  }

  kill() {
    return new Promise((resolve) => {
      this.aborted = true;
      this._stopHookWatcher();
      if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
      if (!this.process) { resolve(); return; }
      const pid = this.process.pid;
      const proc = this.process;
      this.process = null;

      const timeout = setTimeout(() => {
        try {
          if (os.platform() === 'win32' && pid) {
            execFile('taskkill', ['/F', '/T', '/PID', String(pid)],
              { timeout: 3000, windowsHide: true }, () => {});
          } else if (pid) {
            process.kill(pid, 'SIGKILL');
          }
        } catch { /* already dead */ }
        setTimeout(resolve, 500);
      }, 3000);

      proc.on('close', () => { clearTimeout(timeout); resolve(); });

      try {
        if (os.platform() === 'win32' && pid) {
          execFile('taskkill', ['/T', '/PID', String(pid)],
            { timeout: 5000, windowsHide: true }, () => {});
        } else {
          proc.kill('SIGTERM');
        }
      } catch (e) {
        logger.debug('proxy', `kill failed for PID ${pid}: ${e.message}`);
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  sendResponse(text) {
    this.emit('response-ready', text);
    return true;
  }

  async _runWithRetry(projectDir, options, attempt) {
    const result = await this._execute(projectDir, options);

    if (result.error && this.config.retry?.enabled && !this.aborted) {
      const maxRetries = this.config.retry.maxRetries || DEFAULT_MAX_RETRIES;
      const backoff = this.config.retry.backoffSeconds || DEFAULT_BACKOFF_SECONDS;

      if (attempt < maxRetries && this._isRetryable(result.error)) {
        const waitSecs = backoff[Math.min(attempt, backoff.length - 1)];
        this.emit('retry', { attempt: attempt + 1, maxRetries, waitSecs, error: result.error });
        await this._sleep(waitSecs * 1000);
        if (this.aborted) return result;
        return this._runWithRetry(projectDir, options, attempt + 1);
      }
    }
    return result;
  }

  _isRetryable(error) {
    const lower = (error || '').toLowerCase();
    return RETRYABLE_PATTERNS.some(p => lower.includes(p));
  }

  _execute(projectDir, options) {
    this._lastProjectDir = projectDir;
    const result = {
      startTime: Date.now(), firstTokenTime: null, endTime: null, ttft: null,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      costUsd: 0, numTurns: 0, model: '', sessionId: null,
      timeline: [], hookEvents: [], toolCalls: [], fullText: '',
      resultText: null, error: null, exitCode: null, askedQuestion: false,
      hasTrustedInputTokens: false,
    };

    this._startHookWatcher(projectDir, result);
    const plan = ClaudeProxy._resolveExecutionPlan(options, this.config);
    this.emit('event', { type: 'execution-mode', mode: plan.mode, reason: plan.reason, prompt: plan.originalPrompt });

    if (plan.mode === 'pty-fallback') {
      return (async () => {
        try {
          const raw = await runPtyCommand({
            cwd: projectDir, prompt: plan.originalPrompt,
            timeoutMs: plan.timeoutMs, skipPermissions: this.config.skipPermissions !== false,
          });
          const classified = classifyPtyRun(raw);
          ClaudeProxy._applyPtyFallbackResult(result, { ...classified, stdout: raw.stdout, stderr: raw.stderr });
          this._mergeToolCalls(result);
          return result;
        } catch (err) {
          result.error = normalizePtyError(err);
          this._mergeToolCalls(result);
          return result;
        }
      })();
    }

    this.sdkMode = this._supportsSDKMode();
    if (this.sdkMode) return this._executeSDK(projectDir, options, plan, result);
    return this._executePrintMode(projectDir, options, plan, result);
  }

  async _executePrintMode(projectDir, options, plan, result) {
    const args = plan.args;
    const detection = await claudeDetector.detect();
    const claudeBin = (detection.path && detection.path !== 'claude') ? detection.path : 'claude';
    const spawnEnv = this._buildSpawnEnv(projectDir);
    return new Promise((resolve) => {
      this.process = spawn(claudeBin, args, {
        cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, windowsHide: true,
      });
      this.process.stdin.end();

      let buffer = '';
      this.process.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim()) this._parseLine(line, result);
        }
      });
      let stderrBuf = '';
      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        this.emit('stderr', text);
        if (this._isRetryable(text)) result.error = text.trim();
      });
      this.process.on('error', (err) => {
        if (err.code === 'ENOENT') {
          result.error = 'Claude CLI not found. Please install it: npm install -g @anthropic-ai/claude-code';
          this.emit('process-error', result.error);
        } else {
          result.error = err.message;
          this.emit('process-error', err.message);
        }
      });
      this.process.on('close', (code) => {
        this.process = null;
        result.exitCode = code;
        result.endTime = Date.now();
        if (code && code !== 0 && !result.error && stderrBuf.trim()) {
          result.error = stderrBuf.trim().slice(0, 2000);
        }
        if (buffer.trim()) this._parseLine(buffer, result);
        if (result.firstTokenTime) result.ttft = result.firstTokenTime - result.startTime;
        setTimeout(async () => {
          await this._flushHookLog(projectDir, result);
          this._stopHookWatcher();
          this._mergeToolCalls(result);
          resolve(result);
        }, PROCESS_CLOSE_FLUSH_MS);
      });
    });
  }

  async _executeSDK(projectDir, options, plan, result) {
    const prompt = options?.prompt || '';
    const args = ClaudeProxy._buildSDKModeArgs(prompt, options, this.config);
    const detection = await claudeDetector.detect();
    const claudeBin = (detection.path && detection.path !== 'claude') ? detection.path : 'claude';
    const spawnEnv = this._buildSpawnEnv(projectDir);
    spawnEnv.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = 'true';
    return new Promise((resolve) => {
      this.process = spawn(claudeBin, args, {
        cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, windowsHide: true,
      });
      this._keepAliveTimer = setInterval(() => this.sendKeepAlive(), SDK_KEEPALIVE_INTERVAL_MS);

      let buffer = '';
      this.process.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim()) this._parseLine(line, result);
        }
      });
      let stderrBuf = '';
      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        this.emit('stderr', text);
        if (this._isRetryable(text)) result.error = text.trim();
      });
      this.process.on('error', (err) => {
        if (err.code === 'ENOENT') {
          result.error = 'Claude CLI not found. Please install it: npm install -g @anthropic-ai/claude-code';
          this.emit('process-error', result.error);
        } else {
          result.error = err.message;
          this.emit('process-error', err.message);
        }
      });
      this.process.on('close', (code) => {
        if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
        this.process = null;
        result.exitCode = code;
        result.endTime = Date.now();
        if (code && code !== 0 && !result.error && stderrBuf.trim()) {
          result.error = stderrBuf.trim().slice(0, 2000);
        }
        if (buffer.trim()) this._parseLine(buffer, result);
        if (result.firstTokenTime) result.ttft = result.firstTokenTime - result.startTime;
        setTimeout(async () => {
          await this._flushHookLog(projectDir, result);
          this._stopHookWatcher();
          this._mergeToolCalls(result);
          resolve(result);
        }, PROCESS_CLOSE_FLUSH_MS);
      });
    });
  }

  _buildSpawnEnv(projectDir) {
    const extraPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.claude', 'local'),
    ];
    const spawnEnv = { ...process.env };
    spawnEnv.PATH = extraPaths.join(path.delimiter) + path.delimiter + (spawnEnv.PATH || '');
    if (fs.existsSync(path.join(projectDir, 'build.gradle')) ||
        fs.existsSync(path.join(projectDir, 'build.gradle.kts')) ||
        fs.existsSync(path.join(projectDir, 'pom.xml'))) {
      const javaHome = process.env.JAVA_HOME || process.env.JAVA_HOME_ALT;
      if (javaHome) spawnEnv.JAVA_HOME = javaHome;
    }
    return spawnEnv;
  }

  // Delegated methods
  _parseLine(line, result) { parseLine(this, line, result); }
  _appendFullText(result, text) { appendFullText(this, result, text); }
  _startHookWatcher(projectDir, result) { startHookWatcher(this, projectDir, result); }
  async _flushHookLog(projectDir, result) { await flushHookLog(this, projectDir, result); }
  _stopHookWatcher() { stopHookWatcher(this); }
  _startWorktreeHookWatcher(worktreeDir, result) { startWorktreeHookWatcher(this, worktreeDir, result); }

  _mergeToolCalls(result) {
    result.toolCalls = result.hookEvents
      .filter(e => e.event === 'PostToolUse' || e.event === 'SubagentStop')
      .map(e => ({
        tool: e.tool || 'subagent-stop', input: e.input || '',
        isSubagent: !!e.agentId, agentId: e.agentId, agentType: e.agentType,
        isError: e.isError || false, timestamp: e.ts,
      }));
    if (result.toolCalls.length > RING_BUFFER_TOOL_CALLS) result.toolCalls = result.toolCalls.slice(-RING_BUFFER_TOOL_CALLS);
  }

  // SDK mode
  _supportsSDKMode() {
    try {
      const version = this.config._claudeVersion || '';
      return this._compareVersions(version, SDK_MIN_VERSION) >= 0;
    } catch { return false; }
  }

  _compareVersions(a, b) {
    const pa = (a || '0.0.0').split('.').map(Number);
    const pb = (b || '0.0.0').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  _sendToStdin(message) {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) return false;
    try {
      this.process.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch (e) {
      logger.debug('proxy', `stdin write failed: ${e.message}`);
      return false;
    }
  }

  sendControlResponse(toolUseId, decision) {
    return this._sendToStdin({ type: 'control_response', tool_use_id: toolUseId, decision });
  }

  sendKeepAlive() { return this._sendToStdin({ type: 'keep_alive' }); }

  // Static delegates for backward compatibility (tests reference ClaudeProxy._xxx)
  static _shouldPassSessionModel(p) { return shouldPassSessionModel(p); }
  static _normalizeCliResultError(m) { return normalizeCliResultError(m); }
  static _parsePluginSlashCommand(p) { return parsePluginSlashCommand(p); }
  static _parseSlashCommand(p) { return parseSlashCommand(p); }
  static _buildPrintModeArgs(o, c, ov) { return buildPrintModeArgs(o, c, ov); }
  static _mapSlashCommandToCliArgs(o, c) { return mapSlashCommandToCliArgs(o, c); }
  static _getSlashFallbackConfig(c) { return getSlashFallbackConfig(c); }
  static _resolveExecutionPlan(o, c) { return resolveExecutionPlan(o, c); }
  static _buildCliArgs(o, c) { return resolveExecutionPlan(o, c).args; }
  static _buildSDKModeArgs(p, o, c) { return buildSDKModeArgs(p, o, c); }
  static _normalizePrompt(p) { return normalizePrompt(p); }

  static _applyPtyFallbackResult(result, classified) {
    result.exitCode = classified.exitCode;
    result.resultText = classified.summary;
    if (!classified.ok) result.error = classified.summary;
    const ptyText = [classified.stdout, classified.stderr, classified.summary]
      .filter(Boolean).join('\n').trim();
    if (ptyText) {
      result.fullText = ptyText;
      result.inputTokens = Math.ceil(ptyText.length / 4);
      result.hasTrustedInputTokens = false;
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = ClaudeProxy;
