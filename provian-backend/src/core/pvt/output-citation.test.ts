/**
 * a citation counts toward the producer's Consumption only when it carries the
 * producer's signature over the output's hash; unsigned citations don't count (the 09-12 rule).
 * Binding constraints (the operator, same day):
 * 1. The signature only establishes WHO MADE the output. The citing act must still be witnessed,
 * and the ring and self filters still apply.
 * 2. Devices that don't hold the wallet key (a MacBook daemon, a phone) sign with their
 * REGISTERED key and map to the owner through the same identity index.
 *
 * Every counting claim ships with its RED control in this suite : the positive case is shown
 * counting 1, and each of unsigned / bad signature / foreign signer / unknown signer / unwitnessed
 * citing act / declared body / self / linked agent↔human / ring / unsigned `pe:` counts ZERO.
 */

import fs from 'fs';
import path from 'path';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import { Wallet } from 'ethers';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { resolveOriginPricingInputs, newBatchOriginEdges } from './origin-pricing-inputs';
import {
  CITATION_PAIR_COUNTS_COLLECTION,
  CITATION_PAIR_COUNTS_STATE_COLLECTION,
  CITATION_PAIR_COUNTS_STATE_DOC,
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
  citationIncrementsOf,
  citationPairId,
  originEdgeId,
  readActorConsumption,
  readOwnerInEdges,
  resetCitationPairGateForTests,
  stageNewOriginEdges,
  summarizeConsumption,
} from './origin-reference-graph';
import { resolveOutputCitations, resolveWalletSignerActor, verifyOutputSignature } from './output-citation';
import {
  APP_OUTPUT_KEYS_COLLECTION,
  readAppOutputKey,
  readDeviceOutputKey,
  registerAppOutputKey,
  registerDeviceOutputKey,
  verifyP256Sha256,
} from './output-signing-keys';
import {
  appOutputKeyId,
  decodeOutputSignatureHeader,
  encodeOutputSignatureHeader,
  outputCitationOrigin,
  outputHashOfBytes,
  outputHashOfText,
  outputKeyRegistrationMessage,
  outputSignatureDigestHex,
  outputSignatureMessage,
  signedCitationOf,
  type OutputSignature,
} from '../meter/output-signature';
import { normalizeInputOrigins, type InputOrigin } from '../provenance/input-origins';
import {
  CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  NATIVE_WALLET_REGISTRATION_CHAIN_ID,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESS_SCHEMA } from '../external-address/link';
import { HUMAN_PROVEN_ADDRESS_SCHEMA } from '../external-address/human-link';
import type { BeneficiaryCacheEntry } from './beneficiary';
import type { SealedWitness } from './origin-independence';
import type { Firestore } from 'firebase-admin/firestore';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../docs/audit/output-signature-vectors.json'), 'utf8'));

// Public Hardhat/Anvil test keys — never Provian keys.
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PERSON = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const AGENT_PROVEN = new Wallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const STRANGER = new Wallet('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');

const cache = {} as never;
const UNLINKED: BeneficiaryCacheEntry = {
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
};
const unlinked = async (): Promise<BeneficiaryCacheEntry> => UNLINKED;
const DEVICE: SealedWitness = { identity: 'dev_bob', tier: 'software' };
const CITING_WITNESS = { type: 'observer_device', identity: 'dev_bob', attestation_tier: 'software' };
const fsOf = (d: FakeFirestore) => d as unknown as Firestore;
const sha = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex')}`;

// ─── signers ─────────────────────────────────────────────────────────────────

async function walletSign(wallet: Wallet, text: string): Promise<OutputSignature> {
  const hash = outputHashOfText(text);
  return {
    hash, signer: { kind: 'wallet', id: wallet.address.toLowerCase() }, scheme: 'eip191_secp256k1',
    sig: (await wallet.signMessage(outputSignatureMessage(hash))).toLowerCase(),
  };
}

