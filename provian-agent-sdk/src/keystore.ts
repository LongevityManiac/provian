/**
 * Agent Keystore - encrypted-at-rest persistence for the agent wallet key.
 *
 * The agent wallet's secp256k1 private key controls real funds (USDC, PVT) and
 * is generated locally and non-custodially by prepared wallet registration -
 * the relay never sees it. The pending-registration boundary encrypts the key
 * before networking; this module provides the final hardened persistence layer:
 *
 *   - The key is encrypted at rest with AES-256-GCM.
 *   - The encryption key is derived from an operator passphrase via scrypt.
 *   - The serialized keystore is a self-contained, portable JSON document the
 *     operator can copy off-device for backup (`exportKeystore`).
 *   - Recovery from that export is `importKeystore` + the operator passphrase.
 *
 * Non-custodial discipline is preserved: this module only ever *encrypts a key
 * the agent already holds*. It never generates key material and never transmits
 * it. There is no cloud backup path - iCloud / Drive do not apply in Node; the
 * only backup is the operator copying the encrypted file somewhere safe.
 *
 * GCM binds the ciphertext to the keystore header (wallet_id / address /
 * public_key) via AAD, so a ciphertext cannot be transplanted into a forged
 * header and a tampered header fails authentication rather than decrypting to
 * the wrong key.
 *
 * Zero runtime dependencies - Node's built-in `crypto`.
 */
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { ProvianError } from './errors';
import { deriveAddressFromPrivateKey } from './wallet';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYSTORE_VERSION = 1 as const;
const KEYSTORE_TYPE = 'provian-agent-keystore' as const;
const CIPHER = 'aes-256-gcm' as const;
const KDF = 'scrypt' as const;

const PROVIAN_DIR = path.join(homedir(), '.provian');
const DEFAULT_KEYSTORE_PATH = path.join(PROVIAN_DIR, 'agent-keystore.json');

/** Minimum passphrase length. Below this we refuse to encrypt fund-bearing key material. */
const MIN_PASSPHRASE_LENGTH = 8;

/**
 * Default scrypt cost. N=2^17 (~134 MB working set) is deliberately expensive
 * to slow offline brute force against a stolen keystore file. Stored per-file
 * so future hardening can raise it without breaking old keystores.
 */
const DEFAULT_KDF_PARAMS = {
  N: 1 << 17,
  r: 8,
  p: 1,
  dklen: 32,
} as const;

/**
 * F34: hard bounds on FILE-supplied scrypt parameters, enforced in
 * validateKeystoreShape BEFORE any KDF runs. scrypt's working set is 128*N*r
 * bytes, so an unbounded N/r in a hostile or tampered keystore forces a
 * multi-GB allocation / OOM at decrypt time (before the GCM tag can reject the
 * file). The default (N=2^17) is already the intended ceiling.
 */
const MIN_KDF_N = 1 << 10; // 2^10 = 1024
const MAX_KDF_N = DEFAULT_KDF_PARAMS.N; // 2^17 (~134 MB at r=8)
const MAX_KDF_R = 16;
const MAX_KDF_P = 4;
const REQUIRED_DKLEN = 32;
const REQUIRED_SALT_HEX_LEN = 64; // 32 random bytes
/**
 * Fixed maxmem ceiling for scrypt, derived from the MAX allowed params (NEVER
 * the file), so scrypt's own OOM guard is a constant rather than attacker-sized.
 * Covers every in-bounds (N,r): 128*MAX_KDF_N*MAX_KDF_R ≤ this.
 */
const KDF_MAXMEM = 256 * MAX_KDF_N * MAX_KDF_R;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeystoreKdfParams {
  kdf: typeof KDF;
  N: number;
  r: number;
  p: number;
  dklen: number;
  /** hex-encoded random salt */
  salt: string;
}

export interface KeystoreCrypto {
  cipher: typeof CIPHER;
  /** hex-encoded ciphertext (the raw private key bytes) */
  ciphertext: string;
  /** hex-encoded 12-byte GCM nonce */
  iv: string;
  /** hex-encoded 16-byte GCM authentication tag */
  tag: string;
  kdfparams: KeystoreKdfParams;
}

export interface AgentKeystore {
  version: typeof KEYSTORE_VERSION;
  type: typeof KEYSTORE_TYPE;
  /** Provian wallet ID (wallet_aw_...) */
  wallet_id: string;
  /** EVM address derived from the encrypted key */
  address: string;
  /** Uncompressed secp256k1 public key (hex, no 04 prefix) - public, safe to store */
  public_key: string;
  /** ISO timestamp of keystore creation */
  created_at: string;
  crypto: KeystoreCrypto;
}

