# Agent Keystore

The agent wallet's secp256k1 private key controls real funds (USDC, PVT). The
SDK generates it locally and non-custodially (the relay never sees it) and
persists it encrypted at rest.

## How it works

- The key is encrypted with **AES-256-GCM**.
- The encryption key is derived from your passphrase with **scrypt** (N=2^17).
- GCM's authentication tag is bound (via AAD) to the keystore header
  (`wallet_id` / `address` / `public_key`), so a tampered header or a
  transplanted ciphertext fails authentication instead of decrypting to the
  wrong key.
- The keystore is a self-contained JSON file at `~/.provian/agent-keystore.json`
  (mode `0600`). It contains **no plaintext key material**, so it is safe to copy.

There is **no cloud backup** of this file. iCloud / Google Drive do not apply in
Node.

**Recovery escrow (an agent linked to a human).** A linked agent's key has one
more copy: it is sealed on this machine to the linked human's published recovery
key, and the relay stores only that ciphertext, which only the human's phone can
open. The relay never sees the key. It is sealed at wallet creation when the
connection code names the human's recovery key. Otherwise the observer seals it
once the agent is linked and the phone has published that key (it checks every
15 minutes until it is escrowed), reading a keystore encrypted under the
machine's local at-rest secret, as the one-command install writes. A key rotation
re-seals the new key to the same recovery key. If the machine is lost, the human
opens the escrow from the Provian app, which prints a `restore-wallet` command
for the new machine; the key is pasted into that command's hidden prompt and
written back as a local keystore. Escrow never holds earnings.

> **An unescrowed key is single-copy.** A wallet with no linked human, or whose
> human's phone has not published its recovery key yet, has no escrow: the key
> exists only on the machine that created it. If that machine is lost, wiped,
> or fails **before** you export a backup, the wallet and any funds in it are
> **permanently unrecoverable**. There is no reset and no backdoor. Back up
> immediately after creating a wallet (the `create-agent-wallet --backup <path>`
> flag does this in one step).

## Create a wallet (opt-in)

Filing a link request to a human (`request-link`) does not create a wallet. Creating one
is an explicit opt-in:

```bash
# Passphrase via env (required for non-interactive runs). --backup writes an
# encrypted off-device backup in the same step so you are never left unbacked:
PROVIAN_KEYSTORE_PASSPHRASE='your strong passphrase' \
  npx @provian/agent-sdk create-agent-wallet --name "Atlas" --backup /Volumes/usb/agent-keystore.json

# Or run interactively and you'll be prompted (input hidden):
npx @provian/agent-sdk create-agent-wallet
```

Before its first relay request, this generates the key locally and writes it to
an encrypted `~/.provian/pending-agent-wallet-registration.json` with the
stable registration/agent identity. It then registers via proof-of-possession,
promotes the key to `~/.provian/agent-keystore.json` only after the final
keystore and credentials are atomically written and file/directory-synced, and,
if the human issued a beneficiary invite when they generated the connection
token, binds that pending link onto the new wallet. A crash or lost response
leaves the encrypted pending file in place so rerunning resumes the same wallet.

## Back up (export) off-device

```bash
npx @provian/agent-sdk export-agent-keystore ./agent-keystore.backup.json
# or to external media:
npx @provian/agent-sdk export-agent-keystore /Volumes/usb/agent-keystore.json
```

The exported file is encrypted. **Back up your passphrase separately** (e.g. a
password manager). Never store it alongside the keystore. Without the
passphrase the backup is unrecoverable; that is the point.

## Recover from a backup

On a new device (or after losing the local keystore):

1. Copy the exported `agent-keystore.backup.json` onto the machine.
2. Import it with your passphrase. Import verifies the passphrase **and** that
   the decrypted key re-derives the stored address before installing it:

```bash
PROVIAN_KEYSTORE_PASSPHRASE='your strong passphrase' \
  node -e "require('@provian/agent-sdk').importKeystore('./agent-keystore.backup.json', process.env.PROVIAN_KEYSTORE_PASSPHRASE)"
```

This writes `~/.provian/agent-keystore.json` and the wallet is live again. A
wrong passphrase throws `WRONG_PASSPHRASE`; a corrupted or forged backup throws
`WRONG_PASSPHRASE` or `KEYSTORE_ADDRESS_MISMATCH` and nothing is installed.

## Programmatic API

```ts
import {
  loadOrCreatePendingAgentWalletRegistration, // encrypted before networking
  resumeAgentWalletRegistration,              // safe ambiguous-response retry
  persistAgentWalletKey, // final encrypted promotion after relay acknowledgement
  encryptKeystore,       // pure: key -> keystore document
  decryptKeystore,       // keystore + passphrase -> key (throws WRONG_PASSPHRASE)
  saveKeystore,          // write keystore to disk (0600)
  loadKeystore,          // read keystore from disk (null if absent)
  exportKeystore,        // copy encrypted keystore to a backup path
  importKeystore,        // recover from a backup (verifies passphrase + address)
  getDefaultKeystorePath,
} from '@provian/agent-sdk';
```

## Failure modes

| Situation | Result |
|-----------|--------|
| Wrong passphrase | `ProvianError` code `WRONG_PASSPHRASE` |
| Tampered ciphertext / header | `ProvianError` code `WRONG_PASSPHRASE` (GCM auth fails) |
| Backup header address swapped | `WRONG_PASSPHRASE` on import (the address is bound into the GCM tag; not installed) |
| Backup whose key does not derive the header's address | `KEYSTORE_ADDRESS_MISMATCH` on import (not installed) |
| Passphrase < 8 chars | `WEAK_PASSPHRASE` (refuses to encrypt) |
| Lost passphrase | Unrecoverable by design (there is no backdoor) |
| Machine lost/wiped with no escrow and no export | Wallet and funds unrecoverable. Always back up off-device first |
