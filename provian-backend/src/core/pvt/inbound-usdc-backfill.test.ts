/**
 * the inbound USDC lineage backfill. Real Firestore graph (route-created
 * wallet, real rotation transition), real watcher claim path and real PE emit;
 * only the chain (logs + two-operator evidence) is a double.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const verifyPop = jest.fn(async (
  challengeId: string,
  expected: { registration_id: string; agent_id: string },
) => ({
  ok: true as const,
  registration_context: {
    ...expected,
    credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
  },
}));
jest.mock('../agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => verifyPop(challengeId, expected),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));
// The REAL pe_history writer runs in the round-2 partial-state test; its
// jurisdiction read is the only Firestore-global it makes.
jest.mock('../jurisdiction/jurisdiction-policy', () => ({
  ...(jest.requireActual('../jurisdiction/jurisdiction-policy') as object),
  getJurisdictionPolicy: async () => 'immediate',
}));
const listProvenAddresses = jest.fn(async () => [] as unknown[]);
jest.mock('../external-address/link', () => ({
  ...(jest.requireActual('../external-address/link') as object),
  listProvenAddresses: () => listProvenAddresses(),
}));

import type { Firestore } from 'firebase-admin/firestore';
import { Log } from 'ethers';
import { writePEHistory } from '../../pe-history';
import type { AgentBankDeps } from '../agent-bank/types';
import { METER_RELAY_ACTS_COLLECTION } from '../meter/meter-relay-authored';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import {
  buildBaseInboundDeps,
  inboundSeenDocId,
  INBOUND_SEEN_COLLECTION,
  scanInboundUsdc,
  type InboundTransferLog,
  type InboundUsdcScanDeps,
} from './inbound-usdc-watcher';
import {
  INBOUND_HISTORICAL_ADMISSION_COLLECTION,
  INBOUND_HISTORICAL_ADMISSION_LABEL,
  assertHistoricalAdmission,
  clipLineageWindow,
  computeLineageWindows,
  lineageWindowAdmits,
  loadAgentAddressLineage,
  LOG_RANGE_REFUSAL,
  assertInboundLogShape,
  runInboundUsdcBackfill,
  withRangeSplitting,
  type InboundBackfillParams,
  type LineageWindow,
} from './inbound-usdc-backfill';
import {
  isActivePolicyVersion,
  productionBackfillMonetaryGate,
  type BackfillMonetaryGate,
} from './inbound-usdc-backfill-monetary';
import { APPROVED_MONETARY_ACTIVATION_SIGNATURE } from './policy/approved-monetary-activation-approval';
import {
  PROPOSED_MONETARY_POLICY_TEMPLATE,
  hashProposedMonetaryPolicyTemplate,
} from './policy/proposed-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';
import {
  MONETARY_POLICY_ACTIVATION_COLLECTION,
  MONETARY_POLICY_ACTIVATION_DOCUMENT,
} from './policy/runtime-monetary-policy';
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from './watcher-address-admission';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from './native-wallet-registration';
import { IDENTITY_ACTS_COLLECTION } from '../meter/identity-acts';
import {
  rehashIdentityAct,
  replaceIdentityActRecord,
} from '../agent-wallet/__test-helpers__/identity-pe-fixture';
import {
  AGENT_ID,
  BIRTH_ADDRESS,
  SIGNER_ONE,
  agentBankDeps,
  buildAgentRoute,
  createAgentWallet,
  rotateAgent,
  type FakeDb,
} from './__test-helpers__/rotated-agent';

const SENDER = '0x9999999999999999999999999999999999999999';

/**
 * A gate double for the tests that exercise the claim path itself (the real
 * gate refuses under NODE_ENV=test by design — see the monetary-gate suite,
 * which drives the PRODUCTION gate with NODE_ENV=production). Blocks listed in
 * `inactiveBlocks` project an inactive policy.
 */
function stubGate(inactiveBlocks: ReadonlySet<number> = new Set()): BackfillMonetaryGate {
  return {
    preflight: async () => ({
      admits_execute: true, refusal: null, node_env: 'test', approval_env_present: true,
      activation_verdict: 'quiet_active', digest_match: true,
      computed_template_sha256: 'stub', pinned_template_sha256: 'stub',
      policy_version: 'stub-policy', effective_at_ms: 0, activity_mapping_enabled: true,
    }),
    project: async ({ log, recordedAtMs }) => ({
      recorded_at_ms: recordedAtMs,
      policy_version: inactiveBlocks.has(log.blockNumber) ? 'inactive' : 'stub-policy',
      policy_active: !inactiveBlocks.has(log.blockNumber),
      mint_disposition: 'eligible', mint_reason_code: 'policy_eligible',
      record_points_atomic: '1', receive_authored: true, linkage_state: 'unlinked',
    }),
  };
}

function backfill(params: InboundBackfillParams) {
  return runInboundUsdcBackfill({ monetaryGate: stubGate(), ...params });
}

