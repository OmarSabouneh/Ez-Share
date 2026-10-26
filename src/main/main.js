const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DiscoveryService, getLocalIp } = require('./network/discovery');
const { TransferServer } = require('./network/transferServer');
const { TransferClient } = require('./network/transferClient');

let mainWindow = null;
let discoveryService = null;
let transferServer = null;
let transferClient = null;

const deviceId = `win_${os.hostname()}_${Math.random().toString(36).substring(2, 7)}`;
const deviceName = os.hostname() || 'Windows Device';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#090D16',
    autoHideMenuBar: true,
    title: 'EzShare - LAN File Transfer',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Initialize services
  discoveryService = new DiscoveryService(deviceId, deviceName);
  transferServer = new TransferServer();
  transferClient = new TransferClient();

  try {
    await discoveryService.start();
  } catch (err) {
    console.error('Failed to start UDP discovery socket:', err);
  }

  // Wire up discovery events
  discoveryService.on('devices-updated', (devices) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('devices-updated', devices);
    }
  });

  // Wire up server events
  transferServer.on('transfer-requested', (reqData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transfer-requested', reqData);
    }
  });

  transferServer.on('transfer-progress', (progressData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transfer-progress', progressData);
    }
  });

  transferServer.on('transfer-complete', (summary) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transfer-complete', summary);
    }
  });

  transferServer.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('error', err.message);
    }
  });

  // Wire up client events
  transferClient.on('transfer-progress', (progressData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transfer-progress', progressData);
    }
  });

  transferClient.on('transfer-complete', (summary) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transfer-complete', summary);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (discoveryService) discoveryService.stop();
  if (transferServer) transferServer.stop();
  if (transferClient) transferClient.cancel();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC: System & Dialog Handlers
ipcMain.handle('system:get-local-info', () => {
  return {
    deviceId,
    deviceName,
    ip: getLocalIp(),
    os: 'windows'
  };
});

ipcMain.handle('dialog:select-files', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Files to Send',
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || !result.filePaths) {
    return [];
  }

  return result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size
    };
  });
});

ipcMain.handle('dialog:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Folder to Store Received Files',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('shell:open-folder', async (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    return shell.openPath(folderPath);
  }
});

// IPC: Sender Actions
ipcMain.handle('sender:start-discovery', () => {
  if (discoveryService) {
    discoveryService.startSearching();
  }
  return true;
});

ipcMain.handle('sender:stop-discovery', () => {
  if (discoveryService) {
    discoveryService.stopSearching();
  }
  return true;
});

ipcMain.handle('sender:send-files', async (event, { targetDevice, files }) => {
  if (!targetDevice || !files || files.length === 0) {
    throw new Error('Target device or files missing.');
  }

  if (discoveryService) {
    discoveryService.stopSearching();
  }

  return await transferClient.sendFiles(targetDevice.ip, targetDevice.port, files, deviceName);
});

ipcMain.handle('sender:cancel', () => {
  if (transferClient) {
    transferClient.cancel();
  }
  return true;
});

// IPC: Receiver Actions
ipcMain.handle('receiver:start', async (event, destinationFolder) => {
  if (!destinationFolder) {
    throw new Error('Destination folder must be specified.');
  }

  const assignedPort = await transferServer.start(destinationFolder);
  // Device only becomes discoverable now!
  if (discoveryService) {
    discoveryService.setReceiverReady(true, assignedPort);
  }

  return { port: assignedPort, destinationFolder };
});

ipcMain.handle('receiver:stop', () => {
  if (discoveryService) {
    discoveryService.setReceiverReady(false);
  }
  if (transferServer) {
    transferServer.stop();
  }
  return true;
});

ipcMain.handle('receiver:change-folder', (event, newFolder) => {
  if (transferServer) {
    transferServer.setDestinationFolder(newFolder);
  }
  return true;
});
