// ProvianSecureSeed (iOS) — the wallet seed's keychain item.
//
// Why this exists instead of expo-secure-store's `requireAuthentication`:
//   expo-secure-store 15.0.8 hard-codes `.biometryCurrentSet` for every authenticated item
//   (SecureStoreModule.swift:105). That flag (a) permanently invalidates the item the moment the
//   user adds or removes a Face ID / Touch ID enrollment, and (b) makes SecItemAdd fail on a device
//   with no enrolled biometry, so a passcode-only phone cannot create a wallet at all. Its `set()`
//   also deletes the item's other-alias and legacy copies straight after SecItemAdd with no
//   read-back (:116-118).
//
// The OS gates seed access on user authentication through
// `.userPresence` — biometry-ANY (re-enrollment does not invalidate) OR the device passcode — and
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (never synced, readable only while unlocked).
//
// Contract the JS side relies on (src/core/wallet/secureSeedStore.ts):
//   * set NEVER deletes any other keychain item and NEVER replaces an existing one: it only adds. If
// the named item exists it throws ERR_SEED_ITEM_EXISTS (round 2 — the JS side stages a new
//     seed in an EMPTY slot, reads it back, and only then retires the old slot; an in-place update
//     would destroy the old value before the new one is proven).
//   * get returns nil ONLY when the item does not exist. Every other outcome — cancel, failed auth,
//     no UI allowed, undecodable bytes — THROWS with a stable code; nothing is ever deleted on read.
//   * probe never prompts: absent / present / unknown (see probeItemAsync).
//   * items live under a service expo-secure-store never queries ("ai.provian.secureseed"), so no
//     expo-secure-store call (whose deletes are scoped to service "app"/"app:auth"/"app:no-auth")
//     can reach them.
import ExpoModulesCore
import LocalAuthentication
import Security

private let SERVICE = "ai.provian.secureseed"

private func seedError(_ code: String, _ description: String) -> Exception {
  return Exception(name: "ProvianSecureSeedError", description: description, code: code)
}

private func baseQuery(_ key: String) -> [String: Any] {
  return [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: SERVICE,
    kSecAttrAccount as String: key,
  ]
}

private func statusError(_ status: OSStatus, _ op: String) -> Exception {
  switch status {
  case errSecUserCanceled:
    return seedError("ERR_SEED_AUTH_CANCELLED", "\(op): the user cancelled authentication")
  case errSecAuthFailed:
    return seedError("ERR_SEED_AUTH_FAILED", "\(op): authentication failed")
  case errSecInteractionNotAllowed:
    return seedError("ERR_SEED_AUTH_UNAVAILABLE", "\(op): user interaction is not allowed right now")
  default:
    return seedError("ERR_SEED_KEYCHAIN", "\(op): keychain status \(status)")
  }
}

public final class ProvianSecureSeedModule: Module {
  private let lock = NSLock()
  private var actions: [String: LAContext] = [:]

  private func actionContext(_ id: String?) throws -> LAContext {
    lock.lock()
    defer { lock.unlock() }
    guard let id, let context = actions[id] else {
      throw seedError("ERR_SEED_AUTH_UNAVAILABLE", "A live authenticated action is required")
    }
    return context
  }

  private func endAction(_ id: String) {
    lock.lock()
    let context = actions.removeValue(forKey: id)
    lock.unlock()
    context?.invalidate()
  }

  private func endAllActions() {
    lock.lock()
    let contexts = Array(actions.values)
    actions.removeAll()
    lock.unlock()
    for context in contexts { context.invalidate() }
  }

