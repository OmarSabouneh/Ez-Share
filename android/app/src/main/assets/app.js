// ==========================================================================
// EzShare Renderer Application Logic (Windows & Android Cross-Platform)
// ==========================================================================

// Android Bridge Shim
if (window.AndroidHost && !window.ezshare) {
  let _reqId = 0;
  window._pending = window._pending || {};
  window.__ezshare_resolve = function(id, res, err) {
    if (window._pending[id]) {
      if (err) window._pending[id].reject(new Error(err));
      else window._pending[id].resolve(res);
      delete window._pending[id];
    }
  };
  const _listeners = {};
  window.__ezshare_dispatch = function(eventName, data) {
    if (_listeners[eventName]) {
      _listeners[eventName].forEach(fn => fn(typeof data === 'string' ? JSON.parse(data) : data));
    }
  };
  function callAndroid(action, payload) {
    return new Promise((resolve, reject) => {
      const id = ++_reqId;
      window._pending[id] = { resolve, reject };
      window.AndroidHost.callNative(id, action, typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
    });
  }
  window.ezshare = {
    selectFiles: () => callAndroid('selectFiles'),
    selectDirectory: () => callAndroid('selectDirectory'),
    openFolder: (p) => callAndroid('openFolder', p),
    getLocalInfo: () => callAndroid('getLocalInfo'),
    startDiscovery: () => callAndroid('startDiscovery'),
    stopDiscovery: () => callAndroid('stopDiscovery'),
    sendFiles: (targetDevice, files) => callAndroid('sendFiles', { targetDevice, files }),
    cancelSend: () => callAndroid('cancelSend'),
    startReceiver: (folder) => callAndroid('startReceiver', folder),
    stopReceiver: () => callAndroid('stopReceiver'),
    changeDestinationFolder: (folder) => callAndroid('changeDestinationFolder', folder),

    onDevicesUpdated: (cb) => {
      _listeners['devices-updated'] = _listeners['devices-updated'] || [];
      _listeners['devices-updated'].push(cb);
    },
    onTransferProgress: (cb) => {
      _listeners['transfer-progress'] = _listeners['transfer-progress'] || [];
      _listeners['transfer-progress'].push(cb);
    },
    onTransferComplete: (cb) => {
      _listeners['transfer-complete'] = _listeners['transfer-complete'] || [];
      _listeners['transfer-complete'].push(cb);
    },
    onTransferRequested: (cb) => {
      _listeners['transfer-requested'] = _listeners['transfer-requested'] || [];
      _listeners['transfer-requested'].push(cb);
    },
    onError: (cb) => {
      _listeners['error'] = _listeners['error'] || [];
      _listeners['error'].push(cb);
    }
  };
}

const State = {
  currentView: 'viewHome',
  mode: null, // 'sender' | 'receiver' | null
  stagedFiles: [],
  discoveredDevices: [],
  receiverFolder: null,
  localInfo: {
    deviceName: 'Windows Device',
    ip: '127.0.0.1'
  },
  transferSummary: null
};

// DOM Elements
const views = {
  home: document.getElementById('viewHome'),
  senderFiles: document.getElementById('viewSenderFiles'),
  senderDiscovery: document.getElementById('viewSenderDiscovery'),
  receiverReady: document.getElementById('viewReceiverReady'),
  transferActive: document.getElementById('viewTransferActive'),
  transferComplete: document.getElementById('viewTransferComplete')
};

// Formatting utilities
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.0 MB/s';
  const mbPerSec = bytesPerSec / (1024 * 1024);
  if (mbPerSec >= 1) {
    return `${mbPerSec.toFixed(1)} MB/s`;
  }
  const kbPerSec = bytesPerSec / 1024;
  return `${kbPerSec.toFixed(0)} KB/s`;
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return 'Calculating...';
  if (seconds < 60) return `~${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `~${mins}m ${secs}s`;
}

// Navigation helper
function switchView(targetViewId) {
  Object.values(views).forEach(v => {
    if (v) v.classList.remove('active');
  });

  const target = document.getElementById(targetViewId);
  if (target) {
    target.classList.add('active');
    State.currentView = targetViewId;
  }
}

// Initialize App
async function initApp() {
  try {
    State.localInfo = await window.ezshare.getLocalInfo();
    const networkIpText = document.getElementById('networkIpText');
    if (networkIpText) {
      networkIpText.textContent = `${State.localInfo.deviceName} (${State.localInfo.ip})`;
    }
  } catch (err) {
    console.error('Failed to get local info:', err);
  }

  setupEventListeners();
  setupIPCListeners();
}

// Helper to completely reset transfer dashboard UI
function resetTransferUI() {
  const speedEl = document.getElementById('metricSpeed');
  const etaEl = document.getElementById('metricEta');
  const filesEl = document.getElementById('metricFilesProgress');
  const progressFill = document.getElementById('progressBarFill');
  const progressBytes = document.getElementById('progressBytesText');
  const progressPercent = document.getElementById('progressPercentText');
  const currentFileName = document.getElementById('currentFileNameText');

  if (speedEl) speedEl.textContent = '0.0 MB/s';
  if (etaEl) etaEl.textContent = 'Calculating...';
  if (filesEl) filesEl.textContent = '0 / 0 Files';
  if (progressFill) progressFill.style.width = '0%';
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressBytes) progressBytes.textContent = '0 MB / 0 MB';
  if (currentFileName) currentFileName.textContent = 'Initializing transfer session...';
}

function setupEventListeners() {
  // 1. Home: Choose Send
  document.getElementById('btnChooseSend')?.addEventListener('click', async () => {
    State.mode = 'sender';
    resetTransferUI();
    const files = await window.ezshare.selectFiles();
    if (files && files.length > 0) {
      State.stagedFiles = [...files];
      renderStagedFiles();
      switchView('viewSenderFiles');
    }
  });

  // 2. Home: Choose Receive
  document.getElementById('btnChooseReceive')?.addEventListener('click', async () => {
    State.mode = 'receiver';
    resetTransferUI();
    await startReceiving(State.receiverFolder || "");
  });

  // 3. Staging Actions
  document.getElementById('btnBackFromStaging')?.addEventListener('click', () => {
    State.stagedFiles = [];
    resetTransferUI();
    switchView('viewHome');
  });

  document.getElementById('btnAddMoreFiles')?.addEventListener('click', async () => {
    const moreFiles = await window.ezshare.selectFiles();
    if (moreFiles && moreFiles.length > 0) {
      const existingPaths = new Set(State.stagedFiles.map(f => f.path));
      for (const f of moreFiles) {
        if (!existingPaths.has(f.path)) {
          State.stagedFiles.push(f);
        }
      }
      renderStagedFiles();
    }
  });

  document.getElementById('btnProceedToDiscovery')?.addEventListener('click', () => {
    if (State.stagedFiles.length === 0) return;
    window.ezshare.startDiscovery();
    switchView('viewSenderDiscovery');
  });

  // 4. Discovery Actions
  document.getElementById('btnBackFromDiscovery')?.addEventListener('click', () => {
    window.ezshare.stopDiscovery();
    switchView('viewSenderFiles');
  });

  // 5. Receiver Actions
  document.getElementById('btnStopReceiver')?.addEventListener('click', async () => {
    await window.ezshare.stopReceiver();
    resetTransferUI();
    switchView('viewHome');
  });

  document.getElementById('btnChangeReceiverPath')?.addEventListener('click', async () => {
    const newFolder = await window.ezshare.selectDirectory();
    if (newFolder) {
      State.receiverFolder = newFolder;
      await window.ezshare.changeDestinationFolder(newFolder);
      const pathEl = document.getElementById('receiverSavePathText');
      if (pathEl) pathEl.textContent = newFolder;
    }
  });

  // 6. Transfer Actions
  document.getElementById('btnCancelTransfer')?.addEventListener('click', async () => {
    try { await window.ezshare.cancelSend(); } catch (e) {}
    resetTransferUI();
    switchView('viewHome');
  });

  // 7. Complete Actions
  document.getElementById('btnOpenSaveDirectory')?.addEventListener('click', () => {
    if (State.receiverFolder) {
      window.ezshare.openFolder(State.receiverFolder);
    }
  });

  document.getElementById('btnReturnHome')?.addEventListener('click', () => {
    State.stagedFiles = [];
    State.transferSummary = null;
    resetTransferUI();
    switchView('viewHome');
  });
}

// Start Receiver Engine
async function startReceiving(folder) {
  try {
    const res = await window.ezshare.startReceiver(folder || "");
    if (res && res.destinationFolder) {
      State.receiverFolder = res.destinationFolder;
      const nameEl = document.getElementById('receiverDeviceNameText');
      const pathEl = document.getElementById('receiverSavePathText');
      if (nameEl) nameEl.textContent = State.localInfo.deviceName;
      if (pathEl) pathEl.textContent = res.destinationFolder;
      switchView('viewReceiverReady');
    } else {
      const picked = await window.ezshare.selectDirectory();
      if (picked) {
        State.receiverFolder = picked;
        await startReceiving(picked);
      } else {
        switchView('viewHome');
      }
    }
  } catch (err) {
    alert(`Could not start receiver: ${err.message}`);
  }
}

// Render Staged Files
function renderStagedFiles() {
  const container = document.getElementById('stagingFilesList');
  const summaryBadge = document.getElementById('stagingSummaryBadge');
  if (!container) return;

  container.innerHTML = '';
  let totalBytes = 0;

  State.stagedFiles.forEach((file, index) => {
    totalBytes += file.size;

    const row = document.createElement('div');
    row.className = 'file-item-row';
    row.innerHTML = `
      <div class="file-item-info">
        <div class="file-type-icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="file-name-meta">
          <span class="file-name" title="${file.name}">${file.name}</span>
          <span class="file-size">${formatBytes(file.size)}</span>
        </div>
      </div>
      <button class="file-remove-btn" data-index="${index}" title="Remove file">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    row.querySelector('.file-remove-btn').addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      State.stagedFiles.splice(idx, 1);
      if (State.stagedFiles.length === 0) {
        switchView('viewHome');
      } else {
        renderStagedFiles();
      }
    });

    container.appendChild(row);
  });

  if (summaryBadge) {
    summaryBadge.textContent = `${State.stagedFiles.length} file${State.stagedFiles.length > 1 ? 's' : ''} (${formatBytes(totalBytes)})`;
  }
}

