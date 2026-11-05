/**
 * Institution COMPLETION watcher — the sibling of the funding watcher, for
 * lifecycle completions (release / resolve / settle / execute).
 *
 * The properties asserted here are the ones that decide whether this module can
 * be trusted to carry a verdict now that the 3b matrix reclassification (,
 * 2026-08-10) has made the completion types lineage-optional and `eligible` *
 * - the registry is bound to the deployment file and to keccak of the REAL
 * completion signatures, so a copied address or a stale topic fails HERE;
 * - it refuses a correctly-shaped completion from the WRONG contract;
 * - it attributes to the party the ON-CHAIN EVENT NAMES and reads the
 * counterparty from the struct — never guesses; an unreadable struct is
 * COUNTED and skipped;
 * - `EscrowResolved` has no indexed actor: the `releaseToRecipient` bool decides
 * whether the recipient (released) or the depositor (refunded) is the earner;
 * - THE STAMP IS EARNED, NEVER ASSERTED — every finality/counterparty refusal
 * leaves NO `verified: true` on the metadata (the RED controls: a
 * mutation that granted the stamp unconditionally reddens these);
 * - the emitter hands generatePE the LOAD-BEARING mint inputs
 * (`durableViaOrdinaryIntake`, `counterpartyAddress`, `observedCanonicalEventId`);
 * - one canonical log identity produces at most one row; the cursor never
 * advances past a failure; the scan is bounded by the L1-batched safe head.
 *
 * SCOPE: this file proves the EMISSION + stamp-discipline properties above (it
 * makes 0 `recordPEAccrual` calls). The END-TO-END pricing proofs — that a
 * verified completion seals `eligible`, and that the same-owner fence /
 * durable-inlet removal drive it to `record_only` live in
 * `completion-earning.acceptance.test.ts`, now that the completion types are
 * `verified_institution_lifecycle` + session-lineage OPTIONAL + `eligible` in
 * the live matrix. The watcher PAYS; it is no longer inert.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import {
  INSTITUTION_ADDRESSES,
  INSTITUTION_WATCHER_CHAIN_ID,
  PREDECESSOR_ESCROW_V4_ADDRESS,
} from './institution-funding-watcher';
import {
  INSTITUTION_COMPLETION_EVENTS,
  INSTITUTION_COMPLETION_ACTION_TYPES,
  INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION,
  buildCompletionEvidenceMetadata,
  decodeInstitutionCompletionLog,
  emptyInstitutionCompletionWatcherReport,
  evaluateCompletionVerdict,
  institutionCompletionLogFilters,
  makeCompletionTransactionalEmitter,
  processDecodedCompletion,
  resolveCompletionParties,
  runInstitutionCompletionWatcherCycle,
  type InstitutionCompletionEmission,
  type InstitutionCompletionWatcherDeps,
  type DecodedInstitutionCompletion,
} from './institution-completion-watcher';

const TX_A = `0x${'a1'.repeat(32)}`;
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const LENDER = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const DEPOSITOR = '0x4444444444444444444444444444444444444444';
const BORROWER = '0x5555555555555555555555555555555555555555';
const CREATOR = '0x6666666666666666666666666666666666666666';
const SAFE_HASH = `0x${'5e'.repeat(32)}`;
const ENTITY = `0x${'cd'.repeat(32)}`;

const topicOf = (sig: string) => ethers.id(sig);
const addrTopic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
/** A two-address-plus-amount struct return: word0, word1, amount. */
const struct2 = (w0: string, w1: string) =>
  `0x${addrTopic(w0).slice(2)}${addrTopic(w1).slice(2)}${word(1n)}`;

/** EscrowReleased: recipient indexed (topic 2), net amount in data word 0. */
function releasedLog(over: Partial<CanonicalEconomicLog> = {}): CanonicalEconomicLog {
  return {
    address: INSTITUTION_ADDRESSES.escrow,
    topics: [
      topicOf('EscrowReleased(bytes32,address,uint256,uint256,bool)'),
      ENTITY,
      addrTopic(RECIPIENT),
    ],
    data: `0x${word(9_000_000n)}`,
    blockNumber: 1_000,
    blockHash: `0x${'ee'.repeat(32)}`,
    transactionHash: TX_A,
    transactionIndex: 0,
    logIndex: 7,
    removed: false,
    ...over,
  } as CanonicalEconomicLog;
}

