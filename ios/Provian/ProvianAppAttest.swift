import Foundation
import DeviceCheck
import CryptoKit

@objc(ProvianAppAttest)
class ProvianAppAttest: NSObject {

  private let keyIdKey = "com.provian.wallet.appattest.keyId"

  // MARK: - isSupported

  @objc
  func isSupported(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 14.0, *) {
      resolve(DCAppAttestService.shared.isSupported)
    } else {
      resolve(false)
    }
  }

  // MARK: - attestKey

  @objc
  func attestKey(_ clientDataHash: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 14.0, *) else {
      reject("UNSUPPORTED", "App Attest requires iOS 14+", nil)
      return
    }

    let service = DCAppAttestService.shared
    guard service.isSupported else {
      reject("UNSUPPORTED", "App Attest is not supported on this device", nil)
      return
    }

    // Generate a new key
    service.generateKey { [weak self] keyId, error in
      guard let self = self else { return }
      if let error = error {
        reject("KEYGEN_ERROR", "Failed to generate attestation key: \(error.localizedDescription)", error)
        return
      }

      guard let keyId = keyId else {
        reject("KEYGEN_ERROR", "Key ID is nil", nil)
        return
      }

      // Store the key ID for later assertion generation
      UserDefaults.standard.set(keyId, forKey: self.keyIdKey)

      // Convert the client data hash from hex to Data
      guard let hashData = Self.hexToData(clientDataHash) else {
        reject("INVALID_HASH", "clientDataHash must be a valid hex string", nil)
        return
      }

      // Attest the key
      service.attestKey(keyId, clientDataHash: hashData) { attestationObject, error in
        if let error = error {
          reject("ATTEST_ERROR", "Attestation failed: \(error.localizedDescription)", error)
          return
        }

        guard let attestationObject = attestationObject else {
          reject("ATTEST_ERROR", "Attestation object is nil", nil)
          return
        }

        resolve([
          "keyId": keyId,
          "attestation": attestationObject.base64EncodedString(),
        ])
      }
    }
  }

  // MARK: - generateAssertion

  @objc
  func generateAssertion(_ clientDataHash: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 14.0, *) else {
      reject("UNSUPPORTED", "App Attest requires iOS 14+", nil)
      return
    }

    guard let keyId = UserDefaults.standard.string(forKey: keyIdKey) else {
      reject("NO_KEY", "No attestation key found. Call attestKey() first.", nil)
      return
    }

    guard let hashData = Self.hexToData(clientDataHash) else {
      reject("INVALID_HASH", "clientDataHash must be a valid hex string", nil)
      return
    }

    let service = DCAppAttestService.shared
    service.generateAssertion(keyId, clientDataHash: hashData) { assertion, error in
      if let error = error {
        reject("ASSERTION_ERROR", "Assertion generation failed: \(error.localizedDescription)", error)
        return
      }

      guard let assertion = assertion else {
        reject("ASSERTION_ERROR", "Assertion is nil", nil)
        return
      }

      resolve([
        "keyId": keyId,
        "assertion": assertion.base64EncodedString(),
      ])
    }
  }

  // MARK: - Helpers

  private static func hexToData(_ hex: String) -> Data? {
    let cleanHex = hex.lowercased()
    guard cleanHex.count % 2 == 0 else { return nil }
    var data = Data()
    var index = cleanHex.startIndex
    while index < cleanHex.endIndex {
      let nextIndex = cleanHex.index(index, offsetBy: 2)
      guard let byte = UInt8(cleanHex[index..<nextIndex], radix: 16) else { return nil }
      data.append(byte)
      index = nextIndex
    }
    return data
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
