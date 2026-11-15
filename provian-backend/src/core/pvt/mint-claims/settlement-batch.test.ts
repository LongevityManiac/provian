import { keccak256, toUtf8Bytes } from 'ethers';
import {
  assembleStandardBatch,
  assemblyPolicyForEpoch,
  computeSettlementDigest,
  HUMAN_FOUNDATION_BPS,
  hashGenesisClaims,
  hashStandardClaims,
  standardSettlementDigest,
  BeneficiaryClass,
  MAX_RECIPIENTS_PER_BATCH,
  SettlementLane,
  type BatchHeader,
  type StandardClaimEntry,
} from './settlement-batch';

const KERNEL = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 8453n;

const HEADER: BatchHeader = {
  batchId: keccak256(toUtf8Bytes('wp-ev.vector.batchId')),
  epoch: 7n,
  policyHash: keccak256(toUtf8Bytes('wp-ev.vector.policy')),
  finalizedCursorStart: 1_000n,
  finalizedCursorEnd: 1_002n,
};

function claimId(n: number): string {
  return keccak256(toUtf8Bytes(`wp-ev.claim.${n}`));
}

function address(suffix: string): string {
  return `0x${suffix.padStart(40, '0')}`;
}

// =====================================================================
// Cross-language digest vector
// =====================================================================

/**
 * These four constants are asserted IDENTICALLY by
 * `contracts/test/ProvianPVT9EligibilityVerifier.t.sol` section I, where they are produced
 * by the real kernel bytecode etched at `KERNEL` with `block.chainid` fixed to `CHAIN_ID`.
 * If either language's encoding drifts, one of the two suites fails — before a batch is
 * ever submitted with a digest the oracle would refuse.
 */
describe('cross-language digest vector', () => {
  const recipients = [
    { contributor: address('a1'), beneficiaryClass: BeneficiaryClass.HumanResolving, claimCount: 1n },
    { contributor: address('b2'), beneficiaryClass: BeneficiaryClass.AutonomousAgent, claimCount: 1n },
  ];
  const claims = [
    { claimId: keccak256(toUtf8Bytes('wp-ev.vector.claim.1')), recordPointsAtomic: 10n ** 18n },
    { claimId: keccak256(toUtf8Bytes('wp-ev.vector.claim.2')), recordPointsAtomic: 2n * 10n ** 18n },
  ];

  const genesisRecipients = [{ contributor: address('a1'), claimCount: 1n }];
  const genesisClaims = [
    {
      claimId: keccak256(toUtf8Bytes('wp-ev.vector.claim.1')),
      walletId: keccak256(toUtf8Bytes('wp-ev.vector.wallet')),
      oneTimeAnchor: keccak256(toUtf8Bytes('wp-ev.vector.anchor')),
      grantType: 0,
      qualifiedAt: 1_800_000_000n,
      reservedGrossAtomic: 75n * 10n ** 18n,
    },
  ];

  it('matches Solidity hashStandardClaims', () => {
    expect(hashStandardClaims(recipients, claims)).toBe(
      '0xd32f6ba25ef8ac5f4b1e598ee7c50b2379ebccd8a16140e4e5cd868d00f31224',
    );
  });

  it('matches Solidity hashGenesisClaims', () => {
    expect(hashGenesisClaims(genesisRecipients, genesisClaims)).toBe(
      '0x3043b09a9a61356cc92a7a503c17ab3bbca126c9fc14203db24907c2f3cf9e5a',
    );
  });

  it('matches Solidity computeSettlementDigest on the standard lane', () => {
    expect(
      computeSettlementDigest({
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        lane: SettlementLane.StandardPE,
        header: HEADER,
        claimsHash: hashStandardClaims(recipients, claims),
      }),
    ).toBe('0xf52449d4698d5e2b348262aee32250f3591de21d8e6e62043bde07b796b69e93');
  });

  /**
   * The end-to-end wiring proof. Real evaluated entries go through the real assembly and
   * out the far end comes the digest the ON-CHAIN oracle independently derives for the
   * same batch — `ProvianPVT9EligibilityVerifier.t.sol::
   * test_oracleDerivesTheDigestTheOffChainSettlerComputed` asserts this same constant as
   * the return value of `approveStandardBatch`.
   *
   * Entries are fed in REVERSE address order so the assembly's sorting is exercised rather
   * than accidentally satisfied.
   */
  it('assembles the vector batch and produces the digest the oracle affirms', () => {
    const assembled = assembleStandardBatch(
      [
        {
          contributor: address('b2'),
          beneficiaryClass: BeneficiaryClass.AutonomousAgent,
          claimId: keccak256(toUtf8Bytes('wp-ev.vector.claim.2')),
          recordPointsAtomic: 2n * 10n ** 18n,
        },
        {
          contributor: address('a1'),
          beneficiaryClass: BeneficiaryClass.HumanResolving,
          claimId: keccak256(toUtf8Bytes('wp-ev.vector.claim.1')),
          recordPointsAtomic: 10n ** 18n,
        },
      ],
      HEADER,
    );

    expect(assembled.kind).toBe('assembled');
    if (assembled.kind !== 'assembled') return;
    expect(standardSettlementDigest(assembled.batch, KERNEL, CHAIN_ID)).toBe(
      '0xf52449d4698d5e2b348262aee32250f3591de21d8e6e62043bde07b796b69e93',
    );
  });

  it('matches Solidity computeSettlementDigest on the genesis lane', () => {
    expect(
      computeSettlementDigest({
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        lane: SettlementLane.GenesisPE,
        header: { ...HEADER, finalizedCursorEnd: 1_001n },
        claimsHash: hashGenesisClaims(genesisRecipients, genesisClaims),
      }),
    ).toBe('0x36cfff46404787bb8126365b71781e86f8cc2c8a05b67ea6b885dc3471cd0f8d');
  });
});