/** EscrowResolved: no indexed actor; only the direction bool in data word 0. */
function resolvedLog(releaseToRecipient: boolean, over: Partial<CanonicalEconomicLog> = {}) {
  return {
    address: INSTITUTION_ADDRESSES.escrow,
    topics: [topicOf('EscrowResolved(bytes32,bool)'), ENTITY],
    data: `0x${word(releaseToRecipient ? 1n : 0n)}`,
    blockNumber: 1_000,
    blockHash: `0x${'ee'.repeat(32)}`,
    transactionHash: TX_A,
    transactionIndex: 0,
    logIndex: 7,
    removed: false,
    ...over,
  } as CanonicalEconomicLog;
}

/** EscrowDisputed: only the indexed escrowId; NO data words at all. */
function disputedLog(over: Partial<CanonicalEconomicLog> = {}) {
  return {
    address: INSTITUTION_ADDRESSES.escrow,
    topics: [topicOf('EscrowDisputed(bytes32)'), ENTITY],
    data: '0x',
    blockNumber: 1_000,
    blockHash: `0x${'ee'.repeat(32)}`,
    transactionHash: TX_A,
    transactionIndex: 0,
    logIndex: 7,
    removed: false,
    ...over,
  } as CanonicalEconomicLog;
}

// =============================================================================
// REGISTRY — bound to reality, not a copied list
// =============================================================================

describe('completion watcher — the registry is bound to deployed reality', () => {
  it('covers exactly nine successor events across three institutions, plus the one predecessor-escrow resolution', () => {
    // A universally-quantified claim over zero specs proves nothing.
    // added the currency-less EscrowDisputed (9th event, 5th action type).
    // added ONE spec on the PREDECESSOR EscrowV4: EscrowResolved, for the escrow
    // that was Disputed at the migration and completes where its USDC sits.
    expect(INSTITUTION_COMPLETION_EVENTS.length).toBe(10);
    const onPredecessor = INSTITUTION_COMPLETION_EVENTS.filter((s) => s.address === PREDECESSOR_ESCROW_V4_ADDRESS);
    expect(onPredecessor.map((s) => s.signature)).toEqual(['EscrowResolved(bytes32,bool)']);
    expect(onPredecessor[0].actionType).toBe('escrow_resolved');
    expect(new Set(INSTITUTION_COMPLETION_EVENTS.map((s) => s.institution)).size).toBe(3);
    expect(new Set(INSTITUTION_COMPLETION_ACTION_TYPES).size).toBe(5);
    expect(INSTITUTION_COMPLETION_ACTION_TYPES).toContain('escrow_disputed');
  });

  it('addresses match the deployment file byte-for-byte (lowercased)', () => {
    const deployed = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../contracts/deployments/base-pvt9-institutions.json'),
      'utf8',
    )) as { chainId: number; contracts: Record<string, { address: string }> };
    expect(deployed.chainId).toBe(INSTITUTION_WATCHER_CHAIN_ID);
    const predecessor = (deployed as unknown as { predecessor: { contracts: { escrowV4: string } } }).predecessor;
    expect(PREDECESSOR_ESCROW_V4_ADDRESS).toBe(predecessor.contracts.escrowV4.toLowerCase());
    for (const s of INSTITUTION_COMPLETION_EVENTS) {
      if (s.address === PREDECESSOR_ESCROW_V4_ADDRESS) continue;
      const deployedAddr = s.institution === 'escrow' ? deployed.contracts.escrowV4.address
        : s.institution === 'promise' ? deployed.contracts.promiseV3.address
          : deployed.contracts.poolV3.address;
      expect(s.address).toBe(deployedAddr.toLowerCase());
    }
  });

  it('every topic0 is keccak of its own declared signature', () => {
    for (const s of INSTITUTION_COMPLETION_EVENTS) {
      expect(s.topic0).toBe(ethers.id(s.signature));
    }
  });

  it('pins the nine topic0s to independently-verified values', () => {
    // Derivation alone would pass even with a wrong signature, so the expected
    // hashes are pinned, verified against contracts/src at build time.
    const byName = Object.fromEntries(
      INSTITUTION_COMPLETION_EVENTS.map((s) => [s.signature, s.topic0]),
    );
    expect(byName['EscrowReleased(bytes32,address,uint256,uint256,bool)'])
      .toBe('0xc34eee57406c5476f711c07433c681e46156b01cfcfa73e3f50037f351e34020');
    expect(byName['EscrowReleasedPVT(bytes32,address,uint256,bool)'])
      .toBe('0xd14e7c8951337c2288203f05e40dd5b787b3d48ee85dc29b35d55cc698c8e8fc');
    expect(byName['EscrowResolved(bytes32,bool)'])
      .toBe('0xcafb63065ff3b879e667874cb9ec5b7560d4f5632ead82938ed6e053e7347dc8');
    expect(byName['EscrowResolvedPVT(bytes32,bool)'])
      .toBe('0xaa81bc6c04aab5912bb0dd9e09efb1dc3872573f17e5a5b12d2450d9ab1b5563');
    expect(byName['PromiseSettled(bytes32,address,uint256,uint256)'])
      .toBe('0xa5a1f05785a942c5f624cee545c68394881a83bcaf21a83f4d76a9e8240a5668');
    expect(byName['PromiseSettledPVT(bytes32,address,uint256,uint256)'])
      .toBe('0x998fbf1982ac456a80716924dff7ae0c724aaaca9ad864a280efce7bd66d3f1b');
    expect(byName['PoolExecuted(bytes32,address,uint256,uint256)'])
      .toBe('0x35ef8a6730dbe6666bc1511b5492fdf5d2369e451de92c95382dd3294ee6f110');
    expect(byName['PoolExecutedPVT(bytes32,address,uint256,uint256)'])
      .toBe('0xbcb8ab7beab7ad19e27601e418b42cc4ad0f530c89fecc578e4e57d1a492c43e');
    // EscrowDisputed(bytes32) — verified against contracts/src/ProvianEscrowV4.sol.
    expect(byName['EscrowDisputed(bytes32)'])
      .toBe('0x550ba3f95fa658596451573e6d789afa3858d8a992cb121712d3df88cff5765c');
  });

  it('the log filter covers every completion address and topic0', () => {
    const { addresses, topic0s } = institutionCompletionLogFilters();
    expect(new Set(addresses)).toEqual(new Set(INSTITUTION_COMPLETION_EVENTS.map((s) => s.address)));
    expect(new Set(topic0s)).toEqual(new Set(INSTITUTION_COMPLETION_EVENTS.map((s) => s.topic0)));
  });
});

