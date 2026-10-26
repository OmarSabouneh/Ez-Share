using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace EzShare.Services;

public class FileManifestItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("size")]
    public long Size { get; set; }
}

public class HandshakeRequest
{
    [JsonPropertyName("senderName")]
    public string SenderName { get; set; } = "Remote Device";

    [JsonPropertyName("totalFiles")]
    public int TotalFiles { get; set; }

    [JsonPropertyName("totalSizeBytes")]
    public long TotalSizeBytes { get; set; }

    [JsonPropertyName("files")]
    public List<FileManifestItem> Files { get; set; } = new();

    [JsonPropertyName("pairCode")]
    public string? PairCode { get; set; }
}

public class TransferProgressData
{
    [JsonPropertyName("fileId")]
    public string FileId { get; set; } = "";

    [JsonPropertyName("filename")]
    public string Filename { get; set; } = "";

    [JsonPropertyName("totalBytesSentSoFar")]
    public long TotalBytesSentSoFar { get; set; }

    [JsonPropertyName("totalSizeBytes")]
    public long TotalSizeBytes { get; set; }

    [JsonPropertyName("speedBytesPerSec")]
    public double SpeedBytesPerSec { get; set; }

    [JsonPropertyName("progressPercent")]
    public double ProgressPercent { get; set; }

    [JsonPropertyName("etaSeconds")]
    public int EtaSeconds { get; set; }

    [JsonPropertyName("currentFileIndex")]
    public int CurrentFileIndex { get; set; }

    [JsonPropertyName("totalFiles")]
    public int TotalFiles { get; set; }
}

public class TransferCompleteSummary
{
    [JsonPropertyName("totalFiles")]
    public int TotalFiles { get; set; }

    [JsonPropertyName("totalSizeBytes")]
    public long TotalSizeBytes { get; set; }

    [JsonPropertyName("totalDurationSec")]
    public double TotalDurationSec { get; set; }

    [JsonPropertyName("avgSpeedBytesPerSec")]
    public double AvgSpeedBytesPerSec { get; set; }
}

public class TransferServer : IDisposable
{
    public const int DefaultPort = 53318;

    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private CancellationTokenSource? _activeTransferCts;
    private string? _destinationFolder;
    private HandshakeRequest? _currentSession;
    private long _totalReceivedBytes;
    private DateTime _sessionStartTime;

    public int Port { get; private set; } = DefaultPort;
    public string PairCode { get; private set; } = "";

    public event Action<HandshakeRequest>? TransferRequested;
    public event Action<TransferProgressData>? TransferProgress;
    public event Action<TransferCompleteSummary>? TransferComplete;
    public event Action<string>? TransferCancelled;

    public int Start(string destinationFolder, int preferredPort = DefaultPort)
    {
        _destinationFolder = destinationFolder;
        _cts = new CancellationTokenSource();
        PairCode = new Random().Next(1000, 10000).ToString();

        int port = preferredPort;
        while (port < preferredPort + 10)
        {
            try
            {
                _listener = new TcpListener(IPAddress.Any, port);
                _listener.Start();
                Port = port;
                break;
            }
            catch (SocketException)
            {
                port++;
            }
        }

        Task.Run(() => AcceptLoopAsync(_cts.Token));
        return Port;
    }

    public void SetDestinationFolder(string newFolder)
    {
        _destinationFolder = newFolder;
    }

