import Foundation

/// A local coordinated write is not an iCloud backup. Unknown upload state never acknowledges it.
enum ICloudUploadConfirmation {
  struct State {
    let uploaded: Bool?
    let uploading: Bool?
    let error: Error?
  }

  enum Failure: Error { case timeout }

  static func wait(
    timeout: TimeInterval,
    state: () throws -> State,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    pause: () -> Void = { Thread.sleep(forTimeInterval: 0.25) }
  ) throws {
    let deadline = now() + timeout
    while true {
      let value = try state()
      if let error = value.error { throw error }
      if value.uploaded == true && value.uploading != true { return }
      if now() >= deadline { throw Failure.timeout }
      pause()
    }
  }
}
