/**
 * carried onto the HUMAN mobile lane (: "no actor's own claim mints, on any
 * route"). Two defects on `POST /v1/pe/submit/mobile`, closed prospectively:
 *
 * 1. A NEVER-SEEN action type (a made-up `my_garden_work`) was sealed at `device_tier` the only
 * "witness" being the human's own wallet-auth token — and class-admitted `eligible`. It now
 * seals at `actor_declared` (class base 0) → record_only. Named mobile types (ai_conversation
 * with a valid fingerprint) are unchanged.
 * 2. A `human_approval` minted on the SHAPE of `request_id` / `subject_hash` alone. It now mints
 * only for an EXISTING request addressed to the caller, naming the same agent, whose subject
 * hash matches, that is pending and unexpired — checked and claimed inside the chain-tip
 * transaction. Everything else records `record_only`.
 *
 * Drives the route's exact construction: `mobileLaneWitnessClass` + `isUnnamedActionTypeAtRecordTime`
 * (defect 1), `createApprovalSealHooks` riding the REAL `advanceChainTipAtomic`
 * transaction with the REAL co-committed ordinary-accrual intake row (defect 2), then the REAL
 * `recordPEAccrual`. The last block is the permanent in-suite RED control : the pre-fix
 * construction mints exactly the claims this fix refuses.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';
import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk({ strictTransactionOrder: true });
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

jest.mock('./cache', () => ({
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('./core/pvt/beneficiary', () => ({
  resolveBeneficiary: async (): Promise<BeneficiaryCacheEntry> => ({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./core/pvt/delegation-pe', () => ({
  isDelegationQualifying: () => false, createDelegationPE: async () => {},
}));
jest.mock('./core/provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute', recordActionTypeObservation: async () => {},
}));
jest.mock('./core/foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }), queueInitialMembershipGrants: async () => {},
}));

import type admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual, type RecordPEAccrualParams } from './pvt-accrual';
import { advanceChainTipAtomic } from './pe-chain-validator';
import {
  buildOrdinaryAccrualIntake,
  createOrdinaryAccrualIntakeInTransaction,
} from './core/pvt/wp11/ordinary-accrual-intake';
import {
  classAdmittedWitnessedFields,
  isClassAdmittedAtRecordTime,
  isUnnamedActionTypeAtRecordTime,
  mobileLaneWitnessClass,
} from './core/pvt/class-admission-earning';
import { mobileChatVerifiedFields } from './core/pvt/mobile-chat-earning';
import { createApprovalSealHooks } from './core/pvt/human-approval-seal';
import { HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS } from './core/pvt/human-approval-earning';
import type { HumanApprovalMetadata } from './core/pe/human-approval';
import { buildApprovalRequest, HUMAN_APPROVAL_REQUESTS_COLLECTION, type HumanApprovalRequestRecord } from './core/pe/human-approval-request';
import type { WitnessClass } from './core/pvt/policy/evidence-class';

const NOW = Date.now();
const HUMAN = 'human_frank';
const OTHER_HUMAN = 'human_other';
const AGENT = 'wallet_aw_atlas';
let seq = 0;

const fsDb = (): admin.firestore.Firestore => mockDb as unknown as admin.firestore.Firestore;

interface Sealed {
  readonly peId: string;
  readonly disposition: string;
  readonly points: bigint;
  readonly exactDuplicate: boolean | undefined;
  readonly witnessClass: unknown;
}

/**
 * One mobile submission, built the way `/v1/pe/submit/mobile` builds it. `preFix` reproduces the
 * route BEFORE this change (device_tier for every type + the class-admission overlay; the approval
 * overlay keyed on the parsed request id / subject hash with no request read) — the RED control.
 */