interface P256Key { readonly privateKey: KeyObject; readonly publicHex: string }
function p256Key(): P256Key {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const publicHex = `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  return { privateKey, publicHex };
}
const p256SignText = (key: P256Key, message: string): string =>
  cryptoSign('sha256', Buffer.from(message, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex');
function p256Sign(key: P256Key, kind: 'device' | 'app', id: string, text: string): OutputSignature {
  const hash = outputHashOfText(text);
  return { hash, signer: { kind, id }, scheme: 'p256_sha256', sig: p256SignText(key, outputSignatureMessage(hash)) };
}

// ─── registries ──────────────────────────────────────────────────────────────

function seedNative(d: FakeFirestore, wallet: Wallet, actorId: string, ownerType: 'agent' | 'human' = 'agent'): void {
  const address = wallet.address.toLowerCase();
  d.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(address)}`, {
    schema_version: CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA, chain_id: NATIVE_WALLET_REGISTRATION_CHAIN_ID,
    address, wallet_id: `w_${actorId}`, owner_type: ownerType, owner_id: actorId, created_at_ms: 1,
  });
}

function seedDevice(d: FakeFirestore, deviceId: string, over: Record<string, unknown>): void {
  d.store.set(`devices/${deviceId}`, {
    device_id: deviceId, status: 'active', owner_type: 'human', owner_user_id: 'user_frank',
    owner_wallet_id: 'wallet_frank', signing_method: 'bearer', ...over,
  });
}

function proofFields(): Record<string, unknown> {
  return {
    economic_eligibility: 'active_go_forward_only', proven_at_ms: 1_000, proven_at_block: 1_001,
    proof_observed_head_block: 1_000, proof_block_number: 989, proof_block_hash: `0x${'ab'.repeat(32)}`,
    proof_min_confirmations: 12, proof_rpc_operator_ids: ['op-a', 'op-b'], chain: 'base', chain_id: 8453,
    proof_method: 'eip191_eoa', signature_hash: sha('sig'),
    proof_evidence: {
      schema_version: 'external-address-control-proof/v1', challenge_id_sha256: sha('cid'),
      challenge_message_sha256: sha('msg'), signature_sha256: sha('sig'), proof_method: 'eip191_eoa', verified_at_ms: 1_000,
    },
    initial_reputation_tier: 0, baseline_nonce: 0, created_at: 1_000,
  };
}

// ─── the citing act ──────────────────────────────────────────────────────────

const base = (actor: string, peId: string) => ({
  economicActorId: actor, walletAddress: null as string | null, peId, nowMs: 1_000,
  submissionWitness: DEVICE as SealedWitness | null,
  witnessObservedTokens: null as number | null, bodyDeclaredTokens: null as number | null,
});

/** Entries exactly as the batch lanes normalize them off the wire. */
function wire(entries: unknown[]): InputOrigin[] {
  const normalized = normalizeInputOrigins(entries);
  if (normalized === null) throw new Error('not an array');
  return normalized;
}
const cite = (s: OutputSignature) => outputCitationOrigin(s, CITING_WITNESS);

async function consumptionOf(d: FakeFirestore, actor: string) {
  return summarizeConsumption(await readOwnerInEdges(fsOf(d), actor));
}
const pairOf = (d: FakeFirestore, signer: string, owner: string) =>
  d.store.get(`${CITATION_PAIR_COUNTS_COLLECTION}/${citationPairId(signer, owner)}`) as Record<string, number> | undefined;
const pairsWritten = (d: FakeFirestore) => [...d.store.keys()].filter((k) => k.startsWith(`${CITATION_PAIR_COUNTS_COLLECTION}/`));

// =============================================================================

