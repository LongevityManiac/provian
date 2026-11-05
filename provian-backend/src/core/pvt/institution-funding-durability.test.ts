/**
 * Stage 1b(ii) — the DURABILITY canary for the institution funding watcher.
 *
 * made durability its own part with its own canary, and 's
 * reuse finding does NOT shrink that obligation: the machinery being mostly
 * present is a reason the change is small, never a reason to skip proving it.
 *
 * What this proves, against the REAL `generatePE` and the REAL
 * `recordPEAccrual` over a realistic fake Firestore — no stubbed accrual seam,
 * because the seam is the thing under test:
 *
 * 1. THE MARKER WORKS. With `durableViaOrdinaryIntake` the watcher's row seals
 * `pending_evidence`; without it, `record_only`. Both pay 0 — the point is
 * that the DURABLE INLET condition of 's three is now satisfied.
 * 2. IT DOES NOT PAY YET. The verdict is still absent (1b(iii) has not landed),
 * so the row must NOT be `eligible`. Asserted, so durability cannot be
 * mistaken for the mint switch.
 * 3. ALL-OR-NOTHING. A failure inside the chain-tip transaction leaves NO PE,
 * NO emission lock, NO intake row and NO tip advance — the old state.
 * 4. CRASH BETWEEN COMMIT AND ACCRUAL IS RECOVERABLE, NOT A SPLIT. The PE,
 * lock and intake row are all present, the intake carries the exact accrual
 * input, and a replay completes it EXACTLY ONCE.
 * 5. THE MARKER IS VERIFIED, NEVER TRUSTED. If the committed intake row does
 * not match the live call, the accrual REFUSES the claim and seals
 * `record_only` so passing the flag cannot manufacture durability.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { FakeFirestore } from './__test-helpers__/fake-firestore';

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
  __esModule: true,
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
jest.mock('./beneficiary', () => ({
  resolveBeneficiary: async () => ({
    linked: false, humanWalletId: null, humanUserId: null,
    humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));
jest.mock('./delegation-pe', () => ({
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from '../../pvt-accrual';
import type { Firestore } from 'firebase-admin/firestore';
import { meterActRows, relayIntakes } from './__test-helpers__/meter-acts';
import {
  METER_RELAY_ACTS_COLLECTION,
  METER_RELAY_ACT_REPLAY_AFTER_MS,
  priceRelayAct,
  replayStuckRelayActs,
} from '../meter/meter-relay-authored';
import { METER_PENDING_CLAIMS_COLLECTION } from '../meter/meter-store';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
} from './wp11/ordinary-accrual-intake';
import {
  INSTITUTION_EMISSION_LOCK_COLLECTION,
  INSTITUTION_CONFIRMATION_FLOOR,
  buildLinkedEvidenceMetadata,
  decodeInstitutionFundingLog,
  finalizedThroughBlock,
  makeTransactionalEmitter,
  INSTITUTION_ADDRESSES,
  type InstitutionFundingEmission,
} from './institution-funding-watcher';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { ethers } from 'ethers';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';

const TX = `0x${'a1'.repeat(32)}`;
const LENDER = '0x1111111111111111111111111111111111111111';
const ENTITY = `0x${'cd'.repeat(32)}`;
const TIMESTAMP = Date.UTC(2026, 7, 3, 12, 0);

const addrTopic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');

function fundingLog(logIndex = 7): CanonicalEconomicLog {
  return {
    address: INSTITUTION_ADDRESSES.promise,
    topics: [
      ethers.id('PromiseFunded(bytes32,address,uint256)'),
      ENTITY,
      addrTopic(LENDER),
    ],
    data: `0x${word(10_000_000n)}`,
    blockNumber: 1_000,
    blockHash: `0x${'ee'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex,
    removed: false,
  } as CanonicalEconomicLog;
}

/**
 *. A witness the STAMP will accept: the head is exactly
 * `blockNumber + 11`, so `finalizedThroughBlock(head)` is the funding's own
 * block and it sits exactly at the 12-confirmation floor.
 */
const WITNESS_HEAD = 1_000 + INSTITUTION_CONFIRMATION_FLOOR - 1;

/**. A counterparty distinct from the actor — an arm's-length funding. */
const BORROWER = '0x2222222222222222222222222222222222222222';

