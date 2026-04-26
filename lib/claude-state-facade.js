'use strict';

async function buildClaudeStateFacade({ detectClaudeState, checkForUpdate, checkPluginUpdates }) {
  let detected = {};
  let error = '';
  let update = {};
  let pluginUpdates = [];
  let pluginUpdatesError = '';

  try {
    detected = await detectClaudeState();
  } catch (err) {
    detected = {};
    error = err?.message || String(err);
  }

  try {
    update = await checkForUpdate({ forceCheck: false });
  } catch (err) {
    update = { error: err?.message || String(err) };
  }

  try {
    const pluginUpdateResult = await checkPluginUpdates(false);
    pluginUpdates = pluginUpdateResult?.updates || [];
  } catch (err) {
    pluginUpdates = [];
    pluginUpdatesError = err?.message || String(err);
  }

  const facade = {
    installed: !!detected.installed,
    version: detected.version || '',
    authType: detected.authType || '',
    update,
    pluginUpdates,
  };
  if (error) facade.error = error;
  if (pluginUpdatesError) facade.pluginUpdatesError = pluginUpdatesError;
  return facade;
}

module.exports = { buildClaudeStateFacade };