// Render Discovered Devices
function renderDiscoveredDevices(devices) {
  const grid = document.getElementById('discoveredDevicesGrid');
  const emptyNotice = document.getElementById('emptyDevicesNotice');
  if (!grid) return;

  // Clear previous device cards except empty notice
  const cards = grid.querySelectorAll('.device-card');
  cards.forEach(c => c.remove());

  if (!devices || devices.length === 0) {
    if (emptyNotice) emptyNotice.style.display = 'block';
    return;
  }

  if (emptyNotice) emptyNotice.style.display = 'none';

  devices.forEach(device => {
    const card = document.createElement('div');
    card.className = 'device-card';

    const isAndroid = (device.os || '').toLowerCase() === 'android';
    const osIcon = isAndroid 
      ? `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`
      : `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;

    card.innerHTML = `
      <div class="device-card-top">
        <div class="device-avatar">${osIcon}</div>
        <div class="device-details">
          <h4>${device.name}</h4>
          <span class="device-os-tag">${device.os || 'Device'}</span>
        </div>
      </div>
      <div class="device-ip-info">${device.ip}:${device.port}</div>
      <div class="device-send-action">
        <span>Send Files &rarr;</span>
      </div>
    `;

    card.addEventListener('click', () => {
      initiateTransferToDevice(device);
    });

    grid.appendChild(card);
  });
}

// Initiate Transfer from Sender
async function initiateTransferToDevice(targetDevice) {
  resetTransferUI();
  const transferTitle = document.getElementById('transferTitle');
  const transferTargetSub = document.getElementById('transferTargetSub');
  if (transferTitle) transferTitle.textContent = 'Sending Files...';
  if (transferTargetSub) transferTargetSub.textContent = `Streaming to ${targetDevice.name} (${targetDevice.ip})`;

  switchView('viewTransferActive');

  try {
    await window.ezshare.sendFiles(targetDevice, State.stagedFiles);
  } catch (err) {
    alert(`Transfer error: ${err.message}`);
    resetTransferUI();
    switchView('viewSenderDiscovery');
  }
}

// Setup IPC Listeners from Backend
function setupIPCListeners() {
  // Discovery updates
  window.ezshare.onDevicesUpdated((devices) => {
    State.discoveredDevices = devices;
    if (State.currentView === 'viewSenderDiscovery') {
      renderDiscoveredDevices(devices);
    }
  });

  // Transfer requested by remote sender
  window.ezshare.onTransferRequested((data) => {
    resetTransferUI();
    const transferTitle = document.getElementById('transferTitle');
    const transferTargetSub = document.getElementById('transferTargetSub');
    if (transferTitle) transferTitle.textContent = 'Receiving Files...';
    if (transferTargetSub) transferTargetSub.textContent = `Incoming from ${data.senderName} (${data.totalFiles} files, ${formatBytes(data.totalSizeBytes)})`;

    switchView('viewTransferActive');
  });

  // Live telemetry
  window.ezshare.onTransferProgress((p) => {
    const speedEl = document.getElementById('metricSpeed');
    const etaEl = document.getElementById('metricEta');
    const filesEl = document.getElementById('metricFilesProgress');
    const progressFill = document.getElementById('progressBarFill');
    const progressBytes = document.getElementById('progressBytesText');
    const progressPercent = document.getElementById('progressPercentText');
    const currentFileName = document.getElementById('currentFileNameText');

    if (speedEl) speedEl.textContent = formatSpeed(p.speedBytesPerSec);
    if (etaEl) etaEl.textContent = formatTime(p.etaSeconds);
    if (filesEl && p.currentFileIndex) {
      filesEl.textContent = `${p.currentFileIndex} / ${p.totalFiles} Files`;
    }

    const pct = Math.round(p.progressPercent || 0);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;

    const transferred = p.totalBytesSentSoFar || p.totalSessionBytesReceived || 0;
    const total = p.totalSizeBytes || p.totalSessionBytes || 0;
    if (progressBytes) {
      progressBytes.textContent = `${formatBytes(transferred)} / ${formatBytes(total)}`;
    }

    if (currentFileName && (p.currentFileName || p.filename)) {
      currentFileName.textContent = `Writing: ${p.currentFileName || p.filename}`;
    }
  });

  // Transfer Complete
  window.ezshare.onTransferComplete((summary) => {
    State.transferSummary = summary;
    const completeSubtitle = document.getElementById('completeSubtitle');
    const statsBox = document.getElementById('completeStatsBox');
    const openDirBtn = document.getElementById('btnOpenSaveDirectory');

    if (completeSubtitle) {
      completeSubtitle.textContent = State.mode === 'sender' 
        ? `Successfully sent ${summary.totalFiles} files.`
        : `Successfully received and saved ${summary.totalFiles} files.`;
    }

    if (openDirBtn) {
      openDirBtn.style.display = (State.mode === 'receiver' && State.receiverFolder) ? 'inline-flex' : 'none';
    }

    if (statsBox) {
      const duration = summary.totalDurationSec ? `${summary.totalDurationSec.toFixed(1)}s` : 'Instant';
      const avgSpeed = summary.avgSpeedBytesPerSec ? formatSpeed(summary.avgSpeedBytesPerSec) : '--';
      const totalSize = formatBytes(summary.totalSizeBytes || summary.totalBytes || 0);

      statsBox.innerHTML = `
        <div class="stat-item">
          <span class="stat-label">Total Files</span>
          <span class="stat-val">${summary.totalFiles}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Total Transferred</span>
          <span class="stat-val">${totalSize}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Duration</span>
          <span class="stat-val">${duration}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Average Speed</span>
          <span class="stat-val">${avgSpeed}</span>
        </div>
      `;
    }

    switchView('viewTransferComplete');
  });

  // Error notifications
  window.ezshare.onError((err) => {
    alert(`Error: ${err}`);
  });
}

// Start app on DOM load
window.addEventListener('DOMContentLoaded', initApp);
