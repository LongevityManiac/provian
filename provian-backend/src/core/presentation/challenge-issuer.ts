/**
 * Wallet-signed challenges — the relay signs a challenge for an AUTHENTICATED Provian wallet.
 *
 * A Provian wallet (agent or human) that asks someone to present gets a challenge envelope whose
 * requester is `{ type: 'wallet', id: <wallet id>, address: <its EVM address> }`, signed with the
 * Provian presentation Ed25519 key (the same key and JWKS as the presentation JWS; the
 * `provian-challenge-v1` signing string can never be confused with a JWS signing input). The relay
 * signs only after it authenticated that wallet (agent API key / wallet auth), so the identity a
 * presenter sees is a Provian-attested wallet id↔address binding from the relay's own registry.
 *
 * One function behind every relay-issued challenge: the agent and human `/present/challenge`
 * routes, Commons thread presentation requests, and the remote-request compose step.
 * Signing a challenge consumes nothing and produces no presentation — it is not a burn-free path.
 */

import { randomBytes } from 'crypto';
import { normalizePredicateRequests, type PredicateRequest } from './disclosure';
import { normalizeDisclosureRequests, type CanonicalDisclosureRequest } from './disclosure-request';
import { signChallengeEnvelope, CHALLENGE_MIN_TTL_SECONDS, CHALLENGE_MAX_TTL_SECONDS, type ChallengeEnvelope } from './challenge';
import { loadPresentationSigningKey } from './signer';

export const WALLET_CHALLENGE_DEFAULT_TTL_SECONDS = 900;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type IssueWalletChallengeResult =
  | { ok: true; envelope: ChallengeEnvelope }
  | { ok: false; status: number; error: string };

/** Sign a challenge for `wallet` from already-validated fields (threads / remote requests). */
export function signWalletChallenge(
  wallet: { walletId: string; address: string },
  fields: { challenge?: string; predicates?: readonly PredicateRequest[]; disclosures?: readonly CanonicalDisclosureRequest[]; ttlSeconds?: number; presenter?: string; nowSeconds?: number },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IssueWalletChallengeResult {
  const key = loadPresentationSigningKey(env);
  if (!key.ok) return { ok: false, status: 503, error: `challenge signing key is not configured (${key.reason})` };
  const address = wallet.address.toLowerCase();
  if (!ADDRESS_RE.test(address)) return { ok: false, status: 409, error: 'the requester wallet has no EVM address to attest' };
  const issuedAt = fields.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = fields.ttlSeconds ?? WALLET_CHALLENGE_DEFAULT_TTL_SECONDS;
  const envelope = signChallengeEnvelope({
    audience: wallet.walletId,
    challenge: fields.challenge ?? randomBytes(32).toString('hex'),
    issuedAt,
    expiresAt: issuedAt + ttl,
    requester: { type: 'wallet', id: wallet.walletId, address, kid: key.key.kid },
    ...(fields.presenter ? { presenter: fields.presenter.toLowerCase() } : {}),
    predicates: fields.predicates ?? [],
    disclosures: fields.disclosures ?? [],
  }, key.key.privateKey);
  return { ok: true, envelope };
}

/** Parse an untrusted `{ predicates?, disclosures?, ttl_seconds?, presenter? }` body and sign for `wallet`. */
export function issueWalletChallengeFromRequest(
  wallet: { walletId: string; address: string },
  body: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IssueWalletChallengeResult {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const predicates = normalizePredicateRequests(b.predicates);
  if (predicates === null) return { ok: false, status: 400, error: 'predicates is malformed (field, op gte|gt|lte|lt|eq|in, threshold | set)' };
  const disclosures = normalizeDisclosureRequests(b.disclosures);
  if (disclosures === null) return { ok: false, status: 400, error: 'disclosures is malformed ({kind:pe, output_digest, issuer?, fields?, content?} | {kind:witness, issuer?|signer?, limit?, fields?, content?})' };
  let ttlSeconds: number | undefined;
  if (b.ttl_seconds !== undefined) {
    if (!Number.isInteger(b.ttl_seconds) || (b.ttl_seconds as number) < CHALLENGE_MIN_TTL_SECONDS || (b.ttl_seconds as number) > CHALLENGE_MAX_TTL_SECONDS) {
      return { ok: false, status: 400, error: `ttl_seconds must be an integer ${CHALLENGE_MIN_TTL_SECONDS}..${CHALLENGE_MAX_TTL_SECONDS}` };
    }
    ttlSeconds = b.ttl_seconds as number;
  }
  let presenter: string | undefined;
  if (b.presenter !== undefined && b.presenter !== null && b.presenter !== '') {
    if (typeof b.presenter !== 'string' || !ADDRESS_RE.test(b.presenter.toLowerCase())) {
      return { ok: false, status: 400, error: 'presenter must be an EVM address' };
    }
    presenter = b.presenter.toLowerCase();
  }
  return signWalletChallenge(wallet, { predicates, disclosures, ttlSeconds, presenter }, env);
}