// =============================================================================
// DECODE
// =============================================================================

describe('completion watcher — decoding', () => {
  it('decodes an EscrowReleased and names the recipient as the value-receiver', () => {
    const c = decodeInstitutionCompletionLog(releasedLog())!;
    expect(c.spec.actionType).toBe('escrow_completed');
    expect(c.indexedActorAddress).toBe(RECIPIENT);
    expect(c.releaseToRecipient).toBeNull();
    expect(c.amountAtomic).toBe(9_000_000n);
  });

  it('decodes an EscrowResolved release vs refund from the bool', () => {
    expect(decodeInstitutionCompletionLog(resolvedLog(true))!.releaseToRecipient).toBe(true);
    expect(decodeInstitutionCompletionLog(resolvedLog(false))!.releaseToRecipient).toBe(false);
    // amount is not carried by the event.
    expect(decodeInstitutionCompletionLog(resolvedLog(true))!.amountAtomic).toBeNull();
  });

  it('REFUSES a resolution whose bool is neither 0 nor 1 (malformed)', () => {
    expect(decodeInstitutionCompletionLog(resolvedLog(true, { data: `0x${word(2n)}` }))).toBeNull();
  });

  it('decodes an EscrowDisputed with empty data (no amount, no direction)', () => {
    const c = decodeInstitutionCompletionLog(disputedLog())!;
    expect(c.spec.actionType).toBe('escrow_disputed');
    expect(c.spec.currency).toBe('none');
    expect(c.indexedActorAddress).toBeNull();
    expect(c.releaseToRecipient).toBeNull();
    expect(c.amountAtomic).toBeNull();
    expect(c.entityId).toBe(ENTITY);
  });

  it('REFUSES a settled/executed topic emitted by the WRONG contract', () => {
    // A PromiseSettled topic emitted at the pool address must not decode — the
    // exact wrong-contract shape the funding bar closed.
    const wrong = decodeInstitutionCompletionLog(releasedLog({
      address: INSTITUTION_ADDRESSES.pool,
      topics: [
        topicOf('PromiseSettled(bytes32,address,uint256,uint256)'),
        ENTITY,
        addrTopic(LENDER),
      ],
    }));
    expect(wrong).toBeNull();
  });

  it('REFUSES an indexed event whose actor topic is missing', () => {
    expect(decodeInstitutionCompletionLog(releasedLog({ topics: [
      topicOf('EscrowReleased(bytes32,address,uint256,uint256,bool)'), ENTITY,
    ] }))).toBeNull();
  });

  it('REFUSES a removed log', () => {
    expect(decodeInstitutionCompletionLog(releasedLog({ removed: true }))).toBeNull();
  });
});

