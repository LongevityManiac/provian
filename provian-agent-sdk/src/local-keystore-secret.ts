/**
 * local-keystore-secret — the no-passphrase at-rest secret for the two-touch
 * onboarding.
 *
 * The unattended bootstrap creates a fund-bearing agent wallet with NO operator
 * passphrase (the human never types or sees one). The keystore still must be
 * encrypted at rest, so it is encrypted under a random 32-byte secret generated
 * here and stored 0600 beside it — the same OS-file-perms posture as
 * ~/.provian/credentials. This is at-rest protection, NOT the recovery path.
 *
 * Recovery is the non-custodial escrow sealed to the inviting human's phone
 * anchor (agent-key-recovery.ts). If this machine is lost, the human recovers
 * through their Provian app; this file is not a backup and losing it with the
 * machine is expected — that is exactly why the escrow exists.
 *
 * Idempotent: a re-run reuses the existing secret so the keystore stays
 * decryptable across bootstrap retries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const PROVIAN_DIR = path.join(homedir(), '.provian');
export const LOCAL_KEYSTORE_SECRET_PATH = path.join(PROVIAN_DIR, 'agent-keystore.secret');

/** 64 lowercase hex chars = 32 random bytes; comfortably above the keystore's 8-char floor. */
const SECRET_SHAPE = /^[a-f0-9]{64}$/;

/** Read the local keystore secret, or null if absent/malformed. Never throws. */
export function readLocalKeystoreSecret(secretPath: string = LOCAL_KEYSTORE_SECRET_PATH): string | null {
  try {
    const raw = fs.readFileSync(secretPath, 'utf8').trim();
    return SECRET_SHAPE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The secret file exists but does not read as a secret (malformed, unreadable, not a regular file).
 * It is never replaced: the keystore and any pending registration are encrypted under its bytes.
 */
export class LocalKeystoreSecretUnreadableError extends Error {
  constructor(readonly secretPath: string) {
    super(`The agent keystore at-rest secret at ${secretPath} exists but is not readable as a secret. It has been left untouched (the keystore is encrypted under it); restore it from a copy or recover the agent from the Provian app.`);
    this.name = 'LocalKeystoreSecretUnreadableError';
  }
}

/**
 * Return the existing local keystore secret, or generate + persist one (0600).
 * The write goes through a temp file + rename so a crash never leaves a partial
 * secret that would orphan the keystore. A secret is generated ONLY when no file
 * exists: an existing file that does not parse is an error, and is preserved
 * (fix run 2026-10-24).
 */
export function loadOrCreateLocalKeystoreSecret(
  secretPath: string = LOCAL_KEYSTORE_SECRET_PATH,
): string {
  const existing = readLocalKeystoreSecret(secretPath);
  if (existing) return existing;
  try {
    fs.lstatSync(secretPath);
    throw new LocalKeystoreSecretUnreadableError(secretPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err instanceof LocalKeystoreSecretUnreadableError ? err : new LocalKeystoreSecretUnreadableError(secretPath);
    }
  }

  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const tmp = `${secretPath}.tmp`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  fs.renameSync(tmp, secretPath);
  // rename can preserve the umask-affected mode on some platforms; force 0600.
  try { fs.chmodSync(secretPath, 0o600); } catch { /* best effort on non-POSIX FS */ }
  return secret;
}
