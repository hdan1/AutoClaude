'use strict';

function uninstallProjectHooks({ projectDir, installerPath, execFileSync }) {
  try {
    execFileSync('node', [installerPath, projectDir, '--uninstall'], { stdio: 'pipe' });
    return {
      ok: true,
      severity: 'info',
      scope: 'hooks',
      summary: 'Hooks removed',
      details: '',
      nextSteps: [],
    };
  } catch (err) {
    return {
      ok: false,
      severity: 'warning',
      scope: 'hooks',
      summary: 'Hook cleanup incomplete',
      details: err.message,
      nextSteps: [
        'Retry closing the project',
        'Remove hooks manually with install-hooks.js',
        'Check project .claude/settings.json',
      ],
    };
  }
}

module.exports = {
  uninstallProjectHooks,
};
