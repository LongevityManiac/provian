import Foundation
import Security

/// Native iCloud Keychain sync module for Provian Wallet.
///
/// Stores the PIN-encrypted wallet backup blob — a single AES-256-GCM ciphertext produced by
/// CloudBackupV2 (the encrypted BIP-39 mnemonic) — with kSecAttrSynchronizable = true, which
/// enables iCloud Keychain sync across devices signed into the same Apple ID. (There are NO
/// Shamir recovery shares anywhere in this app; an earlier docstring here claimed otherwise.)
///
/// CRITICAL: All queries include kSecAttrAccessGroup to ensure items are
/// stored in the shared keychain access group declared in entitlements.
/// Without this, items land in the app-private keychain and are lost on reinstall.
@objc(ProvianCloudKeychainSync)
class ProvianCloudKeychainSync: NSObject {

  private let service = "com.provian.wallet.recovery"
  private let accessGroupSuffix = "ai.provian.cloudkeychain"

  /// Resolved access group: "{TeamID}.ai.provian.cloudkeychain"
  /// Team ID is probed at init by writing+reading a temporary keychain item.
  private lazy var accessGroup: String? = {
    // Probe: add a temporary item without an explicit access group, then read
    // back the access group iOS assigned (which includes the team ID prefix).
    let probeAccount = "provian.teamid.probe.\(UUID().uuidString)"
    let addQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: probeAccount,
      kSecValueData as String: Data([0x42]),
      kSecReturnAttributes as String: true,
    ]
    var ref: AnyObject?
    let addStatus = SecItemAdd(addQuery as CFDictionary, &ref)