export interface EncryptKeystoreParams {
  /** Hex-encoded secp256k1 private key (64 hex chars, optional 0x prefix) */
  privateKey: string;
  /** EVM address that the private key derives to */
  address: string;
  /** Uncompressed public key hex (no 04 prefix) */
  publicKey: string;
  /** Provian wallet ID */
  walletId: string;
  /** Operator passphrase used to derive the encryption key */
  passphrase: string;
  /** ISO timestamp (defaults to now) */
  createdAt?: string;
  /** Override scrypt cost (tests use a low N for speed) */
  kdfParams?: { N?: number; r?: number; p?: number; dklen?: number };
}

export interface DecryptedKey {
  /** Hex-encoded secp256k1 private key (no 0x prefix) */
  privateKey: string;
  address: string;
  publicKey: string;
  walletId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePrivateKey(privateKeyHex: string): string {
  const clean = privateKeyHex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== 64 || !/^[0-9a-f]+$/.test(clean)) {
    throw new ProvianError(
      'privateKey must be 32 bytes (64 hex chars)',
      'INVALID_KEY',
    );
  }
  return clean;
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ProvianError(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      'WEAK_PASSPHRASE',
    );
  }
}

/**
 * scrypt requires maxmem >= 128 * N * r. The Node default (32 MB) is too small
 * for N=2^17. maxmem is a FIXED ceiling derived from the max allowed params
 * (F34) — never sized from the file — so it caps allocation instead of enabling
 * an attacker-chosen one. Callers reach this only after validateKeystoreShape
 * has bounded N/r/p/dklen/salt, so the (N,r) here is always in range.
 */
function deriveEncryptionKey(passphrase: string, params: KeystoreKdfParams): Buffer {
  return scryptSync(
    Buffer.from(passphrase, 'utf8'),
    Buffer.from(params.salt, 'hex'),
    params.dklen,
    { N: params.N, r: params.r, p: params.p, maxmem: KDF_MAXMEM },
  );
}

/**
 * Additional authenticated data binding the ciphertext to the keystore header.
 * Recomputed from header fields at decrypt time so that tampering with
 * wallet_id / address / public_key invalidates the GCM tag instead of silently
 * decrypting a transplanted ciphertext.
 */
function computeAad(header: {
  version: number;
  type: string;
  wallet_id: string;
  address: string;
  public_key: string;
}): Buffer {
  const canonical = JSON.stringify([
    header.version,
    header.type,
    header.wallet_id,
    header.address.toLowerCase(),
    header.public_key.toLowerCase(),
  ]);
  return Buffer.from(canonical, 'utf8');
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt an agent private key into a portable keystore document.
 * Pure - performs no filesystem I/O. Pair with `saveKeystore` to persist.
 */
export function encryptKeystore(params: EncryptKeystoreParams): AgentKeystore {
  assertPassphrase(params.passphrase);
  const privateKeyHex = normalizePrivateKey(params.privateKey);
  let publicKey = params.publicKey.toLowerCase().replace(/^0x/, '');
  if (publicKey.length === 130 && publicKey.startsWith('04')) publicKey = publicKey.slice(2);

  const kdfparams: KeystoreKdfParams = {
    kdf: KDF,
    N: params.kdfParams?.N ?? DEFAULT_KDF_PARAMS.N,
    r: params.kdfParams?.r ?? DEFAULT_KDF_PARAMS.r,
    p: params.kdfParams?.p ?? DEFAULT_KDF_PARAMS.p,
    dklen: params.kdfParams?.dklen ?? DEFAULT_KDF_PARAMS.dklen,
    salt: randomBytes(32).toString('hex'),
  };
  // Never mint a keystore whose params fall outside the bounds we will enforce
  // at decrypt time (F34) — fail closed on an out-of-range caller override.
  assertKdfParamsInBounds(kdfparams);

  const encryptionKey = deriveEncryptionKey(params.passphrase, kdfparams);
  const iv = randomBytes(12); // 96-bit GCM nonce

  const header = {
    version: KEYSTORE_VERSION,
    type: KEYSTORE_TYPE,
    wallet_id: params.walletId,
    address: params.address,
    public_key: publicKey,
  };
  const aad = computeAad(header);

  const cipher = createCipheriv(CIPHER, encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKeyHex, 'hex')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: KEYSTORE_VERSION,
    type: KEYSTORE_TYPE,
    wallet_id: params.walletId,
    address: params.address,
    public_key: publicKey,
    created_at: params.createdAt ?? new Date().toISOString(),
    crypto: {
      cipher: CIPHER,
      ciphertext: ciphertext.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      kdfparams,
    },
  };
}

/**
 * Decrypt a keystore back to the private key. Throws `WRONG_PASSPHRASE` when
 * the passphrase is incorrect or the file has been tampered with (both surface
 * as a failed GCM tag check - indistinguishable by design).
 */
