/**
 * GitHub App connect flow - pure data layer + finalize logic.
 *
 * Step 4c of the GitHub App connector. Backs the user-initiated install
 * flow: the CLI (or mobile wallet) starts a pending-connect session,
 * sends the user to GitHub's install page, and polls until the relay
 * has recorded the install. The user authorizes ON github.com - Provian
 * never sees a GitHub credential and never holds a token capable of
 * reading the user's account.
 *
 * **Why a pending-connect collection exists.** GitHub App "Setup URL"
 * is configured once per app on GitHub's side; it can't be a per-CLI-
 * invocation localhost address. The relay therefore has to mediate:
 *
 *   1. CLI generates a 32-byte hex state nonce.
 *   2. CLI calls /connect/start (DeviceKey auth) → relay records
 *      pending { state, user_id, expires_at }, returns the install URL
 *      with state in the query string.
 *   3. CLI opens browser → user installs on github.com.
 *   4. GitHub redirects to the relay's static setup-callback with
 *      `installation_id`, `state`, and `setup_action`.
 *   5. setup-callback (no auth - GitHub can't auth to us) looks up
 *      pending by state, marks it completed.
 *   6. CLI polls /connect/poll (DeviceKey auth) → relay validates
 *      state's user_id matches the authenticated user, calls
 *      createServiceInstall + emits the `service_install_created` PE
 *      ON FIRST POLL after completion; subsequent polls return the
 *      cached result idempotently.
 *
 * **Threat model for the state nonce.** Anyone who can intercept state
 * AND drive a fake setup-callback to the relay can attach an arbitrary
 * installation_id to the legitimate user's session. Mitigations:
 *   - 32 bytes (256 bits) of entropy makes guessing intractable.
 *   - 5-minute TTL bounds the window for replay.
 *   - The TTL doc is keyed by state so an exhausted state can't be
 *     reused.
 *   - Confirmation is still the user-side action - they had to click
 *     "Install" on github.com for any installation_id to exist at all.
 * The residual risk is "attacker who steals state in transit", which
 * requires either MITM of the CLI's initial POST or compromise of the
 * user's session. Same risk class as OAuth state-parameter handling
 * elsewhere; an explicit confirmation step is a future hardening.
 */

import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { createServiceInstall, ServiceInstallOwnedByOtherUserError } from './service-installs';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** TTL for a pending connect session. Generous; covers slow installs. */
export const CONNECT_TTL_MS = 5 * 60 * 1000;
/** State nonce length in hex chars (32 bytes → 64 hex). */
export const STATE_HEX_LENGTH = 64;

const PENDING_COLLECTION = 'github_connect_pending';
const STATE_RE = /^[0-9a-f]{64}$/;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface PendingConnectDocument {
  state: string;
  user_id: string;
  status: 'pending' | 'completed';
  installation_id: string | null;
  created_at: number;
  expires_at: number;
  /** Set when the poll handler first creates the install + emits PE; subsequent polls are idempotent on this. */
  recorded_install_id?: string;
  /** PE id emitted for the install creation; idempotent partner of recorded_install_id. */
  recorded_pe_id?: string;
}

export type PollStatus = 'pending' | 'completed' | 'expired' | 'conflict';

export interface PollResult {
  status: PollStatus;
  install_id?: string;
  pe_id?: string;
  /** `conflict` only: the installation is ACTIVE under another wallet (2026-10-17 hijack guard). */
  reason?: 'installation_already_linked';
}

/** GitHub installation ids are decimal integers; anything else never reaches a Firestore id. */
const INSTALLATION_ID_RE = /^[0-9]{1,20}$/;

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

/**
 * Verify a state nonce is well-formed (64 lowercase hex chars). All
 * handlers MUST validate state with this before any DB lookup -
 * otherwise an attacker could inject a Firestore doc id with control
 * characters.
 */
export function isValidState(value: unknown): value is string {
  return typeof value === 'string' && STATE_RE.test(value);
}

/**
 * Build the GitHub install URL with the state nonce attached. The slug
 * is validated upstream in github-app-config.ts; we still
 * encodeURIComponent both pieces as defense in depth.
 */
export function buildInstallUrl(slug: string, state: string): string {
  const safeSlug = encodeURIComponent(slug);
  const safeState = encodeURIComponent(state);
  return `https://github.com/apps/${safeSlug}/installations/new?state=${safeState}`;
}

// -----------------------------------------------------------------------------
// Pending CRUD
// -----------------------------------------------------------------------------

/**
 * Start a new pending connect session. Idempotent on (state) - calling
 * with the same state from the same user resets the TTL but keeps the
 * record; calling with the same state from a different user is
 * rejected (returns null) so a stolen state can't be hijacked.
 */
export async function startPendingConnect(
  deps: { db: AgentBankDeps['db'] },
  state: string,
  userId: string,
): Promise<PendingConnectDocument | null> {
  if (!isValidState(state)) throw new Error('startPendingConnect: invalid state');
  if (!userId) throw new Error('startPendingConnect: user_id is required');

  const ref = deps.db.collection(PENDING_COLLECTION).doc(state);
  return await deps.db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = snap.data() as PendingConnectDocument;
      if (existing.user_id !== userId) {
        // State collision across users - refuse rather than overwrite.
        return null;
      }
    }
    const now = Date.now();
    const doc: PendingConnectDocument = {
      state,
      user_id: userId,
      status: 'pending',
      installation_id: null,
      created_at: now,
      expires_at: now + CONNECT_TTL_MS,
    };
    tx.set(ref, doc);
    return doc;
  });
}

