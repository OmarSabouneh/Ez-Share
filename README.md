# 🚀 EzShare - High-Speed LAN File Transfer

EzShare is a modern, peer-to-peer local network file transfer application designed for blazing-fast transfers between Windows and Mobile devices on the same Wi-Fi/LAN network.

---

## ✨ Features

- **⚡ Blazing Fast Streaming**: Direct TCP/HTTP chunked streaming (1–4 MB buffers) utilizing full LAN speeds (often 30–100+ MB/s).
- **🔒 Zero Cloud Dependency**: 100% local and private. Files never leave your local Wi-Fi network.
- **📡 On-Demand LAN Discovery**: Automatic UDP broadcast discovery (`53317`) on local subnets.
- **🛡️ Strict Conditional Visibility**: The receiver is **only visible and discoverable after** explicitly choosing to receive and selecting the destination storage folder.
- **📁 Multi-File Transfer**: Select single or multiple files with real-time throughput metrics, progress bars, and ETA countdowns.
- **💎 Cyber-Clean Aesthetics**: Modern dark glassmorphic interface with interactive radar sweep and micro-animations.

---

## 🏗️ Architecture & Protocols

```
┌────────────────┐                     ┌────────────────┐
│  Sender (App)  │                     │ Receiver (App) │
└───────┬────────┘                     └───────┬────────┘
        │                                      │ (User picks save folder)
        │                                      │ (Starts HTTP Server :53318)
        │── UDP Broadcast (Probe :53317) ─────>│ (Listens on UDP :53317)
        │<── UDP Unicast (Offer :53317) ───────│
        │                                      │
        │── POST /api/transfer/handshake ─────>│ (Manifest: files, sizes)
        │<── 200 OK (Session Accepted) ────────│
        │                                      │
        │── POST /api/transfer/file (Stream) ─>│ (Writes directly to disk)
        │<── 200 OK (File Verified) ───────────│
        │                                      │
        │── POST /api/transfer/complete ──────>│
        │<── 200 OK (Transfer Finished) ───────│
```

---

## 💻 Running from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or newer)
- npm (v9 or newer)

### Installation
```bash
# Clone the repository
git clone https://github.com/your-username/EzShare.git
cd EzShare

# Install dependencies
npm install

# Launch the application
npm start
```

---

## 📦 Building Standalone Release

To package the standalone Windows `.exe` application:

```bash
npm run build:win
```

The output will be placed in the `../EzShare-Releases` directory ready to run without requiring Node.js to be installed.

---

## 📱 Mobile (Android) Interoperability

EzShare uses a standardized JSON over UDP discovery protocol and HTTP/1.1 chunked file streaming. The upcoming Android companion app utilizes the same ports:
- **Discovery Port**: `UDP 53317`
- **Transfer Port**: `TCP 53318`

---

## 📄 License
MIT License. Feel free to use and contribute!
