package com.ezshare.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class TransferClient {

    public interface ClientCallback {
        void onTransferProgress(String json);
        void onTransferComplete(String json);
        void onError(String message);
    }

    public static class FileItem {
        public Uri uri;
        public String name;
        public long size;
    }

    private final Context context;
    private final ClientCallback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean isCancelled = false;

    public TransferClient(Context context, ClientCallback callback) {
        this.context = context;
        this.callback = callback;
    }

    public void cancel() {
        this.isCancelled = true;
    }

    public void sendFiles(String targetIp, int targetPort, List<Uri> uris, String senderName) {
        isCancelled = false;
        new Thread(() -> {
            try {
                List<FileItem> files = new ArrayList<>();
                long totalSizeBytes = 0;

                for (Uri uri : uris) {
                    FileItem item = getFileInfo(uri);
                    files.add(item);
                    totalSizeBytes += item.size;
                }

                // 1. Handshake
                JSONObject handshake = new JSONObject();
                handshake.put("senderName", senderName);
                handshake.put("totalFiles", files.size());
                handshake.put("totalSizeBytes", totalSizeBytes);

                JSONArray fileArray = new JSONArray();
                for (int i = 0; i < files.size(); i++) {
                    JSONObject fObj = new JSONObject();
                    fObj.put("id", String.valueOf(i));
                    fObj.put("name", files.get(i).name);
                    fObj.put("size", files.get(i).size);
                    fileArray.put(fObj);
                }
                handshake.put("files", fileArray);

                postJson("http://" + targetIp + ":" + targetPort + "/api/transfer/handshake", handshake.toString());

                // 2. Stream Files
                long totalSentSoFar = 0;
                long startTime = System.currentTimeMillis();
                long lastTelemetry = System.currentTimeMillis();
                long bytesSinceTelemetry = 0;

                for (int i = 0; i < files.size(); i++) {
                    if (isCancelled) throw new Exception("Transfer cancelled by user");

                    FileItem file = files.get(i);
                    String encName = URLEncoder.encode(file.name, "UTF-8");
                    String fileUrl = "http://" + targetIp + ":" + targetPort + "/api/transfer/file?id=" + i + "&name=" + encName;

                    HttpURLConnection conn = (HttpURLConnection) new URL(fileUrl).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(file.size);
                    conn.setRequestProperty("Content-Type", "application/octet-stream");
                    conn.setRequestProperty("Expect", "");
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(60000);

                    try (InputStream in = context.getContentResolver().openInputStream(file.uri);
                         OutputStream out = conn.getOutputStream()) {

                        if (in == null) throw new Exception("Cannot read file: " + file.name);

                        byte[] buffer = new byte[1024 * 1024];
                        int bytesRead;

                        while ((bytesRead = in.read(buffer)) != -1) {
                            if (isCancelled) {
                                conn.disconnect();
                                throw new Exception("Transfer cancelled");
                            }

                            out.write(buffer, 0, bytesRead);
                            totalSentSoFar += bytesRead;
                            bytesSinceTelemetry += bytesRead;

                            long now = System.currentTimeMillis();
                            double elapsed = (now - lastTelemetry) / 1000.0;
                            if (elapsed >= 0.3) {
                                double speed = bytesSinceTelemetry / elapsed;
                                long remaining = Math.max(0, totalSizeBytes - totalSentSoFar);
                                int eta = speed > 0 ? (int) Math.round(remaining / speed) : 0;
                                double pct = totalSizeBytes > 0 ? Math.min(100.0, ((double) totalSentSoFar / totalSizeBytes) * 100.0) : 100;

                                JSONObject prog = new JSONObject();
                                prog.put("filename", file.name);
                                prog.put("totalBytesSentSoFar", totalSentSoFar);
                                prog.put("totalSizeBytes", totalSizeBytes);
                                prog.put("speedBytesPerSec", speed);
                                prog.put("progressPercent", pct);
                                prog.put("etaSeconds", eta);
                                prog.put("currentFileIndex", i + 1);
                                prog.put("totalFiles", files.size());

                                final String progStr = prog.toString();
                                mainHandler.post(() -> callback.onTransferProgress(progStr));

                                lastTelemetry = now;
                                bytesSinceTelemetry = 0;
                            }
                        }
                        out.flush();
                    }

                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) {
                        throw new Exception("Receiver error: " + code);
                    }
                }

                // 3. Complete
                postJson("http://" + targetIp + ":" + targetPort + "/api/transfer/complete", "{\"success\":true}");

                double duration = (System.currentTimeMillis() - startTime) / 1000.0;
                double avgSpeed = duration > 0 ? totalSizeBytes / duration : 0;

                JSONObject summary = new JSONObject();
                summary.put("totalFiles", files.size());
                summary.put("totalSizeBytes", totalSizeBytes);
                summary.put("totalDurationSec", duration);
                summary.put("avgSpeedBytesPerSec", avgSpeed);

                final String sumStr = summary.toString();
                mainHandler.post(() -> callback.onTransferComplete(sumStr));

            } catch (Exception ex) {
                mainHandler.post(() -> callback.onError(ex.getMessage()));
            }
        }).start();
    }

    private FileItem getFileInfo(Uri uri) {
        FileItem item = new FileItem();
        item.uri = uri;
        item.name = "file_" + System.currentTimeMillis();
        item.size = 0;

        try (Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);

                if (nameIndex != -1) item.name = cursor.getString(nameIndex);
                if (sizeIndex != -1) item.size = cursor.getLong(sizeIndex);
            }
        } catch (Exception ignored) {}
        return item;
    }

    private void postJson(String urlStr, String json) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("Expect", "");
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);

        try (OutputStream out = conn.getOutputStream()) {
            out.write(bytes);
            out.flush();
        }

        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new Exception("HTTP request failed with status: " + code);
        }
    }
}
