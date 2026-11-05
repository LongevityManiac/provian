/// provian-se-sign - Secure Enclave P-256 key generation and signing CLI
///
/// Usage:
///   provian-se-sign --generate --key-alias <alias>
///     → Generates a P-256 key in the Mac Secure Enclave
///     → Outputs: { "publicKeyX": "<hex>", "publicKeyY": "<hex>" }
///
///   provian-se-sign --sign --hash <hex> --key-alias <alias>
///     → Signs a 32-byte hash with the SE key (Touch ID / password auth)
///     → Outputs: { "r": "<hex>", "s": "<hex>" }
///
/// The generated key is non-exportable - the private key never leaves
/// the Secure Enclave hardware. The public key coordinates can be used
/// to register a supported human-owned Mac as a PE signer. The relay caps
/// this signing path at hardware_partial until macOS platform attestation is
/// verifiable. Agent-owned devices remain software regardless of this key.
///
/// DEVICE REGISTRATION:
/// After generating a key, use the current human-device registration flow to
/// register the public key. Key possession proves signing capability only;
/// evidence verified by the relay determines the recorded attestation tier.

import Foundation
import Security
import LocalAuthentication
import CryptoKit

// MARK: - Helpers

func hexString(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

func dataFromHex(_ hex: String) -> Data? {
    let cleaned = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
    guard cleaned.count % 2 == 0 else { return nil }
    var data = Data()
    var index = cleaned.startIndex
    while index < cleaned.endIndex {
        let nextIndex = cleaned.index(index, offsetBy: 2)
        guard let byte = UInt8(cleaned[index..<nextIndex], radix: 16) else { return nil }
        data.append(byte)
        index = nextIndex
    }
    return data
}

/// Extract raw X and Y coordinates from a SecKey P-256 public key.
/// The external representation is 04 || X (32 bytes) || Y (32 bytes).
func extractP256Coordinates(_ publicKey: SecKey) -> (x: Data, y: Data)? {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        return nil
    }
    // Uncompressed point: 0x04 + 32 bytes X + 32 bytes Y = 65 bytes
    guard data.count == 65, data[0] == 0x04 else { return nil }
    let x = data[1..<33]
    let y = data[33..<65]
    return (x: Data(x), y: Data(y))
}

// MARK: - Key Tag

func keyTag(for alias: String) -> String {
    "ai.provian.se.\(alias)"
}

// MARK: - Generate

func generateKey(alias: String, requireUserPresence: Bool) throws {
    let tag = keyTag(for: alias).data(using: .utf8)!

    // Check if key already exists
    let checkQuery: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef as String: true,
    ]
    var existing: CFTypeRef?
    if SecItemCopyMatching(checkQuery as CFDictionary, &existing) == errSecSuccess {
        fputs("Error: Key with alias '\(alias)' already exists. Delete it first or use a different alias.\n", stderr)
        exit(1)
    }

    // Create access control.
    //   - Default: privateKeyUsage + userPresence (mobile-like - biometric/password per signature).
    //   - --no-user-presence: privateKeyUsage only. The key is still non-extractable and
    //     hardware-bound in the Secure Enclave; signatures just don't prompt Touch ID.
    //     This is the daemon-signing path - background PE emitters can sign without
    //     prompting the user every few minutes. Device-level identity (DeviceKey/DeviceSignature
    //     auth) plus SE key non-extractability remain the trust anchors.
    let flags: SecAccessControlCreateFlags = requireUserPresence
        ? [.privateKeyUsage, .userPresence]
        : [.privateKeyUsage]
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        flags,
        &accessError
    ) else {
        fputs("Error: Failed to create access control: \(accessError?.takeRetainedValue().localizedDescription ?? "unknown")\n", stderr)
        exit(1)
    }

    // Key attributes: P-256 in Secure Enclave
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

    var createError: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
        fputs("Error: Key generation failed: \(createError?.takeRetainedValue().localizedDescription ?? "unknown")\n", stderr)
        exit(1)
    }

    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        fputs("Error: Failed to extract public key\n", stderr)
        exit(1)
    }

    guard let (x, y) = extractP256Coordinates(publicKey) else {
        fputs("Error: Failed to extract P-256 coordinates\n", stderr)
        exit(1)
    }

    // Output JSON
    let output: [String: String] = [
        "publicKeyX": hexString(x),
        "publicKeyY": hexString(y),
    ]
    let jsonData = try JSONSerialization.data(withJSONObject: output, options: .prettyPrinted)
    print(String(data: jsonData, encoding: .utf8)!)
}

// MARK: - Sign

