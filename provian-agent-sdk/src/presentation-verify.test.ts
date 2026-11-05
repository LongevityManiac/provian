/**
 * Burn-to-present REQUESTER (SDK) — challenge + trustless verify + RED controls.
 *
 * End-to-end: the PRESENTER (an agent key) signs the exact binding the backend
 * would, and the REQUESTER verifies it offline. Non-vacuous — a valid presentation
 * VERIFIES — paired with RED controls for every binding property (wrong challenge,
 * wrong audience, tampered signature, expired, unknown JWKS kid, bad JWS sig).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { keccak256, encodePacked } from 'viem';
import { buildAgentPresentationRequest } from './presentation';
import { deriveAgentIdentityFromPrivateKey } from './wallet';
import {
  issuePresentationChallenge,
  verifyPresentationToken,
  decodePresentationToken,
  PROVIAN_BASE_PE_ANCHOR,
  PRESENTATION_ISSUER,
  PRESENTATION_PEFACT_TYP,
} from './presentation-verify';
import { createMemorySeenStore } from './challenge';
import { actLeafOf, actRecordOf, batchLeafOf, merkleProofOf } from './meter-wire';
import { anchoredStore, ANCHORED_ACTOR_ID, ANCHORED_DEVICE_ID } from './meter/anchored-store.test-support';

/** every verify here uses its own seen-store (acceptOnce is on by default, and these
 * fixtures share one BURN_ID), so no test observes another's accepted presentation. */
const fresh = () => ({ seenStore: createMemorySeenStore() });
import type { Presentation, PresentationJwk } from './presentation-verify';

// Mock ONLY viem's createPublicClient (the on-chain read path) — every other viem
// export (keccak256, encodePacked, recoverMessageAddress, …) stays real, so the
// binding/PoP/leaf math is exercised for real. readContract is a spy each on-chain
// test drives; a refusal that fires BEFORE the chain read asserts it was never called.
const { readContractMock } = vi.hoisted(() => ({ readContractMock: vi.fn() }));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ readContract: readContractMock }) };
});
beforeEach(() => { readContractMock.mockReset(); });

/** The anchored leaf-domain hash, byte-identical to the backend + on-chain rule. */
function leafOf(envelopeHash: string): string {
  return keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', envelopeHash as `0x${string}`]));
}

// A fixed agent private key (test-only).
const AGENT_KEY = 'a'.repeat(64);
const { address: PRESENTER_ADDR, publicKey: PRESENTER_PUB } = deriveAgentIdentityFromPrivateKey(AGENT_KEY);

const AUD = 'requester-agent-1';
const NOW = 1_800_000_000;
const DEFAULT_HASH = '0x' + 'ab'.repeat(32); // one real 32-byte envelope hash
const BURN_ID = 'b'.repeat(64);

// ── Provian pe_fact CO-SIGN signing key (test-only Ed25519). The relay signs the
// co-sign in production; the requester verifies it against the fetched JWKS. ──────
function makeCosignKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'test-cosign-kid-1';
  const jwks: PresentationJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid }];
  const signWith = (payload: unknown, typ = PRESENTATION_PEFACT_TYP, key = privateKey): string => {
    const header = { alg: 'EdDSA', typ, kid };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  return { jwks, signWith, kid };
}
const COSIGN = makeCosignKey();

/** The canonical pe_fact co-sign payload, matching the backend buildPeFactCosignPayload. */
function cosignPayload(fields: { presenterAddress: string; burnId: string; claims: { pe_id: string; envelope_hash: string }[]; jti: string; iat: number; exp: number }) {
  return {
    v: 1, iss: PRESENTATION_ISSUER, ctx: 'pe_fact_cosign',
    presenter_address: fields.presenterAddress.toLowerCase(), burn_id: fields.burnId,
    pe_facts: fields.claims.map((c) => ({ pe_id: c.pe_id, envelope_hash: c.envelope_hash.toLowerCase() })),
    jti: fields.jti, iat: fields.iat, exp: fields.exp,
  };
}

/** Assemble a full, Provian-co-signed pe_fact Presentation the way the backend
 *  produces one: one real claim, its anchor proof, and a valid co-sign. */
