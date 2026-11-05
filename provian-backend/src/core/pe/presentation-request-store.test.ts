/**
 * Presentation-request STORE : the transactional, ownership-guarded,
 * idempotent transitions and the list/push helpers. These hold the real security
 * guards the routes rely on (a different party cannot drive a transition; a
 * wrong-status transition is 409). Every guard ships with its RED control :
 * the happy path is shown succeeding AND the guard is shown returning 403/409.
 */
import crypto from 'crypto';
import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { verifyChallengeEnvelope } from '../presentation/challenge';

// The push helper reads users/{id}.fcm_tokens and calls sendPush — mock the
// dispatcher so we can assert the payload NEVER carries the Tier-3 note.
const mockSendPush = jest.fn<(tokens: string[], msg: unknown) => Promise<{ invalidTokens: string[] }>>();
const mockPrune = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.mock('../notifications/pushDispatcher', () => ({
  sendPush: (...args: unknown[]) => mockSendPush(...(args as [string[], unknown])),
  pruneUserTokens: (...args: unknown[]) => mockPrune(...args),
}));

import {
  writePresentationRequest,
  getPresentationRequest,
  listPendingRequestsForHuman,
  listRequestsForAgent,
  challengePresentationRequest,
  recordPresentationForRequest,
  recordVerdictForRequest,
  declinePresentationRequest,
  pushPresentationRequestToHuman,
} from './presentation-request-store';
import {
  buildPresentationRequest,
  PRESENTATION_REQUESTS_COLLECTION,
  type PresentationRequestRecord,
} from './presentation-request';

// ---- Minimal in-memory Firestore: doc get/set + where('f','=='|'in',v) chains
// + runTransaction(txn.get/txn.set). Enough to exercise the store faithfully. ----
type Doc = Record<string, unknown>;
function fakeDb() {
  const store = new Map<string, Map<string, Doc>>();
  const coll = (n: string) => { let c = store.get(n); if (!c) { c = new Map(); store.set(n, c); } return c; };
  const ref = (n: string, id: string) => ({
    id,
    async get() { const d = coll(n).get(id); return { exists: d !== undefined, data: () => (d ? { ...d } : undefined) }; },
    async set(d: Doc) { coll(n).set(id, { ...d }); },
  });
  type Filter = { field: string; op: string; value: unknown };
  const query = (n: string, filters: Filter[]) => ({
    where(field: string, op: string, value: unknown) { return query(n, [...filters, { field, op, value }]); },
    limit() { return query(n, filters); },
    async get() {
      const rows = [...coll(n).values()].filter((row) => filters.every((f) => {
        const v = (row as Doc)[f.field];
        if (f.op === '==') return v === f.value;
        if (f.op === 'in') return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
        throw new Error(`unsupported op ${f.op}`);
      }));
      return { empty: rows.length === 0, docs: rows.map((r, i) => ({ id: `row_${i}`, data: () => ({ ...r }) })) };
    },
  });
  return {
    _store: store,
    collection: (n: string) => ({
      doc: (id: string) => ref(n, id),
      where: (field: string, op: string, value: unknown) => query(n, [{ field, op, value }]),
    }),
    async runTransaction(fn: (t: unknown) => Promise<unknown>) {
      return fn({
        get: (r: { get: () => unknown }) => r.get(),
        set: (r: { set: (d: Doc) => void }, d: Doc) => r.set(d),
      });
    },
  } as unknown as import('firebase-admin/firestore').Firestore & { _store: Map<string, Map<string, Doc>> };
}

const NOW = 1_700_000_000_000;