// =====================================================================
// The digest binds everything the oracle would refuse to move
// =====================================================================

describe('digest binding', () => {
  const recipients = [
    { contributor: address('a1'), beneficiaryClass: BeneficiaryClass.HumanResolving, claimCount: 1n },
    { contributor: address('b2'), beneficiaryClass: BeneficiaryClass.AutonomousAgent, claimCount: 1n },
  ];
  const claims = [
    { claimId: claimId(1), recordPointsAtomic: 10n ** 18n },
    { claimId: claimId(2), recordPointsAtomic: 2n * 10n ** 18n },
  ];
  const baseline = computeSettlementDigest({
    kernelAddress: KERNEL,
    chainId: CHAIN_ID,
    lane: SettlementLane.StandardPE,
    header: HEADER,
    claimsHash: hashStandardClaims(recipients, claims),
  });

  function digestWith(overrides: Partial<BatchHeader> & { chainId?: bigint; kernelAddress?: string }): string {
    const { chainId, kernelAddress, ...header } = overrides;
    return computeSettlementDigest({
      kernelAddress: kernelAddress ?? KERNEL,
      chainId: chainId ?? CHAIN_ID,
      lane: SettlementLane.StandardPE,
      header: { ...HEADER, ...header },
      claimsHash: hashStandardClaims(recipients, claims),
    });
  }

  it.each([
    ['batchId', { batchId: keccak256(toUtf8Bytes('other')) }],
    ['epoch', { epoch: 8n }],
    ['policyHash', { policyHash: keccak256(toUtf8Bytes('other-policy')) }],
    ['cursorStart', { finalizedCursorStart: 1_001n }],
    ['cursorEnd', { finalizedCursorEnd: 1_003n }],
    ['chainId', { chainId: 84532n }],
    ['kernel address', { kernelAddress: address('dead') }],
  ])('changes when %s changes', (_label, overrides) => {
    expect(digestWith(overrides)).not.toBe(baseline);
  });

  it('changes when the lane changes, with everything else held fixed', () => {
    expect(
      computeSettlementDigest({
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        lane: SettlementLane.GenesisPE,
        header: HEADER,
        claimsHash: hashStandardClaims(recipients, claims),
      }),
    ).not.toBe(baseline);
  });

  it.each([
    ['a claim amount', [{ claimId: claimId(1), recordPointsAtomic: 10n ** 18n + 1n }, claims[1]]],
    ['a claim id', [{ claimId: claimId(99), recordPointsAtomic: 10n ** 18n }, claims[1]]],
    ['claim order', [claims[1], claims[0]]],
  ])('changes when %s changes', (_label, altered) => {
    expect(hashStandardClaims(recipients, altered)).not.toBe(hashStandardClaims(recipients, claims));
  });

  it.each([
    ['a recipient address', [{ ...recipients[0], contributor: address('c3') }, recipients[1]]],
    ['a beneficiary class', [{ ...recipients[0], beneficiaryClass: BeneficiaryClass.AutonomousAgent }, recipients[1]]],
    ['a claim split', [{ ...recipients[0], claimCount: 2n }, { ...recipients[1], claimCount: 0n }]],
  ])('changes when %s changes', (_label, altered) => {
    expect(hashStandardClaims(altered, claims)).not.toBe(hashStandardClaims(recipients, claims));
  });
});

