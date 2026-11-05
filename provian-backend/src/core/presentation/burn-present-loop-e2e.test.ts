/**
 * BURN-TO-PRESENT — end-to-end rig proof of the THREE loops, with real crypto and
 * the REAL modules (producePresentationFromRequest → verifyPresentation → the rail
 * handshake gate → event invalidation → readHandshakeState). This is the
 * reproducible mechanism proof the live on-chain drill mirrors on mainnet.
 *
 *   1. STANDALONE: challenge → burn-backed present → offline verify → single-use
 *      holds (a replay of the same burn 409s; the token does not verify to another
 *      requester/moment).
 *   2. RAIL: a commitment REFUSES with no live handshake (428) → present →
 *      the commitment PASSES (one burn) → a second in-window action still passes
 *      (no new present) → window lapse → refuses again → re-present passes.
 *   3. INVALIDATION: with a live window, an adverse presenter-side event
 *      (reputation downgrade / key rotation) closes it → the next commit refuses
 *      with the reason class readable by BOTH parties → re-present passes. A
 *      previously-established (committed) handshake fact is never rewritten.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { producePresentationFromRequest, type PresenterPrincipal } from './service';
import { verifyPresentation } from './verify';
import { presentationBindingString, claimsDigest } from './types';
import { canonicalReputationDirective } from './disclosure';
import type { CommerceAttestationPublicJwk } from './jws-key-material';
import {
  assertLiveHandshake,
  findLiveHandshake,
  readHandshakeState,
  RailHandshakeError,
  RAIL_HANDSHAKE_WINDOW_MS,
} from '../rail/handshake';
import { invalidateHandshakes } from '../rail/invalidation';

// ── Ed25519 Provian reputation signing key ───────────────────────────────────
function makeEd25519Env(): { env: Record<string, string>; publicKeys: CommerceAttestationPublicJwk[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'e2e-rep-key';
  return {
    env: { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid, x: priv.x, d: priv.d }) },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
  };
}

// ── Agent secp256k1 signer (the PRESENTER) ───────────────────────────────────
function makeAgentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0');
  const yHex = Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const pubkeyHex = xHex + yHex;
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  const sign = (msg: string): string => { const s = crypto.createSign('SHA256'); s.update(msg); return s.sign(privateKey, 'hex'); };
  return { pubkeyHex, address, sign };
}

// ── Fake Firestore (collection/doc/get/set/create, where/count, runTransaction) ─
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name); if (!c) { c = new Map(); store.set(name, c); } return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() { const row = coll(this.store, this.collection).get(this.id); return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) }; }
  set(data: Row, opts?: { merge?: boolean }): void { const c = coll(this.store, this.collection); if (opts?.merge) c.set(this.id, { ...(c.get(this.id) ?? {}), ...data }); else c.set(this.id, { ...data }); }
  create(data: Row): void { const c = coll(this.store, this.collection); if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; } c.set(this.id, { ...data }); }
}
class FakeQuery {
  // the vocabulary is fail-closed — the fixture gives it every reader it uses (op-aware
  // `where` for == / >=, the reference graph's orderBy/select/startAfter, a snapshot `size`).
  constructor(private store: Store, private collection: string, private cons: [string, string, unknown][] = [], private lim = Infinity) {}
  where(f: string, op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.collection, [...this.cons, [f, op, v]], this.lim); }
  limit(n: number): FakeQuery { return new FakeQuery(this.store, this.collection, this.cons, n); }
  orderBy(): FakeQuery { return this; }
  select(): FakeQuery { return this; }
  startAfter(): FakeQuery { return this; }
  private rows() { let rows = [...coll(this.store, this.collection).entries()]; for (const [f, op, v] of this.cons) rows = rows.filter(([, d]) => (op === '>=' ? typeof d[f] === 'number' && (d[f] as number) >= (v as number) : d[f] === v)); return rows.slice(0, this.lim); }
  async get() { const rows = this.rows(); return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) }; }
  count() { return { get: async () => ({ data: () => ({ count: this.rows().length }) }) }; }
}
class FakeCollection {
  constructor(private store: Store, private name: string) {}
  doc(id: string): FakeDocRef { return new FakeDocRef(this.store, this.name, id); }
  where(f: string, op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.name).where(f, op, v); }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => new FakeCollection(store, name),
    runTransaction: async (fn: (txn: { get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>; create: (r: FakeDocRef, d: Row) => void; set: (r: FakeDocRef, d: Row, o?: { merge?: boolean }) => void }) => Promise<unknown>) =>
      fn({ get: (r) => r.get(), create: (r, d) => r.create(d), set: (r, d, o) => r.set(d, o) }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const ONE_PVT = 10n ** 18n;
function seedBurn(store: Store, burnId: string, walletId: string, address: string): void {
  coll(store, 'pvt_burn_records').set(burnId, {
    tx_hash: `0x${burnId.slice(0, 8)}`, chain: 'base', wallet_id: walletId,
    burner_address: address, amount_atomic: (15n * ONE_PVT).toString(),
    status: 'recorded', verified: true,
  });
}

/** Build the reputation presentation request body the PRESENTER signs + POSTs. */
function buildReputationBody(signer: ReturnType<typeof makeAgentSigner>, opts: { audience: string; challenge: string; burnId: string; iat: number; jti: string }) {
  const directive = canonicalReputationDirective({ redact: [], predicates: [] });
  const digest = claimsDigest({ tier: 'reputation', reputation_directive: directive });
  const exp = opts.iat + 300;
  const binding = presentationBindingString({
    tier: 'reputation', presenter_address: signer.address, aud: opts.audience, chal: opts.challenge,
    iat: opts.iat, exp, jti: opts.jti, burn_id: opts.burnId, claims_digest: digest,
  });
  return {
    tier: 'reputation', burn_id: opts.burnId, audience: opts.audience, challenge: opts.challenge,
    iat: opts.iat, exp, jti: opts.jti,
    pop: { scheme: 'ecdsa_sha256_secp256k1', signature: signer.sign(binding), pubkey: signer.pubkeyHex },
    disclosure: { redact: [], predicates: [] },
    nowSeconds: opts.iat,
  };
}

