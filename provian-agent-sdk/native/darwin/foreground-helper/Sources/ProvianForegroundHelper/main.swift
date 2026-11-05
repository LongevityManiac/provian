import Foundation
import AppKit

// Initial permission probe + baseline emission. Reads both
// accessibility and input_monitoring, emits permission_status with the
// combined snapshot.
Permissions.emitIfChanged()

// Start the CGEventTap if Input Monitoring is already granted. No-op
// and returns false otherwise; the polling loop below will attempt to
// start it when the grant flips on.
CGEventTapMonitor.start()

// Subscribe to machine sleep/wake (NSWorkspace) and screen lock/unlock
// (Darwin distributed notifications). No permissions required.
SystemStateMonitor.start()

let center = NSWorkspace.shared.notificationCenter

_ = center.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { notification in
    guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
        return
    }

    // Re-probe permissions and emit permission_status on any transition.
    let (accessibility, _) = Permissions.emitIfChanged()

    // Wire up / tear down the AX tab observer depending on whether the
    // activated app is a supported browser.
    if AxBrowserUrl.isBrowser(bundleId: app.bundleIdentifier) {
        AxTabObserver.activate(app: app)
    } else {
        AxTabObserver.deactivate()
    }

    // Extract URL for supported browsers when AX trust is granted.
    let browserUrl: String?
    if accessibility, AxBrowserUrl.isBrowser(bundleId: app.bundleIdentifier) {
        browserUrl = AxBrowserUrl.extract(for: app)
    } else {
        browserUrl = nil
    }

    IpcEmitter.emitForegroundChanged(app: app, browserUrl: browserUrl)
}

// Permission poller. Catches grant toggles that happen without an
// activation event. AXIsProcessTrusted and CGPreflightListenEventAccess
// are both cheap local TCC queries, so polling every 30s costs almost
// nothing. When Input Monitoring flips from denied to granted, we
// start the CGEventTap; when it flips from granted to denied, we stop
// it (the tap would otherwise silently stop receiving events).
let permissionPoller = Timer(timeInterval: 30.0, repeats: true) { _ in
    let (_, inputMon) = Permissions.emitIfChanged()
    if inputMon && !CGEventTapMonitor.isRunning() {
        CGEventTapMonitor.start()
    } else if !inputMon && CGEventTapMonitor.isRunning() {
        CGEventTapMonitor.stop()
    }
}
RunLoop.main.add(permissionPoller, forMode: .common)

RunLoop.main.run()
