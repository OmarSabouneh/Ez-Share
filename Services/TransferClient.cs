using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace EzShare.Services;

public class StagedFile
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public long Size { get; set; }
}

public class TransferClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private CancellationTokenSource? _cts;
    private string? _currentTargetIp;
    private int _currentTargetPort;

    public event Action<TransferProgressData>? TransferProgress;
    public event Action<TransferCompleteSummary>? TransferComplete;
    public event Action<string>? TransferCancelled;
    public event Action<string>? TransferFailed;

    public TransferClient()
    {
        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromHours(1) // Support multi-gigabyte files
        };
    }

    public void Cancel()
    {
        _cts?.Cancel();
        if (!string.IsNullOrEmpty(_currentTargetIp) && _currentTargetPort > 0)
        {
            var cancelUrl = $"http://{_currentTargetIp}:{_currentTargetPort}/api/transfer/cancel";
            _ = Task.Run(async () =>
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    using var content = new StringContent("{\"cancelled\":true}", Encoding.UTF8, "application/json");
                    await _httpClient.PostAsync(cancelUrl, content, cts.Token);
                }
                catch { }
            });
        }
    }

    public async Task<TransferCompleteSummary> SendFilesAsync(string targetIp, int targetPort, List<StagedFile> files, string senderName = "Windows Device", string pairCode = "")
    {
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _currentTargetIp = targetIp;
        _currentTargetPort = targetPort;

        try
        {
            long totalSizeBytes = 0;
            var manifestFiles = new List<FileManifestItem>();

            for (int i = 0; i < files.Count; i++)
            {
                var f = files[i];
                var fi = new FileInfo(f.Path);
                f.Size = fi.Length;
                totalSizeBytes += f.Size;

                manifestFiles.Add(new FileManifestItem
                {
                    Id = i.ToString(),
                    Name = f.Name,
                    Size = f.Size
                });
            }

            var handshake = new HandshakeRequest
            {
                SenderName = senderName,
                TotalFiles = files.Count,
                TotalSizeBytes = totalSizeBytes,
                Files = manifestFiles,
                PairCode = pairCode
            };

            // 1. Handshake
            var handshakeUrl = $"http://{targetIp}:{targetPort}/api/transfer/handshake";
            var handshakeJson = JsonSerializer.Serialize(handshake);
            using (var content = new StringContent(handshakeJson, Encoding.UTF8, "application/json"))
            {
                var response = await _httpClient.PostAsync(handshakeUrl, content, token);
                if (response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    throw new InvalidOperationException("Invalid 4-digit pairing code. Please verify the code shown on the receiving device.");
                }
                response.EnsureSuccessStatusCode();
            }

        // 2. Stream Each File
        long totalSentBytes = 0;
        var startTime = DateTime.UtcNow;
        var lastTelemetry = DateTime.UtcNow;
        long bytesSinceTelemetry = 0;

        for (int i = 0; i < files.Count; i++)
        {
            token.ThrowIfCancellationRequested();

            var file = files[i];
            var encodedName = Uri.EscapeDataString(file.Name);
            var fileUrl = $"http://{targetIp}:{targetPort}/api/transfer/file?id={i}&name={encodedName}";

            using (var fs = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, true))
            using (var progressContent = new ProgressStreamContent(fs, 1024 * 1024, (bytesWritten) =>
            {
                totalSentBytes += bytesWritten;
                bytesSinceTelemetry += bytesWritten;

                var now = DateTime.UtcNow;
                var elapsed = (now - lastTelemetry).TotalSeconds;
                if (elapsed >= 0.3)
                {
                    var speed = bytesSinceTelemetry / elapsed;
                    var remaining = Math.Max(0, totalSizeBytes - totalSentBytes);
                    var eta = speed > 0 ? (int)Math.Round(remaining / speed) : 0;
                    var pct = totalSizeBytes > 0 ? Math.Min(100.0, ((double)totalSentBytes / totalSizeBytes) * 100.0) : 100;

                    TransferProgress?.Invoke(new TransferProgressData
                    {
                        FileId = i.ToString(),
                        Filename = file.Name,
                        TotalBytesSentSoFar = totalSentBytes,
                        TotalSizeBytes = totalSizeBytes,
                        SpeedBytesPerSec = speed,
                        ProgressPercent = pct,
                        EtaSeconds = eta,
                        CurrentFileIndex = i + 1,
                        TotalFiles = files.Count
                    });

                    lastTelemetry = now;
                    bytesSinceTelemetry = 0;
                }
            }))
            {
                var fileResp = await _httpClient.PostAsync(fileUrl, progressContent, token);
                fileResp.EnsureSuccessStatusCode();
            }
        }

        // 3. Complete
        var completeUrl = $"http://{targetIp}:{targetPort}/api/transfer/complete";
        using (var compContent = new StringContent("{\"success\":true}", Encoding.UTF8, "application/json"))
        {
            await _httpClient.PostAsync(completeUrl, compContent, token);
        }

            var duration = (DateTime.UtcNow - startTime).TotalSeconds;
            var avgSpeed = duration > 0 ? totalSizeBytes / duration : 0;

            var summary = new TransferCompleteSummary
            {
                TotalFiles = files.Count,
                TotalSizeBytes = totalSizeBytes,
                TotalDurationSec = duration,
                AvgSpeedBytesPerSec = avgSpeed
            };

            TransferComplete?.Invoke(summary);
            return summary;
        }
        catch (OperationCanceledException)
        {
            TransferCancelled?.Invoke("Transfer cancelled by user.");
            throw;
        }
        catch (Exception ex)
        {
            TransferFailed?.Invoke(ex.Message);
            throw;
        }
        finally
        {
            _currentTargetIp = null;
            _currentTargetPort = 0;
        }
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _httpClient.Dispose();
    }
}

public class ProgressStreamContent : HttpContent
{
    private readonly Stream _stream;
    private readonly int _bufferSize;
    private readonly Action<int> _onProgress;

    public ProgressStreamContent(Stream stream, int bufferSize, Action<int> onProgress)
    {
        _stream = stream;
        _bufferSize = bufferSize;
        _onProgress = onProgress;
        Headers.ContentLength = stream.Length;
    }

    protected override async Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context)
    {
        var buffer = new byte[_bufferSize];
        int bytesRead;

        while ((bytesRead = await _stream.ReadAsync(buffer.AsMemory(0, buffer.Length))) > 0)
        {
            await stream.WriteAsync(buffer.AsMemory(0, bytesRead));
            _onProgress(bytesRead);
        }
    }

    protected override bool TryComputeLength(out long length)
    {
        length = _stream.Length;
        return true;
    }
}
