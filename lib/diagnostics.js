'use strict';

const { buildDiagnosticsBundle } = require('./operations-status');

function buildDiagnostics({ appVersion, claude, workspacePath, logPath, updater, telemetry, lastError }) {
  return buildDiagnosticsBundle({
    appVersion,
    claudeVersion: claude?.version || '',
    claudePath: claude?.path || '',
    authType: claude?.authType || '',
    workspacePath: workspacePath || '',
    logPath: logPath || '',
    updaterStatus: updater?.status || '',
    telemetryDegraded: !!telemetry?.degraded,
    lastError: lastError || '',
  });
}

module.exports = { buildDiagnostics };