/**. A well-formed L1-batched safe-block hash. */
const SAFE_HASH = `0x${'5e'.repeat(32)}`;

function emissionFor(
  logIndex = 7,
  withWitness = false,
  counterparty: string | null = BORROWER,
): InstitutionFundingEmission {
  const funding = decodeInstitutionFundingLog(fundingLog(logIndex))!;
  return {
    funding,
    actorAddress: LENDER,
    ...(counterparty === null ? {} : { counterpartyAddress: counterparty }),
    walletId: 'w_lender',
    agentId: 'agent_lender',
    ...(withWitness
      ? {
        finalityWitness: {
          head: WITNESS_HEAD,
          finalizedThrough: finalizedThroughBlock(WITNESS_HEAD)!,
          observedBlock: funding.blockNumber,
          //, the reorg floor. Exactly at this funding's block: the
          // boundary is inclusive, and a witness with slack would not notice an
          // off-by-one turning the guard into a no-op.
          safeHead: { number: funding.blockNumber, hash: SAFE_HASH },
        },
      }
      : {}),
  };
}

/** Deps whose accrual is the REAL one. The seam is what is being tested. */
function realDeps(over: Partial<Record<string, unknown>> = {}): AgentBankDeps {
  return {
    db: mockDb,
    cache: {},
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: (p: Record<string, unknown>) => recordPEAccrual(
      { ...p, ...over } as unknown as Parameters<typeof recordPEAccrual>[0],
    ),
  } as unknown as AgentBankDeps;
}

/**
 * PE METER (2026-10-03): the relay keeps no pe_history row. A priced act's sealed row lives on its
 * 31-day act key (`meter_act_keys_v1/{pe_id}.row`) — the same pe_history-shaped row, so every
 * disposition / snapshot assertion below reads it unchanged.
 */
function peHistoryRows(): Array<Record<string, unknown>> {
  return meterActRows(mockDb.store);
}

