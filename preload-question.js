const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('questionAPI', {
  onQuestionData: cb => ipcRenderer.on('question-data', (_, d) => cb(d)),
  sendAnswer: text => ipcRenderer.send('question-answer', { tabId: 'default', text }),
  skipQuestion: () => ipcRenderer.send('skip-question', { tabId: 'default' }),
  openTerminal: () => ipcRenderer.send('open-terminal', { tabId: 'default' }),
});
