/**
 * the PIPELINED presentation: the presenter sends the burn's tx with the presentation, and
 * the relay records the burn at Base finality WHILE it prepares the presentation. Issuance (the live
 * vocabulary, the signing, the consumption) happens only after the burn is final.
 *
 * controls:
 * A. ISSUANCE AFTER FINALITY: the live vocabulary is read, and the burn consumed, only after the
 * verifier accepted the burn. Removing the burn gate (`passBurnGate`) turns this RED.
 * B. FINALITY INVARIANT (RED): a burn accepted into the request early — seen at inclusion — that
 * never reaches finality leaves NO standing benefit: no burn row, no consumption, no
 * presentation record (so no rail window / talking pass), no token.
 * C. A refusal that is not the burn's fault still records the burn and reports it back, so a
 * retry presents it instead of burning again.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ethers } from 'ethers';
import type { TxVerificationResult } from '../onchain/tx-verifier';

const mockVerify = jest.fn<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>();
jest.mock('../onchain/tx-verifier', () => ({
  ...(jest.requireActual('../onchain/tx-verifier') as object),
  verifyEvmPvtBurn: (...args: unknown[]) => mockVerify(...(args as Parameters<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>)),
}));

import { producePresentationFromRequest, type PresenterPrincipal } from './service';
import { burnIdFor } from './burn-record';
import { presentationBindingString, claimsDigest } from './types';
import { canonicalReputationDirective } from './disclosure';
import { STANDING_ALWAYS_PRESENT_FIELDS } from './vocabulary-fields';
import { findLiveHandshake } from '../rail/handshake';
import type { FinalityProbe } from './burn-finality-wait';

// ── Fake Firestore: docs (async, with delete), equality queries, transactions ──
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
const coll = (store: Store, name: string): Map<string, Row> => {
  let c = store.get(name); if (!c) { c = new Map(); store.set(name, c); } return c;
};
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() { const row = coll(this.store, this.collection).get(this.id); return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) }; }
  async set(data: Row, opts?: { merge?: boolean }) { this.setNow(data, opts); }
  setNow(data: Row, opts?: { merge?: boolean }) { const c = coll(this.store, this.collection); c.set(this.id, opts?.merge ? { ...(c.get(this.id) ?? {}), ...data } : { ...data }); }
  async create(data: Row) { this.createNow(data); }
  createNow(data: Row) { const c = coll(this.store, this.collection); if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; } c.set(this.id, { ...data }); }
  async delete() { coll(this.store, this.collection).delete(this.id); }
}
class FakeQuery {
  constructor(private store: Store, private collection: string, private cons: [string, unknown][] = []) {}
  where(f: string, _op: string, v: unknown) { return new FakeQuery(this.store, this.collection, [...this.cons, [f, v]]); }
  limit() { return this; }
  async get() {
    const rows = [...coll(this.store, this.collection).entries()].filter(([, d]) => this.cons.every(([f, v]) => d[f] === v));
    return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
  }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => new FakeDocRef(store, name, id),
      where: (f: string, op: string, v: unknown) => new FakeQuery(store, name).where(f, op, v),
    }),
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => fn({
      get: (r: FakeDocRef) => r.get(),
      create: (r: FakeDocRef, d: Row) => r.createNow(d),
      set: (r: FakeDocRef, d: Row, o?: { merge?: boolean }) => r.setNow(d, o),
      delete: (r: FakeDocRef) => { void r.delete(); },
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

// ── Keys: Provian's Ed25519 presentation key + the agent presenter ──
function makeEd25519Env(): Record<string, string> {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'd485', x: priv.x, d: priv.d }) };
}
function makeAgentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  const sign = (msg: string): string => { const s = crypto.createSign('SHA256'); s.update(msg); return s.sign(privateKey, 'hex'); };
  return { pubkeyHex, address, sign };
}

const WALLET = 'aw_presenter';
const AUDIENCE = 'provian:commons';
const TX = `0x${'c'.repeat(64)}`;
const BURN_ID = burnIdFor('base', TX);
const AMOUNT = (15n * 10n ** 18n).toString();
const FACTS: Record<string, number> = Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0]));

function body(signer: ReturnType<typeof makeAgentSigner>, opts: { iat: number; ttl?: number; burnId?: string; badPop?: boolean }) {
  const exp = opts.iat + (opts.ttl ?? 300);
  const challenge = crypto.randomBytes(32).toString('hex');
  const burnId = opts.burnId ?? BURN_ID;
  const digest = claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective({ redact: [], predicates: [] }) });
  const binding = presentationBindingString({
    tier: 'reputation', presenter_address: signer.address, aud: AUDIENCE, chal: challenge,
    iat: opts.iat, exp, jti: 'pres-d485', burn_id: burnId, claims_digest: digest,
  });
  return {
    tier: 'reputation', audience: AUDIENCE, challenge, iat: opts.iat, exp, jti: 'pres-d485',
    burn_id: burnId,
    burn: { tx_hash: TX, amount_atomic: AMOUNT, chain: 'base' },
    pop: { scheme: 'ecdsa_sha256_secp256k1', signature: opts.badPop ? signer.sign('not the binding') : signer.sign(binding), pubkey: signer.pubkeyHex },
    disclosure: { redact: [], predicates: [] },
  };
}

/** Fake time starting at the real clock (the presentation's iat is real seconds). */
function fakeClock() {
  const start = Date.now();
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, start, elapsed: () => t - start };
}
/** A chain: included at block 100 immediately; a block every 2 s; optionally reorged out. */
function chain(clock: ReturnType<typeof fakeClock>, opts: { reorgOutAfterMs?: number } = {}) {
  const head = () => 100 + Math.floor((clock.now() - clock.start) / 2000);
  const visible = () => opts.reorgOutAfterMs === undefined || clock.now() - clock.start < opts.reorgOutAfterMs;
  let finalAt: number | null = null;
  const probe: FinalityProbe = { async receiptBlock() { return visible() ? 100 : null; }, async headBlock() { return head(); } };
  const verify = async (): Promise<TxVerificationResult> => {
    if (!visible()) return { ok: false, reason: 'tx_not_found' };
    const c = head() - 100 + 1;
    if (c >= 12) { finalAt = finalAt ?? clock.now(); return { ok: true, blockNumber: 100, confirmations: c }; }
    return { ok: false, reason: `insufficient_confirmations: ${c}/12`, confirmations: c };
  };
  return { probe, verify, finalAt: () => finalAt };
}

