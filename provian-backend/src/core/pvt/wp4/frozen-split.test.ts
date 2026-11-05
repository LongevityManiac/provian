/**
 * A PE's payout legs are determined ONCE and always sum to exactly 100%.
 *
 * Every scenario here runs the REAL standard source (`createFirestoreInletSource`) through the
 * REAL inlet (`runClaimInlet`) and, where the flip matters, the REAL writeback
 * (`writeLedgerSettlement`) — the three places the defect lived. Each ships with its RED
 * control: the old per-leg, re-resolving inlet fails the same assertion (recorded in the
 * commit), and every scenario first proves its live-state change is REAL (the resolution
 * really moved) so a green cannot come from a change that changed nothing.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { canonicalAgentBeneficiaryShareBps } from '../../agent-wallet/beneficiary-relationship';
import { hashBeneficiaryRoutingSnapshot, type BeneficiaryRoutingSnapshot } from '../beneficiary-routing';
import {
  ATTESTATION_HORIZON_CUT_LINE_MS,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from '../policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../policy/runtime-monetary-policy';
import { corroborationLiftedRecordPointsAtomic } from '../policy/economic-projection';
import { deriveLegClaimId, deriveTopupClaimId, type SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import { PAYOUT_LEG_ROLES, type PayoutLegRole } from '../wp-ev/payout-legs';
import { runClaimInlet, type ClaimInletDeps, type ClaimInletReport } from './claim-inlet';
import {
  AGENT_WALLETS_COLLECTION,
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  WALLETS_COLLECTION,
  createFirestoreInletSource,
  resolvePayee,
} from './claim-inlet-source';
import { createAttestationTopupInletSource, topupSweepFloorMs } from './attestation-topup-inlet-source';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../../agent-recovery-escrow';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../native-wallet-registration';
import {
  CLAIM_LEDGER_COLLECTION,
  acquireCycleLease,
  applyConfirmedBatch,
  claimKeyOf,
  recordAttempt,
  recordMinedReceipt,
  registerClaim,
  reserveBatch,
  writeLedgerSettlement,
  type SettlementDb,
} from './durable-settlement-store';
import { PE_SPLIT_COLLECTION, parseFrozenSplit } from './pe-split';

type Db = SettlementDb & { store: Map<string, Record<string, unknown>> };

const ADDR_HUMAN = '0x00000000000000000000000000000000000000a1';
const ADDR_HUMAN_NEW = '0x00000000000000000000000000000000000000a9';
const ADDR_AGENT = '0x00000000000000000000000000000000000000a2';
const ADDR_AGENT_NEW = '0x00000000000000000000000000000000000000a8';
const OTHER_AGENT_ADDR = '0x1111111111111111111111111111111111111111';
const RECORDED = ATTESTATION_HORIZON_CUT_LINE_MS + 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const INLET = { pageSize: 50, maxPesPerRun: 1_000, maxRunMs: 60_000 };

const PUBLIC_APPROVAL_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAf9JCgexoRd6ZMoF1oJOIS25hmoqPriUTxlz3rVZ6e';
const PUBLIC_APPROVAL_KEY_SHA256 = 'sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974';
const savedEnv = {
  key: process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY,
  sha: process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
};
beforeAll(() => {
  process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY ??= PUBLIC_APPROVAL_KEY;
  process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 ??= PUBLIC_APPROVAL_KEY_SHA256;
});
afterAll(() => {
  if (savedEnv.key === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  else process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = savedEnv.key;
  if (savedEnv.sha === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  else process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = savedEnv.sha;
});

function db(options?: Parameters<typeof createFakeFirestore>[0]): Db {
  return createFakeFirestore(options) as unknown as Db;
}

function identity(peId: string, actor: string): SealedEnvelopeIdentity {
  return {
    id: peId, prev_hash: GENESIS_PREV_HASH, hash: `0x${'11'.repeat(31)}${peId.length.toString(16).padStart(2, '0')}`,
    timestamp: RECORDED, action_type: 'compute_session', user_id: actor,
  };
}

/** A `compute_session` sealed at the software tier (the fixture shape), for any actor. */
function sealed(peId: string, actor: string, overrides: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId,
    economicActorId: actor,
    actionType: 'compute_session',
    recordedAtMs: RECORDED,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: `compute_session:${peId}`,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: `lineage-${peId}`,
    genesisReservation: null,
  });
  return {
    peId,
    userId: actor,
    actionType: 'compute_session',
    timestamp: RECORDED,
    attestationDepth: 'software',
    attestation_verified: true,
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    record_points_atomic: snapshot.recordPointsAtomic,
    replication_pack: null,
    corroboration_status: 'none',
    corroboration_received_at: null,
    economic_snapshot: snapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    ...overrides,
  } as Partial<PEHistoryDocument>;
}

