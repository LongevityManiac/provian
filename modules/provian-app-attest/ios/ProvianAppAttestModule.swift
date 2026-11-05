// ProvianAppAttest (iOS) — Apple App Attest bridge (Trust Layer §2.9).
//
// The Secure Enclave holds a P-256 key Apple attests against its App Attestation Root CA. The app
// attests the key ONCE (attestKey, clientDataHash = sha256 of the canonical registration binding)
// and registers it with the relay; every later PE carries an ASSERTION (generateAssertion,
// clientDataHash = sha256 of the canonical submit body minus the slot). The relay verifies the
// chain / nonce / rpIdHash / counter and admits the PE as hardware_rooted.
//
// Nothing here ever exposes the key: only Apple-formatted attestation / assertion bytes leave.

import ExpoModulesCore
import DeviceCheck
import Foundation

public class ProvianAppAttestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProvianAppAttest")

    Function("isSupported") { () -> Bool in
      if #available(iOS 14.0, *) { return DCAppAttestService.shared.isSupported }
      return false
    }

    AsyncFunction("generateKey") { (promise: Promise) in
      guard #available(iOS 14.0, *), DCAppAttestService.shared.isSupported else {
        promise.reject("APP_ATTEST_UNSUPPORTED", "App Attest is not supported on this device")
        return
      }
      DCAppAttestService.shared.generateKey { keyId, error in
        if let error = error { promise.reject("APP_ATTEST_GENERATE_FAILED", error.localizedDescription); return }
        promise.resolve(keyId ?? "")
      }
    }

    // clientDataHashBase64: the 32-byte hash the caller already computed (never hashed again here).
    AsyncFunction("attestKey") { (keyId: String, clientDataHashBase64: String, promise: Promise) in
      guard #available(iOS 14.0, *), DCAppAttestService.shared.isSupported else {
        promise.reject("APP_ATTEST_UNSUPPORTED", "App Attest is not supported on this device")
        return
      }
      guard let hash = Data(base64Encoded: clientDataHashBase64), hash.count == 32 else {
        promise.reject("APP_ATTEST_BAD_HASH", "clientDataHash must be 32 bytes, base64")
        return
      }
      DCAppAttestService.shared.attestKey(keyId, clientDataHash: hash) { attestation, error in
        if let error = error { promise.reject("APP_ATTEST_ATTEST_FAILED", error.localizedDescription); return }
        promise.resolve(attestation?.base64EncodedString() ?? "")
      }
    }

    AsyncFunction("generateAssertion") { (keyId: String, clientDataHashBase64: String, promise: Promise) in
      guard #available(iOS 14.0, *), DCAppAttestService.shared.isSupported else {
        promise.reject("APP_ATTEST_UNSUPPORTED", "App Attest is not supported on this device")
        return
      }
      guard let hash = Data(base64Encoded: clientDataHashBase64), hash.count == 32 else {
        promise.reject("APP_ATTEST_BAD_HASH", "clientDataHash must be 32 bytes, base64")
        return
      }
      DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: hash) { assertion, error in
        if let error = error { promise.reject("APP_ATTEST_ASSERT_FAILED", error.localizedDescription); return }
        promise.resolve(assertion?.base64EncodedString() ?? "")
      }
    }
  }
}