export function decryptKeystore(keystore: AgentKeystore, passphrase: string): DecryptedKey {
  validateKeystoreShape(keystore);
  assertPassphrase(passphrase);

  const { crypto: c } = keystore;
  const encryptionKey = deriveEncryptionKey(passphrase, c.kdfparams);
  const aad = computeAad(keystore);

  const decipher = createDecipheriv(CIPHER, encryptionKey, Buffer.from(c.iv, 'hex'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(c.tag, 'hex'));

  let privateKeyBytes: Buffer;
  try {
    privateKeyBytes = Buffer.concat([
      decipher.update(Buffer.from(c.ciphertext, 'hex')),
      decipher.final(),
    ]);
  } catch {
    // GCM authentication failure - wrong passphrase or tampered keystore.
    throw new ProvianError(
      'Failed to decrypt keystore: wrong passphrase or corrupted file',
      'WRONG_PASSPHRASE',
    );
  }

  return {
    privateKey: privateKeyBytes.toString('hex'),
    address: keystore.address,
    publicKey: keystore.public_key,
    walletId: keystore.wallet_id,
  };
}

/**
 * Decrypt the keystore, run `fn` with the key, then drop our reference to it.
 *
 * This is the recommended way to feed the sovereign key into a signer
 * (e.g. evm-signer.ts): the decrypted private key is confined to the lifetime
 * of `fn` and is not retained by this helper afterward. Pass the key straight
 * into the per-call signer and do not stash it elsewhere.
 *
 * Caveat (be honest): JS strings are immutable and GC-managed, so the key
 * bytes cannot be zeroed in place. The `finally` clears our property reference
 * so the helper does not hold the key past the callback, but a copy `fn` made
 * (or the original string still reachable by the GC) is the caller's
 * responsibility. Never log, serialize, or return the key out of `fn`.
 */
export async function withDecryptedKey<T>(
  keystore: AgentKeystore,
  passphrase: string,
  fn: (key: DecryptedKey) => Promise<T> | T,
): Promise<T> {
  const key = decryptKeystore(keystore, passphrase);
  try {
    return await fn(key);
  } finally {
    // Drop our reference so the key is not retained beyond the callback.
    key.privateKey = '';
  }
}

/**
 * F34: bound the scrypt parameters BEFORE any KDF runs. N must be a power of two
 * in [MIN_KDF_N, MAX_KDF_N]; r/p small positive; dklen exactly 32; salt exactly
 * 32 random bytes (64 hex). A hostile keystore with N=2^27 can no longer force a
 * 137 GB working set — it is rejected here, before deriveEncryptionKey.
 */
function assertKdfParamsInBounds(kp: KeystoreKdfParams | undefined): void {
  const isBoundedPow2 = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= MIN_KDF_N && n <= MAX_KDF_N && (n & (n - 1)) === 0;
  if (
    !kp
    || !isBoundedPow2(kp.N)
    || typeof kp.r !== 'number' || !Number.isInteger(kp.r) || kp.r < 1 || kp.r > MAX_KDF_R
    || typeof kp.p !== 'number' || !Number.isInteger(kp.p) || kp.p < 1 || kp.p > MAX_KDF_P
    || kp.dklen !== REQUIRED_DKLEN
    || typeof kp.salt !== 'string' || !new RegExp(`^[0-9a-fA-F]{${REQUIRED_SALT_HEX_LEN}}$`).test(kp.salt)
  ) {
    throw new ProvianError('Keystore KDF parameters are out of the allowed bounds', 'INVALID_KEYSTORE');
  }
}

function validateKeystoreShape(keystore: AgentKeystore): void {
  if (
    !keystore
    || keystore.version !== KEYSTORE_VERSION
    || keystore.type !== KEYSTORE_TYPE
    || !keystore.crypto
    || keystore.crypto.cipher !== CIPHER
    || keystore.crypto.kdfparams?.kdf !== KDF
    || typeof keystore.crypto.ciphertext !== 'string'
    || typeof keystore.crypto.iv !== 'string'
    || typeof keystore.crypto.tag !== 'string'
  ) {
    throw new ProvianError('Unrecognized or malformed keystore', 'INVALID_KEYSTORE');
  }
  // Bound the KDF cost parameters before any caller can reach deriveEncryptionKey.
  assertKdfParamsInBounds(keystore.crypto.kdfparams);
}

// ---------------------------------------------------------------------------
// Filesystem persistence
// ---------------------------------------------------------------------------

export function getDefaultKeystorePath(): string {
  return DEFAULT_KEYSTORE_PATH;
}

function ensureProvianDir(): void {
  if (!fs.existsSync(PROVIAN_DIR)) {
    fs.mkdirSync(PROVIAN_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Atomically persist a keystore with 0600 permissions, fsyncing both file and
 * directory before success so the pending-registration record can be cleared
 * without a crash window that loses or truncates the final key. */
export function saveKeystore(keystore: AgentKeystore, filePath: string = DEFAULT_KEYSTORE_PATH): string {
  validateKeystoreShape(keystore);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(keystore, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, 0o600);
    const installedFd = fs.openSync(filePath, 'r');
    try {
      const installed = fs.fstatSync(installedFd);
      if (!installed.isFile()
        || (process.platform !== 'win32' && (installed.mode & 0o777) !== 0o600)) {
        throw new ProvianError('Installed keystore is not a 0600 regular file', 'INVALID_KEYSTORE_PERMISSIONS');
      }
      fs.fsyncSync(installedFd);
    } finally { fs.closeSync(installedFd); }
    const directoryFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* renamed or already removed */ }
    throw error;
  }
  return filePath;
}

/** Load a keystore from disk. Returns null if the file does not exist. */
export function loadKeystore(filePath: string = DEFAULT_KEYSTORE_PATH): AgentKeystore | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: AgentKeystore;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AgentKeystore;
  } catch {
    throw new ProvianError(`Keystore at ${filePath} is not valid JSON`, 'INVALID_KEYSTORE');
  }
  validateKeystoreShape(parsed);
  return parsed;
}

