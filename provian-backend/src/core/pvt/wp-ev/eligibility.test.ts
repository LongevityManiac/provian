import { deriveClaimId, type SealedEnvelopeIdentity } from './claim-id';
import type { SubmissionProvenance } from './submission-provenance';
import {
  collectWorkEvidence,
  evaluateEligibility,
  resolveAttestationTier,
  type EligibilityCandidate,
  type WorkEvidence,
} from './eligibility';

const PE: SealedEnvelopeIdentity = {
  id: 'pe_9f2c4a1b-0000-4000-8000-000000000001',
  prev_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  // Post-cut-line (after PVT9_ELIGIBILITY_CUT_LINE_MS 1_784_938_132_043) so these
  // tier/evidence/double-mint tests exercise their intended dimension rather than
  // tripping the cut-line fence. The fence itself is tested in eligibility.cutLineFence.test.ts.
  timestamp: 1_785_200_000_000,
  action_type: 'work_product',
  user_id: 'user_abc',
};

const ARTIFACT: WorkEvidence = { workProductHash: 'f'.repeat(64) };

function candidate(overrides: Partial<EligibilityCandidate> = {}): EligibilityCandidate {
  return {
    pe: PE,
    attestationTier: 'software',
    chainVerified: true,
    submissionProvenance: 'earner_signed',
    workEvidence: ARTIFACT,
    relayMintStatus: 'eligible',
    ...overrides,
  };
}

function reasonsOf(c: EligibilityCandidate): readonly string[] {
  const verdict = evaluateEligibility(c);
  return verdict.kind === 'ineligible' ? verdict.reasons : [];
}

describe('tier affects weight, never eligibility', () => {
  it('a SOFTWARE-attested PE with real work evidence is fully eligible', () => {
    const verdict = evaluateEligibility(candidate({ attestationTier: 'software' }));

    expect(verdict.kind).toBe('eligible');
    if (verdict.kind !== 'eligible') return;
    expect(verdict.attestationTier).toBe('software');
    expect(verdict.weightMultiplier).toBe(0.8);
    expect(verdict.evidence).toContain('work_product_hash');
  });

  it('the same PE at a hardware tier is eligible too — only the weight moves', () => {
    const software = evaluateEligibility(candidate({ attestationTier: 'software' }));
    const hardware = evaluateEligibility(candidate({ attestationTier: 'hardware_full' }));

    expect(software.kind).toBe('eligible');
    expect(hardware.kind).toBe('eligible');
    if (software.kind !== 'eligible' || hardware.kind !== 'eligible') return;

    expect(hardware.weightMultiplier).toBeGreaterThan(software.weightMultiplier);
    // Same PE, same identity, whatever the device that signed it.
    expect(hardware.claimId).toBe(software.claimId);
  });

  it.each([
    ['software', 0.8],
    ['social', 0.5],
    ['corroborated', 1.1],
    ['software_verified', 1.2],
    ['hardware_partial', 1.2],
    ['hardware_full', 2.5],
  ])('%s is eligible and prices at %sx', (tier, multiplier) => {
    const verdict = evaluateEligibility(candidate({ attestationTier: tier }));
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.weightMultiplier).toBe(multiplier);
  });

  it('resolves the legacy tier spellings the relay still emits', () => {
    expect(resolveAttestationTier('hardware')).toBe('hardware_full');
    expect(resolveAttestationTier('hardware_tpm')).toBe('hardware_partial');
    expect(resolveAttestationTier('hardware_limited')).toBe('hardware_partial');
    expect(evaluateEligibility(candidate({ attestationTier: 'hardware' })).kind).toBe('eligible');
  });

  it('blocks an unrecognized tier instead of silently pricing it as software', () => {
    expect(resolveAttestationTier('quantum_attested')).toBeNull();
    expect(reasonsOf(candidate({ attestationTier: 'quantum_attested' }))).toContain('unknown_attestation_tier');
    expect(reasonsOf(candidate({ attestationTier: '' }))).toContain('unknown_attestation_tier');
    expect(reasonsOf(candidate({ attestationTier: undefined as unknown as string })))
      .toContain('unknown_attestation_tier');
  });

  it.each(['compute_tee', 'full_stack'])('blocks the reserved tier %s', (tier) => {
    // Reserved and deliberately unimplemented. Honouring a claim to one would mint at
    // 1.4x-2.0x on evidence nothing can currently check.
    expect(reasonsOf(candidate({ attestationTier: tier }))).toContain('reserved_attestation_tier');
  });
});