    // Clean up the probe item regardless of outcome
    defer {
      let delQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: probeAccount,
      ]
      SecItemDelete(delQuery as CFDictionary)
    }

    guard addStatus == errSecSuccess,
          let attrs = ref as? [String: Any],
          let defaultGroup = attrs[kSecAttrAccessGroup as String] as? String else {
      NSLog("[ProvianKeychain] WARNING: team ID probe failed (status \(addStatus)), access group unavailable")
      return nil
    }

    // defaultGroup is like "L83XFY5S26.com.provian.wallet"
    // Extract the team ID prefix (everything up to and including the first dot)
    guard let dotIndex = defaultGroup.firstIndex(of: ".") else {
      NSLog("[ProvianKeychain] WARNING: unexpected access group format: \(defaultGroup)")
      return nil
    }
    let teamPrefix = String(defaultGroup[defaultGroup.startIndex...dotIndex])
    let resolved = teamPrefix + accessGroupSuffix
    NSLog("[ProvianKeychain] Resolved access group: \(resolved)")
    return resolved
  }()

  // MARK: - Private: query builders

  /// Base query fields shared by all operations.
  private func baseQuery(key: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    if let group = accessGroup {
      q[kSecAttrAccessGroup as String] = group
    }
    return q
  }

  /// Read from the old (no access group) keychain - used for migration only.
  private func readFromLegacyKeychain(key: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanTrue!,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
      return data
    }
    return nil
  }

  /// Delete from the old (no access group) keychain - used after migration.
  private func deleteFromLegacyKeychain(key: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// Store data into the correct access group.
  private func storeInAccessGroup(key: String, data: Data) -> OSStatus {
    // Delete any existing item first (upsert pattern)
    var deleteQuery = baseQuery(key: key)
    deleteQuery[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    SecItemDelete(deleteQuery as CFDictionary)

    // Also delete from legacy location if it exists there
    deleteFromLegacyKeychain(key: key)

    // Add with iCloud sync in the correct access group
    var addQuery = baseQuery(key: key)
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrSynchronizable as String] = kCFBooleanTrue!
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(addQuery as CFDictionary, nil)
  }

  // MARK: - store

  @objc
  func store(_ key: String,
             value: String,
             resolver resolve: @escaping RCTPromiseResolveBlock,
             rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = value.data(using: .utf8) else {
      reject("ENCODE_ERROR", "Failed to encode value as UTF-8", nil)
      return
    }

    let status = storeInAccessGroup(key: key, data: data)

    if status == errSecSuccess {
      resolve(true)
    } else {
      reject("STORE_ERROR", "SecItemAdd failed with OSStatus \(status)", nil)
    }
  }

  // MARK: - migrateAccessibility (M-4)

  @objc
  func migrateAccessibility(_ key: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Try to read from the correct access group first
    var readQuery = baseQuery(key: key)
    readQuery[kSecAttrSynchronizable as String] = kCFBooleanTrue!
    readQuery[kSecReturnData as String] = true
    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: AnyObject?
    var readStatus = SecItemCopyMatching(readQuery as CFDictionary, &result)

    // If not in access group, try legacy location and migrate
    if readStatus == errSecItemNotFound {
      if let legacyData = readFromLegacyKeychain(key: key) {
        result = legacyData as AnyObject
        readStatus = errSecSuccess
      }
    }

    guard readStatus == errSecSuccess, let data = result as? Data else {
      resolve(false)
      return
    }

    let addStatus = storeInAccessGroup(key: key, data: data)
    if addStatus == errSecSuccess {
      resolve(true)
    } else {
      reject("MIGRATE_ERROR", "Failed to re-store: OSStatus \(addStatus)", nil)
    }
  }

  // MARK: - retrieve

  @objc
  func retrieve(_ key: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    // 1. Try the correct access group first
    var query = baseQuery(key: key)
    query[kSecAttrSynchronizable as String] = kCFBooleanTrue!
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    if status == errSecSuccess, let data = result as? Data,
       let value = String(data: data, encoding: .utf8) {
      resolve(value)
      return
    }

    // 2. Fallback: try legacy keychain (no access group) and migrate if found
    if let legacyData = readFromLegacyKeychain(key: key),
       let value = String(data: legacyData, encoding: .utf8) {
      NSLog("[ProvianKeychain] Found '\(key)' in legacy keychain, migrating to access group")
      // Migrate: re-store in the correct access group (also deletes legacy copy)
      let migStatus = storeInAccessGroup(key: key, data: legacyData)
      if migStatus != errSecSuccess {
        NSLog("[ProvianKeychain] Migration store failed (\(migStatus)), returning legacy value anyway")
      }
      resolve(value)
      return
    }

    if status == errSecItemNotFound {
      resolve(nil)
    } else {
      reject("READ_ERROR", "SecItemCopyMatching failed with OSStatus \(status)", nil)
    }
  }

  // MARK: - listKeys — every synchronizable item key in this service
  // One cloud account can hold more than one wallet's backup (each wallet past the first in
  // its own key), and recovery has to find them all. Mirrors the Android module's listKeys:
  // keys only, never values.

  @objc
  func listKeys(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: kCFBooleanTrue!,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    if let group = accessGroup {
      query[kSecAttrAccessGroup as String] = group
    }

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      resolve([String]())
      return
    }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else {
      reject("LIST_ERROR", "SecItemCopyMatching failed with OSStatus \(status)", nil)
      return
    }
    var keys: [String] = []
    for attrs in items {
      if let account = attrs[kSecAttrAccount as String] as? String, !keys.contains(account) {
        keys.append(account)
      }
    }
    resolve(keys)
  }

  // MARK: - storeWithSync (legacy alias)

  @objc
  func storeWithSync(_ key: String,
                     value: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    store(key, value: value, resolver: resolve, rejecter: reject)
  }

  // MARK: - readSyncedItem (legacy alias)

  @objc
  func readSyncedItem(_ key: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    retrieve(key, resolver: resolve, rejecter: reject)
  }

  // MARK: - deleteSyncedItem

  @objc
  func deleteSyncedItem(_ key: String,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Delete from both the correct access group and legacy location
    var query = baseQuery(key: key)
    query[kSecAttrSynchronizable as String] = kCFBooleanTrue!
    let status = SecItemDelete(query as CFDictionary)

    // Also clean up legacy location
    deleteFromLegacyKeychain(key: key)

    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(true)
    } else {
      reject("DELETE_ERROR", "SecItemDelete failed with OSStatus \(status)", nil)
    }
  }

  // MARK: - verifySync (C-6; A2)
  // Post-store confirmation that the backup can actually reach iCloud Keychain.
  //
  // Returns TRUE only when BOTH hold:
  //   (a) an iCloud account is signed in (FileManager.ubiquityIdentityToken != nil), AND
  //   (b) the just-written item exists locally with kSecAttrSynchronizable = true.
  //
  // (a) is the load-bearing addition. The old check was (b) ALONE — but (b) only proves the
  // item sits in the LOCAL keychain marked synchronizable; it reads back the exact flag this
  // module set at write time (storeInAccessGroup). With NO iCloud account signed in, that flag
  // can never leave the device, yet (b) alone still returned true — reporting a device-local
  // write as a cloud backup, the worst silent-loss case. A nil ubiquity token DEFINITIVELY
  // means no iCloud, so (a) fail-closes that case: CloudBackupV2 rolls back the write and tells
  // the user to sign into iCloud ("Unknown/Impossible = Block").
  //
  // HONEST LIMITATION — do NOT overstate this to the user. iOS exposes no public API that
  // positively confirms the iCloud KEYCHAIN sub-toggle is on, or that the item propagated to
  // Apple's servers. ubiquityIdentityToken confirms an iCloud ACCOUNT, not the Keychain toggle,
  // and true cross-device propagation can only be confirmed on a second device. So TRUE here
  // means "an iCloud account is present and the item is queued for iCloud Keychain sync", NOT
  // "confirmed synced". Callers present it as such, never as a proven off-device backup.

  @objc
  func verifySync(_ key: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    // (a) No iCloud account → sync is impossible. Fail closed rather than report a false backup.
    guard FileManager.default.ubiquityIdentityToken != nil else {
      NSLog("[ProvianKeychain] verifySync: no iCloud account signed in — cannot sync; reporting NOT backed up")
      resolve(false)
      return
    }

    // (b) The synchronizable item must exist locally (queued for iCloud Keychain sync).
    var query = baseQuery(key: key)
    query[kSecAttrSynchronizable as String] = kCFBooleanTrue!
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    if status == errSecSuccess, let attrs = result as? [String: Any] {
      // Confirm the synchronizable attribute is set
      let isSyncable = attrs[kSecAttrSynchronizable as String] as? Bool ?? false
      resolve(isSyncable)
    } else {
      resolve(false)
    }
  }

  // MARK: - isSyncVerified — iCloud-account AVAILABILITY probe (exposed to JS as isSyncAvailable)
  // NOTE (A2): this is NOT a per-item sync confirmation despite the historical name. It
  // answers only "is an iCloud account signed in at all", which is why the TS layer exposes it
  // as `isSyncAvailable()` and the recovery screen uses it to decide whether cloud recovery is
  // even possible. Per-backup confirmation is `verifySync` above. ubiquityIdentityToken is
  // non-nil whenever an iCloud account is present; it does not isolate the iCloud Keychain toggle.

  @objc
  func isSyncVerified(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    let isSignedIn = FileManager.default.ubiquityIdentityToken != nil
    resolve(isSignedIn)
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