// =====================================================================
// Assembly
// =====================================================================

function entry(contributor: string, id: number, points = 10n ** 18n): StandardClaimEntry {
  return {
    contributor,
    beneficiaryClass: BeneficiaryClass.HumanResolving,
    claimId: claimId(id),
    recordPointsAtomic: points,
  };
}

describe('assembleStandardBatch', () => {
  it('orders recipients strictly ascending and keeps each recipient contiguous', () => {
    // Deliberately out of order on input; the kernel reverts anything but ascending.
    const result = assembleStandardBatch(
      [entry(address('c3'), 1), entry(address('a1'), 2), entry(address('c3'), 3), entry(address('b2'), 4)],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 4n },
    );

    expect(result.kind).toBe('assembled');
    if (result.kind !== 'assembled') return;

    expect(result.batch.recipients.map((r) => r.contributor.toLowerCase())).toEqual([
      address('a1'),
      address('b2'),
      address('c3'),
    ]);
    expect(result.batch.recipients.map((r) => r.claimCount)).toEqual([1n, 1n, 2n]);
    // Claim order follows recipient order: a1's, then b2's, then c3's two.
    expect(result.batch.claims.map((c) => c.claimId)).toEqual([
      claimId(2),
      claimId(4),
      claimId(1),
      claimId(3),
    ]);
  });

  it('produces claim counts that sum to the claim array length', () => {
    const result = assembleStandardBatch(
      [entry(address('a1'), 1), entry(address('a1'), 2), entry(address('b2'), 3)],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 3n },
    );
    if (result.kind !== 'assembled') throw new Error('expected assembly');
    const sum = result.batch.recipients.reduce((total, r) => total + r.claimCount, 0n);
    expect(sum).toBe(BigInt(result.batch.claims.length));
  });

  it('is deterministic for the same input', () => {
    const entries = [entry(address('b2'), 1), entry(address('a1'), 2)];
    const header = { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 2n };
    const first = assembleStandardBatch(entries, header);
    const second = assembleStandardBatch(entries, header);
    if (first.kind !== 'assembled' || second.kind !== 'assembled') throw new Error('expected assembly');
    expect(standardSettlementDigest(first.batch, KERNEL, CHAIN_ID)).toBe(
      standardSettlementDigest(second.batch, KERNEL, CHAIN_ID),
    );
  });

  it('rejects a duplicate claim id before it can revert the whole batch on-chain', () => {
    const result = assembleStandardBatch(
      [entry(address('a1'), 1), entry(address('b2'), 1)],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 2n },
    );
    expect(result).toEqual({ kind: 'rejected', reason: 'duplicate_claim_id' });
  });

  it.each([
    ['empty_batch', []],
    ['invalid_claim_id', [{ ...entry(address('a1'), 1), claimId: `0x${'0'.repeat(64)}` }]],
    ['invalid_claim_id', [{ ...entry(address('a1'), 1), claimId: 'not-a-hash' }]],
    ['invalid_record_points', [{ ...entry(address('a1'), 1), recordPointsAtomic: 0n }]],
    ['invalid_record_points', [{ ...entry(address('a1'), 1), recordPointsAtomic: -1n }]],
    ['invalid_record_points', [{ ...entry(address('a1'), 1), recordPointsAtomic: 1 as unknown as bigint }]],
    ['invalid_contributor', [{ ...entry(address('a1'), 1), contributor: address('0') }]],
    ['invalid_contributor', [{ ...entry(address('a1'), 1), contributor: 'nope' }]],
  ])('rejects with %s', (reason, entries) => {
    const result = assembleStandardBatch(
      entries as StandardClaimEntry[],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + BigInt(entries.length) },
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toBe(reason);
  });

  it('rejects more recipients than the kernel accepts', () => {
    const entries = Array.from({ length: MAX_RECIPIENTS_PER_BATCH + 1 }, (_unused, i) =>
      entry(address((i + 1).toString(16)), i + 1));
    const result = assembleStandardBatch(entries, {
      ...HEADER,
      finalizedCursorEnd: HEADER.finalizedCursorStart + BigInt(entries.length),
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'too_many_recipients' });
  });

  it('accepts exactly the kernel maximum, still strictly ordered', () => {
    const entries = Array.from({ length: MAX_RECIPIENTS_PER_BATCH }, (_unused, i) =>
      entry(address((i + 1).toString(16)), i + 1));
    const result = assembleStandardBatch(entries, {
      ...HEADER,
      finalizedCursorEnd: HEADER.finalizedCursorStart + BigInt(entries.length),
    });
    expect(result.kind).toBe('assembled');
    if (result.kind !== 'assembled') return;

    expect(result.batch.recipients).toHaveLength(MAX_RECIPIENTS_PER_BATCH);
    // The kernel compares addresses numerically, so a lexicographic sort would pass a
    // small fixture and revert at 500. Assert the real ordering property.
    for (let i = 1; i < result.batch.recipients.length; i += 1) {
      expect(BigInt(result.batch.recipients[i].contributor))
        .toBeGreaterThan(BigInt(result.batch.recipients[i - 1].contributor));
    }
  });

  it('rejects a cursor range that does not match the claim count', () => {
    const result = assembleStandardBatch([entry(address('a1'), 1)], {
      ...HEADER,
      finalizedCursorEnd: HEADER.finalizedCursorStart + 5n,
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'cursor_range_mismatch' });
  });

  it('REJECTS a beneficiary-class conflict rather than silently picking a winner', () => {
    // Under a differential rate the classification alone decides that contributor's split,
    // so picking the first one seen would mint every claim of theirs at a rate nobody chose.
    const result = assembleStandardBatch(
      [
        entry(address('a1'), 1),
        { ...entry(address('a1'), 2), beneficiaryClass: BeneficiaryClass.AutonomousAgent },
      ],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 2n },
    );
    expect(result.kind).toBe('rejected');
    // `conflicts` is reachable only after narrowing on the reason — the type makes reading
    // it anywhere else a compile error, which is what stops it being quietly ignored.
    if (result.kind !== 'rejected' || result.reason !== 'beneficiary_class_conflict') {
      throw new Error(`expected a classification conflict, got ${JSON.stringify(result)}`);
    }
    // Addresses come back EIP-55 checksummed, so compare on the canonical lowercase form.
    expect(result.conflicts.map((a) => a.toLowerCase())).toEqual([address('a1')]);
  });

  it('assembles when a contributor is consistently classified', () => {
    const result = assembleStandardBatch(
      [entry(address('a1'), 1), entry(address('a1'), 2)],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 2n },
    );
    expect(result.kind).toBe('assembled');
  });

  describe('beneficiary classification', () => {
    const twoClaims = { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 1n };

    it('accepts Unknown while the epoch prices agents and humans alike', () => {
      // The kernel only demands a resolved classification under a differential rate, so
      // rejecting Unknown here unconditionally would refuse batches it would settle.
      const result = assembleStandardBatch(
        [{ ...entry(address('a1'), 1), beneficiaryClass: BeneficiaryClass.Unknown }],
        twoClaims,
      );
      expect(result.kind).toBe('assembled');
    });

    it('rejects Unknown once the epoch prices them differently', () => {
      const result = assembleStandardBatch(
        [{ ...entry(address('a1'), 1), beneficiaryClass: BeneficiaryClass.Unknown }],
        twoClaims,
        { differentialAgentFoundationRate: true },
      );
      expect(result).toEqual({ kind: 'rejected', reason: 'beneficiary_class_required' });
    });

    it.each([3, 7, -1, 1.5, NaN, undefined])('rejects the out-of-range value %s always', (value) => {
      const result = assembleStandardBatch(
        [{ ...entry(address('a1'), 1), beneficiaryClass: value as BeneficiaryClass }],
        twoClaims,
      );
      expect(result).toEqual({ kind: 'rejected', reason: 'invalid_beneficiary_class' });
    });
  });

  describe('header values that could never settle', () => {
    const one = [entry(address('a1'), 1)];
    const span = { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 1n };

    it.each([
      ['invalid_batch_id', { batchId: `0x${'0'.repeat(64)}` }],
      ['invalid_batch_id', { batchId: 'nope' }],
      ['invalid_policy_hash', { policyHash: `0x${'0'.repeat(64)}` }],
      ['invalid_cursor', { finalizedCursorStart: -1n }],
      ['invalid_cursor', { finalizedCursorStart: 0 as unknown as bigint }],
      ['invalid_cursor', { finalizedCursorEnd: 5 as unknown as bigint }],
      ['invalid_epoch', { epoch: -1n }],
      ['invalid_epoch', { epoch: 2n ** 64n }],
      ['invalid_epoch', { epoch: 7 as unknown as bigint }],
      ['invalid_cursor', { finalizedCursorStart: 2n ** 256n }],
      ['invalid_cursor', { finalizedCursorEnd: -1n }],
    ])('rejects with %s', (reason, override) => {
      const result = assembleStandardBatch(one, { ...span, ...override });
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.reason).toBe(reason);
    });

    it('rejects out-of-domain values rather than letting the encoder throw', () => {
      // An assembler that returns a result type must never throw instead.
      expect(() => assembleStandardBatch(one, { ...span, epoch: 2n ** 64n })).not.toThrow();
      expect(() =>
        assembleStandardBatch(
          [{ ...entry(address('a1'), 1), recordPointsAtomic: 2n ** 256n }],
          span,
        )).not.toThrow();
      expect(
        assembleStandardBatch([{ ...entry(address('a1'), 1), recordPointsAtomic: 2n ** 256n }], span),
      ).toEqual({ kind: 'rejected', reason: 'invalid_record_points' });
    });
  });

  describe('assemblyPolicyForEpoch', () => {
    it('derives the differential flag from the kernel constant, not a repeated rule', () => {
      expect(assemblyPolicyForEpoch(HUMAN_FOUNDATION_BPS))
        .toEqual({ differentialAgentFoundationRate: false });
      expect(assemblyPolicyForEpoch(HUMAN_FOUNDATION_BPS + 1n))
        .toEqual({ differentialAgentFoundationRate: true });
      expect(assemblyPolicyForEpoch(2_000n)).toEqual({ differentialAgentFoundationRate: true });
      // Below the floor too, so the rule is pinned as `!==` rather than `>`.
      expect(assemblyPolicyForEpoch(0n)).toEqual({ differentialAgentFoundationRate: true });
    });

    it('mirrors the immutable human Foundation floor', () => {
      expect(HUMAN_FOUNDATION_BPS).toBe(50n);
    });
  });

  it('treats differently-cased spellings of one address as one recipient', () => {
    const result = assembleStandardBatch(
      [entry(address('a1'), 1), entry(address('A1'), 2)],
      { ...HEADER, finalizedCursorEnd: HEADER.finalizedCursorStart + 2n },
    );
    if (result.kind !== 'assembled') throw new Error('expected assembly');
    expect(result.batch.recipients).toHaveLength(1);
    expect(result.batch.recipients[0].claimCount).toBe(2n);
  });
});
