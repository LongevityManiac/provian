import Foundation
import AppKit

/// Subscribes to machine sleep/wake and screen lock/unlock events and
/// emits system_state IPC events.
///
/// Sleep and wake come from NSWorkspace's notification center (same one
/// already used for app-activation in main.swift).
///
/// Screen lock and unlock detection on modern macOS is layered. The
/// Darwin distributed notifications `com.apple.screenIsLocked` and
/// `com.apple.screenIsUnlocked` fire on some lock paths but not all; in
/// particular, Ctrl-Cmd-Q on macOS 14+ appears to skip them while still
/// locking the screen. The screensaver-family names
/// `com.apple.screensaver.didstart` / `com.apple.screensaver.didstop`
/// cover the screensaver path (lock-after-screensaver with "Require
/// password immediately" on).
///
/// The ultimate fallback is already captured by main.swift's NSWorkspace
/// observer: when the screen locks, `com.apple.loginwindow` becomes the
/// foreground process. The plugin layer maps that to "no provider" and
/// the state machine transitions the current session through the 60-
/// second closing window before finalizing. The explicit system_state
/// event lets the state machine end sessions immediately instead of
/// waiting out the closing grace; when the explicit event is not
/// delivered by the OS, the closing-window path takes over.
///
/// Neither API requires a permission grant.
enum SystemStateMonitor {
    static func start() {
        startWorkspaceObservers()
        startDarwinObservers()
    }

    private static func startWorkspaceObservers() {
        let center = NSWorkspace.shared.notificationCenter

        _ = center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { _ in
            IpcEmitter.emitSystemState(state: "sleep")
        }

        _ = center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { _ in
            IpcEmitter.emitSystemState(state: "wake")
        }
    }

    // A stable non-nil pointer used as the observer identity when
    // registering with CFNotificationCenter. The content is not
    // dereferenced; the pointer is a bookkeeping tag.
    private static let observerTag = UnsafeRawPointer(bitPattern: 0x1)!

    private static func startDarwinObservers() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        for name in darwinLockNames + darwinUnlockNames {
            CFNotificationCenterAddObserver(
                center,
                observerTag,
                darwinCallback,
                name as CFString,
                nil,
                .deliverImmediately
            )
        }
    }

    fileprivate static let darwinLockNames: [String] = [
        "com.apple.screenIsLocked",
        "com.apple.screensaver.didstart"
    ]

    fileprivate static let darwinUnlockNames: [String] = [
        "com.apple.screenIsUnlocked",
        "com.apple.screensaver.didstop"
    ]
}

// C-function-pointer callback for Darwin notifications. CFNotificationName
// is a CFString typealias; match by string value to route between lock
// and unlock. Runs on whatever thread CFNotificationCenter uses;
// IpcEmitter's internal dispatch queue keeps writes atomic.
private let darwinCallback: CFNotificationCallback = { _, _, name, _, _ in
    guard let name = name else { return }
    let nameStr = name.rawValue as String
    if SystemStateMonitor.darwinLockNames.contains(nameStr) {
        IpcEmitter.emitSystemState(state: "lock")
    } else if SystemStateMonitor.darwinUnlockNames.contains(nameStr) {
        IpcEmitter.emitSystemState(state: "unlock")
    }
}
