using System.Diagnostics;

namespace Provian.ForegroundHelper;

/// <summary>
/// Watches foreground-window changes via SetWinEventHook(EVENT_SYSTEM_FOREGROUND)
/// and emits foreground_changed IPC events. Windows counterpart of the macOS
/// NSWorkspace.didActivateApplication observer.
///
/// For each activation it resolves the owning process name (executable
/// basename, no .exe) and, when the process is a browser, reads the focused
/// tab URL via UI Automation. bundle_id is always null on Windows.
///
/// Requires a running message loop on the thread that installed the hook
/// (WINEVENT_OUTOFCONTEXT delivers callbacks via the message queue). Program
/// provides this via Application.Run.
/// </summary>
internal sealed class ForegroundWatcher : IDisposable
{
    private IntPtr _hook = IntPtr.Zero;
    // Held in a field so the GC cannot collect the delegate the OS retains.
    private readonly NativeMethods.WinEventProc _proc;

    // Coalesce duplicate activations of the same window (the OS can fire
    // EVENT_SYSTEM_FOREGROUND more than once for one switch).
    private IntPtr _lastHwnd = IntPtr.Zero;

    public ForegroundWatcher()
    {
        _proc = OnForegroundChanged;
    }

    public void Start()
    {
        _hook = NativeMethods.SetWinEventHook(
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero,
            _proc,
            0,
            0,
            NativeMethods.WINEVENT_OUTOFCONTEXT | NativeMethods.WINEVENT_SKIPOWNPROCESS);

        if (_hook == IntPtr.Zero)
        {
            Ipc.EmitError("failed to install foreground hook");
            return;
        }

        // Emit the current foreground window once at startup so the state
        // machine has an initial provider context without waiting for a switch.
        EmitFor(NativeMethods.GetForegroundWindow());
    }

    private void OnForegroundChanged(
        IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
    {
        if (hwnd == IntPtr.Zero || hwnd == _lastHwnd) return;
        _lastHwnd = hwnd;
        EmitFor(hwnd);
    }

    private static void EmitFor(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            Ipc.EmitForegroundChanged(null, null);
            return;
        }

        string? processName = ResolveProcessName(hwnd);
        string? browserUrl = BrowserUrl.IsBrowser(processName) ? BrowserUrl.Extract(hwnd) : null;
        Ipc.EmitForegroundChanged(processName, browserUrl);
    }

    private static string? ResolveProcessName(IntPtr hwnd)
    {
        try
        {
            NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid == 0) return null;
            using Process p = Process.GetProcessById((int)pid);
            // Process.ProcessName is the executable basename without ".exe",
            // matching catalog surface_match.process_names entries ("Claude").
            return p.ProcessName;
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_hook != IntPtr.Zero)
        {
            NativeMethods.UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
    }
}
