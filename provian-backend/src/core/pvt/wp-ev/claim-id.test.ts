import { deriveClaimId, CLAIM_ID_GENESIS_PREV_HASH, type SealedEnvelopeIdentity } from './claim-id';

const BASE: SealedEnvelopeIdentity = {
  id: 'pe_9f2c4a1b-0000-4000-8000-000000000001',
  prev_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  timestamp: 1_780_000_000_000,
  action_type: 'work_product',
  user_id: 'user_abc',
};

function claimIdOf(pe: SealedEnvelopeIdentity): string {
  const result = deriveClaimId(pe);
  if (result.kind !== 'derived') throw new Error(`expected derivation, got ${result.reason}`);
  return result.claimId;
}

describe('deriveClaimId — shape', () => {
  it('produces a non-zero bytes32', () => {
    const claimId = claimIdOf(BASE);
    expect(claimId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(claimId).not.toBe(`0x${'0'.repeat(64)}`);
  });

  /**
   * Known answer. A claim id is a PE's permanent settlement identity, so the derivation
   * itself is frozen: changing the domain separator, the field set, or the preimage
   * encoding would re-identify every PE ever recorded and let already-settled work
   * re-enter the standard lane. Any such change must bump `CLAIM_ID_DOMAIN` deliberately
   * and land here as a visible, reviewed edit — never as a silent drift.
   */
  it('is pinned to a fixed vector', () => {
    expect(claimIdOf(BASE)).toBe('0x291078f11606addb8cacd5ee0a0889fad82ec4e8b7bfacef1d1ff118b667827b');
  });
});

describe('deriveClaimId — stable re-derivation', () => {
  it('yields the same id for the same PE on every call', () => {
    expect(claimIdOf(BASE)).toBe(claimIdOf(BASE));
    expect(claimIdOf({ ...BASE })).toBe(claimIdOf(BASE));
  });

  it('is independent of the key order of the input object', () => {
    const reordered = {
      user_id: BASE.user_id,
      action_type: BASE.action_type,
      timestamp: BASE.timestamp,
      hash: BASE.hash,
      prev_hash: BASE.prev_hash,
      id: BASE.id,
    } as SealedEnvelopeIdentity;
    expect(claimIdOf(reordered)).toBe(claimIdOf(BASE));
  });

  it('ignores every enrichment field, so later corroboration cannot move a claim id', () => {
    const enriched = {
      ...BASE,
      // `pe_history` enrichment — none of it may reach the preimage.
      mint_status: 'minted',
      corroboration_status: 'on_chain_verified',
      corroboration_source: 'watcher',
      attestation_multiplier_at_anchor: 1.1,
      audit_hold: false,
      // the two `provenance_envelopes` fields that DO mutate post-seal
      hidden: true,
      durability: 'final',
      // and a field excluded for diverging from `timestamp` on some writers
      created_at: 1_780_000_999_999,
    } as unknown as SealedEnvelopeIdentity;
    expect(claimIdOf(enriched)).toBe(claimIdOf(BASE));
  });

  it('is independent of attestation tier — identity is intrinsic at every tier', () => {
    const software = { ...BASE, attestation_type: 'software' } as unknown as SealedEnvelopeIdentity;
    const hardware = { ...BASE, attestation_type: 'hardware_full' } as unknown as SealedEnvelopeIdentity;
    expect(claimIdOf(software)).toBe(claimIdOf(hardware));
    expect(claimIdOf(software)).toBe(claimIdOf(BASE));
  });

  it('treats an absent user_id and an explicit null user_id as the same PE', () => {
    const withNull = { ...BASE, user_id: null };
    const { user_id: _omitted, ...withoutKey } = BASE;
    expect(claimIdOf(withNull)).toBe(claimIdOf(withoutKey as SealedEnvelopeIdentity));
  });

  it('accepts the genesis sentinel as a prior-hash link', () => {
    expect(() => claimIdOf({ ...BASE, prev_hash: CLAIM_ID_GENESIS_PREV_HASH })).not.toThrow();
  });
});

describe('deriveClaimId — folding that agrees with the stability checker', () => {
  it('folds the PE id exactly as wp4/claim-identity.ts folds it', () => {
    // `normalizePeId` there is trim+lowercase. Deriving one id per spelling while the
    // stability checker treats them as one PE would make legitimate work look like
    // `claim_id_drift`; the two modules must agree on what counts as one PE.
    expect(claimIdOf({ ...BASE, id: BASE.id.toUpperCase() })).toBe(claimIdOf(BASE));
    expect(claimIdOf({ ...BASE, id: `  ${BASE.id}  ` })).toBe(claimIdOf(BASE));
  });

  it('still separates two genuinely distinct documents whose ids differ only in case', () => {
    // Firestore ids ARE case-sensitive, so `PE-Abc` and `pe-abc` can both exist. Folding
    // the id cannot collide them, because each carries its own `hash` in the preimage.
    expect(claimIdOf({ ...BASE, id: BASE.id.toUpperCase(), hash: `${BASE.hash.slice(0, 63)}a` }))
      .not.toBe(claimIdOf(BASE));
  });

  it('treats hex digest casing as non-semantic', () => {
    expect(claimIdOf({ ...BASE, hash: BASE.hash.toUpperCase() })).toBe(claimIdOf(BASE));
    expect(claimIdOf({ ...BASE, prev_hash: BASE.prev_hash.toUpperCase() })).toBe(claimIdOf(BASE));
  });
});

describe('deriveClaimId — no collision between distinct work events', () => {
  const variants: ReadonlyArray<readonly [string, SealedEnvelopeIdentity]> = [
    ['baseline', BASE],
    ['different id', { ...BASE, id: 'pe_9f2c4a1b-0000-4000-8000-000000000002' }],
    ['different prev_hash', { ...BASE, prev_hash: `${BASE.prev_hash.slice(0, 63)}f` }],
    ['different hash', { ...BASE, hash: `${BASE.hash.slice(0, 63)}0` }],
    ['different timestamp', { ...BASE, timestamp: BASE.timestamp + 1 }],
    ['different action_type', { ...BASE, action_type: 'action_report' }],
    ['different user_id', { ...BASE, user_id: 'user_xyz' }],
    ['null user_id', { ...BASE, user_id: null }],
  ];

  it('gives every variant its own claim id', () => {
    const seen = new Map<string, string>();
    for (const [label, pe] of variants) {
      const claimId = claimIdOf(pe);
      const clash = seen.get(claimId);
      expect(clash).toBeUndefined();
      if (clash === undefined) seen.set(claimId, label);
    }
    expect(seen.size).toBe(variants.length);
  });

  it('separates two PEs that differ only in the field naming the work', () => {
    expect(claimIdOf({ ...BASE, action_type: 'x402_payment' })).not.toBe(
      claimIdOf({ ...BASE, action_type: 'x402_payments' }),
    );
  });

  it('separates two chain positions of otherwise identical content', () => {
    const first = { ...BASE, prev_hash: CLAIM_ID_GENESIS_PREV_HASH };
    const later = { ...BASE, prev_hash: BASE.hash };
    expect(claimIdOf(first)).not.toBe(claimIdOf(later));
  });
});

describe('deriveClaimId — fail-closed on an underivable identity', () => {
  it.each([
    ['missing_id', { ...BASE, id: '' }],
    ['missing_id', { ...BASE, id: '   ' }],
    ['missing_prev_hash', { ...BASE, prev_hash: '' }],
    ['missing_hash', { ...BASE, hash: '' }],
    ['missing_action_type', { ...BASE, action_type: '' }],
    ['invalid_timestamp', { ...BASE, timestamp: -1 }],
    ['invalid_timestamp', { ...BASE, timestamp: 1.5 }],
    ['invalid_timestamp', { ...BASE, timestamp: Number.MAX_SAFE_INTEGER + 2 }],
    ['invalid_user_id', { ...BASE, user_id: '' }],
  ])('rejects with %s', (reason, pe) => {
    const result = deriveClaimId(pe as SealedEnvelopeIdentity);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toBe(reason);
  });

  it.each([
    ['missing_id', undefined],
    ['missing_id', null],
    ['missing_id', {}],
  ])('rejects a non-PE input with %s', (reason, input) => {
    const result = deriveClaimId(input as unknown as SealedEnvelopeIdentity);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toBe(reason);
  });

  it('rejects a non-string timestamp rather than coercing it', () => {
    const result = deriveClaimId({ ...BASE, timestamp: '1780000000000' } as unknown as SealedEnvelopeIdentity);
    expect(result.kind).toBe('rejected');
  });
});