  private func legacyQuery(_ key: String, _ service: String) -> [String: Any] {
    let account = Data(key.utf8)
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: account, kSecAttrAccount as String: account]
  }

  public func definition() -> ModuleDefinition {
    Name("ProvianSecureSeed")

    Function("isAvailable") { () -> Bool in
      return true
    }

    OnAppEntersBackground { self.endAllActions() }
    OnDestroy { self.endAllActions() }

    AsyncFunction("beginActionAsync") { (reason: String, allowPasscode: Bool, _: String, promise: Promise) in
      let id = UUID().uuidString
      let context = LAContext()
      context.localizedFallbackTitle = allowPasscode ? nil : ""
      context.touchIDAuthenticationAllowableReuseDuration = 0
      // Register BEFORE presenting: backgrounding can invalidate even a pending authentication.
      self.lock.lock()
      self.actions[id] = context
      self.lock.unlock()
      let policy: LAPolicy = allowPasscode ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics
      context.evaluatePolicy(policy, localizedReason: reason) { success, error in
        if success {
          self.lock.lock()
          let live = self.actions[id] === context
          context.interactionNotAllowed = true
          self.lock.unlock()
          if live { promise.resolve(id); return }
        }
        self.endAction(id)
        let code = (error as? LAError)?.code
        let cancelled = code == .userCancel || code == .appCancel || code == .systemCancel
        promise.reject(seedError(cancelled ? "ERR_SEED_AUTH_CANCELLED" : "ERR_SEED_AUTH_FAILED", "Action authentication did not complete"))
      }
    }
    AsyncFunction("endActionAsync") { (id: String) in self.endAction(id) }

    AsyncFunction("hasLegacyItemAsync") { (key: String) throws -> Bool in
      for service in ["app:no-auth", "app:auth", "app"] {
        var query = self.legacyQuery(key, service)
        query[kSecReturnAttributes as String] = true
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecSuccess || status == errSecInteractionNotAllowed { return true }
        if status != errSecItemNotFound { throw statusError(status, "hasLegacyItem") }
      }
      return false
    }
    AsyncFunction("getLegacyItemAsync") { (key: String, _: String, id: String) throws -> String? in
      let context = try self.actionContext(id)
      for service in ["app:no-auth", "app:auth", "app"] {
        var query = self.legacyQuery(key, service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { continue }
        // Expo legacy biometryCurrentSet items become inaccessible after re-enrollment.
        // The action has already authenticated; this is a stable unreadable-key result.
        if status == errSecAuthFailed { throw seedError("ERR_SEED_UNRECOVERABLE", "Legacy seed authentication key is no longer usable") }
        if status != errSecSuccess { throw statusError(status, "getLegacyItem") }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
          throw seedError("ERR_SEED_UNRECOVERABLE", "Legacy seed is not UTF-8")
        }
        _ = try self.actionContext(id)
        return value
      }
      return nil
    }

    AsyncFunction("signDeviceDigestAsync") { (keyId: String, hex: String, id: String) throws -> String in
      let context = try self.actionContext(id)
      let raw = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
      guard raw.count == 64 else { throw seedError("ERR_SEED_KEYCHAIN", "Digest must be 32 bytes") }
      var digest = Data()
      for offset in stride(from: 0, to: raw.count, by: 2) {
        let start = raw.index(raw.startIndex, offsetBy: offset)
        let end = raw.index(start, offsetBy: 2)
        guard let byte = UInt8(raw[start..<end], radix: 16) else { throw seedError("ERR_SEED_KEYCHAIN", "Invalid digest") }
        digest.append(byte)
      }
      let query: [String: Any] = [kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: Data("com.provian.wallet.p256.\(keyId)".utf8),
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecUseAuthenticationContext as String: context, kSecReturnRef as String: true]
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      guard status == errSecSuccess, let item else { throw statusError(status, "signDeviceDigest") }
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(item as! SecKey, .ecdsaSignatureDigestX962SHA256, digest as CFData, &error) as Data? else {
        throw seedError("ERR_SEED_KEYCHAIN", "Hardware signature failed")
      }
      _ = try self.actionContext(id)
      return signature.map { String(format: "%02x", $0) }.joined()
    }

    // Existence check that never prompts: attributes only, with UI forbidden. An item whose ACL
    // would need authentication to read attributes answers errSecInteractionNotAllowed — which
    // still proves it exists.
    AsyncFunction("hasItemAsync") { (key: String) throws -> Bool in
      let context = LAContext()
      context.interactionNotAllowed = true
      var query = baseQuery(key)
      query[kSecReturnAttributes as String] = kCFBooleanTrue
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      query[kSecUseAuthenticationContext as String] = context
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      switch status {
      case errSecSuccess, errSecInteractionNotAllowed:
        return true
      case errSecItemNotFound:
        return false
      default:
        throw statusError(status, "hasItem")
      }
    }

    // No-prompt classification for the unlock-time check. iOS exposes no way to ask "would this
    // decrypt" without authenticating, so this reports existence only: a `.userPresence` item is not
    // invalidated by biometric re-enrollment, and one the keychain has dropped reads as absent.
    // Anything else is "unknown" (the caller then performs a real, prompting read).
    AsyncFunction("probeItemAsync") { (key: String) -> String in
      let context = LAContext()
      context.interactionNotAllowed = true
      var query = baseQuery(key)
      query[kSecReturnAttributes as String] = kCFBooleanTrue
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      query[kSecUseAuthenticationContext as String] = context
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      switch status {
      case errSecSuccess, errSecInteractionNotAllowed:
        return "present"
      case errSecItemNotFound:
        return "absent"
      default:
        return "unknown"
      }
    }

    AsyncFunction("setItemAsync") { (key: String, value: String, _: String, id: String?) throws -> Bool in
      _ = try self.actionContext(id)
      guard let data = value.data(using: .utf8) else {
        throw seedError("ERR_SEED_WRITE_FAILED", "setItem: value is not UTF-8")
      }
      var cfError: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .userPresence,
        &cfError
      ) else {
        let code = cfError.map { CFErrorGetCode($0.takeRetainedValue()) } ?? -1
        throw seedError("ERR_SEED_WRITE_FAILED", "setItem: SecAccessControlCreateWithFlags failed (\(code))")
      }

      var add = baseQuery(key)
      add[kSecValueData as String] = data
      add[kSecAttrAccessControl as String] = access
      let status = SecItemAdd(add as CFDictionary, nil)
      if status == errSecSuccess {
        // Deliberately NO sibling deletes here (contrast expo-secure-store set()).
        return true
      }
      if status == errSecDuplicateItem {
        // Never overwrite in place: the caller must delete a slot explicitly before reusing it.
        throw seedError("ERR_SEED_ITEM_EXISTS", "setItem: an item named \(key) already exists")
      }
      throw statusError(status, "setItem")
    }

    AsyncFunction("getItemAsync") { (key: String, _: String, id: String?) throws -> String? in
      let context = try self.actionContext(id)
      var query = baseQuery(key)
      query[kSecReturnData as String] = kCFBooleanTrue
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      query[kSecUseAuthenticationContext as String] = context
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      switch status {
      case errSecSuccess:
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
          throw seedError("ERR_SEED_UNRECOVERABLE", "getItem: stored bytes are not UTF-8")
        }
        _ = try self.actionContext(id)
        return value
      case errSecItemNotFound:
        return nil
      default:
        throw statusError(status, "getItem")
      }
    }

    AsyncFunction("deleteItemAsync") { (key: String) throws -> Bool in
      let status = SecItemDelete(baseQuery(key) as CFDictionary)
      if status == errSecSuccess || status == errSecItemNotFound {
        return true
      }
      throw statusError(status, "deleteItem")
    }
  }
}
