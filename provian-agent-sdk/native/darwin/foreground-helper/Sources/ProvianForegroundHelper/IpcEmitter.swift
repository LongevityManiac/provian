import Foundation
import AppKit

/// Serializes line-delimited JSON events to stdout for the TS HelperBridge.
///
/// All events share the shape:
///   { "t": <event-type>, "ts": <unix-millis>, ... }
///
/// Writes are serialized on an internal dispatch queue so concurrent
/// callers cannot interleave bytes within a single JSON line.
enum IpcEmitter {
    private static let writeQueue = DispatchQueue(label: "ai.provian.foreground-helper.emitter")
    private static let stdout = FileHandle.standardOutput
    private static let stderr = FileHandle.standardError
    private static let newline = "\n".data(using: .utf8)!

    static func emitPermissionStatus(accessibility: Bool, inputMonitoring: Bool) {
        emit(event: [
            "t": "permission_status",
            "ts": nowMs(),
            "accessibility": accessibility,
            "input_monitoring": inputMonitoring
        ])
    }

    static func emitForegroundChanged(app: NSRunningApplication, browserUrl: String?) {
        emit(event: [
            "t": "foreground_changed",
            "ts": nowMs(),
            "app": [
                "bundle_id": jsonOrNull(app.bundleIdentifier),
                "process_name": jsonOrNull(app.localizedName)
            ],
            "browser_url": jsonOrNull(browserUrl)
        ])
    }

    /// Emit a single input_event. Carries only a timestamp; no keycode,
    /// no modifier, no content. Called from the CGEventTap callback.
    static func emitInputEvent() {
        emit(event: [
            "t": "input_event",
            "ts": nowMs()
        ])
    }

    /// Emit a system_state event. `state` must be one of "sleep",
    /// "wake", "lock", "unlock" (validated at the TS IPC boundary).
    static func emitSystemState(state: String) {
        emit(event: [
            "t": "system_state",
            "ts": nowMs(),
            "state": state
        ])
    }

    static func nowMs() -> Int {
        return Int(Date().timeIntervalSince1970 * 1000)
    }

    private static func emit(event: [String: Any]) {
        writeQueue.sync {
            guard JSONSerialization.isValidJSONObject(event),
                  let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
            else {
                stderr.write("helper: failed to serialize event\n".data(using: .utf8)!)
                return
            }
            stdout.write(data)
            stdout.write(newline)
        }
    }

    private static func jsonOrNull<T>(_ value: T?) -> Any {
        if let value = value {
            return value
        }
        return NSNull()
    }
}