// The PRODUCTION approval key pair, exactly as the relay's Cloud Run env and the
// Backend Tests workflow carry it.
const APPROVAL_ENV = {
  FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY:
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAf9JCgexoRd6ZMoF1oJOIS25hmoqPriUTxlz3rVZ6e provian-pvt-policy',
  FRANK_PVT_APPROVAL_SSH_KEY_SHA256: APPROVED_MONETARY_ACTIVATION_SIGNATURE.public_key_sha256,
};

async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(over).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The live activation's shape, carrying the SHIPPED signature (verifies for real). */
function seedMonetaryActivation(fake: FakeDb, over: Record<string, unknown> = {}): void {
  const effectiveAt = Date.now() - 3_600_000;
  fake.store.set(`${MONETARY_POLICY_ACTIVATION_COLLECTION}/${MONETARY_POLICY_ACTIVATION_DOCUMENT}`, {
    schema_version: 'pvt-monetary-policy-activation/v1',
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: APPROVED_MONETARY_ACTIVATION_SIGNATURE,
    policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
    policy_template_sha256: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: effectiveAt,
    effective_until_ms: null,
    activation_scope: 'record_and_settlement',
    automation_generated: false,
    activated_at_ms: effectiveAt,
    activated_by: 'backfill-test-operator',
    ...over,
  });
}

function writtenSince(fake: FakeDb, before: Map<string, unknown>): string[] {
  return [...fake.store.keys()].filter((key) => !before.has(key));
}

let errorSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => errorSpy.mockRestore());

function transfer(label: string, to: string, blockNumber: number, amountAtomic = '1500000'): InboundTransferLog {
  return {
    txHash: testTxHash(label),
    logIndex: 3,
    blockNumber,
    fromAddress: SENDER,
    toAddress: to,
    amountAtomic,
  };
}

/** A chain double: logs by recipient + block range, and two-operator evidence
 * that can be switched off to strand a claim. */
const CHAIN_TIME_BASE_MS = Date.now() - 60_000;

function chain(logs: InboundTransferLog[], options: { strays?: InboundTransferLog[] } = {}) {
  const state = { verifyFails: false, strays: [...(options.strays ?? [])] };
  const overlay = (base: InboundUsdcScanDeps, head: number): InboundUsdcScanDeps => ({
    ...base,
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      const wanted = new Set(toAddresses.map((a) => a.toLowerCase()));
      const out = logs.filter((log) => wanted.has(log.toAddress)
        && log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
      // A misbehaving provider leg: out-of-range logs for a requested address.
      const stray = state.strays.filter((log) => wanted.has(log.toAddress));
      state.strays = state.strays.filter((log) => !wanted.has(log.toAddress));
      return [...out, ...stray];
    },
    verifyFundingEvent: async (wallet, event) => {
      if (state.verifyFails) throw new Error('economic_discovery_rpc_disagreement:test');
      return baseEconomicEvidence({
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        fromAddress: event.fromAddress,
        toAddress: wallet.address,
        amountAtomic: event.amountAtomic,
        // Deterministic per block, as the chain is: a retry re-reads the SAME
        // evidence, which freezeWatcherClaimEvidence requires byte-identical.
        blockTimestampMs: CHAIN_TIME_BASE_MS + event.blockNumber,
      });
    },
  });
  return { state, overlay };
}

function seenKey(log: InboundTransferLog): string {
  return `${INBOUND_SEEN_COLLECTION}/${inboundSeenDocId(8453, log.txHash, log.logIndex)}`;
}

function setCheckpoint(fake: FakeDb, lastProcessed: number): void {
  const key = `${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`;
  fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), last_processed_block: lastProcessed });
}

/**
 * PE METER: a relay-authored receive PE is never stored readable. The relay stages its act record
 * (`meter_relay_acts_v1/{pe_id}`) in the chain-tip transaction and, once priced, keeps a 31-day
 * act key (`meter_act_keys_v1/{pe_id}`). These test deps price through a recorder that seals
 * nothing, so the staged act remains; a priced one leaves its act key. Each receive PE the relay
 * sealed is counted once, by pe id, across both.
 */
function receiveActs(fake: FakeDb): Map<string, { peHash: string; actorAddress: unknown }> {
  const acts = new Map<string, { peHash: string; actorAddress: unknown }>();
  for (const [key, value] of fake.store) {
    const doc = value as Record<string, unknown>;
    if (key.startsWith(`${METER_RELAY_ACTS_COLLECTION}/`)) {
      const act = doc.act as { action_type: string; pe_hash: string; pricing: Record<string, unknown> };
      if (act.action_type === 'receive') {
        acts.set(String(doc.pe_id), { peHash: act.pe_hash, actorAddress: act.pricing.actor_address });
      }
    } else if (key.startsWith(`${METER_ACT_KEYS_COLLECTION}/`) && doc.action_type === 'receive') {
      const id = key.slice(METER_ACT_KEYS_COLLECTION.length + 1);
      if (!acts.has(id)) acts.set(id, { peHash: String(doc.pe_hash), actorAddress: undefined });
    }
  }
  expect([...fake.store.keys()].some((k) => k.startsWith('provenance_envelopes/pe_inbound_'))).toBe(false);
  return acts;
}