describe('the output signature — pinned vectors (shared with the SDK, app, MCP and facilitator)', () => {
  it('every case re-derives; ethers reproduces the wallet signatures; node verifies the P-256 ones', async () => {
    const vectorWallet = new Wallet(V.wallet_test_private_key);
    expect(V.cases.map((c: { signer_kind: string }) => c.signer_kind)).toEqual(['wallet', 'wallet', 'device', 'app']);
    for (const c of V.cases) {
      const hash = c.input.kind === 'text' ? outputHashOfText(c.input.value) : outputHashOfBytes(Buffer.from(c.input.value, 'hex'));
      expect(hash).toBe(c.hash);
      expect(outputSignatureMessage(c.hash)).toBe(c.message);
      expect(outputSignatureDigestHex(c.hash)).toBe(createHash('sha256').update(c.message, 'utf8').digest('hex'));
      expect(outputSignatureDigestHex(c.hash)).toBe(c.digest);
      expect(encodeOutputSignatureHeader(c.signature)).toBe(c.header);
      expect(decodeOutputSignatureHeader(c.header)).toEqual(c.signature);
      expect(outputCitationOrigin(c.signature, V.citing_witness)).toEqual(c.citation_origin);
      expect(signedCitationOf(c.citation_origin)).toEqual(c.signature);
      if (c.signer_kind === 'wallet') {
        expect((await vectorWallet.signMessage(c.message)).toLowerCase()).toBe(c.signature.sig);
      } else {
        const pub = c.signer_kind === 'device' ? V.device_public_key : V.app_public_key;
        expect(verifyP256Sha256(pub, c.message, c.signature.sig)).toBe(true);
        // RED: the other key does not verify it.
        expect(verifyP256Sha256(c.signer_kind === 'device' ? V.app_public_key : V.device_public_key, c.message, c.signature.sig)).toBe(false);
      }
    }
    expect(appOutputKeyId(V.app_public_key)).toBe(V.app_key_id);
    expect(verifyP256Sha256(V.device_public_key, V.registration.device.message, V.registration.device.sig)).toBe(true);
    expect(verifyP256Sha256(V.app_public_key, V.registration.app.message, V.registration.app.sig)).toBe(true);
    expect(outputKeyRegistrationMessage('app', V.registration.app.owner_id, V.app_public_key)).toBe(V.registration.app.message);
  });

  it('RED — shape: a scheme that is not the kind\'s, a foreign signer, a swapped hash and no signature are refused', () => {
    const c = V.cases[0];
    expect(signedCitationOf({ ...c.citation_origin, signature: { ...c.signature, scheme: 'p256_sha256' } })).toBeNull();
    expect(signedCitationOf({ ...c.citation_origin, origin_identifier: `out:wallet:${BOB.address.toLowerCase()}` })).toBeNull();
    expect(signedCitationOf({ ...c.citation_origin, hash: V.cases[1].hash })).toBeNull();
    const { signature: _drop, ...unsigned } = c.citation_origin;
    expect(signedCitationOf(unsigned)).toBeNull();
    // An identifier that is not canonical (uppercase address) is not a citation identifier.
    expect(signedCitationOf({ ...c.citation_origin, origin_identifier: c.citation_origin.origin_identifier.toUpperCase() })).toBeNull();
  });

  it('the normalizer keeps a well-formed signature on an out: entry and drops it anywhere else', async () => {
    const s = await walletSign(ALICE, 'kept');
    const [kept] = wire([cite(s)]);
    expect(kept.signature).toEqual(s);
    const [other] = wire([{ hash: s.hash, origin_identifier: 'domain:example.com', witnessed: false, signature: s }]);
    expect(other.signature).toBeUndefined();
  });
});

