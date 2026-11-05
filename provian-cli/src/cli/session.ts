/**
 * CLI Session File Management
 *
 * Persists connection state across CLI invocations.
 * Session file lives at ~/.provian/session.json.
 *
 * The file holds a live relay session token and is treated as a secret.
 * The directory is created with mode 0700 and the file with mode 0600.
 * If the directory already exists with mode more permissive than 0755 the
 * write fails loudly rather than silently widening or narrowing the
 * caller's existing permissions.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const SESSION_DIR = join(homedir(), '.provian');
const SESSION_FILE = join(SESSION_DIR, 'session.json');
/**
 * Pre-unification filename. Older @provian/cli and @provian/agent-sdk builds
 * wrote ~/.provian/session (no extension, snake_case). readSession() migrates
 * it forward once so an upgrade never orphans an existing session.
 */
const LEGACY_SESSION_FILE = join(SESSION_DIR, 'session');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DIR_MODE_MAX = 0o755;

/**
 * The single Provian config directory (~/.provian). All CLI state — the
 * secret session token and the non-secret agent pointer — lives here.
 */
export const PROVIAN_DIR = SESSION_DIR;
export const PROVIAN_FILE_MODE = FILE_MODE;

/**
 * Ensure ~/.provian exists with a private mode, failing loudly if it is more
 * permissive than 0755. Shared with agent-config so the directory permission
 * discipline lives in one place.
 */
export function ensureProvianDir(): void {
  ensureSessionDir();
}

export interface SessionData {
  /** RETIRED : the relay session is gone; tolerated on older files. */
  sessionId?: string;
  relayUrl: string;
  agentId: string;
  serverAgentId: string;
  userId: string;
  connectedAt: string;
  /** Present once an agent wallet is bound (set by the SDK create-agent-wallet). */
  agentWalletId?: string;
}

export function readSession(): SessionData | null {
  if (existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
    } catch {
      return null;
    }
  }
  // One-time migration: an older CLI/SDK build wrote ~/.provian/session (no
  // extension, snake_case). Convert it to the canonical shape, persist forward
  // to session.json, and remove the legacy file so this runs at most once and
  // a session created by an older @provian/agent-sdk is not silently orphaned.
  const migrated = readLegacySession();
  if (migrated) {
    // Remove the legacy file ONLY after the forward write has demonstrably
    // succeeded. If writeSession() throws (e.g. ensureSessionDir refuses a
    // too-permissive ~/.provian) we must keep the legacy file as the fallback,
    // otherwise we'd delete it without ever persisting session.json and orphan
    // the session on the next run. We still return the in-memory value so the
    // current invocation works; a later run retries the migration.
    let wrote = false;
    try { writeSession(migrated); wrote = true; } catch { /* keep legacy file as the fallback */ }
    if (wrote) {
      try { if (existsSync(LEGACY_SESSION_FILE)) unlinkSync(LEGACY_SESSION_FILE); } catch { /* best effort */ }
    }
    return migrated;
  }
  return null;
}

/**
 * Read and normalize the legacy ~/.provian/session file. Handles the SDK's
 * snake_case shape (and an epoch-ms connected_at), and is defensive about a
 * file that already happens to be camelCase. Returns null if absent/invalid.
 */
function readLegacySession(): SessionData | null {
  if (!existsSync(LEGACY_SESSION_FILE)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(LEGACY_SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
  const sessionId = (raw.session_id ?? raw.sessionId) as string | undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

  const agentId = (raw.agent_id ?? raw.agentId) as string | undefined;
  const connectedRaw = raw.connected_at ?? raw.connectedAt;
  let connectedAt: string;
  if (typeof connectedRaw === 'number') connectedAt = new Date(connectedRaw).toISOString();
  else if (typeof connectedRaw === 'string' && connectedRaw.length > 0) connectedAt = connectedRaw;
  else connectedAt = new Date().toISOString();

  const walletId = (raw.agent_wallet_id ?? raw.agentWalletId) as string | undefined;
  return {
    sessionId,
    relayUrl: ((raw.relay_url ?? raw.relayUrl) as string) || 'https://api.provian.ai',
    agentId: agentId || 'provian-agent',
    serverAgentId: ((raw.server_agent_id ?? raw.serverAgentId) as string) || agentId || sessionId,
    userId: ((raw.user_id ?? raw.userId) as string) || '',
    connectedAt,
    ...(walletId ? { agentWalletId: walletId } : {}),
  };
}

export function writeSession(data: SessionData): void {
  ensureSessionDir();
  // Mode in writeFileSync only applies on file creation. Chmod afterwards
  // to handle the overwrite case where an existing file may have looser
  // permissions from a pre-fix install.
  writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: FILE_MODE });
  if (platform() !== 'win32') {
    chmodSync(SESSION_FILE, FILE_MODE);
  }
}

export function deleteSession(): void {
  // Remove both the canonical file and any legacy file so disconnect can't be
  // silently undone by the migration path resurrecting a stale legacy session.
  // Per-file best-effort: a failure removing one (e.g. transient EPERM on
  // session.json) must not skip the other, which would leave the legacy file
  // behind for the next read to migrate back in.
  for (const f of [SESSION_FILE, LEGACY_SESSION_FILE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}

function ensureSessionDir(): void {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true, mode: DIR_MODE });
    return;
  }
  // Directory exists. If it is too permissive on POSIX, fail loudly rather
  // than silently chmod the user's existing directory (could be shared with
  // other Provian tooling that the user configured intentionally).
  if (platform() === 'win32') return;
  const mode = statSync(SESSION_DIR).mode & 0o777;
  if (mode & ~DIR_MODE_MAX) {
    throw new Error(
      `Refusing to write session into ${SESSION_DIR}: directory mode ${mode.toString(8)} is more permissive than ${DIR_MODE_MAX.toString(8)}. ` +
      `Run: chmod ${DIR_MODE.toString(8)} ${SESSION_DIR}`,
    );
  }
}
