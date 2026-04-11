const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./lib/logger');
const claudeDetector = require('./lib/claude-detector');
const summarize = require('./lib/summarize');
const { runPtyCommand, classifyPtyRun, normalizePtyError } = require('./lib/pty-executor');
const {
  RETRYABLE_PATTERNS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_SECONDS,
  HOOK_POLL_INTERVAL_MS,
  PROCESS_CLOSE_FLUSH_MS,
  MAX_FULL_TEXT_BYTES,
  RING_BUFFER_TIMELINE,
  RING_BUFFER_HOOK_EVENTS,
  RING_BUFFER_TOOL_CALLS,
  QUESTION_TOOL_NAMES,
  MAX_HOOK_LOG_BYTES,
} = require('./lib/constants');

class ClaudeProxy extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.aborted = false;
    this.hookWatcher = null;
    this.hookByteOffset = 0; // M1: Track byte offset instead of line offset
    this.worktreeHookWatcher = null;
    this.worktreeHookByteOffset = 0;
    this.worktreeDir = null;
    this._readCounts = new Map(); // Track file read counts for redundancy detection
  }

  run(projectDir, options) {
    return this._runWithRetry(projectDir, options, 0);
  }

  kill() {
    return new Promise((resolve) => {
      this.aborted = true;
      this._stopHookWatcher();
      if (!this.process) { resolve(); return; }
      const pid = this.process.pid;
      const proc = this.process;
      this.process = null;

      const timeout = setTimeout(() => resolve(), 5000);
      proc.on('close', () => { clearTimeout(timeout); resolve(); });

      try {
        // On Windows, SIGTERM only kills the parent shell, not child processes.
        // Use async execFile with taskkill /T to kill the entire process tree
        // without blocking the main process (PERF-04).
        if (os.platform() === 'win32' && pid) {
          execFile('taskkill', ['/T', '/PID', String(pid), '/F'],
            { timeout: 5000, windowsHide: true }, () => {});
        } else {
          proc.kill('SIGTERM');
        }
      } catch (e) { logger.debug('proxy', `kill failed for PID ${pid}: ${e.message}`); resolve(); }
    });
  }

  sendResponse(text) {
    // In --print mode, stdin is closed after spawn. Responses are sent by
    // emitting 'response-ready' so main.js can spawn a continuation turn
    // with --continue -p "answer".
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
    return new Promise((resolve) => {
      const result = {
        startTime: Date.now(),
        firstTokenTime: null,
        endTime: null,
        ttft: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0,
        numTurns: 0,
        model: '',
        sessionId: null,
        timeline: [],
        hookEvents: [],
        toolCalls: [],
        fullText: '',
        resultText: null,
        error: null,
        exitCode: null,
      };

      // Start watching the hook log for subagent activity
      this._startHookWatcher(projectDir, result);

      const plan = ClaudeProxy._resolveExecutionPlan(options, this.config);
      this.emit('event', { type: 'execution-mode', mode: plan.mode, reason: plan.reason, prompt: plan.originalPrompt });

      if (plan.mode === 'pty-fallback') {
        (async () => {
          try {
            const raw = await runPtyCommand({
              cwd: projectDir,
              prompt: plan.originalPrompt,
              timeoutMs: plan.timeoutMs,
              skipPermissions: this.config.skipPermissions !== false,
            });
            const classified = classifyPtyRun(raw);
            ClaudeProxy._applyPtyFallbackResult(result, { ...classified, stdout: raw.stdout, stderr: raw.stderr });
            this._mergeToolCalls(result);
            return resolve(result);
          } catch (err) {
            result.error = normalizePtyError(err);
            this._mergeToolCalls(result);
            return resolve(result);
          }
        })();
        return;
      }

      // Build CLI args based on mode
      const args = plan.args;

      // Stdin piped for sendResponse() but ended immediately to prevent
      // Claude CLI's 3-second stdin wait warning. stdin.end() signals no
      // piped input; sendResponse() reopens the write channel when needed.
      // Resolve claude binary path — packaged Electron apps may not have
      // ~/.local/bin on PATH, so use the absolute path when available.
      const detection = claudeDetector.detect();
      const claudeBin = (detection.path && detection.path !== 'claude') ? detection.path : 'claude';
      // Extend PATH with common install dirs so claude can find its deps
      const extraPaths = [
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.claude', 'local'),
      ];
      const spawnEnv = { ...process.env };
      spawnEnv.PATH = extraPaths.join(path.delimiter) + path.delimiter + (spawnEnv.PATH || '');
      this.process = spawn(claudeBin, args, {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        windowsHide: true,
      });
      // End stdin immediately to avoid "no stdin data received in 3s" warning.
      // sendResponse() will still work because stdin.end() flushes but keeps
      // the writable stream reference valid for future writes before close.
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

      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.emit('stderr', text);
        if (this._isRetryable(text)) result.error = text.trim();
      });

      this.process.on('error', (err) => {
        // L6: Graceful handling of claude CLI not found
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
        if (buffer.trim()) this._parseLine(buffer, result);
        if (result.firstTokenTime) result.ttft = result.firstTokenTime - result.startTime;

        // M6: Give hooks a moment to flush, then read final state
        setTimeout(() => {
          this._flushHookLog(projectDir, result);
          this._stopHookWatcher();
          this._mergeToolCalls(result);
          resolve(result);
        }, PROCESS_CLOSE_FLUSH_MS);
      });
    });
  }

  // ── Stream-JSON parsing (top-level agent only) ─────

  _parseLine(line, result) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      this.emit('raw', line);
      this._appendFullText(result, line + '\n');
      return;
    }

    const elapsed = Date.now() - result.startTime;
    const type = event.type;

    if (type === 'system') {
      if (event.subtype === 'init' && event.session_id) {
        result.sessionId = event.session_id;
        this.emit('session-init', {
          sessionId: event.session_id,
          model: event.model,
          version: event.claude_code_version,
        });
      }
      if (event.model) result.model = event.model;
      result.timeline.push({ time: elapsed, type: 'system', data: { model: event.model } });
      if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
      this.emit('event', { type: 'system', event, elapsed });
      // Emit real-time metrics update with model
      this.emit('metrics', { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    }

    else if (type === 'assistant') {
      const msg = event.message;
      if (!msg) return;
      if (!result.firstTokenTime && msg.content?.length > 0) {
        result.firstTokenTime = Date.now();
        result.ttft = result.firstTokenTime - result.startTime;
        // Emit TTFT as soon as first token arrives
        this.emit('metrics', { ttft: result.ttft, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      }
      if (msg.usage) {
        result.inputTokens += msg.usage.input_tokens || 0;
        result.outputTokens += msg.usage.output_tokens || 0;
        // Emit real-time token count updates
        this.emit('metrics', { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      }
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            this._appendFullText(result, block.text);
            result.timeline.push({ time: elapsed, type: 'text', data: { text: block.text } });
            if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
            this.emit('event', { type: 'text', text: block.text, elapsed });
          }
          if (block.type === 'tool_use') {
            const summary = summarize(block.name, block.input);
            result.timeline.push({
              time: elapsed, type: 'tool_use',
              data: { id: block.id, name: block.name, input: summary, isSubagent: false },
            });
            if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
            this.emit('event', { type: 'tool_use', name: block.name, input: summary, elapsed });
            if (QUESTION_TOOL_NAMES.includes(block.name)) {
              this.emit('ask-user-question', { input: block.input, id: block.id, elapsed });
            }
          }
        }
      }
    }

    else if (type === 'user') {
      const msg = event.message;
      if (!msg?.content) return;
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          result.timeline.push({
            time: elapsed, type: 'tool_result',
            data: { id: block.tool_use_id, isError: block.is_error || false },
          });
          if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
          this.emit('event', { type: 'tool_result', isError: block.is_error, elapsed });
        }
      }
    }

    else if (type === 'result') {
      result.numTurns = event.num_turns || 0;

      // Token data: try top-level fields first (older CLI), then result.usage (current CLI)
      const inTok = event.total_input_tokens || event.usage?.input_tokens || 0;
      const outTok = event.total_output_tokens || event.usage?.output_tokens || 0;
      if (inTok) result.inputTokens = inTok;
      if (outTok) result.outputTokens = outTok;
      result.cacheReadTokens = event.usage?.cache_read_input_tokens || 0;
      result.cacheCreateTokens = event.usage?.cache_creation_input_tokens || 0;
      if (event.total_cost_usd) result.costUsd = event.total_cost_usd;

      // Emit final token counts (may be the only token data if per-message usage wasn't available)
      this.emit('metrics', {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreateTokens: result.cacheCreateTokens,
        costUsd: result.costUsd,
      });
      result.timeline.push({
        time: elapsed, type: 'result',
        data: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, numTurns: result.numTurns },
      });
      if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
      this.emit('event', { type: 'result', event, elapsed });
      if (event.subtype === 'error') result.error = event.error || 'Unknown error';

      // Capture CLI result text (e.g. "Unknown skill: ..." or other messages)
      if (event.result && typeof event.result === 'string') {
        result.resultText = event.result;
        // Detect zero-token failures disguised as success (e.g. unknown skill/command)
        if (!result.error && result.inputTokens === 0 && result.outputTokens === 0) {
          const rt = event.result.toLowerCase();
          if (rt.startsWith('unknown skill') || rt.startsWith('unknown command') || rt.startsWith('error:')) {
            result.error = ClaudeProxy._normalizeCliResultError(event.result);
          }
        }
      }
    }
  }

  // M3: Cap fullText accumulation to prevent unbounded memory growth
  _appendFullText(result, text) {
    // Detect worktree creation and start secondary hook watcher
    if (!this.worktreeDir) {
      const wtMatch = text.match(/\.claude[\/\\]worktrees[\/\\]([\w.-]+)/);
      if (wtMatch && this._lastProjectDir) {
        const wtPath = path.join(this._lastProjectDir, '.claude', 'worktrees', wtMatch[1]);
        this._startWorktreeHookWatcher(wtPath, result);
      }
    }

    if (result.fullText.length < MAX_FULL_TEXT_BYTES) {
      result.fullText += text;
      if (result.fullText.length > MAX_FULL_TEXT_BYTES) {
        // Keep the last MAX_FULL_TEXT_BYTES worth of text for detection functions
        result.fullText = result.fullText.slice(-MAX_FULL_TEXT_BYTES);
      }
    } else {
      // Sliding window: drop oldest, keep newest
      result.fullText = (result.fullText + text).slice(-MAX_FULL_TEXT_BYTES);
    }
  }

  // ── Hook log watcher (sees subagent tool calls) ────

  _startHookWatcher(projectDir, result) {
    const logFile = path.join(projectDir, this.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');

    // Ensure directory exists (but do NOT truncate — other tabs may be reading)
    try {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch { /* silent */ }

    // Record current file size as starting offset (only read events written after this point)
    try {
      const stat = fs.statSync(logFile);
      this.hookByteOffset = stat.size;
    } catch {
      this.hookByteOffset = 0;
    }

    // M1: Poll with byte offset reads instead of re-reading entire file
    this.hookWatcher = setInterval(() => {
      this._readHookLog(logFile, result);
    }, HOOK_POLL_INTERVAL_MS);
  }

  // M1: Read only new bytes from hook log using byte offset
  _readHookLog(logFile, result) {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size < this.hookByteOffset) { this.hookByteOffset = 0; }
      if (stat.size === this.hookByteOffset) return; // No new data

      // Cap check: truncate from top if file exceeds max size
      const maxBytes = ((this.config.hooks?.maxLogSizeMB || 5) * 1024 * 1024) || MAX_HOOK_LOG_BYTES;
      if (stat.size > maxBytes) {
        try {
          const all = fs.readFileSync(logFile, 'utf8');
          const lines = all.split('\n').filter(l => l.trim());
          const keep = lines.slice(Math.floor(lines.length / 2));
          // R4: Atomic truncation — write to temp, rename over original
          const tmpFile = logFile + '.tmp';
          fs.writeFileSync(tmpFile, keep.join('\n') + '\n');
          fs.renameSync(tmpFile, logFile);
          this.hookByteOffset = fs.statSync(logFile).size;
          return;
        } catch (e) { logger.debug('proxy', `hook log truncation failed: ${e.message}`); }
      }

      // Read only new bytes
      const newBytes = stat.size - this.hookByteOffset;
      const buf = Buffer.alloc(newBytes);
      const fd = fs.openSync(logFile, 'r');
      try {
        fs.readSync(fd, buf, 0, newBytes, this.hookByteOffset);
      } finally {
        fs.closeSync(fd);
      }

      this.hookByteOffset = stat.size;

      // Parse new lines
      const newContent = buf.toString('utf8');
      const lines = newContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          result.hookEvents.push(entry);
          if (result.hookEvents.length > RING_BUFFER_HOOK_EVENTS) result.hookEvents = result.hookEvents.slice(-RING_BUFFER_HOOK_EVENTS);
          this.emit('hook-event', entry);
          // Track redundant file reads
          this._trackRedundantReads(entry);
        } catch (err) { logger.debug('proxy', `JSON parse failed: ${err.message}`); }
      }
    } catch (err) { logger.debug('proxy', `hook log read failed: ${err.message}`); }
  }

  _flushHookLog(projectDir, result) {
    const logFile = path.join(projectDir, this.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');
    this._readHookLog(logFile, result);
  }

  // Detect when the same file is read 3+ times in one session (token waste signal)
  _trackRedundantReads(entry) {
    const toolName = entry.tool_name || entry.tool || '';
    if (toolName !== 'Read') return;
    const filePath = entry.input?.file_path || entry.file_path || '';
    if (!filePath) return;
    const count = (this._readCounts.get(filePath) || 0) + 1;
    this._readCounts.set(filePath, count);
    if (count >= 3) {
      const fileName = path.basename(filePath);
      this.emit('redundant-reads', { filePath, fileName, count });
    }
  }

  _stopHookWatcher() {
    if (this.hookWatcher) {
      clearInterval(this.hookWatcher);
      this.hookWatcher = null;
    }
    if (this.worktreeHookWatcher) {
      clearInterval(this.worktreeHookWatcher);
      this.worktreeHookWatcher = null;
    }
  }

  // Start secondary hook watcher for worktree directory
  _startWorktreeHookWatcher(worktreeDir, result) {
    if (this.worktreeDir) return; // Already watching
    this.worktreeDir = worktreeDir;
    const logFile = path.join(worktreeDir, this.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');

    try {
      const stat = fs.statSync(logFile);
      this.worktreeHookByteOffset = stat.size;
    } catch {
      this.worktreeHookByteOffset = 0;
    }

    this.worktreeHookWatcher = setInterval(() => {
      this._readWorktreeHookLog(logFile, result);
    }, HOOK_POLL_INTERVAL_MS);
  }

  _readWorktreeHookLog(logFile, result) {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size < this.worktreeHookByteOffset) { this.worktreeHookByteOffset = 0; }
      if (stat.size === this.worktreeHookByteOffset) return;

      const fd = fs.openSync(logFile, 'r');
      const newBytes = stat.size - this.worktreeHookByteOffset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, newBytes, this.worktreeHookByteOffset);
      fs.closeSync(fd);
      this.worktreeHookByteOffset = stat.size;

      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          result.hookEvents.push(entry);
          if (result.hookEvents.length > RING_BUFFER_HOOK_EVENTS) result.hookEvents = result.hookEvents.slice(-RING_BUFFER_HOOK_EVENTS);
          this.emit('hook-event', entry);
        } catch { /* silent */ }
      }
    } catch { /* silent */ }
  }

  // ── Merge stream timeline + hook events into unified tool call list ──

  _mergeToolCalls(result) {
    result.toolCalls = result.hookEvents
      .filter(e => e.event === 'PostToolUse' || e.event === 'SubagentStop')
      .map(e => ({
        tool: e.tool || 'subagent-stop',
        input: e.input || '',
        isSubagent: !!e.agentId,
        agentId: e.agentId,
        agentType: e.agentType,
        isError: e.isError || false,
        timestamp: e.ts,
      }));
    if (result.toolCalls.length > RING_BUFFER_TOOL_CALLS) result.toolCalls = result.toolCalls.slice(-RING_BUFFER_TOOL_CALLS);
  }

  static _shouldPassSessionModel(prompt) {
    return !(prompt && /^\/model(?:\s|$)/i.test(prompt.trim()));
  }

  static _normalizeCliResultError(message) {
    if (typeof message !== 'string') return message;
    const trimmed = message.trim();
    if (/^Unknown skill:\s*model\s*$/i.test(trimmed)) {
      return 'Unknown skill: model (this Claude Code environment does not expose /model; use session model setting or --model).';
    }
    const m = trimmed.match(/^Unknown skill:\s*([a-z0-9_-]+)\s*$/i);
    if (m) {
      const skill = m[1].toLowerCase();
      const interactiveOnly = new Set(['clear', 'compact', 'config', 'cost', 'init', 'memory', 'review', 'status', 'terminal-setup']);
      if (interactiveOnly.has(skill)) {
        return `Unknown skill: ${skill} (built-in slash commands are interactive-only in this print-mode flow; use Auto Claude controls or mapped CLI equivalents).`;
      }
    }
    return message;
  }

  static _parsePluginSlashCommand(prompt) {
    if (typeof prompt !== 'string') return null;
    const trimmed = prompt.trim();
    const m = trimmed.match(/^\/(plugin|plugins)(?:\s+(.*))?$/i);
    if (!m) return null;
    const rest = (m[2] || '').trim();
    return rest ? rest.split(/\s+/).filter(Boolean) : [];
  }

  static _parseSlashCommand(prompt) {
    if (typeof prompt !== 'string') return null;
    const trimmed = prompt.trim();
    const m = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
    if (!m) return null;
    const command = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    const args = rest ? rest.split(/\s+/).filter(Boolean) : [];
    return { command, args, raw: trimmed };
  }

  static _buildPrintModeArgs(options, config, overrides = {}) {
    const args = ['--output-format', 'stream-json', '--verbose'];
    if (config?.skipPermissions !== false) args.push('--dangerously-skip-permissions');
    if (options?.mode === 'resume' && options?.sessionId) args.push('-r', options.sessionId);
    if (options?.mode === 'continue') {
      args.push('--continue');
      if (options?.sessionId) args.push('-r', options.sessionId);
    }

    const prompt = overrides.prompt !== undefined ? overrides.prompt : options?.prompt;
    if (prompt) args.push('-p', ClaudeProxy._normalizePrompt(prompt));

    const shouldPassSessionModel = !overrides.forceSkipDefaultModel && ClaudeProxy._shouldPassSessionModel(prompt);
    if (overrides.model && overrides.model !== 'auto') {
      args.push('--model', overrides.model);
    } else if (shouldPassSessionModel && config?.session?.model && config.session.model !== 'auto') {
      args.push('--model', config.session.model);
    }

    if (config?.session?.effort && config.session.effort !== 'auto') {
      args.push('--effort', config.session.effort);
    }
    return args;
  }

  static _mapSlashCommandToCliArgs(options, config) {
    const slash = ClaudeProxy._parseSlashCommand(options?.prompt);
    if (!slash) return null;

    if (slash.command === 'plugin' || slash.command === 'plugins') {
      return ['plugins', ...slash.args];
    }
    if (slash.command === 'mcp') {
      return ['mcp', ...slash.args];
    }
    if (slash.command === 'doctor') {
      return ['doctor', ...slash.args];
    }
    if (slash.command === 'help') {
      return ['--help'];
    }
    if (slash.command === 'login') {
      return ['auth', 'login'];
    }
    if (slash.command === 'logout') {
      return ['auth', 'logout'];
    }
    if (slash.command === 'status') {
      return ['auth', 'status'];
    }
    if (slash.command === 'model' && slash.args.length > 0) {
      return ClaudeProxy._buildPrintModeArgs(
        { ...options, prompt: 'continue' },
        config,
        { model: slash.args[0], forceSkipDefaultModel: true }
      );
    }

    return null;
  }

  static _getSlashFallbackConfig(config) {
    const cfg = config?.runtime?.slashFallback || {};
    return {
      enabled: cfg.enabled !== false,
      timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 45000,
      logRawOutput: !!cfg.logRawOutput,
    };
  }

  static _resolveExecutionPlan(options, config) {
    const mapped = ClaudeProxy._mapSlashCommandToCliArgs(options, config);
    if (mapped) {
      const isPrint = mapped[0] === '--output-format';
      return {
        mode: isPrint ? 'print' : 'cli-subcommand',
        args: mapped,
        reason: isPrint ? 'print-mapped' : 'direct-cli-map',
        originalPrompt: options?.prompt || '',
      };
    }

    const slash = ClaudeProxy._parseSlashCommand(options?.prompt);
    const fallback = ClaudeProxy._getSlashFallbackConfig(config);
    const interactiveOnly = new Set(['clear', 'compact', 'config', 'cost', 'init', 'memory', 'review', 'terminal-setup']);

    if (slash && interactiveOnly.has(slash.command) && fallback.enabled) {
      return {
        mode: 'pty-fallback',
        args: [],
        reason: 'interactive-only-slash',
        originalPrompt: slash.raw,
        timeoutMs: fallback.timeoutMs,
        logRawOutput: fallback.logRawOutput,
      };
    }

    return {
      mode: 'print',
      args: ClaudeProxy._buildPrintModeArgs(options, config),
      reason: 'default-print',
      originalPrompt: options?.prompt || '',
    };
  }

  static _buildCliArgs(options, config) {
    return ClaudeProxy._resolveExecutionPlan(options, config).args;
  }

  static _applyPtyFallbackResult(result, classified) {
    result.exitCode = classified.exitCode;
    result.resultText = classified.summary;
    if (!classified.ok) result.error = classified.summary;
  }

  // CLI -p mode uses hyphens for slash commands (e.g. /gsd-new-project),
  // but interactive mode and skill registries use colons (e.g. /gsd:new-project).
  // Normalize colon-prefixed slash commands so they work in -p mode.
  static _normalizePrompt(prompt) {
    // Strip leading double-slash typo: "//model" -> "/model"
    let p = prompt.replace(/^\/\/+/, '/');
    // Match leading slash command with plugin:skill colon format
    // e.g. "/gsd:new-project args" -> "/gsd-new-project args"
    p = p.replace(/^\/([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)/, '/$1-$2');
    return p;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = ClaudeProxy;