function buildPeFactPresentation(over?: { challenge?: string; audience?: string; iat?: number; exp?: number; jws?: string; claims?: { pe_id: string; envelope_hash: string }[] }): { presentation: Presentation; challenge: string; audience: string } {
  const challenge = over?.challenge ?? issuePresentationChallenge({ audience: AUD }).challenge;
  const audience = over?.audience ?? AUD;
  const claims = over?.claims ?? [{ pe_id: 'pe_1', envelope_hash: DEFAULT_HASH }];
  const { body } = buildAgentPresentationRequest({
    privateKeyHex: AGENT_KEY,
    tier: 'pe_fact',
    burnId: BURN_ID,
    audience,
    challenge,
    nowSeconds: over?.iat ?? NOW,
    peFacts: claims.map((c) => ({ peId: c.pe_id, envelopeHash: c.envelope_hash })),
  });
  const exp = over?.exp ?? body.exp;
  const jws = over?.jws ?? COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: body.burn_id, claims, jti: body.jti, iat: body.iat, exp }));
  const presentation: Presentation = {
    tier: 'pe_fact',
    payload: {
      v: 1, tier: 'pe_fact', iss: PRESENTER_ADDR.toLowerCase(), sub: 'agent-wallet-x',
      presenter_address: PRESENTER_ADDR.toLowerCase(), aud: body.audience, chal: body.challenge,
      iat: body.iat, exp, jti: body.jti, burn_id: body.burn_id,
      presenter_pop: body.pop, pe_facts: claims,
    },
    provian_jws: jws,
    proofs: claims.map((c) => ({ pe_id: c.pe_id, envelope_hash: c.envelope_hash, anchored: true as const, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: leafOf(c.envelope_hash) }, merkle_proof: ['0x' + '22'.repeat(32)] })),
  };
  return { presentation, challenge, audience };
}

describe('issuePresentationChallenge', () => {
  it('returns an unguessable nonce bound to the requester audience', () => {
    const c = issuePresentationChallenge({ audience: AUD });
    expect(c.audience).toBe(AUD);
    expect(c.challenge.length).toBeGreaterThanOrEqual(16);
    // Two challenges differ (fresh randomness).
    expect(issuePresentationChallenge({ audience: AUD }).challenge).not.toBe(c.challenge);
  });
});

describe('pe_fact verify (trustless, offline) — reachable + RED controls', () => {
  it('a valid presentation VERIFIES against the issued challenge + audience', async () => {
    const { presentation, challenge } = buildPeFactPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r.valid).toBe(true);
    if (r.valid) { expect(r.tier).toBe('pe_fact'); expect(r.onchainChecked).toBe(false); }
  });

  it('round-trips through the opaque token form', async () => {
    const { presentation, challenge } = buildPeFactPresentation();
    const token = Buffer.from(JSON.stringify(presentation), 'utf8').toString('base64url');
    expect(decodePresentationToken(token)).not.toBeNull();
    const r = await verifyPresentationToken(token, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r.valid).toBe(true);
  });

  it('RED: a WRONG challenge is refused (challenge_mismatch)', async () => {
    const { presentation } = buildPeFactPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: 'not-the-challenge-000', jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'challenge_mismatch' });
  });

  it('RED: a WRONG audience is refused (audience_mismatch)', async () => {
    const { presentation, challenge } = buildPeFactPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: 'someone-else', expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'audience_mismatch' });
  });

  it('RED: a tampered presenter signature is refused (bad_presenter_pop)', async () => {
    const { presentation, challenge } = buildPeFactPresentation();
    const tampered: Presentation = {
      ...presentation,
      payload: { ...presentation.payload, presenter_pop: { ...presentation.payload.presenter_pop, signature: '30' + '00'.repeat(40) } },
    };
    const r = await verifyPresentationToken(tampered, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'bad_presenter_pop' });
  });

  it('RED: an EXPIRED presentation is refused (expired)', async () => {
    const { presentation, challenge } = buildPeFactPresentation({ iat: NOW - 1000, exp: NOW - 500 });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'expired' });
  });

  it('requireOnchain with no rpcUrl reads the DEFAULT Base RPC — an unreadable chain refuses', async () => {
    // Pre- this returned pe_fact_onchain_unchecked without touching the chain. Now the check
    // runs through https://mainnet.base.org; the (mocked) read fails → refused, never valid.
    readContractMock.mockRejectedValue(new Error('network down'));
    const { presentation, challenge } = buildPeFactPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, requireOnchain: true, nowSeconds: NOW + 10, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_proof_onchain_invalid' });
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });
});