/** Every pending (not yet minted) claim document, serialized — the money the act owes. */
function pendingClaimsSnapshot(): string {
  return JSON.stringify([...mockDb.store.entries()]
    .filter(([k]) => k.startsWith(`${METER_PENDING_CLAIMS_COLLECTION}/`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function countIn(prefix: string): number {
  let n = 0;
  for (const k of mockDb.store.keys()) if (k.startsWith(prefix)) n += 1;
  return n;
}

/**
 * Emit through the production path with the timestamp pinned, so the sealed
 * disposition is a function of the marker and nothing else.
 */
async function emit(opts: {
  durable: boolean;
  /**. Supply the finality witness the stamp is granted against. */
  witness?: boolean;
  /**. `null` = unresolved; pass the actor's own address for self-dealing. */
  counterparty?: string | null;
  logIndex?: number;
  accrualOver?: Record<string, unknown>;
}): Promise<void> {
  const emission = emissionFor(
    opts.logIndex ?? 7,
    opts.witness === true,
    opts.counterparty === undefined ? BORROWER : opts.counterparty,
  );
  // DRIVE THE PRODUCTION EMITTER. An earlier cut of this helper re-declared
  // generatePE's call site and supplied `durableViaOrdinaryIntake` itself — so
  // it asserted a property of its own construction, and deleting the real flag
  // from the module left the whole battery green. That is the self-referential
  // control the run contract names, and it is why this goes through
  // `makeTransactionalEmitter` instead.
  const generateWithClock: typeof generatePE = ((deps, params) => generatePE(deps, {
    ...params,
    timestampOverride: TIMESTAMP,
    // The ONLY thing the test injects is the clock. Durability, the canonical
    // identity and the (absent) verdict all come from the module.
    ...(opts.durable ? {} : { durableViaOrdinaryIntake: false }),
  })) as typeof generatePE;

  const emitPE = makeTransactionalEmitter(
    mockDb as unknown as Parameters<typeof makeTransactionalEmitter>[0],
    8453,
    generateWithClock,
    realDeps(opts.accrualOver ?? {}) as Parameters<typeof makeTransactionalEmitter>[3],
  );
  await emitPE(emission);
  // generatePE fires the accrual FIRE-AND-FORGET (the production shape for a
  // best-effort caller — which the watcher is, deliberately: `awaitAccrual`
  // would skip the intake co-commit the durable marker depends on). Drain the
  // queue so the assertions read the settled row rather than a race.
  await flushAccrual();
}

/** Let the detached accrual promise chain settle. */
async function flushAccrual(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 *. Seed the registry `detectSameOwnerTransfer` actually reads, so the
 * self-dealing guard is exercised the way PRODUCTION has it.
 *
 * In production the watcher only ever emits for an actor that
 * `resolveWalletByAddress` found in `agent_wallets`, so these records exist. An
 * unseeded fake DB makes the detector resolve nothing and report arm's length,
 * which would have let the self-dealing test pass for the wrong reason.
 *
 * -a: the native-index rows are the FULL canonical 7-key shape every
 * production writer emits (`routes/agent-wallet.ts`, `genesis-ingress.ts`,
 * `key-rotation-transition.ts`). The fence now classifies an index row through
 * the same canonical parser the USDC watchers enumerate with, and a partial
 * row — which production cannot produce — is an UNUSABLE registry answer that
 * holds the PE in `pending_review` rather than resolving arm's length.
 */
function canonicalIndexRow(address: string, walletId: string, agentId: string): Record<string, unknown> {
  return {
    schema_version: 'native-wallet-address-index/v1',
    chain_id: 8453,
    address,
    wallet_id: walletId,
    owner_type: 'agent',
    owner_id: agentId,
    created_at_ms: 1,
  };
}

function seedActorRegistry(): void {
  mockDb.store.set(
    `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId('agent_lender')}`,
    { wallet_id: 'w_lender' },
  );
  mockDb.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(LENDER)}`,
    canonicalIndexRow(LENDER, 'w_lender', 'agent_lender'),
  );
  mockDb.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(BORROWER)}`,
    canonicalIndexRow(BORROWER, 'w_borrower', 'agent_borrower'),
  );
  mockDb.store.set('agent_wallets/w_lender', { linked_human_user_id: 'human_a' });
  mockDb.store.set('agent_wallets/w_borrower', { linked_human_user_id: 'human_b' });
}

beforeEach(() => {
  // The watcher observes a funding shortly after it lands. The fixture's event is dated; the
  // PE meter prices a relay act more than 30 days old as record-only, so the clock rides with it.
  jest.spyOn(Date, 'now').mockReturnValue(TIMESTAMP + 60_000);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seedActorRegistry();
});

afterEach(() => { jest.restoreAllMocks(); });

// =============================================================================
// 1 + 2 — the marker works, and it does NOT pay
// =============================================================================

describe('1b(ii) — the durable marker changes the sealed disposition', () => {
  it('WITHOUT the marker the watcher row seals record_only', async () => {
    await emit({ durable: false });
    const rows = peHistoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].mint_disposition).toBe('record_only');
  });

  it('WITH the marker it seals pending_evidence — the durable inlet is satisfied', async () => {
    await emit({ durable: true });
    const rows = peHistoryRows();
    expect(rows).toHaveLength(1);
    // 's three conditions: durable inlet NOW MET, canonical event id
    // present, verdict still absent. So the row advances record_only ->
    // pending_evidence and stops there.
    expect(rows[0].mint_disposition).toBe('pending_evidence');
  });

  it('AND IT STILL PAYS NOTHING — durability is not the mint switch', async () => {
    await emit({ durable: true });
    const row = peHistoryRows()[0];
    expect(row.mint_disposition).not.toBe('eligible');
    expect(Number(row.estimatedPVT ?? 0)).toBe(0);
  });

  it('SEALS THE OBSERVED CANONICAL EVENT ID even with no verdict ', async () => {
    // The defect the 1b(ii) reviewer leg found: `pe-utils` derived the id from
    // `metadata.verified === true`, and this emitter is verdict-less — so the
    // identity it computed was discarded and the row sealed `canonicalEventId:
    // null`, permanently unbound to its event while its emission lock made
    // re-emission impossible. Nothing asserted the sealed value; now this does.
    await emit({ durable: true });
    const snap = peHistoryRows()[0].economic_snapshot as
      { recordTimeFactors?: { canonicalEventId?: unknown } } | null;
    expect(snap).not.toBeNull();
    expect(snap!.recordTimeFactors!.canonicalEventId)
      .toBe(emissionFor().funding.canonicalEventId);
  });

  it('writes the intake row that IS the durable replay source', async () => {
    await emit({ durable: true });
    // PE METER: the durable replay source is the relay-act intake (`meter_relay_acts_v1`), committed
    // in the chain-tip transaction and consumed by the very meter commit that priced the act. The
    // pre-meter ordinary-accrual intake is no longer written.
    const staged = mockDb.ops.filter((o) => o.startsWith(`txn.set:${METER_RELAY_ACTS_COLLECTION}/`));
    expect(staged).toHaveLength(1);
    expect(mockDb.ops).toContain(staged[0].replace('txn.set:', 'txn.delete:'));
    expect(countIn(`${METER_RELAY_ACTS_COLLECTION}/`)).toBe(0);
    expect(countIn(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/`)).toBe(0);
    expect(peHistoryRows()).toHaveLength(1);
  });
});

// =============================================================================
// 1b(iii) — THE STAMP. This is the mint switch; these run on the REAL accrual.
// =============================================================================

describe('1b(iii) — the stamp is what makes the funding trio pay', () => {
  it('THE MINT SWITCH: durable inlet + earned verdict -> eligible', async () => {
    await emit({ durable: true, witness: true });
    const rows = peHistoryRows();
    expect(rows).toHaveLength(1);
    // 's three conditions, ALL met for the first time: durable inlet
    //, canonical event id, verdict.
    expect(rows[0].mint_disposition).toBe('eligible');
  });

  it('and it PRICES — the row that was worth 0 through all of 1b now is not', async () => {
    await emit({ durable: true, witness: true });
    // Asserted as a number, and asserted to be ABOVE zero rather than merely
    // "defined": every prior part of 1b passed the "pays 0" assertion, so a
    // stamp that changed the disposition without changing the money would look
    // identical to success from the disposition alone.
    expect(Number(peHistoryRows()[0].estimatedPVT ?? 0)).toBeGreaterThan(0);
  });

  it('RED CONTROL (a) — the verdict ALONE cannot make a row eligible', async () => {
    // THE PERMANENT CONTROL FOR "a row sealing eligible WITHOUT the durable
    // inlet must be impossible". Same earned verdict, same canonical id, the
    // inlet withheld. It must fall all the way back to record_only — durability
    // is not a formality the stamp can paper over.
    await emit({ durable: false, witness: true });
    const row = peHistoryRows()[0];
    expect(row.mint_disposition).not.toBe('eligible');
    expect(row.mint_disposition).toBe('record_only');
    expect(Number(row.estimatedPVT ?? 0)).toBe(0);
  });

  it('RED CONTROL — the inlet ALONE cannot make a row eligible either', async () => {
    // The mirror. Neither of the two conditions this part controls is
    // sufficient on its own, so a pass above cannot be either one leaking.
    await emit({ durable: true, witness: false });
    const row = peHistoryRows()[0];
    expect(row.mint_disposition).toBe('pending_evidence');
    expect(Number(row.estimatedPVT ?? 0)).toBe(0);
  });

  it('RED CONTROL (b) — a STAMPED row seals the OBSERVED log identity, not the tx hash', async () => {
    // The property that survives the stamp. Before the risk was a NULL
    // id; now that rows carry `verified: true`, `pe-utils`'s fallback would
    // instead reach `firstEconomicEventId`, whose SECOND key is `tx_hash`. So
    // the live failure mode is a silent degradation to the weaker per-
    // TRANSACTION identity — exactly what both USDC watchers seal today — which
    // would collapse two fundings in one transaction onto one id and break
    // log-granular exactly-once on the money path.
    await emit({ durable: true, witness: true });
    const snap = peHistoryRows()[0].economic_snapshot as
      { recordTimeFactors?: { canonicalEventId?: unknown } } | null;
    expect(snap).not.toBeNull();
    const sealed = snap!.recordTimeFactors!.canonicalEventId;
    expect(sealed).toBe(`8453:${TX}:7`);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toBe(TX);
  });

  it('SELF-DEALING DOES NOT PAY — the guard the 1d leg found inert ', async () => {
    // THE DEFECT THIS EXISTS FOR. All three funding types carry the
    // `record_only_if_self_shared_or_churn` beneficial-ownership policy, and
    // `pvt-accrual.ts` runs `detectSameOwnerTransfer` ONLY when a counterparty
    // is supplied. shipped a paying row that supplied none, so the policy
    // was structurally inert: fund an escrow whose recipient is yourself, earn,
    // release the principal back to yourself, repeat. Here the counterparty IS
    // the actor and everything else is a perfect, fully-witnessed funding.
    await emit({ durable: true, witness: true, counterparty: LENDER });
    const row = peHistoryRows()[0];
    expect(row.mint_disposition).toBe('record_only');
    expect(Number(row.estimatedPVT ?? 0)).toBe(0);
  });

  it('an UNRESOLVED counterparty records but does not pay ', async () => {
    // "Unknown = Block, Not Warn": an unreadable struct costs the payment, not
    // the record. The row still seals, and 1c's promoter is its designed exit.
    await emit({ durable: true, witness: true, counterparty: null });
    const row = peHistoryRows()[0];
    expect(row.mint_disposition).toBe('pending_evidence');
    expect(Number(row.estimatedPVT ?? 0)).toBe(0);
  });

  it('two fundings in ONE transaction both price, on DISTINCT ids', async () => {
    // Log granularity under the stamp, end to end: the batch case is where a
    // per-transaction identity would have paid once and dropped the other.
    await emit({ durable: true, witness: true, logIndex: 7 });
    await emit({ durable: true, witness: true, logIndex: 8 });
    const rows = peHistoryRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mint_disposition === 'eligible')).toBe(true);
    const ids = rows.map((r) => (r.economic_snapshot as
      { recordTimeFactors?: { canonicalEventId?: unknown } }).recordTimeFactors!.canonicalEventId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(expect.arrayContaining([`8453:${TX}:7`, `8453:${TX}:8`]));
  });
});

describe('1b(ii) — the invalid combination is refused at the door', () => {
  it('durableViaOrdinaryIntake + awaitAccrual THROWS rather than silently record_only', async () => {
    // `awaitAccrual: true` skips the intake co-commit, so the claim would have
    // no committed row to verify against: the accrual would refuse it, warn,
    // and seal record_only while the caller believed it was durable. That is
    // the defect wearing a marker, so the combination is refused here.
    const emission = emissionFor();
    await expect(generatePE(realDeps(), {
      walletId: emission.walletId,
      agentId: emission.agentId,
      actorAddress: emission.actorAddress,
      actionType: emission.funding.spec.actionType,
      metadata: buildLinkedEvidenceMetadata(emission, 8453),
      timestampOverride: TIMESTAMP,
      durableViaOrdinaryIntake: true,
      awaitAccrual: true,
    })).rejects.toThrow('generatePE_durable_via_intake_conflicts_with_awaitAccrual');

    // And it refused BEFORE writing anything: no staged act, no envelope, no tip.
    expect(countIn(`${METER_RELAY_ACTS_COLLECTION}/`)).toBe(0);
    expect(countIn('provenance_envelopes/')).toBe(0);
    expect(countIn('pe_chain_tips/')).toBe(0);
  });
});

// =============================================================================
// 3 — all-or-nothing inside the transaction
// =============================================================================

describe('1b(ii) — a failure inside the transaction leaves the OLD state', () => {
  it('no PE, no lock, no intake row, no chain tip', async () => {
    const emission = emissionFor();
    await expect(generatePE(realDeps(), {
      walletId: emission.walletId,
      agentId: emission.agentId,
      actorAddress: emission.actorAddress,
      actionType: emission.funding.spec.actionType,
      metadata: buildLinkedEvidenceMetadata(emission, 8453),
      timestampOverride: TIMESTAMP,
      durableViaOrdinaryIntake: true,
      atomicEntityPrecondition: async () => {
        throw new Error('institution_funding_emission_lock_exists');
      },
      atomicEntityWrite: () => {},
    })).rejects.toThrow('institution_funding_emission_lock_exists');

    expect(countIn(`${METER_RELAY_ACTS_COLLECTION}/`)).toBe(0);
    expect(countIn('provenance_envelopes/')).toBe(0);
    expect(countIn(`${INSTITUTION_EMISSION_LOCK_COLLECTION}/`)).toBe(0);
    expect(countIn(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/`)).toBe(0);
    expect(countIn('pe_chain_tips/')).toBe(0);
    expect(peHistoryRows()).toHaveLength(0);
  });
});

// =============================================================================
// 4 — crash between commit and accrual: recoverable, exactly once
// =============================================================================

describe('1b(ii) — a crash after the commit is recoverable, never a split', () => {
  it('the PE, the lock and the intake row all survive a crashed accrual', async () => {
    // The accrual dies at the pe_history boundary. generatePE fires it
    // best-effort, so the emission itself still returns.
    await emit({
      durable: true,
      accrualOver: { durableTestCrashAt: 'before_pe_history' },
    });
    await flushAccrual();

    // NEW state on the durable side: the staged act (PE METER: the relay-act intake is both the
    // PE's committed record and its replay source), the lock, and the chain tip...
    expect(countIn(`${METER_RELAY_ACTS_COLLECTION}/`)).toBe(1);
    expect(countIn(`${INSTITUTION_EMISSION_LOCK_COLLECTION}/`)).toBe(1);
    expect(countIn('pe_chain_tips/')).toBe(1);
    const [intake] = relayIntakes(mockDb.store);
    expect(intake.accrual.durableReplaySource).toBe('ordinary_accrual_intake');
    expect(intake.act.pe_hash).toBe((mockDb.store.get('pe_chain_tips/agent_lender') as { hash: string }).hash);
    // ...and the accrual half genuinely did NOT land. That is the crash this
    // canary exists to survive, not an incidental detail.
    expect(peHistoryRows()).toHaveLength(0);
    expect(countIn(`${METER_PENDING_CLAIMS_COLLECTION}/`)).toBe(0);
  });

  it('replaying from the committed intake row completes it EXACTLY ONCE', async () => {
    await emit({
      durable: true,
      accrualOver: { durableTestCrashAt: 'before_pe_history' },
    });
    await flushAccrual();
    expect(peHistoryRows()).toHaveLength(0);

    // Replay is the production shape: the relay-act replay sweep re-prices the committed intake
    // verbatim (PE METER: `replayStuckRelayActs`, which reads `meter_relay_acts_v1`).
    const [intake] = relayIntakes(mockDb.store);
    expect(intake).toBeDefined();
    const swept = await replayStuckRelayActs(mockDb as unknown as Firestore, {
      nowMs: intake.created_at_ms + METER_RELAY_ACT_REPLAY_AFTER_MS + 1,
    });
    expect(swept).toEqual({ scanned: 1, priced: 1, failed: 0 });
    expect(peHistoryRows()).toHaveLength(1);
    expect(peHistoryRows()[0].mint_disposition).toBe('pending_evidence');
    // The pricing commit consumed the replay source.
    expect(countIn(`${METER_RELAY_ACTS_COLLECTION}/`)).toBe(0);
    const claimsAfterReplay = pendingClaimsSnapshot();

    // Re-firing again must not double it: the act key makes a re-price a no-op.
    await priceRelayAct(mockDb as unknown as Firestore, intake);
    expect(peHistoryRows()).toHaveLength(1);
    expect(pendingClaimsSnapshot()).toBe(claimsAfterReplay);
  });
});

// =============================================================================
// 5 — the marker is VERIFIED, never trusted
// =============================================================================

describe('1b(ii) — the marker cannot manufacture durability', () => {
  it('a claim whose committed intake row does not match seals record_only', async () => {
    // Claim durability with NO intake row at all: the accrual must verify
    // against the committed row, find nothing, refuse, and seal record_only.
    const emission = emissionFor();
    await recordPEAccrual({
      peId: 'pe_forged_durable',
      userId: emission.agentId,
      actionType: 'promise_funded',
      integrationSource: 'agent_bank_generate_pe',
      attestationDepth: 'software',
      peHash: 'h_forged',
      timestamp: TIMESTAMP,
      durableReplaySource: 'ordinary_accrual_intake',
      economicCanonicalEventId: emission.funding.canonicalEventId,
    } as unknown as Parameters<typeof recordPEAccrual>[0]);

    // A direct, un-metered accrual call is the pre-meter path: it seals its own pe_history row,
    // after verifying the claimed replay source against the committed ordinary intake (absent).
    // (On the metered path the replay source is the relay-act intake generatePE commits in the
    // chain-tip transaction itself, so a relay-authored act cannot claim one it did not stage.)
    const row = mockDb.store.get('pe_history/pe_forged_durable') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.mint_disposition).toBe('record_only');
    expect(peHistoryRows()).toHaveLength(0);
  });
});