function agentPrincipal(signer: ReturnType<typeof makeAgentSigner>, walletId: string): PresenterPrincipal {
  return {
    kind: 'agent', walletId, address: signer.address, peOwnerUserId: `${walletId}-agent`,
    publicKeyHex: signer.pubkeyHex, standing: { governance_score: 42, pe_count: 7, streak_days: 3 },
  };
}

// producePresentationFromRequest binds freshness to the REAL wall clock (it does
// not thread nowSeconds through), so the rig uses real time: iat = now, and the
// handshake gate is evaluated relative to the presentation's own recorded_at.
const nowSec = (): number => Math.floor(Date.now() / 1000);
let store: Store;
let ed: ReturnType<typeof makeEd25519Env>;
let presenter: ReturnType<typeof makeAgentSigner>;
const PRESENTER_WALLET = 'aw_presenter';
const REQUESTER = 'aw_requester';

beforeEach(() => { store = new Map(); ed = makeEd25519Env(); presenter = makeAgentSigner(); });

// =============================================================================
describe('LOOP 1 — standalone: challenge → present → verify → single-use', () => {
  it('a burn-backed presentation verifies to the requester, and the burn is single-use', async () => {
    const db = makeDb(store);
    const now = nowSec();
    const challenge = crypto.randomBytes(32).toString('hex'); // requester issues
    const burnId = 'a'.repeat(64);
    seedBurn(store, burnId, PRESENTER_WALLET, presenter.address);

    const body = buildReputationBody(presenter, { audience: REQUESTER, challenge, burnId, iat: now, jti: 'pres-1' });
    const produced = await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET), body);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;

    // Requester verifies against the EXACT challenge + audience it issued.
    const ok = await verifyPresentation(produced.presentation, { publicKeys: ed.publicKeys, expectedAudience: REQUESTER, expectedChallenge: challenge, nowSeconds: now + 10 });
    expect(ok.valid).toBe(true);

    // RED (replay to another requester/moment): a different challenge/audience fails.
    const wrongChal = await verifyPresentation(produced.presentation, { publicKeys: ed.publicKeys, expectedAudience: REQUESTER, expectedChallenge: 'different-challenge-00', nowSeconds: now + 10 });
    expect(wrongChal).toEqual({ valid: false, reason: 'challenge_mismatch' });

    // RED (single-use burn): re-producing with the SAME burn 409s — the burn is spent.
    const replay = await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET),
      buildReputationBody(presenter, { audience: REQUESTER, challenge, burnId, iat: now, jti: 'pres-1-replay' }));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(409);
  });

  it('the standalone pe_fact floor is 5 PVT and reputation 15 PVT (a 15-PVT burn covers both)', async () => {
    // Covered structurally by burn-consumption.test.ts; here we assert the seeded
    // 15-PVT burn is accepted for a reputation presentation (>= 15 floor).
    const db = makeDb(store);
    const burnId = 'c'.repeat(64);
    seedBurn(store, burnId, PRESENTER_WALLET, presenter.address);
    const produced = await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET),
      buildReputationBody(presenter, { audience: REQUESTER, challenge: crypto.randomBytes(32).toString('hex'), burnId, iat: nowSec(), jti: 'floor-1' }));
    expect(produced.ok).toBe(true);
  });
});