describe('pe_fact ON-CHAIN verify — pinned anchor + leaf binding + RED controls', () => {
  const HASH_A = '0x' + 'ab'.repeat(32); // a real 32-byte envelope hash
  const HASH_B = '0x' + 'cd'.repeat(32); // a DIFFERENT real hash (leaf(A) != leaf(B))

  /** A pe_fact presentation the presenter signs over `claimedHash`, embedding a
   *  proof whose leaf is `leaf(leafHash)` and whose anchor names `contractAddress`
   *  (omitted → absent). Real ECDSA PoP over the exact binding. */
  function buildAnchored(opts: { claimedHash: string; leafHash: string; contractAddress?: string }): { presentation: Presentation; challenge: string } {
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const claims = [{ pe_id: 'pe_1', envelope_hash: opts.claimedHash }];
    const { body } = buildAgentPresentationRequest({
      privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge, nowSeconds: NOW,
      peFacts: claims.map((c) => ({ peId: c.pe_id, envelopeHash: c.envelope_hash })),
    });
    const anchor: Record<string, unknown> = { batch_id: '0x' + '11'.repeat(32) };
    if (opts.contractAddress) anchor.contract_address = opts.contractAddress;
    // A real co-sign over the CLAIMED hash — so the co-sign always binds and the
    // on-chain / leaf logic is what these tests actually exercise.
    const jws = COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: body.burn_id, claims, jti: body.jti, iat: body.iat, exp: body.exp }));
    const presentation: Presentation = {
      tier: 'pe_fact',
      payload: {
        v: 1, tier: 'pe_fact', iss: PRESENTER_ADDR.toLowerCase(), sub: 'x', presenter_address: PRESENTER_ADDR.toLowerCase(),
        aud: AUD, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id,
        presenter_pop: body.pop, pe_facts: claims,
      },
      provian_jws: jws,
      proofs: [{ pe_id: 'pe_1', envelope_hash: opts.claimedHash, anchored: true, anchor, leaf: { leaf_value: leafOf(opts.leafHash) }, merkle_proof: ['0x' + '22'.repeat(32)] }],
    };
    return { presentation, challenge };
  }

  it('a matching leaf + pinned anchor + on-chain inclusion VERIFIES (onchainChecked)', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_A, leafHash: HASH_A });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.onchainChecked).toBe(true);
    expect(readContractMock).toHaveBeenCalledTimes(1);
    // The chain read used the PINNED anchor, never a presenter-supplied address.
    expect((readContractMock.mock.calls[0][0] as { address: string }).address.toLowerCase()).toBe(PROVIAN_BASE_PE_ANCHOR.toLowerCase());
  });

  it('RED (defect 1): a presenter-named anchor contract is REFUSED even if it would return true', async () => {
    // The attacker points anchor.contract_address at a contract of its own whose
    // verifyPE returns true. Pinning must refuse it WITHOUT ever reading the chain.
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_A, leafHash: HASH_A, contractAddress: '0x' + 'de'.repeat(20) });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_anchor_untrusted' });
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it('RED (defect 3): a genuine anchored leaf replayed under a FORGED claimed hash is refused (pe_fact_leaf_mismatch)', async () => {
    // Presenter validly signs over HASH_B (its own claim) but embeds leaf(HASH_A) —
    // a real anchored leaf from a different PE. Must be caught by the leaf binding
    // BEFORE any chain read (which, on the real leaf, would pass).
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_B, leafHash: HASH_A });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_leaf_mismatch' });
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it('RED (defect 3, offline): the leaf binding holds even with no rpcUrl', async () => {
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_B, leafHash: HASH_A });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_leaf_mismatch' });
  });

  it('RED: a matching leaf + pinned anchor whose on-chain inclusion is FALSE is refused', async () => {
    readContractMock.mockResolvedValue(false);
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_A, leafHash: HASH_A });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_proof_onchain_invalid' });
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('an explicit anchor.contract_address EQUAL to the pinned anchor is accepted', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildAnchored({ claimedHash: HASH_A, leafHash: HASH_A, contractAddress: PROVIAN_BASE_PE_ANCHOR });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r.valid).toBe(true);
  });
});

