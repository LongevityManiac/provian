# Compliance Posture

## US Encryption Export

The Provian wallet uses standard encryption beyond the operating system's
own. The posture is
**EAR 740.17(b)(1) mass-market software self-classification**: standard,
publicly-available cryptographic primitives in a consumer app, no novel
cryptographic implementations.

### Cryptographic primitives in use

| Primitive | Where | Purpose |
|---|---|---|
| AES-256-GCM | `src/core/recovery/cloud/cloudBackupEnvelope.ts` | Encrypt the BIP-39 mnemonic for cloud backup |
| PBKDF2-SHA256 (600 000 iterations) | `src/core/recovery/cloud/cloudBackupEnvelope.ts` | Derive the AES key from the user's backup password |
| HMAC-SHA256 | `src/core/security/hmacAsyncStorage.ts`, relay auth | Authenticated storage; relay HMAC tokens |
| ECDSA on P-256 (secp256r1) | iOS Secure Enclave + Android StrongBox/TEE via `KeyManager` | Provenance Envelope and decision-receipt attestation |
| ECDSA on secp256k1 | BIP-39 EOA derivation in `SeedManager` (`@scure/bip32`), signing via `ethers` | EVM transaction signing |
| EIP-712 typed-data signatures | `src/services/RelayAPIService.ts` | Relay credential recovery (replaces the former `personal_sign` path) |
| X25519 + HKDF-SHA256 + XChaCha20-Poly1305 | `src/core/commons/threadCrypto.ts`, `src/core/security/agentKeyRecovery.ts` | End-to-end Commons thread messages; the agent-key recovery escrow |
| HKDF-SHA256 + AES-256-GCM | `src/core/promises/PromiseTermsVault.ts`, `src/core/promises/PromiseShareCrypto.ts` | Seed-derived end-to-end promise terms; the end-to-end promise share link |
| EIP-191 signatures on secp256k1 | `src/core/promises/promiseSigning.ts` | Promise signatures and close-out |
| Ed25519 (SLIP-0010 derivation) | `src/core/chains/solana/` | Solana address derivation and transaction signing |
| `@noble/curves` / `@noble/ciphers` / `@noble/hashes` | mobile + relay | Reference implementations of the above; nothing custom |

No novel cryptographic algorithms are implemented. All primitives are
standard, peer-reviewed, and available in publicly distributed libraries
(Apple `CryptoKit`, Android `KeyStore`, `@noble/curves`, `@noble/ciphers`,
`ethers`, Node `crypto`).

### How the classification is declared

Mass-market self-classification under EAR 740.17(b)(1) produces no ERN and
no CCATS: nothing is issued by BIS, and there is no code to put in the app.

- **App Store Connect.** `app.json` and the checked-in `ios/Provian/Info.plist`
  both set `ITSAppUsesNonExemptEncryption` to `false`. Apple's key does not
  ask whether the app uses encryption; it asks whether the app's encryption
  needs export documentation filed with Apple. Apple takes documentation only
  for proprietary cryptography, or for standard cryptography offered on the
  French store. This app uses standard, published algorithms and is not
  offered in France, so Apple requires no documentation and issues no
  `ITSEncryptionExportComplianceCode`. A build that sets the key to `true`
  without a code is refused at upload. Setting it to `false` answers the
  per-build export questions once, in the build.
- **Google Play.** Play asks no per-build export question; the same
  self-classification covers the Android build.
- **BIS.** The annual self-classification report (Supplement No. 8 to Part
  742) lists the app (Provian Wallet, ECCN 5D992.c, authorization MMKT) and is emailed to BIS and the ENC Encryption Request
  Coordinator by February 1 for the prior calendar year. The report for
  2026 was prepared on 2026-10-27 and is held for filing by February 1,
  2027. App Store Connect does not accept it: Apple takes export
  documentation only in the two cases above.
- **France.** France requires its own encryption declaration for
  distribution there. The app is not offered in France on either store.

### What this file is not

This is not legal advice. It records the classification the app is
submitted under and where each answer is given.

## Cloud-backup password floor - deliberate 6-character minimum

The cloud-backup password minimum is six characters. The reasoning is
captured inline at `src/core/recovery/cloud/cloudBackupEnvelope.ts:77`. In
short:

- Both platforms collect a 6–64 character password on the full
  keyboard. iOS was once capped at a 6-digit numeric PIN; that cap was
  UI-only and was lifted to match Android, and legacy 6-digit PINs
  still restore.
- iOS: the encrypted blob lands in iCloud Keychain, which throttles
  brute-force attacks at the hardware level via Secure Enclave.
- Android: the blob lands in Google Drive, which lacks equivalent
  hardware throttling, so a digits-only 6-character keyspace (one
  million combinations) would be too shallow; an alphanumeric password
  (≈10¹¹ keyspace at 6 chars) compensates.

This matches industry norms for non-custodial wallets with cloud backup
(e.g. Bull Bitcoin Recoverbull's 6-digit floor, Blockchain.com's 4-digit
floor). The minimum is not changed by the recent security pass.
