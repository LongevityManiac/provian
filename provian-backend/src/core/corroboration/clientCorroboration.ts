/**
 * Client-submitted corroboration metadata - wire validation (Pass-2 #31).
 *
 * Mobile / device clients may submit a `corroboration_signal` PE carrying a
 * `corroboration_metadata` block. The submit endpoints forward that block here
 * to parse + validate the untrusted wire shape BEFORE handing it to
 * applyClientCorroboration (which enforces the target-exists / verified-gate /
 * not-self invariants). This module is the single source of truth for the
 * accepted shape so /v1/pe/submit/mobile and /v1/pe/submit stay in lockstep.
 *
 * Clients may NOT assert the cross-witness forge signal types
 * (github/gitlab/bitbucket_webhook_attestation) - those are relay-witnessed
 * only. Anything unrecognized is rejected (returns null), never coerced.
 */

import type { CorroborationSignalType } from './CorroborationManager';

/** Signal types a client is permitted to submit (subset of CorroborationSignalType). */
const CLIENT_SIGNAL_TYPES: ReadonlySet<CorroborationSignalType> = new Set<CorroborationSignalType>([
  'on_chain_confirmation',
  'merchant_settlement',
  'x402_settlement',
  'promise_fulfillment',
  'job_delivery_accepted',
  'goal_resolution',
  'escrow_completed',
  'counterparty_attestation',
]);

export interface ClientCorroborationMetadata {
  target_pe_id: string;
  target_pe_hash: string;
  signal_type: CorroborationSignalType;
  /** Advisory only (client-controlled); the consumer never trusts it for self-check. */
  corroborating_party: string;
  evidence_ref?: string;
}

/**
 * Parse + validate an untrusted `corroboration_metadata` value. Returns the
 * typed metadata on success, or null when absent/malformed/disallowed (the
 * caller then simply does not run the corroboration consumer - the PE itself
 * still records normally).
 */
export function parseClientCorroborationMetadata(raw: unknown): ClientCorroborationMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  const targetPeId = m.target_pe_id;
  const targetPeHash = m.target_pe_hash;
  const signalType = m.signal_type;
  if (typeof targetPeId !== 'string' || targetPeId.length === 0) return null;
  if (typeof targetPeHash !== 'string' || targetPeHash.length === 0) return null;
  if (typeof signalType !== 'string') return null;
  if (!CLIENT_SIGNAL_TYPES.has(signalType as CorroborationSignalType)) return null;

  const corroboratingParty = typeof m.corroborating_party === 'string' ? m.corroborating_party : '';
  const evidenceRef = typeof m.evidence_ref === 'string' ? m.evidence_ref : undefined;

  return {
    target_pe_id: targetPeId,
    target_pe_hash: targetPeHash,
    signal_type: signalType as CorroborationSignalType,
    corroborating_party: corroboratingParty,
    evidence_ref: evidenceRef,
  };
}
