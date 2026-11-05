/**
 * ~/.provian/session.json — the agent's local identity locator.
 *
 * the relay agent-session channel is gone, so `sessionId` is a retired
 * field (tolerated when present in an older file, never written by new code).
 * The file survives as the ONE place the SDK scripts and `@provian/cli` agree on
 * for the agent's relay URL, agent id, and — once created — its wallet id
 * (`agentWalletId`, written by `create-agent-wallet` / the bootstrap).
 *
 * Canonical: `~/.provian/session.json`, camelCase keys, mode 0600 in a 0700
 * directory. An older SDK build wrote `~/.provian/session` (no extension,
 * snake_case keys, epoch-ms timestamp); `readSessionFile()` migrates that
 * legacy file forward on first read so existing sessions are not orphaned.
 *
 * NOTE: this is DISTINCT from `~/.provian/credentials` (device key/secret,
 * managed by `scripts/credentials.ts` and consumed by report-pe / the
 * observer). Do not conflate the two.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, join } from 'path';
import { atomicReplacePrivateFile } from './durable-private-file';

const DEFAULT_RELAY_URL = 'https://api.provian.ai';

const PROVIAN_DIR = join(homedir(), '.provian');
const SESSION_FILE = join(PROVIAN_DIR, 'session.json');
/** Pre-unification filename written by older SDK builds. */
const LEGACY_SESSION_FILE = join(PROVIAN_DIR, 'session');

const DIR_MODE = 0o700;
const DIR_MODE_MAX = 0o755;

/**
 * Canonical relay-session record. Mirrors the `@provian/cli` SessionData shape
 * exactly so the two tools interoperate over one file.
 */
export interface AgentSessionFile {
  /** RETIRED : tolerated on older files, never written by new code. */
  sessionId?: string;
  relayUrl: string;
  /** Local agent name. */
  agentId: string;
  /** Relay-assigned agent id (relay connect response `agent_id`). */
  serverAgentId: string;
  userId: string;
  /** ISO-8601 timestamp. */
  connectedAt: string;
  /** Present once an agent wallet is bound (set by `create-agent-wallet`). */
  agentWalletId?: string;
}

/** Shape written by pre-unification SDK builds (~/.provian/session). */
interface LegacySessionFile {
  session_id?: string;
  agent_id?: string;
  user_id?: string;
  agent_wallet_id?: string;
  relay_url?: string;
  connected_at?: number | string;
}

function ensurePrivateSessionDir(sessionFile: string): void {
  const directory = dirname(sessionFile);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    return;
  }
  // Fail loudly rather than silently widening/narrowing a directory the user
  // may share with other Provian tooling. Matches the CLI's discipline.
  if (platform() === 'win32') return;
  const mode = statSync(directory).mode & 0o777;
  if (mode & ~DIR_MODE_MAX) {
    throw new Error(
      `Refusing to write session into ${directory}: directory mode ${mode.toString(8)} is more permissive than ${DIR_MODE_MAX.toString(8)}. ` +
      `Run: chmod ${DIR_MODE.toString(8)} ${directory}`,
    );
  }
}

export function writeSessionFile(data: AgentSessionFile): void {
  writeSessionFileAtPath(data, SESSION_FILE);
}

/** Internal/testable path form used by the agent-wallet promotion kernel. */
export function writeSessionFileAtPath(data: AgentSessionFile, sessionFile: string): void {
  ensurePrivateSessionDir(sessionFile);
  atomicReplacePrivateFile(sessionFile, `${JSON.stringify(data, null, 2)}\n`);
}

function fromLegacy(raw: LegacySessionFile): AgentSessionFile | null {
  if (!raw || typeof raw.session_id !== 'string' || raw.session_id.length === 0) {
    return null;
  }
  let connectedAt: string;
  if (typeof raw.connected_at === 'number') {
    connectedAt = new Date(raw.connected_at).toISOString();
  } else if (typeof raw.connected_at === 'string' && raw.connected_at.length > 0) {
    connectedAt = raw.connected_at;
  } else {
    connectedAt = new Date().toISOString();
  }
  return {
    sessionId: raw.session_id,
    relayUrl: raw.relay_url || DEFAULT_RELAY_URL,
    agentId: raw.agent_id || 'provian-agent',
    serverAgentId: raw.agent_id || raw.session_id,
    userId: raw.user_id || '',
    connectedAt,
    ...(raw.agent_wallet_id ? { agentWalletId: raw.agent_wallet_id } : {}),
  };
}

export function readSessionFile(): AgentSessionFile | null {
  if (existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as AgentSessionFile;
    } catch {
      return null;
    }
  }
  // One-time migration from the pre-unification ~/.provian/session (snake_case,
  // no extension). Convert, persist forward to session.json, remove the legacy
  // file so this path runs at most once.
  if (existsSync(LEGACY_SESSION_FILE)) {
    let migrated: AgentSessionFile | null = null;
    try {
      migrated = fromLegacy(JSON.parse(readFileSync(LEGACY_SESSION_FILE, 'utf-8')) as LegacySessionFile);
    } catch {
      migrated = null;
    }
    if (migrated) {
      // Remove the legacy file ONLY after the forward write succeeds. If
      // writeSessionFile() throws (e.g. ensureProvianDir refuses a too-
      // permissive ~/.provian) we keep the legacy file as the fallback rather
      // than deleting it without persisting session.json and orphaning the
      // session. The in-memory value is still returned for the current run.
      let wrote = false;
      try { writeSessionFile(migrated); wrote = true; } catch { /* keep legacy file as the fallback */ }
      if (wrote) {
        try { unlinkSync(LEGACY_SESSION_FILE); } catch { /* best effort */ }
      }
      return migrated;
    }
  }
  return null;
}

export function deleteSessionFile(): void {
  for (const f of [SESSION_FILE, LEGACY_SESSION_FILE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}