describe('work-happened is independent of tier', () => {
  it('a HARDWARE-attested PE with nothing behind it is still a ghost', () => {
    const reasons = reasonsOf(candidate({ attestationTier: 'hardware_full', workEvidence: {} }));
    expect(reasons).toContain('ghost_pe_no_work_evidence');
  });

  it('a SOFTWARE-attested PE with nothing behind it is a ghost for the same reason', () => {
    const reasons = reasonsOf(candidate({ attestationTier: 'software', workEvidence: {} }));
    expect(reasons).toContain('ghost_pe_no_work_evidence');
  });

  it('the ghost verdict is identical at every tier — attestation is never the proxy', () => {
    const tiers = ['software', 'social', 'corroborated', 'hardware_partial', 'hardware_full'];
    for (const tier of tiers) {
      expect(reasonsOf(candidate({ attestationTier: tier, workEvidence: {} })))
        .toEqual(['ghost_pe_no_work_evidence']);
    }
  });

  it('a software PE WITH evidence beats a hardware PE WITHOUT it', () => {
    const softwareWithWork = evaluateEligibility(candidate({ attestationTier: 'software' }));
    const hardwareWithNothing = evaluateEligibility(
      candidate({ attestationTier: 'hardware_full', workEvidence: {} }),
    );
    expect(softwareWithWork.kind).toBe('eligible');
    expect(hardwareWithNothing.kind).toBe('ineligible');
  });
});

describe('what counts as work evidence', () => {
  it('accepts a work-product hash', () => {
    expect(collectWorkEvidence({ workProductHash: 'a'.repeat(64) })).toEqual(['work_product_hash']);
  });

  it('accepts a COMPLETE replication pack and rejects a partial one', () => {
    const complete = { inputHash: 'a', outputHash: 'b', packHash: 'c' };
    expect(collectWorkEvidence({ replicationPack: complete })).toEqual(['replication_pack']);
    expect(evaluateEligibility(candidate({ workEvidence: { replicationPack: complete } })).kind)
      .toBe('eligible');

    // A pack missing any hash does not qualify — the same rule the PE protocol applies.
    for (const partial of [
      { inputHash: 'a', outputHash: 'b' },
      { inputHash: 'a', packHash: 'c' },
      { outputHash: 'b', packHash: 'c' },
      {},
    ]) {
      expect(collectWorkEvidence({ replicationPack: partial })).toEqual([]);
      expect(reasonsOf(candidate({ workEvidence: { replicationPack: partial } })))
        .toContain('ghost_pe_no_work_evidence');
    }
  });

  it('accepts a chain-verified settlement', () => {
    expect(evaluateEligibility(candidate({ workEvidence: { chainVerifiedTxHash: `0x${'1'.repeat(64)}` } })).kind)
      .toBe('eligible');
  });

  it('accepts a one-time anchor for acts whose evidence IS the act', () => {
    // Genesis grants and device-anchored setup PEs produce no artifact and have no
    // counterparty; the kernel enforces the anchor's single use.
    const verdict = evaluateEligibility(
      candidate({ workEvidence: { oneTimeAnchor: `0x${'9'.repeat(64)}` } }),
    );
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.evidence).toEqual(['one_time_anchor']);
  });

  it('treats blank strings as no evidence at all', () => {
    expect(collectWorkEvidence({ workProductHash: '   ', chainVerifiedTxHash: '', oneTimeAnchor: null }))
      .toEqual([]);
  });
});

describe('a counterparty who never confirmed', () => {
  const counterparty = { address: '0xabc', type: 'agent' };

  it('is a ghost even when the submitter supplied an artifact hash', () => {
    const reasons = reasonsOf(
      candidate({ workEvidence: { ...ARTIFACT, counterparty } }),
    );
    expect(reasons).toContain('ghost_pe_counterparty_uncorroborated');
  });

  it('becomes eligible once the corroboration arrives', () => {
    const verdict = evaluateEligibility(
      candidate({
        workEvidence: {
          ...ARTIFACT,
          counterparty,
          counterpartyCorroboration: { received: true, signalType: 'job_delivery' },
        },
      }),
    );
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.evidence).toContain('counterparty_corroboration');
  });

  it('is also satisfied by an on-chain settlement, the strongest confirmation there is', () => {
    expect(
      evaluateEligibility(
        candidate({ workEvidence: { counterparty, chainVerifiedTxHash: `0x${'2'.repeat(64)}` } }),
      ).kind,
    ).toBe('eligible');
  });

  it('is not satisfied by corroboration that was never actually received', () => {
    expect(
      reasonsOf(candidate({ workEvidence: { ...ARTIFACT, counterparty, counterpartyCorroboration: { received: false } } })),
    ).toContain('ghost_pe_counterparty_uncorroborated');
  });

  it('applies only when a counterparty address is actually named', () => {
    const blank = { address: '   ', type: 'agent' };
    expect(evaluateEligibility(candidate({ workEvidence: { ...ARTIFACT, counterparty: blank } })).kind)
      .toBe('eligible');
  });
});

