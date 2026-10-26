const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DEFAULT_SERVER_PORT = 53318;

/**
 * Sanitize filename to avoid directory traversal and illegal Windows filename chars
 */
function sanitizeFilename(filename) {
  // Strip path separators
  let clean = path.basename(filename);
  // Remove illegal Windows characters: \ / : * ? " < > |
  clean = clean.replace(/[\\/:*?"<>|]/g, '_');
  // Trim spaces and dots from end (Windows requirement)
  clean = clean.replace(/[ .]+$/, '');
  return clean || 'unnamed_file';
}

/**
 * Generate a unique file path if file already exists in target directory
 */
function getUniqueFilePath(dir, originalName) {
  const safeName = sanitizeFilename(originalName);
  let targetPath = path.join(dir, safeName);
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }

  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let counter = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return targetPath;
}

class TransferServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = DEFAULT_SERVER_PORT;
    this.destinationFolder = null;
    this.currentSession = null;
    this.activeWriteStream = null;
  }

  /**
   * Start receiver HTTP server
   */
  start(destinationFolder, preferredPort = DEFAULT_SERVER_PORT) {
    return new Promise((resolve, reject) => {
      this.destinationFolder = destinationFolder;
      this.port = preferredPort;

      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Try next port if port is busy
          this.port++;
          this.server.listen(this.port, '0.0.0.0');
        } else {
          this.emit('error', err);
          reject(err);
        }
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve(this.port);
      });
    });
  }

  /**
   * Update destination folder path
   */
  setDestinationFolder(newFolder) {
    this.destinationFolder = newFolder;
  }

  /**
   * Handle incoming HTTP requests
   */
  _handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for interoperability
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 1. Handshake request
    if (pathname === '/api/transfer/handshake' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const manifest = JSON.parse(body);
          const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          
          this.currentSession = {
            id: sessionId,
            senderName: manifest.senderName || 'Remote Device',
            totalFiles: manifest.totalFiles || manifest.files?.length || 0,
            totalSizeBytes: manifest.totalSizeBytes || 0,
            files: manifest.files || [],
            receivedBytesTotal: 0,
            startTime: Date.now(),
            savedFiles: []
          };

          this.emit('transfer-requested', {
            sessionId,
            senderName: this.currentSession.senderName,
            totalFiles: this.currentSession.totalFiles,
            totalSizeBytes: this.currentSession.totalSizeBytes,
            files: this.currentSession.files
          });

          // Handshake acknowledged
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sessionId, status: 'ready' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid manifest format' }));
        }
      });
      return;
    }

    // 2. File upload stream
    if (pathname.startsWith('/api/transfer/file') && req.method === 'POST') {
      const fileId = parsedUrl.searchParams.get('id');
      const filenameParam = parsedUrl.searchParams.get('name') || `file_${fileId}`;
      const decodedFilename = decodeURIComponent(filenameParam);

      if (!this.destinationFolder || !fs.existsSync(this.destinationFolder)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Destination folder unavailable' }));
        return;
      }

      const targetPath = getUniqueFilePath(this.destinationFolder, decodedFilename);
      const writeStream = fs.createWriteStream(targetPath, { highWaterMark: 1024 * 1024 });
      this.activeWriteStream = writeStream;

      let fileReceivedBytes = 0;
      let lastTelemetryTime = Date.now();
      let bytesSinceLastTelemetry = 0;

      req.on('data', chunk => {
        writeStream.write(chunk);
        fileReceivedBytes += chunk.length;
        bytesSinceLastTelemetry += chunk.length;
        if (this.currentSession) {
          this.currentSession.receivedBytesTotal += chunk.length;
        }

        const now = Date.now();
        if (now - lastTelemetryTime >= 300) {
          const deltaSec = (now - lastTelemetryTime) / 1000;
          const speedBytesPerSec = bytesSinceLastTelemetry / deltaSec;
          
          this.emit('transfer-progress', {
            fileId,
            filename: decodedFilename,
            fileReceivedBytes,
            totalSessionBytesReceived: this.currentSession?.receivedBytesTotal || fileReceivedBytes,
            totalSessionBytes: this.currentSession?.totalSizeBytes || 0,
            speedBytesPerSec,
            progressPercent: this.currentSession?.totalSizeBytes 
              ? Math.min(100, (this.currentSession.receivedBytesTotal / this.currentSession.totalSizeBytes) * 100)
              : 0
          });

          lastTelemetryTime = now;
          bytesSinceLastTelemetry = 0;
        }
      });

      req.on('end', () => {
        writeStream.end(() => {
          this.activeWriteStream = null;
          if (this.currentSession) {
            this.currentSession.savedFiles.push(targetPath);
          }

          this.emit('file-received', {
            fileId,
            filename: decodedFilename,
            savedPath: targetPath,
            sizeBytes: fileReceivedBytes
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, savedPath: targetPath }));
        });
      });

      req.on('error', err => {
        writeStream.destroy();
        this.emit('error', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      return;
    }

    // 3. Complete session
    if (pathname === '/api/transfer/complete' && req.method === 'POST') {
      const summary = {
        totalFiles: this.currentSession?.savedFiles.length || 0,
        totalBytes: this.currentSession?.receivedBytesTotal || 0,
        destinationFolder: this.destinationFolder,
        savedFiles: this.currentSession?.savedFiles || []
      };

      this.emit('transfer-complete', summary);
      this.currentSession = null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, summary }));
      return;
    }

    // Default 404
    res.writeHead(404);
    res.end('Not Found');
  }

  /**
   * Stop receiver HTTP server
   */
  stop() {
    if (this.activeWriteStream) {
      try { this.activeWriteStream.destroy(); } catch (e) {}
      this.activeWriteStream = null;
    }
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }
    this.currentSession = null;
  }
}

module.exports = {
  TransferServer,
  DEFAULT_SERVER_PORT,
  sanitizeFilename,
  getUniqueFilePath
};