function peCount(fake: FakeDb): number {
  return receiveActs(fake).size;
}

/**
 * The Atlas shape: a birth-address claim is STRANDED (verification failed while
 * the address was live), then the key rotates, the watcher excludes the rotated
 * wallet, and transfers keep arriving at both addresses.
 */
async function atlasFixture() {
  const { app, fake } = buildAgentRoute();
  const walletId = await createAgentWallet(app); // birth fence: head 140 → 141
  const stranded = transfer('stranded-birth', BIRTH_ADDRESS, 200);
  const missedBirth = transfer('missed-birth', BIRTH_ADDRESS, 400);
  const afterRetirement = transfer('after-retirement', BIRTH_ADDRESS, 600);
  const missedCurrent = transfer('missed-current', SIGNER_ONE.address, 700);
  const beyondCheckpoint = transfer('beyond-checkpoint', SIGNER_ONE.address, 1_200);
  const logs = [stranded, missedBirth, afterRetirement, missedCurrent, beyondCheckpoint];
  const double = chain(logs);

  // The live watcher sees the stranded transfer while the birth address is live,
  // but two-operator verification fails, so the claim is left pending.
  double.state.verifyFails = true;
  const live = double.overlay(buildBaseInboundDeps(agentBankDeps(fake)), 300);
  await scanInboundUsdc({ ...live, now: () => Date.now() }, { blockChunk: 100 });
  expect(fake.store.get(seenKey(stranded))).toMatchObject({ state: 'pending_reverification' });
  // The live watcher's cursor only reached 289 — the next 111 blocks of the
  // birth window were never scanned before the rotation.
  double.state.verifyFails = false;

  await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now(), head: 500 }); // fence 501
  setCheckpoint(fake, 1_000); // the live watcher advanced while the wallet was excluded
  return { app, fake, walletId, double, stranded, missedBirth, afterRetirement, missedCurrent, beyondCheckpoint };
}

describe('lineage windows ', () => {
  // PE METER: the lineage's birth and rotation PEs are point-read identity acts. RED controls:
  // a missing rotation act, and a birth act re-hashed and re-pinned so it no longer opens the
  // agent's chain (the binding a whole-chain walk's expected-birth check used to give).
  test('the lineage refuses a missing rotation act and a birth act that does not open the chain', async () => {
    const control = await atlasFixture();
    await expect(loadAgentAddressLineage(control.fake as unknown as Firestore, control.walletId, Date.now()))
      .resolves.toMatchObject({ rotationCount: 1 });

    const missing = await atlasFixture();
    const rotationKeys = [...missing.fake.store.entries()]
      .filter(([key, value]) => key.startsWith(`${IDENTITY_ACTS_COLLECTION}/`)
        && (value.act as Record<string, unknown>).action_type === 'agent_key_rotated')
      .map(([key]) => key);
    expect(rotationKeys).toHaveLength(1);
    missing.fake.store.delete(rotationKeys[0]);
    await expect(loadAgentAddressLineage(missing.fake as unknown as Firestore, missing.walletId, Date.now()))
      .rejects.toThrow('agent_address_lineage:rotation_pe_not_in_chain');

    const reborn = await atlasFixture();
    const indexKey = `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(AGENT_ID)}`;
    const birthKey = `${IDENTITY_ACTS_COLLECTION}/${String((reborn.fake.store.get(indexKey) as Record<string, unknown>).pe_id)}`;
    replaceIdentityActRecord(reborn.fake.store, birthKey, 'prev_hash', 'e'.repeat(64));
    const hash = rehashIdentityAct(reborn.fake.store, birthKey);
    reborn.fake.store.set(indexKey, { ...(reborn.fake.store.get(indexKey) as Record<string, unknown>), pe_hash: hash });
    await expect(loadAgentAddressLineage(reborn.fake as unknown as Firestore, reborn.walletId, Date.now()))
      .rejects.toThrow('agent_address_lineage:birth_binding');
  });

  test('each address is credited from its own fence through the next rotation head; the current through the checkpoint', async () => {
    const { fake, walletId } = await atlasFixture();
    const db = fake as unknown as Firestore;
    const lineage = await loadAgentAddressLineage(db, walletId, Date.now());
    const windows = computeLineageWindows(lineage, {
      birthFenceEvidence: { values: [141], sources: ['inbound_claims'] },
      currentCeiling: 1_000,
    });
    expect(windows.map((w) => [w.address, w.status, w.startBlock, w.endBlock, w.refused])).toEqual([
      [BIRTH_ADDRESS, 'retired', 141, 500, null],
      [SIGNER_ONE.address, 'current', 501, 1_000, null],
    ]);
  });

  test('RED: pre-fence and post-retirement transfers are refused; the clip never widens a window', async () => {
    const { fake, walletId } = await atlasFixture();
    const lineage = await loadAgentAddressLineage(fake as unknown as Firestore, walletId, Date.now());
    const [birth, current] = computeLineageWindows(lineage, {
      birthFenceEvidence: { values: [141], sources: ['outbound_admission'] },
      currentCeiling: 1_000,
    });
    expect(lineageWindowAdmits(birth, 140)).toBe('pre_fence');
    expect(lineageWindowAdmits(birth, 141)).toBe('admit');
    expect(lineageWindowAdmits(birth, 500)).toBe('admit');
    expect(lineageWindowAdmits(birth, 501)).toBe('post_retirement');
    expect(lineageWindowAdmits(current, 500)).toBe('pre_fence');
    expect(lineageWindowAdmits(current, 1_001)).toBe('post_retirement');
    expect(clipLineageWindow(birth, { fromBlock: 0, toBlock: 10_000 })).toEqual({ fromBlock: 141, toBlock: 500 });
    expect(clipLineageWindow(birth, { fromBlock: 600 })).toBeNull();
  });

  test('a birth fence with no evidence, or conflicting evidence, refuses that window (Unknown = Block)', async () => {
    const { fake, walletId } = await atlasFixture();
    const lineage = await loadAgentAddressLineage(fake as unknown as Firestore, walletId, Date.now());
    const none = computeLineageWindows(lineage, { birthFenceEvidence: { values: [], sources: [] }, currentCeiling: 1_000 });
    expect(none[0]).toMatchObject({ refused: 'birth_fence_unrecoverable', startBlock: null });
    expect(lineageWindowAdmits(none[0] as LineageWindow, 300)).toBe('window_refused');
    const conflict = computeLineageWindows(lineage, {
      birthFenceEvidence: { values: [141, 150], sources: ['outbound_admission', 'inbound_claims'] },
      currentCeiling: 1_000,
    });
    expect(conflict[0]).toMatchObject({ refused: 'birth_fence_conflict' });
    // The current window is unaffected by the birth refusal.
    expect(conflict[1]).toMatchObject({ refused: null, startBlock: 501 });
  });
});