// =============================================================================
// ATTRIBUTION — the party the event names; never a guess
// =============================================================================

interface Harness {
  deps: InstitutionCompletionWatcherDeps;
  emitted: InstitutionCompletionEmission[];
  locks: Set<string>;
  logsByRange: CanonicalEconomicLog[];
  headValue: number;
  safeHeadValue: number | null | undefined;
  failSafeHead: boolean;
  failGetLogs: boolean;
  structReturn: string | null;
  knownAddresses: Set<string>;
}

function harness(over: Partial<Harness> = {}): Harness {
  const db = createFakeFirestore();
  const h: Harness = {
    emitted: [],
    locks: new Set<string>(),
    logsByRange: [],
    headValue: 1_011,
    safeHeadValue: 1_000,
    failSafeHead: false,
    failGetLogs: false,
    // escrow struct: depositor(word0), recipient(word1). escrow_completed
    // counterparty is word 0 (depositor); escrow_resolution reads both.
    structReturn: struct2(DEPOSITOR, RECIPIENT),
    knownAddresses: new Set([RECIPIENT, LENDER, TARGET, DEPOSITOR]),
    deps: null as unknown as InstitutionCompletionWatcherDeps,
    ...over,
  };
  h.deps = {
    db: db as unknown as InstitutionCompletionWatcherDeps['db'],
    chainId: 8453,
    readHead: async () => h.headValue,
    ...(h.safeHeadValue === undefined ? {} : {
      readSafeHead: async () => {
        if (h.failSafeHead) throw new Error('quorum disagreement');
        const v = h.safeHeadValue;
        return v === null || v === undefined ? null : { number: v, hash: SAFE_HASH };
      },
    }),
    getLogs: async (f) => {
      if (h.failGetLogs) throw new Error('failed to meet quorum');
      const addrs = typeof f.address === 'string' ? [f.address] : f.address;
      const t0 = f.topics[0];
      const topic0Set = t0 == null ? null : new Set(typeof t0 === 'string' ? [t0] : t0);
      return h.logsByRange.filter(
        (l) => addrs.includes(l.address)
          && (topic0Set === null || topic0Set.has(l.topics[0]))
          && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock,
      );
    },
    callContract: async () => {
      if (h.structReturn === null) throw new Error('rpc down');
      return h.structReturn;
    },
    resolveWalletByAddress: async (a) => (
      h.knownAddresses.has(a) ? { walletId: `w_${a.slice(2, 8)}`, agentId: `ag_${a.slice(2, 8)}` } : null
    ),
    emitLinkedEvidencePE: async (e) => {
      const key = e.completion.canonicalEventId;
      if (h.locks.has(key)) return { emitted: false };
      h.locks.add(key);
      h.emitted.push(e);
      return { emitted: true, peId: `pe_${h.emitted.length}` };
    },
    now: () => 1_700_000_000_000,
  };
  return h;
}