    public void CancelActiveTransfer()
    {
        _activeTransferCts?.Cancel();
        _activeTransferCts = new CancellationTokenSource();
        _currentSession = null;
        TransferCancelled?.Invoke("Transfer cancelled by user.");
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested && _listener != null)
        {
            try
            {
                var client = await _listener.AcceptTcpClientAsync(token);
                _ = Task.Run(() => HandleClientAsync(client, token));
            }
            catch (OperationCanceledException) { break; }
            catch { }
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken token)
    {
        using (client)
        using (var stream = client.GetStream())
        using (var reader = new BufferedStream(stream))
        {
            try
            {
                // Read HTTP request line & headers
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var requestLine = ReadLine(reader);
                if (string.IsNullOrWhiteSpace(requestLine)) return;

                var parts = requestLine.Split(' ');
                if (parts.Length < 2) return;

                var method = parts[0];
                var rawUrl = parts[1];

                string? line;
                while (!string.IsNullOrEmpty(line = ReadLine(reader)))
                {
                    var colon = line.IndexOf(':');
                    if (colon > 0)
                    {
                        var key = line[..colon].Trim();
                        var val = line[(colon + 1)..].Trim();
                        headers[key] = val;
                    }
                }

                headers.TryGetValue("Content-Length", out var clStr);
                long.TryParse(clStr, out var contentLength);

                // Acknowledge Expect: 100-continue immediately to prevent client (Android) stalls
                if (headers.TryGetValue("Expect", out var expectVal) && expectVal.Contains("100-continue", StringComparison.OrdinalIgnoreCase))
                {
                    var continueBytes = Encoding.UTF8.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                    await stream.WriteAsync(continueBytes, token);
                    await stream.FlushAsync(token);
                }

                // Handle Cancel notification from remote sender
                if (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && rawUrl.StartsWith("/api/transfer/cancel"))
                {
                    _currentSession = null;
                    _activeTransferCts?.Cancel();
                    _activeTransferCts = new CancellationTokenSource();
                    TransferCancelled?.Invoke("Transfer cancelled by peer.");
                    await SendResponseAsync(stream, 200, "OK", "application/json", "{\"cancelled\":true}");
                    return;
                }

                // Handle Handshake
                if (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && rawUrl.StartsWith("/api/transfer/handshake"))
                {
                    var bodyBytes = new byte[contentLength];
                    int read = 0;
                    while (read < contentLength)
                    {
                        int r = await reader.ReadAsync(bodyBytes.AsMemory(read, (int)contentLength - read), token);
                        if (r <= 0) break;
                        read += r;
                    }

                    var bodyJson = Encoding.UTF8.GetString(bodyBytes);
                    _currentSession = JsonSerializer.Deserialize<HandshakeRequest>(bodyJson) ?? new();

                    // Verify 4-digit pairing code
                    if (!string.IsNullOrEmpty(PairCode) && !string.Equals(_currentSession.PairCode?.Trim(), PairCode, StringComparison.OrdinalIgnoreCase))
                    {
                        _currentSession = null;
                        await SendResponseAsync(stream, 403, "Forbidden", "application/json", "{\"accepted\":false,\"error\":\"Invalid 4-digit pairing code.\"}");
                        return;
                    }

                    _totalReceivedBytes = 0;
                    _sessionStartTime = DateTime.UtcNow;

                    TransferRequested?.Invoke(_currentSession);

                    var respJson = JsonSerializer.Serialize(new { accepted = true, status = "ready" });
                    await SendResponseAsync(stream, 200, "OK", "application/json", respJson);
                    return;
                }

                // Handle File Streaming
                if (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && rawUrl.StartsWith("/api/transfer/file"))
                {
                    var query = rawUrl.Contains('?') ? rawUrl[(rawUrl.IndexOf('?') + 1)..] : "";
                    var qParams = ParseQuery(query);
                    qParams.TryGetValue("name", out var encodedName);
                    var fileName = !string.IsNullOrEmpty(encodedName) ? Uri.UnescapeDataString(encodedName) : "received_file";

                    var safePath = GetUniqueFilePath(_destinationFolder ?? AppDomain.CurrentDomain.BaseDirectory, fileName);
                    bool fileCompleted = false;

                    _activeTransferCts?.Dispose();
                    _activeTransferCts = new CancellationTokenSource();
                    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(token, _activeTransferCts.Token);
                    var streamToken = linkedCts.Token;

                    // Stream directly to disk with 1MB buffer
                    try
                    {
                        using (var fs = new FileStream(safePath, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024, true))
                        {
                            var buffer = new byte[1024 * 1024];
                            long remaining = contentLength;
                            var lastTelemetry = DateTime.UtcNow;
                            long bytesSinceTelemetry = 0;
                            int fileIdx = 1;

                            while (remaining > 0)
                            {
                                int toRead = (int)Math.Min(buffer.Length, remaining);
                                int bytesRead = await reader.ReadAsync(buffer.AsMemory(0, toRead), streamToken);
                                if (bytesRead <= 0) break;

                                await fs.WriteAsync(buffer.AsMemory(0, bytesRead), streamToken);
                                remaining -= bytesRead;
                                _totalReceivedBytes += bytesRead;
                                bytesSinceTelemetry += bytesRead;

                                var now = DateTime.UtcNow;
                                var elapsed = (now - lastTelemetry).TotalSeconds;
                                if (elapsed >= 0.3)
                                {
                                    var speed = bytesSinceTelemetry / elapsed;
                                    var totalExpected = _currentSession?.TotalSizeBytes ?? contentLength;
                                    var percent = totalExpected > 0 ? Math.Min(100.0, ((double)_totalReceivedBytes / totalExpected) * 100.0) : 0;

                                    TransferProgress?.Invoke(new TransferProgressData
                                    {
                                        Filename = fileName,
                                        TotalBytesSentSoFar = _totalReceivedBytes,
                                        TotalSizeBytes = totalExpected,
                                        SpeedBytesPerSec = speed,
                                        ProgressPercent = percent,
                                        CurrentFileIndex = fileIdx,
                                        TotalFiles = _currentSession?.TotalFiles ?? 1
                                    });

                                    lastTelemetry = now;
                                    bytesSinceTelemetry = 0;
                                }
                            }

                            fileCompleted = (remaining == 0);
                        }
                    }
                    catch
                    {
                        fileCompleted = false;
                    }
                    finally
                    {
                        if (!fileCompleted)
                        {
                            try
                            {
                                if (File.Exists(safePath))
                                {
                                    File.Delete(safePath);
                                }
                            }
                            catch { }

                            _currentSession = null;
                            TransferCancelled?.Invoke("Transfer interrupted or cancelled. Incomplete file deleted.");
                        }
                    }

                    if (!fileCompleted)
                    {
                        await SendResponseAsync(stream, 500, "Error", "application/json", "{\"error\":\"File transfer interrupted\"}");
                        return;
                    }

                    await SendResponseAsync(stream, 200, "OK", "application/json", "{\"success\":true}");
                    return;
                }

                // Handle Complete
                if (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && rawUrl.StartsWith("/api/transfer/complete"))
                {
                    var totalDuration = (DateTime.UtcNow - _sessionStartTime).TotalSeconds;
                    var avgSpeed = totalDuration > 0 ? _totalReceivedBytes / totalDuration : 0;

                    var summary = new TransferCompleteSummary
                    {
                        TotalFiles = _currentSession?.TotalFiles ?? 1,
                        TotalSizeBytes = _totalReceivedBytes,
                        TotalDurationSec = totalDuration,
                        AvgSpeedBytesPerSec = avgSpeed
                    };

                    TransferComplete?.Invoke(summary);
                    await SendResponseAsync(stream, 200, "OK", "application/json", "{\"success\":true}");
                    return;
                }

                await SendResponseAsync(stream, 404, "Not Found", "text/plain", "Not Found");
            }
            catch { }
        }
    }

