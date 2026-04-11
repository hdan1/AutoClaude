const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const ClaudeProxy = require('./proxy');
const { TOOL_ACTIVITY_MAP, GSD_PHASE_PATTERNS, CRASH_RETRY_DELAY_MS, QUESTION_TIMEOUT_MS, COST_WARNING_USD, COST_DANGER_USD, REVIEW_COUNTDOWN_SECONDS } = require('./lib/constants');
const AutonomyEngine = require('./lib/autonomy');
const contextGuard = require('./lib/context-guard');
const logger = require('./lib/logger');

class SessionManager extends EventEmitter {
  constructor(globalConfig, sendFn, workflowManager) {
    super();
    this.config = globalConfig;
    this._origSend = sendFn;
    this.send = (tabId, channel, data) => {
      sendFn(tabId, channel, data);
      // Forward log events to telegram bridge with formatting
      const session = this.sessions.get(tabId);
      if (channel === 'log' && data?.text) {
        const hasBridge = !!session?.telegramBridge;
        const isRunning = session?.telegramBridge?.isRunning;
        const chatCount = session?.telegramBridge?.chatIds?.size || 0;
        const logger = require('./lib/logger');
        if (!session) logger.info('tg-debug', 'No session for ' + tabId);
        else if (!hasBridge) logger.info('tg-debug', 'No telegramBridge on session ' + tabId);
        else if (!isRunning) logger.info('tg-debug', 'telegramBridge not running for ' + tabId);
        else if (chatCount === 0) logger.info('tg-debug', 'telegramBridge running but 0 chatIds for ' + tabId);
        else logger.info('tg-debug', 'Forwarding log to ' + chatCount + ' chats for ' + tabId);
      }
      if (session?.telegramBridge?.isRunning) {
        if (channel === 'log' && data?.text) {
          session.telegramBridge.forwardLog(data.type || 'stdout', data.text);
        } else if (channel === 'proxy-event') {
          session.telegramBridge.forwardProxyEvent(data);
        } else if (channel === 'metrics') {
          session.telegramBridge.forwardMetrics(data);
        } else if (channel === 'hook-event') {
          session.telegramBridge.forwardHookEvent(data);
        }
      }
    };
    this.sessions = new Map();
    this.autonomy = new AutonomyEngine(globalConfig, workflowManager);
  }

  setTelegram(tabId, bridge) {
    const session = this.sessions.get(tabId);
    if (session) session.telegramBridge = bridge;
  }

  create(tabId, projectDir) {
    if (this.sessions.has(tabId)) return this.sessions.get(tabId);
    const session = {
      tabId,
      proxy: null,
      state: {
        running: false, currentStep: '', message: '',
        projectDir, startTime: null, sessionId: null,
        totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
        hooksInstalled: false,
        lastAutoNextPrompt: null,
        activityType: 'idle', activeTool: null,
        gsdPhase: null,
        activeSkill: null,
        skillSource: null,
        // Cumulative project-level stats (persisted across sessions)
        projectInputTokens: 0, projectOutputTokens: 0, projectCostUsd: 0, projectSessions: 0,
      },
      telegramBridge: null,
      pendingResponse: null,
      waitingForAnswer: false,
      answerResolve: null,
    };
    // Load persisted project stats
    this._loadProjectStats(session);
    this.sessions.set(tabId, session);
    return session;
  }

  get(tabId) { return this.sessions.get(tabId) || null; }

  getState(tabId) {
    const s = this.sessions.get(tabId);
    return s ? s.state : null;
  }

  sendState(tabId) {
    const s = this.sessions.get(tabId);
    if (s) this.send(tabId, 'status', { ...s.state });
  }