describe('pe_fact meter_act proofs (PE meter: the presenter supplied the PE; the relay embedded both hops)', () => {
  /** A co-signed pe_fact whose proof is the relay's `meter_act` leaf for one anchored-store PE. */
  async function buildMeterFact(mutate: (leaf: Record<string, unknown>) => Record<string, unknown> = (l) => l, claimed?: string) {
    const { pes, actsRoot, batchHash } = await anchoredStore({ pes: 3 });
    const pe = pes[1];
    const acts = pes.map(actRecordOf);
    const batch = { device_id: ANCHORED_DEVICE_ID, actor_id: ANCHORED_ACTOR_ID, seq: 1, batch_hash: batchHash };
    const batchLeaf = batchLeafOf({ ...batch, acts_root: actsRoot });
    const leaf = mutate({
      kind: 'meter_act', leaf_value: leafOf('0x' + batchLeaf), act: acts[1], act_index: 1,
      act_proof: merkleProofOf(acts.map(actLeafOf), 1), acts_root: actsRoot, batch, batch_leaf: batchLeaf,
    });
    const claimedHash = claimed ?? pe.pe_hash;
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const claims = [{ pe_id: pe.pe_id, envelope_hash: claimedHash }];
    const { body } = buildAgentPresentationRequest({
      privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge, nowSeconds: NOW,
      peFacts: claims.map((c) => ({ peId: c.pe_id, envelopeHash: c.envelope_hash })),
    });
    const jws = COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: body.burn_id, claims, jti: body.jti, iat: body.iat, exp: body.exp }));
    const presentation: Presentation = {
      tier: 'pe_fact',
      payload: {
        v: 1, tier: 'pe_fact', iss: PRESENTER_ADDR.toLowerCase(), sub: 'x', presenter_address: PRESENTER_ADDR.toLowerCase(),
        aud: AUD, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id,
        presenter_pop: body.pop, pe_facts: claims,
      },
      provian_jws: jws,
      proofs: [{ pe_id: pe.pe_id, envelope_hash: claimedHash, anchored: true, anchor: { kind: 'meter_day', batch_id: '0x' + '11'.repeat(32), day: '2026-10-02', chain_id: 8453 }, leaf, merkle_proof: ['0x' + '22'.repeat(32)] }],
    };
    return { presentation, challenge, leafValue: leaf.leaf_value };
  }

  it('a meter_act proof verifies hop 1 offline and hop 2 against the pinned anchor (with the batch leaf)', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge, leafValue } = await buildMeterFact();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.onchainChecked).toBe(true);
    expect((readContractMock.mock.calls[0][0] as { args: unknown[] }).args[1]).toBe(leafValue);
  });

  it('RED: a meter_act proof under a different claimed hash, an edited act, or a swapped leaf is refused before any chain read', async () => {
    readContractMock.mockResolvedValue(true);
    const cases = [
      await buildMeterFact((l) => l, 'ef'.repeat(32)),
      await buildMeterFact((l) => ({ ...l, act: { ...(l.act as Record<string, unknown>), pricing: { metadata: { tool_count: 99 } } } })),
      await buildMeterFact((l) => ({ ...l, leaf_value: leafOf('0x' + 'ab'.repeat(32)) })),
      await buildMeterFact((l) => ({ ...l, batch: { ...(l.batch as Record<string, unknown>), actor_id: 'wallet_aw_other' } })),
    ];
    for (const { presentation, challenge } of cases) {
      const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
      expect(r).toEqual({ valid: false, reason: 'pe_fact_leaf_mismatch' });
    }
    expect(readContractMock).not.toHaveBeenCalled();
  });
});