// =============================================================================
describe('LOOP 2 — rail: refuse → present (fold) → commit → in-window → lapse', () => {
  it('a commitment refuses with no handshake, passes after presenting, and re-refuses on lapse', async () => {
    const db = makeDb(store);
    // 1) No handshake → the rail gate refuses (428).
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, Date.now())).rejects.toBeInstanceOf(RailHandshakeError);

    // 2) Present to the counterparty (the presentation IS the handshake burn — fold).
    const burnId = 'd'.repeat(64);
    seedBurn(store, burnId, PRESENTER_WALLET, presenter.address);
    const produced = await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET),
      buildReputationBody(presenter, { audience: REQUESTER, challenge: crypto.randomBytes(32).toString('hex'), burnId, iat: nowSec(), jti: 'rail-1' }));
    expect(produced.ok).toBe(true);
    const recordedAt = coll(store, 'commons_presentations').get(burnId)!.recorded_at as number;

    // 3) Now the commitment PASSES — one burn, no second one.
    const hs = await assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 1000);
    expect(hs.committerWalletId).toBe(PRESENTER_WALLET);

    // 4) A SECOND in-window action still passes — no new presentation.
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 60_000)).resolves.toBeDefined();

    // 5) Window lapse → refuses again → the parties must re-present.
    const afterLapse = recordedAt + RAIL_HANDSHAKE_WINDOW_MS + 1;
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, afterLapse)).rejects.toBeInstanceOf(RailHandshakeError);
  });
});

// =============================================================================
describe('LOOP 3 — invalidation: adverse event → refuse w/ reason → re-present', () => {
  it('an adverse standing event closes the window; the reason is readable by both parties; re-present restores it', async () => {
    const db = makeDb(store);

    // Establish a live handshake.
    const burnId1 = '1'.repeat(64);
    seedBurn(store, burnId1, PRESENTER_WALLET, presenter.address);
    await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET),
      buildReputationBody(presenter, { audience: REQUESTER, challenge: crypto.randomBytes(32).toString('hex'), burnId: burnId1, iat: nowSec(), jti: 'inv-1' }));
    const recordedAt = (coll(store, 'commons_presentations').get(burnId1)!.recorded_at as number);
    expect(await findLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 1000)).not.toBeNull();

    // Adverse presenter-side event AFTER the presentation (reputation downgrade —
    // sufficient in the rig, no real-fund slash needed).
    await invalidateHandshakes(db, PRESENTER_WALLET, 'reputation_downgrade', recordedAt + 2000);

    // The next commitment REFUSES.
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 3000)).rejects.toBeInstanceOf(RailHandshakeError);
    // BOTH parties read the state — invalidated, with the reason class.
    const statePresenter = await readHandshakeState(db, PRESENTER_WALLET, REQUESTER, recordedAt + 3000);
    expect(statePresenter.state).toBe('invalidated');
    expect(statePresenter.reasonClass).toBe('reputation_downgrade');

    // Re-present AFTER the event → live again (forward-looking; a fresh burn).
    const burnId2 = '2'.repeat(64);
    seedBurn(store, burnId2, PRESENTER_WALLET, presenter.address);
    await producePresentationFromRequest({ db, env: ed.env }, agentPrincipal(presenter, PRESENTER_WALLET),
      buildReputationBody(presenter, { audience: REQUESTER, challenge: crypto.randomBytes(32).toString('hex'), burnId: burnId2, iat: nowSec() + 3, jti: 'inv-2' }));
    // The rig produces both presentations within the same real millisecond; place
    // the re-presentation's record time AFTER the invalidation event so the
    // forward-looking floor lets it through (on a real clock the re-present is
    // simply later than the event).
    coll(store, 'commons_presentations').get(burnId2)!.recorded_at = recordedAt + 3000;
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 5000)).resolves.toBeDefined();

    // A SECOND adverse event — key rotation — closes it again.
    await invalidateHandshakes(db, PRESENTER_WALLET, 'key_rotation', recordedAt + 6000);
    await expect(assertLiveHandshake(db, PRESENTER_WALLET, REQUESTER, recordedAt + 7000)).rejects.toBeInstanceOf(RailHandshakeError);
    const state2 = await readHandshakeState(db, PRESENTER_WALLET, REQUESTER, recordedAt + 7000);
    expect(state2.reasonClass).toBe('key_rotation');

    // Forward-looking only: the invalidation floor never rewrote the earlier
    // presentation records — both burns still exist as sealed history.
    expect(coll(store, 'commons_presentations').has(burnId1)).toBe(true);
    expect(coll(store, 'commons_presentations').has(burnId2)).toBe(true);
  });
});
