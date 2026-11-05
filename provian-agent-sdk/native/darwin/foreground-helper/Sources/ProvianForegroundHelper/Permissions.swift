import Foundation
import ApplicationServices
import CoreGraphics

/// Unified permission probing and permission_status emission.
///
/// The helper needs two macOS permissions for full capture:
///   - Accessibility (AXIsProcessTrusted): for browser URL extraction
///     via AXUIElement traversal and for AXObserver-based tab-switch
///     detection.
///   - Input Monitoring (CGPreflightListenEventAccess): for CGEventTap
///     to receive keystroke and click events.
///
/// Both are probed without prompting (the register-device flow in step
/// 6 handles the one-time prompt). permission_status is emitted when
/// either value changes or on the first probe, carrying both fields
/// together so the TS bridge always sees a consistent snapshot.
enum Permissions {
    private static var lastAccessibility: Bool?
    private static var lastInputMonitoring: Bool?

    static func currentAccessibility() -> Bool {
        return AXIsProcessTrusted()
    }

    static func currentInputMonitoring() -> Bool {
        return CGPreflightListenEventAccess()
    }

    /// Emit permission_status if either permission has changed since the
    /// last emission, or on first call. Returns the current snapshot.
    @discardableResult
    static func emitIfChanged() -> (accessibility: Bool, inputMonitoring: Bool) {
        let a = currentAccessibility()
        let im = currentInputMonitoring()
        let aChanged = (lastAccessibility == nil) || (lastAccessibility != a)
        let imChanged = (lastInputMonitoring == nil) || (lastInputMonitoring != im)
        if aChanged || imChanged {
            IpcEmitter.emitPermissionStatus(accessibility: a, inputMonitoring: im)
            lastAccessibility = a
            lastInputMonitoring = im
        }
        return (accessibility: a, inputMonitoring: im)
    }
}
