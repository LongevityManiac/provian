/**
 * pe-history mint_status assignment - H-6 (audit 2026-05-11).
 *
 * When the cache (Redis) is unavailable, the PE must be recorded with
 * mint_status='pending_cache' (reclassifiable) and NOT 'ineligible'
 * (terminal). The pending-cache backfill scheduler reclassifies these
 * once Redis recovers; an Upstash blip during launch traffic must not
 * permanently disqualify the affected PEs.
 */

import { writePEHistory, type WritePEHistoryParams } from './pe-history';
import { computeRecordSnapshot } from './core/pvt/policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './core/pvt/policy/runtime-monetary-policy';

const txnUpdates: Record<string, unknown>[] = [];

jest.mock('firebase-admin', () => {
  const mockDocRef = {
    set: jest.fn(),
    get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
  };
  const runTransaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
      // The seal transaction also writes the accrual-time aggregate document
      // (M5). This suite is about the pe_history ROW, so capture only
      // sets whose payload is a row (carries `peId`).
      set: (_ref: unknown, doc: Record<string, unknown>) => {
        if (typeof doc.peId === 'string') txnUpdates.push(doc);
      },
    };
    await fn(tx);
  });
  const mockFirestore = {
    collection: () => ({
      doc: () => mockDocRef,
    }),
    runTransaction,
  };
  return {
    firestore: () => mockFirestore,
  };
});

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: jest.fn().mockResolvedValue('immediate'),
}));

const BASE_TIMESTAMP = 1_750_000_000_000;
const baseParams = {
  peId: 'pe_test',
  userId: 'user_test',
  timestamp: BASE_TIMESTAMP,
  actionType: 'send',
  category: 'wallet' as const,
  attestationDepth: 'hardware',
  estimatedPVT: 0,
  peHash: 'hash_test',
  jurisdiction_context: 'US',
};

function paramsWithSnapshot(
  overrides: Partial<WritePEHistoryParams> = {},
): WritePEHistoryParams {
  const params = { ...baseParams, ...overrides } as WritePEHistoryParams;
  const operationalDispositionOverride = params.cacheUnavailable
    ? {
      mintDisposition: 'pending_cache' as const,
      mintReasonCode: 'cache_unavailable' as const,
      suppressRecordPoints: false,
    }
    : params.deviceRateLimited || params.noObservableOutput || params.farmCapped
      ? {
        mintDisposition: 'ineligible_terminal' as const,
        mintReasonCode: 'policy_ineligible' as const,
        suppressRecordPoints: true,
      }
      : params.x402Unverified
        ? {
          mintDisposition: 'ineligible_terminal' as const,
          mintReasonCode: 'policy_ineligible' as const,
          suppressRecordPoints: true,
        }
        : null;
  const policy = materializeProposedMonetaryPolicy(0);
  const snapshot = computeRecordSnapshot(policy, {
    peId: params.peId,
    economicActorId: params.userId,
    actionType: params.actionType,
    recordedAtMs: params.timestamp,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: params.attestationDepth === 'software' ? 'software' : 'hardware_full',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: `base:8453:${params.peId}:0`,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: `session:${params.peId}`,
    genesisReservation: null,
    operationalDispositionOverride,
  });
  return {
    ...params,
    mint_disposition: snapshot.mintDisposition,
    disposition_reason_code: snapshot.mintReasonCode,
    policy_review_state: snapshot.policyReviewState,
    policy_review_reason_code: snapshot.policyReviewReasonCode,
    economic_policy_version: snapshot.policyVersion,
    economic_snapshot: snapshot,
  };
}

describe('writePEHistory - mint_status (H-6)', () => {
  beforeEach(() => {
    txnUpdates.length = 0;
  });

  it('cacheUnavailable=true → mint_status=pending_cache (RECLASSIFIABLE)', async () => {
    await writePEHistory(paramsWithSnapshot({
      cacheUnavailable: true,
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('pending_cache');
  });

  it('deviceRateLimited=true → mint_status=ineligible (TERMINAL, unchanged)', async () => {
    await writePEHistory(paramsWithSnapshot({
      deviceRateLimited: true,
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('ineligible');
  });

  it('cacheUnavailable wins over deviceRateLimited (pending_cache is more recoverable)', async () => {
    // If both flags somehow set, the more-recoverable status wins so we
    // get a chance to reclassify rather than locking into terminal state.
    await writePEHistory(paramsWithSnapshot({
      cacheUnavailable: true,
      deviceRateLimited: true,
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('pending_cache');
  });

  it('cache failure overrides an explicit eligible policy without field drift', async () => {
    await writePEHistory(paramsWithSnapshot({
      cacheUnavailable: true,
      mint_disposition: 'eligible',
      disposition_reason_code: 'policy_eligible',
    }));
    const written = txnUpdates[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      mint_status: 'pending_cache',
      mint_disposition: 'pending_cache',
      disposition_reason_code: 'cache_unavailable',
    });
  });

  it('happy path: no flags → mint_status=eligible', async () => {
    await writePEHistory(paramsWithSnapshot());
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('eligible');
  });

  it('noObservableOutput=true → mint_status=skipped_no_output', async () => {
    await writePEHistory(paramsWithSnapshot({
      noObservableOutput: true,
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('skipped_no_output');
  });

  it('farmCapped=true → mint_status=farm_capped (records provenance, mints 0), with reason', async () => {
    await writePEHistory(paramsWithSnapshot({
      farmCapped: true,
      farm_cap_reason: 'daily_ceiling',
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string; farm_cap_reason?: string };
    expect(written.mint_status).toBe('farm_capped');
    expect(written.farm_cap_reason).toBe('daily_ceiling');
  });

  it('x402Unverified=true → mint_status=x402_unverified (records + reputation, mints 0)', async () => {
    await writePEHistory(paramsWithSnapshot({
      actionType: 'x402_payment',
      category: 'x402' as unknown as 'wallet',
      x402Unverified: true,
    }));
    expect(txnUpdates).toHaveLength(1);
    const written = txnUpdates[0] as { mint_status?: string };
    expect(written.mint_status).toBe('x402_unverified');
  });

  it('farm_cap_reason is null unless farmCapped', async () => {
    await writePEHistory(paramsWithSnapshot({ farm_cap_reason: 'daily_ceiling' }));
    const written = txnUpdates[0] as { mint_status?: string; farm_cap_reason?: string | null };
    expect(written.mint_status).toBe('eligible');
    expect(written.farm_cap_reason).toBeNull();
  });

  it('unknown action policy is record_only even when cache is unavailable', async () => {
    await writePEHistory(paramsWithSnapshot({
      actionType: 'thirdparty:never_seen_before',
      cacheUnavailable: true,
      mint_disposition: 'record_only',
      disposition_reason_code: 'unknown_action_type',
      policy_review_state: 'pending_policy',
      policy_review_reason_code: 'unknown_action_type',
    }));
    const written = txnUpdates[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      disposition_reason_code: 'unknown_action_type',
      policy_review_state: 'pending_policy',
      policy_review_reason_code: 'unknown_action_type',
      economic_policy_version: expect.stringContaining('base-mainnet-monetary-proposal'),
      estimatedPVT: 0,
    });
  });

  it('maps legacy eligible records into separate explicit policy fields', async () => {
    await writePEHistory(paramsWithSnapshot());
    const written = txnUpdates[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      disposition_reason_code: 'policy_eligible',
      policy_review_state: 'not_required',
      policy_review_reason_code: 'known_policy_entry',
    });
  });
});
