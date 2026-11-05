using System.IO;
using System.Text;
using System.Text.Json;

namespace Provian.ForegroundHelper;

/// <summary>
/// Serializes line-delimited JSON events to stdout for the TS HelperBridge.
///
/// All events share the shape:
///   { "t": &lt;event-type&gt;, "ts": &lt;unix-millis&gt;, ... }
///
/// Writes are serialized behind a lock so concurrent callers (the foreground
/// hook callback, the input hook callback, the SystemEvents thread) cannot
/// interleave bytes within a single JSON line. This mirrors
/// native/darwin/foreground-helper IpcEmitter.swift.
/// </summary>
internal static class Ipc
{
    private static readonly object WriteLock = new();
    private static readonly Stream StdOut = Console.OpenStandardOutput();
    private static readonly byte[] Newline = "\n"u8.ToArray();

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        // Keys are written in a fixed, deterministic order by using ordered
        // dictionaries below; no need for sorting. Default escaping is safe
        // for stdout (ASCII-escaped non-ASCII).
        WriteIndented = false,
    };

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static void EmitPermissionStatus(bool accessibility, bool inputMonitoring)
    {
        Emit(new Dictionary<string, object?>
        {
            ["t"] = "permission_status",
            ["ts"] = NowMs(),
            ["accessibility"] = accessibility,
            ["input_monitoring"] = inputMonitoring,
        });
    }

    /// <summary>
    /// Emit foreground_changed. bundle_id is always null on Windows (no bundle
    /// identifier concept); process_name carries the executable basename
    /// (e.g. "Claude") and browser_url is the focused browser tab URL or null.
    /// </summary>
    public static void EmitForegroundChanged(string? processName, string? browserUrl)
    {
        Emit(new Dictionary<string, object?>
        {
            ["t"] = "foreground_changed",
            ["ts"] = NowMs(),
            ["app"] = new Dictionary<string, object?>
            {
                ["bundle_id"] = null,
                ["process_name"] = processName,
            },
            ["browser_url"] = browserUrl,
        });
    }

    /// <summary>
    /// Emit a single input_event. Carries only a timestamp; no keycode, no
    /// modifier, no content, no coordinates. Mirrors the macOS contract.
    /// </summary>
    public static void EmitInputEvent()
    {
        Emit(new Dictionary<string, object?>
        {
            ["t"] = "input_event",
            ["ts"] = NowMs(),
        });
    }

    /// <summary>
    /// Emit a system_state event. state must be one of sleep|wake|lock|unlock
    /// (validated at the TS IPC boundary).
    /// </summary>
    public static void EmitSystemState(string state)
    {
        Emit(new Dictionary<string, object?>
        {
            ["t"] = "system_state",
            ["ts"] = NowMs(),
            ["state"] = state,
        });
    }

    public static void EmitError(string message) => EmitDiagnostic("error", message);

    public static void EmitFatal(string message) => EmitDiagnostic("fatal", message);

    private static void EmitDiagnostic(string type, string message)
    {
        Emit(new Dictionary<string, object?>
        {
            ["t"] = type,
            ["ts"] = NowMs(),
            ["message"] = message,
        });
    }

    private static void Emit(Dictionary<string, object?> ev)
    {
        byte[] data;
        try
        {
            data = JsonSerializer.SerializeToUtf8Bytes(ev, JsonOpts);
        }
        catch
        {
            // Never throw out of the IPC path; drop the malformed event.
            return;
        }

        lock (WriteLock)
        {
            try
            {
                StdOut.Write(data, 0, data.Length);
                StdOut.Write(Newline, 0, Newline.Length);
                StdOut.Flush();
            }
            catch
            {
                // stdout closed (parent gone). Nothing to do; the process will
                // be reaped by the bridge's restart/kill logic.
            }
        }
    }
}