describe('runInboundUsdcBackfill ', () => {
  test('dry run reports what it would do and writes nothing', async () => {
    const f = await atlasFixture();
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const before = new Map(f.fake.store);
    const report = await backfill({ deps, walletId: f.walletId, execute: false, blockChunk: 50, segmentBlocks: 500 });
    const byTx = new Map(report.transfers.map((t) => [t.tx_hash, t.outcome]));
    expect(byTx.get(f.stranded.txHash)).toBe('would_recover');
    expect(byTx.get(f.missedBirth.txHash)).toBe('would_witness');
    expect(byTx.get(f.missedCurrent.txHash)).toBe('would_witness');
    expect(byTx.has(f.afterRetirement.txHash)).toBe(false); // never fetched: outside every window
    expect(byTx.has(f.beyondCheckpoint.txHash)).toBe(false); // the live watcher owns it
    expect(report.windows.map((w) => w.fenceSource)).toEqual(['inbound_claims', 'rotation_pe']);
    expect([...f.fake.store.keys()].filter((k) => !before.has(k))).toEqual([]);
  });

  test('execute witnesses the missed transfers, recovers the stranded claim, and is idempotent', async () => {
    const f = await atlasFixture();
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const receivesBefore = peCount(f.fake);
    const report = await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    const byTx = new Map(report.transfers.map((t) => [t.tx_hash, t]));
    expect(byTx.get(f.stranded.txHash)).toMatchObject({ outcome: 'recovered', pe_id: expect.stringMatching(/^pe_inbound_/) });
    expect(byTx.get(f.missedBirth.txHash)).toMatchObject({
      outcome: 'witnessed', to: BIRTH_ADDRESS, block_number: 400, amount_atomic: '1500000', from: SENDER,
      pe_id: expect.stringMatching(/^pe_inbound_/),
    });
    expect(byTx.get(f.missedCurrent.txHash)).toMatchObject({ outcome: 'witnessed', to: SIGNER_ONE.address });
    expect(peCount(f.fake)).toBe(receivesBefore + 3);
    for (const log of [f.stranded, f.missedBirth, f.missedCurrent]) {
      expect(f.fake.store.get(seenKey(log))).toMatchObject({ state: 'complete', pe_id: byTx.get(log.txHash)!.pe_id });
    }
    // The retired address is witnessed through a labelled historical admission, never a live one.
    const historical = [...f.fake.store.entries()]
      .filter(([k]) => k.startsWith(`${INBOUND_HISTORICAL_ADMISSION_COLLECTION}/`)).map(([, v]) => v);
    expect(historical).toEqual([expect.objectContaining({
      label: INBOUND_HISTORICAL_ADMISSION_LABEL, address: BIRTH_ADDRESS,
      eligibility_start_block: 141, retired_after_block: 500,
    })]);

    const again = await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    expect(again.transfers.map((t) => t.outcome).sort()).toEqual(['already_witnessed', 'already_witnessed', 'already_witnessed']);
    expect(new Map(again.transfers.map((t) => [t.tx_hash, t.pe_id]))).toEqual(
      new Map(report.transfers.map((t) => [t.tx_hash, t.pe_id])),
    );
    expect(peCount(f.fake)).toBe(receivesBefore + 3);
  });

  test('RED: out-of-window logs from a misbehaving provider are refused before any claim exists', async () => {
    const preFence = transfer('pre-fence-current', SIGNER_ONE.address, 450);
    const postRetirement = transfer('post-retirement-birth', BIRTH_ADDRESS, 650);
    const f = await atlasFixture();
    // Armed after the fixture's live scan, so the live watcher cannot consume them.
    f.double.state.strays = [preFence, postRetirement];
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const report = await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    expect(report.transfers.find((t) => t.tx_hash === preFence.txHash)).toMatchObject({ outcome: 'refused_pre_fence', pe_id: null });
    expect(report.transfers.find((t) => t.tx_hash === postRetirement.txHash))
      .toMatchObject({ outcome: 'refused_post_retirement', pe_id: null });
    // No durable claim: a claim for an uncreditable transfer would sit pending in
    // the live watcher's recovery forever.
    expect(f.fake.store.has(seenKey(preFence))).toBe(false);
    expect(f.fake.store.has(seenKey(postRetirement))).toBe(false);
  });

  test('RED: the historical admission refuses pre-fence, post-retirement, and a live address', async () => {
    const f = await atlasFixture();
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    const db = f.fake as unknown as Firestore;
    const target = {
      direction: 'inbound' as const, chainId: 8453, address: BIRTH_ADDRESS,
      walletId: f.walletId, agentId: 'canonical-agent', eligibilityStartBlock: 141,
    };
    await expect(assertHistoricalAdmission(db, target, 300)).resolves.toBeUndefined();
    await expect(assertHistoricalAdmission(db, target, 140)).rejects.toThrow('historical_admission_pre_fence');
    await expect(assertHistoricalAdmission(db, target, 501)).rejects.toThrow('historical_admission_post_retirement');
    await expect(assertHistoricalAdmission(db, { ...target, walletId: 'someone-else' }, 300))
      .rejects.toThrow('historical_admission_binding');
    // The CURRENT address has no historical admission: a live address is only
    // ever witnessed through its live admission.
    await expect(assertHistoricalAdmission(db, { ...target, address: SIGNER_ONE.address, eligibilityStartBlock: 501 }, 700))
      .rejects.toThrow('historical_admission_missing');
  });

  test('an un-rotated wallet backfills its single window from its registration fence', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    setCheckpoint(fake, 400);
    const missed = transfer('unrotated-missed', BIRTH_ADDRESS, 350);
    const double = chain([missed]);
    const deps = double.overlay(buildBaseInboundDeps(agentBankDeps(fake)), 500);
    const report = await backfill({ deps, walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    expect(report.windows).toEqual([expect.objectContaining({ status: 'current', startBlock: 141, endBlock: 400, fenceSource: 'wallet_fence' })]);
    expect(report.transfers).toEqual([expect.objectContaining({ outcome: 'witnessed', block_number: 350 })]);
  });
});

describe('the backfill monetary gate ( )', () => {
  // A shell without the Cloud Run approval env prices under the INACTIVE
  // record-only policy: every recovered receive would seal 0 PVT under a
  // deterministic PE id, permanently. The loader's NODE_ENV=test branch hides
  // this in every other suite, so these run the PRODUCTION gate with
  // NODE_ENV=production.
  test('RED: --execute without the approval env is refused before any claim, admission or PE', async () => {
    const f = await atlasFixture();
    // This case deliberately runs with NODE_ENV=production. Model the actual read converter
    // on its legacy identity fixtures rather than weakening the production storage boundary.
    const originalCollection=f.fake.collection.bind(f.fake);
    (f.fake as any).collection=(name:string)=>{
      const base=originalCollection(name) as any;
      base.withConverter=(converter:FirebaseFirestore.FirestoreDataConverter<any>)=>({
        ...base,doc:(id:string)=>{
          const ref=base.doc(id),originalGet=ref.get.bind(ref);
          return {...ref,get:async()=>{const snap=await originalGet();return {...snap,data:()=>snap.exists?converter.fromFirestore(snap):undefined};}};
        },
      });
      return base;
    };
    seedMonetaryActivation(f.fake);
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const before = new Map(f.fake.store);
    const receivesBefore = peCount(f.fake);
    await withEnv({
      NODE_ENV: 'production',
      FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY: undefined,
      FRANK_PVT_APPROVAL_SSH_KEY_SHA256: undefined,
    }, async () => {
      await expect(runInboundUsdcBackfill({
        deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500,
      })).rejects.toThrow('inbound_backfill:monetary_preflight_refused:approval_verifier_env_absent');
    });
    expect(writtenSince(f.fake, before)).toEqual([]);
    expect(peCount(f.fake)).toBe(receivesBefore);
    expect(f.fake.store.has(seenKey(f.missedBirth))).toBe(false);
  });

  test('--execute is refused when this tree computes a different template digest than the live document pins', async () => {
    const f = await atlasFixture();
    seedMonetaryActivation(f.fake, { policy_template_sha256: `sha256:${'0'.repeat(64)}` });
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const before = new Map(f.fake.store);
    await withEnv({ NODE_ENV: 'production', ...APPROVAL_ENV }, async () => {
      await expect(runInboundUsdcBackfill({
        deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500,
      })).rejects.toThrow('monetary_preflight_refused:monetary_template_digest_mismatch');
    });
    expect(writtenSince(f.fake, before)).toEqual([]);
  });

  test('--execute is refused under NODE_ENV=test, whose loader branch has no activation at all', async () => {
    const f = await atlasFixture();
    seedMonetaryActivation(f.fake);
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    await withEnv({ ...APPROVAL_ENV }, async () => {
      await expect(runInboundUsdcBackfill({
        deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500,
      })).rejects.toThrow('monetary_preflight_refused:node_env_test_materializes_policy_without_activation');
    });
  });

  test('the production gate admits a live, signed activation and projects the active policy (non-vacuous)', async () => {
    const f = await atlasFixture();
    seedMonetaryActivation(f.fake);
    const db = f.fake as unknown as Firestore;
    await withEnv({ NODE_ENV: 'production', ...APPROVAL_ENV }, async () => {
      const gate = productionBackfillMonetaryGate(db);
      const preflight = await gate.preflight();
      expect(preflight).toMatchObject({
        admits_execute: true, refusal: null, activation_verdict: 'quiet_active', digest_match: true,
        approval_env_present: true, activity_mapping_enabled: true,
        policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
      });
      const wallet = {
        walletId: f.walletId, agentId: 'canonical-agent', address: SIGNER_ONE.address,
        createdAtMs: 0, ownerType: 'agent' as const, eligibilityStartBlock: 501,
      };
      const active = await gate.project({
        wallet, log: f.missedCurrent, recordedAtMs: Date.now(), pinnedPolicyVersion: preflight.policy_version,
      });
      expect(active.policy_active).toBe(true);
      expect(isActivePolicyVersion(active.policy_version, preflight.policy_version)).toBe(true);
      expect(BigInt(active.record_points_atomic) > 0n).toBe(true);
      // Before the activation's effective_at the loader returns the inactive vintage.
      const inactive = await gate.project({
        wallet, log: f.missedCurrent, recordedAtMs: Date.now() - 7_200_000,
        pinnedPolicyVersion: preflight.policy_version,
      });
      expect(inactive.policy_active).toBe(false);
      expect(isActivePolicyVersion(inactive.policy_version, preflight.policy_version)).toBe(false);
    });
  });

  test('the dry run prints each row\'s projected disposition and record points, and writes nothing', async () => {
    const f = await atlasFixture();
    // This case deliberately runs with NODE_ENV=production. Model the actual read converter
    // on its legacy identity fixtures rather than weakening the production storage boundary.
    const originalCollection=f.fake.collection.bind(f.fake);
    (f.fake as any).collection=(name:string)=>{
      const base=originalCollection(name) as any;
      base.withConverter=(converter:FirebaseFirestore.FirestoreDataConverter<any>)=>({
        ...base,doc:(id:string)=>{
          const ref=base.doc(id),originalGet=ref.get.bind(ref);
          return {...ref,get:async()=>{const snap=await originalGet();return {...snap,data:()=>snap.exists?converter.fromFirestore(snap):undefined};}};
        },
      });
      return base;
    };
    seedMonetaryActivation(f.fake);
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const before = new Map(f.fake.store);
    const report = await withEnv({ NODE_ENV: 'production', ...APPROVAL_ENV }, () => runInboundUsdcBackfill({
      deps, walletId: f.walletId, execute: false, blockChunk: 50, segmentBlocks: 500,
    }));
    expect(report.monetary_preflight).toMatchObject({ admits_execute: true, digest_match: true });
    const pending = report.transfers.filter((t) => t.outcome === 'would_witness' || t.outcome === 'would_recover');
    expect(pending).toHaveLength(3);
    for (const t of pending) {
      expect(t.projection).toEqual(expect.objectContaining({
        policy_active: true,
        mint_disposition: expect.any(String),
        record_points_atomic: expect.stringMatching(/^\d+$/),
      }));
    }
    expect(writtenSince(f.fake, before)).toEqual([]);
  });

  test('a transfer whose record time is outside the active policy is refused with no claim; the rest proceed', async () => {
    const f = await atlasFixture();
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const report = await runInboundUsdcBackfill({
      deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500,
      monetaryGate: stubGate(new Set([f.missedBirth.blockNumber])),
    });
    const byTx = new Map(report.transfers.map((t) => [t.tx_hash, t]));
    expect(byTx.get(f.missedBirth.txHash)).toMatchObject({ outcome: 'refused_monetary_policy_inactive', pe_id: null });
    expect(f.fake.store.has(seenKey(f.missedBirth))).toBe(false);
    expect(byTx.get(f.missedCurrent.txHash)).toMatchObject({ outcome: 'witnessed' });
  });

  test('a transfer whose record time cannot be read is refused with no claim', async () => {
    const f = await atlasFixture();
    f.double.state.verifyFails = true;
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const report = await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 });
    expect(report.transfers.find((t) => t.tx_hash === f.missedCurrent.txHash))
      .toMatchObject({ outcome: 'refused_unverified', pe_id: null });
    expect(f.fake.store.has(seenKey(f.missedCurrent))).toBe(false);
  });
});

