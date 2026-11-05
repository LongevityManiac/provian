import Foundation
import Security
import CryptoKit
import LocalAuthentication

@objc(ProvianSecureEnclaveP256)
class ProvianSecureEnclaveP256: NSObject {

  private static let p256Order: [UInt8] = {
    let hex = "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
    return hexToBytes(hex)
  }()

  private static let p256HalfOrder: [UInt8] = {
    let hex = "7FFFFFFF800000007FFFFFFFFFFFFFFFDE7357D6D3A0CF4279DCE5617E3192A8"
    return hexToBytes(hex)
  }()

  private func keychainTag(for keyId: String) -> Data {
    return "com.provian.wallet.p256.\(keyId)".data(using: .utf8)!
  }

  @objc
  func generateKey(_ keyId: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    let tag = keychainTag(for: keyId)

    // [C-11 + F-02 + MED-3] Access control flags.
    //
    // F-02: Android enforces BIOMETRIC_STRONG at the OS Keystore boundary;
    // iOS uses .biometryCurrentSet so the OS requires the *currently
    // enrolled* biometric set before signing.
    //
    // .biometryCurrentSet invalidates the device-attestation key when the
    // biometric enrollment changes. This blocks a PIN-aware attacker from
    // enrolling a new biometric and signing with the previous device key.
    // BIP-39 wallet recovery and its encrypted cloud backup are independent.
    //
    // .biometryCurrentSet is mirrored on Android by
    // setInvalidatedByBiometricEnrollment(true) on the
    // KeyGenParameterSpec - the two platforms now share the same
    // re-enrollment invalidation policy.
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      nil
    ) else {
      reject("KEYGEN_ERROR", "Failed to create access control", nil)
      return
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]

    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      let errMsg = error?.takeRetainedValue().localizedDescription ?? "Unknown error"
      reject("KEYGEN_ERROR", "Secure Enclave key generation failed: \(errMsg)", nil)
      return
    }

    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      reject("KEYGEN_ERROR", "Failed to extract public key", nil)
      return
    }

    guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      let errMsg = error?.takeRetainedValue().localizedDescription ?? "Unknown error"
      reject("KEYGEN_ERROR", "Failed to export public key: \(errMsg)", nil)
      return
    }

    guard publicKeyData.count == 65, publicKeyData[0] == 0x04 else {
      reject("KEYGEN_ERROR", "Unexpected public key format (length: \(publicKeyData.count))", nil)
      return
    }

    let xBytes = publicKeyData[1...32]
    let yBytes = publicKeyData[33...64]
    let publicKeyX = Self.bytesToHex(Array(xBytes))
    let publicKeyY = Self.bytesToHex(Array(yBytes))

    resolve([
      "publicKeyX": publicKeyX,
      "publicKeyY": publicKeyY,
    ])
  }

  // [C-11] signDigest now accepts frictionLevel parameter.
  // Only 'hard_confirm' triggers biometric authentication before signing.
  // 'auto_approve' and 'soft_confirm' sign silently (friction routing already handled auth).
  //
  // [Chunk I native pass] frictionLevel must be one of the recognized values.
  // Unknown values are rejected (fail-closed) per "Unknown = Block, Not Warn" -
  // a typo or contract drift in JS must not silently downgrade hard_confirm
  // to silent signing.
  private static let recognizedFrictionLevels: Set<String> = [
    "auto_approve",
    "soft_confirm",
    "hard_confirm",
  ]

  @objc
  func signDigest(_ keyId: String,
                  digestHex: String,
                  frictionLevel: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    let tag = keychainTag(for: keyId)
    let digestBytes = Self.hexToBytes(digestHex)

    guard digestBytes.count == 32 else {
      reject("SIGN_ERROR", "Digest must be 32 bytes, got \(digestBytes.count)", nil)
      return
    }

    guard Self.recognizedFrictionLevels.contains(frictionLevel) else {
      reject("INVALID_FRICTION_LEVEL", "Unknown frictionLevel: \(frictionLevel)", nil)
      return
    }

    // [C-11] For hard_confirm, require biometric auth before signing
    if frictionLevel == "hard_confirm" {
      let context = LAContext()
      context.localizedFallbackTitle = "" // Hide passcode fallback
      var authError: NSError?
      guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
        reject("SIGN_ERROR", "Biometric authentication unavailable: \(authError?.localizedDescription ?? "unknown")", nil)
        return
      }

      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                             localizedReason: "Authorize transaction signing") { success, evaluateError in
        if success {
          self.performSign(tag: tag, digestBytes: digestBytes, resolve: resolve, reject: reject)
        } else {
          reject("SIGN_ERROR", "Biometric authentication failed: \(evaluateError?.localizedDescription ?? "cancelled")", nil)
        }
      }
    } else {
      // auto_approve or soft_confirm: sign without biometric prompt
      performSign(tag: tag, digestBytes: digestBytes, resolve: resolve, reject: reject)
    }
  }

  private func performSign(tag: Data,
                           digestBytes: [UInt8],
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    guard status == errSecSuccess, let privateKey = item else {
      reject("SIGN_ERROR", "Key not found in Secure Enclave", nil)
      return
    }

    let digestData = Data(digestBytes)
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      privateKey as! SecKey,
      .ecdsaSignatureDigestX962SHA256,
      digestData as CFData,
      &error
    ) as Data? else {
      let errMsg = error?.takeRetainedValue().localizedDescription ?? "Unknown error"
      reject("SIGN_ERROR", "Signing failed: \(errMsg)", nil)
      return
    }

    guard let (rBytes, sBytes) = Self.parseDERSignature(signature) else {
      reject("SIGN_ERROR", "Failed to parse DER signature", nil)
      return
    }

    let normalizedS = Self.normalizeLowS(sBytes)

    let rHex = Self.bytesToHex(Self.padTo32Bytes(rBytes))
    let sHex = Self.bytesToHex(Self.padTo32Bytes(normalizedS))

    resolve([
      "r": rHex,
      "s": sHex,
    ])
  }

  @objc
  func hasKey(_ keyId: String,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    let tag = keychainTag(for: keyId)

    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: false,
    ]

    let status = SecItemCopyMatching(query as CFDictionary, nil)
    resolve(status == errSecSuccess)
  }

  @objc
  func deleteKey(_ keyId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    let tag = keychainTag(for: keyId)

    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    ]

    let status = SecItemDelete(query as CFDictionary)

    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(nil)
    } else {
      reject("DELETE_ERROR", "Failed to delete key (OSStatus: \(status))", nil)
    }
  }

  @objc
  func isHardwareBacked(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 13.0, *) {
      resolve(SecureEnclave.isAvailable)
    } else {
      resolve(true)
    }
  }

  /// Audit Pass 2, Fix 3: report the actual key backing.
  ///
  /// On iOS the Secure Enclave is the platform's strongbox-equivalent -
  /// keys generated under `kSecAttrTokenIDSecureEnclave` are non-extractable
  /// and live in the dedicated SE coprocessor. We report `"strongbox"` for
  /// any key that exists when `SecureEnclave.isAvailable` is true; on the
  /// rare device that lacks an SE we report `"software"`.
  ///
  /// The Android side surfaces a real distinction between StrongBox and
  /// TEE; iOS does not have that gradient - there's the SE or there isn't.
  @objc
  func getKeyBacking(_ keyId: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 13.0, *) {
      resolve(SecureEnclave.isAvailable ? "strongbox" : "software")
    } else {
      // Pre-iOS-13 devices we no longer support; default to software.
      resolve("software")
    }
  }

  @objc
  func isCloudBackupAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    let token = FileManager.default.ubiquityIdentityToken
    resolve(token != nil)
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  // MARK: - DER Signature Parsing

  private static func parseDERSignature(_ data: Data) -> ([UInt8], [UInt8])? {
    let bytes = Array(data)
    guard bytes.count >= 8, bytes[0] == 0x30 else { return nil }

    var offset = 2

    guard offset < bytes.count, bytes[offset] == 0x02 else { return nil }
    offset += 1
    let rLen = Int(bytes[offset])
    offset += 1
    guard offset + rLen <= bytes.count else { return nil }
    var r = Array(bytes[offset..<(offset + rLen)])
    offset += rLen

    while r.count > 1 && r[0] == 0x00 {
      r.removeFirst()
    }

    guard offset < bytes.count, bytes[offset] == 0x02 else { return nil }
    offset += 1
    let sLen = Int(bytes[offset])
    offset += 1
    guard offset + sLen <= bytes.count else { return nil }
    var s = Array(bytes[offset..<(offset + sLen)])

    while s.count > 1 && s[0] == 0x00 {
      s.removeFirst()
    }

    return (r, s)
  }

  // MARK: - Low-S Normalization

  private static func normalizeLowS(_ s: [UInt8]) -> [UInt8] {
    let sPadded = padTo32Bytes(s)

    if compareUnsigned(sPadded, p256HalfOrder) > 0 {
      return subtractBigUnsigned(p256Order, sPadded)
    }
    return sPadded
  }

  private static func compareUnsigned(_ a: [UInt8], _ b: [UInt8]) -> Int {
    for i in 0..<min(a.count, b.count) {
      if a[i] != b[i] {
        return Int(a[i]) - Int(b[i])
      }
    }
    return a.count - b.count
  }

  private static func subtractBigUnsigned(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
    var result = [UInt8](repeating: 0, count: 32)
    var borrow: Int = 0

    for i in stride(from: 31, through: 0, by: -1) {
      let diff = Int(a[i]) - Int(b[i]) - borrow
      if diff < 0 {
        result[i] = UInt8((diff + 256) & 0xFF)
        borrow = 1
      } else {
        result[i] = UInt8(diff & 0xFF)
        borrow = 0
      }
    }

    return result
  }

  // MARK: - Hex Utilities

  private static func padTo32Bytes(_ bytes: [UInt8]) -> [UInt8] {
    if bytes.count >= 32 {
      return Array(bytes.suffix(32))
    }
    return [UInt8](repeating: 0, count: 32 - bytes.count) + bytes
  }

  private static func hexToBytes(_ hex: String) -> [UInt8] {
    let h = hex.lowercased()
    var bytes: [UInt8] = []
    var index = h.startIndex
    while index < h.endIndex {
      let nextIndex = h.index(index, offsetBy: 2, limitedBy: h.endIndex) ?? h.endIndex
      if let byte = UInt8(h[index..<nextIndex], radix: 16) {
        bytes.append(byte)
      }
      index = nextIndex
    }
    return bytes
  }

  private static func bytesToHex(_ bytes: [UInt8]) -> String {
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}