/**
 * Export the encrypted keystore to an off-device backup location.
 *
 * The keystore is already encrypted, so the exported file is safe to store on
 * external media / a password manager / a separate host. The operator still
 * needs the passphrase to recover from it. Returns the destination path.
 */
export function exportKeystore(destPath: string, filePath: string = DEFAULT_KEYSTORE_PATH): string {
  const keystore = loadKeystore(filePath);
  if (!keystore) {
    throw new ProvianError(`No keystore found at ${filePath} to export`, 'KEYSTORE_NOT_FOUND');
  }
  const dir = path.dirname(destPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(destPath, JSON.stringify(keystore, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(destPath, 0o600);
  return destPath;
}

/**
 * Recover from an exported keystore. Accepts a file path, a JSON string, or a
 * parsed keystore object. Verifies the passphrase decrypts the key AND that the
 * decrypted key re-derives the stored address before installing it as the
 * active local keystore - a wrong passphrase or a corrupted/forged export is
 * rejected rather than silently installed.
 *
 * This is the documented recovery path: copy the exported file back, run
 * import with the passphrase, and the agent wallet is live again.
 */
export function importKeystore(
  source: string | AgentKeystore,
  passphrase: string,
  destFilePath: string = DEFAULT_KEYSTORE_PATH,
): AgentKeystore {
  let keystore: AgentKeystore;
  if (typeof source === 'string') {
    if (fs.existsSync(source)) {
      keystore = loadKeystore(source) as AgentKeystore;
    } else {
      try {
        keystore = JSON.parse(source) as AgentKeystore;
      } catch {
        throw new ProvianError(
          'importKeystore source is neither an existing file path nor valid keystore JSON',
          'INVALID_KEYSTORE',
        );
      }
    }
  } else {
    keystore = source;
  }
  validateKeystoreShape(keystore);

  // Proves the passphrase is correct (GCM tag) before we trust the file.
  const decrypted = decryptKeystore(keystore, passphrase);

  // Integrity: the decrypted key must reproduce the stored address. Guards
  // against a header whose address was swapped to point at attacker funds.
  const derived = deriveAddressFromPrivateKey(decrypted.privateKey);
  if (derived.toLowerCase() !== keystore.address.toLowerCase()) {
    throw new ProvianError(
      `Keystore integrity check failed: decrypted key derives ${derived}, header claims ${keystore.address}`,
      'KEYSTORE_ADDRESS_MISMATCH',
    );
  }

  saveKeystore(keystore, destFilePath);
  return keystore;
}

// ---------------------------------------------------------------------------
// Convenience: end-to-end persist after wallet creation
// ---------------------------------------------------------------------------

export interface PersistAgentWalletParams {
  privateKey: string;
  address: string;
  publicKey: string;
  walletId: string;
  passphrase: string;
  createdAt?: string;
  filePath?: string;
  kdfParams?: EncryptKeystoreParams['kdfParams'];
}

/**
 * Encrypt and persist a freshly created agent wallet's key in one call.
 * Returns the keystore and the path written. The caller should then drop the
 * plaintext private key from memory.
 */
export function persistAgentWalletKey(
  params: PersistAgentWalletParams,
): { keystore: AgentKeystore; path: string } {
  const keystore = encryptKeystore({
    privateKey: params.privateKey,
    address: params.address,
    publicKey: params.publicKey,
    walletId: params.walletId,
    passphrase: params.passphrase,
    createdAt: params.createdAt,
    kdfParams: params.kdfParams,
  });
  const writtenPath = saveKeystore(keystore, params.filePath ?? DEFAULT_KEYSTORE_PATH);
  return { keystore, path: writtenPath };
}