describe('completion watcher — attribution follows the event, never a guess', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('attributes an escrow release to the recipient, counterparty the depositor', async () => {
    const parties = await resolveCompletionParties(
      h.deps, decodeInstitutionCompletionLog(releasedLog())!, emptyInstitutionCompletionWatcherReport(),
    );
    expect(parties).toEqual({ actorAddress: RECIPIENT, counterpartyAddress: DEPOSITOR });
  });

  it('escrow RESOLUTION released -> recipient earns; REFUND -> depositor earns', async () => {
    const released = await resolveCompletionParties(
      h.deps, decodeInstitutionCompletionLog(resolvedLog(true))!, emptyInstitutionCompletionWatcherReport(),
    );
    expect(released).toEqual({ actorAddress: RECIPIENT, counterpartyAddress: DEPOSITOR });

    const refunded = await resolveCompletionParties(
      h.deps, decodeInstitutionCompletionLog(resolvedLog(false))!, emptyInstitutionCompletionWatcherReport(),
    );
    // The direction bool flips both sides — the depositor is now the value-receiver.
    expect(refunded).toEqual({ actorAddress: DEPOSITOR, counterpartyAddress: RECIPIENT });
  });

  it('attributes an escrow DISPUTE to the depositor (disputer), counterparty the recipient', async () => {
    const parties = await resolveCompletionParties(
      h.deps, decodeInstitutionCompletionLog(disputedLog())!, emptyInstitutionCompletionWatcherReport(),
    );
    // struct2(DEPOSITOR, RECIPIENT): the disputer (depositor, word0) is the value-
    // receiver; the recipient (word1) is the counterparty. No direction bool.
    expect(parties).toEqual({ actorAddress: DEPOSITOR, counterpartyAddress: RECIPIENT });
  });

  it('a dispute whose depositor struct-read fails DROPS and is held for retry', async () => {
    // RED-adjacent control: an unresolvable ACTOR (depositor) drops the row so the
    // block is retried — a dispute is not silently emitted with no earner.
    h.structReturn = null;
    const report = emptyInstitutionCompletionWatcherReport();
    const parties = await resolveCompletionParties(
      h.deps, decodeInstitutionCompletionLog(disputedLog())!, report,
    );
    expect(parties).toBeNull();
    expect(report.attributionFailures).toBe(1);
  });

  it('attributes a promise settlement to the lender, counterparty the borrower', async () => {
    const hp = harness({ structReturn: struct2(BORROWER, LENDER), knownAddresses: new Set([LENDER]) });
    const settled = {
      address: INSTITUTION_ADDRESSES.promise,
      topics: [topicOf('PromiseSettled(bytes32,address,uint256,uint256)'), ENTITY, addrTopic(LENDER)],
      data: `0x${word(5n)}`, blockNumber: 1_000, blockHash: `0x${'ee'.repeat(32)}`,
      transactionHash: TX_A, transactionIndex: 0, logIndex: 3, removed: false,
    } as CanonicalEconomicLog;
    const parties = await resolveCompletionParties(
      hp.deps, decodeInstitutionCompletionLog(settled)!, emptyInstitutionCompletionWatcherReport(),
    );
    expect(parties).toEqual({ actorAddress: LENDER, counterpartyAddress: BORROWER });
  });

  it('attributes a pool execution to the target, counterparty the creator', async () => {
    const hp = harness({ structReturn: struct2(CREATOR, TARGET), knownAddresses: new Set([TARGET]) });
    const executed = {
      address: INSTITUTION_ADDRESSES.pool,
      topics: [topicOf('PoolExecuted(bytes32,address,uint256,uint256)'), ENTITY, addrTopic(TARGET)],
      data: `0x${word(5n)}`, blockNumber: 1_000, blockHash: `0x${'ee'.repeat(32)}`,
      transactionHash: TX_A, transactionIndex: 0, logIndex: 4, removed: false,
    } as CanonicalEconomicLog;
    const parties = await resolveCompletionParties(
      hp.deps, decodeInstitutionCompletionLog(executed)!, emptyInstitutionCompletionWatcherReport(),
    );
    expect(parties).toEqual({ actorAddress: TARGET, counterpartyAddress: CREATOR });
  });

  it('EMITS record_only (never drops) when an indexed-actor counterparty read fails', async () => {
    // Regression for the a transient struct-read failure on
    // escrow_completed must NOT lose the event. Emit the row WITHOUT a counterparty
    // (verdict refuses -> record_only), exactly as the funding watcher does. The
    // first cut dropped it AND advanced the cursor, losing a real completion forever.
    h.structReturn = null;
    const report = emptyInstitutionCompletionWatcherReport();
    await processDecodedCompletion(h.deps, decodeInstitutionCompletionLog(releasedLog())!, report, {
      head: 1_011, finalizedThrough: 1_000, safeHead: { number: 1_000, hash: SAFE_HASH },
    });
    expect(report.counterpartyReadFailures).toBe(1);
    expect(report.emitted).toBe(1); // RECORDED, not lost
    expect(h.emitted[0].counterpartyAddress).toBeUndefined();
    // No counterparty -> the verdict refused -> record_only, pays 0.
    expect(evaluateCompletionVerdict(h.emitted[0]))
      .toEqual({ verified: false, reason: 'counterparty_unresolved' });
  });

  it('DROPS and holds an escrow RESOLUTION whose struct read fails — no value-receiver', async () => {
    // escrow_resolution reads BOTH parties from one struct; a failed read leaves no
    // one to attribute the earning to, so the row DROPS and is held
    // (attributionFailures, which the cursor-hold set includes) for retry — NOT
    // emitted, unlike the indexed-actor counterparty case above.
    h.structReturn = null;
    const report = emptyInstitutionCompletionWatcherReport();
    await processDecodedCompletion(h.deps, decodeInstitutionCompletionLog(resolvedLog(true))!, report);
    expect(report.attributionFailures).toBe(1);
    expect(report.emitted).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it('COUNTS and skips a completion by an address no Provian wallet holds', async () => {
    h.knownAddresses.clear();
    const report = emptyInstitutionCompletionWatcherReport();
    await processDecodedCompletion(h.deps, decodeInstitutionCompletionLog(releasedLog())!, report);
    expect(report.unattributed).toBe(1);
    expect(report.emitted).toBe(0);
  });
});

// =============================================================================
// THE STAMP IS EARNED, NEVER ASSERTED (RED controls)
// =============================================================================

const FULL_WITNESS = {
  head: 1_011,
  finalizedThrough: 1_000,
  observedBlock: 1_000,
  safeHead: { number: 1_000, hash: SAFE_HASH },
};

function emission(over: Partial<InstitutionCompletionEmission> = {}): InstitutionCompletionEmission {
  return {
    completion: decodeInstitutionCompletionLog(releasedLog())!,
    actorAddress: RECIPIENT,
    walletId: 'w', agentId: 'ag',
    counterpartyAddress: DEPOSITOR,
    finalityWitness: FULL_WITNESS,
    ...over,
  };
}

describe('completion watcher — the stamp is earned, never asserted', () => {
  it('GRANTS the verdict for a fully-witnessed, safe-head-covered completion', () => {
    expect(evaluateCompletionVerdict(emission()).verified).toBe(true);
    const md = buildCompletionEvidenceMetadata(emission(), 8453);
    expect(md.verified).toBe(true);
    expect(md.evidence_verdict_refused).toBeUndefined();
  });

  // Each of these is a RED control: a mutation that granted the stamp regardless
  // (e.g. `evaluateInstitutionFinalityVerdict` short-circuiting to `{verified:true}`)
  // would flip every one of them from refuse to grant and FAIL the assertion.
  it('REFUSES with no counterparty — and seals NO verified stamp', () => {
    const e = emission({ counterpartyAddress: undefined });
    const v = evaluateCompletionVerdict(e);
    expect(v).toEqual({ verified: false, reason: 'counterparty_unresolved' });
    const md = buildCompletionEvidenceMetadata(e, 8453);
    expect(md.verified).toBeUndefined();
    expect(md.evidence_verdict_refused).toBe('counterparty_unresolved');
  });

  it('REFUSES with no finality witness', () => {
    expect(evaluateCompletionVerdict(emission({ finalityWitness: undefined })))
      .toEqual({ verified: false, reason: 'no_finality_witness' });
  });

  it('REFUSES a witness about a DIFFERENT block', () => {
    expect(evaluateCompletionVerdict(emission({
      finalityWitness: { ...FULL_WITNESS, observedBlock: 999 },
    }))).toEqual({ verified: false, reason: 'witness_block_mismatch' });
  });

  it('REFUSES a witness whose ceiling its head does not re-derive', () => {
    expect(evaluateCompletionVerdict(emission({
      finalityWitness: { ...FULL_WITNESS, finalizedThrough: 1_010 },
    }))).toEqual({ verified: false, reason: 'witness_ceiling_not_derived' });
  });

  it('REFUSES a completion with NO safe head witness (the reorg floor)', () => {
    const { safeHead, ...noSafe } = FULL_WITNESS;
    void safeHead;
    expect(evaluateCompletionVerdict(emission({ finalityWitness: noSafe })))
      .toEqual({ verified: false, reason: 'no_safe_head_witness' });
  });

  it('REFUSES a completion whose block leads the safe head', () => {
    // block 1_000, safe head 999 -> above_safe_head.
    expect(evaluateCompletionVerdict(emission({
      finalityWitness: { ...FULL_WITNESS, safeHead: { number: 999, hash: SAFE_HASH } },
    }))).toEqual({ verified: false, reason: 'above_safe_head' });
  });
});

// =============================================================================
// EMITTER — the load-bearing mint inputs are handed to generatePE
// =============================================================================

describe('completion watcher — the emitter carries the mint inputs, not the verdict', () => {
  it('hands generatePE the durable inlet, counterparty and observed canonical id', async () => {
    const db = createFakeFirestore();
    let captured: Record<string, unknown> | null = null;
    const generate = (async (_d: unknown, params: Record<string, unknown>) => {
      // Honor the precondition/write contract against a real transaction.
      await (db as unknown as { runTransaction: (fn: (t: unknown) => Promise<string>) => Promise<string> })
        .runTransaction(async (txn: unknown) => {
          await (params.atomicEntityPrecondition as (t: unknown) => Promise<void>)(txn);
          (params.atomicEntityWrite as (t: unknown, id: string) => void)(txn, 'pe_x');
          return 'pe_x';
        });
      captured = params;
      return { peId: 'pe_x' };
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;

    const emit = makeCompletionTransactionalEmitter(
      db as unknown as Parameters<typeof makeCompletionTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeCompletionTransactionalEmitter>[3],
    );
    const res = await emit(emission());
    expect(res.emitted).toBe(true);
    const p = captured! as Record<string, unknown>;
    // LOAD-BEARING: removing any of these drops the row to record_only.
    expect(p.durableViaOrdinaryIntake).toBe(true);
    expect(p.counterpartyAddress).toBe(DEPOSITOR);
    expect(p.observedCanonicalEventId).toBe((emission().completion as DecodedInstitutionCompletion).canonicalEventId);
    expect(p.actionType).toBe('escrow_completed');
    // The stamp lives in the metadata, granted by the verdict — not a param.
    expect((p.metadata as Record<string, unknown>).verified).toBe(true);
    // the release is the ON-CHAIN witness of a job completion, so the
    // emitter hands generatePE the completion mint-once key. No relay escrow
    // pins this bytes32 id in this harness, so the key is the chain-qualified
    // form; `resolvesEscrowCanonicalId` below covers the relay-escrow form.
    expect(p.completionCanonicalId).toBe(
      `escrow_onchain:8453:${(emission().completion as DecodedInstitutionCompletion).entityId.toLowerCase()}`,
    );
  });

  it('a release whose bytes32 id is pinned on a relay escrow claims `escrow:<escrow_id>` the key the off-chain witness derives', async () => {
    const db = createFakeFirestore();
    const entityId = (emission().completion as DecodedInstitutionCompletion).entityId.toLowerCase();
    await db.collection('escrows').doc('esc_relay-1').set({
      escrow_id: 'esc_relay-1', onchain_escrow_id: entityId, status: 'completed',
    });
    let captured: Record<string, unknown> | null = null;
    const generate = (async (_d: unknown, params: Record<string, unknown>) => {
      captured = params;
      return { peId: 'pe_y' };
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;
    const emit = makeCompletionTransactionalEmitter(
      db as unknown as Parameters<typeof makeCompletionTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeCompletionTransactionalEmitter>[3],
    );
    await emit(emission());
    expect((captured! as Record<string, unknown>).completionCanonicalId).toBe('escrow:esc_relay-1');
  });

  it('RED : a REFUND (escrow_resolved to the depositor) is not a completion — no key is handed over', async () => {
    const db = createFakeFirestore();
    let captured: Record<string, unknown> | null = null;
    const generate = (async (_d: unknown, params: Record<string, unknown>) => {
      captured = params;
      return { peId: 'pe_z' };
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;
    const emit = makeCompletionTransactionalEmitter(
      db as unknown as Parameters<typeof makeCompletionTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeCompletionTransactionalEmitter>[3],
    );
    const refund = decodeInstitutionCompletionLog(resolvedLog(false))!;
    await emit({ ...emission(), completion: refund, actorAddress: DEPOSITOR, counterpartyAddress: RECIPIENT });
    expect((captured! as Record<string, unknown>).completionCanonicalId).toBeUndefined();
  });

  it('RED : an AMBIGUOUS relay-escrow mapping fails the emission — no lock, no PE, retried', async () => {
    const db = createFakeFirestore();
    const entityId = (emission().completion as DecodedInstitutionCompletion).entityId.toLowerCase();
    await db.collection('escrows').doc('esc_a').set({ escrow_id: 'esc_a', onchain_escrow_id: entityId });
    await db.collection('escrows').doc('esc_b').set({ escrow_id: 'esc_b', onchain_escrow_id: entityId });
    const generate = jest.fn(async () => ({ peId: 'never' })) as unknown as typeof import('../agent-bank/pe-utils').generatePE;
    const emit = makeCompletionTransactionalEmitter(
      db as unknown as Parameters<typeof makeCompletionTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeCompletionTransactionalEmitter>[3],
    );
    await expect(emit(emission())).rejects.toThrow('completion_canonical_escrow_ambiguous');
    expect(generate).not.toHaveBeenCalled();
    expect([...db.store.keys()].filter((k) => k.startsWith(`${INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION}/`)))
      .toHaveLength(0);
  });

  it('emits once per canonical id; a replay is a duplicate, not a second row', async () => {
    const h = harness();
    const report = emptyInstitutionCompletionWatcherReport();
    await processDecodedCompletion(h.deps, decodeInstitutionCompletionLog(releasedLog())!, report, {
      head: 1_011, finalizedThrough: 1_000, safeHead: { number: 1_000, hash: SAFE_HASH },
    });
    await processDecodedCompletion(h.deps, decodeInstitutionCompletionLog(releasedLog())!, report, {
      head: 1_011, finalizedThrough: 1_000, safeHead: { number: 1_000, hash: SAFE_HASH },
    });
    expect(report.emitted).toBe(1);
    expect(report.duplicatesSkipped).toBe(1);
  });
});

// =============================================================================
// CYCLE
// =============================================================================

describe('completion watcher — the cycle', () => {
  it('scans, emits, and advances the cursor', async () => {
    const h = harness({ logsByRange: [releasedLog()] });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.emitted).toBe(1);
    expect(report.cursorAdvanced).toBe(true);
    expect(h.emitted[0].actorAddress).toBe(RECIPIENT);
  });

  it('FAILS CLOSED with no safe-head reader — scans nothing', async () => {
    const h = harness({ safeHeadValue: undefined, logsByRange: [releasedLog()] });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.emitted).toBe(0);
    expect(report.safeHead).toBeNull();
  });

  it('the safe head, not the 12-confirmation ceiling, bounds the scan when it lags', async () => {
    // finalized ceiling would be 1_000; safe head is only 995, so 996..1000 are
    // NOT YET REACHED. A release at 998 is not emitted this cycle.
    const h = harness({ safeHeadValue: 995, logsByRange: [releasedLog({ blockNumber: 998 })] });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.safeHeadBoundedScan).toBe(true);
    expect(report.emitted).toBe(0);
  });

  it('does not advance the cursor past a getLogs failure', async () => {
    const h = harness({ failGetLogs: true });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.cursorAdvanced).toBe(false);
  });

  it('a counterparty read failure EMITS record_only and advances — the event is not lost', async () => {
    // The , at the cycle level: an indexed-actor completion whose
    // counterparty struct read fails must be RECORDED (record_only) and the cursor
    // may advance, because the row exists — not dropped-and-skipped.
    const h = harness({ structReturn: null, logsByRange: [releasedLog()] });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.emitted).toBe(1);
    expect(report.counterpartyReadFailures).toBe(1);
    expect(report.cursorAdvanced).toBe(true);
  });

  it('an escrow RESOLUTION struct failure HOLDS the cursor for retry — not skipped', async () => {
    const h = harness({ structReturn: null, logsByRange: [resolvedLog(true)] });
    const report = await runInstitutionCompletionWatcherCycle(h.deps);
    expect(report.emitted).toBe(0);
    expect(report.attributionFailures).toBe(1);
    expect(report.cursorAdvanced).toBe(false);
  });

  it('uses a distinct lock collection from the funding watcher', () => {
    expect(INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION)
      .toBe('institution_completion_emission_locks');
  });
});


describe('semantic read holds preserve the existing cursor', () => {
  it.each(['head', 'safe', 'disagreement'])('reports %s failure without reading logs or advancing', async (fault) => {
    const h = harness();
    const deps = h.deps;
    const getLogs = jest.fn(deps.getLogs);
    const error = fault === 'disagreement' ? 'economic_discovery_rpc_disagreement:safe_head' : 'unavailable';
    const report = await runInstitutionCompletionWatcherCycle({ ...deps, getLogs,
      ...(fault === 'head' ? { readHead: async () => { throw new Error(error); } } : { readSafeHead: async () => { throw new Error(error); } }),
    });
    expect(report).toMatchObject({ status: 'held', hold_reason: fault === 'disagreement' ? 'provider_disagreement' : fault === 'head' ? 'head_unavailable' : 'safe_head_unavailable', cursorAdvanced: false });
    expect(getLogs).not.toHaveBeenCalled();
  });
});
