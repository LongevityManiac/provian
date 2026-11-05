/**
 * (constraint 2: human-device work earns consumption too). A person's Commons
 * writes — forum post / reply, want, hiring-board job post, job deliverable — carry their PHONE's
 * signature over the content hash the write's PE seals; the relay verifies it is the author's,
 * keeps it with the record and serves it, and a reader's witnessed act citing it counts toward the
 * person's consumption.
 *
 * RED controls: a signature over other content / by another person's key / by an unregistered key /
 * forged is refused BEFORE any write; the same phone-signed output cited by the person's own linked
 * agent counts zero; a registry read failure refuses retryably.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createPost as createPostRaw, getPost } from './forum';
import { postWant as postWantRaw } from './wants';
import { postHumanJob as postHumanJobRaw, deliverHumanJob } from './human-jobs';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
import { COMMONS_COLLECTIONS, type CommonsDeps, type CommonsForumPost, type HumanJob } from './types';
import { ValidationError } from '../agent-bank/errors';
import { acceptAttachedOutputSignature, OutputSignatureUnverifiableError } from './attached-output-signature';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { registerAppOutputKey } from '../pvt/output-signing-keys';
import { resolveOriginPricingInputs } from '../pvt/origin-pricing-inputs';
import { readOwnerInEdges, summarizeConsumption } from '../pvt/origin-reference-graph';
import { _resetPvtPrincipalConfigForTests } from '../agent-bank/pvt-principal-config';
import {
  appOutputKeyId,
  deliverableOutputText,
  forumPostOutputText,
  jobPostOutputText,
  outputCitationOrigin,
  outputHashOfText,
  outputKeyRegistrationMessage,
  outputSignatureMessage,
  splitThreadOutputSignature,
  wantOutputText,
  withThreadOutputSignature,
  type OutputSignature,
} from '../meter/output-signature';
import { normalizeInputOrigins, type InputOrigin } from '../provenance/input-origins';
import type { BeneficiaryCacheEntry } from '../pvt/beneficiary';
import type { SealedWitness } from '../pvt/origin-independence';

const FRANK = 'user_frank';
const DAN = 'user_dan';
const fsOf = (d: FakeFirestore) => d as unknown as Firestore;
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

interface PhoneKey { readonly privateKey: KeyObject; readonly publicHex: string; readonly keyId: string }
function phoneKey(): PhoneKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const publicHex = `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  return { privateKey, publicHex, keyId: appOutputKeyId(publicHex) };
}
const p256 = (k: PhoneKey, message: string) =>
  cryptoSign('sha256', Buffer.from(message, 'utf8'), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex');
/** The phone's signature over an output text (what the app's createAppOutputSigner produces). */
function phoneSign(k: PhoneKey, text: string): OutputSignature {
  const hash = outputHashOfText(text);
  return { hash, signer: { kind: 'app', id: k.keyId }, scheme: 'p256_sha256', sig: p256(k, outputSignatureMessage(hash)) };
}
async function registerPhone(d: FakeFirestore, userId: string, k: PhoneKey): Promise<void> {
  const r = await registerAppOutputKey(fsOf(d), userId, { public_key: k.publicHex, proof: p256(k, outputKeyRegistrationMessage('app', userId, k.publicHex)) }, 1);
  expect(r.ok).toBe(true);
}

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}
function seed(db: FakeFirestore): void {
  for (const id of [FRANK, DAN]) {
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${id}`, {
      status: 'active', participant_type: 'human', attestation_tier: 'software',
      commons_join_date: Date.now() - 40 * 86_400_000, pe_count: 100, display_name: id,
    });
  }
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { name: 'general', post_count: 0 });
}
const createPost = (db: FakeFirestore, userId: string, body: Parameters<typeof createPostRaw>[2]) =>
  createPostRaw(makeDeps(db), actorOf(userId, userId, null, false), body, TEST_WINDOW);
const postCount = (db: FakeFirestore) => [...db.store.keys()].filter((k) => k.startsWith(`${COMMONS_COLLECTIONS.FORUM_POSTS}/`)).length;

const CONTENT = '  A field guide to verifying agent receipts.  ';

describe('a phone-signed forum post', () => {
  it('is kept with the post and served with it (the signature names the sealed content hash)', async () => {
    const db = createFakeFirestore(); seed(db);
    const k = phoneKey(); await registerPhone(db, FRANK, k);
    const sig = phoneSign(k, forumPostOutputText(CONTENT));
    const post = await createPost(db, FRANK, { channel: 'general', content: CONTENT, provian_output_signature: sig });
    expect(post.provian_output_signature).toEqual(sig);
    const served = await getPost(makeDeps(db), post.post_id);
    expect((served.post as CommonsForumPost).provian_output_signature).toEqual(sig);
    expect(sig.hash).toBe(`sha256:${sha256Hex(CONTENT.trim())}`);
    // An unsigned post is unchanged.
    const plain = await createPost(db, FRANK, { channel: 'general', content: 'unsigned' });
    expect(plain.provian_output_signature).toBeUndefined();
  });

  it('RED — other content, another person\'s key, an unregistered key or a forgery is refused and writes nothing', async () => {
    const db = createFakeFirestore(); seed(db);
    const mine = phoneKey(); await registerPhone(db, FRANK, mine);
    const dans = phoneKey(); await registerPhone(db, DAN, dans);
    const stray = phoneKey();
    const cases: Array<[unknown, string]> = [
      [phoneSign(mine, 'different text'), 'output_signature_hash_mismatch'],
      [phoneSign(dans, CONTENT.trim()), 'output_signature_not_author'],
      [phoneSign(stray, CONTENT.trim()), 'output_signature_unknown_signer'],
      [{ ...phoneSign(mine, CONTENT.trim()), sig: phoneSign(dans, CONTENT.trim()).sig }, 'output_signature_bad_signature'],
      [{ hash: 'nope' }, 'output_signature_malformed'],
    ];
    for (const [sig, error] of cases) {
      await expect(createPost(db, FRANK, { channel: 'general', content: CONTENT, provian_output_signature: sig })).rejects.toThrow(error);
    }
    expect(postCount(db)).toBe(0);
  });

  it('RED — a registry read failure refuses retryably (503), never stores an unverified signature', async () => {
    const k = phoneKey();
    const failing = { collection: () => { throw new Error('unavailable'); } } as unknown as Firestore;
    const sig = phoneSign(k, 'x');
    await expect(acceptAttachedOutputSignature(failing, sig, sig.hash.slice(7), FRANK)).rejects.toBeInstanceOf(OutputSignatureUnverifiableError);
    await expect(acceptAttachedOutputSignature(failing, undefined, sig.hash.slice(7), FRANK)).resolves.toBeNull();
    await expect(acceptAttachedOutputSignature(failing, sig, 'f'.repeat(64), FRANK)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('wants, job posts and deliverables carry the same signature', () => {
  const ADDR = '0x0000000000000000000000000000000000000001';
  const ORIGINAL_ENV = { ...process.env };
  afterAll(() => { process.env = ORIGINAL_ENV; _resetPvtPrincipalConfigForTests(); });

  it('a want: the signature over wantOutputText is kept; RED: over the un-normalized input it is refused', async () => {
    const db = createFakeFirestore(); seed(db);
    const k = phoneKey(); await registerPhone(db, FRANK, k);
    const input = { outcome: ' a reviewed contract ', capabilities: ['Legal-Review', 'legal-review'] };
    const sig = phoneSign(k, wantOutputText(input.outcome, input.capabilities));
    const view = await postWantRaw(makeDeps(db) as never, { walletId: FRANK, isAgent: false, agentId: FRANK }, { ...input, outputSignature: sig }, TEST_WINDOW);
    expect(view.provian_output_signature).toEqual(sig);
    await expect(postWantRaw(makeDeps(db) as never, { walletId: FRANK, isAgent: false, agentId: FRANK },
      { ...input, outputSignature: phoneSign(k, JSON.stringify(input)) }, TEST_WINDOW)).rejects.toThrow('output_signature_hash_mismatch');
  });

  it('a job post seals its title+description digest and keeps the poster\'s signature; a deliverable keeps the deliverer\'s', async () => {
    process.env.ENABLE_PVT_PRINCIPAL = 'true';
    process.env.PVT_PRINCIPAL_CHAINS = 'base';
    process.env.ESCROW_V4_CONTRACT_ADDRESS = ADDR;
    process.env.PVT_CONTRACT_ADDRESS_BASE = ADDR;
    _resetPvtPrincipalConfigForTests();
    const db = createFakeFirestore(); seed(db);
    const frank = phoneKey(); await registerPhone(db, FRANK, frank);
    const dan = phoneKey(); await registerPhone(db, DAN, dan);
    const body = {
      title: ' Translate a document ', description: 'Need a careful human translation.', category: 'professional_services' as const,
      skills_required: ['translation'], location: { type: 'remote' as const }, compensation_type: 'pvt' as const,
      budget_pvt: '1000000000000000000', requires_identity_verification: false, requires_pe_history: false, deadline_hours: 24,
    };
    const postSig = phoneSign(frank, jobPostOutputText(body.title, body.description));
    const job = await postHumanJobRaw(makeDeps(db), FRANK, FRANK, null, { ...body, provian_output_signature: postSig }, TEST_WINDOW);
    expect(job.provian_output_signature).toEqual(postSig);
    await expect(postHumanJobRaw(makeDeps(db), FRANK, FRANK, null, { ...body, provian_output_signature: phoneSign(dan, jobPostOutputText(body.title, body.description)) }, TEST_WINDOW))
      .rejects.toThrow('output_signature_not_author');

    // The deliverable: Dan is the accepted applicant.
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${job.job_id}`, { ...(db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${job.job_id}`) as object), status: 'in_progress', accepted_applicant_wallet_id: DAN });
    const deliverable = { deliverable_body: 'The translated document.' };
    await expect(deliverHumanJob(makeDeps(db), DAN, DAN, null, job.job_id, deliverable, phoneSign(dan, 'something else')))
      .rejects.toThrow('output_signature_hash_mismatch');
    const delSig = phoneSign(dan, deliverableOutputText(null, deliverable.deliverable_body));
    await deliverHumanJob(makeDeps(db), DAN, DAN, null, job.job_id, deliverable, delSig);
    const stored = db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/${job.job_id}`) as unknown as HumanJob;
    expect(stored.deliverable?.provian_output_signature).toEqual(delSig);
  });
});

