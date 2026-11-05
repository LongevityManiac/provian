/**
 * THREADS: bilateral Commons communication.
 *
 * - a cold contact (profile anchor, no relationship, no window) is REFUSED 428 naming whom to
 * present to; a live window opener → target opens it;
 * - a thread inside a shared artifact (escrow) is free — no window needed;
 * - every message seals a `commons_thread_message` PE carrying ONLY the content hash; the
 * ciphertext is stored per party and never hashed into the PE;
 * - a message mints ONLY under the author's live pass (a presentation to provian:commons),
 * durable + budgeted; with no pass it records (the accrual seals it record_only,
 * speech_no_live_pass_record_only) — a presentation to the counterparty opens the
 * relationship for sending but is not the pass;
 * - a presentation request travels inside the thread (relay-composed audience = requester id,
 * fresh nonce) and the presenter answers with verify-at-submit; the outcome rides the thread;
 * - only parties read/write; a non-party is refused;
 * - the deliverable message lands in the job thread.
 */
import crypto from 'crypto';
import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { verifyChallengeEnvelope, type ChallengeEnvelope } from '../presentation/challenge';

const accrualCalls: Array<Record<string, unknown>> = [];
// These assertions inspect asynchronous pricing, which follows the committed message/intake.
async function accrualFor(peId: string): Promise<Record<string, unknown>> {
  for (let turn = 0; turn < 20; turn++) {
    const call = accrualCalls.find(c => c.peId === peId);
    if (call) return call;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Committed message never reached pricing: ${peId}`);
}
const mockVerify = jest.fn<(...args: unknown[]) => Promise<{ verdict: string; predicate_results: unknown[]; reason?: string; presenter?: { sub: string; presenter_address: string; burn_id: string } }>>();
jest.mock('../pe/presentation-submit-verify', () => ({
  verifyFreshPresentationToken: (...args: unknown[]) => mockVerify(...args),
}));

import {
  getThread,
  listMessages,
  listThreads,
  markRead,
  normalizeDeliverable,
  openThread,
  pendingThreadPresentationRequestsFor,
  postDeliverableMessage,
  postMessage,
  presentInThread,
  requestPresentationInThread,
} from './threads';
import { SpeechWindowRequiredError } from './speech-window';
import { ForbiddenError, ValidationError } from '../agent-bank/errors';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { relayIntakes } from '../pvt/__test-helpers__/meter-acts';
import { seedBurn } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS } from './types';
import { PRESENTATION_REQUESTS_COLLECTION } from '../pe/presentation-request';

const A = 'wallet_aw_alpha';
const B = 'wallet_aw_beta';
const H = 'user_h';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const BURN = 'f'.repeat(64);
const FIVE = 5_000_000_000_000_000_000n;
const HASH = '9'.repeat(64);
const CT = 'AQIDBA'; // base64url

function deps(db: FakeFirestore): AgentBankDeps {
  return { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) }, peBuffer: { enqueue: () => {} }, recordPEAccrual: async (p: Record<string, unknown>) => { accrualCalls.push(p); } } as unknown as AgentBankDeps;
}
const actor = (id: string) => ({ walletId: id, agentId: `agent_${id}`, actorAddress: `0x${id}`, isAgent: id.startsWith('wallet_aw_') });

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_H = '0x' + 'c'.repeat(40);
function seedParties(db: FakeFirestore): void {
  db.store.set(`agent_wallets/${A}`, { id: A, agent_id: 'agent_a', address: ADDR_A, status: 'active' });
  db.store.set(`agent_wallets/${B}`, { id: B, agent_id: 'agent_b', address: ADDR_B, status: 'active' });
  db.store.set(`users/${H}`, { id: H });
  db.store.set('wallets/hw_1', { user_id: H, type: 'human', address: ADDR_H });
}

// thread presentation requests are SIGNED by the relay (wallet requester) with the Provian
// presentation key — the suite runs with a test key and verifies envelopes against its JWKS.
const SIGNING = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    env: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'thread-test-k1', x: priv.x, d: priv.d }),
    jwks: [{ kty: 'OKP', crv: 'Ed25519', kid: 'thread-test-k1', x: pub.x }],
  };
})();
const priorSigningKey = process.env.ATTESTATION_SIGNING_KEY;
beforeAll(() => { process.env.ATTESTATION_SIGNING_KEY = SIGNING.env; });
afterAll(() => { if (priorSigningKey === undefined) delete process.env.ATTESTATION_SIGNING_KEY; else process.env.ATTESTATION_SIGNING_KEY = priorSigningKey; });
function seedPresentation(db: FakeFirestore, walletId: string, audience: string, recordedAt: number, burnId = BURN): void {
  db.store.set(`commons_presentations/pres_${walletId}_${audience}`, { wallet_id: walletId, audience, recorded_at: recordedAt, burn_id: burnId, presentation_id: 'jti_1', tier: 'pe_fact' });
}
const text = (to: string) => ({ kind: 'text' as const, ciphertexts: { [to]: CT }, content_sha256: HASH });
// PE METER (2026-10-03): the relay keeps no readable PE. Each message's act is staged in the tip
// transaction as an intake (the stub accrual never prices it): its act record carries the PE's pricing
// projection (every field but identity and free text — metadata, output_digests) and its accrual
// inputs carry the witness class. This view projects exactly those, plus the whole intake, so a
// content leak anywhere in what the relay keeps still fails the no-content assertions.
const peDocs = (db: FakeFirestore): Array<Record<string, unknown>> => relayIntakes(db.store).map((i) => ({
  ...i.act.pricing,
  pe_id: i.pe_id,
  action_type: i.act.action_type,
  witness_class: i.accrual.witnessClass,
  intake: i,
}));

let db: FakeFirestore;
beforeEach(() => {
  accrualCalls.length = 0;
  mockVerify.mockReset();
  db = createFakeFirestore();
  seedParties(db);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('opening a thread — a presentation opens a voice, once', () => {
  it('RED: a cold contact (profile anchor, strangers, no window) is refused 428 naming the target to present to', async () => {
    const err = await openThread(deps(db), actor(A), { anchor: { kind: 'profile', id: B }, message: text(B) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechWindowRequiredError);
    expect((err as SpeechWindowRequiredError).presentTo).toBe(B);
    expect(peDocs(db)).toHaveLength(0);
    expect([...db.store.keys()].some((k) => k.startsWith(`${COMMONS_COLLECTIONS.THREADS}/`))).toBe(false);
  });

  it('a live window opener → target (one burn-to-present) opens the cold contact; with no commons PASS the first message records, it does not mint (2026-09-23)', async () => {
    seedPresentation(db, A, B, NOW - DAY);
    seedBurn(db, BURN, A, FIVE);
    const out = await openThread(deps(db), actor(A), { anchor: { kind: 'profile', id: B }, message: text(B) });
    expect(out.created).toBe(true);
    expect(out.thread.backing).toEqual({ kind: 'relationship' });
    expect(out.thread.party_a < out.thread.party_b).toBe(true);
    // the pairwise presentation opened the relationship (sending) — it is not the pass (minting)
    expect(out.message.minted_under_window).toBe(false);
    const call = await accrualFor(out.message.pe_id);
    expect(call?.durableReplaySource).toBeDefined();
    expect(call?.speechWindow ?? null).toBeNull();
  });

  it('a thread inside a shared escrow is free — no window, backed by the anchor', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const out = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    expect(out.created).toBe(true);
    expect(out.thread.backing).toEqual({ kind: 'anchor' });
    expect(out.thread.parties[B]).toEqual({ kind: 'agent', id: B });
    // deterministic id: reopening from the other side lands in the SAME thread
    jest.mocked(Date.now).mockReturnValue(NOW + 1);
    const again = await openThread(deps(db), actor(B), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(A) });
    expect(again.created).toBe(false);
    expect(again.thread.thread_id).toBe(out.thread.thread_id);
    expect((await listMessages(deps(db), out.thread)).map((m) => m.author_id)).toEqual([A, B]);
  });

  it('RED: a non-party cannot open an escrow thread', async () => {
    db.store.set('escrows/esc_2', { depositor_wallet_id: A, recipient_wallet_id: H });
    await expect(openThread(deps(db), actor(B), { anchor: { kind: 'escrow', id: 'esc_2' }, message: text(A) })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('RED: an applicant (stranger to the job, no relationship, no window) is a COLD CONTACT — refused 428 (negative control)', async () => {
    db.store.set('jobs/job_1', { poster_wallet_id: A, assigned_wallet_id: null, status: 'open' });
    const err = await openThread(deps(db), actor(B), { anchor: { kind: 'job', id: 'job_1' }, message: text(A) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechWindowRequiredError);
    expect((err as SpeechWindowRequiredError).presentTo).toBe(A);
    expect([...db.store.keys()].some((k) => k.startsWith(`${COMMONS_COLLECTIONS.THREADS}/`))).toBe(false);
    // The same stranger with a live COMMONS window (the one burn that prices every Commons write) is admitted.
    seedPresentation(db, B, 'provian:commons', NOW - DAY);
    seedBurn(db, BURN, B, FIVE);
    const out = await openThread(deps(db), actor(B), { anchor: { kind: 'job', id: 'job_1' }, message: text(A) });
    expect(out.thread.parties[A]).toBeDefined();
    expect(out.thread.opened_by).toBe(B);
    expect(out.message.minted_under_window).toBe(true);
  });

  it('RED (round 2): a poster naming ANY wallet on its own unassigned job / want is a COLD CONTACT — the one-sided anchor is not a relationship', async () => {
    const Z = 'wallet_aw_zulu';
    db.store.set(`agent_wallets/${Z}`, { id: Z, agent_id: 'agent_z', address: '0xz', status: 'active' });
    db.store.set('jobs/job_p', { poster_wallet_id: A, assigned_wallet_id: null, status: 'open' });
    db.store.set('commons_wants/want_p', { poster_wallet_id: A, matched_fulfiller_wallet_id: null, status: 'open' });
    for (const anchor of [{ kind: 'job' as const, id: 'job_p' }, { kind: 'want' as const, id: 'want_p' }]) {
      const err = await openThread(deps(db), actor(A), { anchor, counterparty: Z, message: text(Z) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpeechWindowRequiredError);
      expect((err as SpeechWindowRequiredError).presentTo).toBe(Z);
    }
    expect([...db.store.keys()].some((k) => k.startsWith(`${COMMONS_COLLECTIONS.THREADS}/`))).toBe(false);
  });

  it('a named party of the anchor (the assigned worker) needs no window — the shared job IS the relationship', async () => {
    db.store.set('jobs/job_2', { poster_wallet_id: A, assigned_wallet_id: B, status: 'in_progress' });
    const out = await openThread(deps(db), actor(B), { anchor: { kind: 'job', id: 'job_2' }, message: text(A) });
    expect(out.created).toBe(true);
    expect(out.thread.backing).toEqual({ kind: 'anchor' });
  });
});

describe('messages — the PE carries the content hash, never the content', () => {
  it('seals commons_thread_message with content_sha256 + an artifact digest; stores the ciphertext per party', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const out = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    const pes = peDocs(db);
    expect(pes).toHaveLength(1);
    const pe = pes[0] as { action_type: string; metadata?: Record<string, unknown>; output_digests?: Array<{ hash: string }> };
    expect(pe.action_type).toBe('commons_thread_message');
    expect(pe.metadata?.content_sha256).toBe(HASH);
    expect(JSON.stringify(pe)).not.toContain(CT);
    expect(pe.output_digests?.[0]?.hash).toBe(`sha256:${HASH}`);
    const stored = db.store.get(`commons_thread_messages/${out.message.message_id}`) as { ciphertexts: Record<string, string> };
    expect(stored.ciphertexts).toEqual({ [B]: CT });
    // no pass, open relationship (the escrow) → sending is free, but the PE carries NO pass: it is
    // durable (so it records under its own reason) and the accrual seals it record_only
    // (speech_no_live_pass_record_only) — no pass, no mint.
    expect(out.message.minted_under_window).toBe(false);
    const call = await accrualFor(out.message.pe_id);
    expect(call).toBeDefined();
    expect(call?.durableReplaySource).toBeDefined();
    expect(call?.speechWindow ?? null).toBeNull();
  });

  it('a message under the author\'s live commons window is minted (durable + budgeted)', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    seedPresentation(db, A, 'provian:commons', NOW - DAY);
    seedBurn(db, BURN, A, FIVE);
    const out = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    expect(out.message.minted_under_window).toBe(true);
    const call = await accrualFor(out.message.pe_id);
    expect(call?.durableReplaySource).toBeDefined();
    expect((call?.speechWindow as { burnId?: string } | undefined)?.burnId).toBe(BURN);
  });

  it('RED: a ciphertext addressed to a non-party, a malformed hash, and a bare text message are refused', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    await expect(postMessage(deps(db), actor(A), thread, { ciphertexts: { [H]: CT }, content_sha256: HASH })).rejects.toThrow(/non-party/);
    await expect(postMessage(deps(db), actor(A), thread, { ciphertexts: { [B]: CT }, content_sha256: 'nope' })).rejects.toThrow(/content_sha256/);
    await expect(postMessage(deps(db), actor(A), thread, { ciphertexts: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(postMessage(deps(db), actor(H), thread, text(B))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getThread(deps(db), thread.thread_id, H)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the read loop : up_to marks read only through the newest message shown — never past now, never backwards', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    const cursor = () => (db.store.get(`commons_threads/${thread.thread_id}`) as { read_cursors: Record<string, number> }).read_cursors[B];
    await markRead(deps(db), thread, B, 5_000, 3_000);
    expect(cursor()).toBe(3_000);
    await markRead(deps(db), thread, B, 5_000, 2_000); // older than the cursor: unchanged
    expect(cursor()).toBe(3_000);
    await markRead(deps(db), thread, B, 5_000, 9_000); // in the future: clamped to now
    expect(cursor()).toBe(5_000);
    await markRead(deps(db), thread, B, 6_000); // no up_to: everything, as before
    expect(cursor()).toBe(6_000);
    await expect(markRead(deps(db), thread, B, 7_000, -1)).rejects.toBeInstanceOf(ValidationError);
    await expect(markRead(deps(db), thread, B, 7_000, 1.5)).rejects.toBeInstanceOf(ValidationError);
    await expect(markRead(deps(db), thread, H, 7_000, 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('sending preserves an unread incoming message committed after the caller read the thread', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    // A's caller holds the old caught-up snapshot while B's incoming message commits.
    jest.mocked(Date.now).mockReturnValue(NOW + 1);
    await postMessage(deps(db), actor(B), thread, text(A));
    jest.mocked(Date.now).mockReturnValue(NOW); // delayed send captured its time before the incoming commit
    await postMessage(deps(db), actor(A), thread, text(B));
    const latest = await getThread(deps(db), thread.thread_id, A);
    expect(latest.read_cursors[A]).toBe(NOW);
    expect(latest.last_message_at).toBe(NOW + 2);
    expect((await listThreads(deps(db), A))[0].unread).toBe(true);
    // Healthy control: once bounded reading catches up, a self-only send stays read.
    await markRead(deps(db), latest, A, NOW + 2, NOW + 2);
    jest.mocked(Date.now).mockReturnValue(NOW + 3);
    await postMessage(deps(db), actor(A), latest, text(B));
    expect((await getThread(deps(db), thread.thread_id, A)).read_cursors[A]).toBe(NOW + 3);
  });

  it('listThreads marks unread for the counterparty and read for the author', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    expect((await listThreads(deps(db), B))[0].unread).toBe(true);
    expect((await listThreads(deps(db), A))[0].unread).toBe(false);
  });
});

describe('presentations inside a thread (any two wallets)', () => {
  it('request → present (verify-at-submit) → verified; both ride the thread; the audience is the requester\'s id', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    jest.mocked(Date.now).mockReturnValue(NOW + 1);
    const req = await requestPresentationInThread(deps(db), actor(A), thread, { tier: 'reputation', predicates: [{ field: 'work.sealed_count', op: 'gte', threshold: 3 }] });
    expect(req.request.status).toBe('challenged');
    expect(req.request.audience).toBe(A);
    expect(req.request.requester_id).toBe(A);
    expect(req.request.presenter_id).toBe(B);
    expect(req.request.thread_id).toBe(thread.thread_id);
    expect(req.message.kind).toBe('presentation_request');
    expect((req.message.attachment as { request_id: string }).request_id).toBe(req.request.request_id);
    // the request carries a relay-SIGNED challenge naming the requester wallet + the addressed
    // presenter; it verifies against the Provian JWKS, and its deadline is the request's expiry.
    const env = (req.message.attachment as { challenge_envelope: ChallengeEnvelope }).challenge_envelope;
    expect(env).toEqual(req.request.challenge_envelope);
    expect(env.challenge).toBe(req.request.challenge);
    expect(env.presenter).toBe(ADDR_B);
    expect(env.expiresAt).toBe(Math.floor(req.request.expires_at_ms / 1000));
    const verdict = await verifyChallengeEnvelope(env, { provianKeys: SIGNING.jwks, nowSeconds: Math.floor(NOW / 1000), presenterAddress: ADDR_B });
    expect(verdict).toMatchObject({ status: 'verified', requester: { type: 'wallet', id: A, address: ADDR_A } });
    // RED twin: a different presenter sees it as not addressed to them.
    expect((await verifyChallengeEnvelope(env, { provianKeys: SIGNING.jwks, nowSeconds: Math.floor(NOW / 1000), presenterAddress: ADDR_A })).status).toBe('not_addressed');

    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { sub: B, presenter_address: `0x${B}`.toLowerCase(), burn_id: BURN }, predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: true }] });
    jest.mocked(Date.now).mockReturnValue(NOW + 2);
    const out = await presentInThread(deps(db), actor(B), thread, req.request.request_id, { burn_id: BURN, presentation_token: 'tok' }, { publicKeys: [], peAnchorContract: null });
    expect(out.request.status).toBe('verified');
    expect(out.request.verdict).toBe('valid');
    expect(out.message.kind).toBe('presentation');
    const [input] = mockVerify.mock.calls[0] as [{ audience: string; challenge: string }];
    expect(input.audience).toBe(A);
    expect(input.challenge).toBe(req.request.challenge);
    const kinds = (await listMessages(deps(db), thread)).map((m) => m.kind);
    expect(kinds).toEqual(['text', 'presentation_request', 'presentation']);
  });

  it('RED: only the requested presenter can present; the requester cannot answer its own request', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    const req = await requestPresentationInThread(deps(db), actor(A), thread, { tier: 'pe_fact' });
    await expect(presentInThread(deps(db), actor(A), thread, req.request.request_id, { burn_id: BURN, presentation_token: 'tok' }, { publicKeys: [], peAnchorContract: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('RED: the requested presenter cannot hand in a THIRD PARTY\'s valid token (presenter.sub ≠ submitter)', async () => {
    db.store.set('escrows/esc_p2', { depositor_wallet_id: A, recipient_wallet_id: B });
    const opened = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_p2' }, message: text(B) });
    const req = await requestPresentationInThread(deps(db), actor(A), opened.thread, { tier: 'reputation', predicates: [{ field: 'work.sealed_count', op: 'gte', threshold: 1 }] });
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { sub: A, presenter_address: `0x${A}`.toLowerCase(), burn_id: BURN }, predicate_results: [{ result: true }] });
    await expect(presentInThread(deps(db), actor(B), opened.thread, req.request.request_id, { burn_id: BURN, presentation_token: 'tok' }, { publicKeys: [], peAnchorContract: null })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a human ↔ agent request composes the human\'s user id as the audience', async () => {
    db.store.set('escrows/esc_3', { depositor_wallet_id: H, recipient_wallet_id: A });
    const { thread } = await openThread(deps(db), actor(H), { anchor: { kind: 'escrow', id: 'esc_3' }, message: text(A) });
    const req = await requestPresentationInThread(deps(db), actor(H), thread, { tier: 'reputation', predicates: [] });
    expect(req.request.audience).toBe(H);
    expect(req.request.requester_kind).toBe('human');
    expect(req.request.presenter_kind).toBe('agent');
    // a human requester is attested by its first-party wallet address.
    expect(req.request.challenge_envelope?.requester).toEqual({ type: 'wallet', id: H, address: ADDR_H, kid: 'thread-test-k1' });
  });

  it('RED : a requester with no attestable address cannot issue a request (the challenge could not be signed)', async () => {
    db.store.set(`agent_wallets/${A}`, { id: A, agent_id: 'agent_a', address: 'not-an-address', status: 'active' });
    db.store.set('escrows/esc_4', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_4' }, message: text(B) });
    await expect(requestPresentationInThread(deps(db), actor(A), thread, { tier: 'pe_fact' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe(' item 9 — the bell: thread presentation requests waiting on me', () => {
  it('lists a challenged request addressed to the viewer until it is presented; never the requester\'s own', async () => {
    db.store.set('escrows/esc_b1', { depositor_wallet_id: H, recipient_wallet_id: A });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_b1' }, message: text(H) });
    const req = await requestPresentationInThread(deps(db), actor(A), thread, { tier: 'reputation', predicates: [{ field: 'work.sealed_count', op: 'gte', threshold: 1 }] });

    const forHuman = await pendingThreadPresentationRequestsFor(deps(db), H, NOW);
    expect(forHuman.map((r) => r.request_id)).toEqual([req.request.request_id]);
    // The requester is not waiting on itself.
    expect(await pendingThreadPresentationRequestsFor(deps(db), A, NOW)).toEqual([]);

    // Presented → verified → it leaves the list (the bell clears).
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { sub: H, presenter_address: `0x${H}`.toLowerCase(), burn_id: BURN }, predicate_results: [{ result: true }] });
    await presentInThread(deps(db), actor(H), thread, req.request.request_id, { burn_id: BURN, presentation_token: 'tok' }, { publicKeys: [], peAnchorContract: null });
    expect(await pendingThreadPresentationRequestsFor(deps(db), H, NOW)).toEqual([]);
  });

  it('an expired request leaves the list (the bell clears on expiry)', async () => {
    db.store.set('escrows/esc_b2', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_b2' }, message: text(B) });
    const req = await requestPresentationInThread(deps(db), actor(A), thread, { tier: 'pe_fact' });
    expect((await pendingThreadPresentationRequestsFor(deps(db), B, NOW)).length).toBe(1);
    expect(await pendingThreadPresentationRequestsFor(deps(db), B, req.request.expires_at_ms)).toEqual([]);
  });

  it('RED control: a challenged request with no thread (a wallet-route request) is not a thread item', async () => {
    const rows = await pendingThreadPresentationRequestsFor(deps(db), B, NOW);
    expect(rows).toEqual([]);
    db.store.set(`${PRESENTATION_REQUESTS_COLLECTION}/preq_nothread`, {
      request_id: 'preq_nothread', presenter_id: B, requester_id: A, status: 'challenged',
      thread_id: null, expires_at_ms: NOW + DAY, created_at_ms: NOW, agent_wallet_id: B,
    });
    expect(await pendingThreadPresentationRequestsFor(deps(db), B, NOW)).toEqual([]);
    db.store.set(`${PRESENTATION_REQUESTS_COLLECTION}/preq_nothread`, {
      request_id: 'preq_nothread', presenter_id: B, requester_id: A, status: 'challenged',
      thread_id: 'thr_x', expires_at_ms: NOW + DAY, created_at_ms: NOW, agent_wallet_id: B,
    });
    expect((await pendingThreadPresentationRequestsFor(deps(db), B, NOW)).map((r) => r.request_id)).toEqual(['preq_nothread']);
  });
});

describe('deliverables', () => {
  it('normalizeDeliverable hashes the body/URI and refuses a non-URI locator', () => {
    const d = normalizeDeliverable({ deliverable_uri: 'https://example.com/out.tgz', deliverable_body: 'hello' });
    expect(d?.uri).toBe('https://example.com/out.tgz');
    expect(d?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeDeliverable({})).toBeNull();
    expect(() => normalizeDeliverable({ deliverable_uri: 'javascript:alert(1)' })).toThrow(ValidationError);
  });

  it('the delivery lands in the job thread (opening it if the parties never talked)', async () => {
    db.store.set('jobs/job_9', { poster_wallet_id: A, assigned_wallet_id: B, status: 'in_progress' });
    const d = normalizeDeliverable({ deliverable_uri: 'ipfs://bafy123' })!;
    const msg = await postDeliverableMessage(deps(db), actor(B), 'job', 'job_9', A, d, 'pe_delivery');
    expect(msg?.kind).toBe('deliverable');
    expect((msg?.attachment as { deliverable_sha256: string; delivery_pe_id: string }).delivery_pe_id).toBe('pe_delivery');
    const threads = await listThreads(deps(db), A);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor_id).toBe('job_9');
  });
});

describe('a client posts only text; the verified kinds are relay-originated', () => {
  const peFor = (peId: string) => peDocs(db).find((p) => p.id === peId || p.pe_id === peId) as { metadata?: Record<string, unknown>; witness_class?: string } | undefined;

  it.each(['presentation', 'deliverable', 'presentation_request'])(
    'RED: a client message of kind %s is refused and writes nothing (before it sealed verified:true)',
    async (kind) => {
      db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
      const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
      const pesBefore = peDocs(db).length;
      const forged = { kind, ciphertexts: {}, attachment: { request_id: 'preq_forged', verdict: 'valid', predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: true }], deliverable_uri: 'https://evil.example/x', deliverable_sha256: HASH } };
      const err = await postMessage(deps(db), actor(A), thread, forged).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/relay only/);
      expect(peDocs(db)).toHaveLength(pesBefore);
      expect((await listMessages(deps(db), thread)).map((m) => m.kind)).toEqual(['text']);
    },
  );

  it('RED: opening a thread with a relay-only first message is refused BEFORE the thread is written', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const err = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: { kind: 'deliverable', ciphertexts: {}, attachment: { deliverable_sha256: HASH } } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect([...db.store.keys()].filter((k) => k.startsWith(`${COMMONS_COLLECTIONS.THREADS}/`))).toHaveLength(0);
    expect(peDocs(db)).toHaveLength(0);
  });

  it('an unknown kind is refused too; an omitted kind is text', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    await expect(postMessage(deps(db), actor(A), thread, { kind: 'verdict', ciphertexts: { [B]: CT }, content_sha256: HASH })).rejects.toBeInstanceOf(ValidationError);
    const plain = await postMessage(deps(db), actor(A), thread, { ciphertexts: { [B]: CT }, content_sha256: HASH });
    expect(plain.kind).toBe('text');
    expect(plain.origin).toBe('client');
  });

  it('a client message carries origin client and NO verified claim; the witness class (the pricing evidence) is unchanged', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const out = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: { ...text(B), attachment: { request_id: 'preq_forged' } } });
    expect(out.message.origin).toBe('client');
    const pe = peFor(out.message.pe_id);
    expect(pe).toBeDefined();
    expect(pe?.metadata?.verified).toBeUndefined();
    expect(pe?.metadata?.origin).toBe('client');
    expect(pe?.metadata?.request_id).toBeUndefined();
    expect(pe?.witness_class).toBe('relay_verified');
  });

  it('relay-composed request, presentation and deliverable messages carry origin relay and verified:true', async () => {
    db.store.set('escrows/esc_1', { depositor_wallet_id: A, recipient_wallet_id: B });
    const { thread } = await openThread(deps(db), actor(A), { anchor: { kind: 'escrow', id: 'esc_1' }, message: text(B) });
    const req = await requestPresentationInThread(deps(db), actor(A), thread, { tier: 'reputation', predicates: [{ field: 'work.sealed_count', op: 'gte', threshold: 1 }] });
    mockVerify.mockResolvedValue({ verdict: 'valid', presenter: { sub: B, presenter_address: `0x${B}`.toLowerCase(), burn_id: BURN }, predicate_results: [{ result: true }] });
    const presented = await presentInThread(deps(db), actor(B), thread, req.request.request_id, { burn_id: BURN, presentation_token: 'tok' }, { publicKeys: [], peAnchorContract: null });
    db.store.set('jobs/job_9', { poster_wallet_id: A, assigned_wallet_id: B, status: 'in_progress' });
    const delivered = await postDeliverableMessage(deps(db), actor(B), 'job', 'job_9', A, normalizeDeliverable({ deliverable_uri: 'ipfs://bafy123' })!, 'pe_delivery');
    expect(delivered).not.toBeNull();
    for (const m of [req.message, presented.message, delivered!]) {
      expect(m.origin).toBe('relay');
      const pe = peFor(m.pe_id);
      expect(pe?.metadata?.verified).toBe(true);
      expect(pe?.metadata?.origin).toBe('relay');
    }
    expect(peFor(req.message.pe_id)?.metadata?.request_id).toBe(req.request.request_id);
  });
});


describe('immediate notification and reply retry identity',()=>{
 it('one committed message creates one notification and one PE, even when retried',async()=>{
  db.store.set('escrows/esc_immediate',{depositor_wallet_id:A,recipient_wallet_id:B});
  const opened=await openThread(deps(db),actor(A),{anchor:{kind:'escrow',id:'esc_immediate'},message:text(B)});
  const before=peDocs(db).length;
  const input={...text(B),idempotency_key:'reply:original'};
  const first=await postMessage(deps(db),actor(A),opened.thread,input);
  const again=await postMessage(deps(db),actor(A),opened.thread,input);
  expect(again.message_id).toBe(first.message_id);expect(again.pe_id).toBe(first.pe_id);
  expect(peDocs(db)).toHaveLength(before+1);
  expect(db.store.get('commons_agent_delivery_v1/'+B)?.sequence).toBe(2);
  const events=[...db.store].filter(([k])=>k.startsWith('commons_agent_delivery_v1/'+B+'/events/'));
  expect(events).toHaveLength(2);expect(events[1][1].message_id).toBe(first.message_id);
 });
 it('RED: a malformed key commits neither message nor notification',async()=>{
  db.store.set('escrows/esc_invalid',{depositor_wallet_id:A,recipient_wallet_id:B});
  const opened=await openThread(deps(db),actor(A),{anchor:{kind:'escrow',id:'esc_invalid'},message:text(B)});
  const before=peDocs(db).length;
  await expect(postMessage(deps(db),actor(A),opened.thread,{...text(B),idempotency_key:'../bad'})).rejects.toThrow('Invalid idempotency_key');
  expect(peDocs(db)).toHaveLength(before);expect(db.store.get('commons_agent_delivery_v1/'+B)?.sequence).toBe(1);
 });
 it('same-clock messages retain strict commit order beyond the recipient read cursor',async()=>{
  db.store.set('escrows/esc_order',{depositor_wallet_id:A,recipient_wallet_id:B});
  const opened=await openThread(deps(db),actor(A),{anchor:{kind:'escrow',id:'esc_order'},message:text(B)});
  await markRead(deps(db),opened.thread,B,NOW,opened.message.created_at);
  const next=await postMessage(deps(db),actor(A),opened.thread,text(B));
  expect(next.created_at).toBeGreaterThan(opened.message.created_at);
 });
});
