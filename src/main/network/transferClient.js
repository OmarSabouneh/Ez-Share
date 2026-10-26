const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class TransferClient extends EventEmitter {
  constructor() {
    super();
    this.isCancelled = false;
    this.activeRequest = null;
    this.activeReadStream = null;
  }

  /**
   * Cancel in-flight transfer
   */
  cancel() {
    this.isCancelled = true;
    if (this.activeReadStream) {
      try { this.activeReadStream.destroy(); } catch (e) {}
      this.activeReadStream = null;
    }
    if (this.activeRequest) {
      try { this.activeRequest.destroy(); } catch (e) {}
      this.activeRequest = null;
    }
    this.emit('cancelled');
  }

  /**
   * Send files to remote target device
   */
  async sendFiles(targetIp, targetPort, filesList, senderName = 'Windows PC') {
    this.isCancelled = false;

    // Validate files and compute total size
    const files = [];
    let totalSizeBytes = 0;

    for (let i = 0; i < filesList.length; i++) {
      const f = filesList[i];
      const stats = fs.statSync(f.path);
      const fileEntry = {
        id: String(i),
        path: f.path,
        name: f.name || path.basename(f.path),
        size: stats.size
      };
      files.push(fileEntry);
      totalSizeBytes += stats.size;
    }

    const manifest = {
      senderName,
      totalFiles: files.length,
      totalSizeBytes,
      files: files.map(f => ({ id: f.id, name: f.name, size: f.size }))
    };

    // 1. Perform Handshake
    this.emit('status-update', { status: 'handshaking', message: 'Connecting to device...' });
    const handshakeResult = await this._postJson(targetIp, targetPort, '/api/transfer/handshake', manifest);

    if (!handshakeResult.accepted) {
      throw new Error('Transfer declined by recipient.');
    }

    // 2. Stream Each File
    let totalBytesSentSoFar = 0;
    const sessionStartTime = Date.now();
    let lastTelemetryTime = Date.now();
    let bytesSinceLastTelemetry = 0;

    for (let index = 0; index < files.length; index++) {
      if (this.isCancelled) throw new Error('Transfer was cancelled.');

      const file = files[index];
      this.emit('status-update', {
        status: 'transferring',
        currentFileIndex: index + 1,
        totalFiles: files.length,
        currentFileName: file.name
      });

      await this._streamSingleFile(targetIp, targetPort, file, (chunkLen) => {
        totalBytesSentSoFar += chunkLen;
        bytesSinceLastTelemetry += chunkLen;

        const now = Date.now();
        if (now - lastTelemetryTime >= 300) {
          const deltaSec = (now - lastTelemetryTime) / 1000;
          const speedBytesPerSec = bytesSinceLastTelemetry / deltaSec;
          const remainingBytes = Math.max(0, totalSizeBytes - totalBytesSentSoFar);
          const etaSeconds = speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : 0;
          const progressPercent = totalSizeBytes > 0 ? Math.min(100, (totalBytesSentSoFar / totalSizeBytes) * 100) : 100;

          this.emit('transfer-progress', {
            currentFileIndex: index + 1,
            totalFiles: files.length,
            currentFileName: file.name,
            totalBytesSentSoFar,
            totalSizeBytes,
            speedBytesPerSec,
            progressPercent,
            etaSeconds
          });

          lastTelemetryTime = now;
          bytesSinceLastTelemetry = 0;
        }
      });
    }

    // 3. Finalize Transfer
    if (this.isCancelled) throw new Error('Transfer was cancelled.');
    await this._postJson(targetIp, targetPort, '/api/transfer/complete', { success: true });

    const totalDurationSec = (Date.now() - sessionStartTime) / 1000;
    const avgSpeedBytesPerSec = totalDurationSec > 0 ? totalSizeBytes / totalDurationSec : 0;

    const summary = {
      totalFiles: files.length,
      totalSizeBytes,
      totalDurationSec,
      avgSpeedBytesPerSec
    };

    this.emit('transfer-complete', summary);
    return summary;
  }

  /**
   * Stream a single file to target receiver
   */
  _streamSingleFile(targetIp, targetPort, file, onChunk) {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(file.path, { highWaterMark: 1024 * 1024 });
      this.activeReadStream = readStream;

      const encodedName = encodeURIComponent(file.name);
      const req = http.request({
        host: targetIp,
        port: targetPort,
        path: `/api/transfer/file?id=${file.id}&name=${encodedName}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': file.size
        }
      }, (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          this.activeRequest = null;
          this.activeReadStream = null;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Server error (${res.statusCode}): ${respData}`));
          }
        });
      });

      this.activeRequest = req;

      req.on('error', (err) => {
        readStream.destroy();
        this.activeRequest = null;
        this.activeReadStream = null;
        reject(err);
      });

      readStream.on('data', (chunk) => {
        if (this.isCancelled) {
          readStream.destroy();
          req.destroy();
          return;
        }
        onChunk(chunk.length);
      });

      readStream.on('error', (err) => {
        req.destroy();
        this.activeRequest = null;
        this.activeReadStream = null;
        reject(err);
      });

      readStream.pipe(req);
    });
  }

  /**
   * Helper to POST JSON payload
   */
  _postJson(targetIp, targetPort, path, data) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(data);
      const req = http.request({
        host: targetIp,
        port: targetPort,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (e) {
            resolve({ raw: body, statusCode: res.statusCode });
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = {
  TransferClient
};