  async start(tabId, prompt) {
    const session = this.sessions.get(tabId);
    if (!session) return;

    session.state.running = true;
    session.state.activityType = 'idle';
    session.state.message = 'Starting session...';
    session.state.currentStep = 'starting';
    this.sendState(tabId);
    this._saveResumeState(tabId, session, prompt);

    // If we have a session ID and a prompt, continue the session (new turn).
    // 'resume' replays the last turn; 'continue' sends a new message.
    const initialMode = session.state.sessionId ? (prompt ? 'continue' : 'resume') : 'fresh';
    const effectivePrompt = prompt || this.config.defaultPrompt || (initialMode === 'resume' ? 'continue' : '');
    if (!effectivePrompt) {
      session.state.running = false; session.state.message = 'No prompt provided';
      this.send(tabId, 'error', { message: 'A prompt is required to start a new session.' });
      this.sendState(tabId); return;
    }

    let turnPrompt = effectivePrompt;
    let turnMode = initialMode;
    let turnSessionId = session.state.sessionId;
    let result;
    let crashRetryCount = 0;
    let derailmentCount = 0;
    let contextRecoveryCount = 0;
    // Loop detection: sliding window of recent auto-next prompts + output fingerprints
    const autoNextHistory = []; // { prompt, outputHash }
    const MAX_HISTORY = 10;
    const STUCK_THRESHOLD = 3;     // same prompt + same output = truly stuck
    const OSCILLATION_WINDOW = 8;  // check last N for oscillation (≤2 unique prompts)

    while (session.state.running) {
      session.pendingResponse = null;
      session.waitingForAnswer = false;

      this.send(tabId, 'log', { type: 'user-input', text: `\u25b6 ${turnPrompt}` });

      if (this.config.hooks?.install && session.state.hooksInstalled) {
        this._ensureHooks(session.state.projectDir);
      }

      session.proxy = new ClaudeProxy(this.config);
      this._wireProxy(tabId, session, session.proxy);

      result = await session.proxy.run(session.state.projectDir, {
        prompt: turnPrompt,
        mode: turnMode,
        sessionId: turnSessionId,
      });

      if (!session.state.running) return;

      session.state.totalInputTokens += result.inputTokens;
      session.state.totalOutputTokens += result.outputTokens;
      session.state.totalCostUsd += result.costUsd || 0;
      if (result.sessionId) session.state.sessionId = result.sessionId;


      // Crash retry — non-zero exit code
      if (result.exitCode && result.exitCode !== 0) {
        if (this.autonomy.shouldRetry(result.exitCode, result.error, crashRetryCount)) {
          crashRetryCount++;
          const maxR = this.config.resilience?.maxCrashRetries || 3;
          const msg = `Crash retry ${crashRetryCount}/${maxR} (exit ${result.exitCode})...`;
          this.send(tabId, 'log', { type: 'system', text: msg });
          this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Crash Retry', body: msg });
          const delay = this.config.resilience?.crashRetryDelaySecs
            ? this.config.resilience.crashRetryDelaySecs * 1000
            : CRASH_RETRY_DELAY_MS;
          await this._sleep(delay);
          if (!session.state.running) return;
          turnPrompt = 'continue';
          turnMode = 'continue';
          turnSessionId = session.state.sessionId;
          continue;
        }
      }
      crashRetryCount = 0;

      // ── Context Guard (CTX-01) ──────────────────────────
      // Check if context usage exceeds threshold — trigger handoff + fresh session
      const ctxCheck = contextGuard.shouldRecover(result, session.state.model, this.config, contextRecoveryCount);
      if (ctxCheck.recover) {
        contextRecoveryCount++;
        const pctStr = (ctxCheck.pct * 100).toFixed(0);
        this.send(tabId, 'log', { type: 'system', text: `\u26a0 Context at ${pctStr}% \u2014 saving state and starting fresh session (${contextRecoveryCount}/${this.config.contextGuard?.maxRecoveriesPerSession || 3})` });
        this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Context Recovery', body: ctxCheck.reason });

        // Step 1: Handoff turn — save state via workflow-appropriate method
        const handoffPrompt = contextGuard.getHandoffPrompt(session.state);
        this.send(tabId, 'log', { type: 'system', text: `Handoff: ${handoffPrompt.substring(0, 80)}...` });
        session.proxy = new ClaudeProxy(this.config);
        this._wireProxy(tabId, session, session.proxy);
        const handoffResult = await session.proxy.run(session.state.projectDir, {
          prompt: handoffPrompt,
          mode: 'continue',
          sessionId: session.state.sessionId,
        });
        if (!session.state.running) return;
        // Accumulate handoff turn tokens
        session.state.totalInputTokens += handoffResult.inputTokens;
        session.state.totalOutputTokens += handoffResult.outputTokens;
        session.state.totalCostUsd += handoffResult.costUsd || 0;

        // Step 2: Clear session — next turn starts fresh
        session.state.sessionId = null;
        this.send(tabId, 'log', { type: 'system', text: '\u2713 Session cleared \u2014 starting fresh with handoff' });

        // Step 3: Resume — set prompt for fresh session
        turnPrompt = contextGuard.getResumePrompt(session.state);
        turnMode = 'fresh';
        turnSessionId = null;

        // Reset loop detection state for the fresh session
        autoNextHistory.length = 0;
        derailmentCount = 0;
        session.state.lastAutoNextPrompt = null;
        continue;
      }

      // Auto-answer was set during the turn (by ask-user-question handler)
      if (session.pendingResponse) {
        session.state.lastAutoNextPrompt = null; // Reset loop detection on answer
        autoNextHistory.length = 0;
        derailmentCount = 0;
        const answerMatch = session.pendingResponse.match(/I choose: (.+)$/);
        const shortAnswer = answerMatch ? answerMatch[1] : session.pendingResponse.substring(0, 80);
        this.send(tabId, 'log', { type: 'system', text: `Continuing with answer: ${shortAnswer}` });
        turnPrompt = session.pendingResponse;
        turnMode = 'continue';
        turnSessionId = session.state.sessionId;
        continue;
      }

      // Auto-continue: detect GSD phase completion or agent waiting
      const nextAction = this.autonomy.detectAutoNext(result, session);
      if (nextAction) {
        // Progress-aware loop detection using output fingerprinting + sliding window.
        // Same prompt is fine if output differs (making progress through phases/tests/waves).
        // Same prompt + same output = truly stuck. Oscillating between 2 prompts = also stuck.
        const outputHash = this._fingerprint(result.fullText);
        const entry = { prompt: nextAction.prompt, outputHash };

        // Check 1: Same prompt AND same output = truly stuck (no progress)
        const lastEntry = autoNextHistory.length > 0 ? autoNextHistory[autoNextHistory.length - 1] : null;
        if (lastEntry && lastEntry.prompt === entry.prompt && lastEntry.outputHash === entry.outputHash) {
          const stuckCount = autoNextHistory.filter(h => h.prompt === entry.prompt && h.outputHash === entry.outputHash).length;
          if (stuckCount >= STUCK_THRESHOLD) {
            this.send(tabId, 'log', { type: 'system', text: `\u26a0 Loop detected: ${nextAction.prompt} produced identical output ${stuckCount + 1} times \u2014 stopping` });
            break;
          }
        }

        // Check 2: Oscillation detection — last N entries have ≤2 unique prompts
        if (autoNextHistory.length >= OSCILLATION_WINDOW) {
          const recent = autoNextHistory.slice(-OSCILLATION_WINDOW).concat(entry);
          const uniquePrompts = new Set(recent.map(h => h.prompt));
          if (uniquePrompts.size <= 2) {
            this.send(tabId, 'log', { type: 'system', text: `\u26a0 Oscillation detected: cycling between ${[...uniquePrompts].join(' \u2194 ')} \u2014 stopping` });
            break;
          }
        }

        // Record this entry
        autoNextHistory.push(entry);
        if (autoNextHistory.length > MAX_HISTORY) autoNextHistory.shift();

        session.state.lastAutoNextPrompt = nextAction.prompt;
        derailmentCount = 0; // Reset derailment counter on successful auto-next
        if (nextAction.delaySecs) {
          this.send(tabId, 'log', { type: 'system', text: `\u23f3 ${nextAction.reason} \u2014 waiting ${nextAction.delaySecs}s before checking...` });
          await this._sleep(nextAction.delaySecs * 1000);
          if (!session.state.running) return;
        }
        this.send(tabId, 'log', { type: 'system', text: `\u2713 ${nextAction.reason} \u2014 auto-continuing with: ${nextAction.prompt}` });
        this.emit('notify', { type: 'complete', title: 'Auto Claude \u2014 Phase Complete', body: nextAction.reason });
        turnPrompt = nextAction.prompt;
        turnMode = 'continue';
        turnSessionId = session.state.sessionId;
        continue;
      }

      // Derailment detection (with loop protection)
      const derail = this.autonomy.detectDerailment(result, session);
      if (derail) {
        derailmentCount++;
        const MAX_DERAILMENTS = 3;
        if (derailmentCount > MAX_DERAILMENTS) {
          this.send(tabId, 'log', { type: 'system', text: `\u26a0 Derailment correction repeated ${derailmentCount} times \u2014 pausing for user input` });
          this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Derailment Loop', body: 'Repeated corrections failed. Pausing.' });
          break;
        }
        this.send(tabId, 'log', { type: 'system', text: `\u26a0 ${derail.reason} \u2014 redirecting... (${derailmentCount}/${MAX_DERAILMENTS})` });
        this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Course Correction', body: derail.reason });
        turnPrompt = derail.prompt;
        turnMode = 'continue';
        turnSessionId = session.state.sessionId;
        continue;
      }

      // Waiting for user answer (with timeout)
      if (session.waitingForAnswer) {
        const timeoutMs = (this.config.autoAnswer?.questionTimeoutSeconds || 300) * 1000;
        const answered = await this._waitForAnswerWithTimeout(session, timeoutMs);
        if (!session.state.running) return;
        if (answered && session.pendingResponse) {
          const answerMatch2 = session.pendingResponse.match(/I choose: (.+)$/);
          const shortAnswer2 = answerMatch2 ? answerMatch2[1] : session.pendingResponse.substring(0, 80);
          this.send(tabId, 'log', { type: 'system', text: `Continuing with answer: ${shortAnswer2}` });
          turnPrompt = session.pendingResponse;
          turnMode = 'continue';
          turnSessionId = session.state.sessionId;
          continue;
        }
        if (!answered) {
          // Timeout — try auto-answer as fallback
          const fallback = this.autonomy.autoAnswer(session._lastQuestionData, this.config);
          if (fallback) {
            this.send(tabId, 'log', { type: 'system', text: `Question timed out. Auto-answered: ${fallback.answer} (${fallback.reason})` });
            this.emit('notify', { type: 'question', title: 'Auto Claude \u2014 Timeout', body: `Auto-answered: ${fallback.answer}` });
            turnPrompt = fallback.answer;
            turnMode = 'continue';
            turnSessionId = session.state.sessionId;
            session.waitingForAnswer = false;
            continue;
          }
        }
      }

      // Session error (including zero-token failures like "Unknown skill")
      if (result.error) {
        this.send(tabId, 'log', { type: 'stderr', text: `Session error: ${result.error}` });
        session.state.message = result.error;
      } else if (result.resultText && result.inputTokens === 0 && result.outputTokens === 0) {
        // CLI returned a message but did zero work — surface it so user knows what happened
        this.send(tabId, 'log', { type: 'system', text: `CLI result: ${result.resultText}` });
        session.state.message = result.resultText;
      }

      break;
    }

    if (result && result.sessionId) session.state.sessionId = result.sessionId;

    session.state.running = false;
    session.state.currentStep = 'session-complete';
    session.state.message = 'Session complete';
    // Accumulate into project-level stats and persist
    session.state.projectInputTokens += session.state.totalInputTokens;
    session.state.projectOutputTokens += session.state.totalOutputTokens;
    session.state.projectCostUsd += session.state.totalCostUsd;
    session.state.projectSessions += 1;
    this._saveProjectStats(session);
    this.emit('notify', { type: 'complete', title: 'Auto Claude \u2014 Session Complete', body: 'Claude session ended.' });
    this.emit('session-complete', { tabId, sessionId: session.state.sessionId });
    this.send(tabId, 'session-complete', {
      sessionId: session.state.sessionId,
      inputTokens: result ? result.inputTokens : 0,
      outputTokens: result ? result.outputTokens : 0,
    });
    this.sendState(tabId);
    this._clearResumeState(tabId, session);
    this._cleanupTempImages(tabId);
    session.proxy = null;
  }