describe(' round 2 — the first prod --execute', () => {
  const UNDEFINED_TX_HASH = 'Cannot use "undefined" as a Firestore value (found in field "tx_hash")';

  test('RED: --execute from a client that rejects `undefined` (the bare CLI client) is refused before any write', async () => {
    const f = await atlasFixture();
    f.fake.settings({ ignoreUndefinedProperties: false }); // the SDK default the CLI ran with
    const deps = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const before = new Map(f.fake.store);
    await expect(backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 }))
      .rejects.toThrow('inbound_backfill:firestore_write_parity_refused:ignoreUndefinedProperties_not_set');
    expect(writtenSince(f.fake, before)).toEqual([]);
    // The dry run says so, and writes nothing.
    const dry = await backfill({ deps, walletId: f.walletId, execute: false, blockChunk: 50, segmentBlocks: 500 });
    expect(dry.firestore_write_parity_refusal).toContain('Cannot use "undefined" as a Firestore value');
    expect(writtenSince(f.fake, before)).toEqual([]);
  });

  test('the prod partial state (PE sealed, no pe_history, claim pending) is completed by a rerun from the relay\'s client', async () => {
    const f = await atlasFixture();
    // The accrual's pe_history seal through the REAL writer (`pe-history.ts`,
    // `tx_hash: params.tx_hash || undefined`), exactly as recordPEAccrual calls it.
    const realHistoryAccrual: AgentBankDeps['recordPEAccrual'] = async (p) => {
      await writePEHistory({
        peId: p.peId,
        userId: p.userId,
        timestamp: p.timestamp,
        actionType: p.actionType,
        category: 'agent',
        attestationDepth: p.attestationDepth,
        estimatedPVT: 0,
        peHash: p.peHash,
        // recordPEAccrual forwards `params.tx_hash`, which generatePE never sets.
        tx_hash: undefined,
        jurisdiction_context: 'US',
        mint_disposition: 'record_only',
        disposition_reason_code: 'policy_record_only',
        policy_review_state: 'not_required',
        policy_review_reason_code: 'known_policy_entry',
        economic_policy_version: 'd487d-round2-test/v1',
        economic_snapshot: null,
      }, f.fake as unknown as Firestore);
    };
    const deps = f.double.overlay(buildBaseInboundDeps({
      ...agentBankDeps(f.fake),
      recordPEAccrual: realHistoryAccrual,
    }), 1_100);
    const clip = { fromBlock: 501, toBlock: 1_000 }; // the current window only, as the prod run clipped
    // 1. Reproduce the prod run exactly: a bare client and the pre-round-2 code (no probe).
    f.fake.settings({ ignoreUndefinedProperties: false });
    const first = await backfill({
      deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500, ...clip,
      firestoreParityProbe: () => null,
    });
    const failed = first.transfers.find((t) => t.tx_hash === f.missedCurrent.txHash);
    expect(failed).toMatchObject({ outcome: 'emit_failed', pe_id: null });
    expect(failed?.error).toContain(UNDEFINED_TX_HASH);
    // What that left behind: the claim pending, the PE sealed on the chain (its act staged for
    // pricing — the relay keeps no readable PE), NO pe_history row.
    const peId = [...receiveActs(f.fake).entries()]
      .filter(([id, act]) => id.startsWith('pe_inbound_') && act.actorAddress === SIGNER_ONE.address)
      .map(([id]) => id)[0];
    expect(peId).toBeDefined();
    const sealed = { hash: receiveActs(f.fake).get(peId)!.peHash };
    expect(f.fake.store.has(`pe_history/${peId}`)).toBe(false);
    expect(f.fake.store.get(seenKey(f.missedCurrent))).toMatchObject({ state: 'pending_reverification' });
    const receivesAfterFailure = peCount(f.fake);

    // 2. Rerun from the relay's client: the pending claim is leased and completed.
    f.fake.settings({ ignoreUndefinedProperties: true });
    const rerun = await backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500, ...clip });
    expect(rerun.transfers.find((t) => t.tx_hash === f.missedCurrent.txHash))
      .toMatchObject({ outcome: 'recovered', pe_id: peId, error: null });
    expect(f.fake.store.get(seenKey(f.missedCurrent))).toMatchObject({ state: 'complete', pe_id: peId });
    expect(f.fake.store.get(`pe_history/${peId}`)).toMatchObject({ peId, actionType: 'receive' });
    // The sealed PE is reused, never re-sealed: same hash, no second receive PE.
    expect(receiveActs(f.fake).get(peId)?.peHash).toBe(sealed.hash);
    expect(peCount(f.fake)).toBe(receivesAfterFailure);
  });

  test('RED: an ethers `Log` from a mis-mapped provider fails the run by name before any claim', async () => {
    const f = await atlasFixture();
    const base = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    const ethersLog = new Log({
      transactionHash: `0x${'45'.repeat(32)}`,
      blockHash: `0x${'ab'.repeat(32)}`,
      blockNumber: 700,
      removed: false,
      address: `0x${'83'.repeat(20)}`,
      data: '0x' + (50_000n).toString(16).padStart(64, '0'),
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        `0x${'00'.repeat(12)}${SENDER.slice(2)}`,
        `0x${'00'.repeat(12)}${SIGNER_ONE.address.slice(2)}`,
      ],
      index: 423,
      transactionIndex: 5,
    }, null as never);
    const deps: InboundUsdcScanDeps = {
      ...base,
      getLogs: async (args) => (args.fromBlock <= 700 && 700 <= args.toBlock
        ? [ethersLog as unknown as InboundTransferLog]
        : []),
    };
    const before = new Map(f.fake.store);
    await expect(backfill({ deps, walletId: f.walletId, execute: true, blockChunk: 50, segmentBlocks: 500 }))
      .rejects.toThrow('inbound_backfill:malformed_provider_log:txHash');
    await expect(backfill({ deps, walletId: f.walletId, execute: false, blockChunk: 50, segmentBlocks: 500 }))
      .rejects.toThrow('inbound_backfill:malformed_provider_log:txHash');
    // Only the retired window's labelled historical admission (written at the
    // start of its window, before any log) — never a claim, signal or PE.
    expect(writtenSince(f.fake, before)
      .filter((key) => !key.startsWith(`${INBOUND_HISTORICAL_ADMISSION_COLLECTION}/`))).toEqual([]);
    // Control: the relay's own mapping of the same canonical log is well-formed.
    expect(() => assertInboundLogShape(f.missedCurrent)).not.toThrow();
  });

  test('RED: a provider range refusal (HTTP 413 over 2,000 blocks) is split and retried, never skipped', async () => {
    const f = await atlasFixture();
    const base = f.double.overlay(buildBaseInboundDeps(agentBankDeps(f.fake)), 1_100);
    let calls = 0;
    const capped: InboundUsdcScanDeps = {
      ...base,
      getLogs: async (args) => {
        calls += 1;
        if (args.toBlock - args.fromBlock + 1 > 100) {
          throw new Error('server response 413 Payload Too Large (request={ }, response={ })');
        }
        return base.getLogs(args);
      },
    };
    const report = await backfill({ deps: capped, walletId: f.walletId, execute: false, blockChunk: 500, segmentBlocks: 500 });
    const byTx = new Map(report.transfers.map((t) => [t.tx_hash, t.outcome]));
    expect(byTx.get(f.missedBirth.txHash)).toBe('would_witness');
    expect(byTx.get(f.missedCurrent.txHash)).toBe('would_witness');
    expect(byTx.get(f.stranded.txHash)).toBe('would_recover');
    expect(calls).toBeGreaterThan(2);

    // Anything else propagates unchanged — a rate limit is never split into a storm.
    let limited = 0;
    const rateLimited: InboundUsdcScanDeps = {
      ...base,
      getLogs: async () => {
        limited += 1;
        throw new Error('server response 429 Too Many Requests');
      },
    };
    await expect(backfill({ deps: rateLimited, walletId: f.walletId, execute: false, blockChunk: 500, segmentBlocks: 500 }))
      .rejects.toThrow('429');
    expect(limited).toBe(1);
  });

  test('the range splitter returns the union of both halves, in order', async () => {
    const seen: Array<[number, number]> = [];
    const split = withRangeSplitting(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 3) throw new Error('eth_getLogs block range is too wide');
      seen.push([fromBlock, toBlock]);
      return [];
    });
    await split({ fromBlock: 1, toBlock: 10, toAddresses: [SENDER] });
    expect(seen.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)))
      .toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(LOG_RANGE_REFUSAL.test('Too Many Requests')).toBe(false);
  });
});
