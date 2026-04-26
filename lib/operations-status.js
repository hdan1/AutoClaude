'use strict';

function makeStatus({ severity, scope, summary, details = '', nextSteps = [], meta = {} }) {
  return { severity, scope, summary, details, nextSteps: [...nextSteps], meta: { ...meta } };
}

function makeUpdateErrorStatus({ summary, detail }) {
  return makeStatus({
    severity: 'error',
    scope: 'update',
    summary: 'Update failed',
    details: summary,
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail },
  });
}

function makeUpdateProgressStatus(status, { version } = {}) {
  const summaryMap = {
    downloading: 'Downloading update',
    ready: 'Update ready',
  };

  return makeStatus({
    severity: 'info',
    scope: 'update',
    summary: summaryMap[status] || 'Update status',
    details: version ? `Version ${version}` : '',
    nextSteps: [],
    meta: version ? { version } : {},
  });
}

function buildDiagnosticsBundle({
  appVersion,
  claudeVersion,
  claudePath,
  authType,
  workspacePath = '',
  logPath = '',
  updaterStatus = '',
  telemetryDegraded = false,
  lastError = '',
}) {
  return {
    appVersion,
    claudeVersion,
    claudePath,
    authType,
    workspacePath,
    logPath,
    updaterStatus,
    telemetryDegraded,
    lastError,
  };
}

module.exports = {
  makeStatus,
  makeUpdateErrorStatus,
  makeUpdateProgressStatus,
  buildDiagnosticsBundle,
};
