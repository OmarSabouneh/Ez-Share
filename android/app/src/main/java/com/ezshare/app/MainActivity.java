package com.ezshare.app;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private DiscoveryService discoveryService;
    private TransferServer transferServer;
    private TransferClient transferClient;

    private final List<Uri> selectedFileUris = new ArrayList<>();
    private Uri selectedFolderUri;
    private int currentReqId = 0;

    private ActivityResultLauncher<String[]> filePickerLauncher;
    private ActivityResultLauncher<Uri> folderPickerLauncher;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());

        // Setup Pickers
        filePickerLauncher = registerForActivityResult(
                new ActivityResultContracts.OpenMultipleDocuments(),
                uris -> {
                    selectedFileUris.clear();
                    JSONArray array = new JSONArray();
                    if (uris != null) {
                        for (Uri uri : uris) {
                            try {
                                getContentResolver().takePersistableUriPermission(
                                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (Exception ignored) {}

                            selectedFileUris.add(uri);
                            JSONObject obj = new JSONObject();
                            try {
                                obj.put("path", uri.toString());
                                obj.put("name", getDisplayName(uri));
                                obj.put("size", getFileSize(uri));
                                array.put(obj);
                            } catch (Exception ignored) {}
                        }
                    }
                    resolvePendingJs(currentReqId, array.toString());
                }
        );

        folderPickerLauncher = registerForActivityResult(
                new ActivityResultContracts.OpenDocumentTree(),
                uri -> {
                    if (uri != null) {
                        try {
                            getContentResolver().takePersistableUriPermission(
                                    uri,
                                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            );
                        } catch (Exception ignored) {}
                        selectedFolderUri = uri;
                        resolvePendingJs(currentReqId, "\"" + uri.toString() + "\"");
                    } else {
                        resolvePendingJs(currentReqId, "null");
                    }
                }
        );

        // Services
        discoveryService = new DiscoveryService(this, devicesJson ->
                dispatchJsEvent("devices-updated", devicesJson)
        );

        transferServer = new TransferServer(this, new TransferServer.ServerCallback() {
            @Override
            public void onTransferRequested(String json) {
                dispatchJsEvent("transfer-requested", json);
            }

            @Override
            public void onTransferProgress(String json) {
                dispatchJsEvent("transfer-progress", json);
            }

            @Override
            public void onTransferComplete(String json) {
                dispatchJsEvent("transfer-complete", json);
            }

            @Override
            public void onError(String message) {
                dispatchJsEvent("error", "\"" + message + "\"");
            }
        });

        transferClient = new TransferClient(this, new TransferClient.ClientCallback() {
            @Override
            public void onTransferProgress(String json) {
                dispatchJsEvent("transfer-progress", json);
            }

            @Override
            public void onTransferComplete(String json) {
                dispatchJsEvent("transfer-complete", json);
            }

            @Override
            public void onError(String message) {
                dispatchJsEvent("error", "\"" + message + "\"");
            }
        });

        discoveryService.start();

        // Inject JS interface
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidHost");

        // Load UI from assets
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void dispatchJsEvent(String eventName, String jsonPayload) {
        runOnUiThread(() -> {
            String script = "if (window.__ezshare_dispatch) window.__ezshare_dispatch('" + eventName + "', " + jsonPayload + ");";
            webView.evaluateJavascript(script, null);
        });
    }

    private void resolvePendingJs(int reqId, String jsonResult) {
        runOnUiThread(() -> {
            String script = "if (window.__ezshare_resolve) window.__ezshare_resolve(" + reqId + ", " + jsonResult + ", null);";
            webView.evaluateJavascript(script, null);
        });
    }

    private String getDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx != -1) return cursor.getString(idx);
            }
        } catch (Exception ignored) {}
        return "file_" + System.currentTimeMillis();
    }

    private long getFileSize(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (idx != -1) return cursor.getLong(idx);
            }
        } catch (Exception ignored) {}
        return 0;
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void callNative(int id, String action, String payload) {
            currentReqId = id;
            runOnUiThread(() -> {
                try {
                    switch (action) {
                        case "selectFiles":
                            filePickerLauncher.launch(new String[]{"*/*"});
                            break;

                        case "selectDirectory":
                            folderPickerLauncher.launch(null);
                            break;

                        case "openFolder":
                            if (selectedFolderUri != null) {
                                Intent intent = new Intent(Intent.ACTION_VIEW);
                                intent.setDataAndType(selectedFolderUri, "*/*");
                                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                try {
                                    startActivity(intent);
                                } catch (Exception e) {
                                    Toast.makeText(MainActivity.this, "Folder saved: " + selectedFolderUri.getPath(), Toast.LENGTH_SHORT).show();
                                }
                            }
                            resolvePendingJs(id, "true");
                            break;

                        case "getLocalInfo":
                            JSONObject info = new JSONObject();
                            info.put("deviceId", discoveryService.getDeviceId());
                            info.put("deviceName", discoveryService.getDeviceName());
                            info.put("ip", DiscoveryService.getLocalIpAddress());
                            info.put("os", "android");
                            resolvePendingJs(id, info.toString());
                            break;

                        case "startDiscovery":
                            discoveryService.startSearching();
                            resolvePendingJs(id, "true");
                            break;

                        case "stopDiscovery":
                            discoveryService.stopSearching();
                            resolvePendingJs(id, "true");
                            break;

                        case "sendFiles":
                            JSONObject p = new JSONObject(payload);
                            JSONObject dev = p.getJSONObject("targetDevice");
                            String ip = dev.getString("ip");
                            int port = dev.getInt("port");
                            discoveryService.stopSearching();
                            transferClient.sendFiles(ip, port, selectedFileUris, discoveryService.getDeviceName());
                            resolvePendingJs(id, "true");
                            break;

                        case "cancelSend":
                            transferClient.cancel();
                            resolvePendingJs(id, "true");
                            break;

                        case "startReceiver":
                            if (selectedFolderUri != null) {
                                int assignedPort = transferServer.start(selectedFolderUri, 53318);
                                discoveryService.setReceiverReady(true, assignedPort);
                                JSONObject res = new JSONObject();
                                res.put("port", assignedPort);
                                res.put("destinationFolder", selectedFolderUri.toString());
                                resolvePendingJs(id, res.toString());
                            } else {
                                resolvePendingJs(id, "null");
                            }
                            break;

                        case "stopReceiver":
                            discoveryService.setReceiverReady(false, 53318);
                            transferServer.stop();
                            resolvePendingJs(id, "true");
                            break;

                        case "changeDestinationFolder":
                            folderPickerLauncher.launch(null);
                            break;

                        default:
                            resolvePendingJs(id, "null");
                            break;
                    }
                } catch (Exception ex) {
                    resolvePendingJs(id, "null");
                }
            });
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (discoveryService != null) discoveryService.stop();
        if (transferServer != null) transferServer.stop();
        if (transferClient != null) transferClient.cancel();
    }
}