describe('reputation verify (JWKS) — reachable + RED controls', () => {
  // Build a reputation presentation and sign the Provian JWS with a test Ed25519 key.
  function buildReputationPresentation(kid = 'test-kid-1'): { presentation: Presentation; challenge: string; jwks: PresentationJwk[]; badJwks: PresentationJwk[] } {
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const { body } = buildAgentPresentationRequest({
      privateKeyHex: AGENT_KEY, tier: 'reputation', burnId: 'c'.repeat(64), audience: AUD, challenge, nowSeconds: NOW,
      disclosure: { redact: ['pe_count'], predicates: [] },
    });
    const payload = {
      v: 1, tier: 'reputation' as const, iss: 'https://provian.ai', sub: 'agent-wallet-x',
      presenter_address: PRESENTER_ADDR.toLowerCase(), aud: AUD, chal: challenge,
      iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id, presenter_pop: body.pop,
      reputation: {
        facts: { 'standing.adverse_events': 0, 'standing.bond_active': 0, 'standing.open_bond_claims_against': 0, 'standing.invalidation_active': 0, 'standing.adverse_events_30d': 0, 'standing.adverse_events_90d': 0, 'standing.adverse_events_365d': 0 },
        predicates: [], redacted: ['pe_count'],
      },
    };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const jwkPub = publicKey.export({ format: 'jwk' }) as { x: string };
    const header = { alg: 'EdDSA', typ: 'provian-presentation+jwt', kid };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    const jws = `${h}.${p}.${sig}`;
    const presentation: Presentation = { tier: 'reputation', payload: payload as unknown as Presentation['payload'], provian_jws: jws };
    // A bad key set: same kid, but a DIFFERENT Ed25519 public key.
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string };
    return {
      presentation, challenge,
      jwks: [{ kty: 'OKP', crv: 'Ed25519', x: jwkPub.x, kid }],
      badJwks: [{ kty: 'OKP', crv: 'Ed25519', x: other.x, kid }],
    };
  }

  it('a valid reputation JWS VERIFIES against the JWKS', async () => {
    const { presentation, challenge, jwks } = buildReputationPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.tier).toBe('reputation');
  });

  it('RED: an unknown kid is refused (reputation_jws_unknown_kid)', async () => {
    const { presentation, challenge } = buildReputationPresentation('kid-A');
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'kid-B' }], nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'reputation_jws_unknown_kid' });
  });

  it('RED: a JWS verified against the WRONG public key is refused (reputation_jws_bad_signature)', async () => {
    const { presentation, challenge, badJwks } = buildReputationPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: badJwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'reputation_jws_bad_signature' });
  });

  it('RED: a reputation presentation with no JWS is refused (reputation_not_signed)', async () => {
    const { presentation, challenge, jwks } = buildReputationPresentation();
    const r = await verifyPresentationToken({ ...presentation, provian_jws: undefined }, { expectedAudience: AUD, expectedChallenge: challenge, jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'reputation_not_signed' });
  });
});

// =============================================================================
// pe_fact PROVIAN CO-SIGN (F61). The presenter signature + on-chain anchor prove
// the PEs exist and the presenter holds a live key; NEITHER proves the PEs belong
// to the presenter or that a burn was consumed. Provian co-signs those two facts
// and the requester REQUIRES it. Each property ships with its RED control.
describe('pe_fact Provian co-sign — required at verify (F61)', () => {
  it('POSITIVE: a genuinely co-signed pe_fact VERIFIES on-chain', async () => {
    readContractMock.mockResolvedValue(true);
    const { presentation, challenge } = buildPeFactPresentation();
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', nowSeconds: NOW + 10, ...fresh() });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.onchainChecked).toBe(true);
  });

  it('RED: a self-issued pe_fact with NO co-sign is refused (pe_fact_not_cosigned)', async () => {
    const { presentation, challenge } = buildPeFactPresentation();
    const r = await verifyPresentationToken({ ...presentation, provian_jws: undefined }, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_not_cosigned' });
    // The chain is never read for a presentation refused at the co-sign gate.
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it('RED: a co-sign minted with an ATTACKER Ed25519 key (real anchored PEs) is refused', async () => {
    // The classic F61 forgery: attacker controls its presenter key and cites a real
    // anchored PE, but cannot produce Provian\'s co-sign. It mints one with its OWN
    // key reusing the kid; verified against the real JWKS → bad_signature.
    const attacker = crypto.generateKeyPairSync('ed25519');
    const { body } = buildAgentPresentationRequest({ privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge: issuePresentationChallenge({ audience: AUD }).challenge, nowSeconds: NOW, peFacts: [{ peId: 'pe_1', envelopeHash: DEFAULT_HASH }] });
    const forgedJws = COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: body.burn_id, claims: [{ pe_id: 'pe_1', envelope_hash: DEFAULT_HASH }], jti: body.jti, iat: body.iat, exp: body.exp }), PRESENTATION_PEFACT_TYP, attacker.privateKey);
    const { presentation, challenge } = buildPeFactPresentation({ jws: forgedJws });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_cosign_bad_signature' });
  });

  it('RED: a reputation-typ JWS presented as a pe_fact co-sign is refused (pe_fact_cosign_wrong_typ)', async () => {
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const { body } = buildAgentPresentationRequest({ privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge, nowSeconds: NOW, peFacts: [{ peId: 'pe_1', envelopeHash: DEFAULT_HASH }] });
    const wrongTypJws = COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: body.burn_id, claims: [{ pe_id: 'pe_1', envelope_hash: DEFAULT_HASH }], jti: body.jti, iat: body.iat, exp: body.exp }), 'provian-presentation+jwt');
    const { presentation } = buildPeFactPresentation({ challenge, jws: wrongTypJws });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_cosign_wrong_typ' });
  });

  it('RED: a valid co-sign LIFTED from another burn is refused (pe_fact_cosign_payload_mismatch)', async () => {
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const { body } = buildAgentPresentationRequest({ privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge, nowSeconds: NOW, peFacts: [{ peId: 'pe_1', envelopeHash: DEFAULT_HASH }] });
    // A genuine Provian co-sign but over a DIFFERENT burn_id — cannot be lifted.
    const otherBurnJws = COSIGN.signWith(cosignPayload({ presenterAddress: PRESENTER_ADDR, burnId: 'e'.repeat(64), claims: [{ pe_id: 'pe_1', envelope_hash: DEFAULT_HASH }], jti: body.jti, iat: body.iat, exp: body.exp }));
    const { presentation } = buildPeFactPresentation({ challenge, jws: otherBurnJws });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
  });

  it('RED: a pe_fact with ZERO claims is refused (pe_fact_no_claims)', async () => {
    // PoP + co-sign both validly over an EMPTY claim set, so checkCommon passes and
    // the refusal is specifically the zero-claims minimum, not bad_presenter_pop.
    const { presentation, challenge } = buildPeFactPresentation({ claims: [] });
    const r = await verifyPresentationToken(presentation, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, nowSeconds: NOW + 10, requireOnchain: false, ...fresh() });
    expect(r).toEqual({ valid: false, reason: 'pe_fact_no_claims' });
  });

  it('RED: requireOnchain with an EMPTY proof list never returns valid:true/onchainChecked:false', async () => {
    // A co-signed pe_fact whose claim has no matching proof: pe_fact_no_proofs — and
    // requireOnchain can never slip through as valid with the chain unchecked.
    const { presentation, challenge } = buildPeFactPresentation();
    const noProofs: Presentation = { ...presentation, proofs: [] };
    const r = await verifyPresentationToken(noProofs, { expectedAudience: AUD, expectedChallenge: challenge, jwks: COSIGN.jwks, rpcUrl: 'http://rpc.test', requireOnchain: true, nowSeconds: NOW + 10, ...fresh() });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('pe_fact_no_proofs');
  });
});

