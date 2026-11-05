import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Backend CorroborationManager - Server-Side Corroboration Signal PE Generator
 *
 * Called by backend Agent Bank flows (escrow completion, promise settlement,
 * job delivery) to emit corroboration_signal PEs via the PE buffer.
 *
 * SECURITY INVARIANT (from CLAUDE.md #8):
 * - Never suppress, delay, or filter valid corroboration signals
 * - Invalid signals (missing target_pe_id) are rejected, not suppressed
 */

import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import type { MeterActKeyDoc } from '../meter/meter-act-key';
import { recordMeterIncumbentCorroboration } from '../meter/meter-corroboration';
import crypto from 'crypto';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { mutatePeHistoryRowWithAggregate } from '../pvt/policy/economic-aggregate';

export type CorroborationSignalType =
  | 'on_chain_confirmation'
  | 'merchant_settlement'
  | 'x402_settlement'
  | 'promise_fulfillment'
  | 'job_delivery_accepted'
  | 'goal_resolution'
  | 'escrow_completed'
  | 'counterparty_attestation'
  // Witness 3 - relay-witnessed external service event (e.g. a user-installed
  // GitHub App webhook delivery that attests an action the user's PE chain
  // already claimed). One emitter call per matched prior PE; bidirectional
  // by design (whichever PE arrives later triggers the upgrade of the earlier
  // one). See core/witnesses/github-webhook.ts and core/witnesses/gitlab-webhook.ts.
  | 'github_webhook_attestation'
  | 'gitlab_webhook_attestation'
  | 'bitbucket_webhook_attestation';

export interface BackendCorroborationInput {
  /** The PE ID being corroborated (from the original action) */
  targetPeId: string;
  /** Hash of the target PE */
  targetPeHash: string;
  /** Corroboration signal type */
  signalType: CorroborationSignalType;
  /** Who/what is corroborating - wallet_id or 'system' */
  corroboratingParty: string;
  /** Raw evidence string to hash */
  evidence: string;
  /** Human-readable reference (escrow_id, promise_id, job_id, etc.) */
  evidenceRef?: string;
  /** Stable identity for a durable forge delivery retry; ordinary callers stay unchanged. */
  peIdOverride?: string;
  timestampOverride?: number;
  /** Wallet ID for the PE owner */
  walletId: string;
  /** Agent ID for the PE owner */
  agentId: string;
  /** Actor address */
  actorAddress: string;
}


/**
 * The corroboration target: its canonical hash, its author identities, and where its priced row
 * lives. PE METER: a metered act's row and hash are in its act key, kept for 31 days — the
 * 30-day corroboration horizon fits inside it. A pre-meter target is read from its envelope and
 * pe_history row until the migration retires them. Null when the target is unknown.
 */
interface CorroborationTarget {
  readonly home: 'meter' | 'legacy';
  readonly hash: string | undefined;
  readonly authorIds: readonly string[];
}

async function readCorroborationTarget(
  db: AgentBankDeps['db'],
  targetPeId: string,
): Promise<CorroborationTarget | null> {
  const keySnap = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(targetPeId).get();
  if (keySnap.exists) {
    const key = keySnap.data() as Partial<MeterActKeyDoc> | undefined;
    const authorIds = [key?.actor_id, (key?.row as { userId?: unknown } | undefined)?.userId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return { home: 'meter', hash: key?.pe_hash, authorIds: [...new Set(authorIds)] };
  }
  const [envSnap, histSnap] = await Promise.all([
    db.collection('provenance_envelopes').doc(targetPeId).get(),
    db.collection('pe_history').doc(targetPeId).get(),
  ]);
  if (!envSnap.exists && !histSnap.exists) return null;
  const env = envSnap.data() as { hash?: string; user_id?: string; wallet_id?: string; agent_id?: string } | undefined;
  const hist = histSnap.data() as { peHash?: string; hash?: string; userId?: string; user_id?: string } | undefined;
  const authorIds = [env?.user_id, env?.wallet_id, env?.agent_id, hist?.userId, hist?.user_id]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return {
    home: 'legacy',
    // The derived pe_history row keys its hash under `peHash`; an envelope under `hash`.
    hash: hist?.peHash ?? hist?.hash ?? env?.hash,
    authorIds: [...new Set(authorIds)],
  };
}

/**
 * Emit a backend corroboration signal PE via the PE buffer.
 * Validates target PE exists, hash matches, and no self-corroboration.
 * Fire-and-forget - errors are logged but never thrown.
 */
export async function emitBackendCorroboration(
  deps: AgentBankDeps,
  input: BackendCorroborationInput,
): Promise<void> {
  // Validate required fields - reject invalid, never suppress valid
  if (!input.targetPeId || !input.targetPeHash || !input.evidence) {
    console.warn('[BackendCorroboration] Rejected: missing required field');
    return;
  }

  try {
    // SECURITY FIX P0-3: Verify target PE exists and hash matches before accepting corroboration
    const target = await readCorroborationTarget(deps.db, input.targetPeId);
    if (target === null) {
      console.warn(
        `[BackendCorroboration] Rejected: target PE ${input.targetPeId} not found. ` +
        `Party: ${input.corroboratingParty}, signal: ${input.signalType}`,
      );
      return;
    }
    const targetCanonicalHash = target.hash;
    if (targetCanonicalHash !== input.targetPeHash) {
      console.warn(
        `[BackendCorroboration] Rejected: hash mismatch for PE ${input.targetPeId}. ` +
        `Expected: ${targetCanonicalHash?.slice(0, 12)}, got: ${input.targetPeHash.slice(0, 12)}. ` +
        `Party: ${input.corroboratingParty}, signal: ${input.signalType}`,
      );
      return;
    }

    // No self-corroboration: the corroborating party must not be the PE author (invariant #8:
    // reject a party corroborating its own PE). The author set is the act key's actor (metered)
    // or the envelope's and pe_history's author ids (pre-meter).
    if (target.authorIds.includes(input.corroboratingParty)) {
      console.warn(
        `[BackendCorroboration] Rejected: self-corroboration by ${input.corroboratingParty} ` +
        `on PE ${input.targetPeId}`,
      );
      return;
    }
    const evidenceHash = crypto.createHash('sha256')
      .update(input.evidence)
      .digest('hex');

    // H-3 fix: delegate to generatePE so the PE chain tip is advanced atomically.
    // Previously this wrote `prev_hash: 'CHAIN_TIP'` as a literal sentinel,
    // breaking the hash chain for every corroboration signal.
    const now = input.timestampOverride ?? Date.now();
    const { peId } = await generatePE(deps, {
      walletId: input.walletId,
      agentId: input.agentId,
      actorAddress: input.actorAddress,
      actionType: 'corroboration_signal',
      ...(input.peIdOverride ? { peIdOverride: input.peIdOverride, timestampOverride: now } : {}),
      metadata: {
        target_pe_id: input.targetPeId,
        target_pe_hash: input.targetPeHash,
        corroborating_party: input.corroboratingParty,
        signal_type: input.signalType,
        evidence_hash: evidenceHash,
        evidence_ref: input.evidenceRef,
        automated: true,
      },
    });

    // Update corroboration status on the target PE in Firestore. Best-effort:
    // a failed write is logged, never thrown (the signal PE above is already
    // sealed). M5: through the aggregate-aware mutation primitive, so a
    // lift that changes the target's settlement input inside its 72h window
    // lands as an aggregate delta in the same transaction as the status write.
    try {
      if (target.home === 'meter') {
        // PE METER: the lift is paid as an additive top-up claim computed from the act key, at the
        // moment the corroboration lands (one per leg, ever; first observation wins).
        await recordMeterIncumbentCorroboration(deps.db, {
          incumbentPeId: input.targetPeId,
          corroboratingPeId: peId,
          nowMs: now,
          status: mapSignalTypeToStatus(input.signalType),
          source: input.evidenceRef || evidenceHash,
        });
      } else {
        await mutatePeHistoryRowWithAggregate(deps.db, input.targetPeId, {
          corroboration_status: mapSignalTypeToStatus(input.signalType),
          corroboration_source: input.evidenceRef || evidenceHash,
          corroboration_received_at: now,
        }, { nowMs: now });
      }
    } catch (writeError) {
      console.warn('[BackendCorroboration] target corroboration_status write failed (non-blocking):', writeError);
    }

    console.log(
      `[BackendCorroboration] Emitted ${input.signalType} for PE ${input.targetPeId.slice(0, 12)}`,
    );
  } catch (err) {
    console.warn('[BackendCorroboration] Failed to emit:', err);
  }
}

/**
 * Resolve the canonical hash of a target PE for first-party backend
 * corroboration (escrow completion, promise settlement, job delivery).
 *
 * Pass-2 #5: the three primary economic emitters previously hardcoded
 * `targetPeHash: ''`, which the falsy-guard in emitBackendCorroboration
 * rejected immediately, so the advertised `corroborated` (1.1×) tier was
 * unreachable on every primary flow. This mirrors the github-webhook
 * fetch-then-skip-if-absent pattern: read the target's stored hash and let
 * the caller skip when it is genuinely missing. Reads pe_history (the same
 * collection emitBackendCorroboration validates + writes back to), preferring
 * the canonical `peHash` field and falling back to `hash` for envelope-shaped
 * docs. Returns '' ONLY when the target or its hash is genuinely missing — a
 * genuinely-missing target is rejected, never a valid signal suppressed
 * (CLAUDE.md invariant #8).
 */
export async function resolveTargetPeHash(
  deps: Pick<AgentBankDeps, 'db'>,
  targetPeId: string,
): Promise<string> {
  if (!targetPeId) return '';
  try {
    return (await readCorroborationTarget(deps.db, targetPeId))?.hash ?? '';
  } catch (err) {
    console.warn(`[BackendCorroboration] resolveTargetPeHash failed for ${targetPeId}:`, err);
    return '';
  }
}

export interface ClientCorroborationInput {
  /** The PE ID being corroborated (from the client-submitted corroboration_metadata). */
  targetPeId: string;
  /** Client-supplied target hash; must match the stored canonical hash (verified gate). */
  targetPeHash: string;
  /** Corroboration signal type (client union is a subset of CorroborationSignalType). */
  signalType: CorroborationSignalType;
  /**
   * The corroborating party as ADVISORY metadata only (client-controlled,
   * forgeable). The self-corroboration decision uses `submitterIdentities`
   * (the authenticated submitter), never this field.
   */
  corroboratingParty: string;
  /**
   * Authoritative identity of the authenticated submitter (e.g. their user_id
   * plus resolved wallet address). Used for the no-self-corroboration check AND
   * stamped as the non-forgeable corroboration_source (attestor) on the target.
   * The FIRST entry is treated as the canonical attestor id.
   */
  submitterIdentities: string[];
  /**
   * The envelope_id of the corroboration_signal PE the client just submitted.
   * Stamped on the target as the mint-neutral `client_corroborating_pe_id` so
   * the (visibility-only) corroboration is traceable back to the PE that
   * produced it.
   */
  corroboratingPeId?: string;
  /** Optional human-readable reference (promise_id, tx hash, etc.). */
  evidenceRef?: string;
}

export type ClientCorroborationReason =
  | 'missing_fields'
  | 'target_not_found'
  | 'hash_mismatch'
  | 'self_corroboration'
  | 'writeback_failed';

export interface ClientCorroborationResult {
  applied: boolean;
  reason?: ClientCorroborationReason;
}

/**
 * Apply a CLIENT-submitted corroboration_signal PE to its target (Pass-2 #31).
 *
 * MINT-NEUTRAL BY PRODUCT DECISION (2026-06-29). Client-submitted peer
 * corroboration is recorded for reputation/visibility but DOES NOT grant the
 * corroborated (1.1x) mint tier. The 1.1x tier is reserved for server-driven,
 * event-grounded corroboration (escrow/promise/job settlement via
 * emitBackendCorroboration, and forge-webhook cross-witness attestations) where
 * the relay verified a real on-chain/external event. An unverifiable peer
 * assertion — even cross-party and hash-verified — is collusion/sybil-prone (the
 * target hash is shareable), so it must NOT move mint weight. Concretely: this
 * function NEVER writes `corroboration_status` (the field the PVT9 claim inlet,
 * `wp4/claim-inlet-source.ts`, and the dashboard projection read);
 * it writes only mint-neutral `client_corroboration_*` markers. (If a future
 * decision grants client corroboration mint weight, the anti-collusion controls
 * in OPEN_ITEMS WS-FixtureFidelity-3 must land first.)
 *
 * Unlike emitBackendCorroboration, this does NOT create a new PE — the
 * corroboration_signal PE the client already submitted IS the record.
 *
 * Gates (mirroring the finding: "validate target exists, not self, verified gate"):
 * 1. target exists — the target_pe_id resolves to a real PE.
 * 2. verified gate — the client-supplied target_pe_hash must match the stored
 * canonical hash (proof the submitter actually witnessed the
 * target; an attacker cannot corroborate a PE whose hash they
 * cannot produce).
 * 3. not self — the AUTHENTICATED submitter must not be the target PE's
 * author. We check the authenticated identity, NOT the
 * forgeable corroborating_party field.
 *
 * Reads the canonical author + hash from provenance_envelopes (the immutable
 * envelope), falling back to pe_history. Records mint-neutral markers on the
 * target's pe_history doc. Rejecting an invalid/self/hash-mismatched signal is
 * rejection of an INVALID signal, never suppression of a valid one (Inv #8).
 */
export async function applyClientCorroboration(
  deps: Pick<AgentBankDeps, 'db'>,
  input: ClientCorroborationInput,
): Promise<ClientCorroborationResult> {
  if (!input.targetPeId || !input.targetPeHash) {
    console.warn('[ClientCorroboration] Rejected: missing target_pe_id or target_pe_hash');
    return { applied: false, reason: 'missing_fields' };
  }

  try {
    const target = await readCorroborationTarget(deps.db, input.targetPeId);
    if (target === null) {
      console.warn(`[ClientCorroboration] Rejected: target PE ${input.targetPeId} not found`);
      return { applied: false, reason: 'target_not_found' };
    }
    const canonicalHash = target.hash;
    const authorIds = target.authorIds;
    const histRef = deps.db.collection('pe_history').doc(input.targetPeId);
    const histSnap = target.home === 'legacy' ? await histRef.get() : null;

    // Verified gate: client hash must match the stored canonical hash.
    if (!canonicalHash || canonicalHash !== input.targetPeHash) {
      console.warn(
        `[ClientCorroboration] Rejected: hash mismatch for PE ${input.targetPeId} ` +
        `(expected ${canonicalHash?.slice(0, 12)}, got ${input.targetPeHash.slice(0, 12)})`,
      );
      return { applied: false, reason: 'hash_mismatch' };
    }

    // No self-corroboration (authenticated submitter vs PE author).
    const submitter = new Set(
      input.submitterIdentities.filter((x) => typeof x === 'string' && x.length > 0),
    );
    if (authorIds.some((a) => submitter.has(a))) {
      console.warn(
        `[ClientCorroboration] Rejected: self-corroboration on PE ${input.targetPeId} ` +
        `by submitter ${[...submitter][0]}`,
      );
      return { applied: false, reason: 'self_corroboration' };
    }

    // The target must have a pe_history doc to upgrade (where minting reads the
    // status). If it predates accrual, there is nothing to write back to.
    if (histSnap !== null && !histSnap.exists) {
      console.warn(`[ClientCorroboration] Rejected: no pe_history record for PE ${input.targetPeId}`);
      return { applied: false, reason: 'target_not_found' };
    }

    // MINT-NEUTRAL writeback. We deliberately DO NOT touch `corroboration_status`
    // (the field the PVT9 claim inlet reads to grant the corroborated tier) —
    // client peer corroboration must not move mint weight. We record
    // only `client_corroboration_*` markers for reputation/visibility, stamped with
    // the NON-forgeable authenticated attestor (never the client-controlled
    // corroborating_party). These markers are read by no mint/tier/weight path.
    const attestor = [...submitter][0] ?? 'client';
    const markers = {
      client_corroboration_last_at: Date.now(),
      client_corroboration_last_by: attestor,
      client_corroboration_signal_type: input.signalType,
      ...(input.corroboratingPeId ? { client_corroborating_pe_id: input.corroboratingPeId } : {}),
      ...(input.evidenceRef ? { client_corroboration_evidence_ref: input.evidenceRef } : {}),
    };
    if (target.home === 'meter') {
      await privateRetentionCollection(deps.db, METER_ACT_KEYS_COLLECTION).doc(input.targetPeId).set({ row: markers }, { merge: true });
    } else {
      await histRef.update(markers);
    }
    console.log(
      `[ClientCorroboration] Recorded MINT-NEUTRAL client corroboration on PE ` +
      `${input.targetPeId.slice(0, 12)} (attestor ${attestor}); corroboration_status untouched`,
    );
    return { applied: true };
  } catch (err) {
    console.warn('[ClientCorroboration] Failed to apply:', err);
    return { applied: false, reason: 'writeback_failed' };
  }
}

function mapSignalTypeToStatus(
  signalType: CorroborationSignalType,
): 'on_chain_verified' | 'merchant_confirmed' | 'peer_verified' | 'service_grant_attested' {
  switch (signalType) {
    case 'on_chain_confirmation':
      return 'on_chain_verified';
    case 'merchant_settlement':
    case 'x402_settlement':
      return 'merchant_confirmed';
    case 'github_webhook_attestation':
    case 'gitlab_webhook_attestation':
    case 'bitbucket_webhook_attestation':
      // Distinct from peer_verified so the mint pipeline (and audit
      // tooling) can tell Witness 3 cross-witness corroboration apart
      // from peer attestations. Recognized at corroborated tier by the PVT9
      // claim inlet (core/pvt/wp4/claim-inlet-source.ts).
      return 'service_grant_attested';
    default:
      return 'peer_verified';
  }
}
