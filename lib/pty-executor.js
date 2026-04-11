const { spawn } = require('child_process');

function normalizePtyError(err) {
  const msg = String(err?.message || err || 'unknown error');
  return `PTY fallback unavailable: ${msg}`;
}

function classifyPtyRun({ code, stdout, stderr, timedOut }) {
  const text = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (timedOut) return { ok: false, timeout: true, exitCode: code, summary: text || 'PTY fallback timed out' };
  if (code === 0) return { ok: true, timeout: false, exitCode: 0, summary: text || 'PTY fallback complete' };
  return { ok: false, timeout: false, exitCode: code, summary: text || `PTY fallback failed (exit ${code})` };
}

function runPtyCommand({ cwd, prompt, timeoutMs = 45000, env = {}, skipPermissions = true }) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    proc.stdin.write(`${prompt}\n`);
    proc.stdin.write('/exit\n');
    proc.stdin.end();
  });
}

module.exports = { runPtyCommand, classifyPtyRun, normalizePtyError };