/** A linked-agent PE: sealed for the AGENT, with a verified 20% routing snapshot to its human. */
function linkedSealed(peId: string, overrides: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  const snapshot = {
    schema_version: 'beneficiary-routing/v1',
    pe_id: peId,
    economic_actor_id: 'agent-1',
    recorded_at_ms: RECORDED,
    human_wallet_id: 'w-user-1',
    human_user_id: 'user-1',
    human_address: ADDR_HUMAN,
    agent_share_bps: canonicalAgentBeneficiaryShareBps({ bps: 2000 })!,
  } as unknown as BeneficiaryRoutingSnapshot;
  return sealed(peId, 'agent-1', {
    beneficiary_routing_snapshot: snapshot,
    beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(snapshot),
    ...overrides,
  });
}

async function seedPe(database: Db, peId: string, actor: string, history: Partial<PEHistoryDocument>): Promise<void> {
  await database.collection(PE_HISTORY_COLLECTION).doc(peId).set(history as never);
  const id = identity(peId, actor);
  await database.collection(ENVELOPES_COLLECTION).doc(peId).set({
    ...id, counterparty_address: null, counterparty_type: null,
  });
}

async function seedLinkedWallets(database: Db): Promise<void> {
  await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ user_id: 'user-1', type: 'human', address: ADDR_HUMAN });
  await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_agent-1').set({
    id: 'wallet_aw_agent-1', agent_id: 'agent-1', address: ADDR_AGENT, status: 'active',
  });
}

function runInlet(database: SettlementDb, extra: Partial<ClaimInletDeps> = {}, nowMs = RECORDED + HOUR): Promise<ClaimInletReport> {
  return runClaimInlet({
    db: database,
    source: createFirestoreInletSource({ db: database, now: () => nowMs }),
    now: () => nowMs,
    ...extra,
  }, INLET);
}

function actRows(database: Db, peId: string): Record<string, unknown>[] {
  return [...database.store.entries()]
    .filter(([key, row]) => key.startsWith(`${CLAIM_LEDGER_COLLECTION}/`) && row.pe_id === peId
      && row.claim_kind !== 'attestation_topup')
    .map(([, row]) => row);
}

function actSum(database: Db, peId: string): bigint {
  return actRows(database, peId).reduce((sum, row) => sum + BigInt(row.record_points_atomic as string), 0n);
}

function splitOf(database: Db, peId: string) {
  return database.store.get(`${PE_SPLIT_COLLECTION}/${peId}`);
}

const createdAt = () => Date.UTC(2026, 9, 26);

async function agentStore(_status: 'active' | 'suspended'): Promise<Db> {
  const database = db();
  await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_other').set({
    agent_id: 'other-agent', address: OTHER_AGENT_ADDR, status: 'active', created_at: createdAt(),
  });
  return database;
}
async function activeAgentStore(): Promise<Db> { return agentStore('active'); }

// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 2. The WHOLE split freezes at once; recovery escrow never holds a leg
// ---------------------------------------------------------------------------

/**
 * Put an agent address in exactly the state the retired gate deferred: the native address
 * index names an agent wallet, and that wallet has (or has no) recovery escrow. Recovery escrow
 * never holds earnings, so the inlet must register the agent either way.
 */
