# Recovery Architecture

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

## The Model

Provian wallet recovery uses a cloud backup encrypted with a password you choose. The underlying BIP-39 seed restores both EVM and Solana keys.

## How It Works

**At wallet creation:**
1. `WalletCreationService.createWallet` calls `SeedManager.generate` to produce a 12-word BIP-39 mnemonic.
2. The mnemonic is held in the `provian-secure-seed` native vault, protected by OS user authentication (supported biometrics or device passcode). Derived chain keys are not stored separately.
3. The user picks a backup password (6–64 characters). The mnemonic is encrypted with the password via PBKDF2-HMAC-SHA256 (600,000 iterations; the backup encodes its derivation parameters) → AES-256-GCM.
4. The encrypted blob is synced to iCloud Keychain (iOS) or Google Drive encrypted app folder (Android) via the native `ProvianCloudKeychainSync` module.

**At recovery (new device):**
1. User signs in to the same Apple / Google account on the new device.
2. The native cloud-keychain module pulls the encrypted blob.
3. User enters the same backup password.
4. PBKDF2 derives the AES key; AES-256-GCM decrypts the mnemonic. Wrong password throws an auth-tag failure.
5. `SeedManager.importMnemonic(mnemonic)` re-derives the EVM key (and the Solana key, which derives from the same seed at `m/44'/501'/0'/0'`).
6. Wallet address is restored. User is back in.

The wallet address is the same: it's a normal Ethereum address derived from the same seed. The Solana address restores identically from that seed; there is no separate Solana backup.

## Optional Seed Phrase Export

For users who want a fully self-sovereign backup independent of cloud providers, Settings → Exit Strategy → Export Seed reveals the 12 words. By default, users never see them.

## The PE Attestation Key Is Separate

Verified App Attest supplies the hardware-rooted 4.0× class, and so does a verified TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed Provian observer release (the measured observer, 2026-10-10: the platform produces the measurement when the program starts, so the operator cannot choose it; the pins come only from the signed release channel). Any other verified hardware report remains a presentation fact at the normal lane price (StrongBox and desktop Secure Enclave evidence included); a bare attested machine submission mints at device tier. Registration tiers follow the same rule. Replication, independent corroboration and the separate 2.0× verified-human linkage factor remain unchanged. Historical sealed prices never reprice. The PE attestation key never leaves its secure element and is not used for wallet signing. Recovery restores the same wallet from its encrypted seed backup; a new device registers a new attestation key and starts its own PE sub-chain. Owner-held PE backups and relay device-key records preserve proof continuity.

## Security Properties

- The mnemonic is the recovery factor. Cloud backup plus password is needed to access it.
- An attacker with cloud access alone cannot decrypt the blob without the password.
- An attacker with the password alone cannot reach the blob without cloud access.
- The cloud provider sees only ciphertext. The mnemonic is never exposed in plaintext to any service.
- Optional seed phrase export gives advanced users an additional out-of-band recovery path.
