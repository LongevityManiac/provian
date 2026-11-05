// ProvianICloudDocuments (iOS) — the PE backup's file store in the owner's own iCloud.
//
// PE meter : the phone keeps every PE and backs it up, encrypted, to the person's
// own iCloud. The previous "backup" wrote synced KEYCHAIN items, which never appear under iCloud
// storage and are size-limited; this module writes real files into the app's ubiquity container
// `iCloud.com.provian.wallet`, in `PEBackup/` (outside `Documents/`, so the files do not show in the
// Files app but do count under Settings → iCloud → Manage Storage → Provian).
//
// Every file arriving here is already AES-256-GCM ciphertext (`src/core/meter/peCloudBackup.ts`, key
// derived from the recovery phrase). This module never sees a key or a readable PE.
//
// All file work runs on one serial utility queue: `url(forUbiquityContainerIdentifier:)` and
// downloads block, and must never run on the main thread.

import ExpoModulesCore
import Foundation

public class ProvianICloudDocumentsModule: Module {
  static let containerId = "iCloud.com.provian.wallet"
  static let folderName = "PEBackup"
  private static let work = DispatchQueue(label: "ai.provian.icloud-documents", qos: .utility)
  private static var cachedContainer: URL?

  public func definition() -> ModuleDefinition {
    Name("ProvianICloudDocuments")

    AsyncFunction("isAvailableAsync") { (promise: Promise) in
      Self.work.async {
        guard FileManager.default.ubiquityIdentityToken != nil else { promise.resolve(false); return }
        promise.resolve(Self.backupDirectory(create: true) != nil)
      }
    }

    AsyncFunction("writeFileAsync") { (name: String, contents: String, promise: Promise) in
      Self.work.async {
        guard Self.isSafeName(name) else { promise.reject("ICLOUD_BAD_NAME", "refused file name"); return }
        guard let dir = Self.backupDirectory(create: true) else {
          promise.reject("ICLOUD_UNAVAILABLE", "iCloud is signed out or iCloud Drive is off for Provian")
          return
        }
        let url = dir.appendingPathComponent(name)
        let data = Data(contents.utf8)
        var coordinationError: NSError?
        var writeError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { target in
          do { try data.write(to: target, options: .atomic) } catch { writeError = error }
        }
        if let error = coordinationError ?? writeError {
          promise.reject("ICLOUD_WRITE_FAILED", error.localizedDescription)
          return
        }
        // Poll only AFTER releasing NSFileCoordinator: iCloud needs that coordination lock to
        // upload the file. The caller publishes its immutable manifest only after all objects
        // have received this acknowledgement. Offline/local-only writes remain failed backups.
        do {
          try ICloudUploadConfirmation.wait(timeout: 120) {
            var freshURL = url
            freshURL.removeAllCachedResourceValues()
            let values = try freshURL.resourceValues(forKeys: [
              .ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey, .ubiquitousItemUploadingErrorKey
            ])
            return ICloudUploadConfirmation.State(uploaded: values.ubiquitousItemIsUploaded,
              uploading: values.ubiquitousItemIsUploading, error: values.ubiquitousItemUploadingError)
          }
          promise.resolve(true)
        } catch ICloudUploadConfirmation.Failure.timeout {
          promise.reject("ICLOUD_UPLOAD_TIMEOUT", "iCloud did not upload \(name) in time")
        } catch {
          promise.reject("ICLOUD_UPLOAD_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("readFileAsync") { (name: String, timeoutMs: Double, promise: Promise) in
      Self.work.async {
        guard Self.isSafeName(name) else { promise.reject("ICLOUD_BAD_NAME", "refused file name"); return }
        guard let dir = Self.backupDirectory(create: false) else {
          promise.reject("ICLOUD_UNAVAILABLE", "iCloud is signed out or iCloud Drive is off for Provian")
          return
        }
        do {
          promise.resolve(try Self.readFile(dir: dir, name: name, timeout: max(1, timeoutMs) / 1000))
        } catch let error as ICloudReadError {
          promise.reject(error.code, error.message)
        } catch {
          promise.reject("ICLOUD_READ_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("listFilesAsync") { (promise: Promise) in
      Self.work.async {
        guard let dir = Self.backupDirectory(create: false) else { promise.resolve([String]()); return }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        // A not-yet-downloaded file can appear as ".<name>.icloud"; report its real name.
        let real = names.map { n -> String in
          if n.hasPrefix(".") && n.hasSuffix(".icloud") { return String(n.dropFirst().dropLast(7)) }
          return n
        }
        promise.resolve(Array(Set(real.filter { Self.isSafeName($0) })).sorted())
      }
    }

    // Restore on a fresh phone: the container's file list may not have arrived yet. Ask iCloud for
    // it (NSMetadataQuery, data scope) and start downloading every backup file.
    AsyncFunction("prepareAsync") { (timeoutMs: Double, promise: Promise) in
      Self.work.async {
        guard FileManager.default.ubiquityIdentityToken != nil, Self.backupDirectory(create: false) != nil else {
          promise.resolve(0)
          return
        }
        let urls = Self.gatherBackupFiles(timeout: max(1, timeoutMs) / 1000)
        for url in urls { try? FileManager.default.startDownloadingUbiquitousItem(at: url) }
        promise.resolve(urls.count)
      }
    }
  }

  // MARK: - helpers

  struct ICloudReadError: Error {
    let code: String
    let message: String
  }

  /// The JS side admits only `[a-z0-9_.-]{1,96}`; here a leading dot (iCloud placeholders) and ".." are refused too.
  static func isSafeName(_ name: String) -> Bool {
    guard !name.isEmpty, name.count <= 96, !name.hasPrefix("."), !name.contains("..") else { return false }
    return name.unicodeScalars.allSatisfy { c in
      (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_" || c == "." || c == "-"
    }
  }

  static func backupDirectory(create: Bool) -> URL? {
    let container: URL
    if let cached = cachedContainer {
      container = cached
    } else {
      guard let resolved = FileManager.default.url(forUbiquityContainerIdentifier: containerId) else { return nil }
      cachedContainer = resolved
      container = resolved
    }
    let dir = container.appendingPathComponent(folderName, isDirectory: true)
    if create && !FileManager.default.fileExists(atPath: dir.path) {
      do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      } catch {
        return nil
      }
    }
    return dir
  }

  static func readFile(dir: URL, name: String, timeout: TimeInterval) throws -> String? {
    let fm = FileManager.default
    let url = dir.appendingPathComponent(name)
    let placeholder = dir.appendingPathComponent(".\(name).icloud")
    var known = fm.fileExists(atPath: url.path) || fm.fileExists(atPath: placeholder.path)
    if !known, let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey]), values.isUbiquitousItem == true {
      known = true
    }
    if !known { return nil }

    try? fm.startDownloadingUbiquitousItem(at: url)
    let deadline = Date().addingTimeInterval(timeout)
    while true {
      let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
      let status = values?.ubiquitousItemDownloadingStatus
      if status == .current { break }
      if status == nil && fm.fileExists(atPath: url.path) { break }
      if Date() >= deadline {
        throw ICloudReadError(code: "ICLOUD_DOWNLOAD_TIMEOUT", message: "iCloud did not deliver \(name) in time")
      }
      Thread.sleep(forTimeInterval: 0.25)
    }

    var coordinationError: NSError?
    var text: String?
    var readError: Error?
    NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { target in
      do {
        let data = try Data(contentsOf: target)
        text = String(data: data, encoding: .utf8)
        if text == nil { readError = ICloudReadError(code: "ICLOUD_NOT_TEXT", message: "\(name) is not UTF-8") }
      } catch {
        readError = error
      }
    }
    if let error = coordinationError ?? readError { throw error }
    return text
  }

  static func gatherBackupFiles(timeout: TimeInterval) -> [URL] {
    let done = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var found: [URL] = []
    var query: NSMetadataQuery?
    var observer: NSObjectProtocol?

    DispatchQueue.main.async {
      let q = NSMetadataQuery()
      q.searchScopes = [NSMetadataQueryUbiquitousDataScope]
      q.predicate = NSPredicate(format: "%K LIKE %@", NSMetadataItemFSNameKey, "pe_*")
      observer = NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main) { _ in
        q.disableUpdates()
        var urls: [URL] = []
        for case let item as NSMetadataItem in q.results {
          if let u = item.value(forAttribute: NSMetadataItemURLKey) as? URL,
             u.deletingLastPathComponent().lastPathComponent == folderName {
            urls.append(u)
          }
        }
        lock.lock(); found = urls; lock.unlock()
        q.stop()
        done.signal()
      }
      query = q
      if !q.start() { done.signal() }
    }

    _ = done.wait(timeout: .now() + timeout)
    DispatchQueue.main.async {
      query?.stop()
      if let o = observer { NotificationCenter.default.removeObserver(o) }
    }
    lock.lock(); defer { lock.unlock() }
    return found
  }
}