    private static string ReadLine(Stream stream)
    {
        var sb = new StringBuilder();
        int b;
        while ((b = stream.ReadByte()) != -1)
        {
            if (b == '\n') break;
            if (b != '\r') sb.Append((char)b);
        }
        return sb.ToString();
    }

    private static async Task SendResponseAsync(Stream stream, int code, string status, string contentType, string body)
    {
        var bodyBytes = Encoding.UTF8.GetBytes(body);
        var header = $"HTTP/1.1 {code} {status}\r\n" +
                     $"Content-Type: {contentType}\r\n" +
                     $"Content-Length: {bodyBytes.Length}\r\n" +
                     "Access-Control-Allow-Origin: *\r\n" +
                     "Connection: close\r\n\r\n";
        var headerBytes = Encoding.UTF8.GetBytes(header);
        await stream.WriteAsync(headerBytes);
        await stream.WriteAsync(bodyBytes);
        await stream.FlushAsync();
    }

    private static Dictionary<string, string> ParseQuery(string q)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(q)) return dict;
        foreach (var pair in q.Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq > 0)
            {
                dict[pair[..eq]] = pair[(eq + 1)..];
            }
        }
        return dict;
    }

    public static string GetUniqueFilePath(string dir, string originalName)
    {
        var safe = SanitizeFilename(originalName);
        var target = Path.Combine(dir, safe);
        if (!File.Exists(target)) return target;

        var ext = Path.GetExtension(safe);
        var baseName = Path.GetFileNameWithoutExtension(safe);
        int counter = 1;
        while (File.Exists(target))
        {
            target = Path.Combine(dir, $"{baseName} ({counter}){ext}");
            counter++;
        }
        return target;
    }

    public static string SanitizeFilename(string name)
    {
        var clean = Path.GetFileName(name);
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            clean = clean.Replace(c, '_');
        }
        return string.IsNullOrWhiteSpace(clean) ? "unnamed_file" : clean.Trim();
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _listener?.Stop();
        _currentSession = null;
    }
}