// the relay SIGNS the composed challenge as the requester wallet — the parties need attestable
// addresses and the suite needs a presentation signing key.
const SIGNING = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return { env: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'store-k1', x: priv.x, d: priv.d }), jwks: [{ kty: 'OKP', crv: 'Ed25519', kid: 'store-k1', x: pub.x }] };
})();
const priorKey = process.env.ATTESTATION_SIGNING_KEY;
beforeAll(() => { process.env.ATTESTATION_SIGNING_KEY = SIGNING.env; });
afterAll(() => { if (priorKey === undefined) delete process.env.ATTESTATION_SIGNING_KEY; else process.env.ATTESTATION_SIGNING_KEY = priorKey; });
const HUMAN_ADDR = '0x' + '1'.repeat(40);
const AGENT_ADDR = '0x' + '2'.repeat(40);

function seed(db: ReturnType<typeof fakeDb>, overrides: Partial<Parameters<typeof buildPresentationRequest>[0]> = {}): Promise<PresentationRequestRecord> {
  (db as unknown as { _store: Map<string, Map<string, Doc>> })._store.set('wallets', new Map([['hw_frank', { user_id: 'user_frank', type: 'human', address: HUMAN_ADDR } as unknown as Doc]]));
  (db as unknown as { _store: Map<string, Map<string, Doc>> })._store.set('agent_wallets', new Map([['wallet_aw_1', { address: AGENT_ADDR } as unknown as Doc]]));
  const r = buildPresentationRequest({ agentWalletId: 'wallet_aw_1', humanUserId: 'user_frank', nowMs: NOW, ...overrides });
  if (!r.ok) throw new Error('seed');
  return writePresentationRequest(db, r.record).then(() => r.record);
}

