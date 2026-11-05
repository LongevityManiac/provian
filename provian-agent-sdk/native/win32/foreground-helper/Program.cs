using System.Windows.Forms;

namespace Provian.ForegroundHelper;

/// <summary>
/// Entry point for the Provian Windows foreground helper.
///
/// Mirrors native/darwin/foreground-helper/main.swift: probe permissions and
/// emit a baseline permission_status, install the foreground / input / system-
/// state watchers, then run a message loop forever. The observer's TS
/// HelperBridge spawns this with piped stdio, reads the line-delimited JSON on
/// stdout, and restarts it on exit with backoff.
///
/// A WinForms message loop (Application.Run) drives three things that all
/// require message dispatch on this thread: the WINEVENT_OUTOFCONTEXT
/// foreground hook, the WH_*_LL low-level input hooks, and SystemEvents.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main()
    {
        // stdout is the IPC channel; make sure nothing buffers or rewrites it.
        // Ipc writes raw UTF-8 bytes directly to the standard output stream.
        try
        {
            // Baseline permission snapshot. On Windows, reading foreground
            // window identity and installing low-level hooks needs no special
            // TCC-style grant in an interactive desktop session, so both are
            // reported true. If hook installation fails at runtime (e.g. under
            // a more restrictive session), InputWatcher emits an error event
            // and the TS layer keeps input_fidelity at its optimistic default;
            // session capture still works from foreground + system-state.
            Ipc.EmitPermissionStatus(accessibility: true, inputMonitoring: true);

            using var foreground = new ForegroundWatcher();
            using var input = new InputWatcher();
            using var systemState = new SystemStateWatcher();

            foreground.Start();
            input.Start();
            systemState.Start();

            // Hidden, no main window. Application.Run pumps the message queue
            // so the hooks and SystemEvents callbacks fire. Runs until the
            // process is terminated (the bridge kills it on observer shutdown).
            Application.Run(new ApplicationContext());
            return 0;
        }
        catch (Exception ex)
        {
            Ipc.EmitFatal(ex.Message);
            return 1;
        }
    }
}