describe('the record-time seal is authoritative evidence (2026-08-16 seam ruling)', () => {
  const SEAL_VERIFIED = { evidenceState: 'verified' };
  const SEAL_NOT_REQUIRED = { evidenceState: 'not_required' };

  it('a sealed-VERIFIED PE with nothing else behind it is eligible — body-binding IS the evidence ', () => {
    // The exact production shape of every family, solo coding_session, and solo
    // service:* forge row: eligible + verified at record time, no replication pack, no
    // corroboration, no tx hash. Pre-fix these refused `ghost_pe_no_work_evidence`.
    const verdict = evaluateEligibility(
      candidate({ workEvidence: { recordTimeSeal: SEAL_VERIFIED } }),
    );
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.evidence).toEqual(['record_time_seal']);
  });

  it('a sealed NOT_REQUIRED PE is eligible — the armed policy demands no evidence (wallet_created)', () => {
    const verdict = evaluateEligibility(candidate({
      pe: { ...PE, action_type: 'wallet_created', prev_hash: '0x0000' },
      submissionProvenance: 'server_authored',
      workEvidence: { recordTimeSeal: SEAL_NOT_REQUIRED },
    }));
    expect(verdict.kind).toBe('eligible');
  });

  it('RED CONTROL — the identical candidate WITHOUT the seal is the ghost it always was', () => {
    expect(reasonsOf(candidate({ workEvidence: {} }))).toContain('ghost_pe_no_work_evidence');
    expect(reasonsOf(candidate({ workEvidence: { recordTimeSeal: null } })))
      .toContain('ghost_pe_no_work_evidence');
  });

  it('RED CONTROL — a pending, rejected, or unverifiable seal contributes nothing', () => {
    // These rows were never sealed evidence-sufficient; the seam fix must not admit them.
    for (const evidenceState of ['pending', 'rejected', 'unverifiable']) {
      const seal = { evidenceState };
      expect(collectWorkEvidence({ recordTimeSeal: seal })).toEqual([]);
      expect(reasonsOf(candidate({ workEvidence: { recordTimeSeal: seal } })))
        .toContain('ghost_pe_no_work_evidence');
    }
  });

  it('RED CONTROL — the seal never bypasses the relay-status gate (the disposition axis)', () => {
    // The disposition authority is the CURRENT `mint_status` allowlist, not the seal: a
    // row whose relay status is not `eligible` refuses however verified its seal — which
    // is also why the seal carries no disposition of its own (a `pending_cache`-recovered
    // row lawfully reads eligible while its immutable seal still says the record-time
    // state; see the WorkEvidence field note).
    for (const relayMintStatus of ['pending_cache', 'record_only', 'minted', 'ineligible']) {
      const verdict = evaluateEligibility(candidate({
        relayMintStatus,
        workEvidence: { recordTimeSeal: SEAL_VERIFIED },
      }));
      expect(verdict.kind).toBe('ineligible');
    }
  });

  it('a VERIFIED seal confirms a named counterparty — the seal is never submitter-chosen', () => {
    const counterparty = { address: '0xabc', type: 'agent' };
    const verdict = evaluateEligibility(
      candidate({ workEvidence: { counterparty, recordTimeSeal: SEAL_VERIFIED } }),
    );
    expect(verdict.kind).toBe('eligible');
  });

  it('RED CONTROL — the counterparty ghost gate still fires for a sealless row', () => {
    const counterparty = { address: '0xabc', type: 'agent' };
    expect(reasonsOf(candidate({ workEvidence: { ...ARTIFACT, counterparty } })))
      .toContain('ghost_pe_counterparty_uncorroborated');
  });
});