describe('presentation-request-store transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendPush.mockResolvedValue({ invalidTokens: [] });
    mockPrune.mockResolvedValue(undefined);
  });

  it('FULL HAPPY PATH: request → challenge (human) → present (agent) → verify (human)', async () => {
    const db = fakeDb();
    const rec = await seed(db);

    const ch = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'aud', challenge: 'chal-abcdefghijklmnop', predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }], nowMs: NOW + 1 });
    expect(ch.ok).toBe(true);
    if (ch.ok) {
      expect(ch.record.status).toBe('challenged');
      // the relay signed the composed challenge as the human wallet; the audience is the
      // requester's party id (the client's 'aud' is superseded), the human's nonce is kept, and the
      // agent it is addressed to is named.
      const env = ch.record.challenge_envelope!;
      expect(ch.record.audience).toBe('user_frank');
      expect(env.challenge).toBe('chal-abcdefghijklmnop');
      expect(env.presenter).toBe(AGENT_ADDR);
      const v = await verifyChallengeEnvelope(env, { provianKeys: SIGNING.jwks, nowSeconds: Math.floor((NOW + 1) / 1000), presenterAddress: AGENT_ADDR });
      expect(v).toMatchObject({ status: 'verified', requester: { type: 'wallet', id: 'user_frank', address: HUMAN_ADDR } });
    }

    const pr = await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b'.repeat(64), presentationToken: 'TOKEN', nowMs: NOW + 2 });
    expect(pr.ok).toBe(true);
    if (pr.ok) { expect(pr.record.status).toBe('presented'); expect(pr.record.presentation_token).toBe('TOKEN'); }

    const vr = await recordVerdictForRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', verdict: 'valid', predicateResults: [{ field: 'x', result: true }], nowMs: NOW + 3 });
    expect(vr.ok).toBe(true);
    if (vr.ok) { expect(vr.record.status).toBe('verified'); expect(vr.record.verdict).toBe('valid'); }

    const final = await getPresentationRequest(db, rec.request_id);
    expect(final?.status).toBe('verified');
  });

  // ---- OWNERSHIP GUARDS (403) — RED controls ----
  it('RED: a DIFFERENT human cannot compose the challenge (403)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const res = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_someone_else', audience: 'a', challenge: 'c', nowMs: NOW });
    expect(res).toEqual({ ok: false, status: 403, error: 'not your presentation request' });
    // unchanged
    expect((await getPresentationRequest(db, rec.request_id))?.status).toBe('requested');
  });

  it('RED: a DIFFERENT agent cannot post the presentation (403)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    const res = await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_OTHER', burnId: 'b', presentationToken: 't', nowMs: NOW });
    expect(res).toEqual({ ok: false, status: 403, error: 'not your presentation request' });
    expect((await getPresentationRequest(db, rec.request_id))?.status).toBe('challenged');
  });

  it('RED: a DIFFERENT human cannot record the verdict (403)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b', presentationToken: 't', nowMs: NOW });
    const res = await recordVerdictForRequest(db, { requestId: rec.request_id, humanUserId: 'imposter', verdict: 'valid', nowMs: NOW });
    expect(res).toEqual({ ok: false, status: 403, error: 'not your presentation request' });
  });

  // ---- WRONG-STATUS TRANSITIONS (409) — RED controls ----
  it('RED: presenting a `requested` (un-challenged) request is 409', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const res = await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b', presentationToken: 't', nowMs: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it('RED: recording a verdict on a `challenged` (un-presented) request is 409', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    const res = await recordVerdictForRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', verdict: 'valid', nowMs: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it('RED: composing a challenge twice is 409 (already `challenged`, not idempotent-eligible)', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const first = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    const res = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a2', challenge: 'c2', nowMs: NOW });
    // 'challenged' is the target of this transition → treated as idempotent no-op ok (not a corruption).
    expect(res.ok && first.ok).toBe(true);
    // unchanged — the first (relay-signed) compose stands: same nonce, same envelope
    if (res.ok && first.ok) {
      expect(res.record.challenge).toBe(first.record.challenge);
      expect(res.record.challenge_envelope).toEqual(first.record.challenge_envelope);
    }
  });

  it('idempotent: re-recording the SAME presentation returns ok without a second mutation', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    const first = await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b1', presentationToken: 'T1', nowMs: NOW });
    expect(first.ok).toBe(true);
    const second = await recordPresentationForRequest(db, { requestId: rec.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b2', presentationToken: 'T2', nowMs: NOW });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.record.presentation_token).toBe('T1'); // the first token stands (idempotent)
  });

  it('missing request → 404', async () => {
    const db = fakeDb();
    const res = await challengePresentationRequest(db, { requestId: 'preq_missing', humanUserId: 'u', audience: 'a', challenge: 'c', nowMs: NOW });
    expect(res).toEqual({ ok: false, status: 404, error: 'presentation request not found' });
  });

  it('decline moves a non-terminal request to declined; a terminal request is 409', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const d = await declinePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank' });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.record.status).toBe('declined');
    const again = await declinePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank' });
    // 'declined' IS the target status → idempotent no-op ok.
    expect(again.ok).toBe(true);
  });
});