/**
 * Mark a pending connect session as completed with the GitHub-supplied
 * installation_id. Called from the no-auth setup-callback path -
 * GitHub's redirect carries (installation_id, state) but no auth.
 *
 * Returns true if a matching pending session was updated, false if
 * the state is unknown or expired. The handler must return a generic
 * HTML response either way (no information leak about whether the
 * state existed).
 *
 * Transactional + status-aware: an already-completed session is not
 * overwritten (prevents an attacker from changing installation_id
 * after the legitimate completion).
 */
export async function markPendingCompleted(
  deps: { db: AgentBankDeps['db'] },
  state: string,
  installationId: string,
): Promise<boolean> {
  if (!isValidState(state)) return false;
  if (!installationId || !INSTALLATION_ID_RE.test(installationId)) return false;

  const ref = deps.db.collection(PENDING_COLLECTION).doc(state);
  return await deps.db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const existing = snap.data() as PendingConnectDocument;
    if (existing.status === 'completed') return false; // already set; refuse overwrite
    if (Date.now() > existing.expires_at) return false; // expired
    tx.update(ref, {
      status: 'completed',
      installation_id: installationId,
    });
    return true;
  });
}

/**
 * Poll handler. Called from /connect/poll with DeviceKey auth.
 *
 * Security: the authenticated user's id is the SOURCE OF TRUTH for
 * "who owns this session" - if pending.user_id doesn't match
 * authUserId, we return `'expired'` (not `'forbidden'`) so an attacker
 * scraping for valid states learns nothing about whether a given state
 * exists for a different user.
 *
 * On first poll after completion, creates the service_installs row and
 * emits the `service_install_created` PE. Subsequent polls return the
 * cached result. Idempotent.
 */
export async function pollAndFinalize(
  deps: AgentBankDeps,
  state: string,
  authUserId: string,
): Promise<PollResult> {
  if (!isValidState(state)) return { status: 'expired' };
  if (!authUserId) return { status: 'expired' };

  const ref = deps.db.collection(PENDING_COLLECTION).doc(state);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'expired' };
  const pending = snap.data() as PendingConnectDocument;

  // Wrong-user → same observable as expired (don't leak existence)
  if (pending.user_id !== authUserId) return { status: 'expired' };
  // True expiry
  if (Date.now() > pending.expires_at && pending.status !== 'completed') {
    return { status: 'expired' };
  }
  // Still waiting on GitHub
  if (pending.status !== 'completed') return { status: 'pending' };

  // Idempotent - already recorded on a prior poll
  if (pending.recorded_install_id && pending.recorded_pe_id) {
    return {
      status: 'completed',
      install_id: pending.recorded_install_id,
      pe_id: pending.recorded_pe_id,
    };
  }

  // Completed but not yet recorded - do it now.
  if (!pending.installation_id) return { status: 'expired' }; // shouldn't happen

  try {
    await createServiceInstall(deps.db, {
      user_id: authUserId,
      provider: 'github',
      installation_id: pending.installation_id,
    });
  } catch (err) {
    // 2026-10-17 hijack guard: the installation is ACTIVE under another wallet.
    // Nothing was written; no PE is emitted; the poller is told why.
    if (err instanceof ServiceInstallOwnedByOtherUserError) {
      return { status: 'conflict', reason: 'installation_already_linked' };
    }
    throw err;
  }

  const { peId } = await generatePE(deps, {
    walletId: authUserId,
    agentId: authUserId,
    actorAddress: '',
    actionType: 'service_install_created',
    metadata: {
      provider: 'github',
      installation_id: pending.installation_id,
      connect_state: state,
    },
  });

  // Cache the result on the pending doc so subsequent polls are idempotent.
  // Best-effort - if the write fails, the next poll re-creates (which
  // hits createServiceInstall's idempotent path) and re-emits a PE.
  await ref.update({
    recorded_install_id: pending.installation_id,
    recorded_pe_id: peId,
  });

  return {
    status: 'completed',
    install_id: pending.installation_id,
    pe_id: peId,
  };
}

// -----------------------------------------------------------------------------
// Revoke (disconnect)
// -----------------------------------------------------------------------------

/**
 * Emit a `service_install_revoked` PE for a user-initiated disconnect.
 * The actual install row is mutated by markServiceInstallRevoked
 * (from service-installs.ts) - this only emits the audit-trail PE.
 *
 * Best-effort: PE emission is fire-and-forget; the route returns
 * success on the install update regardless of whether the PE write
 * landed.
 */
export async function emitServiceInstallRevokedPE(
  deps: AgentBankDeps,
  userId: string,
  installationId: string,
): Promise<string | null> {
  try {
    const { peId } = await generatePE(deps, {
      walletId: userId,
      agentId: userId,
      actorAddress: '',
      actionType: 'service_install_revoked',
      metadata: {
        provider: 'github',
        installation_id: installationId,
      },
    });
    return peId;
  } catch (err) {
    console.warn('[GitHubConnect] revoked PE emission failed:', err);
    return null;
  }
}
