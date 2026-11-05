# Android TEE/Biometric Signing - QA Verification

> **Location note:** This test checklist lives in `docs/setup/`. Run it when verifying a new Android device or after native module changes.


## Build

```bash
npx expo run:android
```

**Important:** Biometric signing requires a **physical device**. Emulators do not have real biometric hardware and will fail at the `BiometricPrompt` step.

## Verify StrongBox vs TEE

After launching the app on device, check logcat for hardware security level:

```bash
adb logcat | grep -i "strongbox\|keystore\|biometric"
```

- **StrongBox**: Dedicated tamper-resistant chip (Pixel 3+, Samsung S10+). Best security.
- **TEE**: Trusted Execution Environment (virtually all Android 6.0+ devices). Good security.
- If StrongBox is unavailable, the native module automatically falls back to TEE.

## Test Checklist

This native module holds exactly one key: the P-256 **PE attestation key** (`provian_pe_attestation`,
`src/core/security/KeyManager.ts`). It identifies the device in the PE chain. It is **not** the wallet
key — wallet transactions are signed with the BIP-39-derived secp256k1 key (`SeedManager`, behind its own
biometric session), which this module never sees.

### 1. Key Generation
- [ ] Fresh install → onboarding → Consent → BiometricSetup → … → Attestation completes
- [ ] The P-256 key is generated (at attestation, or lazily on the first PE via `ProvenanceEnvelopeManager`)
- [ ] Check logcat: key generation in StrongBox or TEE (`getKeyBacking` reports `strongbox` / `tee`)

### 2. Key Persistence
- [ ] Force-close and reopen the app
- [ ] `KeyManager.hasKey` returns `true`; the device public key is unchanged

### 3. Biometric Window
- [ ] A strong biometric opens a 60-second authentication window (`AUTH_VALIDITY_SECONDS`)
- [ ] Inside the window, `auto_approve` / `soft_confirm` digest signing proceeds without a fresh prompt
- [ ] A `hard_confirm` signature always raises its own CryptoObject-bound prompt
- [ ] Cancel biometric → signing fails gracefully (no crash)
- [ ] Signature is valid (r, s are 32 bytes each, low-S normalized)

### 4. Provenance Envelope Signing
- [ ] Trigger a PE-generating action (e.g., create a promise)
- [ ] PE is created with valid `signature` and `device_attestation_id`
- [ ] The relay accepts it at the device's evidence-derived tier (StrongBox and TEE are reported separately)

### 5. Key Deletion
- [ ] Delete wallet (Settings → Reset)
- [ ] `KeyManager.hasKey` returns `false`
- [ ] The next attestation generates a fresh key pair

## Common Failures

### "No activity available for biometric prompt"
The `FragmentActivity` cast in the native module is failing. Check that `MainActivity` extends a class that inherits from `FragmentActivity`:

```bash
# Check MainActivity.kt after prebuild
cat android/app/src/main/java/com/provian/wallet/MainActivity.kt
```

Expo's `ReactActivity` extends `ComponentActivity` which extends `FragmentActivity`, so this should work out of the box. If it doesn't, ensure no custom `Activity` base class was introduced.

### Biometric prompt doesn't appear
- Device must have at least one fingerprint/face enrolled in Settings → Security
- App must have `USE_BIOMETRIC` permission (already in app.json and `AndroidManifest.xml`)
- Check that `androidx.biometric:biometric:1.2.0-alpha05` is in `android/app/build.gradle` dependencies
- Signing inside the 60-second window is silent by design; only `hard_confirm` prompts per signature

### "Key not found" on signing
- Key generation may have silently failed (check logcat for `KEYGEN_ERROR`)
- The `keyId` must match between generation and signing (`provian_pe_attestation`; Keystore alias prefix `com.provian.wallet.p256.`)

### SignDigest returns invalid signature
- Digest must be exactly 32 bytes (hex string without `0x` prefix is 64 chars)
- The native module uses `NONEwithECDSA` - do NOT pass unhashed data
- Low-S normalization is applied automatically in the native module

## Prebuild Safety

The `android/` directory is committed (only build outputs, `local.properties` and keystores are
gitignored). Running `npx expo prebuild --platform android --clean` regenerates it from scratch. The
config plugins listed in `app.json` then re-inject what they own: `withBiometric` adds the
`androidx.biometric` dependency, `withSecureEnclave` writes `ProvianSecureEnclaveP256Module.kt` +
`Package.kt` and registers the package, `withCloudKeychainSync` writes
`ProvianCloudKeychainSync{Module,Package}.kt`, registers the package and adds the Google Sign-In +
Drive client dependencies, and `withPlayIntegrity` does the same for Play Integrity.

`withSecureEnclave` and `withCloudKeychainSync` read their Kotlin (and iOS Swift/ObjC) sources from
the committed files under `plugins/native/` — one copy, read at prebuild time — so a clean prebuild
writes the same modules the committed tree carries, including `getKeyBacking` (the StrongBox-vs-TEE
tier split). `scripts/native-plugin-sources.test.mjs` pins `plugins/native/` byte-identical to the
committed `ios/` and `android/` trees. After a `prebuild --clean`, `MainApplication.kt`'s
`getPackages` registers `ProvianPlayIntegrityPackage`, `ProvianCloudKeychainSyncPackage` and
`ProvianSecureEnclaveP256Package`.

## Architecture Notes

| Property | Value |
|----------|-------|
| Curve | P-256 (secp256r1) |
| Key Storage | Android Keystore (StrongBox-first, TEE fallback) |
| Signing Algorithm | `NONEwithECDSA` (raw digest, no double-hash) |
| Auth Required | `AUTH_BIOMETRIC_STRONG`, 60-second validity window; `hard_confirm` prompts per signature |
| Signature Format | DER → parsed to (r, s) → low-S normalized |
| Public Key Format | Uncompressed: `04 || X (32 bytes) || Y (32 bytes)` |
| Verification | Server-side via Node webcrypto (P-256) against the registered device pubkey (PE attestation only - wallet TX signing is BIP-39 secp256k1, unrelated to this key) |
