/**
 * verify-at-submit — the relay verifies a remote-channel presentation the
 * instant the agent submits it (while the token is fresh) and stores the verdict,
 * so an ABSENT human reads a verdict computed in-window instead of re-verifying an
 * expired token. Every failing assertion ships with its RED control.
 */
import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import { produceReputationPresentation, type PresenterPrincipal } from '../presentation/service';
import { presentationBindingString, claimsDigest, encodePresentationToken, type PresenterPop } from '../presentation/types';
import { canonicalReputationDirective, type DisclosureDirective } from '../presentation/disclosure';
import { ACTOR_STATS_COLLECTION, emptyActorStats } from '../pvt/actor-stats';
import { loadCommerceAttestationKeys } from '../presentation/jws-key-material';
import { verifyFreshPresentationToken } from './presentation-submit-verify';

function ed25519Env() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: priv.x, d: priv.d }) };
}
function agentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0')
    + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  return { pubkeyHex, address: ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase(), sign: (m: string) => crypto.createSign('SHA256').update(m).sign(privateKey, 'hex') };
}
function fakeDb(store: Map<string, Map<string, Record<string, unknown>>>) {
  const coll = (n: string) => { let c = store.get(n); if (!c) { c = new Map(); store.set(n, c); } return c; };
  const ref = (n: string, id: string) => ({
    id,
    async get() { const r = coll(n).get(id); return { exists: r !== undefined, data: () => (r ? { ...r } : undefined) }; },
    set(d: Record<string, unknown>, o?: { merge?: boolean }) { coll(n).set(id, o?.merge ? { ...(coll(n).get(id) ?? {}), ...d } : { ...d }); },
    create(d: Record<string, unknown>) { if (coll(n).has(id)) { const e = new Error('x') as Error & { code: number }; e.code = 6; throw e; } coll(n).set(id, { ...d }); },
  });
  // the vocabulary is fail-closed — the fixture answers every reader it uses (the reference
  // graph, presentation counts, device / bond counts) instead of relying on a swallowed read error.
  type Q = { where(f: string, op: string, v: unknown): Q; orderBy(): Q; select(): Q; startAfter(): Q; limit(n: number): Q;
    get(): Promise<{ empty: boolean; size: number; docs: Array<{ id: string; data: () => Record<string, unknown> }> }>;
    count(): { get(): Promise<{ data: () => { count: number } }> } };
  const query = (n: string, cons: Array<[string, string, unknown]> = [], lim = Infinity): Q => {
    const rows = () => [...coll(n).entries()]
      .filter(([, d]) => cons.every(([f, op, v]) => (op === '>=' ? typeof d[f] === 'number' && (d[f] as number) >= (v as number) : d[f] === v)))
      .slice(0, lim);
    const q: Q = {
      where: (f, op, v) => query(n, [...cons, [f, op, v]], lim),
      orderBy: () => q, select: () => q, startAfter: () => q,
      limit: (k) => query(n, cons, k),
      get: async () => { const r = rows(); return { empty: r.length === 0, size: r.length, docs: r.map(([id, d]) => ({ id, data: () => ({ ...d }) })) }; },
      count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
    };
    return q;
  };
  return {
    collection: (n: string) => ({ doc: (id: string) => ref(n, id), where: (f: string, op: string, v: unknown) => query(n).where(f, op, v) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: (r: { get: () => unknown }) => r.get(),
      create: (r: { create: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => r.create(d),
      set: (r: { set: (d: Record<string, unknown>, o?: unknown) => void }, d: Record<string, unknown>, o?: unknown) => r.set(d, o),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const NOW = Math.floor(Date.now() / 1000);
const AUD = 'requester-1';
const CHAL = 'chal-abcdefghijklmnop';
const PRED = { field: 'continuity.chain_depth', op: 'gte' as const, threshold: 10 };

async function makeToken(env: Record<string, string>, opts: { directive?: DisclosureDirective } = {}) {
  const agent = agentSigner();
  const directive: DisclosureDirective = opts.directive ?? { redact: [], predicates: [PRED] };
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  store.set(ACTOR_STATS_COLLECTION, new Map([['agent1', { ...emptyActorStats('agent1'), pe_count: 10 } as unknown as Record<string, unknown>]]));
  store.set('pvt_burn_records', new Map([['a'.repeat(64), { wallet_id: 'aw1', amount_atomic: (15n * 10n ** 18n).toString(), status: 'recorded', verified: true, chain: 'base' }]]));
  const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
  const binding = presentationBindingString({ tier: 'reputation', presenter_address: agent.address, aud: AUD, chal: CHAL, iat: NOW, exp: NOW + 300, jti: 'j1', burn_id: 'a'.repeat(64), claims_digest: claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(directive) }) });
  const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };
  const r = await produceReputationPresentation({ db: fakeDb(store), env }, { principal, burnId: 'a'.repeat(64), audience: AUD, challenge: CHAL, iat: NOW, exp: NOW + 300, jti: 'j1', pop, directive, nowSeconds: NOW });
  if (!r.ok) throw new Error('setup failed to produce presentation');
  return encodePresentationToken(r.presentation);
}

describe('verifyFreshPresentationToken', () => {
  it('valid when the fresh token answers the request binding + predicates', async () => {
    const env = ed25519Env();
    const token = await makeToken(env);
    const keys = loadCommerceAttestationKeys(env);
    const out = await verifyFreshPresentationToken(
      { token, audience: AUD, challenge: CHAL, predicates: [PRED] },
      { publicKeys: keys.ok ? keys.keys : [], peAnchorContract: null },
    );
    expect(out.verdict).toBe('valid');
    expect(out.predicate_results.length).toBe(1);

    // RED control: the SAME token verified against a DIFFERENT challenge is invalid —
    // proves the check is really binding, not rubber-stamping any structurally-valid token.
    const wrong = await verifyFreshPresentationToken(
      { token, audience: AUD, challenge: '0'.repeat(20), predicates: [PRED] },
      { publicKeys: keys.ok ? keys.keys : [], peAnchorContract: null },
    );
    expect(wrong.verdict).toBe('invalid');
  });

  it('invalid (missing_binding) when audience/challenge is absent — fail closed', async () => {
    const out = await verifyFreshPresentationToken(
      { token: 'x'.repeat(20), audience: null, challenge: CHAL, predicates: [] },
      { publicKeys: [], peAnchorContract: null },
    );
    expect(out).toEqual({ verdict: 'invalid', predicate_results: [], reason: 'missing_binding' });
  });

  it('invalid (malformed_token) when the token does not decode', async () => {
    const out = await verifyFreshPresentationToken(
      { token: 'not-a-real-token', audience: AUD, challenge: CHAL, predicates: [] },
      { publicKeys: [], peAnchorContract: null },
    );
    expect(out.verdict).toBe('invalid');
    expect(out.reason).toBe('malformed_token');
  });

  it('RED: a valid token but an UNANSWERED extra predicate is invalid (predicates are enforced, not ignored)', async () => {
    const env = ed25519Env();
    const token = await makeToken(env); // answers only PRED
    const keys = loadCommerceAttestationKeys(env);
    const out = await verifyFreshPresentationToken(
      { token, audience: AUD, challenge: CHAL, predicates: [PRED, { field: 'accountability.human_beneficiary', op: 'gte', threshold: 1 }] },
      { publicKeys: keys.ok ? keys.keys : [], peAnchorContract: null },
    );
    expect(out.verdict).toBe('invalid');
  });
});
