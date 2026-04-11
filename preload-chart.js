const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onChartData: cb => ipcRenderer.on('chart-data', (_, d) => cb(d)),
});