func signHash(alias: String, hashHex: String) throws {
    let tag = keyTag(for: alias).data(using: .utf8)!

    guard let hashData = dataFromHex(hashHex), hashData.count == 32 else {
        fputs("Error: Hash must be exactly 32 bytes (64 hex characters)\n", stderr)
        exit(1)
    }

    // Retrieve the private key from Secure Enclave
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef as String: true,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else {
        fputs("Error: Key '\(alias)' not found (status: \(status)). Generate it first with --generate.\n", stderr)
        exit(1)
    }
    let privateKey = item as! SecKey

    // Sign with ECDSA - Touch ID / password prompt will appear
    var signError: Unmanaged<CFError>?
    guard let signatureData = SecKeyCreateSignature(
        privateKey,
        .ecdsaSignatureMessageX962SHA256,
        hashData as CFData,
        &signError
    ) as Data? else {
        fputs("Error: Signing failed: \(signError?.takeRetainedValue().localizedDescription ?? "unknown")\n", stderr)
        exit(1)
    }

    // Parse DER-encoded ECDSA signature to extract r and s
    guard let (r, s) = parseDERSignature(signatureData) else {
        fputs("Error: Failed to parse DER signature\n", stderr)
        exit(1)
    }

    let output: [String: String] = [
        "r": hexString(r),
        "s": hexString(s),
    ]
    let jsonData = try JSONSerialization.data(withJSONObject: output, options: .prettyPrinted)
    print(String(data: jsonData, encoding: .utf8)!)
}

/// Parse a DER-encoded ECDSA signature into r and s components.
/// DER format: 30 <len> 02 <rlen> <r> 02 <slen> <s>
func parseDERSignature(_ data: Data) -> (r: Data, s: Data)? {
    guard data.count > 6, data[0] == 0x30 else { return nil }

    var offset = 2 // Skip 30 <len>

    // Parse r
    guard data[offset] == 0x02 else { return nil }
    offset += 1
    let rLen = Int(data[offset])
    offset += 1
    var r = Data(data[offset..<(offset + rLen)])
    offset += rLen

    // Parse s
    guard data[offset] == 0x02 else { return nil }
    offset += 1
    let sLen = Int(data[offset])
    offset += 1
    var s = Data(data[offset..<(offset + sLen)])

    // Remove leading zero byte (DER encodes positive integers with leading 0 if high bit set)
    if r.count == 33 && r[0] == 0x00 { r = Data(r.dropFirst()) }
    if s.count == 33 && s[0] == 0x00 { s = Data(s.dropFirst()) }

    // Pad to 32 bytes if shorter
    while r.count < 32 { r.insert(0x00, at: 0) }
    while s.count < 32 { s.insert(0x00, at: 0) }

    return (r: r, s: s)
}

// MARK: - CLI Entry Point

let args = CommandLine.arguments

func printUsage() {
    fputs("""
    Usage:
      provian-se-sign --generate --key-alias <alias> [--no-user-presence]
      provian-se-sign --sign --hash <hex> --key-alias <alias>

    Options:
      --generate           Generate a new P-256 key in Secure Enclave
      --sign               Sign a 32-byte hash with an existing key
      --hash <hex>         The hash to sign (64 hex chars, with or without 0x prefix)
      --key-alias <alias>  Key identifier (stored in Keychain)
      --no-user-presence   Generate a daemon-signable key (omits Touch ID / password gate).
                           Key remains non-extractable and Secure Enclave-bound.

    """, stderr)
    exit(1)
}

// Parse arguments
var mode: String?
var keyAlias: String?
var hashValue: String?
var requireUserPresence = true

var i = 1
while i < args.count {
    switch args[i] {
    case "--generate":
        mode = "generate"
    case "--sign":
        mode = "sign"
    case "--no-user-presence":
        requireUserPresence = false
    case "--key-alias":
        i += 1
        guard i < args.count else { printUsage(); exit(1) }
        keyAlias = args[i]
    case "--hash":
        i += 1
        guard i < args.count else { printUsage(); exit(1) }
        hashValue = args[i]
    default:
        fputs("Unknown argument: \(args[i])\n", stderr)
        printUsage()
    }
    i += 1
}

guard let mode = mode, let keyAlias = keyAlias else {
    printUsage()
    fatalError() // unreachable, printUsage calls exit
}

do {
    switch mode {
    case "generate":
        try generateKey(alias: keyAlias, requireUserPresence: requireUserPresence)
    case "sign":
        guard let hashValue = hashValue else {
            fputs("Error: --hash is required for --sign\n", stderr)
            exit(1)
        }
        try signHash(alias: keyAlias, hashHex: hashValue)
    default:
        printUsage()
    }
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    exit(1)
}
