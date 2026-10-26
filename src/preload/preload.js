const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ezshare', {
  // Dialogs & System
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:open-folder', folderPath),
  getLocalInfo: () => ipcRenderer.invoke('system:get-local-info'),

  // Sender Actions
  startDiscovery: () => ipcRenderer.invoke('sender:start-discovery'),
  stopDiscovery: () => ipcRenderer.invoke('sender:stop-discovery'),
  sendFiles: (targetDevice, files) => ipcRenderer.invoke('sender:send-files', { targetDevice, files }),
  cancelSend: () => ipcRenderer.invoke('sender:cancel'),

  // Receiver Actions
  startReceiver: (destinationFolder) => ipcRenderer.invoke('receiver:start', destinationFolder),
  stopReceiver: () => ipcRenderer.invoke('receiver:stop'),
  changeDestinationFolder: (newFolder) => ipcRenderer.invoke('receiver:change-folder', newFolder),

  // Events from Main Process
  onDevicesUpdated: (callback) => {
    const handler = (event, devices) => callback(devices);
    ipcRenderer.on('devices-updated', handler);
    return () => ipcRenderer.removeListener('devices-updated', handler);
  },
  onTransferProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('transfer-progress', handler);
    return () => ipcRenderer.removeListener('transfer-progress', handler);
  },
  onTransferComplete: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('transfer-complete', handler);
    return () => ipcRenderer.removeListener('transfer-complete', handler);
  },
  onTransferRequested: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('transfer-requested', handler);
    return () => ipcRenderer.removeListener('transfer-requested', handler);
  },
  onError: (callback) => {
    const handler = (event, error) => callback(error);
    ipcRenderer.on('error', handler);
    return () => ipcRenderer.removeListener('error', handler);
  }
});