async function submitMobile(opts: {
  userId?: string;
  actionType: string;
  approval?: HumanApprovalMetadata;
  body?: string;
  preFix?: boolean;
}): Promise<Sealed> {
  const userId = opts.userId ?? HUMAN;
  const peId = `pe_mob_${seq++}`;
  const timestamp = NOW + seq;
  const bodyDigest = createHash('sha256').update(opts.body ?? peId).digest('hex');

  let witnessClass: WitnessClass;
  let extra: Partial<RecordPEAccrualParams>;
  let hooks: ReturnType<typeof createApprovalSealHooks> | null = null;
  if (opts.preFix === true) {
    witnessClass = 'device_tier';
    const reqId = opts.approval?.request_id ?? null;
    const anchor = reqId ?? opts.approval?.subject_hash ?? null;
    const approvalOverlay: Partial<RecordPEAccrualParams> = opts.actionType === 'human_approval' && anchor
      ? (() => {
        const canonical = `human_approval:${anchor}`;
        const h = createHash('sha256').update(canonical).digest('hex');
        return {
          durableReplaySource: 'ordinary_accrual_intake' as const,
          economicEvidenceState: 'verified' as const,
          economicCanonicalEventId: canonical,
          deviceWitnessedOccurrenceHash: h,
          artifact_hash: h,
        };
      })()
      : {};
    extra = {
      ...approvalOverlay,
      ...classAdmittedWitnessedFields({
        actionType: opts.actionType,
        classAdmitted: await isClassAdmittedAtRecordTime(mockDb as unknown as Firestore, {
          actionType: opts.actionType, recordedAtMs: timestamp, witnessClass,
        }),
        witnessClass,
        witnessId: 'mobile:dev_phone',
        bodyDigestHex: bodyDigest,
      }),
    };
  } else {
    witnessClass = mobileLaneWitnessClass({
      hardwareAdmitted: false,
      unnamedActionType: await isUnnamedActionTypeAtRecordTime(mockDb as unknown as Firestore, {
        actionType: opts.actionType, recordedAtMs: timestamp,
      }),
    });
    hooks = createApprovalSealHooks({
      db: fsDb(), approval: opts.approval ?? null, callerUserId: userId, approvalPeId: peId, nowMs: NOW,
    });
    extra = {};
  }

  const buildAccrualParams = (peHash: string): RecordPEAccrualParams => ({
    peId,
    userId,
    actionType: opts.actionType,
    integrationSource: 'mobile_pe_submit',
    attestationDepth: 'software',
    peHash,
    timestamp,
    isDevicePE: true,
    deviceAttestationId: 'dev_phone',
    deviceId: 'dev_phone',
    attestation_verified: true,
    ownerType: 'human',
    walletAddress: '0xabc',
    ...mobileChatVerifiedFields({
      actionType: opts.actionType,
      sessionFingerprintHash: opts.actionType === 'ai_conversation' ? createHash('sha256').update(`fp:${peId}`).digest('hex') : null,
      surface: 'claude',
    }),
    ...(hooks ? hooks.accrualFields(opts.actionType) : {}),
    ...extra,
    witnessClass,
    witnessedAtMs: NOW,
  });

  const tip = await advanceChainTipAtomic(
    fsDb(),
    userId,
    (prev) => createHash('sha256').update(`${prev}:${peId}`).digest('hex'),
    timestamp,
    (txn, ctx) => {
      createOrdinaryAccrualIntakeInTransaction(
        txn,
        fsDb(),
        buildOrdinaryAccrualIntake({ prevHash: ctx.prevHash, peHash: ctx.newHash, accrualParams: buildAccrualParams(ctx.newHash) }),
      );
      hooks?.secondaryWrite?.(txn);
    },
    hooks?.precondition,
  );
  const advanced = { prevHash: tip.prev_hash, peHash: tip.new_hash };
  await recordPEAccrual(buildAccrualParams(advanced.peHash));
  const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row for ${peId}`);
  const snap = row.economic_snapshot as Record<string, unknown> | null;
  const factors = snap?.recordTimeFactors as Record<string, unknown> | undefined;
  return {
    peId,
    disposition: String(row.mint_disposition),
    // The MINT estimate the seal carries (record points are not PVT; a record_only seal says 0).
    points: BigInt(String(row.estimated_pvt_atomic ?? 'missing')),
    exactDuplicate: factors?.exactDuplicate as boolean | undefined,
    witnessClass: row.witness_class,
  };
}

/** Seed an agent-initiated request exactly as POST /v1/agent/wallet/:id/request-approval writes it. */
function seedRequest(over: Partial<HumanApprovalRequestRecord> = {}): HumanApprovalRequestRecord {
  const built = buildApprovalRequest({
    agentWalletId: AGENT, humanUserId: HUMAN, actionDescription: 'Pay the invoice from Acme for 12 USDC', nowMs: NOW - 1000,
  });
  if (!built.ok) throw new Error(built.error);
  const record = { ...built.record, ...over };
  mockDb.store.set(`${HUMAN_APPROVAL_REQUESTS_COLLECTION}/${record.request_id}`, { ...record });
  return record;
}

const approvalFor = (r: Pick<HumanApprovalRequestRecord, 'request_id' | 'agent_wallet_id' | 'action_description_sha256'>, over: Partial<HumanApprovalMetadata> = {}): HumanApprovalMetadata => ({
  agent_wallet_id: r.agent_wallet_id,
  decision: 'approved',
  subject_pe_id: null,
  subject_hash: r.action_description_sha256,
  request_id: r.request_id,
  ...over,
});

const requestDoc = (id: string) => mockDb.store.get(`${HUMAN_APPROVAL_REQUESTS_COLLECTION}/${id}`) as Record<string, unknown>;

beforeEach(() => {
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seq = 0;
});

describe('DEFECT 1 — a never-seen mobile type is the human\'s own declaration: actor_declared, record_only, 0', () => {
  it('"my_garden_work" seals at actor_declared, record_only, zero points — on the stored PE and the accrual alike', async () => {
    const s = await submitMobile({ actionType: 'my_garden_work' });
    expect(s.witnessClass).toBe('actor_declared');
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
    // New-type intake A3: the actor's own declaration never reaches the pending-policy queue.
    expect([...mockDb.store.keys()].filter((k) => k.startsWith('pvt_pending_policy_queue/'))).toEqual([]);
  });

  it('distinct bodies do not help: every made-up occurrence records 0', async () => {
    for (const body of ['watered the garden', 'weeded the garden', 'mowed the lawn']) {
      const s = await submitMobile({ actionType: 'my_garden_work', body });
      expect(s.disposition).toBe('record_only');
      expect(s.points).toBe(0n);
    }
  });

  it('a NAMED mobile type is unchanged: ai_conversation with a valid fingerprint still seals eligible, nonzero, at device_tier', async () => {
    const s = await submitMobile({ actionType: 'ai_conversation' });
    expect(s.witnessClass).toBe('device_tier');
    expect(s.disposition).toBe('eligible');
    expect(s.points).toBeGreaterThan(0n);
  });
});

describe('DEFECT 2 — a human_approval mints only against a real, live request addressed to this human', () => {
  it('ADMIT: a valid pending request of mine → eligible, nonzero; the request is claimed by this PE in the same commit', async () => {
    const r = seedRequest();
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    // human_approval is a NAMED row (no launch-emitter entry, but the loader keeps its row): it keeps
    // the lane's device_tier witness class — never demoted to actor_declared by the defect-1 fix.
    expect(s.witnessClass).toBe('device_tier');
    expect(s.disposition).toBe('eligible');
    expect(s.points).toBeGreaterThan(0n);
    expect(requestDoc(r.request_id)).toMatchObject({ status: 'satisfied', satisfied_by_pe_id: s.peId, decision: 'approved' });
  });

  it('a second submission for the SAME request does not mint again (the claim is spent; record_only, 0)', async () => {
    const r = seedRequest();
    const first = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    const second = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    expect(first.points).toBeGreaterThan(0n);
    expect(second.disposition).toBe('record_only');
    expect(second.points).toBe(0n);
    expect(requestDoc(r.request_id).satisfied_by_pe_id).toBe(first.peId); // the claim is not stolen
  });

  it('the app\'s real order (resolve BEFORE the PE queue flushes) still mints once: satisfied by THIS envelope', async () => {
    const r = seedRequest();
    // POST /approval-requests/:id/resolve ran first with the envelope id the app is about to submit.
    // A request created at the seal-stamp line (fix run 2026-10-24): an unstamped satisfied request
    // created before it is treated as sealed by the earlier code.
    mockDb.store.set(`${HUMAN_APPROVAL_REQUESTS_COLLECTION}/${r.request_id}`, {
      ...r, status: 'satisfied', satisfied_by_pe_id: 'pe_mob_0', decision: 'approved',
      created_at_ms: HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS,
    });
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    expect(s.peId).toBe('pe_mob_0');
    expect(s.disposition).toBe('eligible');
    expect(s.points).toBeGreaterThan(0n);
    const again = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    expect(again.points).toBe(0n);
  });

  it('a FABRICATED apr_ id (no such request) → record_only, 0', async () => {
    const fake = { request_id: `apr_${'9'.repeat(32)}`, agent_wallet_id: AGENT, action_description_sha256: `sha256:${'1'.repeat(64)}` };
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(fake) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
  });

  it('subject_hash only (no request_id — the retired fallback) → record_only, 0', async () => {
    const r = seedRequest();
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r, { request_id: null }) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
    expect(requestDoc(r.request_id).status).toBe('pending');
  });

  it('ANOTHER human\'s request → record_only, 0, and their request is untouched', async () => {
    const r = seedRequest({ human_user_id: OTHER_HUMAN });
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
    expect(requestDoc(r.request_id).status).toBe('pending');
  });

  it('an EXPIRED request (past expires_at, or status expired) → record_only, 0', async () => {
    const lapsed = seedRequest({ expires_at_ms: NOW - 1 });
    const a = await submitMobile({ actionType: 'human_approval', approval: approvalFor(lapsed) });
    const marked = seedRequest({ status: 'expired' });
    const b = await submitMobile({ actionType: 'human_approval', approval: approvalFor(marked) });
    for (const s of [a, b]) {
      expect(s.disposition).toBe('record_only');
      expect(s.points).toBe(0n);
    }
  });

  it('a request already RESOLVED by another PE → record_only, 0', async () => {
    const r = seedRequest({ status: 'satisfied', satisfied_by_pe_id: 'pe_someone_else', decision: 'approved' });
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
  });

  it('a SUBJECT-HASH mismatch (approving other text than the agent described) → record_only, 0', async () => {
    const r = seedRequest();
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r, { subject_hash: `sha256:${'2'.repeat(64)}` }) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
    expect(requestDoc(r.request_id).status).toBe('pending');
  });

  it('an AGENT mismatch (the request was another agent\'s) → record_only, 0', async () => {
    const r = seedRequest();
    const s = await submitMobile({ actionType: 'human_approval', approval: approvalFor(r, { agent_wallet_id: 'wallet_aw_other' }) });
    expect(s.disposition).toBe('record_only');
    expect(s.points).toBe(0n);
  });
});

describe('RED NEGATIVE CONTROL — the PRE-FIX mobile construction mints exactly these claims', () => {
  it('pre-fix: a made-up "my_garden_work" seals at device_tier and is QUEUED as witnessed work', async () => {
    // New-type intake made every class-admitted row record_only, so the pre-fix
    // construction no longer mints it either (the intake suites carry that RED control). What the
    // mobile fix still changes is the CLASS: pre-fix the human's own token counted as a witness
    // (device_tier), so the type reached the pending-policy queue; post-fix it is actor_declared
    // and never queued (the DEFECT 1 block below).
    const s = await submitMobile({ actionType: 'my_garden_work', preFix: true });
    expect(s.witnessClass).toBe('device_tier');
    expect(s.disposition).toBe('record_only');
    expect([...mockDb.store.keys()].filter((k) => k.startsWith('pvt_pending_policy_queue/'))).toHaveLength(1);
  });

  it('pre-fix: a FABRICATED apr_ id and a random subject hash each seal ELIGIBLE, nonzero — one mint per invented value', async () => {
    const fake = { request_id: `apr_${'8'.repeat(32)}`, agent_wallet_id: AGENT, action_description_sha256: `sha256:${'3'.repeat(64)}` };
    const a = await submitMobile({ actionType: 'human_approval', approval: approvalFor(fake), preFix: true });
    const b = await submitMobile({ actionType: 'human_approval', approval: approvalFor(fake, { request_id: null, subject_hash: `sha256:${'4'.repeat(64)}` }), preFix: true });
    for (const s of [a, b]) {
      expect(s.disposition).toBe('eligible');
      expect(s.points).toBeGreaterThan(0n);
    }
  });
});

describe('SHUTDOWN COVERAGE — past the accrual end line nothing new mints ', () => {
  const ENV = 'PVT_ACCRUAL_END_MS';
  const saved = process.env[ENV];
  const restore = (): void => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  };

  it('an act sealed after the end line is recorded but seals record_only with zero mint', async () => {
    process.env[ENV] = String(Date.now() - 1_000);
    try {
      const s = await submitMobile({ actionType: 'ai_conversation' });
      expect(s.disposition).toBe('record_only');
      expect(s.points).toBe(0n);
    } finally {
      restore();
    }
  });

  it('a malformed end line blocks too (Unknown = Block)', async () => {
    process.env[ENV] = 'next tuesday';
    try {
      const s = await submitMobile({ actionType: 'ai_conversation' });
      expect(s.disposition).toBe('record_only');
      expect(s.points).toBe(0n);
    } finally {
      restore();
    }
  });

  it('CONTROL: an end line still in the future changes nothing — the same act seals eligible, nonzero', async () => {
    process.env[ENV] = String(Date.now() + 86_400_000);
    try {
      const s = await submitMobile({ actionType: 'ai_conversation' });
      expect(s.disposition).toBe('eligible');
      expect(s.points).toBeGreaterThan(0n);
    } finally {
      restore();
    }
  });
});
