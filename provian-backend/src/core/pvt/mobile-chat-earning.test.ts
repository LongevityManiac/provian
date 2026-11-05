/**
 * mobile-chat-earning — RED-controlled proof, in two layers:
 * (A) the pure overlay — that it stamps the mint fields for a body-bound
 * ai_conversation and NOTHING for any other type / malformed fingerprint;
 * (B) the MONEY OUTCOME — the same overlay driven through the REAL
 * recordPEAccrual against a fake Firestore: a mobile ai_conversation seals
 * `eligible` and prices a NON-ZERO amount, and WITHOUT the overlay the same
 * submission seals `record_only` and pays 0 (the RED control, on the
 * pre- mobile behaviour), and durable-but-unverified → pending_evidence.
 *
 * 2026-NO DURATION FLOOR. The 2,000 ms `active_duration_ms`
 * effort floor that used to gate this overlay is REMOVED: a chat session under 2 s
 * mints exactly like a long one. The overlay no longer takes `activeDurationMs` at
 * all, so duration cannot gate earning; the mint-once/novelty anchor is the session
 * fingerprint, and the remaining gates are structural (type + fingerprint + device
 * bodyBound). The `(A1) the effort floor` block is gone with it.
 *
 * Mirrors device-witnessed-earning.test.ts, the sibling overlay.
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import type { BeneficiaryCacheEntry } from './beneficiary';
import {
  deviceChatVerifiedFields,
  mobileChatVerifiedFields,
  NON_MINTING_AI_CONVERSATION_SURFACES,
} from './mobile-chat-earning';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';

const FP = 'a'.repeat(64);
const canonicalHash = crypto.createHash('sha256').update(`ai_conversation:${FP}`).digest('hex');

// ---------------------------------------------------------------------------
// (A) The pure overlay — no I/O, no mocks.
// ---------------------------------------------------------------------------
describe('(A) mobileChatVerifiedFields — the wiring decision', () => {
  it('ai_conversation + valid fingerprint → full verified/durable overlay', () => {
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' })).toEqual({
      durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: `ai_conversation:${FP}`,
      deviceWitnessedOccurrenceHash: canonicalHash,
      artifact_hash: canonicalHash,
    });
  });

  it('the occurrence hash is the mint-once anchor: identical session → identical claim', () => {
    const a = mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' });
    const b = mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' });
    expect(a.deviceWitnessedOccurrenceHash).toBe(b.deviceWitnessedOccurrenceHash);
  });

  it('distinct sessions get distinct novelty anchors (distinct sessions keep earning)', () => {
    const a = mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: 'a'.repeat(64), surface: 'mobile_wrapper' });
    const b = mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: 'b'.repeat(64), surface: 'mobile_wrapper' });
    expect(a.deviceWitnessedOccurrenceHash).not.toBe(b.deviceWitnessedOccurrenceHash);
  });

  it('tolerates an uppercase/whitespace-padded fingerprint (normalizes to canonical form)', () => {
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: `  ${FP.toUpperCase()}  `, surface: 'mobile_wrapper' })
      .economicCanonicalEventId).toBe(`ai_conversation:${FP}`);
  });

  it('RED CONTROL: a non-ai_conversation action type gets an EMPTY overlay (stays record_only)', () => {
    expect(mobileChatVerifiedFields({ actionType: 'wallet_created', sessionFingerprintHash: FP, surface: 'mobile_wrapper' })).toEqual({});
    expect(mobileChatVerifiedFields({ actionType: 'send', sessionFingerprintHash: FP, surface: 'mobile_wrapper' })).toEqual({});
  });

  it('RED CONTROL: a missing or malformed fingerprint gets an EMPTY overlay (never a 0-point eligible)', () => {
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: null, surface: 'mobile_wrapper' })).toEqual({});
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: '', surface: 'mobile_wrapper' })).toEqual({});
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: 'xyz', surface: 'mobile_wrapper' })).toEqual({});
    expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: 'a'.repeat(63), surface: 'mobile_wrapper' })).toEqual({});
  });

  it('RED CONTROL : the Android UsageStats surface gets an EMPTY overlay, case variants included', () => {
    for (const surface of ['mobile_usage_stats', 'MOBILE_USAGE_STATS', '  mobile_usage_stats ']) {
      expect(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface })).toEqual({});
    }
    // The control above is not vacuous: the identical input on the in-app surface stamps.
    expect(Object.keys(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' })).length).toBe(5);
    expect(NON_MINTING_AI_CONVERSATION_SURFACES).toEqual(['mobile_usage_stats']);
  });

  it('RED CONTROL: NO daily-ceiling / fatigue / duration-floor field is emitted ', () => {
    const overlay = mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' }) as Record<string, unknown>;
    expect(Object.keys(overlay).sort()).toEqual([
      'artifact_hash',
      'deviceWitnessedOccurrenceHash',
      'durableReplaySource',
      'economicCanonicalEventId',
      'economicEvidenceState',
    ]);
  });
});

// ---------------------------------------------------------------------------
// (A2) (WS2) — the DEVICE-route gate. Same pure logic as mobile, but the
// device route is NOT inherently body-bound, so a bearer daemon with no body
// HMAC must stay record_only. The bodyBound=false case is the RED control for
// the gate the desktop path adds.
// ---------------------------------------------------------------------------
describe('(A2) deviceChatVerifiedFields — the bodyBound gate', () => {
  it('body-bound ai_conversation → the SAME overlay the mobile path produces', () => {
    expect(deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: true, sessionFingerprintHash: FP, surface: 'desktop_foreground' }))
      .toEqual(mobileChatVerifiedFields({ actionType: 'ai_conversation', sessionFingerprintHash: FP, surface: 'mobile_wrapper' }));
  });

  it('RED CONTROL: a NON-body-bound ai_conversation gets an EMPTY overlay (stays record_only)', () => {
    // A bearer device with no X-Provian-Body-HMAC is authenticated but cannot
    // vouch for the work — it must not earn. This is the gate the device route adds.
    expect(deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: false, sessionFingerprintHash: FP, surface: 'desktop_foreground' })).toEqual({});
  });

  it('RED CONTROL: body-bound but non-ai_conversation / malformed fingerprint → EMPTY', () => {
    expect(deviceChatVerifiedFields({ actionType: 'coding_session', bodyBound: true, sessionFingerprintHash: FP, surface: 'desktop_foreground' })).toEqual({});
    expect(deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: true, sessionFingerprintHash: null, surface: 'desktop_foreground' })).toEqual({});
    expect(deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: true, sessionFingerprintHash: 'a'.repeat(63), surface: 'desktop_foreground' })).toEqual({});
  });

  it('RED CONTROL : a body-bound device PE claiming the UsageStats surface gets an EMPTY overlay', () => {
    expect(deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: true, sessionFingerprintHash: FP, surface: 'mobile_usage_stats' })).toEqual({});
  });

  it('the occurrence anchor is identical to the mobile path for the same session (one mint-once space across surfaces)', () => {
    const dev = deviceChatVerifiedFields({ actionType: 'ai_conversation', bodyBound: true, sessionFingerprintHash: FP, surface: 'desktop_foreground' });
    expect(dev.deviceWitnessedOccurrenceHash).toBe(canonicalHash);
  });
});

// ---------------------------------------------------------------------------
// (B) The money outcome — real recordPEAccrual against a fake Firestore.
//     Mock preamble mirrors device-witnessed-earning.test.ts.
// ---------------------------------------------------------------------------
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';

const TIMESTAMP = Date.UTC(2026, 7, 15, 12, 0);
let seq = 0;

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: { recordPointsAtomic: string; recordTimeFactors?: { attestationMultiplierBps?: number } } | null;
}

/** The exact params the mobile submit handler builds for a chat PE. */
function mobileChatParams(
  over: Record<string, unknown> = {},
  surface: string = 'mobile_wrapper',
): RecordPEAccrualParams {
  const peId = `pe_chat_${seq++}`;
  const overlay = mobileChatVerifiedFields({
    actionType: 'ai_conversation',
    sessionFingerprintHash: crypto.createHash('sha256').update(peId).digest('hex'),
    surface,
  });
  return {
    peId,
    userId: 'human1',
    actionType: 'ai_conversation',
    integrationSource: 'mobile_pe_submit',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    ownerType: 'human',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    ...overlay,
    ...over,
  } as RecordPEAccrualParams;
}