describe('signer → owner through the per-identity registries only', () => {
  it('wallet: native agent / native human / agent-proven / person-proven; RED: unknown + corrupt', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    seedNative(d, BOB, 'user_bob', 'human');
    const ap = AGENT_PROVEN.address.toLowerCase();
    d.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${ap}`, { schema_version: PROVEN_ADDRESS_SCHEMA, address: ap, agent_id: 'agent_q', wallet_id: 'wq', ...proofFields() });
    const pp = PERSON.address.toLowerCase();
    d.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${pp}`, { schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA, address: pp, user_id: 'user_p', wallet_id: 'wp', ...proofFields() });
    expect(await resolveWalletSignerActor(fsOf(d), ALICE.address)).toBe('alice');
    expect(await resolveWalletSignerActor(fsOf(d), BOB.address)).toBe('user_bob');
    expect(await resolveWalletSignerActor(fsOf(d), ap)).toBe('agent_q');
    expect(await resolveWalletSignerActor(fsOf(d), pp)).toBe('user_p');
    expect(await resolveWalletSignerActor(fsOf(d), STRANGER.address)).toBeNull();
    const corrupt = createFakeFirestore();
    const a = ALICE.address.toLowerCase();
    corrupt.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(a)}`, { address: a, owner_id: 'alice' });
    expect(await resolveWalletSignerActor(fsOf(corrupt), a)).toBeNull();
  });

  it('device: an SE device verifies with its signing key; a bearer device with its registered output key; owner from the device row', async () => {
    const d = createFakeFirestore();
    const se = p256Key();
    const bearer = p256Key();
    seedDevice(d, 'dev_mac_se', { signing_method: 'secure_enclave_p256', signing_public_key: se.publicHex });
    seedDevice(d, 'dev_linux', { output_signing_public_key: bearer.publicHex });
    seedDevice(d, 'dev_agent', { owner_type: 'agent', owner_user_id: 'wallet_aw_x', owner_wallet_id: 'wallet_aw_x', output_signing_public_key: bearer.publicHex });
    d.store.set('agent_wallets/wallet_aw_x', { id: 'wallet_aw_x', agent_id: 'agent_x' });
    expect(await readDeviceOutputKey(fsOf(d), 'dev_mac_se')).toEqual({ publicKey: se.publicHex, actorId: 'user_frank' });
    expect(await readDeviceOutputKey(fsOf(d), 'dev_linux')).toEqual({ publicKey: bearer.publicHex, actorId: 'user_frank' });
    // An agent device keys under the agent's agent_id, never the wallet doc id.
    expect(await readDeviceOutputKey(fsOf(d), 'dev_agent')).toEqual({ publicKey: bearer.publicHex, actorId: 'agent_x' });
    const ok = await verifyOutputSignature(fsOf(d), p256Sign(se, 'device', 'dev_mac_se', 'a MacBook output'));
    expect(ok).toEqual({ ok: true, actorId: 'user_frank' });
    // RED: the bearer key cannot sign as the SE device; a revoked device and a key-less bearer device are unknown.
    expect(await verifyOutputSignature(fsOf(d), p256Sign(bearer, 'device', 'dev_mac_se', 'x'))).toEqual({ ok: false, reason: 'bad_signature' });
    seedDevice(d, 'dev_revoked', { status: 'revoked', output_signing_public_key: bearer.publicHex });
    seedDevice(d, 'dev_keyless', {});
    expect(await verifyOutputSignature(fsOf(d), p256Sign(bearer, 'device', 'dev_revoked', 'x'))).toEqual({ ok: false, reason: 'unknown_signer' });
    expect(await verifyOutputSignature(fsOf(d), p256Sign(bearer, 'device', 'dev_keyless', 'x'))).toEqual({ ok: false, reason: 'unknown_signer' });
    // RED: an agent device whose wallet cannot be read has no owner (fail closed, never the wallet id).
    seedDevice(d, 'dev_orphan', { owner_type: 'agent', owner_wallet_id: 'wallet_missing', output_signing_public_key: bearer.publicHex });
    expect(await readDeviceOutputKey(fsOf(d), 'dev_orphan')).toBeNull();
  });

  it('a bearer device registers its output key with a proof of possession; RED: bad proof, SE device, a different second key', async () => {
    const d = createFakeFirestore();
    seedDevice(d, 'dev_linux', {});
    const key = p256Key();
    const proof = p256SignText(key, outputKeyRegistrationMessage('device', 'dev_linux', key.publicHex));
    const device = { device_id: 'dev_linux', signing_method: 'bearer', status: 'active' };
    expect(await registerDeviceOutputKey(fsOf(d), device, { public_key: key.publicHex, proof: '00'.repeat(64) }))
      .toEqual({ ok: false, status: 400, error: 'proof_of_possession_invalid' });
    // A proof made for ANOTHER device id does not register this one.
    const otherProof = p256SignText(key, outputKeyRegistrationMessage('device', 'dev_other', key.publicHex));
    expect((await registerDeviceOutputKey(fsOf(d), device, { public_key: key.publicHex, proof: otherProof })).ok).toBe(false);
    expect(await registerDeviceOutputKey(fsOf(d), device, { public_key: key.publicHex, proof }))
      .toMatchObject({ ok: true, created: true });
    expect(await registerDeviceOutputKey(fsOf(d), device, { public_key: key.publicHex, proof }))
      .toMatchObject({ ok: true, created: false });
    const second = p256Key();
    const secondProof = p256SignText(second, outputKeyRegistrationMessage('device', 'dev_linux', second.publicHex));
    expect(await registerDeviceOutputKey(fsOf(d), device, { public_key: second.publicHex, proof: secondProof }))
      .toEqual({ ok: false, status: 409, error: 'output_key_already_registered' });
    expect(await registerDeviceOutputKey(fsOf(d), { ...device, signing_method: 'secure_enclave_p256' }, { public_key: key.publicHex, proof }))
      .toEqual({ ok: false, status: 409, error: 'secure_enclave_device_signs_with_its_signing_key' });
    expect(await readDeviceOutputKey(fsOf(d), 'dev_linux')).toEqual({ publicKey: key.publicHex, actorId: 'user_frank' });
  });

  it('app: a phone registers its PE-attestation key under wallet auth; the key id names the person; RED: another account', async () => {
    const d = createFakeFirestore();
    const phone = p256Key();
    const proof = p256SignText(phone, outputKeyRegistrationMessage('app', 'user_frank', phone.publicHex));
    const r = await registerAppOutputKey(fsOf(d), 'user_frank', { public_key: phone.publicHex, proof }, 5);
    expect(r).toMatchObject({ ok: true, created: true, key_id: appOutputKeyId(phone.publicHex) });
    expect(d.store.get(`${APP_OUTPUT_KEYS_COLLECTION}/${appOutputKeyId(phone.publicHex)}`)).toMatchObject({ owner_user_id: 'user_frank', status: 'active' });
    expect(await readAppOutputKey(fsOf(d), appOutputKeyId(phone.publicHex))).toEqual({ publicKey: phone.publicHex, actorId: 'user_frank' });
    const mallory = p256SignText(phone, outputKeyRegistrationMessage('app', 'user_mallory', phone.publicHex));
    expect(await registerAppOutputKey(fsOf(d), 'user_mallory', { public_key: phone.publicHex, proof: mallory }, 6))
      .toEqual({ ok: false, status: 409, error: 'output_key_bound_to_other_owner' });
    // RED: a proof over frank's binding does not register for mallory.
    expect((await registerAppOutputKey(fsOf(d), 'user_mallory', { public_key: phone.publicHex, proof }, 6)).ok).toBe(false);
    const s = p256Sign(phone, 'app', appOutputKeyId(phone.publicHex), 'a phone answer');
    expect(await verifyOutputSignature(fsOf(d), s)).toEqual({ ok: true, actorId: 'user_frank' });
  });

  it('a registry read that throws resolves to no owner (never guessed)', async () => {
    const s = await walletSign(ALICE, 'x');
    const broken = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('unavailable'); } }) }) } as unknown as Firestore;
    const m = await resolveOutputCitations(broken, wire([cite(s)]));
    expect([...m.values()][0]).toEqual({ producerActorId: null, reason: 'registry_unreadable' });
  });
});

describe('Consumption counts SIGNED citations from WITNESSED citing acts only', () => {
  it('bob\'s witnessed act cites alice\'s signed output → a counted consumption edge; price unchanged', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s = await walletSign(ALICE, 'alice output 1');
    const r = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b1'), inputOrigins: wire([cite(s)]) }, unlinked);
    expect(r.origins[0]).toMatchObject({
      origin_identifier: `out:wallet:${ALICE.address.toLowerCase()}`,
      owner: 'signer:alice', witnessed: true, counted: false, reason: 'consumption_edge',
      witness: { identity: 'dev_bob', tier: 'software' }, // the CITING act's witness, never the producer
    });
    expect(r.independentOriginCount).toBe(0); // MONEY-SAFETY: a citation adds zero to the multiplier
    const summary = await consumptionOf(d, 'alice');
    expect(summary.consumption_edges).toBe(1);
    expect(summary.independent_consumers).toBe(1);
    expect(pairOf(d, 'bob', 'signer:alice')?.pe_consumption).toBe(1);
    d.store.set(`${CITATION_PAIR_COUNTS_STATE_COLLECTION}/${CITATION_PAIR_COUNTS_STATE_DOC}`, { complete: true });
    resetCitationPairGateForTests();
    expect((await readActorConsumption(fsOf(d), 'alice')).consumption_edges).toBe(1);
    resetCitationPairGateForTests();
  });

  it('a MacBook daemon (SE device key) and a phone (app key) produce citable outputs for their HUMAN owner', async () => {
    const d = createFakeFirestore();
    const mac = p256Key();
    const phone = p256Key();
    seedDevice(d, 'dev_mac', { signing_method: 'secure_enclave_p256', signing_public_key: mac.publicHex });
    await registerAppOutputKey(fsOf(d), 'user_frank', {
      public_key: phone.publicHex, proof: p256SignText(phone, outputKeyRegistrationMessage('app', 'user_frank', phone.publicHex)),
    }, 1);
    const r = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('bob', 'pe_b2'),
      inputOrigins: wire([cite(p256Sign(mac, 'device', 'dev_mac', 'mac output')), cite(p256Sign(phone, 'app', appOutputKeyId(phone.publicHex), 'phone output'))]),
    }, unlinked);
    expect(r.origins.map((o) => [o.owner, o.reason])).toEqual([['signer:user_frank', 'consumption_edge'], ['signer:user_frank', 'consumption_edge']]);
    const summary = await consumptionOf(d, 'user_frank');
    expect(summary.consumption_edges).toBe(2);
    expect(summary.independent_consumers).toBe(1);
  });

  it('RED (constraint 1a) — the SAME valid signature cited by an UNWITNESSED act counts zero', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s = await walletSign(ALICE, 'alice output 1');
    // No non-actor witness vouched the citing act (e.g. an actor-declared lane).
    const r = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b3'), submissionWitness: null, inputOrigins: wire([cite(s)]) }, unlinked);
    expect(r.origins[0]).toMatchObject({ owner: 'signer:alice', witnessed: false, reason: 'unwitnessed' });
    expect((await consumptionOf(d, 'alice')).consumption_edges).toBe(0);
    expect(pairOf(d, 'bob', 'signer:alice')).toMatchObject({ pe_consumption: 0, pe_unwitnessed: 1 });
  });

  it('RED (constraint 1a) — a witnessed lane whose body did not mark the citation witnessed counts zero', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s = await walletSign(ALICE, 'alice output 1');
    const r = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b4'), inputOrigins: wire([outputCitationOrigin(s)]) }, unlinked);
    expect(r.origins[0]).toMatchObject({ owner: 'signer:alice', witnessed: false, reason: 'unwitnessed' });
    expect((await consumptionOf(d, 'alice')).consumption_edges).toBe(0);
  });

  it('RED — unsigned, bad signature, and unknown signer each count zero (no owner, no pair)', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s = await walletSign(ALICE, 'alice output 1');
    const { signature: _drop, ...unsigned } = cite(s);
    const forged = await walletSign(STRANGER, 'alice output 1');
    const bad = { ...cite(s), signature: { ...s, sig: forged.sig } };
    const unknown = cite(await walletSign(STRANGER, 'stranger output'));
    const r = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b5'), inputOrigins: wire([unsigned, bad, unknown]) }, unlinked);
    expect(r.origins.map((o) => [o.owner, o.reason])).toEqual([[null, 'unresolvable_owner'], [null, 'unresolvable_owner'], [null, 'unresolvable_owner']]);
    expect((await consumptionOf(d, 'alice')).consumption_edges).toBe(0);
    expect(pairsWritten(d)).toEqual([]);
  });

  it('entries naming one output are verified separately: a bad or unsigned duplicate neither borrows nor shadows a valid one', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s = await walletSign(ALICE, 'alice output 7');
    const { signature: _drop, ...unsigned } = cite(s);
    const forged = { ...cite(s), signature: { ...s, sig: (await walletSign(STRANGER, 'alice output 7')).sig } };
    // Unsigned (and a forgery) FIRST, the valid entry after: the valid one still counts, once.
    const r = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b5x'), inputOrigins: wire([unsigned, forged, cite(s)]) }, unlinked);
    expect(r.origins.map((o) => [o.owner, o.reason])).toEqual([[null, 'unresolvable_owner'], [null, 'unresolvable_owner'], ['signer:alice', 'consumption_edge']]);
    expect((await consumptionOf(d, 'alice')).consumption_edges).toBe(1);
    expect(pairsWritten(d)).toHaveLength(1);
    // RED: a forgery AFTER a valid entry does not inherit its verdict.
    const r2 = await resolveOriginPricingInputs(fsOf(d), cache, { ...base('carol', 'pe_c5x'), inputOrigins: wire([cite(s), forged]) }, unlinked);
    expect(r2.origins.map((o) => o.reason)).toEqual(['consumption_edge', 'unresolvable_owner']);
  });

  it('RED (constraint 1b) — citing your OWN signed output (wallet or own device) is same_party', async () => {
    const d = createFakeFirestore();
    seedNative(d, BOB, 'bob');
    const mac = p256Key();
    seedDevice(d, 'dev_bob_mac', { owner_user_id: 'bob', signing_method: 'secure_enclave_p256', signing_public_key: mac.publicHex });
    const r = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('bob', 'pe_b6'), inputOrigins: wire([cite(await walletSign(BOB, 'mine')), cite(p256Sign(mac, 'device', 'dev_bob_mac', 'mine too'))]),
    }, unlinked);
    expect(r.origins.map((o) => o.reason)).toEqual(['same_party', 'same_party']);
    expect((await consumptionOf(d, 'bob')).consumption_edges).toBe(0);
  });

  it('RED (constraint 1b) — a linked agent citing its human\'s device output, and the human citing the agent\'s, are same_party', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'atlas');
    d.store.set('agent_wallets/w_atlas', { id: 'w_atlas', agent_id: 'atlas', linked_human_user_id: 'user_frank', address: ALICE.address.toLowerCase() });
    const mac = p256Key();
    seedDevice(d, 'dev_frank_mac', { signing_method: 'secure_enclave_p256', signing_public_key: mac.publicHex });
    const linkedToFrank = async (): Promise<BeneficiaryCacheEntry> => ({
      linked: true, humanWalletId: 'wallet_frank', humanUserId: 'user_frank', humanAddress: null, agentShareBps: null,
    });
    const agentCites = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('atlas', 'pe_t1'), inputOrigins: wire([cite(p256Sign(mac, 'device', 'dev_frank_mac', 'frank wrote this'))]),
    }, linkedToFrank);
    expect(agentCites.origins[0]).toMatchObject({ owner: 'signer:user_frank', reason: 'same_party' });
    const humanCites = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('user_frank', 'pe_f1'), inputOrigins: wire([cite(await walletSign(ALICE, 'atlas wrote this'))]),
    }, unlinked);
    expect(humanCites.origins[0]).toMatchObject({ owner: 'signer:atlas', reason: 'same_party' });
    expect((await consumptionOf(d, 'user_frank')).consumption_edges).toBe(0);
    expect((await consumptionOf(d, 'atlas')).consumption_edges).toBe(0);
  });

  it('RED (constraint 1c) — a signed citation that closes a ring is excluded; the same citation outside the ring counts', async () => {
    const ring = createFakeFirestore();
    seedNative(ring, ALICE, 'alice');
    // Existing signed-citation ring edges: alice cited bob, bob cited carol.
    for (const [signer, owner, pe] of [['alice', 'signer:bob', 'pe_A'], ['bob', 'signer:carol', 'pe_B']] as const) {
      const id = `out:wallet:0x${pe === 'pe_A' ? 'b'.repeat(40) : 'c'.repeat(40)}`;
      ring.store.set(`${ORIGIN_REFERENCE_GRAPH_COLLECTION}/${originEdgeId(pe, id, sha(pe))}`, {
        schema_version: 'origin-reference-graph-edge/v1', signer, owner, origin_identifier: id, hash: sha(pe),
        witnessed: true, counted: false, pe_id: pe, recorded_at_ms: 1, scheme: 'out', reason: 'consumption_edge', closed_loop: false,
      });
    }
    // carol now cites alice's signed output → closes alice→bob→carol→alice.
    const s = await walletSign(ALICE, 'alice output');
    const closed = await resolveOriginPricingInputs(fsOf(ring), cache, { ...base('carol', 'pe_C'), inputOrigins: wire([cite(s)]) }, unlinked);
    expect(closed.origins[0].reason).toBe('closed_loop');
    const summary = await consumptionOf(ring, 'alice');
    expect(summary.consumption_edges).toBe(0);
    expect(summary.ring_excluded_edges).toBe(1);
    // Control: the same citation by an outsider (no ring) counts.
    const open = createFakeFirestore();
    seedNative(open, ALICE, 'alice');
    const counted = await resolveOriginPricingInputs(fsOf(open), cache, { ...base('dave', 'pe_D'), inputOrigins: wire([cite(s)]) }, unlinked);
    expect(counted.origins[0].reason).toBe('consumption_edge');
    expect((await consumptionOf(open, 'alice')).consumption_edges).toBe(1);
  });

  it('RED — a declared (unsigned) pe: citation records as unsigned and is never Consumption', async () => {
    const d = createFakeFirestore();
    d.store.set('pe_history/pe_a1', { peId: 'pe_a1', userId: 'alice', actionType: 'coding_session', timestamp: 1 });
    const r = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('bob', 'pe_b7'), inputOrigins: wire([{ hash: 'pe:pe_a1', origin_identifier: 'pe:pe_a1', witnessed: true, witness: CITING_WITNESS }]),
    }, unlinked);
    expect(r.origins[0]).toMatchObject({ owner: 'signer:alice', witnessed: true, reason: 'consumption_edge' });
    const summary = await consumptionOf(d, 'alice');
    expect(summary.consumption_edges).toBe(0);
    expect(summary.unsigned_edges).toBe(1);
    expect(pairOf(d, 'bob', 'signer:alice')).toMatchObject({ pe_consumption: 0, cite_unsigned: 1 });
  });

  it('one PE citing the same signed output twice is ONE citation; two different outputs are two', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const s1 = await walletSign(ALICE, 'one');
    const s2 = await walletSign(ALICE, 'two');
    await resolveOriginPricingInputs(fsOf(d), cache, { ...base('bob', 'pe_b8'), inputOrigins: wire([cite(s1), cite(s1), cite(s2)]) }, unlinked);
    const summary = await consumptionOf(d, 'alice');
    expect(summary.consumption_edges).toBe(2);
    expect(summary.independent_consumers).toBe(1);
  });
});

describe('the meter batch path: staged edges fold into meter_pair_counts_v1 with no per-citation document', () => {
  it('a signed citation staged by a batch increments the pair\'s pe_consumption; nothing else is written', async () => {
    const d = createFakeFirestore();
    seedNative(d, ALICE, 'alice');
    const before = new Set(d.store.keys());
    const s = await walletSign(ALICE, 'served over x402');
    const r = await resolveOriginPricingInputs(fsOf(d), cache, {
      ...base('bob', 'pe_m1'), inputOrigins: wire([cite(s)]), batchEdges: newBatchOriginEdges(),
    }, unlinked);
    expect(r.stagedEdges).toHaveLength(1);
    await d.runTransaction(async (txn) => { stageNewOriginEdges(txn as never, fsOf(d), r.stagedEdges ?? []); });
    const written = [...d.store.keys()].filter((k) => !before.has(k));
    // Exactly one document: the (bob, alice) pair. No edge, no per-output or per-citation row.
    expect(written).toEqual([`${CITATION_PAIR_COUNTS_COLLECTION}/${citationPairId('bob', 'signer:alice')}`]);
    expect(pairOf(d, 'bob', 'signer:alice')).toMatchObject({ pe_consumption: 1, edges: 1 });
  });

  it('citationIncrementsOf: a witnessed out: consumption edge counts; RED — unwitnessed, ring and pe: do not', () => {
    const edge = { owner: 'signer:alice', counted: false, scheme: 'out', closed_loop: false, reason: 'consumption_edge' as const, witnessed: true };
    expect(citationIncrementsOf(edge)?.pe_consumption).toBe(1);
    expect(citationIncrementsOf({ ...edge, witnessed: false, reason: 'unwitnessed' })).toMatchObject({ pe_consumption: 0, pe_unwitnessed: 1 });
    expect(citationIncrementsOf({ ...edge, closed_loop: true, reason: 'closed_loop' })).toMatchObject({ pe_consumption: 0, pe_ring_excluded: 1 });
    expect(citationIncrementsOf({ ...edge, scheme: 'pe' })).toMatchObject({ pe_consumption: 0, cite_unsigned: 1 });
  });
});
