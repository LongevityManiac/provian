# Native Secure Enclave Module - Implementation Guide

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

> **Applicability.** This guide describes behavior on devices and builds **where the native Secure Enclave / StrongBox module is present**. On development builds without it, `KeyManager.signPayload` falls back to a software secp256k1 key held in `expo-secure-store`, and the resulting PE earns the `software` attestation tier (0.8x); a production build without the module refuses to generate a PE key. Hardware signing is therefore conditional on module availability, never universal. Where this doc says a key "never leaves the chip" or "signs IN hardware", read it as scoped to the native-module-present case.

This document describes native Secure Enclave / StrongBox / TEE integration for provenance, not wallet-key custody. Verified App Attest supplies the hardware-rooted 4.0× class, and so does a verified TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed Provian observer release (the measured observer, 2026-10-10: the platform produces the measurement when the program starts, so the operator cannot choose it; the pins come only from the signed release channel). Any other verified hardware report remains a presentation fact at the normal lane price (StrongBox and desktop Secure Enclave evidence included); a bare attested machine submission mints at device tier. Registration tiers follow the same rule. Replication, independent corroboration and the separate 2.0× verified-human linkage factor remain unchanged. Historical sealed prices never reprice. Wallet keys are BIP-39-derived keys managed by SeedManager in encrypted OS storage, with a ciphertext cloud backup; see [Recovery Architecture](./RECOVERY_ARCHITECTURE.md).

## Security Architecture

### P-256 PE Attestation Architecture

| Surface | Curve | Hardware Support | Security Model |
|---------|-------|------------------|----------------|
| PE signing | P-256 | iOS Secure Enclave / Android StrongBox / `provian-se-sign` Swift package on macOS | Hardware key generation + signing IN the secure element; a Secure Enclave daemon's batch-request signature verified by the relay (Node WebCrypto ECDSA P-256) |

### Why P-256?