async function seedAgentEscrow(database: Db, address: string, walletId: string, escrowed: boolean): Promise<void> {
  await database.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address))
    .set({ owner_type: 'agent', wallet_id: walletId });
  if (escrowed) await database.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId).set({ wallet_id: walletId });
  else database.store.delete(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`);
}

/** The state the retired gate keyed on, read back, so a pass is never over a state that was never set. */
function isUnescrowedAgent(database: Db, address: string, walletId: string): boolean {
  const idx = database.store.get(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(address)}`);
  return idx?.owner_type === 'agent' && idx.wallet_id === walletId
    && !database.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`);
}

/** Every leg of the PE's FROZEN split that has no act row on the ledger. */
function unregisteredFrozenLegs(database: Db, peId: string): PayoutLegRole[] {
  const parsed = parseFrozenSplit(splitOf(database, peId), peId);
  if (parsed.kind !== 'valid') throw new Error(`no valid frozen split for ${peId}`);
  const registered = new Set(actRows(database, peId).map((row) => row.leg));
  return parsed.split.legs.map((leg) => leg.leg).filter((leg) => !registered.has(leg));
}

/**
 * Leave a frozen leg with no act row — the shape a leg-sum correction leaves for the inlet to fill,
 * and the only way a frozen leg is now unregistered after its split froze.
 */
function dropActRow(database: Db, peId: string, leg: PayoutLegRole): void {
  const key = `${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(peId, leg)}`;
  if (!database.store.delete(key)) throw new Error(`no act row ${key} to drop`);
}

describe(' / escrow never holds earnings — the WHOLE split freezes at once and every leg registers', () => {
  it('RED CONTROL (the measure): a frozen leg with no act row IS reported unregistered', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-red', 'agent-1', linkedSealed('pe-red'));
    await runInlet(database);
    expect(unregisteredFrozenLegs(database, 'pe-red')).toEqual([]);
    dropActRow(database, 'pe-red', 'agent');
    expect(unregisteredFrozenLegs(database, 'pe-red')).toEqual(['agent']);
  });

  it('a LINKED, un-escrowed agent: the agent\'s 20% AND the human\'s 80% register on the first run', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedAgentEscrow(database, ADDR_AGENT, 'wallet_aw_agent-1', false);
    expect(isUnescrowedAgent(database, ADDR_AGENT, 'wallet_aw_agent-1')).toBe(true); // the retired gate's defer state
    await seedPe(database, 'pe-link', 'agent-1', linkedSealed('pe-link'));
    const total = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-link`)!.record_points_atomic as string);

    const first = await runInlet(database);
    expect(first.examined).toBe(2); // both legs were offered and judged — not an empty population
    // RED with the gate re-inserted: registered 1, skip agent_recovery_escrow_missing on leg:agent.
    expect(first.registered).toBe(2);
    expect(first.skips).toEqual([]);
    expect(actRows(database, 'pe-link').map((row) => [row.leg, row.contributor]).sort()).toEqual([
      ['agent', ADDR_AGENT], ['beneficiary', ADDR_HUMAN],
    ]);
    expect(unregisteredFrozenLegs(database, 'pe-link')).toEqual([]);
    expect(actSum(database, 'pe-link')).toBe(total);
    const parsed = parseFrozenSplit(splitOf(database, 'pe-link'), 'pe-link');
    expect(parsed.kind === 'valid' && parsed.split.legs.map((leg) => [leg.leg, leg.bps])).toEqual([['agent', 2000], ['beneficiary', 8000]]);
  });

  it('an UNLINKED, un-escrowed agent: its sole leg registers', async () => {
    const database = db();
    await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_solo').set({
      id: 'wallet_aw_solo', agent_id: 'solo-agent', address: ADDR_AGENT, status: 'active',
    });
    await seedAgentEscrow(database, ADDR_AGENT, 'wallet_aw_solo', false);
    expect(isUnescrowedAgent(database, ADDR_AGENT, 'wallet_aw_solo')).toBe(true);
    await seedPe(database, 'pe-solo', 'solo-agent', sealed('pe-solo', 'solo-agent'));
    const total = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-solo`)!.record_points_atomic as string);

    const first = await runInlet(database);
    expect(first.examined).toBe(1);
    // RED with the gate re-inserted: registered 0, nothing frozen.
    expect(first.registered).toBe(1);
    expect(actRows(database, 'pe-solo').map((row) => [row.leg, row.contributor])).toEqual([['sole', ADDR_AGENT]]);
    expect(actSum(database, 'pe-solo')).toBe(total);
  });

  it('a frozen leg left with no row registers later at its FROZEN values, even after the live address moved', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-late', 'agent-1', linkedSealed('pe-late'));
    const total = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-late`)!.record_points_atomic as string);
    await runInlet(database);
    const parsed = parseFrozenSplit(splitOf(database, 'pe-late'), 'pe-late');
    const frozenAgent = parsed.kind === 'valid' ? parsed.split.legs.find((leg) => leg.leg === 'agent')! : null;
    dropActRow(database, 'pe-late', 'agent');

    // Live state moves while the leg waits: the agent's address rotates.
    await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_agent-1').set({ address: ADDR_AGENT_NEW }, { merge: true });
    const again = await runInlet(database, {}, RECORDED + 2 * HOUR);
    expect(again.registered).toBe(1);
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-late', 'agent')}`)).toMatchObject({
      contributor: frozenAgent!.contributor, // ADDR_AGENT, frozen — not the rotated live address
      record_points_atomic: frozenAgent!.record_points_atomic,
      claim_id: frozenAgent!.claim_id,
    });
    expect(actSum(database, 'pe-late')).toBe(total);
  });

  it('a PE none of whose legs can register is NOT frozen (resolved afresh when one can)', async () => {
    const database = await activeAgentStore();
    await seedPe(database, 'pe-unsealed', 'other-agent', sealed('pe-unsealed', 'other-agent'));
    // No sealed envelope: no derivable identity, so every leg fails the inlet's own checks alike.
    database.store.delete(`${ENVELOPES_COLLECTION}/pe-unsealed`);
    const first = await runInlet(database);
    expect(first.examined).toBe(1);
    expect(first.registered).toBe(0);
    expect(first.skips.length).toBeGreaterThan(0);
    expect(splitOf(database, 'pe-unsealed')).toBeUndefined();
    expect(actRows(database, 'pe-unsealed')).toHaveLength(0);
  });

  it('a crash between two legs\' writes leaves NO partial set (one transaction), and the rerun registers both', async () => {
    // Fail the SECOND ledger create inside a transaction: the old inlet had committed the first
    // leg in its own transaction by then, leaving a partial set.
    const database = db({ failTxnWriteOccurrence: { collection: CLAIM_LEDGER_COLLECTION, occurrence: 2 } });
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-crash', 'agent-1', linkedSealed('pe-crash'));
    const total = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-crash`)!.record_points_atomic as string);

    await expect(runInlet(database)).rejects.toThrow();
    // RED on the pre- inlet: one row (the first leg) survived the crash.
    expect(actRows(database, 'pe-crash')).toHaveLength(0);
    expect(splitOf(database, 'pe-crash')).toBeUndefined();

    const rerun = await runInlet(database, {}, RECORDED + 2 * HOUR);
    expect(rerun.registered).toBe(2);
    expect(actSum(database, 'pe-crash')).toBe(total);
  });

  it('a corroboration landing while a frozen leg waits cannot produce a MIXED set: the late leg keeps its frozen share', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-mix', 'agent-1', linkedSealed('pe-mix'));
    const base = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-mix`)!.record_points_atomic as string);

    await runInlet(database);
    dropActRow(database, 'pe-mix', 'agent');
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-mix').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 2 * DAY },
      { merge: true },
    );
    const lifted = BigInt(corroborationLiftedRecordPointsAtomic(
      database.store.get(`${PE_HISTORY_COLLECTION}/pe-mix`) as unknown as PEHistoryDocument,
    ));
    expect(lifted).toBeGreaterThan(base); // the total really moved between the two runs

    await runInlet(database, {}, RECORDED + 3 * DAY);
    // RED on the pre- inlet: beneficiary at 80% of BASE + agent at 20% of LIFTED — a
    // sum that is neither total. Now every leg is cut from the one frozen total; the lift is
    // the top-up lane's to pay.
    expect(actRows(database, 'pe-mix')).toHaveLength(2);
    expect(actSum(database, 'pe-mix')).toBe(base);
    expect(splitOf(database, 'pe-mix')).toMatchObject({ total_points_atomic: base.toString() });
  });
});

