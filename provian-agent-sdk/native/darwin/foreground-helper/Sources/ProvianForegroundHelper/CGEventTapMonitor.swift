import Foundation
import CoreGraphics

/// Global keystroke and mouse-click observer via CGEventTap.
///
/// Emits one input_event per keyDown, leftMouseDown, rightMouseDown, or
/// otherMouseDown. The emitted event carries only a timestamp; no
/// keycode, no modifier flags, no content. This is the coarsest signal
/// the state machine needs to cluster turns and compute
/// active_duration_ms.
///
/// Requires Input Monitoring permission. When access is denied, the
/// helper stays in presence_only mode (no input_events emitted). The
/// main loop polls permissions every 30 seconds and calls start() when
/// a grant is detected, so the tap comes online automatically after the
/// user flips the switch in System Settings.
///
/// Coalescing semantic: lastEmittedMs is updated on *every* matched
/// callback, not only on emit. The "<100 ms since the last CALLBACK"
/// check therefore requires a continuous 100 ms gap in the event stream
/// before the next emission. A held key or a rapid click burst produces
/// one emit at the start and then silence until the burst ends - no
/// steady 10/second drip during the hold. This under-reports held-key
/// durations relative to a "one emit per 100 ms wall-clock window"
/// design, but the state machine's 10-second turn-gap clustering
/// dominates the active_duration_ms and turn_count calculations in
/// realistic typing patterns, so the two shapes converge. The choice is
/// deliberate: kept explicit here so future work doesn't second-guess
/// it. If you ever want wall-clock-quota semantics, move the
/// lastEmittedMs update into the emit branch only.
enum CGEventTapMonitor {
    private static var tap: CFMachPort?
    private static var runLoopSource: CFRunLoopSource?
    // 100 ms coalescing timestamp per design notes §2. Updated on every
    // matched callback whether we emit or not; gap from the previous
    // callback determines emission. One emit per event burst, one emit
    // per key in normal typing, silence during held keys or rapid fire.
    // The state-machine's 10-second turn-gap absorbs the difference.
    fileprivate static var lastEmittedMs: Int = 0

    /// Start the tap if Input Monitoring is granted. Returns whether
    /// the tap is now running. Idempotent.
    @discardableResult
    static func start() -> Bool {
        guard Permissions.currentInputMonitoring() else { return false }
        guard tap == nil else { return true }

        let mask = (1 << CGEventType.keyDown.rawValue)
                 | (1 << CGEventType.leftMouseDown.rawValue)
                 | (1 << CGEventType.rightMouseDown.rawValue)
                 | (1 << CGEventType.otherMouseDown.rawValue)

        guard let newTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: tapCallback,
            userInfo: nil
        ) else {
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)

        tap = newTap
        runLoopSource = source
        return true
    }

    static func stop() {
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        tap = nil
        runLoopSource = nil
    }

    static func isRunning() -> Bool {
        return tap != nil
    }
}

// CGEventTapCallBack is a C function pointer. The closure captures no
// Swift state; it calls into the shared IpcEmitter which is itself
// process-global and thread-safe via its internal dispatch queue.
private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown:
        let now = IpcEmitter.nowMs()
        if now - CGEventTapMonitor.lastEmittedMs >= 100 {
            IpcEmitter.emitInputEvent()
        }
        CGEventTapMonitor.lastEmittedMs = now
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}
