import Foundation
import AppKit
import ApplicationServices

/// AXObserver-based detection of in-browser tab and window switches.
///
/// When a supported browser becomes foreground, two AX notifications
/// are attached:
///   - kAXTitleChangedNotification on the browser's focused window:
///     fires when the user switches tabs (window title updates to
///     reflect the new tab's page title).
///   - kAXFocusedWindowChangedNotification on the browser's application
///     element: fires when the user switches between browser windows.
///
/// On either notification we re-extract the URL via AxBrowserUrl and
/// emit a fresh foreground_changed. The state machine in step 2 treats
/// this as "same provider, different session_id" and rolls the session
/// forward with correct boundaries.
///
/// Only one browser is observed at a time. Activating a different app
/// (browser or otherwise) tears down the current observer.
enum AxTabObserver {
    private static var observer: AXObserver?
    private static var observedApp: NSRunningApplication?
    private static var observedWindow: AXUIElement?
    private static var lastEmittedUrl: String?

    static func activate(app: NSRunningApplication) {
        deactivate()

        guard AxBrowserUrl.isBrowser(bundleId: app.bundleIdentifier) else { return }
        guard Permissions.currentAccessibility() else { return }

        let pid = app.processIdentifier
        guard pid > 0 else { return }

        var obs: AXObserver?
        let createErr = AXObserverCreate(pid, axCallback, &obs)
        guard createErr == .success, let obsRef = obs else { return }

        let appRef = AXUIElementCreateApplication(pid)

        // Application-level notification: fires when the focused window
        // within this app changes (cmd-` window switching, window close,
        // new window open).
        _ = AXObserverAddNotification(
            obsRef, appRef, kAXFocusedWindowChangedNotification as CFString, nil
        )

        // Window-level notification: fires when the focused window's
        // title changes (tab switch within that window).
        attachTitleObserver(observer: obsRef, to: appRef)

        let source = AXObserverGetRunLoopSource(obsRef)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)

        observer = obsRef
        observedApp = app
    }

    static func deactivate() {
        if let obsRef = observer {
            let source = AXObserverGetRunLoopSource(obsRef)
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        observer = nil
        observedApp = nil
        observedWindow = nil
        lastEmittedUrl = nil
    }

    /// Called by the C callback on any subscribed notification.
    fileprivate static func handleNotification(_ notification: CFString) {
        guard let app = observedApp else { return }
        let name = notification as String

        // On window-focus change, move the title observer onto the new
        // focused window so subsequent tab switches inside it register.
        if name == (kAXFocusedWindowChangedNotification as String) {
            if let obsRef = observer {
                let appRef = AXUIElementCreateApplication(app.processIdentifier)
                attachTitleObserver(observer: obsRef, to: appRef)
            }
        }

        let url = AxBrowserUrl.extract(for: app)
        // Tab switches and window changes can fire multiple AX notifications
        // in rapid succession while the browser's AX tree is transitioning
        // between states (omnibox momentarily empty, window reference being
        // swapped). Re-extraction during these transients often returns nil.
        // Emitting nil here would drive the state machine through spurious
        // closing transitions; the caller already has the previous URL from
        // the foreground activation or the last successful tab-change emit.
        // Skip when extraction returned nothing; the next notification with
        // a real URL will surface the transition cleanly.
        guard let url = url else { return }
        // Page loads fire multiple AXTitleChangedNotifications in quick
        // succession (title: "" -> "Loading..." -> actual page title).
        // Each fires our callback. Re-emitting the same URL is harmless
        // for the state machine but noisy in the event stream; skip
        // consecutive duplicates here. Reset on deactivate so the next
        // browser activation re-emits fresh.
        guard url != lastEmittedUrl else { return }
        lastEmittedUrl = url
        IpcEmitter.emitForegroundChanged(app: app, browserUrl: url)
    }

    private static func attachTitleObserver(observer obsRef: AXObserver, to appRef: AXUIElement) {
        var windowValue: AnyObject?
        let err = AXUIElementCopyAttributeValue(
            appRef, kAXFocusedWindowAttribute as CFString, &windowValue
        )
        guard err == .success, let rawWindow = windowValue else { return }
        let newWindow = rawWindow as! AXUIElement

        // Remove the previous window's subscription, if any.
        if let oldWindow = observedWindow {
            _ = AXObserverRemoveNotification(
                obsRef, oldWindow, kAXTitleChangedNotification as CFString
            )
        }
        _ = AXObserverAddNotification(
            obsRef, newWindow, kAXTitleChangedNotification as CFString, nil
        )
        observedWindow = newWindow
    }
}

// Non-capturing C callback. Dispatches to the shared enum's handler.
private let axCallback: AXObserverCallback = { _, _, notification, _ in
    AxTabObserver.handleNotification(notification)
}