function commitIntake(params: RecordPEAccrualParams): void {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
}
function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  commitIntake(params);
  await recordPEAccrual(params);
  return row(params.peId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe('(B) a mobile ai_conversation MINTS; without the overlay it does not', () => {
  it('with the overlay → eligible, NON-ZERO, priced at software 0.8× (8000 bps)', async () => {
    const sealed = await seal(mobileChatParams());
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
  });

  it('NO DURATION FLOOR (2026-09-12): a short session mints — the overlay never sees duration', async () => {
    // The overlay has no `activeDurationMs` parameter, so a session of ANY length —
    // including one that the old floor would have sealed record_only (< 2 s) —
    // reaches the accrual with the full verified overlay and mints. `active_duration_ms`
    // may still ride the PE metadata as an informational field, but it gates nothing.
    // This is the money-outcome side of "a chat session under 2 s mints".
    const sealed = await seal(mobileChatParams({ activeDurationMs: 125 }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
  });

  it('RED (pre- behaviour): the SAME chat submission WITHOUT the overlay seals record_only, 0', async () => {
    const params = mobileChatParams();
    const bare = { ...params };
    delete (bare as Record<string, unknown>).durableReplaySource;
    delete (bare as Record<string, unknown>).economicEvidenceState;
    delete (bare as Record<string, unknown>).economicCanonicalEventId;
    delete (bare as Record<string, unknown>).deviceWitnessedOccurrenceHash;
    delete (bare as Record<string, unknown>).artifact_hash;
    const sealed = await seal(bare as RecordPEAccrualParams);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('a mobile_usage_stats / presence_only PE seals record_only and pays 0', async () => {
    const sealed = await seal(mobileChatParams({}, 'mobile_usage_stats'));
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.mint_status).not.toBe('eligible');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('RED: durable but NOT verified (evidence gate) → pending_evidence, 0', async () => {
    const params = mobileChatParams();
    const noEvidence = { ...params };
    delete (noEvidence as Record<string, unknown>).economicEvidenceState;
    const sealed = await seal(noEvidence as RecordPEAccrualParams);
    expect(sealed.mint_disposition).toBe('pending_evidence');
    expect(sealed.estimatedPVT).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (C) (WS2) — the DESKTOP device path MINTS when body-bound; the SAME
//     submission from a NON-body-bound bearer daemon does not. This is the
//     money-outcome proof for the device route (integration_source =
//     device_pe_submit), with the bodyBound gate as its RED control.
// ---------------------------------------------------------------------------
/** The exact params the DEVICE submit handler builds for a desktop chat PE. */
function deviceChatParams(
  bodyBound: boolean,
  over: Record<string, unknown> = {},
  surface: string = 'desktop_foreground',
): RecordPEAccrualParams {
  const peId = `pe_devchat_${seq++}`;
  const overlay = deviceChatVerifiedFields({
    actionType: 'ai_conversation',
    bodyBound,
    sessionFingerprintHash: crypto.createHash('sha256').update(peId).digest('hex'),
    surface,
  });
  return {
    peId,
    userId: 'human_desktop',
    actionType: 'ai_conversation',
    integrationSource: 'device_pe_submit',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    deviceId: 'dev_desktop_1',
    deviceAttestationId: 'dev_desktop_1',
    ownerType: 'human',
    walletAddress: '0x00000000000000000000000000000000000000bb',
    ...overlay,
    ...over,
  } as RecordPEAccrualParams;
}

describe('(C) a body-bound DESKTOP ai_conversation MINTS; a non-body-bound one does not', () => {
  it('body-bound → eligible, NON-ZERO, priced at software 0.8× (8000 bps)', async () => {
    const sealed = await seal(deviceChatParams(true));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
  });

  it('RED CONTROL: the SAME desktop chat from a NON-body-bound bearer daemon seals record_only, 0', async () => {
    // bodyBound=false → empty overlay → the fence holds, exactly the pre-WS2
    // behaviour every device ai_conversation PE had. This is the gate the
    // "emitted / seals eligible" failure mode would have slipped past.
    const sealed = await seal(deviceChatParams(false));
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('a body-bound device PE claiming the UsageStats surface seals record_only, 0', async () => {
    const sealed = await seal(deviceChatParams(true, {}, 'mobile_usage_stats'));
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });
});