// =============================================================================
// Requester-named disclosure (2026-10-10) — the REQUESTER verifies the answers: every named
// request answered (declined is an answer), every disclosed record proven against its anchored
// act record (hop 1 offline, hop 2 on Base through the pinned anchor), the PoP covering the
// elections + record identities. Each accepting property ships with its RED control.
// =============================================================================
import { normalizeDisclosureRequests, type DisclosureAnswer } from './disclosure-request';

describe('named disclosure verify (reputation tier) — reachable + RED controls', () => {
  const REQ_SIGNER = normalizeDisclosureRequests([{ kind: 'witness', signer: ANCHORED_DEVICE_ID, fields: ['metadata.tool_count'], content: ['description'] }])!;
  const REQ_PE = (digest: string) => normalizeDisclosureRequests([{ kind: 'pe', output_digest: digest }])!;

  /** A reputation presentation answering `requests`, with `records` proven by meter_act proofs. */
  async function buildDisclosurePresentation(opts: {
    requests?: ReturnType<typeof normalizeDisclosureRequests>;
    mutateAnswer?: (a: DisclosureAnswer) => DisclosureAnswer;
    mutateAfterSigning?: (answers: DisclosureAnswer[], pes: Awaited<ReturnType<typeof anchoredStore>>['pes']) => DisclosureAnswer[];
    decline?: boolean;
  } = {}) {
    const requests = opts.requests ?? REQ_SIGNER;
    const { pes, actsRoot, batchHash } = await anchoredStore({ pes: 3 });
    const acts = pes.map(actRecordOf);
    const batch = { device_id: ANCHORED_DEVICE_ID, actor_id: ANCHORED_ACTOR_ID, seq: 1, batch_hash: batchHash };
    const batchLeaf = batchLeafOf({ ...batch, acts_root: actsRoot });
    const proofOf = (i: number) => ({
      pe_id: pes[i].pe_id, envelope_hash: pes[i].pe_hash, anchored: true,
      anchor: { kind: 'meter_day', batch_id: '0x' + '11'.repeat(32), day: '2026-10-02', chain_id: 8453 },
      leaf: { kind: 'meter_act', leaf_value: leafOf('0x' + batchLeaf), act: acts[i], act_index: i, act_proof: merkleProofOf(acts.map(actLeafOf), i), acts_root: actsRoot, batch, batch_leaf: batchLeaf },
      merkle_proof: ['0x' + '22'.repeat(32)],
    });
    // The relay-derived record for pe 1 (what the Provian JWS carries).
    const recordFor = (i: number): DisclosureAnswer['records'] extends readonly (infer R)[] | undefined ? R : never => ({
      pe_id: pes[i].pe_id, pe_hash: pes[i].pe_hash, action_type: pes[i].action_type, timestamp: pes[i].timestamp,
      witness: { kind: 'device', signer: ANCHORED_DEVICE_ID },
      fields: { 'metadata.tool_count': i + 1 }, content: { description: `turn ${i}` },
    });
    const baseAnswer: DisclosureAnswer = opts.decline
      ? { request: requests[0], election: 'declined' }
      : { request: requests[0], election: 'disclosed', records: [recordFor(1)] };
    const answer = opts.mutateAnswer ? opts.mutateAnswer(baseAnswer) : baseAnswer;
    const challenge = issuePresentationChallenge({ audience: AUD, disclosures: requests }).challenge;
    const { body } = buildAgentPresentationRequest({
      privateKeyHex: AGENT_KEY, tier: 'reputation', burnId: 'd'.repeat(64), audience: AUD, challenge, nowSeconds: NOW,
      disclosure: { redact: [], predicates: [] },
      disclosures: [{ request: answer.request, election: answer.election, ...(answer.election === 'disclosed' ? { records: (answer.records ?? []).map((r) => ({ peId: r.pe_id, envelopeHash: r.pe_hash, pe: pes[1], inclusion: {} })) } : {}) }],
    });
    const signedAnswers = opts.mutateAfterSigning ? opts.mutateAfterSigning([answer], pes) : [answer];
    const payload = {
      v: 1, tier: 'reputation' as const, iss: 'https://provian.ai', sub: 'agent-wallet-x',
      presenter_address: PRESENTER_ADDR.toLowerCase(), aud: AUD, chal: challenge,
      iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id, presenter_pop: body.pop,
      reputation: {
        facts: { 'standing.adverse_events': 0, 'standing.bond_active': 0, 'standing.open_bond_claims_against': 0, 'standing.invalidation_active': 0, 'standing.adverse_events_30d': 0, 'standing.adverse_events_90d': 0, 'standing.adverse_events_365d': 0 },
        predicates: [], redacted: [],
      },
      disclosures: signedAnswers,
    };
    const header = { alg: 'EdDSA', typ: 'provian-presentation+jwt', kid: COSIGN.kid };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const jws = `${h}.${p}.${COSIGN.signWith(payload, 'provian-presentation+jwt').split('.')[2]}`;
    const presentation: Presentation = { tier: 'reputation', payload: payload as unknown as Presentation['payload'], provian_jws: jws, disclosure_proofs: [proofOf(1)] as unknown as Presentation['disclosure_proofs'] };
    return { presentation, challenge, requests, pes };
  }

  const verifyOpts = (challenge: string, requests: unknown, over: Record<string, unknown> = {}) => ({
    expectedAudience: AUD, expectedChallenge: challenge, expectedDisclosures: requests as never, jwks: COSIGN.jwks, nowSeconds: NOW + 10, ...fresh(), ...over,
  });

  it('a disclosed record VERIFIES offline (hop 1) and returns the answers; with an RPC the anchor is checked (onchainChecked)', async () => {
    const { presentation, challenge, requests, pes } = await buildDisclosurePresentation();
    const offline = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { requireOnchain: false }));
    expect(offline.valid).toBe(true);
    if (offline.valid) {
      expect(offline.onchainChecked).toBe(false);
      expect(offline.disclosures?.[0].election).toBe('disclosed');
      expect(offline.disclosures?.[0].records?.[0].pe_id).toBe(pes[1].pe_id);
      expect(offline.disclosures?.[0].records?.[0].fields).toEqual({ 'metadata.tool_count': 2 });
    }
    readContractMock.mockResolvedValue(true);
    const onchain = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { rpcUrl: 'http://rpc.test' }));
    expect(onchain.valid).toBe(true);
    if (onchain.valid) expect(onchain.onchainChecked).toBe(true);
    expect(readContractMock).toHaveBeenCalled();
  });

  it('a DECLINED answer verifies as declined — the gate decides; nothing is disclosed', async () => {
    const { presentation, challenge, requests } = await buildDisclosurePresentation({ decline: true });
    const r = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { requireOnchain: false }));
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.disclosures).toEqual([{ request: requests[0], election: 'declined' }]);
      expect(r.onchainChecked).toBe(false);
    }
  });

  it('RED: a named request the presentation does not answer is refused (disclosures_unanswered)', async () => {
    const { presentation, challenge } = await buildDisclosurePresentation();
    const other = normalizeDisclosureRequests([{ kind: 'witness', signer: ANCHORED_DEVICE_ID }, { kind: 'witness', issuer: 'chain:base' }])!;
    const r = await verifyPresentationToken(presentation, verifyOpts(challenge, other, { requireOnchain: false }));
    expect(r).toEqual({ valid: false, reason: 'disclosures_unanswered' });
  });

  it('RED: a disclosed field that does not match the anchored act, an unrequested field, unrequested or forged artifact content, a wrong type or a fake chain witness is refused (disclosure_record_invalid)', async () => {
    // (A description is free text the anchored ACT record does not carry: the relay derives it from
    // the presented PE bytes it hash-checked and signs it, so the requester relies on the Provian
    // signature for it — the relay-side suite proves a description can only come from the PE.)
    const cases = [
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], fields: { 'metadata.tool_count': 99 } }] }),
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], fields: { 'metadata.tool_count': 2, 'metadata.turn_id': 'tc:1' } }] }),
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], content: { description: 'turn 1', artifacts: [{ hash: 'ab'.repeat(32), kind: 'file' }] } }] }),
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], content: { description: 'turn 1', intent: 'x' } }] }),
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], action_type: 'coding_session' }] }),
      (a: DisclosureAnswer) => ({ ...a, records: [{ ...a.records![0], witness: { kind: 'chain' as const, issuer: 'chain:base', ref: '0x' + '3c'.repeat(32) } }] }),
    ];
    for (const mutateAnswer of cases) {
      const { presentation, challenge, requests } = await buildDisclosurePresentation({ mutateAnswer });
      const r = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { requireOnchain: false }));
      expect(r).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    }
  });

  it('RED: a record swapped in after the PoP signed (a different pe_id/pe_hash) breaks the presenter signature', async () => {
    const { presentation, challenge, requests } = await buildDisclosurePresentation({
      mutateAfterSigning: (answers, pes) => [{ ...answers[0], records: [{ ...answers[0].records![0], pe_id: pes[2].pe_id, pe_hash: pes[2].pe_hash, timestamp: pes[2].timestamp, fields: { 'metadata.tool_count': 3 }, content: { description: 'turn 2' } }] }],
    });
    const r = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { requireOnchain: false }));
    expect(r).toEqual({ valid: false, reason: 'bad_presenter_pop' });
  });

  it('RED: a disclosed record whose proof is missing or anchored FALSE on chain is refused; the on-chain requirement cannot be skipped silently', async () => {
    const { presentation, challenge, requests } = await buildDisclosurePresentation();
    const noProof = await verifyPresentationToken({ ...presentation, disclosure_proofs: [] }, verifyOpts(challenge, requests, { requireOnchain: false }));
    expect(noProof).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    readContractMock.mockResolvedValue(false);
    const notAnchored = await verifyPresentationToken(presentation, verifyOpts(challenge, requests, { rpcUrl: 'http://rpc.test' }));
    expect(notAnchored).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
  });

  it('RED: a challenge naming disclosures refuses a pe_fact presentation (disclosures_require_reputation_tier)', async () => {
    const { pes } = await anchoredStore({ pes: 1 });
    const challenge = issuePresentationChallenge({ audience: AUD }).challenge;
    const { body } = buildAgentPresentationRequest({ privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId: BURN_ID, audience: AUD, challenge, nowSeconds: NOW, peFacts: [{ peId: pes[0].pe_id, envelopeHash: pes[0].pe_hash }] });
    const presentation: Presentation = { tier: 'pe_fact', payload: { v: 1, tier: 'pe_fact', iss: PRESENTER_ADDR.toLowerCase(), sub: 'x', presenter_address: PRESENTER_ADDR.toLowerCase(), aud: AUD, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id, presenter_pop: body.pop, pe_facts: [{ pe_id: pes[0].pe_id, envelope_hash: pes[0].pe_hash }] } as unknown as Presentation['payload'] };
    const r = await verifyPresentationToken(presentation, verifyOpts(challenge, REQ_PE(pes[0].pe_hash), { requireOnchain: false }));
    expect(r).toEqual({ valid: false, reason: 'disclosures_require_reputation_tier' });
  });
});