let store: Store;
let env: Record<string, string>;
let signer: ReturnType<typeof makeAgentSigner>;
const principal = (): PresenterPrincipal => ({
  kind: 'agent', walletId: WALLET, address: signer.address, peOwnerUserId: 'agent-presenter', publicKeyHex: signer.pubkeyHex, standing: {},
});

beforeEach(() => {
  mockVerify.mockReset();
  store = new Map();
  env = makeEd25519Env();
  signer = makeAgentSigner();
});

describe('pipelined presentation ', () => {
  it(' A: records the burn at finality while preparing, and issues only after it', async () => {
    const clock = fakeClock();
    const ch = chain(clock);
    mockVerify.mockImplementation(ch.verify);
    let vocabularyReadAt: number | null = null;
    const db = makeDb(store);
    const r = await producePresentationFromRequest(
      {
        db, env,
        burnRecord: { probe: ch.probe, sleep: clock.sleep, now: clock.now },
        vocabulary: async () => { vocabularyReadAt = clock.now(); return FACTS; },
      },
      principal(),
      body(signer, { iat: Math.floor(clock.start / 1000) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presentation.payload.burn_id).toBe(BURN_ID);
    // The facts were read at issuance — after the verifier accepted the burn at finality.
    expect(ch.finalAt()).not.toBeNull();
    expect(vocabularyReadAt).not.toBeNull();
    expect(vocabularyReadAt!).toBeGreaterThanOrEqual(ch.finalAt()!);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(22_000);
    // One call recorded, consumed, and opened the window.
    expect(coll(store, 'pvt_burn_records').get(BURN_ID)).toMatchObject({ status: 'recorded', verified: true, wallet_id: WALLET });
    expect(coll(store, 'burn_consumptions').get(BURN_ID)).toMatchObject({ product: 'presentation' });
    expect(await findLiveHandshake(db, WALLET, AUDIENCE, clock.now())).not.toBeNull();
  });

  it(' B (FINALITY RED): a burn accepted early that never reaches finality leaves no standing benefit', async () => {
    const clock = fakeClock();
    // Included (1 confirmation) at once, reorged out at 6 s, never final.
    const ch = chain(clock, { reorgOutAfterMs: 6_000 });
    mockVerify.mockImplementation(ch.verify);
    let issued = false;
    const db = makeDb(store);
    const r = await producePresentationFromRequest(
      {
        db, env,
        burnRecord: { probe: ch.probe, sleep: clock.sleep, now: clock.now },
        vocabulary: async () => { issued = true; return FACTS; },
      },
      principal(),
      body(signer, { iat: Math.floor(clock.start / 1000) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.reason).toBe('tx_not_found');
    expect(r.burnId).toBeUndefined();
    // No standing benefit of any kind:
    expect(coll(store, 'pvt_burn_records').has(BURN_ID)).toBe(false); // no burn to consume later
    expect(coll(store, 'burn_consumptions').has(BURN_ID)).toBe(false); // nothing consumed it
    expect(coll(store, 'commons_presentations').has(BURN_ID)).toBe(false); // no presentation record
    expect(await findLiveHandshake(db, WALLET, AUDIENCE, clock.now())).toBeNull(); // no window / talking pass
    expect(issued).toBe(false); // nothing was issued, so no token exists
    // Non-vacuous: the request was accepted and the verifier WAS consulted before it refused.
    expect(mockVerify).toHaveBeenCalled();
  });

  it('refuses a burn_id that is not sha256(chain:tx_hash) before touching the chain', async () => {
    const db = makeDb(store);
    const r = await producePresentationFromRequest({ db, env }, principal(), body(signer, { iat: Math.floor(Date.now() / 1000), burnId: 'e'.repeat(64) }));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it(' C: a refusal that is not the burn\'s fault still records the burn and reports it for a retry', async () => {
    const clock = fakeClock();
    const ch = chain(clock);
    mockVerify.mockImplementation(ch.verify);
    const db = makeDb(store);
    const r = await producePresentationFromRequest(
      { db, env, burnRecord: { probe: ch.probe, sleep: clock.sleep, now: clock.now }, vocabulary: async () => FACTS },
      principal(),
      body(signer, { iat: Math.floor(clock.start / 1000), badPop: true }),
    );
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'bad_presenter_pop', burnId: BURN_ID });
    expect(coll(store, 'pvt_burn_records').get(BURN_ID)).toMatchObject({ status: 'recorded' });
    expect(coll(store, 'burn_consumptions').has(BURN_ID)).toBe(false); // recorded, NOT consumed
  });

  it('a presentation window that lapses during the wait is refused without consuming the burn', async () => {
    const clock = fakeClock();
    const ch = chain(clock);
    mockVerify.mockImplementation(ch.verify);
    const db = makeDb(store);
    // exp = iat + 60 s; the verifier accepts at ~22 s, but the clock is pushed past exp + skew.
    const iat = Math.floor(clock.start / 1000) - 110;
    const r = await producePresentationFromRequest(
      { db, env, burnRecord: { probe: ch.probe, sleep: clock.sleep, now: clock.now }, vocabulary: async () => FACTS },
      principal(),
      body(signer, { iat, ttl: 60 }),
    );
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'presentation_expired', burnId: BURN_ID });
    expect(coll(store, 'burn_consumptions').has(BURN_ID)).toBe(false);
  });
});