describe('provenance validity is a hard gate', () => {
  it('rejects a PE whose chain was not verified', () => {
    expect(reasonsOf(candidate({ chainVerified: false }))).toContain('chain_not_verified');
  });

  it('rejects a PE whose signature was not verified', () => {
    expect(reasonsOf(candidate({ submissionProvenance: 'unverified' }))).toContain('signature_not_verified');
  });

  it('treats a missing flag as unverified rather than assuming the best', () => {
    expect(reasonsOf(candidate({ chainVerified: undefined as unknown as boolean })))
      .toContain('chain_not_verified');
    expect(reasonsOf(candidate({
      submissionProvenance: 'yes' as unknown as SubmissionProvenance,
    }))).toContain('signature_not_verified');
  });

  it('rejects a PE with no derivable identity', () => {
    expect(reasonsOf(candidate({ pe: { ...PE, id: '' } }))).toContain('identity_underivable');
    expect(reasonsOf(candidate({ pe: undefined as unknown as SealedEnvelopeIdentity })))
      .toContain('identity_underivable');
  });

  it('reports every failing reason at once rather than only the first', () => {
    const reasons = reasonsOf(
      candidate({
        pe: { ...PE, id: '' },
        attestationTier: 'nonsense',
        chainVerified: false,
        submissionProvenance: 'unverified',
        workEvidence: {},
      }),
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        'identity_underivable',
        'chain_not_verified',
        'signature_not_verified',
        'unknown_attestation_tier',
        'ghost_pe_no_work_evidence',
      ]),
    );
  });
});

describe('the relay mint_status gate is an allowlist', () => {
  it('lets only the relay status that means "ready" through', () => {
    expect(evaluateEligibility(candidate({ relayMintStatus: 'eligible' })).kind).toBe('eligible');
  });

  it('never lifts a terminal ineligible — it is a compliance state, not an opinion', () => {
    // Sanctions, a real per-device rate limit, and a blocked jurisdiction all land here,
    // and nothing may transition them.
    expect(reasonsOf(candidate({ relayMintStatus: 'ineligible' }))).toContain('terminally_ineligible');
  });

  it.each(['minted', 'minting'])('refuses %s — the PE has already been paid', (status) => {
    // PVT9 is a fresh zero-supply kernel with no historical-PE migration, so its
    // claimSettled registry holds no record of a legacy mint and cannot catch the second.
    expect(reasonsOf(candidate({ relayMintStatus: status }))).toContain('already_minted');
  });

  it.each([
    'deferred',
    'pending_cache',
    'pending_review',
    'pending_evidence',
    'beneficiary_pending',
    'record_only',
    'farm_capped',
    'x402_unverified',
    'skipped_no_output',
    'corroborated_duplicate',
    'genesis_epoch_deferred',
    'epoch_headroom_deferred',
    'settlement_retry_deferred',
  ])('refuses the non-ready status %s', (status) => {
    expect(reasonsOf(candidate({ relayMintStatus: status }))).toContain('relay_status_not_ready');
  });

  it('refuses a status it does not recognize rather than assuming it is fine', () => {
    // The whole point of an allowlist: a status invented tomorrow must not mint today.
    expect(reasonsOf(candidate({ relayMintStatus: 'some_future_state' }))).toContain('relay_status_not_ready');
    expect(reasonsOf(candidate({ relayMintStatus: '' }))).toContain('relay_status_not_ready');
  });

  it('refuses an absent status instead of treating the omission as approval', () => {
    expect(reasonsOf(candidate({ relayMintStatus: undefined as unknown as string })))
      .toContain('relay_status_not_ready');
    expect(reasonsOf({ ...candidate(), relayMintStatus: null as unknown as string }))
      .toContain('relay_status_not_ready');
  });

  it('does not normalize case or whitespace — an exact match or nothing', () => {
    for (const status of ['ELIGIBLE', 'Eligible', 'eligible ', ' eligible']) {
      expect(reasonsOf(candidate({ relayMintStatus: status }))).toContain('relay_status_not_ready');
    }
  });

  it.each(['badge_earned', 'pvt_badge_projection_completed'])(
    '%s mints zero however much evidence it carries',
    (actionType) => {
      // Record-only by protocol. An artifact hash does not change that.
      const reasons = reasonsOf(candidate({ pe: { ...PE, action_type: actionType } }));
      expect(reasons).toContain('zero_mint_action_type');
    },
  );

  it('does not block a normal action type', () => {
    expect(evaluateEligibility(candidate({ pe: { ...PE, action_type: 'work_product' } })).kind)
      .toBe('eligible');
  });
});

describe('an eligible verdict carries the settleable claim id', () => {
  it('always carries at least one piece of evidence', () => {
    const verdict = evaluateEligibility(candidate());
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.evidence.length).toBeGreaterThan(0);
  });

  it('matches the standalone derivation exactly', () => {
    const verdict = evaluateEligibility(candidate());
    const derived = deriveClaimId(PE);
    expect(verdict.kind).toBe('eligible');
    expect(derived.kind).toBe('derived');
    if (verdict.kind === 'eligible' && derived.kind === 'derived') {
      expect(verdict.claimId).toBe(derived.claimId);
    }
  });
});