iOS Secure Enclave and Android StrongBox/TEE natively support **P-256 (secp256r1)**: it is the only elliptic curve with full hardware-backed key generation and signing on both platforms. Provian uses this curve for the dedicated PE attestation key on each device. The PE attestation key is generated lazily the first time it is needed and never leaves the chip; signatures are produced inside the secure element, and the signatures the relay receives (a Secure Enclave daemon's batch requests) are verified against the public key registered at device-register time.

The wallet's signing key is a separate concern: it is a standard secp256k1 EOA derived from a BIP-39 seed via SeedManager. The seed is held in the `provian-secure-seed` native vault with OS user authentication, including supported biometrics or device passcode; it is independent of the PE attestation key.

### Security Guarantees

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SECURE ENCLAVE / STRONGBOX                       │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  P-256 KEY (PE Attestation)                                     │   │
│   │  - Generated IN hardware (Secure Enclave / StrongBox)           │   │
│   │  - Signs IN hardware                                            │   │
│   │  - NEVER exportable                                             │   │
│   │  - Requires biometric                                           │   │
│   │  - Public key registered at device-register time                │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         JAVASCRIPT RUNTIME                               │
│                                                                          │
│   - Receives signature (r, s) only                                      │
│   - Never sees private key                                              │
│   - Signs via native bridge → Secure Enclave / StrongBox                │
│   - Constructs Provenance Envelope JSON                                 │
│   - Relay verifies evidence; App Attest or a pinned measurement lifts│
└─────────────────────────────────────────────────────────────────────────┘
```

## Native Module Interface

### Native Module Interface (ProvianSecureEnclaveP256)

The native module handles **P-256 operations only**: used for hardware-attested PE signing.

```typescript
// Native module interface (must match Kotlin/Swift implementation)
interface SecureEnclaveModule {
    generateKey(keyId: string): Promise<{ publicKeyX: string; publicKeyY: string }>;
    signDigest(keyId: string, digest: string, frictionLevel: string): Promise<{ r: string; s: string }>;
    hasKey(keyId: string): Promise<boolean>;
    deleteKey(keyId: string): Promise<void>;
    isHardwareBacked(): Promise<boolean>;
}
```

### KeyManager TypeScript API

`KeyManager` wraps the native module for hardware-attested PE signing. It does not manage wallet keys; those are handled by SeedManager.

```typescript
KeyManager.generateKey(): Promise<KeyInfo>
KeyManager.signDigest(digest: string, frictionLevel?: string): Promise<SignatureResult>
KeyManager.signMessage(message: string): Promise<string>
KeyManager.hasKey(): Promise<boolean>
KeyManager.getSecurityLevel(): Promise<'strongbox' | 'tee' | 'software'>
KeyManager.performDeviceAttestation(): Promise<{ deviceId, securityLevel, isHardwareBacked, timestamp }>
```

## iOS Implementation

**Files:**
- `ios/Provian/ProvianSecureEnclaveP256.swift`: Native module
- `ios/Provian/ProvianSecureEnclaveP256.m`: React Native bridge

### Key Security Features

1. **P-256 PE Attestation Keys**
   - `kSecAttrTokenIDSecureEnclave`: Generated in Secure Enclave
   - `kSecAttrAccessControlBiometryCurrentSet`: Requires biometric
   - `kSecAttrIsPermanent: true`: Persisted in Keychain
   - Signature (r, s) over the PE's `pe_hash`, kept on the device as the PE's `signature` field (the act record the relay prices does not carry it)

### iOS Entitlements

Add to `ios/Provian/Provian.entitlements`:
```xml
<key>keychain-access-groups</key>
<array>
    <string>$(AppIdentifierPrefix)com.provian.wallet</string>
</array>
```

## Android Implementation

**Files:**
- `android/app/src/main/java/com/provian/wallet/ProvianSecureEnclaveP256Module.kt`: Native module
- `android/app/src/main/java/com/provian/wallet/ProvianSecureEnclaveP256Package.kt`: Package registration

### Key Security Features

1. **P-256 PE Attestation Keys**
   - `setIsStrongBoxBacked(true)`: Uses StrongBox if available
   - Falls back to TEE if StrongBox unavailable
   - `setUserAuthenticationRequired(true)`: Requires biometric
   - Signature (r, s) over the PE's `pe_hash`, kept on the device as the PE's `signature` field (the act record the relay prices does not carry it)

> **Android's key-backing report is telemetry, not attestation.** The Android client reports its key backing via `getKeyBacking`, which surfaces `KeyInfo.securityLevel` (`strongbox` / `tee` / `software`). That label is self-stated. Even a verified Android hardware report is a presentation fact at the normal lane price; only verified Apple App Attest, or a TPM / Nitro / GCP Confidential VM / Azure / NVIDIA attestation whose launch measurement the signed observer release pins (the measured observer, 2026-10-10), can establish a hardware pricing lift. The relay-side Key Attestation chain verifier is shipped; the native client that sends the certificate chain at registration is still pending. 

### Android Permissions

In `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
<uses-permission android:name="android.permission.USE_FINGERPRINT" />
```

## PE Attestation Flow

1. Mobile app or daemon constructs the PE (v2) and its `pe_hash`.
2. On the phone, the `pe_hash` is signed in the secure element with the PE attestation key (`KeyManager.signPayload`, which hashes it and signs the digest in hardware) and kept as the PE's `signature`; on a Secure Enclave daemon, the enclave signs each batch request.
3. PE kept on the device; its act record goes to the relay in the device's daily batch. The phone sends `POST /v1/meter/batch/mobile` under its wallet auth (a request-bound token that binds method, path and body hash); the act record does not carry the PE's `signature`. A Secure Enclave daemon sends `POST /v1/meter/batch` with `Authorization: DeviceSignature <device_id>` and the enclave's (r, s) signature in `X-Provian-Signature`, over a preimage that binds the method, path and body hash.
4. Relay verifies the daemon's batch signature (Node WebCrypto ECDSA P-256) against the public key registered at device-register time. The phone's batch is authenticated by its wallet auth; the hardware evidence the relay checks for a phone act is its App Attest `hardware_witness`.
5. Relay applies owner and evidence policy. Verified App Attest supplies the hardware-rooted 4.0× class, and so does a verified TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed Provian observer release (the measured observer, 2026-10-10: the platform produces the measurement when the program starts, so the operator cannot choose it; the pins come only from the signed release channel). Any other verified hardware report remains a presentation fact at the normal lane price (StrongBox and desktop Secure Enclave evidence included); a bare attested machine submission mints at device tier. Registration tiers follow the same rule. Replication, independent corroboration and the separate 2.0× verified-human linkage factor remain unchanged. Historical sealed prices never reprice.

## Testing

### Verification Checklist

- [ ] `KeyManager.isNativeModuleAvailable` returns `true`
- [ ] `KeyManager.generateKey` creates P-256 key (returns `{ publicKey, isHardwareBacked, securityLevel }`)
- [ ] `KeyManager.getSecurityLevel` returns `tee` or `software` (the StrongBox / TEE distinction for the PE key comes from the native `getKeyBacking`)
- [ ] P-256 signing (`signDigest`) triggers biometric prompt via native module
- [ ] The signed PE's act is accepted by the relay; ordinary hardware signatures select no pricing lift — the hardware-rooted class comes from verified App Attest or a measured-observer attestation
- [ ] Keys persist across app restarts
- [ ] Explicit in-app deletion clears the wallet credentials it covers; iOS Keychain entries can survive uninstall. Preserve recovery and PE backups according to the owner’s deletion choices.

### Test on Real Devices

Secure Enclave and StrongBox **do not work on simulators/emulators**. You must test on physical devices:

**iOS:**
- Any iPhone that runs iOS 15.1 or later (the app's deployment target; every such iPhone has a Secure Enclave)
- Face ID or Touch ID configured

**Android:**
- Pixel 3+ for StrongBox
- Most devices since 2018 for TEE
- Fingerprint or face authentication configured

## References

- [Apple Secure Enclave](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web)
- [Android Keystore](https://developer.android.com/training/articles/keystore)
- [Android StrongBox](https://developer.android.com/training/articles/keystore#HardwareSecurityModule)