  // Clean up temp images created by image attachments
  _cleanupTempImages(tabId) {
    try {
      const os = require('os');
      const imgDir = path.join(os.tmpdir(), 'auto-claude-images', tabId);
      if (fs.existsSync(imgDir)) {
        const files = fs.readdirSync(imgDir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(imgDir, f)); } catch { /* ignore */ }
        }
        try { fs.rmdirSync(imgDir); } catch { /* ignore */ }
      }
    } catch { /* non-critical */ }
  }

  async stop(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.state.running = false;
    session.state.message = 'Stopped';
    session.state.currentStep = '';
    session.state.activityType = 'idle';
    session.state.activeTool = null;
    session.state.activeSkill = null;
    session.state.skillSource = null;
    if (session.proxy) {
      await session.proxy.kill();
      session.proxy.emit('response-ready', null);
      session.proxy = null;
    }
    // Unblock any pending answer wait
    if (session.answerResolve) { session.answerResolve(); session.answerResolve = null; }
    this.sendState(tabId);
    this.emit('save-status', tabId);
    this._clearResumeState(tabId, session);
  }

  async stopAll() {
    const promises = [];
    for (const [tabId] of this.sessions) {
      promises.push(this.stop(tabId));
    }
    await Promise.all(promises);
  }

  async close(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return { ok: false, error: `Unknown tab: ${tabId}` };
    const projectPath = session.state.projectDir || '';
    await this.stop(tabId);
    this.sessions.delete(tabId);
    return {
      ok: true,
      tabId,
      projectPath,
      projectName: projectPath ? path.basename(projectPath) : '',
    };
  }

  async remove(tabId) {
    await this.close(tabId);
  }

  sendResponse(tabId, text) {
    const session = this.sessions.get(tabId);
    if (!session || !session.proxy) return;
    session.proxy.sendResponse(text);
    session.state.message = 'Continuing with response...';
    this.sendState(tabId);
  }

  skipQuestion(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.proxy) session.proxy.emit('response-ready', null);
    session.state.message = 'Skipped';
    this.sendState(tabId);
  }

  _wireProxy(tabId, session, proxy) {
    proxy.on('event', e => {
      if (e.type === 'tool_use') {
        const actType = TOOL_ACTIVITY_MAP[e.name] || 'running';
        session.state.activityType = actType;
        session.state.activeTool = { name: e.name, input: e.input || '' };
      } else if (e.type === 'tool_result') {
        session.state.activityType = 'thinking';
        session.state.activeTool = null;
      } else if (e.type === 'text') {
        if (!session.state.activeTool) session.state.activityType = 'thinking';
        // Track GSD phase in session state for derailment detection
        for (const p of GSD_PHASE_PATTERNS) {
          const m = (e.text || '').match(p.re);
          if (m) { session.state.gsdPhase = p.label.replace('$1', m[1] || ''); break; }
        }
        // Track Superpowers skill via WorkflowManager
        if (this.autonomy.workflows) {
          const detected = this.autonomy.workflows.detect(e.text || '');
          if (detected && detected.detector === 'superpowers') {
            session.state.activeSkill = detected.label;
            session.state.skillSource = 'superpowers';
          } else if (detected && detected.detector === 'gsd') {
            // GSD already handled above, but update skillSource
            session.state.skillSource = 'gsd';
          }
        }
      } else if (e.type === 'result') {
        session.state.activityType = 'idle';
        session.state.activeTool = null;
      }
      this.send(tabId, 'proxy-event', e);
    });
    proxy.on('hook-event', e => this.send(tabId, 'hook-event', e));
    proxy.on('redundant-reads', e => {
      this.send(tabId, 'log', { type: 'system', text: `\u26a0 ${e.fileName} read ${e.count}x in this session (token waste)` });
      this.send(tabId, 'redundant-reads', e);
    });
    proxy.on('metrics', m => {
      // Accumulate turn-level tokens into session totals in real-time
      // (proxy resets per turn, so add session baseline to give renderer the running total)
      const augmented = { ...m };
      if (m.inputTokens != null) {
        augmented.inputTokens = session.state.totalInputTokens + m.inputTokens;
      }
      if (m.outputTokens != null) {
        augmented.outputTokens = session.state.totalOutputTokens + m.outputTokens;
      }
      if (m.costUsd != null) {
        augmented.costUsd = session.state.totalCostUsd + m.costUsd;
      }
      // Include project-level cumulative stats
      augmented.projectInputTokens = session.state.projectInputTokens + augmented.inputTokens;
      augmented.projectOutputTokens = session.state.projectOutputTokens + augmented.outputTokens;
      augmented.projectCostUsd = session.state.projectCostUsd + (augmented.costUsd || 0);
      this.send(tabId, 'metrics', augmented);
    });
    proxy.on('stderr', t => this.send(tabId, 'log', { type: 'stderr', text: t }));
    proxy.on('raw', t => {
      this.send(tabId, 'log', { type: 'stdout', text: t });
      this.emit('output', { tabId, text: t });
    });
    proxy.on('session-init', info => {
      session.state.sessionId = info.sessionId;
      if (info.model) session.state.model = info.model;
      const pid = proxy.process?.pid;
      if (pid) this.emit('pid-tracked', { tabId, pid });
      this.send(tabId, 'log', { type: 'system', text: `Session: ${info.sessionId} (${info.model})` });
      this.sendState(tabId);
      this.emit('session-init', { tabId, sessionId: info.sessionId });
    });
    proxy.on('retry', info => {
      session.state.message = `Rate limited \u2014 retrying in ${info.waitSecs}s (${info.attempt}/${info.maxRetries})`;
      this.send(tabId, 'log', { type: 'system', text: session.state.message });
      this.sendState(tabId);
      this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Rate Limited', body: `Retrying in ${info.waitSecs}s` });
    });
    proxy.on('ask-user-question', async (data) => {
      session.state.activityType = 'waiting';
      session.state.activeTool = null;
      const questionData = data.input || null;
      let options = null, questionText = null, multiSelect = false;
      if (typeof questionData === 'string') {
        questionText = questionData;
      } else if (questionData) {
        const qList = questionData.questions || (questionData.question ? [questionData] : []);
        if (qList.length > 0) {
          const q = qList[0];
          questionText = q.question || null;
          multiSelect = !!q.multiSelect;
          if (q.options && Array.isArray(q.options)) {
            options = q.options.map(o => typeof o === 'string' ? o : (o.label || o.value || String(o)));
          }
        }
      }

      // Store for timeout fallback
      session._lastQuestionData = questionData;

      // Smart routing via autonomy engine
      const decision = this.autonomy.handleQuestion(tabId, questionData, session.telegramBridge);
      const hasBridge = !!session.telegramBridge;
      const bridgeRunning = session.telegramBridge?.isRunning;
      logger.info('question-routing', `tabId=${tabId} decision=${decision.action} hasBridge=${hasBridge} bridgeRunning=${bridgeRunning} question="${(questionText || '').substring(0, 50)}" options=${(options || []).length} cfgAutoAnswer=${!!this.config?.autoAnswer} mode=${this.config?.autoAnswer?.mode} fullAutonomy=${this.config?.autoAnswer?.fullAutonomy}`);

      if (decision.action === 'auto-answer') {
        if (questionText) this.send(tabId, 'log', { type: 'auto-answer', text: `Q: ${questionText}` });
        if (options) this.send(tabId, 'log', { type: 'auto-answer', text: `Options: ${options.map((o,i)=>`${i+1}. ${o}`).join(' | ')}` });
        this.send(tabId, 'log', { type: 'auto-answer', text: `Auto-answer: ${decision.answer} (${decision.reason})` });
        if (decision.wasCritical) {
          this.send(tabId, 'log', { type: 'auto-answer', text: '\u26a0 Critical question auto-answered (no Telegram connected)' });
        }
        // Notify Telegram after the fact
        if (session.telegramBridge?.isRunning) {
          session.telegramBridge.notifyAutoAnswer(tabId, questionData, decision.answer, decision.reason);
        }
        // Build contextual response so Claude understands the choice
        // (--continue -p sends a new user message, not a tool_result)
        let contextualAnswer = decision.answer;
        if (questionText && options) {
          // Handle multiSelect comma-separated answers like "1, 2, 3, 4"
          const indices = decision.answer.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
          if (indices.length > 1) {
            const chosen = indices.map(i => options[i - 1]).filter(Boolean);
            contextualAnswer = `For your question "${questionText}" — I choose: ${chosen.join(', ')}`;
          } else {
            const chosen = options[parseInt(decision.answer, 10) - 1] || decision.answer;
            contextualAnswer = `For your question "${questionText}" — I choose: ${chosen}`;
          }
        } else if (questionText) {
          contextualAnswer = `For your question "${questionText}" — my answer: ${decision.answer}`;
        }
        session.pendingResponse = contextualAnswer;
        return;
      }

      if (decision.action === 'review') {
        // Show question panel with pre-selected answer and countdown
        if (questionText) this.send(tabId, 'log', { type: 'auto-answer', text: `Q: ${questionText} (review mode — ${decision.countdown}s countdown)` });
        session.waitingForAnswer = true;
        session.state.message = `Review: auto-answer in ${decision.countdown}s`;
        this.sendState(tabId);
        this.send(tabId, 'question', {
          options, questionText, multiSelect,
          review: true,
          suggestedAnswer: decision.answer,
          countdown: decision.countdown,
          reason: decision.reason,
        });

        // Wait for user override or countdown expiry
        const answered = await this._waitForAnswerWithTimeout(session, decision.countdown * 1000);
        if (!session.state.running) return;
        if (answered && session.pendingResponse) {
          this.send(tabId, 'log', { type: 'system', text: `User overrode review answer` });
          this.send(tabId, 'hide-question', {});
          return; // pendingResponse already set by response-ready
        }
        // Countdown expired — use auto-answer
        this.send(tabId, 'log', { type: 'auto-answer', text: `Review timeout — auto-answered: ${decision.answer} (${decision.reason})` });
        this.send(tabId, 'hide-question', {});
        let contextualAnswer = decision.answer;
        if (questionText && options) {
          const chosen = options[parseInt(decision.answer, 10) - 1] || decision.answer;
          contextualAnswer = `For your question "${questionText}" — I choose: ${chosen}`;
        } else if (questionText) {
          contextualAnswer = `For your question "${questionText}" — my answer: ${decision.answer}`;
        }
        session.pendingResponse = contextualAnswer;
        session.waitingForAnswer = false;
        if (session.answerResolve) { session.answerResolve(); session.answerResolve = null; }
        return;
      }

      if (decision.action === 'route-telegram') {
        this.send(tabId, 'log', { type: 'system', text: `\u23f3 Critical question \u2014 routing to Telegram (${decision.timeout / 1000}s timeout)` });
        session.waitingForAnswer = true;
        session.state.message = 'Waiting for Telegram response...';
        this.sendState(tabId);
        // Also show in UI
        this.send(tabId, 'question', { options, questionText, multiSelect });

        try {
          const answer = await session.telegramBridge.forwardCritical(tabId, questionData, decision.timeout);
          if (answer !== null) {
            // Format answer contextually so Claude understands the choice
            let contextualAnswer = answer;
            if (questionText && options) {
              const idx = parseInt(answer, 10);
              const chosen = (!isNaN(idx) && options[idx - 1]) ? options[idx - 1] : answer;
              contextualAnswer = `For your question "${questionText}" — I choose: ${chosen}`;
            } else if (questionText) {
              contextualAnswer = `For your question "${questionText}" — my answer: ${answer}`;
            }
            session.pendingResponse = contextualAnswer;
            session.waitingForAnswer = false;
            if (session.answerResolve) { session.answerResolve(); session.answerResolve = null; }
            return;
          }
          // Timeout — auto-answer fallback
          const fallback = this.autonomy.autoAnswer(questionData, this.config);
          if (fallback) {
            this.send(tabId, 'log', { type: 'system', text: `Telegram timeout. Auto-answered: ${fallback.answer} (${fallback.reason})` });
            let contextualFallback = fallback.answer;
            if (questionText && options) {
              const idx = parseInt(fallback.answer, 10);
              const chosen = (!isNaN(idx) && options[idx - 1]) ? options[idx - 1] : fallback.answer;
              contextualFallback = `For your question "${questionText}" — I choose: ${chosen}`;
            } else if (questionText) {
              contextualFallback = `For your question "${questionText}" — my answer: ${fallback.answer}`;
            }
            session.pendingResponse = contextualFallback;
            session.waitingForAnswer = false;
            if (session.answerResolve) { session.answerResolve(); session.answerResolve = null; }
            return;
          }
        } catch (e) {
          this.send(tabId, 'log', { type: 'stderr', text: `Telegram routing error: ${e.message}` });
        }
        // Fall through to ask-user if telegram failed
      }

      // action === 'ask-user' or fallback
      session.waitingForAnswer = true;
      session.state.message = 'Claude is asking for input';
      this.emit('notify', { type: 'question', title: 'Auto Claude \u2014 Input Needed', body: 'Claude needs your input.' });
      this.send(tabId, 'question', { options, questionText, multiSelect });
      this.emit('question', { tabId, questionData: { options, questionText, multiSelect } });
      this.sendState(tabId);
    });
    proxy.on('response-ready', text => {
      session.pendingResponse = text;
      session.waitingForAnswer = false;
      if (session.answerResolve) { session.answerResolve(); session.answerResolve = null; }
    });
  }

  // Check if auto-claude hooks are still present in target project settings.
  // Other tools (GSD, Claude CLI itself) may overwrite .claude/settings.json.
  // If hooks are missing, re-emit 'reinstall-hooks' so main.js can re-run install-hooks.js.
  _ensureHooks(projectDir) {
    try {
      const settingsFile = path.join(projectDir, '.claude', 'settings.json');
      if (!fs.existsSync(settingsFile)) {
        this.emit('reinstall-hooks', projectDir);
        return;
      }
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const hooks = settings.hooks || {};
      const marker = 'auto-claude-hook.js';
      const hasPost = Array.isArray(hooks.PostToolUse) && hooks.PostToolUse.some(h => JSON.stringify(h).includes(marker));
      const hasSub = Array.isArray(hooks.SubagentStop) && hooks.SubagentStop.some(h => JSON.stringify(h).includes(marker));
      if (!hasPost || !hasSub) {
        this.emit('reinstall-hooks', projectDir);
      }
    } catch (e) { logger.debug('session-manager', `hook verification failed: ${e.message}`); }
  }

  _waitForAnswerWithTimeout(session, timeoutMs) {
    // B5: Clear any existing timer before setting a new resolve to prevent orphaned promises
    if (session._answerTimer) clearTimeout(session._answerTimer);
    return new Promise(resolve => {
      session.answerResolve = () => {
        if (session._answerTimer) clearTimeout(session._answerTimer);
        session._answerTimer = null;
        resolve(true);
      };
      session._answerTimer = setTimeout(() => {
        session.answerResolve = null;
        session._answerTimer = null;
        resolve(false);
      }, timeoutMs);
    });
  }

  _saveResumeState(tabId, session, prompt) {
    const dir = session.state.projectDir;
    if (!dir) return;
    if (!this.config.sessions) this.config.sessions = {};
    // R5: Include tabId in key to prevent last-write-wins between concurrent sessions
    const key = `${dir}::${tabId}`;
    this.config.sessions[key] = {
      sessionId: session.state.sessionId,
      timestamp: new Date().toISOString(),
      wasRunning: true,
      tabId,
      lastPrompt: prompt || 'continue',
    };
    this.emit('save-config');
  }

  _clearResumeState(tabId, session) {
    const dir = session.state.projectDir;
    if (!dir) return;
    const key = `${dir}::${tabId}`;
    if (this.config.sessions) delete this.config.sessions[key];
    this.emit('save-config');
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Simple hash of the last ~500 chars of output for loop detection.
  // Different output = making progress; identical output = stuck.
  _fingerprint(text) {
    if (!text) return '';
    const tail = text.length > 500 ? text.slice(-500) : text;
    let h = 0;
    for (let i = 0; i < tail.length; i++) {
      h = ((h << 5) - h + tail.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  // ── Project-level cumulative stats ────────────────

  _statsFile(projectDir) {
    return path.join(projectDir, '.planning', 'auto-claude-stats.json');
  }

  _loadProjectStats(session) {
    const dir = session.state.projectDir;
    if (!dir) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._statsFile(dir), 'utf8'));
      session.state.projectInputTokens = data.inputTokens || 0;
      session.state.projectOutputTokens = data.outputTokens || 0;
      session.state.projectCostUsd = data.costUsd || 0;
      session.state.projectSessions = data.sessions || 0;
    } catch { /* no stats file yet — use defaults */ }
  }

  _saveProjectStats(session) {
    const dir = session.state.projectDir;
    if (!dir) return;
    try {
      const statsDir = path.dirname(this._statsFile(dir));
      if (!fs.existsSync(statsDir)) fs.mkdirSync(statsDir, { recursive: true });
      const data = {
        inputTokens: session.state.projectInputTokens,
        outputTokens: session.state.projectOutputTokens,
        costUsd: session.state.projectCostUsd,
        sessions: session.state.projectSessions,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(this._statsFile(dir), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      logger.warn('session-manager', `Stats save failed: ${e.message}`);
    }
  }
}

module.exports = SessionManager;