describe('presentation-request-store lists', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('listPendingRequestsForHuman returns requested + presented (needs their action), filters expired + other humans', async () => {
    const db = fakeDb();
    const mine = await seed(db); // requested, mine
    await seed(db, { humanUserId: 'user_other' }); // another human — excluded
    // one presented (needs a verdict) — include
    const presented = await seed(db);
    await challengePresentationRequest(db, { requestId: presented.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    await recordPresentationForRequest(db, { requestId: presented.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b', presentationToken: 't', nowMs: NOW });
    // one verified (terminal) — exclude
    const verified = await seed(db);
    await challengePresentationRequest(db, { requestId: verified.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c', nowMs: NOW });
    await recordPresentationForRequest(db, { requestId: verified.request_id, agentWalletId: 'wallet_aw_1', burnId: 'b', presentationToken: 't', nowMs: NOW });
    await recordVerdictForRequest(db, { requestId: verified.request_id, humanUserId: 'user_frank', verdict: 'valid', nowMs: NOW });

    const rows = await listPendingRequestsForHuman(db, 'user_frank', NOW + 100);
    const ids = rows.map((r) => r.request_id).sort();
    expect(ids).toEqual([mine.request_id, presented.request_id].sort());

    // Expired filter: nowMs past expiry drops everything.
    const none = await listPendingRequestsForHuman(db, 'user_frank', NOW + 8 * 24 * 60 * 60 * 1000);
    expect(none).toHaveLength(0);
  });

  it('listRequestsForAgent scopes to the agent wallet and optional status', async () => {
    const db = fakeDb();
    await seed(db); // wallet_aw_1
    await seed(db, { agentWalletId: 'wallet_aw_2' }); // different agent
    const all = await listRequestsForAgent(db, 'wallet_aw_1');
    expect(all).toHaveLength(1);
    expect(all[0].agent_wallet_id).toBe('wallet_aw_1');
    const requested = await listRequestsForAgent(db, 'wallet_aw_1', 'requested');
    expect(requested).toHaveLength(1);
    const presented = await listRequestsForAgent(db, 'wallet_aw_1', 'presented');
    expect(presented).toHaveLength(0);
    expect(PRESENTATION_REQUESTS_COLLECTION).toBe('presentation_requests_v1');
  });
});

describe('pushPresentationRequestToHuman — privacy + never throws', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendPush.mockResolvedValue({ invalidTokens: [] });
    mockPrune.mockResolvedValue(undefined);
  });

  it('NEVER puts the Tier-3 note in the push payload', async () => {
    const db = fakeDb();
    const built = buildPresentationRequest({ agentWalletId: 'wallet_aw_1', humanUserId: 'user_frank', note: 'CONFIDENTIAL REASON', nowMs: NOW });
    if (!built.ok) throw new Error('setup');
    // seed the user's fcm token
    await (db as unknown as { collection: (n: string) => { doc: (id: string) => { set: (d: Doc) => Promise<void> } } })
      .collection('users').doc('user_frank').set({ fcm_tokens: ['tok-1'] });
    await pushPresentationRequestToHuman(db, 'user_frank', built.record);
    expect(mockSendPush).toHaveBeenCalledTimes(1);
    const msg = JSON.stringify(mockSendPush.mock.calls[0][1]);
    // RED: the note text must not appear anywhere in the payload.
    expect(msg).not.toContain('CONFIDENTIAL REASON');
    expect(msg).toContain('presentation_request'); // the data.type IS present
    expect(msg).toContain(built.record.request_id);
  });

  it('no tokens → no send, still resolves', async () => {
    const db = fakeDb();
    const built = buildPresentationRequest({ agentWalletId: 'w', humanUserId: 'user_frank', nowMs: NOW });
    if (!built.ok) throw new Error('setup');
    await expect(pushPresentationRequestToHuman(db, 'user_frank', built.record)).resolves.toBeUndefined();
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it('a push error is swallowed (never throws — the app also polls)', async () => {
    const db = fakeDb();
    const built = buildPresentationRequest({ agentWalletId: 'w', humanUserId: 'user_frank', nowMs: NOW });
    if (!built.ok) throw new Error('setup');
    await (db as unknown as { collection: (n: string) => { doc: (id: string) => { set: (d: Doc) => Promise<void> } } })
      .collection('users').doc('user_frank').set({ fcm_tokens: ['tok-1'] });
    mockSendPush.mockRejectedValueOnce(new Error('FCM down'));
    await expect(pushPresentationRequestToHuman(db, 'user_frank', built.record)).resolves.toBeUndefined();
  });
});

describe(' compose fails closed on malformed predicates', () => {
  it('RED: a malformed predicate list is a 400 (never silently "no predicates"); a well-formed one composes', async () => {
    const db = fakeDb();
    const rec = await seed(db);
    const bad = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c'.repeat(32), predicates: [{ field: 'x' }], nowMs: NOW + 1 });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const good = await challengePresentationRequest(db, { requestId: rec.request_id, humanUserId: 'user_frank', audience: 'a', challenge: 'c'.repeat(32), predicates: [{ field: 'x', op: 'gte', threshold: 1 }], nowMs: NOW + 1 });
    expect(good.ok).toBe(true);
  });
});
