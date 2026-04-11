const { contextBridge, ipcRenderer } = require('electron');

// H2: Listener cleanup — remove previous listeners before registering new ones
function safeOn(channel, callback) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_, d) => callback(d));
}

contextBridge.exposeInMainWorld('api', {
  // -- Session API (all accept tabId as first param) --
  startSession:     (tabId, c) => ipcRenderer.invoke('start-session', { tabId, ...c }),
  stopSession:      (tabId) => ipcRenderer.invoke('stop-session', { tabId }),
  listSessions:     d => ipcRenderer.invoke('list-sessions', d),
  getStoredSession: d => ipcRenderer.invoke('get-stored-session', d),
  clearStoredSession: d => ipcRenderer.invoke('clear-stored-session', d),

  // -- Response channels (tabId-aware) --
  sendResponse:     (tabId, t) => ipcRenderer.send('send-response', { tabId, text: t }),
  skipQuestion:     (tabId) => ipcRenderer.send('skip-question', { tabId }),

  // -- Utility (tabId-aware where session-specific) --
  openTerminal:     (tabId) => ipcRenderer.send('open-terminal', { tabId }),
  openChart:        d => ipcRenderer.send('open-chart', d),
  saveConfig:       c => ipcRenderer.send('save-config', c),
  loadConfig:       () => ipcRenderer.invoke('load-config'),
  getSetting:       key => ipcRenderer.invoke('get-setting', key),
  setSetting:       (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  getSettingsGroup: cat => ipcRenderer.invoke('get-settings-group', cat),
  getSettingsSchema:() => ipcRenderer.invoke('get-settings-schema'),
  fetchModels:             () => ipcRenderer.invoke('fetch-models'),
  fetchModelsAnthropic:    () => ipcRenderer.invoke('fetch-models-anthropic'),
  getDefaultModels:        () => ipcRenderer.invoke('get-default-models'),
  getCustomModels:         () => ipcRenderer.invoke('get-custom-models'),
  saveCustomModels:        opts => ipcRenderer.invoke('save-custom-models', opts),
  getState:         (tabId) => ipcRenderer.send('get-state', { tabId }),
  selectDirectory:  opts => ipcRenderer.invoke('select-directory', opts || {}),
  showConfirmDialog: opts => ipcRenderer.invoke('show-confirm-dialog', opts),
  listWorkspaceProjects: () => ipcRenderer.invoke('list-workspace-projects'),
  getWorkspaceStatus: () => ipcRenderer.invoke('get-workspace-status'),
  openWorkspaceProject: name => ipcRenderer.invoke('open-workspace-project', name),
  newWorkspaceProject: name => ipcRenderer.invoke('new-workspace-project', name),
  closeWorkspaceProject: tabId => ipcRenderer.invoke('close-workspace-project', tabId),
  createProjectFolder: name => ipcRenderer.invoke('create-project-folder', name),

  // -- Image Attachment --
  saveImageForPrompt: (buffer, filename, tabId) => ipcRenderer.invoke('save-image-for-prompt', { buffer, filename, tabId }),
  cleanupPromptImages: tabId => ipcRenderer.invoke('cleanup-prompt-images', { tabId }),

  // -- Telegram API --
  saveTelegramConfig: c => ipcRenderer.invoke('save-telegram-config', c),
  loadTelegramConfig: c => ipcRenderer.invoke('load-telegram-config', c || {}),
  saveMasterTelegramConfig: c => ipcRenderer.invoke('save-master-telegram-config', c),
  loadMasterTelegramConfig: () => ipcRenderer.invoke('load-master-telegram-config'),
  testTelegramBot:    c => ipcRenderer.invoke('test-telegram-bot', c || {}),
  tutorialTestSend:   c => ipcRenderer.invoke('tutorial-test-send', c),
  tutorialDiscoverChatId: c => ipcRenderer.invoke('tutorial-discover-chat-id', c),

  // -- Event listeners (unchanged — data will contain tabId from main) --
  onLog:               cb => safeOn('log', cb),
  onStatus:            cb => safeOn('status', cb),
  onProxyEvent:        cb => safeOn('proxy-event', cb),
  onHookEvent:         cb => safeOn('hook-event', cb),
  onQuestion:          cb => safeOn('question', cb),
  onHideQuestion:      cb => safeOn('hide-question', cb),
  onSessionComplete:   cb => safeOn('session-complete', cb),
  onError:             cb => safeOn('error', cb),
  onMetrics:           cb => safeOn('metrics', cb),
  onBatch:             cb => safeOn('batch', cb),
  onMasterWorkspaceOpen: cb => safeOn('master-workspace-open', cb),
  onMasterWorkspaceClose: cb => safeOn('master-workspace-close', cb),
  onRedundantReads:      cb => safeOn('redundant-reads', cb),

  // -- System (auto-update + sleep) --
  restartForUpdate:    () => ipcRenderer.send('restart-for-update'),
  onUpdateStatus:      cb => safeOn('update-status', cb),
  onSleepStatus:       cb => safeOn('sleep-status', cb),

  // -- Claude Code Manager --
  detectClaudeCode:       () => ipcRenderer.invoke('detect-claude-code'),
  readClaudeSettings:     opts => ipcRenderer.invoke('read-claude-settings', opts),
  writeClaudeSettings:    opts => ipcRenderer.invoke('write-claude-settings', opts),
  listClaudePlugins:      () => ipcRenderer.invoke('list-claude-plugins'),
  toggleClaudePlugin:     opts => ipcRenderer.invoke('toggle-claude-plugin', opts),
  installClaudePlugin:    opts => ipcRenderer.invoke('install-claude-plugin', opts),
  testCustomProvider:     opts => ipcRenderer.invoke('test-custom-provider', opts),
  getCustomProviderState: () => ipcRenderer.invoke('get-custom-provider-state'),
  installClaudeCode:      opts => ipcRenderer.invoke('install-claude-code', opts),
  authenticateClaudeCode: opts => ipcRenderer.invoke('authenticate-claude-code', opts),
  saveCustomProvider:     opts => ipcRenderer.invoke('save-custom-provider', opts),
  onInstallProgress:      cb => safeOn('install-claude-code-progress', cb),
  installPrerequisite:    opts => ipcRenderer.invoke('install-prerequisite', opts),
  onPrerequisiteProgress: cb => safeOn('install-prerequisite-progress', cb),
  installTool:            opts => ipcRenderer.invoke('install-tool', opts),
  onToolProgress:         cb => safeOn('install-tool-progress', cb),
  runHealthCheck:            () => ipcRenderer.invoke('run-health-check'),
  snapshotRecommendedPlugins:() => ipcRenderer.invoke('snapshot-recommended-plugins'),
  getAppLogInfo:             () => ipcRenderer.invoke('get-app-log-info'),
  openAppLogFolder:          () => ipcRenderer.invoke('open-app-log-folder'),
  onHealthCheck:             cb => safeOn('health-check', cb),
  listSettingsTags:      () => ipcRenderer.invoke('list-settings-tags'),
  loadSettingsTag:       opts => ipcRenderer.invoke('load-settings-tag', opts),
  saveSettingsTag:       opts => ipcRenderer.invoke('save-settings-tag', opts),
  deleteSettingsTag:     opts => ipcRenderer.invoke('delete-settings-tag', opts),
  checkClaudeUpdate:     opts => ipcRenderer.invoke('check-claude-update', opts),
});
