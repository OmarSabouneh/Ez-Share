package com.ezshare.app;

import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class TransferServer {
    public static final int DEFAULT_PORT = 53318;

    public interface ServerCallback {
        void onTransferRequested(String json);
        void onTransferProgress(String json);
        void onTransferComplete(String json);
        void onError(String message);
    }

    private final Context context;
    private final ServerCallback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private ServerSocket serverSocket;
    private Thread serverThread;
    private volatile boolean isRunning = false;
    private String destinationFolder;

    private JSONObject currentSession;
    private long totalBytesReceived = 0;
    private long sessionStartTime = 0;
    private int port = DEFAULT_PORT;

    public TransferServer(Context context, ServerCallback callback) {
        this.context = context;
        this.callback = callback;
    }

    public synchronized int start(String destinationFolder, int preferredPort) {
        this.destinationFolder = destinationFolder;
        this.port = preferredPort;
        this.isRunning = true;

        for (int p = preferredPort; p < preferredPort + 10; p++) {
            try {
                serverSocket = new ServerSocket(p);
                this.port = p;
                break;
            } catch (Exception ignored) {}
        }

        serverThread = new Thread(this::listenLoop);
        serverThread.start();
        return this.port;
    }

    public synchronized int start(Uri destinationFolder, int preferredPort) {
        return start(destinationFolder != null ? destinationFolder.toString() : null, preferredPort);
    }

    public void setDestinationFolder(String newFolder) {
        this.destinationFolder = newFolder;
    }

    public void setDestinationFolder(Uri newFolder) {
        this.destinationFolder = newFolder != null ? newFolder.toString() : null;
    }

    private void listenLoop() {
        while (isRunning && serverSocket != null && !serverSocket.isClosed()) {
            try {
                Socket client = serverSocket.accept();
                new Thread(() -> handleClient(client)).start();
            } catch (Exception ignored) {
                break;
            }
        }
    }

    private void handleClient(Socket client) {
        try (client;
             InputStream rawIn = client.getInputStream();
             BufferedInputStream in = new BufferedInputStream(rawIn);
             OutputStream out = client.getOutputStream()) {

            // Read HTTP request line
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;

            String method = parts[0];
            String rawUrl = parts[1];

            // Read headers
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(), line.substring(colon + 1).trim());
                }
            }

            if ("100-continue".equalsIgnoreCase(headers.get("expect"))) {
                out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
            }

            long contentLength = 0;
            String clStr = headers.get("content-length");
            if (clStr != null) {
                try { contentLength = Long.parseLong(clStr); } catch (Exception ignored) {}
            }

            // Handshake
            if ("POST".equalsIgnoreCase(method) && rawUrl.startsWith("/api/transfer/handshake")) {
                byte[] body = new byte[(int) contentLength];
                int read = 0;
                while (read < contentLength) {
                    int r = in.read(body, read, (int) contentLength - read);
                    if (r <= 0) break;
                    read += r;
                }
                String bodyStr = new String(body, StandardCharsets.UTF_8);
                currentSession = new JSONObject(bodyStr);
                totalBytesReceived = 0;
                sessionStartTime = System.currentTimeMillis();

                mainHandler.post(() -> callback.onTransferRequested(bodyStr));

                sendHttpResponse(out, 200, "OK", "application/json", "{\"accepted\":true,\"status\":\"ready\"}");
                return;
            }

            // File stream
            if ("POST".equalsIgnoreCase(method) && rawUrl.startsWith("/api/transfer/file")) {
                String fileName = "received_file";
                int qIdx = rawUrl.indexOf('?');
                if (qIdx >= 0) {
                    String query = rawUrl.substring(qIdx + 1);
                    for (String param : query.split("&")) {
                        String[] pair = param.split("=");
                        if (pair.length > 1 && "name".equalsIgnoreCase(pair[0])) {
                            fileName = URLDecoder.decode(pair[1], "UTF-8");
                        }
                    }
                }

                OutputStream fileOut = null;
                File physicalFile = null;

                if (destinationFolder != null && destinationFolder.startsWith("content://")) {
                    DocumentFile dir = DocumentFile.fromTreeUri(context, Uri.parse(destinationFolder));
                    if (dir == null || !dir.canWrite()) {
                        sendHttpResponse(out, 500, "Error", "application/json", "{\"error\":\"Cannot write to destination\"}");
                        return;
                    }

                    DocumentFile targetFile = dir.createFile("application/octet-stream", fileName);
                    if (targetFile == null) {
                        sendHttpResponse(out, 500, "Error", "application/json", "{\"error\":\"File creation failed\"}");
                        return;
                    }
                    fileOut = context.getContentResolver().openOutputStream(targetFile.getUri());
                } else {
                    String folderPath = (destinationFolder != null && !destinationFolder.isEmpty())
                            ? destinationFolder
                            : new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "EzShare").getAbsolutePath();

                    File dir = new File(folderPath);
                    if (!dir.exists()) {
                        dir.mkdirs();
                    }
                    physicalFile = new File(dir, fileName);
                    fileOut = new FileOutputStream(physicalFile);
                }

                if (fileOut == null) {
                    sendHttpResponse(out, 500, "Error", "application/json", "{\"error\":\"Could not open destination stream\"}");
                    return;
                }

                try (OutputStream outStream = fileOut) {
                    byte[] buffer = new byte[1024 * 1024];
                    long remaining = contentLength;
                    long lastTelemetry = System.currentTimeMillis();
                    long bytesSinceTelemetry = 0;

                    while (remaining > 0) {
                        int toRead = (int) Math.min(buffer.length, remaining);
                        int r = in.read(buffer, 0, toRead);
                        if (r <= 0) break;

                        outStream.write(buffer, 0, r);
                        remaining -= r;
                        totalBytesReceived += r;
                        bytesSinceTelemetry += r;

                        long now = System.currentTimeMillis();
                        double elapsed = (now - lastTelemetry) / 1000.0;
                        if (elapsed >= 0.3) {
                            double speed = bytesSinceTelemetry / elapsed;
                            long totalExpected = currentSession != null ? currentSession.optLong("totalSizeBytes", contentLength) : contentLength;
                            double percent = totalExpected > 0 ? Math.min(100.0, ((double) totalBytesReceived / totalExpected) * 100.0) : 0;

                            JSONObject prog = new JSONObject();
                            prog.put("filename", fileName);
                            prog.put("totalBytesSentSoFar", totalBytesReceived);
                            prog.put("totalSizeBytes", totalExpected);
                            prog.put("speedBytesPerSec", speed);
                            prog.put("progressPercent", percent);

                            final String progStr = prog.toString();
                            mainHandler.post(() -> callback.onTransferProgress(progStr));

                            lastTelemetry = now;
                            bytesSinceTelemetry = 0;
                        }
                    }
                    fileOut.flush();
                }

                if (physicalFile != null) {
                    MediaScannerConnection.scanFile(context, new String[]{physicalFile.getAbsolutePath()}, null, null);
                }

                sendHttpResponse(out, 200, "OK", "application/json", "{\"success\":true}");
                return;
            }

            // Complete
            if ("POST".equalsIgnoreCase(method) && rawUrl.startsWith("/api/transfer/complete")) {
                double duration = (System.currentTimeMillis() - sessionStartTime) / 1000.0;
                double avgSpeed = duration > 0 ? totalBytesReceived / duration : 0;

                JSONObject summary = new JSONObject();
                summary.put("totalFiles", currentSession != null ? currentSession.optInt("totalFiles", 1) : 1);
                summary.put("totalSizeBytes", totalBytesReceived);
                summary.put("totalDurationSec", duration);
                summary.put("avgSpeedBytesPerSec", avgSpeed);

                final String sumStr = summary.toString();
                mainHandler.post(() -> callback.onTransferComplete(sumStr));

                sendHttpResponse(out, 200, "OK", "application/json", "{\"success\":true}");
                return;
            }

            sendHttpResponse(out, 404, "Not Found", "text/plain", "Not Found");
        } catch (Exception ignored) {}
    }

    private static String readLine(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
        }
        return sb.length() == 0 && c == -1 ? null : sb.toString();
    }

    private static void sendHttpResponse(OutputStream out, int code, String status, String contentType, String body) throws Exception {
        byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + code + " " + status + "\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + bodyBytes.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(bodyBytes);
        out.flush();
    }

    public synchronized void stop() {
        isRunning = false;
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (Exception ignored) {}
            serverSocket = null;
        }
    }
}