describe('a thread message carries its signature INSIDE the sealed plaintext', () => {
  it('round trip; RED: a trailer whose signature names other text is not a signature', () => {
    const k = phoneKey();
    const sig = phoneSign(k, 'see the attached plan');
    const sealed = withThreadOutputSignature('see the attached plan', sig);
    expect(splitThreadOutputSignature(sealed)).toEqual({ text: 'see the attached plan', signature: sig });
    const tampered = withThreadOutputSignature('a different message', sig);
    expect(splitThreadOutputSignature(tampered)).toEqual({ text: tampered, signature: null });
    expect(splitThreadOutputSignature('plain message')).toEqual({ text: 'plain message', signature: null });
  });
});

describe('who built on a person\'s Commons output', () => {
  const W: SealedWitness = { identity: 'dev_reader', tier: 'software' };
  const CITING = { type: 'observer_device', identity: 'dev_reader', attestation_tier: 'software' };
  const UNLINKED: BeneficiaryCacheEntry = { linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null };
  const linkedTo = (userId: string) => async (): Promise<BeneficiaryCacheEntry> =>
    ({ linked: true, humanWalletId: `wallet_${userId}`, humanUserId: userId, humanAddress: null, agentShareBps: null });
  const wire = (entries: unknown[]): InputOrigin[] => normalizeInputOrigins(entries) as InputOrigin[];
  const cite = (actor: string, peId: string, served: OutputSignature) => ({
    economicActorId: actor, walletAddress: null, peId, nowMs: 1_000, submissionWitness: W,
    witnessObservedTokens: null, bodyDeclaredTokens: null, inputOrigins: wire([outputCitationOrigin(served, CITING)]),
  });

  it('a phone-signed post cited by ANOTHER party\'s witnessed act counts; RED: cited by the person\'s own linked agent it counts zero', async () => {
    const db = createFakeFirestore(); seed(db);
    const k = phoneKey(); await registerPhone(db, FRANK, k);
    const post = await createPost(db, FRANK, { channel: 'general', content: CONTENT, provian_output_signature: phoneSign(k, CONTENT.trim()) });
    const served = (await getPost(makeDeps(db), post.post_id)).post.provian_output_signature as OutputSignature;

    db.store.set('agent_wallets/w_atlas', { id: 'w_atlas', agent_id: 'atlas', linked_human_user_id: FRANK });
    const linked = await resolveOriginPricingInputs(fsOf(db), {} as never, cite('atlas', 'pe_atlas_1', served), linkedTo(FRANK));
    expect(linked.origins[0]).toMatchObject({ owner: `signer:${FRANK}`, reason: 'same_party' });
    expect(summarizeConsumption(await readOwnerInEdges(fsOf(db), FRANK)).consumption_edges).toBe(0);

    const other = await resolveOriginPricingInputs(fsOf(db), {} as never, cite('reader_agent', 'pe_reader_1', served), async () => UNLINKED);
    expect(other.origins[0]).toMatchObject({ owner: `signer:${FRANK}`, reason: 'consumption_edge' });
    expect(summarizeConsumption(await readOwnerInEdges(fsOf(db), FRANK)).consumption_edges).toBe(1);
  });
});
