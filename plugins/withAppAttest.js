/**
 * Expo config plugin that adds ProvianAppAttest native module for iOS.
 *
 * Wraps Apple's DCAppAttestService API for:
 * - attestKey(): Generate and attest a hardware key
 * - generateAssertion(): Sign a challenge with the attested key
 * - isSupported(): Check if App Attest is available
 */
const {
  withDangerousMod,
  withXcodeProject,
  withEntitlementsPlist,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// iOS Swift source
// ---------------------------------------------------------------------------

const APP_ATTEST_SWIFT = `import Foundation
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
        reject("KEYGEN_ERROR", "Failed to generate attestation key: \\(error.localizedDescription)", error)
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
          reject("ATTEST_ERROR", "Attestation failed: \\(error.localizedDescription)", error)
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
        reject("ASSERTION_ERROR", "Assertion generation failed: \\(error.localizedDescription)", error)
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
`;

const APP_ATTEST_OBJC = `#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ProvianAppAttest, NSObject)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(attestKey:(NSString *)clientDataHash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generateAssertion:(NSString *)clientDataHash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
`;

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

function withAppAttestIOS(config) {
  // Write Swift + ObjC files
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName || 'Provian';
      const iosDir = path.join(config.modRequest.platformProjectRoot, projectName);

      fs.mkdirSync(iosDir, { recursive: true });
      fs.writeFileSync(path.join(iosDir, 'ProvianAppAttest.swift'), APP_ATTEST_SWIFT);
      fs.writeFileSync(path.join(iosDir, 'ProvianAppAttest.m'), APP_ATTEST_OBJC);

      return config;
    },
  ]);

  // Add files to Xcode project
  config = withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectName = config.modRequest.projectName || 'Provian';

    const swiftFile = 'ProvianAppAttest.swift';
    const objcFile = 'ProvianAppAttest.m';

    const fileRefs = project.pbxFileReferenceSection();
    const hasSwift = Object.values(fileRefs).some(
      (f) => typeof f === 'object' && f && f.name === swiftFile
    );
    const hasObjc = Object.values(fileRefs).some(
      (f) => typeof f === 'object' && f && f.name === objcFile
    );

    const groupKey = project.pbxGroupByName(projectName)
      ? project.findPBXGroupKey({ name: projectName })
      : project.findPBXGroupKey({ path: projectName });

    if (!hasSwift) {
      project.addSourceFile(`${projectName}/${swiftFile}`, null, groupKey);
    }
    if (!hasObjc) {
      project.addSourceFile(`${projectName}/${objcFile}`, null, groupKey);
    }

    return config;
  });

  // Add App Attest entitlement
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['com.apple.developer.devicecheck.appattest-environment'] = 'production';
    return config;
  });

  return config;
}

module.exports = function withAppAttest(config) {
  config = withAppAttestIOS(config);
  return config;
};
