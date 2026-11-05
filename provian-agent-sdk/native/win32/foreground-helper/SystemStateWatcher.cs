using Microsoft.Win32;

namespace Provian.ForegroundHelper;

/// <summary>
/// Emits system_state IPC events (sleep|wake|lock|unlock) using
/// Microsoft.Win32.SystemEvents. Windows counterpart of the macOS
/// SystemStateMonitor (NSWorkspace sleep/wake + distributed lock/unlock
/// notifications).
///
/// SystemEvents delivers its callbacks on a hidden message-only window, so a
/// running message loop is required (Program provides it via Application.Run).
/// </summary>
internal sealed class SystemStateWatcher : IDisposable
{
    public void Start()
    {
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        SystemEvents.SessionSwitch += OnSessionSwitch;
    }

    private static void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        switch (e.Mode)
        {
            case PowerModes.Suspend:
                Ipc.EmitSystemState("sleep");
                break;
            case PowerModes.Resume:
                Ipc.EmitSystemState("wake");
                break;
            // PowerModes.StatusChange (battery/AC) is not a session boundary.
        }
    }

    private static void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        switch (e.Reason)
        {
            case SessionSwitchReason.SessionLock:
            case SessionSwitchReason.SessionLogoff:
            case SessionSwitchReason.RemoteDisconnect:
                Ipc.EmitSystemState("lock");
                break;
            case SessionSwitchReason.SessionUnlock:
            case SessionSwitchReason.SessionLogon:
            case SessionSwitchReason.RemoteConnect:
                Ipc.EmitSystemState("unlock");
                break;
        }
    }

    public void Dispose()
    {
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        SystemEvents.SessionSwitch -= OnSessionSwitch;
    }
}