// ---------------------------------------------------------------------------
// 3. The PE-level flip requires every FROZEN leg settled
// ---------------------------------------------------------------------------

async function settleOnly(database: Db, peId: string, leg: PayoutLegRole, claimId: string, tag: number): Promise<void> {
  const cycleId = `cycle-${tag}`;
  const acquired = await acquireCycleLease(database, {
    cycleId, workerId: 'w', nowMs: RECORDED, leaseTtlMs: 60_000, epoch: 0, policyHash: H(0xfeed),
    signer: ADDR_AGENT, baseNonce: 7, limits: { max_transactions: 10, max_fee_wei_total: '100000000000000000' },
    cursorStart: 0n,
  });
  if (acquired.kind !== 'acquired') throw new Error('lease');
  const batchId = H(0x7000 + tag);
  const reserved = await reserveBatch(database, {
    cycleId, workerId: 'w', nowMs: RECORDED + 1, batchId, lane: 'standard', epoch: 0, policyHash: H(0xfeed),
    cursorStart: 0n, cursorEnd: 1n, recipientCount: 1, claimCount: 1, totalMintedAtomic: 1n, calldata: '0xdead',
    members: [{ leg, pe_id: peId, claim_id: claimId }],
  });
  if (reserved.kind !== 'reserved') throw new Error(`reserve: ${JSON.stringify(reserved)}`);
  await recordAttempt(database, {
    cycleId, workerId: 'w', nowMs: RECORDED + 2, batchId,
    attempt: {
      nonce: reserved.nonce, tx_hash: H(0xa000 + tag), kind: 'original',
      max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '1', gas_limit: '1000000',
    },
  });
  await recordMinedReceipt(database, {
    batchId, txHash: H(0xa000 + tag), nowMs: RECORDED + 3,
    status: 'success', blockNumber: 11, gasUsed: 400_000n, effectiveGasPriceWei: 3n,
  });
  await applyConfirmedBatch(database, { cycleId, batchId, txHash: H(0xa000 + tag), nowMs: RECORDED + 4 });
}

