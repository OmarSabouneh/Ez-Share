package com.ezshare.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class DiscoveryService {
    public static final int DISCOVERY_PORT = 53317;
    public static final String PROTOCOL_TAG = "EZSHARE_V1";

    public interface DiscoveryCallback {
        void onDevicesUpdated(String devicesJson);
    }

    private final Context context;
    private final String deviceId;
    private final String deviceName;
    private final DiscoveryCallback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private DatagramSocket socket;
    private Thread listenThread;
    private Thread probeThread;
    private Thread cleanupThread;

    private volatile boolean isRunning = false;
    private volatile boolean isSearching = false;
    private volatile boolean isReceiving = false;
    private int receiverPort = 53318;

    private WifiManager.MulticastLock multicastLock;
    private final Map<String, DeviceInfo> discoveredDevices = new ConcurrentHashMap<>();

    public static class DeviceInfo {
        public String id;
        public String name;
        public String os;
        public String ip;
        public int port;
        public long lastSeen;
    }

    public DiscoveryService(Context context, DiscoveryCallback callback) {
        this.context = context;
        this.callback = callback;
        this.deviceId = "android_" + Build.MODEL.replaceAll("\\s+", "_") + "_" + UUID.randomUUID().toString().substring(0, 6);
        this.deviceName = Build.MANUFACTURER + " " + Build.MODEL;
    }

    public String getDeviceId() { return deviceId; }
    public String getDeviceName() { return deviceName; }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;

        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("EzShareMulticastLock");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {}

        listenThread = new Thread(this::listenLoop);
        listenThread.start();

        cleanupThread = new Thread(this::cleanupLoop);
        cleanupThread.start();
    }

    public synchronized void setReceiverReady(boolean ready, int port) {
        this.isReceiving = ready;
        this.receiverPort = port;
    }

    public synchronized void startSearching() {
        isSearching = true;
        discoveredDevices.clear();
        notifyDevicesUpdated();

        if (probeThread != null && probeThread.isAlive()) return;

        probeThread = new Thread(() -> {
            while (isRunning && isSearching) {
                sendProbe();
                try {
                    Thread.sleep(1500);
                } catch (InterruptedException e) {
                    break;
                }
            }
        });
        probeThread.start();
    }

    public synchronized void stopSearching() {
        isSearching = false;
    }

    private void sendProbe() {
        try {
            JSONObject senderObj = new JSONObject();
            senderObj.put("id", deviceId);
            senderObj.put("name", deviceName);
            senderObj.put("os", "android");

            JSONObject probe = new JSONObject();
            probe.put("protocol", PROTOCOL_TAG);
            probe.put("action", "DISCOVER_RECEIVERS");
            probe.put("sender", senderObj);

            byte[] data = probe.toString().getBytes(StandardCharsets.UTF_8);

            List<InetAddress> broadcasts = getBroadcastAddresses();
            for (InetAddress bcast : broadcasts) {
                try {
                    DatagramPacket packet = new DatagramPacket(data, data.length, bcast, DISCOVERY_PORT);
                    if (socket != null && !socket.isClosed()) {
                        socket.send(packet);
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    private void listenLoop() {
        try {
            socket = new DatagramSocket(DISCOVERY_PORT);
            socket.setBroadcast(true);
            socket.setReuseAddress(true);

            byte[] buffer = new byte[4096];
            while (isRunning && !socket.isClosed()) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);

                String msg = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                handleMessage(msg, packet.getAddress(), packet.getPort());
            }
        } catch (Exception ignored) {}
    }

    private void handleMessage(String msg, InetAddress senderIp, int senderPort) {
        try {
            JSONObject obj = new JSONObject(msg);
            if (!PROTOCOL_TAG.equals(obj.optString("protocol"))) return;

            String action = obj.optString("action");

            // 1. In Receive mode and received discovery probe
            if ("DISCOVER_RECEIVERS".equals(action) && isReceiving) {
                JSONObject sender = obj.optJSONObject("sender");
                if (sender != null && deviceId.equals(sender.optString("id"))) return;

                JSONObject dev = new JSONObject();
                dev.put("id", deviceId);
                dev.put("name", deviceName);
                dev.put("os", "android");
                dev.put("ip", getLocalIpAddress());
                dev.put("port", receiverPort);

                JSONObject reply = new JSONObject();
                reply.put("protocol", PROTOCOL_TAG);
                reply.put("action", "RECEIVER_READY");
                reply.put("device", dev);

                byte[] replyData = reply.toString().getBytes(StandardCharsets.UTF_8);
                DatagramPacket replyPacket = new DatagramPacket(replyData, replyData.length, senderIp, senderPort);
                if (socket != null && !socket.isClosed()) {
                    socket.send(replyPacket);
                }
            }
            // 2. In Searching mode and received response
            else if ("RECEIVER_READY".equals(action) && isSearching) {
                JSONObject dev = obj.optJSONObject("device");
                if (dev != null) {
                    String id = dev.optString("id");
                    if (!deviceId.equals(id)) {
                        DeviceInfo info = new DeviceInfo();
                        info.id = id;
                        info.name = dev.optString("name", "Device");
                        info.os = dev.optString("os", "unknown");
                        String ip = dev.optString("ip");
                        info.ip = (ip.isEmpty() || "127.0.0.1".equals(ip)) ? senderIp.getHostAddress() : ip;
                        info.port = dev.optInt("port", 53318);
                        info.lastSeen = System.currentTimeMillis();

                        discoveredDevices.put(id, info);
                        notifyDevicesUpdated();
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void cleanupLoop() {
        while (isRunning) {
            try {
                Thread.sleep(2000);
                long now = System.currentTimeMillis();
                boolean changed = false;

                for (Map.Entry<String, DeviceInfo> entry : discoveredDevices.entrySet()) {
                    if (now - entry.getValue().lastSeen > 4500) {
                        discoveredDevices.remove(entry.getKey());
                        changed = true;
                    }
                }

                if (changed) {
                    notifyDevicesUpdated();
                }
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void notifyDevicesUpdated() {
        try {
            org.json.JSONArray array = new org.json.JSONArray();
            for (DeviceInfo info : discoveredDevices.values()) {
                JSONObject o = new JSONObject();
                o.put("id", info.id);
                o.put("name", info.name);
                o.put("os", info.os);
                o.put("ip", info.ip);
                o.put("port", info.port);
                array.put(o);
            }
            final String json = array.toString();
            mainHandler.post(() -> callback.onDevicesUpdated(json));
        } catch (Exception ignored) {}
    }

    public static String getLocalIpAddress() {
        try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements();) {
                NetworkInterface intf = en.nextElement();
                if (!intf.isUp() || intf.isLoopback()) continue;

                for (Enumeration<InetAddress> enumIp = intf.getInetAddresses(); enumIp.hasMoreElements();) {
                    InetAddress addr = enumIp.nextElement();
                    if (!addr.isLoopbackAddress() && addr.getAddress().length == 4) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return "127.0.0.1";
    }

    private List<InetAddress> getBroadcastAddresses() {
        List<InetAddress> list = new ArrayList<>();
        try {
            list.add(InetAddress.getByName("255.255.255.255"));
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements();) {
                NetworkInterface intf = en.nextElement();
                if (!intf.isUp() || intf.isLoopback()) continue;

                for (InterfaceAddress ifa : intf.getInterfaceAddresses()) {
                    InetAddress bcast = ifa.getBroadcast();
                    if (bcast != null) list.add(bcast);
                }
            }
        } catch (Exception ignored) {}
        return list;
    }

    public synchronized void stop() {
        isRunning = false;
        isSearching = false;
        isReceiving = false;

        if (socket != null) {
            try { socket.close(); } catch (Exception ignored) {}
            socket = null;
        }

        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) {}
            multicastLock = null;
        }

        discoveredDevices.clear();
    }
}
