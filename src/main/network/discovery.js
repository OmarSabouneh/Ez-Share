const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

const DISCOVERY_PORT = 53317;
const PROTOCOL_TAG = 'EZSHARE_V1';

/**
 * Utility to get all local IPv4 broadcast addresses
 */
function getBroadcastAddresses() {
  const interfaces = os.networkInterfaces();
  const broadcastAddrs = new Set(['255.255.255.255']);

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        // Compute subnet broadcast if possible or default to global broadcast
        if (net.address && net.netmask) {
          const ipParts = net.address.split('.').map(Number);
          const maskParts = net.netmask.split('.').map(Number);
          const broadcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
          broadcastAddrs.add(broadcastParts.join('.'));
        }
      }
    }
  }

  return Array.from(broadcastAddrs);
}

/**
 * Get active non-internal IPv4 address
 */
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

class DiscoveryService extends EventEmitter {
  constructor(deviceId, deviceName) {
    super();
    this.deviceId = deviceId || `dev_${Math.random().toString(36).substring(2, 9)}`;
    this.deviceName = deviceName || os.hostname() || 'Windows PC';
    this.socket = null;
    this.broadcastTimer = null;
    this.discoveredDevices = new Map();
    this.cleanupTimer = null;
    this.isReceiving = false;
    this.receiverPort = 53318;
  }

  /**
   * Start listening for discovery packets.
   * Both sender and receiver use this socket.
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        this.emit('error', err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      this.socket.on('listening', () => {
        try {
          this.socket.setBroadcast(true);
        } catch (e) {
          // Some network interfaces may warn, ignore
        }
        this._startStaleDeviceCleanup();
        resolve();
      });

      this.socket.bind(DISCOVERY_PORT);
    });
  }

  /**
   * Set receiver ready state.
   * The device ONLY advertises availability when isReceiving === true!
   */
  setReceiverReady(isReady, port = 53318) {
    this.isReceiving = isReady;
    this.receiverPort = port;
  }

  /**
   * Start active sender search (broadcasting probe every 1.5s)
   */
  startSearching() {
    this.stopSearching();
    this.discoveredDevices.clear();
    this.emit('devices-updated', []);

    const sendProbe = () => {
      if (!this.socket) return;
      const payload = JSON.stringify({
        protocol: PROTOCOL_TAG,
        action: 'DISCOVER_RECEIVERS',
        sender: {
          id: this.deviceId,
          name: this.deviceName,
          os: 'windows'
        }
      });

      const message = Buffer.from(payload);
      const broadcasts = getBroadcastAddresses();

      for (const addr of broadcasts) {
        try {
          this.socket.send(message, 0, message.length, DISCOVERY_PORT, addr);
        } catch (e) {
          // ignore transient send errors
        }
      }
    };

    sendProbe();
    this.broadcastTimer = setInterval(sendProbe, 1500);
  }

  /**
   * Stop active sender search
   */
  stopSearching() {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  /**
   * Handle incoming UDP messages
   */
  _handleMessage(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data.protocol !== PROTOCOL_TAG) return;

      // 1. If we are in "Receive" mode and someone is looking for receivers:
      if (data.action === 'DISCOVER_RECEIVERS' && this.isReceiving) {
        // Do not respond to self if sender id is same
        if (data.sender && data.sender.id === this.deviceId) return;

        const responsePayload = JSON.stringify({
          protocol: PROTOCOL_TAG,
          action: 'RECEIVER_READY',
          device: {
            id: this.deviceId,
            name: this.deviceName,
            os: 'windows',
            ip: getLocalIp(),
            port: this.receiverPort
          }
        });

        const replyBuf = Buffer.from(responsePayload);
        this.socket.send(replyBuf, 0, replyBuf.length, rinfo.port, rinfo.address);
        return;
      }

      // 2. If we are a sender searching for receivers and got a RECEIVER_READY reply:
      if (data.action === 'RECEIVER_READY') {
        const dev = data.device;
        if (!dev || dev.id === this.deviceId) return;

        // Use actual remote sender address if dev.ip is loopback or mismatched
        const resolvedIp = (dev.ip && dev.ip !== '127.0.0.1') ? dev.ip : rinfo.address;

        const deviceInfo = {
          id: dev.id,
          name: dev.name || 'Unknown Device',
          os: dev.os || 'unknown',
          ip: resolvedIp,
          port: dev.port || 53318,
          lastSeen: Date.now()
        };

        this.discoveredDevices.set(dev.id, deviceInfo);
        this.emit('devices-updated', Array.from(this.discoveredDevices.values()));
      }
    } catch (e) {
      // ignore malformed packets
    }
  }

  /**
   * Periodically remove devices not seen in the last 4.5 seconds
   */
  _startStaleDeviceCleanup() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, dev] of this.discoveredDevices.entries()) {
        if (now - dev.lastSeen > 4500) {
          this.discoveredDevices.delete(id);
          changed = true;
        }
      }
      if (changed) {
        this.emit('devices-updated', Array.from(this.discoveredDevices.values()));
      }
    }, 2000);
  }

  /**
   * Stop everything and close socket
   */
  stop() {
    this.stopSearching();
    this.isReceiving = false;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
      this.socket = null;
    }
    this.discoveredDevices.clear();
  }
}

module.exports = {
  DiscoveryService,
  getLocalIp,
  DISCOVERY_PORT
};
