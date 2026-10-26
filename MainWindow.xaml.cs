using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using EzShare.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace EzShare;

public partial class MainWindow : Window
{
    private readonly DiscoveryService _discoveryService;
    private readonly TransferServer _transferServer;
    private readonly TransferClient _transferClient;
    private readonly string _deviceId;
    private readonly string _deviceName;

    public MainWindow()
    {
        InitializeComponent();

        _deviceId = $"win_{Environment.MachineName}_{Guid.NewGuid().ToString("N")[..6]}";
        _deviceName = Environment.MachineName;

        _discoveryService = new DiscoveryService(_deviceId, _deviceName);
        _transferServer = new TransferServer();
        _transferClient = new TransferClient();

        WireUpEvents();

        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
    }

    private void WireUpEvents()
    {
        _discoveryService.DevicesUpdated += (devices) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(devices);
                DispatchJsEvent("devices-updated", json);
            });
        };

        _transferServer.TransferRequested += (req) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(req);
                DispatchJsEvent("transfer-requested", json);
            });
        };

        _transferServer.TransferProgress += (prog) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(prog);
                DispatchJsEvent("transfer-progress", json);
            });
        };

        _transferServer.TransferComplete += (summary) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(summary);
                DispatchJsEvent("transfer-complete", json);
            });
        };

        _transferClient.TransferProgress += (prog) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(prog);
                DispatchJsEvent("transfer-progress", json);
            });
        };

        _transferClient.TransferComplete += (summary) =>
        {
            Dispatcher.Invoke(() =>
            {
                var json = JsonSerializer.Serialize(summary);
                DispatchJsEvent("transfer-complete", json);
            });
        };
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _discoveryService.Start();

        var baseDir = AppDomain.CurrentDomain.BaseDirectory;
        var rendererDir = Path.Combine(baseDir, "src", "renderer");

        if (!Directory.Exists(rendererDir))
        {
            // Fallback for development debugging
            rendererDir = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "src", "renderer"));
        }

        await WebView.EnsureCoreWebView2Async();

        // Map virtual host name to local directory for high-speed offline local loading
        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "ezshare.local",
            rendererDir,
            CoreWebView2HostResourceAccessKind.Allow);

        // Inject JS IPC bridge into renderer
        await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
            const _listeners = {};
            window.__ezshare_dispatch = function(eventName, data) {
                if (_listeners[eventName]) {
                    _listeners[eventName].forEach(fn => fn(typeof data === 'string' ? JSON.parse(data) : data));
                }
            };

            let _reqId = 0;
            const _pending = {};

            window.__ezshare_resolve = function(id, result, error) {
                if (_pending[id]) {
                    if (error) _pending[id].reject(new Error(error));
                    else _pending[id].resolve(result);
                    delete _pending[id];
                }
            };

            function callNative(action, payload) {
                return new Promise((resolve, reject) => {
                    const id = ++_reqId;
                    _pending[id] = { resolve, reject };
                    window.chrome.webview.postMessage({ id, action, payload });
                });
            }

            window.ezshare = {
                selectFiles: () => callNative('selectFiles'),
                selectDirectory: () => callNative('selectDirectory'),
                openFolder: (p) => callNative('openFolder', p),
                getLocalInfo: () => callNative('getLocalInfo'),
                startDiscovery: () => callNative('startDiscovery'),
                stopDiscovery: () => callNative('stopDiscovery'),
                sendFiles: (targetDevice, files) => callNative('sendFiles', { targetDevice, files }),
                cancelSend: () => callNative('cancelSend'),
                startReceiver: (folder) => callNative('startReceiver', folder),
                stopReceiver: () => callNative('stopReceiver'),
                changeDestinationFolder: (folder) => callNative('changeDestinationFolder', folder),

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
        ");

        WebView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
        WebView.CoreWebView2.Navigate("https://ezshare.local/index.html");
    }

    private async void CoreWebView2_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.WebMessageAsJson;
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            int id = root.GetProperty("id").GetInt32();
            string action = root.GetProperty("action").GetString() ?? "";
            JsonElement payload = root.TryGetProperty("payload", out var p) ? p : default;

            object? result = null;
            string? error = null;

            try
            {
                switch (action)
                {
                    case "selectFiles":
                        result = HandleSelectFiles();
                        break;

                    case "selectDirectory":
                        result = HandleSelectDirectory();
                        break;

                    case "openFolder":
                        string? folderPath = payload.GetString();
                        if (!string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath))
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = folderPath,
                                UseShellExecute = true
                            });
                        }
                        result = true;
                        break;

                    case "getLocalInfo":
                        result = new
                        {
                            deviceId = _deviceId,
                            deviceName = _deviceName,
                            ip = DiscoveryService.GetLocalIpAddress(),
                            os = "windows"
                        };
                        break;

                    case "startDiscovery":
                        _discoveryService.StartSearching();
                        result = true;
                        break;

                    case "stopDiscovery":
                        _discoveryService.StopSearching();
                        result = true;
                        break;

                    case "sendFiles":
                        var devElem = payload.GetProperty("targetDevice");
                        var ip = devElem.GetProperty("ip").GetString() ?? "";
                        var port = devElem.GetProperty("port").GetInt32();
                        var filesElem = payload.GetProperty("files");

                        var staged = new List<StagedFile>();
                        foreach (var f in filesElem.EnumerateArray())
                        {
                            staged.Add(new StagedFile
                            {
                                Path = f.GetProperty("path").GetString() ?? "",
                                Name = f.GetProperty("name").GetString() ?? ""
                            });
                        }

                        _discoveryService.StopSearching();
                        result = await _transferClient.SendFilesAsync(ip, port, staged, _deviceName);
                        break;

                    case "cancelSend":
                        _transferClient.Cancel();
                        result = true;
                        break;

                    case "startReceiver":
                        string destFolder = payload.GetString() ?? "";
                        int assignedPort = _transferServer.Start(destFolder);
                        _discoveryService.SetReceiverReady(true, assignedPort);
                        result = new { port = assignedPort, destinationFolder = destFolder };
                        break;

                    case "stopReceiver":
                        _discoveryService.SetReceiverReady(false);
                        _transferServer.Dispose();
                        result = true;
                        break;

                    case "changeDestinationFolder":
                        string newFolder = payload.GetString() ?? "";
                        _transferServer.SetDestinationFolder(newFolder);
                        result = true;
                        break;

                    default:
                        error = $"Unknown action {action}";
                        break;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            var resJson = JsonSerializer.Serialize(result);
            var errJson = JsonSerializer.Serialize(error);
            await WebView.CoreWebView2.ExecuteScriptAsync($"window.__ezshare_resolve({id}, {resJson}, {errJson});");
        }
        catch { }
    }

    private List<object> HandleSelectFiles()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Select Files to Send",
            Multiselect = true
        };

        if (dialog.ShowDialog(this) == true)
        {
            return dialog.FileNames.Select(p => (object)new
            {
                path = p,
                name = Path.GetFileName(p),
                size = new FileInfo(p).Length
            }).ToList();
        }
        return new List<object>();
    }

    private string? HandleSelectDirectory()
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose Folder to Store Received Files",
            Multiselect = false
        };

        if (dialog.ShowDialog(this) == true)
        {
            return dialog.FolderName;
        }
        return null;
    }

    private void DispatchJsEvent(string eventName, string jsonPayload)
    {
        if (WebView.CoreWebView2 != null)
        {
            WebView.CoreWebView2.ExecuteScriptAsync($"window.__ezshare_dispatch('{eventName}', {jsonPayload});");
        }
    }

    private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _discoveryService.Dispose();
        _transferServer.Dispose();
        _transferClient.Dispose();
    }
}
