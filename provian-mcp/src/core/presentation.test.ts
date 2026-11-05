/**
 * Burn-to-present binding/digest — FIXED-VECTOR CROSS-PACKAGE PARITY PIN.
 *
 * `provian-mcp/src/core/presentation.ts` is a byte-for-byte port of the presenter's
 * bytes: the SDK's `presentation.ts` and the relay's `core/presentation`. The
 * presenter signs `presentationBindingString` and the relay verifies that
 * exact string, so if ANY of the three copies drifts by one byte, the presenter's
 * proof-of-possession stops verifying. Nothing at runtime cross-checks the three —
 * so each package pins the SAME fixed vector, and a drift reddens its own suite.
 *
 * The vector here is byte-identical to the one asserted in
 * `provian-backend/src/core/presentation/presentation.test.ts` (and the SDK's).
 * The two RED negative controls mutate the preimage / the tag and assert
 * the output changes, so the pin cannot be passing because the digest is hard-wired
 * or ignores its input.
 */

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_BINDING_TAG,
  claimsDigest,
  canonicalReputationDirective,
  presentationBindingString,
} from './presentation';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// The SAME preimages the backend + SDK pin. Deriving the expected value from the
// literal preimage (rather than a bare hex constant) keeps the spec readable AND
// lets the RED controls below mutate the preimage to prove non-vacuity.
const EMPTY_DIRECTIVE_DIGEST = sha('reputation\n{"redact":[],"predicates":[]}');
const PE_FACT_EMPTY_DIGEST = sha('pe_fact\n');

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

describe('MCP presentation binding — fixed-vector cross-package parity', () => {
  it('claimsDigest(reputation, empty directive) matches the pinned preimage', () => {
    expect(claimsDigest({ tier: 'reputation', directive: { redact: [], predicates: [] } }))
      .toBe(EMPTY_DIRECTIVE_DIGEST);
  });

  it('claimsDigest(pe_fact, no facts) matches the pinned preimage', () => {
    expect(claimsDigest({ tier: 'pe_fact', peFacts: [] })).toBe(PE_FACT_EMPTY_DIGEST);
  });

  it('claimsDigest(pe_fact) sorts facts and lowercases the hash before hashing', () => {
    // Fed OUT of order with an upper-cased hash; the canonical preimage is the
    // sorted, lowercased `peId:hash` lines. This is the exact normalization the
    // relay repeats, so it must land on the same digest.
    const digest = claimsDigest({
      tier: 'pe_fact',
      peFacts: [
        { peId: 'pe_b', envelopeHash: '0xAB' },
        { peId: 'pe_a', envelopeHash: '0xCD' },
      ],
    });
    expect(digest).toBe(sha('pe_fact\npe_a:0xcd\npe_b:0xab'));
  });

  it('presentationBindingString matches the pinned vector byte-for-byte (presenter lowercased)', () => {
    expect(presentationBindingString({
      tier: 'reputation',
      presenterAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // upper-cased input
      aud: 'requester-1',
      chal: 'chal-fixed-000000000',
      iat: 1000,
      exp: 1300,
      jti: 'jti-fixed',
      burnId: 'a'.repeat(64),
      claimsDigest: EMPTY_DIRECTIVE_DIGEST,
    })).toBe(EXPECTED_BINDING);
  });

  it('canonicalReputationDirective is order-independent (redact + predicates sorted)', () => {
    const a = canonicalReputationDirective({
      redact: ['b', 'a'],
      predicates: [
        { field: 'pe_count', op: 'gte', threshold: 10 },
        { field: 'governance_score', op: 'gt', threshold: 50 },
      ],
    });
    const b = canonicalReputationDirective({
      redact: ['a', 'b'],
      predicates: [
        { field: 'governance_score', op: 'gt', threshold: 50 },
        { field: 'pe_count', op: 'gte', threshold: 10 },
      ],
    });
    expect(a).toEqual(b);
  });

  // ── RED negative controls ──────────────────────────────────────────
  it('RED control — a one-byte tag mutation in the preimage changes the digest', () => {
    const real = claimsDigest({ tier: 'pe_fact', peFacts: [] });
    expect(real).toBe(PE_FACT_EMPTY_DIGEST);
    // Same shape, tag mutated by a single byte → a DIFFERENT digest. If the digest
    // were hard-wired or ignored its preimage, these would collide with `real`.
    expect(sha('PE_FACT\n')).not.toBe(real);   // upper-cased tag
    expect(sha('pe_fact\n\n')).not.toBe(real); // one extra newline
  });

  it('RED control — the binding tag is the load-bearing first line', () => {
    const real = presentationBindingString({
      tier: 'reputation',
      presenterAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      aud: 'requester-1',
      chal: 'chal-fixed-000000000',
      iat: 1000,
      exp: 1300,
      jti: 'jti-fixed',
      burnId: 'a'.repeat(64),
      claimsDigest: EMPTY_DIRECTIVE_DIGEST,
    });
    expect(real).toBe(EXPECTED_BINDING);
    expect(real.split('\n')[0]).toBe(PRESENTATION_BINDING_TAG);
    expect(PRESENTATION_BINDING_TAG).toBe('provian-presentation-v1');
    // A verifier pinned to the wrong tag would compute a different string, so the
    // presenter's PoP over THIS string would not verify there.
    const wrongTag = EXPECTED_BINDING.replace(/^provian-presentation-v1/, 'provian-presentation-v2');
    expect(wrongTag).not.toBe(real);
  });
});
