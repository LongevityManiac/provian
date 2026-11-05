/**
 * relay-signed challenges for the relay-mediated presentation requests: Commons thread
 * requests and the remote channel. The requester is an authenticated Commons party
 * (agent or human); the relay composes the binding and signs it as a WALLET requester
 * (`{ type:'wallet', id: <requester party id>, address }`) with the Provian presentation key, so the
 * presenter sees — and every presenter surface verifies before it burns — who is asking.
 *
 * The audience IS the requester's party id (the same id the rail handshake keys on), and the signed
 * deadline is the request's own delivery expiry (a remote request is answered asynchronously). When
 * the presenter's address is resolvable the envelope also names it, so a presenter surface refuses
 * a request that was not addressed to it.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { resolveHumanWallet } from '../presentation/principal';
import { signWalletChallenge } from '../presentation/challenge-issuer';
import { CHALLENGE_MIN_TTL_SECONDS, CHALLENGE_MAX_TTL_SECONDS, type ChallengeEnvelope } from '../presentation/challenge';
import { PRESENTATION_CHALLENGE_MIN_LEN, PRESENTATION_CHALLENGE_MAX_LEN } from '../presentation/types';
import type { PredicateRequest } from '../presentation/disclosure';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

type PartyKind = 'agent' | 'human';

/** The EVM address a Commons party signs / presents with (agent sovereign address; human first-party wallet). */
export async function partyAddressOf(db: Firestore, kind: PartyKind, partyId: string): Promise<string | null> {
  if (kind === 'agent') {
    const snap = await db.collection('agent_wallets').doc(partyId).get();
    const addr = (snap.data() as { address?: unknown } | undefined)?.address;
    return typeof addr === 'string' && ADDRESS_RE.test(addr.toLowerCase()) ? addr.toLowerCase() : null;
  }
  const w = await resolveHumanWallet(db, partyId);
  return w.ok ? w.address : null;
}

export type SignRequestChallengeResult =
  | { ok: true; envelope: ChallengeEnvelope }
  | { ok: false; status: number; error: string };

/**
 * Sign the challenge for a relay-mediated request. `challenge` (the requester's own nonce, when it
 * supplied one) is kept if well-formed; otherwise the relay mints a fresh 32-byte nonce.
 */
export async function signRequestChallenge(
  db: Firestore,
  request: {
    requester_kind: PartyKind; requester_id: string;
    presenter_kind: PartyKind; presenter_id: string;
    expires_at_ms: number;
  },
  input: { challenge?: unknown; predicates: readonly PredicateRequest[]; nowMs: number },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<SignRequestChallengeResult> {
  const requesterAddress = await partyAddressOf(db, request.requester_kind, request.requester_id);
  if (!requesterAddress) return { ok: false, status: 409, error: 'the requester has no EVM address to attest; the challenge cannot be signed' };
  const presenterAddress = await partyAddressOf(db, request.presenter_kind, request.presenter_id).catch(() => null);
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const ttl = Math.min(Math.floor(request.expires_at_ms / 1000) - nowSeconds, CHALLENGE_MAX_TTL_SECONDS);
  if (ttl < CHALLENGE_MIN_TTL_SECONDS) return { ok: false, status: 409, error: 'the request expires too soon to be challenged' };
  const supplied = typeof input.challenge === 'string' ? input.challenge.trim() : '';
  const challenge = supplied.length >= PRESENTATION_CHALLENGE_MIN_LEN && supplied.length <= PRESENTATION_CHALLENGE_MAX_LEN
    ? supplied : undefined;
  const signed = signWalletChallenge(
    { walletId: request.requester_id, address: requesterAddress },
    { challenge, predicates: input.predicates, ttlSeconds: ttl, nowSeconds, ...(presenterAddress ? { presenter: presenterAddress } : {}) },
    env,
  );
  return signed.ok ? { ok: true, envelope: signed.envelope } : signed;
}
