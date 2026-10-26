using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace EzShare.Services;

public class DeviceInfo
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("os")]
    public string Os { get; set; } = "windows";

    [JsonPropertyName("ip")]
    public string Ip { get; set; } = "";

    [JsonPropertyName("port")]
    public int Port { get; set; } = 53318;

    [JsonIgnore]
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;
}

public class DiscoveryService : IDisposable
{
    public const int DiscoveryPort = 53317;
    public const string ProtocolTag = "EZSHARE_V1";

    public string DeviceId { get; }
    public string DeviceName { get; }

    private UdpClient? _udpClient;
    private CancellationTokenSource? _cts;
    private readonly ConcurrentDictionary<string, DeviceInfo> _discoveredDevices = new();
    private int _receiverPort = 53318;

    public bool IsReceiving { get; private set; }
    public bool IsSearching { get; private set; }

    public event Action<List<DeviceInfo>>? DevicesUpdated;

    public DiscoveryService(string? deviceId = null, string? deviceName = null)
    {
        DeviceId = deviceId ?? $"win_{Environment.MachineName}_{Guid.NewGuid().ToString("N")[..6]}";
        DeviceName = deviceName ?? Environment.MachineName;
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();

        try
        {
            _udpClient = new UdpClient();
            _udpClient.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _udpClient.Client.Bind(new IPEndPoint(IPAddress.Any, DiscoveryPort));
            _udpClient.EnableBroadcast = true;

            Task.Run(() => ListenLoopAsync(_cts.Token));
            Task.Run(() => CleanupLoopAsync(_cts.Token));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"UDP Start error: {ex.Message}");
        }
    }

    public void SetReceiverReady(bool isReady, int httpPort = 53318)
    {
        IsReceiving = isReady;
        _receiverPort = httpPort;
    }

    public void StartSearching()
    {
        IsSearching = true;
        _discoveredDevices.Clear();
        DevicesUpdated?.Invoke(new List<DeviceInfo>());

        Task.Run(async () =>
        {
            while (IsSearching && _cts != null && !_cts.Token.IsCancellationRequested)
            {
                SendProbe();
                await Task.Delay(1500, _cts.Token);
            }
        });
    }

    public void StopSearching()
    {
        IsSearching = false;
    }

    private void SendProbe()
    {
        if (_udpClient == null) return;

        var probe = new
        {
            protocol = ProtocolTag,
            action = "DISCOVER_RECEIVERS",
            sender = new
            {
                id = DeviceId,
                name = DeviceName,
                os = "windows"
            }
        };

        var json = JsonSerializer.Serialize(probe);
        var bytes = Encoding.UTF8.GetBytes(json);

        var broadcastEndpoints = GetBroadcastEndPoints();
        foreach (var ep in broadcastEndpoints)
        {
            try
            {
                _udpClient.Send(bytes, bytes.Length, ep);
            }
            catch { }
        }
    }

    private async Task ListenLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested && _udpClient != null)
        {
            try
            {
                var result = await _udpClient.ReceiveAsync(token);
                var json = Encoding.UTF8.GetString(result.Buffer);

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (!root.TryGetProperty("protocol", out var proto) || proto.GetString() != ProtocolTag)
                    continue;

                if (!root.TryGetProperty("action", out var actionElem))
                    continue;

                var action = actionElem.GetString();

                // 1. If we are in "Receive" mode and someone is looking for receivers
                if (action == "DISCOVER_RECEIVERS" && IsReceiving)
                {
                    if (root.TryGetProperty("sender", out var senderElem) &&
                        senderElem.TryGetProperty("id", out var sid) && sid.GetString() == DeviceId)
                    {
                        continue; // skip self
                    }

                    var reply = new
                    {
                        protocol = ProtocolTag,
                        action = "RECEIVER_READY",
                        device = new
                        {
                            id = DeviceId,
                            name = DeviceName,
                            os = "windows",
                            ip = GetLocalIpAddress(),
                            port = _receiverPort
                        }
                    };

                    var replyBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(reply));
                    await _udpClient.SendAsync(replyBytes, replyBytes.Length, result.RemoteEndPoint);
                }
                // 2. If we are searching and got a RECEIVER_READY response
                else if (action == "RECEIVER_READY" && IsSearching)
                {
                    if (root.TryGetProperty("device", out var devElem))
                    {
                        var dev = JsonSerializer.Deserialize<DeviceInfo>(devElem.GetRawText());
                        if (dev != null && dev.Id != DeviceId)
                        {
                            if (string.IsNullOrEmpty(dev.Ip) || dev.Ip == "127.0.0.1")
                            {
                                dev.Ip = result.RemoteEndPoint.Address.ToString();
                            }
                            dev.LastSeen = DateTime.UtcNow;

                            _discoveredDevices[dev.Id] = dev;
                            DevicesUpdated?.Invoke(_discoveredDevices.Values.ToList());
                        }
                    }
                }
            }
            catch (OperationCanceledException) { break; }
            catch { }
        }
    }

    private async Task CleanupLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(2000, token);
                var now = DateTime.UtcNow;
                var changed = false;

                foreach (var kvp in _discoveredDevices.ToList())
                {
                    if ((now - kvp.Value.LastSeen).TotalSeconds > 4.5)
                    {
                        if (_discoveredDevices.TryRemove(kvp.Key, out _))
                        {
                            changed = true;
                        }
                    }
                }

                if (changed)
                {
                    DevicesUpdated?.Invoke(_discoveredDevices.Values.ToList());
                }
            }
            catch (OperationCanceledException) { break; }
            catch { }
        }
    }

    public static string GetLocalIpAddress()
    {
        try
        {
            var interfaces = NetworkInterface.GetAllNetworkInterfaces()
                .Where(ni => ni.OperationalStatus == OperationalStatus.Up &&
                             ni.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                             ni.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                .Where(ni => {
                    var desc = (ni.Description + " " + ni.Name).ToLowerInvariant();
                    return !desc.Contains("virtual") &&
                           !desc.Contains("vethernet") &&
                           !desc.Contains("wsl") &&
                           !desc.Contains("vmware") &&
                           !desc.Contains("virtualbox") &&
                           !desc.Contains("hyper-v") &&
                           !desc.Contains("docker");
                })
                .ToList();

            // First check interfaces with an active gateway
            foreach (var ni in interfaces.Where(ni => ni.GetIPProperties().GatewayAddresses.Any(g => !g.Address.Equals(IPAddress.Any))))
            {
                foreach (var ip in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ip.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip.Address))
                    {
                        return ip.Address.ToString();
                    }
                }
            }

            // Fallback to any physical interface
            foreach (var ni in interfaces)
            {
                foreach (var ip in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ip.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip.Address))
                    {
                        return ip.Address.ToString();
                    }
                }
            }
        }
        catch { }
        return "127.0.0.1";
    }

    private static List<IPEndPoint> GetBroadcastEndPoints()
    {
        var endpoints = new List<IPEndPoint> { new(IPAddress.Broadcast, DiscoveryPort) };

        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                    continue;

                foreach (var u in ni.GetIPProperties().UnicastAddresses)
                {
                    if (u.Address.AddressFamily == AddressFamily.InterNetwork && u.IPv4Mask != null)
                    {
                        var ipBytes = u.Address.GetAddressBytes();
                        var maskBytes = u.IPv4Mask.GetAddressBytes();
                        var broadcastBytes = new byte[ipBytes.Length];
                        for (int i = 0; i < ipBytes.Length; i++)
                        {
                            broadcastBytes[i] = (byte)(ipBytes[i] | ~maskBytes[i]);
                        }
                        endpoints.Add(new IPEndPoint(new IPAddress(broadcastBytes), DiscoveryPort));
                    }
                }
            }
        }
        catch { }

        return endpoints;
    }

    public void Dispose()
    {
        _cts?.Cancel();
        IsSearching = false;
        IsReceiving = false;
        _udpClient?.Dispose();
        _discoveredDevices.Clear();
    }
}