describe('minted only when every FROZEN leg has settled', () => {
  it('a frozen two-leg split with the agent leg not yet registered: the beneficiary settling does NOT flip the PE', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-flip', 'agent-1', linkedSealed('pe-flip'));
    await runInlet(database); // freezes the split and registers both legs
    const agentRow = database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-flip', 'agent')}`)!;
    const benRow = database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-flip', 'beneficiary')}`)!;
    // The agent leg is frozen but absent from the ledger (the shape a leg-sum correction leaves
    // for the inlet to fill): every EXISTING row settles — and that is not every frozen leg.
    database.store.delete(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-flip', 'agent')}`);

    await settleOnly(database, 'pe-flip', 'beneficiary', benRow.claim_id as string, 1);
    const writeback = await writeLedgerSettlement(database, { batchId: H(0x7001), nowMs: RECORDED + 5 });
    // RED on the pre- writeback: minted 1 — the PE flipped with the agent's 20% unpaid,
    // and the inlet (selecting `eligible` only) would never have offered that leg again.
    expect(writeback.peHistory).toMatchObject({ minted: 0, deferred_partial: 1 });
    expect(database.store.get(`${PE_HISTORY_COLLECTION}/pe-flip`)).toMatchObject({ mint_status: 'eligible' });

    // The inlet re-offers the missing FROZEN leg, it registers and settles, and only then the flip.
    const rerun = await runInlet(database, {}, RECORDED + 2 * HOUR);
    expect(rerun.registered).toBe(1);
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-flip', 'agent')}`))
      .toMatchObject({ contributor: agentRow.contributor, record_points_atomic: agentRow.record_points_atomic });
    await settleOnly(database, 'pe-flip', 'agent', agentRow.claim_id as string, 2);
    const final = await writeLedgerSettlement(database, { batchId: H(0x7002), nowMs: RECORDED + 6 });
    expect(final.peHistory).toMatchObject({ minted: 1, deferred_partial: 0 });
    expect(database.store.get(`${PE_HISTORY_COLLECTION}/pe-flip`)).toMatchObject({ mint_status: 'minted' });
  });

  it('LEGACY (no split doc): a pre-freeze linked PE whose only row is the settled beneficiary leg is NOT flipped', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-old', 'agent-1', linkedSealed('pe-old'));
    const total = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-old`)!.record_points_atomic as string);
    const agentShare = (total * 2000n) / 10_000n;
    const benClaim = (deriveLegClaimId(identity('pe-old', 'agent-1'), 'beneficiary') as { claimId: string }).claimId;
    // The pre- shape: one leg registered in its own transaction, the other deferred.
    await registerClaim(database, {
      pe_id: 'pe-old', leg: 'beneficiary', claim_id: benClaim, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 1, record_points_atomic: (total - agentShare).toString(),
    }, RECORDED);
    await settleOnly(database, 'pe-old', 'beneficiary', benClaim, 3);
    const writeback = await writeLedgerSettlement(database, { batchId: H(0x7003), nowMs: RECORDED + 5 });
    // RED on the pre- writeback: every existing row settled ⇒ minted, 20% never paid.
    expect(writeback.peHistory).toMatchObject({ minted: 0, deferred_partial: 1 });
    expect(database.store.get(`${PE_HISTORY_COLLECTION}/pe-old`)).toMatchObject({ mint_status: 'eligible' });
    // …and the inlet does not re-resolve and add the missing leg to a set nobody froze.
    const rerun = await runInlet(database, {}, RECORDED + 2 * HOUR);
    expect(rerun.registered).toBe(0);
    expect(actRows(database, 'pe-old')).toHaveLength(1);
  });

  it('GREEN CONTROL (legacy): a complete pre-freeze set whose rows sum to the total IS flipped', async () => {
    const database = db();
    await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ user_id: 'user-1', type: 'human', address: ADDR_HUMAN });
    await seedPe(database, 'pe-whole', 'user-1', sealed('pe-whole', 'user-1'));
    const total = database.store.get(`${PE_HISTORY_COLLECTION}/pe-whole`)!.record_points_atomic as string;
    const soleClaim = (deriveLegClaimId(identity('pe-whole', 'user-1'), 'sole') as { claimId: string }).claimId;
    await registerClaim(database, {
      pe_id: 'pe-whole', leg: 'sole', claim_id: soleClaim, lane: 'standard',
      contributor: ADDR_HUMAN, beneficiary_class: 1, record_points_atomic: total,
    }, RECORDED);
    await settleOnly(database, 'pe-whole', 'sole', soleClaim, 4);
    const writeback = await writeLedgerSettlement(database, { batchId: H(0x7004), nowMs: RECORDED + 5 });
    expect(writeback.peHistory).toMatchObject({ minted: 1, deferred_partial: 0 });
  });
});

// ---------------------------------------------------------------------------
// 4. Live state after the freeze changes nothing
// ---------------------------------------------------------------------------

describe('once frozen, the split never moves', () => {
  it('a fully registered frozen PE is never re-resolved: wallet reads would throw, and the run is clean', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-frozen', 'agent-1', linkedSealed('pe-frozen'));
    await runInlet(database);
    const before = actRows(database, 'pe-frozen').map((row) => ({ ...row }));

    // Live state moves: the human's address changes and the agent is suspended.
    await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ address: ADDR_HUMAN_NEW }, { merge: true });
    await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_agent-1').set({ status: 'suspended' }, { merge: true });
    const history = database.store.get(`${PE_HISTORY_COLLECTION}/pe-frozen`)!;
    const live = await resolvePayee(database, history, history.record_points_atomic as string, 'pe-frozen');
    expect(live).toEqual({ kind: 'refused', reason: 'payee_wallet_unusable' }); // the change is real

    const guarded = {
      ...database,
      collection: (name: string) => {
        if (name === AGENT_WALLETS_COLLECTION || name === WALLETS_COLLECTION) throw new Error(`payee re-resolved via ${name}`);
        return database.collection(name);
      },
    } as unknown as SettlementDb;
    const rerun = await runInlet(guarded, {}, RECORDED + 2 * HOUR);
    expect(rerun.registered).toBe(0);
    expect(rerun.skipped).toBe(0);
    expect(actRows(database, 'pe-frozen')).toEqual(before);
  });

  it('a frozen leg re-offered after a live change registers at its FROZEN payee and points, not the live ones', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-refill', 'agent-1', linkedSealed('pe-refill'));
    await runInlet(database);
    const frozenBen = { ...database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-refill', 'beneficiary')}`)! };
    database.store.delete(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-refill', 'beneficiary')}`);

    await database.collection(WALLETS_COLLECTION).doc('w-user-1').set({ address: ADDR_HUMAN_NEW }, { merge: true });
    await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_agent-1').set({ address: ADDR_AGENT_NEW }, { merge: true });

    const rerun = await runInlet(database, {}, RECORDED + 2 * HOUR);
    expect(rerun.registered).toBe(1);
    const refilled = database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-refill', 'beneficiary')}`)!;
    expect(refilled.contributor).toBe(ADDR_HUMAN); // frozen, not ADDR_HUMAN_NEW
    expect(refilled.record_points_atomic).toBe(frozenBen.record_points_atomic);
    expect(refilled.claim_id).toBe(frozenBen.claim_id);
  });

  it('a corroboration AFTER the freeze leaves the act legs untouched; the top-up lane pays the delta over the FROZEN legs', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-lift', 'agent-1', linkedSealed('pe-lift'));
    const base = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-lift`)!.record_points_atomic as string);
    await runInlet(database);
    const frozen = { ...splitOf(database, 'pe-lift')! };

    await database.collection(PE_HISTORY_COLLECTION).doc('pe-lift').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 2 * DAY },
      { merge: true },
    );
    const lifted = BigInt(corroborationLiftedRecordPointsAtomic(
      database.store.get(`${PE_HISTORY_COLLECTION}/pe-lift`) as unknown as PEHistoryDocument,
    ));
    expect(lifted).toBeGreaterThan(base);

    const rerun = await runInlet(database, {}, RECORDED + 3 * DAY);
    expect(rerun.registered).toBe(0);
    expect(actSum(database, 'pe-lift')).toBe(base);
    expect(splitOf(database, 'pe-lift')).toEqual(frozen);

    const topup = await runClaimInlet({
      db: database,
      source: createAttestationTopupInletSource({ db: database, now: () => RECORDED + 3 * DAY }),
      now: () => RECORDED + 3 * DAY,
    }, INLET);
    expect(topup.registered).toBe(2);
    const topupSum = [...database.store.entries()]
      .filter(([key, row]) => key.startsWith(`${CLAIM_LEDGER_COLLECTION}/`) && row.pe_id === 'pe-lift'
        && row.claim_kind === 'attestation_topup')
      .reduce((sum, [, row]) => sum + BigInt(row.record_points_atomic as string), 0n);
    expect(base + topupSum).toBe(lifted);
  });

  it('RED CONTROL (top-up): a row that disagrees with the frozen split is never topped up', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-bent', 'agent-1', linkedSealed('pe-bent'));
    await runInlet(database);
    // Bend one act row away from its frozen leg.
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-bent', 'agent'))
      .set({ contributor: ADDR_AGENT_NEW }, { merge: true });
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-bent').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 2 * DAY },
      { merge: true },
    );
    const topup = await runClaimInlet({
      db: database,
      source: createAttestationTopupInletSource({ db: database, now: () => RECORDED + 3 * DAY }),
      now: () => RECORDED + 3 * DAY,
    }, INLET);
    // Per leg (round 2): the bent agent row is never paid a delta; its intact sibling is.
    expect(topup.registered).toBe(1);
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-bent', 'agent', 'attestation_topup')}`)).toBeUndefined();
    expect(database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-bent', 'beneficiary', 'attestation_topup')}`)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Round 2 — a held leg never withholds its siblings' lift, and gets its own when it lands late
// ---------------------------------------------------------------------------

describe(' round 2 — the corroboration lift across a held leg', () => {
  function topupRows(database: Db, peId: string): Record<string, unknown>[] {
    return [...database.store.entries()]
      .filter(([key, row]) => key.startsWith(`${CLAIM_LEDGER_COLLECTION}/`) && row.pe_id === peId
        && row.claim_kind === 'attestation_topup')
      .map(([, row]) => row);
  }
  function runTopup(database: Db, nowMs: number): Promise<ClaimInletReport> {
    return runClaimInlet({
      db: database,
      source: createAttestationTopupInletSource({ db: database, now: () => nowMs }),
      now: () => nowMs,
    }, INLET);
  }

  it('held agent leg + lift: the beneficiary\'s top-up registers NOW; the agent leg, re-offered after the sweep window, gets its act AND its top-up together — total == lifted exactly', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-held', 'agent-1', linkedSealed('pe-held'));
    const base = BigInt(database.store.get(`${PE_HISTORY_COLLECTION}/pe-held`)!.record_points_atomic as string);

    await runInlet(database); // both legs register at the base split
    dropActRow(database, 'pe-held', 'agent'); // the agent leg is frozen with no row
    expect(actRows(database, 'pe-held').map((row) => row.leg)).toEqual(['beneficiary']);
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-held').set(
      { corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + 2 * DAY },
      { merge: true },
    );
    const lifted = BigInt(corroborationLiftedRecordPointsAtomic(
      database.store.get(`${PE_HISTORY_COLLECTION}/pe-held`) as unknown as PEHistoryDocument,
    ));
    expect(lifted).toBeGreaterThan(base);

    // (a) RED on 2d83faae: the missing agent row made the whole PE "non-uniform" — examined 0.
    const topup = await runTopup(database, RECORDED + 3 * DAY);
    expect(topup.registered).toBe(1);
    expect(topupRows(database, 'pe-held').map((row) => row.leg)).toEqual(['beneficiary']);

    // Past the sweep floor (two horizons back): the top-up lane will never see this PE again.
    const late = RECORDED + 63 * DAY;
    expect(topupSweepFloorMs(late)).toBeGreaterThan(RECORDED + 2 * DAY);
    expect((await runTopup(database, late)).examined).toBe(0);

    const released = await runInlet(database, {}, late);
    // (b) RED on 2d83faae: registered 1 — the agent's act only, its lift lost for good.
    expect(released.registered).toBe(2);
    expect(topupRows(database, 'pe-held').map((row) => row.leg).sort()).toEqual(['agent', 'beneficiary']);
    const agentTopup = database.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-held', 'agent', 'attestation_topup')}`)!;
    expect(agentTopup).toMatchObject({
      claim_kind: 'attestation_topup', contributor: ADDR_AGENT,
      topup_of_claim_key: claimKeyOf('pe-held', 'agent'),
      claim_id: (deriveTopupClaimId(identity('pe-held', 'agent-1'), 'agent') as { claimId: string }).claimId,
    });
    // THE INVARIANT: every act leg at its frozen share plus every leg's top-up == lifted, exactly.
    expect(actSum(database, 'pe-held')).toBe(base);
    const topupSum = topupRows(database, 'pe-held').reduce((sum, row) => sum + BigInt(row.record_points_atomic as string), 0n);
    expect(base + topupSum).toBe(lifted);

    // One top-up per leg, ever: nothing re-registers on later runs of either lane.
    expect((await runInlet(database, {}, late + DAY)).registered).toBe(0);
    expect((await runTopup(database, RECORDED + 4 * DAY)).registered).toBe(0);
    expect(topupRows(database, 'pe-held')).toHaveLength(2);
  });

  it('GREEN CONTROL: a split frozen at the LIFTED total owes no late top-up', async () => {
    const database = db();
    await seedLinkedWallets(database);
    await seedPe(database, 'pe-post', 'agent-1', linkedSealed('pe-post', {
      corroboration_status: 'peer_verified', corroboration_source: 'peer-9', corroboration_received_at: RECORDED + HOUR,
    } as Partial<PEHistoryDocument>));
    const lifted = BigInt(corroborationLiftedRecordPointsAtomic(
      database.store.get(`${PE_HISTORY_COLLECTION}/pe-post`) as unknown as PEHistoryDocument,
    ));
    await runInlet(database, {}, RECORDED + 2 * HOUR);
    dropActRow(database, 'pe-post', 'agent');
    const released = await runInlet(database, {}, RECORDED + 3 * HOUR);
    expect(released.registered).toBe(1);
    expect(topupRows(database, 'pe-post')).toHaveLength(0);
    expect(actSum(database, 'pe-post')).toBe(lifted);
  });
});

it('RED: a stored split cannot introduce a role outside the three active payees', () => {
  expect(PAYOUT_LEG_ROLES).toEqual(['sole', 'agent', 'beneficiary']);
  const split = {
    schema_version: 'pvt9-pe-split/v1', pe_key: 'pe-closed-roles', lane: 'standard', resolved_at_ms: 1,
    total_points_atomic: '100', legs: [{leg: 'fourth_payee',bps:10000,record_points_atomic:'100',contributor:OTHER_AGENT_ADDR,beneficiary_class:2,claim_id:'0x'+'1'.repeat(64)}],
  };
  expect(parseFrozenSplit(split,'pe-closed-roles')).toEqual({kind:'invalid',reason:'invalid_leg_role'});
  expect(parseFrozenSplit({...split,legs:[{...split.legs[0],leg:'sole'}]},'pe-closed-roles').kind).toBe('valid');
});
