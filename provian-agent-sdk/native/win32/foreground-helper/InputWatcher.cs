using System.Diagnostics;

namespace Provian.ForegroundHelper;

/// <summary>
/// Counts user input via low-level keyboard and mouse hooks
/// (WH_KEYBOARD_LL / WH_MOUSE_LL) and emits input_event IPC events. Windows
/// counterpart of the macOS CGEventTap. Carries only a timestamp - no
/// keycode, no coordinates, no content, ever.
///
/// Input is coalesced to at most one event per CoalesceMs. The state machine
/// only needs input presence within ~10s windows to compute active duration
/// and approximate turn counts, so sub-250ms granularity is unnecessary and
/// would flood the IPC queue (which evicts input_event under backpressure).
///
/// Low-level hooks require a message loop on the installing thread; Program
/// provides it via Application.Run. Key/mouse-down only - key-up, mouse-up,
/// and raw mouse-move are ignored (passive motion is not interaction).
/// </summary>
internal sealed class InputWatcher : IDisposable
{
    private const long CoalesceMs = 250;

    private IntPtr _kbHook = IntPtr.Zero;
    private IntPtr _mouseHook = IntPtr.Zero;
    // Held in fields so the GC cannot collect the delegates the OS retains.
    private readonly NativeMethods.LowLevelHookProc _kbProc;
    private readonly NativeMethods.LowLevelHookProc _mouseProc;

    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _lastEmitMs = long.MinValue;

    public InputWatcher()
    {
        _kbProc = KeyboardProc;
        _mouseProc = MouseProc;
    }

    public void Start()
    {
        IntPtr hModule = NativeMethods.GetModuleHandle(null);
        _kbHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_KEYBOARD_LL, _kbProc, hModule, 0);
        _mouseHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_MOUSE_LL, _mouseProc, hModule, 0);

        if (_kbHook == IntPtr.Zero && _mouseHook == IntPtr.Zero)
        {
            // No input visibility - degrade to presence-only fidelity. The TS
            // layer maps the absence of input_monitoring to input_fidelity=
            // presence_only via permission_status (emitted by Program).
            Ipc.EmitError("failed to install input hooks");
        }
    }

    private IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            if (msg == NativeMethods.WM_KEYDOWN || msg == NativeMethods.WM_SYSKEYDOWN)
            {
                MaybeEmit();
            }
        }
        return NativeMethods.CallNextHookEx(_kbHook, nCode, wParam, lParam);
    }

    private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            if (msg == NativeMethods.WM_LBUTTONDOWN
                || msg == NativeMethods.WM_RBUTTONDOWN
                || msg == NativeMethods.WM_MBUTTONDOWN
                || msg == NativeMethods.WM_MOUSEWHEEL)
            {
                MaybeEmit();
            }
        }
        return NativeMethods.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private void MaybeEmit()
    {
        long now = _clock.ElapsedMilliseconds;
        if (now - _lastEmitMs < CoalesceMs) return;
        _lastEmitMs = now;
        Ipc.EmitInputEvent();
    }

    public void Dispose()
    {
        if (_kbHook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_kbHook);
            _kbHook = IntPtr.Zero;
        }
        if (_mouseHook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
    }
}
