using System.Runtime.InteropServices;

namespace Provian.ForegroundHelper;

/// <summary>
/// Win32 P/Invoke surface for the foreground helper. Kept in one place so the
/// watchers read as straight-line logic. All delegates that the OS holds onto
/// (WinEventProc, LowLevelHookProc) are stored in static fields by their
/// owning watcher so the GC never collects them while a hook is installed.
///
/// Classic [DllImport] is used (not [LibraryImport]) because these signatures
/// marshal managed delegates to native function pointers - a path DllImport
/// has supported reliably for years, whereas the LibraryImport source
/// generator imposes stricter constraints on delegate parameters.
/// </summary>
internal static class NativeMethods
{
    // --- foreground (WinEvent) -------------------------------------------

    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;

    public delegate void WinEventProc(
        IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWinEventHook(
        uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventProc lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // --- low-level input hooks -------------------------------------------

    public const int WH_KEYBOARD_LL = 13;
    public const int WH_MOUSE_LL = 14;

    // Mouse messages we count as input. Move (WM_MOUSEMOVE 0x0200) is
    // deliberately excluded - passive cursor drift is not interaction.
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_MBUTTONDOWN = 0x0207;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_SYSKEYDOWN = 0x0104;

    public delegate IntPtr LowLevelHookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SetWindowsHookExW")]
    public static extern IntPtr SetWindowsHookEx(
        int idHook, LowLevelHookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")]
    public static extern IntPtr GetModuleHandle(string? lpModuleName);
}
