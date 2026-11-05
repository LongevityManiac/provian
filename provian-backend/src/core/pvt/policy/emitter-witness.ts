/**
 * emitter-witness — the RELAY-COMPOSED lanes' witness class and output digests, derived by
 * IDENTIFIER TYPE (Trust Layer build, §2.3/§2.8; §3 "rules-by-identifier-type,
 * never a catalog of sources or witnesses").
 *
 * `generatePE` seals ~120 relay-composed PEs (watchers, forge webhooks, institution lifecycle,
 * Commons, badges). None of them is an actor's self-report through a body the actor signed — the
 * relay composed the body from an event it OBSERVED — so the class is a fact about that event's
 * identifier, not about which file emitted it:
 *
 * - the emitter stamped `metadata.verified === true` AND the canonical event it observed is a
 * chain log / transaction (`<chainId>:0x<tx>:<log>`, `chaintx:…`, or a bare tx hash)
 * → `chain_witnessed`
 * - `verified === true` AND the event is a forge commit (`metadata.commit_sha`, a git object id)
 * → `forge_witnessed`
 * - `verified === true` with any other canonical event (the relay's own institution / genesis
 * logic checked the state it recorded) → `relay_verified`
 * - anything else (no verified stamp) → `actor_declared` (fail-closed)
 *
 * An emitter that KNOWS better passes `witnessClass` explicitly (a hardware-rooted report, for
 * one) and the explicit value wins. Nothing here is a source catalog: a new watcher observing a
 * chain event lands `chain_witnessed` on its first emit with no edit to this file.
 *
 * Output digests follow the same rule: the observable artifact a verified event names — the
 * commit object id, the settlement transaction hash — IS the PE's output digest, so a consumer's
 * captured `git:<sha>` / `evmtx:<hash>` resolves back to the producing PE by the index (§2.3).
 * Nothing observable → null (the key is omitted; never a placeholder).
 */

import { isWitnessClass, type WitnessClass } from './evidence-class';
import type { OutputDigest } from '../../provenance/output-digests';

/** A chain log identity (`canonicalLogIdentity`), a `chaintx:`-prefixed one, or a bare tx hash. */
export const CHAIN_EVENT_ID_RE = /^(?:chaintx:)?(?:\d+:)?0x[0-9a-f]{64}(?::\d+)?$/i;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const TX_HASH_KEYS = ['tx_hash', 'txHash', 'transaction_hash', 'settlementTxHash'] as const;

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const v = metadata[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function readTxHash(metadata: Record<string, unknown>): string | null {
  for (const key of TX_HASH_KEYS) {
    const v = readString(metadata, key);
    if (v !== null && TX_HASH_RE.test(v)) return v.toLowerCase();
  }
  return null;
}

function readCommitSha(metadata: Record<string, unknown>): string | null {
  const v = readString(metadata, 'commit_sha');
  return v !== null && GIT_OID_RE.test(v) ? v.toLowerCase() : null;
}

export interface EmitterWitnessInput {
  /** The emitter's explicit class, when it passed one (wins when valid). */
  readonly declared?: unknown;
  readonly metadata: Record<string, unknown>;
  /** The explicit canonical event id the emitter observed, when any. */
  readonly observedCanonicalEventId?: string | null;
}

/** The witness class a relay-composed PE seals under. Pure; never throws. */
export function deriveEmitterWitnessClass(input: EmitterWitnessInput): WitnessClass {
  if (isWitnessClass(input.declared)) return input.declared;
  const metadata = input.metadata ?? {};
  if (metadata.verified !== true) return 'actor_declared';
  const event = (typeof input.observedCanonicalEventId === 'string' && input.observedCanonicalEventId.length > 0)
    ? input.observedCanonicalEventId
    : (readString(metadata, 'canonical_event_id') ?? readTxHash(metadata));
  if (event !== null && CHAIN_EVENT_ID_RE.test(event)) return 'chain_witnessed';
  if (readCommitSha(metadata) !== null) return 'forge_witnessed';
  return 'relay_verified';
}

/**
 * The output digests a VERIFIED relay-composed event names — its commit object id and/or its
 * settlement transaction hash. Null when the event names nothing observable (or is unverified: an
 * unverified self-report's tx hash is a claim, not an output). A chain-id locator rides only when
 * the metadata carries one.
 */
export function deriveOutputDigestsFromMetadata(metadata: Record<string, unknown>): OutputDigest[] | null {
  if (!metadata || metadata.verified !== true) return null;
  const out: OutputDigest[] = [];
  const sha = readCommitSha(metadata);
  if (sha !== null) out.push({ hash: `git:${sha}`, kind: 'commit' });
  const tx = readTxHash(metadata);
  if (tx !== null) {
    const chainId = metadata.chain_id ?? metadata.chainId;
    const locator = Number.isSafeInteger(chainId) && (chainId as number) > 0
      ? `chain:eip155:${chainId as number}`
      : undefined;
    out.push(locator ? { hash: `evmtx:${tx}`, kind: 'tx', locator } : { hash: `evmtx:${tx}`, kind: 'tx' });
  }
  return out.length > 0 ? out : null;
}
