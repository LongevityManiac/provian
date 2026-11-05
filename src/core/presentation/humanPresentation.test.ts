/**
 * Burn-to-present (human side) — binding conformance + EIP-191 round-trip.
 *
 * The binding is a CROSS-PACKAGE contract with the backend and the agent SDK. The
 * SAME fixed vector is pinned here, in provian-backend's presentation.test.ts, and
 * in provian-agent-sdk's presentation.test.ts — if any package drifts, its own test
 * reddens and human presentations would fail the backend's presenter-pop check.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import {
  presentationBindingString,
  claimsDigest,
  canonicalReputationDirective,
  buildHumanPresentationRequest,
  burnIdForTx,
  validateRequesterBinding,
  parseChallengeQr,
  presenterMatchesCounterparty,
  extractPresenterLabel,
  PRESENTATION_CHALLENGE_MIN_LEN,
  PRESENTATION_CHALLENGE_MAX_LEN,
  PRESENTATION_AUDIENCE_MAX_LEN,
} from './humanPresentation';

const sha = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

const EMPTY_DIRECTIVE_DIGEST = sha('reputation\n{"redact":[],"predicates":[]}');
const EXPECTED_BINDING = [
  'provian-presentation-v1',
  'tier=reputation',
  'presenter=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'aud=requester-1',
  'chal=chal-fixed-000000000',
  'iat=1000',
  'exp=1300',
  'jti=jti-fixed',
  `burn=${'a'.repeat(64)}`,
  `claims=${EMPTY_DIRECTIVE_DIGEST}`,
].join('\n');

describe('binding conformance (cross-package pin)', () => {
  it('claimsDigest(reputation, empty directive) matches the pinned preimage', () => {
    expect(claimsDigest({ tier: 'reputation', directive: {} })).toBe(EMPTY_DIRECTIVE_DIGEST);
  });

  it('presentationBindingString matches the pinned vector byte-for-byte', () => {
    expect(presentationBindingString({
      tier: 'reputation', presenterAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      aud: 'requester-1', chal: 'chal-fixed-000000000', iat: 1000, exp: 1300, jti: 'jti-fixed',
      burnId: 'a'.repeat(64), claimsDigest: EMPTY_DIRECTIVE_DIGEST,
    })).toBe(EXPECTED_BINDING);
  });

  it('claimsDigest(pe_fact) sorts pe_id:envelope_hash pairs', () => {
    expect(claimsDigest({ tier: 'pe_fact', peFacts: [{ peId: 'pe-b', envelopeHash: '0xBB' }, { peId: 'pe-a', envelopeHash: '0xAA' }] })).toBe(sha('pe_fact\npe-a:0xaa\npe-b:0xbb'));
  });
});

describe('buildHumanPresentationRequest — EIP-191 round-trip', () => {
  it('signs the binding so the presenter address recovers the way the backend verifies', async () => {
    const wallet = ethers.Wallet.createRandom();
    const addr = wallet.address.toLowerCase();
    const { body, binding } = await buildHumanPresentationRequest(
      { tier: 'reputation', burnId: 'a'.repeat(64), audience: 'requester-1', challenge: 'chal-1616161616161616', ttlSeconds: 300, nowSeconds: 1000, jti: 'j1', disclosure: { redact: ['streak_days'] } },
      addr,
      (msg) => wallet.signMessage(msg),
    );
    expect(body.tier).toBe('reputation');
    expect(body.pop.scheme).toBe('eip191_secp256k1');
    expect(body.disclosure).toEqual({ redact: ['streak_days'], predicates: [] });
    // The backend verifies via ethers.verifyMessage(binding, sig) === presenter_address.
    expect(ethers.verifyMessage(binding, body.pop.signature).toLowerCase()).toBe(addr);
    // RED: a tampered binding recovers a DIFFERENT address (verification fails).
    expect(ethers.verifyMessage(binding + 'x', body.pop.signature).toLowerCase()).not.toBe(addr);
  });

  it('clamps an over-long ttl to the max window and carries pe_facts for pe_fact', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { body } = await buildHumanPresentationRequest(
      { tier: 'pe_fact', burnId: 'a'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', ttlSeconds: 999999, nowSeconds: 1000, jti: 'j1', peFacts: [{ peId: 'pe-1', envelopeHash: '0xh' }] },
      wallet.address.toLowerCase(),
      (msg) => wallet.signMessage(msg),
    );
    expect(body.exp - body.iat).toBe(900);
    expect(body.pe_facts).toEqual([{ pe_id: 'pe-1', envelope_hash: '0xh' }]);
  });

  it('carries each PE and its inclusion proof (the relay keeps no PE,); the signed binding is unchanged by them', async () => {
    const wallet = ethers.Wallet.createRandom();
    const base = { tier: 'pe_fact' as const, burnId: 'a'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', nowSeconds: 1000, jti: 'j1' };
    const pe = { schema: 'provian.pe.v2', pe_id: 'pe-1', pe_hash: 'h'.repeat(64) };
    const inclusion = { act_index: 0, act_proof: [], acts_root: 'r'.repeat(64) };
    const withProof = await buildHumanPresentationRequest({ ...base, peFacts: [{ peId: 'pe-1', envelopeHash: '0xh', pe, inclusion }] }, wallet.address.toLowerCase(), (m) => wallet.signMessage(m));
    const without = await buildHumanPresentationRequest({ ...base, peFacts: [{ peId: 'pe-1', envelopeHash: '0xh' }] }, wallet.address.toLowerCase(), (m) => wallet.signMessage(m));
    expect(withProof.body.pe_facts).toEqual([{ pe_id: 'pe-1', envelope_hash: '0xh', pe, inclusion }]);
    expect(withProof.binding).toBe(without.binding);
  });
});

// a pipelined present binds to the burn id the relay will record (sha256 of
// "<chain>:<lowercase tx hash>") — the SAME vector is pinned in provian-backend's
// burn-record.wait.test.ts and provian-agent-sdk's presentation.test.ts.
describe('burnIdForTx + burnTx (pipelined present)', () => {
  const TX = '0x' + 'AB'.repeat(32);
  it('matches the cross-package vector (case-insensitive tx hash)', () => {
    expect(burnIdForTx('base', TX)).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
    expect(burnIdForTx('base', TX.toLowerCase())).toBe(burnIdForTx('base', TX));
  });
  it('carries the broadcast burn to /present and binds its id', async () => {
    const wallet = ethers.Wallet.createRandom();
    const burnId = burnIdForTx('base', TX);
    const { body, binding } = await buildHumanPresentationRequest(
      { tier: 'pe_fact', burnId, audience: 'r', challenge: 'chal-1616161616161616', nowSeconds: 1000, jti: 'j1', burnTx: { txHash: TX, amountAtomic: '5000000000000000000' } },
      wallet.address.toLowerCase(),
      (msg) => wallet.signMessage(msg),
    );
    expect(body.burn).toEqual({ tx_hash: TX, amount_atomic: '5000000000000000000', chain: 'base' });
    expect(binding.split('\n')).toContain(`burn=${burnId}`);
  });
  it('RED: a burnId that is not the broadcast burn\'s id is refused before signing', async () => {
    let signed = 0;
    await expect(buildHumanPresentationRequest(
      { tier: 'pe_fact', burnId: 'f'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', burnTx: { txHash: TX, amountAtomic: '1' } },
      '0x' + '1'.repeat(40),
      async () => { signed += 1; return '0x'; },
    )).rejects.toThrow(/does not match/);
    expect(signed).toBe(0);
  });
  it('without burnTx the body carries no burn (the recorded-burn path is unchanged)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { body } = await buildHumanPresentationRequest(
      { tier: 'pe_fact', burnId: 'a'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', nowSeconds: 1000, jti: 'j1' },
      wallet.address.toLowerCase(),
      (msg) => wallet.signMessage(msg),
    );
    expect(body.burn).toBeUndefined();
  });
});

// F9: validate the requester binding BEFORE burning, so a hostile/malformed
// challenge can never strand a burn. Each guard ships with its RED control.
describe('validateRequesterBinding (F9 — pre-burn validation)', () => {
  const goodChallenge = 'x'.repeat(PRESENTATION_CHALLENGE_MIN_LEN);
  it('accepts a valid audience + challenge', () => {
    expect(validateRequesterBinding({ audience: 'requester-1', challenge: goodChallenge })).toEqual({ ok: true });
  });
  it('RED: rejects an empty audience', () => {
    expect(validateRequesterBinding({ audience: '  ', challenge: goodChallenge }).ok).toBe(false);
  });
  it('RED: rejects a too-short challenge (below the relay floor)', () => {
    expect(validateRequesterBinding({ audience: 'r', challenge: 'x'.repeat(PRESENTATION_CHALLENGE_MIN_LEN - 1) }).ok).toBe(false);
  });
  it('RED: rejects an oversized challenge / audience (above the relay cap)', () => {
    expect(validateRequesterBinding({ audience: 'r', challenge: 'x'.repeat(PRESENTATION_CHALLENGE_MAX_LEN + 1) }).ok).toBe(false);
    expect(validateRequesterBinding({ audience: 'a'.repeat(PRESENTATION_AUDIENCE_MAX_LEN + 1), challenge: goodChallenge }).ok).toBe(false);
  });
});

describe('parseChallengeQr (F9 — QR shape validation)', () => {
  const goodChallenge = 'x'.repeat(PRESENTATION_CHALLENGE_MIN_LEN);
  it('parses a well-formed challenge QR', () => {
    expect(parseChallengeQr(JSON.stringify({ audience: 'r', challenge: goodChallenge }))).toEqual({ audience: 'r', challenge: goodChallenge, predicates: [] });
  });
  it('§2.6: carries the requester-named predicates (comparison + set membership) in canonical order-preserving form', () => {
    const preds = [{ field: 'continuity.chain_depth', op: 'gte', threshold: 100 }, { field: 'standing.bond_active', op: 'in', set: [1] }];
    expect(parseChallengeQr(JSON.stringify({ audience: 'r', challenge: goodChallenge, predicates: preds }))).toEqual({ audience: 'r', challenge: goodChallenge, predicates: preds });
  });
  it('RED (§2.6): a malformed predicate list is NOT a valid request (unknown op / missing threshold / non-numeric set)', () => {
    for (const bad of [[{ field: 'x', op: 'between', threshold: 1 }], [{ field: 'x', op: 'gte' }], [{ field: 'x', op: 'in', set: ['a'] }], 'nope']) {
      expect(parseChallengeQr(JSON.stringify({ audience: 'r', challenge: goodChallenge, predicates: bad }))).toBeNull();
    }
  });
  it('RED: returns null for non-JSON', () => {
    expect(parseChallengeQr('not json')).toBeNull();
  });
  it('RED: returns null for a JSON object missing challenge', () => {
    expect(parseChallengeQr(JSON.stringify({ audience: 'r' }))).toBeNull();
  });
  it('RED: returns null when the embedded challenge is below the floor', () => {
    expect(parseChallengeQr(JSON.stringify({ audience: 'r', challenge: 'short' }))).toBeNull();
  });
});

describe('presenterMatchesCounterparty / extractPresenterLabel (F8)', () => {
  const payload = { presenter_address: '0xABCdef0000000000000000000000000000000001', sub: 'wallet_aw_xyz' };
  it('matches the counterparty by presenter_address (case-insensitive)', () => {
    expect(presenterMatchesCounterparty(payload, '0xabcdef0000000000000000000000000000000001')).toBe(true);
  });
  it('matches the counterparty by wallet-id subject', () => {
    expect(presenterMatchesCounterparty(payload, 'wallet_aw_xyz')).toBe(true);
  });
  it('RED: does NOT match a different presenter (the F8 forgery)', () => {
    expect(presenterMatchesCounterparty(payload, '0xdeadbeef00000000000000000000000000000009')).toBe(false);
  });
  it('RED: fail-closed on empty counterparty or unparseable payload', () => {
    expect(presenterMatchesCounterparty(payload, '')).toBe(false);
    expect(presenterMatchesCounterparty(null, 'x')).toBe(false);
  });
  it('extractPresenterLabel prefers the address, falls back to sub, else null', () => {
    expect(extractPresenterLabel(payload)).toBe('0xABCdef0000000000000000000000000000000001');
    expect(extractPresenterLabel({ sub: 'wallet_only' })).toBe('wallet_only');
    expect(extractPresenterLabel({})).toBeNull();
  });
});

describe('share-only disclosure — cross-package canonical pin', () => {
  it('canonicalizes share only when present (existing digests unchanged) and matches the relay digest byte-for-byte', () => {
    expect(JSON.stringify(canonicalReputationDirective({ redact: ['b', 'a'], predicates: [] }))).toBe('{"redact":["a","b"],"predicates":[]}');
    expect(JSON.stringify(canonicalReputationDirective({ redact: [], predicates: [], share: ['z', 'a', 'a'] }))).toBe('{"redact":[],"predicates":[],"share":["a","z"]}');
    // Computed by the RELAY's claimsDigest over its canonical share-only directive.
    expect(claimsDigest({ tier: 'reputation', directive: { redact: [], predicates: [], share: ['work.total'] } }))
      .toBe('40762420742dc3f5739b06253468266de3215172e26e89bcc5a1d2f044082d1e');
  });
  it('the request body carries the share list the PoP committed to', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { body } = await buildHumanPresentationRequest(
      { tier: 'reputation', burnId: 'a'.repeat(64), audience: 'gate', challenge: 'c'.repeat(32), disclosure: { redact: [], predicates: [], share: ['work.total'] } },
      wallet.address.toLowerCase(),
      (m) => wallet.signMessage(m),
    );
    expect((body as { disclosure?: { share?: string[] } }).disclosure?.share).toEqual(['work.total']);
  });
});
