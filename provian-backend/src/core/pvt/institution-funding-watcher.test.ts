/**
 * Stage 1b(i) — the institution funding watcher.
 *
 * The properties asserted here are the ones that decide whether this module can
 * later be trusted to carry a verdict:
 *
 * - it is VERDICT-LESS — asserted by absence, not by comment;
 * - it emits an EXPLICIT canonical log identity, and two fundings in one
 * transaction get DISTINCT ids (the property, end to end);
 * - it refuses a correctly-shaped event from the WRONG contract (the
 * defect shape, which is the whole reason the promise bar was raised);
 * - it attributes rather than guesses — an unreadable escrow struct and an
 * unknown address are COUNTED and skipped;
 * - one canonical log identity produces at most one row;
 * - the cursor never advances past a failure, and `cursorAdvanced` is its own
 * reported fact rather than "no errors" inferred.
 *
 * The registry is bound to the deployment file and to keccak of the real
 * signatures, so a copied address or a stale topic fails HERE rather than
 * silently producing a healthy-looking empty population.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import {
  INSTITUTION_ADDRESSES,
  INSTITUTION_FUNDING_EVENTS,
  INSTITUTION_FUNDING_ACTION_TYPES,
  INSTITUTION_CONFIRMATION_FLOOR,
  INSTITUTION_EMISSION_LOCK_COLLECTION,
  INSTITUTION_WATCHER_CHAIN_ID,
  buildLinkedEvidenceMetadata,
  canonicalLogIdentity,
  decodeEscrowDepositor,
  decodeInstitutionFundingLog,
  emptyInstitutionWatcherReport,
  evaluateFundingVerdict,
  finalizedThroughBlock,
  institutionLogFilters,
  normalizeBlockChunk,
  buildBaseInstitutionWatcherDeps,
  makeTransactionalEmitter,
  processDecodedFunding,
  runInstitutionFundingWatcherCycle,
  scanInstitutionFundingRange,
  type InstitutionFundingEmission,
  type InstitutionWatcherDeps,
} from './institution-funding-watcher';

const TX_A = `0x${'a1'.repeat(32)}`;
const LENDER = '0x1111111111111111111111111111111111111111';
const CONTRIBUTOR = '0x2222222222222222222222222222222222222222';
const DEPOSITOR = '0x3333333333333333333333333333333333333333';
/**. A well-formed safe-block hash. Lowercase — the guard requires it. */
const SAFE_HASH = `0x${'5e'.repeat(32)}`;
const ENTITY = `0x${'cd'.repeat(32)}`;

const topicOf = (sig: string) => ethers.id(sig);
const addrTopic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');

function log(over: Partial<CanonicalEconomicLog> = {}): CanonicalEconomicLog {
  return {
    address: INSTITUTION_ADDRESSES.promise,
    topics: [topicOf('PromiseFunded(bytes32,address,uint256)'), ENTITY, addrTopic(LENDER)],
    data: `0x${word(10_000_000n)}`,
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
// REGISTRY — bound to reality, not to a copied list
// =============================================================================

describe('institution watcher — the registry is bound to deployed reality', () => {
  it('covers a non-empty set of six events across three institutions', () => {
    // A universally-quantified claim over zero specs proves nothing.
    expect(INSTITUTION_FUNDING_EVENTS.length).toBe(6);
    expect(new Set(INSTITUTION_FUNDING_EVENTS.map((s) => s.institution)).size).toBe(3);
  });

  it('addresses match the deployment file byte-for-byte (lowercased)', () => {
    // Bound to the artifact, not to a hand-copied address. A redeploy that
    // updates the deployment file and not this module fails HERE, rather than
    // producing a watcher that scans a dead contract and reports 0 fundings.
    const deployed = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../contracts/deployments/base-pvt9-institutions.json'),
      'utf8',
    )) as { chainId: number; contracts: Record<string, { address: string }> };

    expect(deployed.chainId).toBe(INSTITUTION_WATCHER_CHAIN_ID);
    expect(INSTITUTION_ADDRESSES.escrow).toBe(deployed.contracts.escrowV4.address.toLowerCase());
    expect(INSTITUTION_ADDRESSES.promise).toBe(deployed.contracts.promiseV3.address.toLowerCase());
    expect(INSTITUTION_ADDRESSES.pool).toBe(deployed.contracts.poolV3.address.toLowerCase());
  });

  it('every topic0 is keccak of its own declared signature', () => {
    for (const s of INSTITUTION_FUNDING_EVENTS) {
      expect(s.topic0).toBe(ethers.id(s.signature));
    }
  });

  it('pins the six topic0s to their independently-verified values', () => {
    // Derivation alone would pass even if a signature were wrong, so the
    // expected hashes are pinned. These were verified against the contract
    // sources in contracts/src at.
    const byName = Object.fromEntries(
      INSTITUTION_FUNDING_EVENTS.map((s) => [s.signature, s.topic0]),
    );
    expect(byName['EscrowFunded(bytes32,uint256)'])
      .toBe('0x08bc5e5162ba9d1a558b2d254f4739d54c8d7051230419652b328670bd68fc37');
    expect(byName['PoolContribution(bytes32,address,uint256,uint256)'])
      .toBe('0x4a18a233a981120c69a91b1db128d4f5b4316a783441f813ea43795d4bfb4851');
    expect(byName['PromiseFunded(bytes32,address,uint256)'])
      .toBe('0x523f6e91392dd9b121a823e5a043b173faa8cc35cc073a4888bd260e55b2cba9');
  });

  it('collapses to ONE combined filter across all three contracts ', () => {
    const f = institutionLogFilters();
    // Exactly the three deployed contract addresses...
    expect([...f.addresses].sort()).toEqual(
      [INSTITUTION_ADDRESSES.escrow, INSTITUTION_ADDRESSES.pool, INSTITUTION_ADDRESSES.promise].sort(),
    );
    // ...and EVERY funding topic0 (all six) — so the combined query's coverage is
    // exactly the union the three per-contract queries had.
    expect(new Set(f.topic0s)).toEqual(new Set(INSTITUTION_FUNDING_EVENTS.map((s) => s.topic0)));
    expect(f.topic0s.length).toBe(6);
  });

  it('the declared action-type list matches the registry exactly', () => {
    // The audit surface's static emitter scan cannot see this module: it emits
    // via a registry lookup, not an `actionType: '<literal>'` site. Making it
    // visible would move the action-policy matrix's declared content_sha256,
    // which check:wp2 refuses outside the Stage 2 supersession. This assertion
    // is the LOCAL substitute for that missing inventory entry: the declared
    // list and the registry cannot drift apart silently.
    expect([...INSTITUTION_FUNDING_ACTION_TYPES].sort())
      .toEqual([...new Set(INSTITUTION_FUNDING_EVENTS.map((s) => s.actionType))].sort());
    expect(INSTITUTION_FUNDING_ACTION_TYPES.length).toBe(3);
  });

  it('only escrow needs a struct read; pool and promise name their actor', () => {
    for (const s of INSTITUTION_FUNDING_EVENTS) {
      if (s.institution === 'escrow') expect(s.actorTopicIndex).toBeNull();
      else expect(s.actorTopicIndex).toBe(2);
    }
  });
});

// =============================================================================
// CANONICAL IDENTITY
// =============================================================================

describe('institution watcher — canonical log identity', () => {
  it('is chainId:txHash:logIndex, never the tx hash alone', () => {
    expect(canonicalLogIdentity(8453, TX_A, 7)).toBe(`8453:${TX_A}:7`);
  });

  it('distinguishes two fundings in ONE transaction', () => {
    // The property at the emitter: same tx, different log index.
    expect(canonicalLogIdentity(8453, TX_A, 7))
      .not.toBe(canonicalLogIdentity(8453, TX_A, 12));
  });

  it('refuses a malformed tx hash or a negative log index', () => {
    expect(() => canonicalLogIdentity(8453, '0xdeadbeef', 1)).toThrow();
    expect(() => canonicalLogIdentity(8453, TX_A, -1)).toThrow();
    expect(() => canonicalLogIdentity(0, TX_A, 1)).toThrow();
  });
});

// =============================================================================
// DECODING
// =============================================================================

describe('institution watcher — decoding', () => {
  it('decodes a promise funding and takes the LENDER from the log', () => {
    const d = decodeInstitutionFundingLog(log());
    expect(d).not.toBeNull();
    expect(d!.spec.actionType).toBe('promise_funded');
    expect(d!.actorAddress).toBe(LENDER);
    expect(d!.amountAtomic).toBe(10_000_000n);
    expect(d!.canonicalEventId).toBe(`8453:${TX_A}:7`);
  });

  it('decodes a pool contribution and takes the CONTRIBUTOR', () => {
    const d = decodeInstitutionFundingLog(log({
      address: INSTITUTION_ADDRESSES.pool,
      topics: [
        topicOf('PoolContribution(bytes32,address,uint256,uint256)'),
        ENTITY,
        addrTopic(CONTRIBUTOR),
      ],
      data: `0x${word(5_000_000n)}${word(9_000_000n)}`,
    }));
    expect(d!.actorAddress).toBe(CONTRIBUTOR);
    expect(d!.amountAtomic).toBe(5_000_000n);
  });

  it('decodes an escrow funding with NO actor — the event does not name one', () => {
    const d = decodeInstitutionFundingLog(log({
      address: INSTITUTION_ADDRESSES.escrow,
      topics: [topicOf('EscrowFunded(bytes32,uint256)'), ENTITY],
      data: `0x${word(4_200_000n)}`,
    }));
    expect(d).not.toBeNull();
    expect(d!.actorAddress).toBeNull();
    expect(d!.spec.actionType).toBe('escrow_funded');
  });

  it('REFUSES a correctly-shaped event from the WRONG contract', () => {
    // The defect shape: an attacker emitting a real-looking PromiseFunded
    // from their own contract. Topic match alone must never be enough.
    const d = decodeInstitutionFundingLog(log({
      address: '0x9999999999999999999999999999999999999999',
    }));
    expect(d).toBeNull();
  });

  it('refuses a removed (reorged-out) log', () => {
    expect(decodeInstitutionFundingLog(log({ removed: true }))).toBeNull();
  });

  it('refuses an unrelated topic on a watched contract', () => {
    expect(decodeInstitutionFundingLog(log({
      topics: [topicOf('SomethingElse(uint256)'), ENTITY, addrTopic(LENDER)],
    }))).toBeNull();
  });

  it('refuses truncated data rather than reading a short amount', () => {
    expect(decodeInstitutionFundingLog(log({ data: '0x00' }))).toBeNull();
  });

  it('decodes the escrow depositor from struct word 0, and refuses a short return', () => {
    const raw = `0x${addrTopic(DEPOSITOR).slice(2)}${word(0n)}${word(1n)}`;
    expect(decodeEscrowDepositor(raw)).toBe(DEPOSITOR);
    expect(decodeEscrowDepositor(`0x${addrTopic(DEPOSITOR).slice(2)}`)).toBeNull();
  });
});

// =============================================================================
// FINALITY
// =============================================================================

describe('institution watcher — finality floor', () => {
  it('is inclusive at exactly 12 confirmations', () => {
    expect(INSTITUTION_CONFIRMATION_FLOOR).toBe(12);
    // head 1011 -> a log in 1000 has 12 confirmations and IS eligible.
    expect(finalizedThroughBlock(1_011)).toBe(1_000);
  });

  it('yields nothing on a chain too short to have a final block', () => {
    expect(finalizedThroughBlock(5)).toBeNull();
  });
});

// =============================================================================
// VERDICT-LESS — asserted by absence
// =============================================================================

describe('institution watcher — THE VERDICT IS EARNED, NEVER ASSERTED ', () => {
  const funding = decodeInstitutionFundingLog(log())!;
  /**
   * No witness, but a resolved counterparty — so these exercise the WITNESS
   * conditions rather than tripping the counterparty check first.
   */
  const emission: InstitutionFundingEmission = {
    funding,
    actorAddress: LENDER,
    counterpartyAddress: CONTRIBUTOR,
    walletId: 'w1',
    agentId: 'a1',
  };
  /** funding.blockNumber is 1_000, so a head of 1_011 finalizes through 1_000. */
  const HEAD = funding.blockNumber + INSTITUTION_CONFIRMATION_FLOOR - 1;
  const witnessed = (over: Partial<{
    head: number;
    finalizedThrough: number;
    observedBlock: number;
    safeHead: { number: number; hash: string } | undefined;
  }> = {}) => {
    const w = {
      head: HEAD,
      finalizedThrough: finalizedThroughBlock(HEAD)!,
      observedBlock: funding.blockNumber,
      //. Exactly at this funding's block: the boundary is inclusive, so
      // the default witness sits ON the safe head rather than comfortably under
      // it. A test that only ever passed with slack would not notice an
      // off-by-one turning the guard into a no-op.
      safeHead: { number: funding.blockNumber, hash: SAFE_HASH } as
        { number: number; hash: string } | undefined,
      ...over,
    };
    if (w.safeHead === undefined) delete (w as { safeHead?: unknown }).safeHead;
    return { ...emission, finalityWitness: w };
  };

  it('NO COUNTERPARTY -> NO STAMP, and it is checked FIRST ', () => {
    // The condition whose absence is SILENT: without a counterparty
    // `detectSameOwnerTransfer` never runs, so a row would pay while its
    // `record_only_if_self_shared_or_churn` policy looked satisfied. Checked
    // ahead of the witness so a fully-witnessed emission still cannot pay
    // without it.
    const { counterpartyAddress: _drop, ...noCounterparty } = witnessed();
    expect(evaluateFundingVerdict(noCounterparty)).toEqual({
      verified: false,
      reason: 'counterparty_unresolved',
    });
    const meta = buildLinkedEvidenceMetadata(noCounterparty, 8453);
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('counterparty_unresolved');
    expect(meta.counterparty_address).toBeNull();
  });

  it('a resolved counterparty is SEALED INTO THE ROW, auditable from the PE alone', () => {
    const meta = buildLinkedEvidenceMetadata(witnessed(), 8453);
    expect(meta.counterparty_address).toBe(CONTRIBUTOR);
  });

  it('NO WITNESS -> NO STAMP. The default is a refusal, not a grant', () => {
    const meta = buildLinkedEvidenceMetadata(emission, 8453);
    expect(Object.prototype.hasOwnProperty.call(meta, 'verified')).toBe(false);
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('no_finality_witness');
    expect(evaluateFundingVerdict(emission)).toEqual({
      verified: false,
      reason: 'no_finality_witness',
    });
  });

  it('carries NO key that pe-utils would read as a verdict when refused', () => {
    // Bound to the actual production stamp rather than to the word "verified":
    // pe-utils seals evidenceState from `metadata.verified === true` only.
    const meta = buildLinkedEvidenceMetadata(emission, 8453);
    const verdictish = Object.keys(meta).filter((k) => /^verified$/i.test(k));
    expect(verdictish).toEqual([]);
  });

  it('A VALID WITNESS EARNS THE STAMP — and it is exactly `true`, not truthy', () => {
    const meta = buildLinkedEvidenceMetadata(witnessed(), 8453);
    // pe-utils tests `=== true`. Anything else is a silent refusal.
    expect(meta.verified).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(meta, 'evidence_verdict_refused')).toBe(false);
    // The basis is sealed INTO the row, so a later reader can re-check it.
    expect(meta.finality_witness_head).toBe(HEAD);
    expect(meta.finality_witness_finalized_through).toBe(funding.blockNumber);
  });

  it('REFUSES a witness about a DIFFERENT block — one funding cannot ride another', () => {
    const meta = buildLinkedEvidenceMetadata(witnessed({ observedBlock: funding.blockNumber - 1 }), 8453);
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('witness_block_mismatch');
  });

  it('REFUSES a ceiling its own head does not derive — the value is recomputed, not trusted', () => {
    // A caller inflating the ceiling to cover an unconfirmed block. The head is
    // untouched, so `finalizedThroughBlock(head)` no longer reproduces it.
    const meta = buildLinkedEvidenceMetadata(
      witnessed({ finalizedThrough: funding.blockNumber + 500 }),
      8453,
    );
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('witness_ceiling_not_derived');
  });

  it('REFUSES a funding under the 12-confirmation floor, witness otherwise honest', () => {
    // Head one block too low: the ceiling derives correctly, and this funding is
    // simply not final yet.
    const shallow = HEAD - 1;
    const meta = buildLinkedEvidenceMetadata(
      witnessed({ head: shallow, finalizedThrough: finalizedThroughBlock(shallow)! }),
      8453,
    );
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('below_confirmation_floor');
    // Exactly at the floor it IS granted — the boundary is inclusive, asserted
    // so the refusal above cannot be an off-by-one masquerading as a guard.
    expect(buildLinkedEvidenceMetadata(witnessed(), 8453).verified).toBe(true);
  });

  // ===========================================================================
  // THE REORG FLOOR — the standing rule, RED by reintroduction.
  //
  // "A stamp granted on an unsafe-head-only event must be impossible." Each of
  // these constructs exactly that event — one that WOULD have been stamped under
  // the / rule — and asserts it is refused now. They are the negative
  // controls: every one of them was observed RED against the pre- module
  // (11 tests failed closed the moment the guard landed), so none of them is a
  // guard that cannot fail.
  // ===========================================================================

  it('RED — a funding PAST 12 confirmations but ABOVE the safe head earns NOTHING', () => {
    // THE DEFECT ITSELF. The old rule's whole basis: head is 11 blocks past the
    // funding, so `finalizedThroughBlock` covers it and every pre- check
    // passes. The L1 batch has not landed, so the sequencer alone can still
    // erase it — and the emission lock would make the resulting priced row
    // permanent.
    const meta = buildLinkedEvidenceMetadata(
      witnessed({ safeHead: { number: funding.blockNumber - 1, hash: SAFE_HASH } }),
      8453,
    );
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('above_safe_head');
    // And the old floor genuinely WAS satisfied — otherwise this test would be
    // proving the 12-confirmation check, not the new one.
    expect(funding.blockNumber).toBeLessThanOrEqual(finalizedThroughBlock(HEAD)!);
  });

  it('RED — a witness with NO safe head at all is refused, not defaulted', () => {
    // The upgrade path's failure mode: a caller still building the witness
    // shape. Absence must be a refusal, never "fall back to the block count".
    const meta = buildLinkedEvidenceMetadata(witnessed({ safeHead: undefined }), 8453);
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('no_safe_head_witness');
  });

  it('RED — a malformed safe-block hash cannot stand in for one', () => {
    // A caller synthesising a witness to clear the guard. The number alone is
    // not the claim; the hash is what names WHICH batched tip was consulted.
    for (const hash of ['', '0xdeadbeef', `0x${'5E'.repeat(32)}`]) {
      const meta = buildLinkedEvidenceMetadata(
        witnessed({ safeHead: { number: funding.blockNumber, hash } }),
        8453,
      );
      expect(meta.evidence_verdict_refused).toBe('no_safe_head_witness');
    }
  });

  it('RED — a safe head LEADING the unsafe head is incoherent and refused', () => {
    // The inflation move, now that the safe head is the binding constraint: a
    // caller claiming an L1-batched tip ahead of the sequencer tip. Refused on
    // shape rather than reconciled.
    const meta = buildLinkedEvidenceMetadata(
      witnessed({ safeHead: { number: HEAD + 1, hash: SAFE_HASH } }),
      8453,
    );
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('safe_head_leads_head');
  });

  it('GRANTS at the safe head exactly, and seals WHICH tip it rested on', () => {
    // The inclusive boundary, so the refusals above cannot be an off-by-one
    // masquerading as a guard — and the basis is sealed for a later reader.
    const meta = buildLinkedEvidenceMetadata(witnessed(), 8453);
    expect(meta.verified).toBe(true);
    expect(meta.finality_witness_safe_head).toBe(funding.blockNumber);
    expect(meta.finality_witness_safe_hash).toBe(SAFE_HASH);
  });

  it('the safe head can only RESTRICT — it never rescues a failing older check', () => {
    // Conjunction, not replacement. A deep safe head must not paper over a
    // funding that has not cleared the 12-confirmation floor.
    const shallow = HEAD - 1;
    const meta = buildLinkedEvidenceMetadata(
      witnessed({
        head: shallow,
        finalizedThrough: finalizedThroughBlock(shallow)!,
        safeHead: { number: shallow, hash: SAFE_HASH },
      }),
      8453,
    );
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('below_confirmation_floor');
  });

  it('supplies the EXPLICIT canonical event id alongside the tx hash', () => {
    // Post- the explicit id outranks tx_hash. Both are carried: the id for
    // identity, the tx hash for provenance.
    const meta = buildLinkedEvidenceMetadata(emission, 8453);
    expect(meta.canonical_event_id).toBe(`8453:${TX_A}:7`);
    expect(meta.tx_hash).toBe(TX_A);
    expect(meta.log_index).toBe(7);
  });
});

// =============================================================================
// ATTRIBUTION AND EXACTLY-ONCE
// =============================================================================

interface Harness {
  db: FakeFirestore;
  deps: InstitutionWatcherDeps;
  emitted: InstitutionFundingEmission[];
  locks: Set<string>;
  logsByRange: CanonicalEconomicLog[];
  headValue: number;
  /**
   *. The L1-batched safe head the harness reports. `undefined` here means
   * the deps carry NO `readSafeHead` at all — the fail-closed shape — while
   * `null` means the reader answered "no safe block yet".
   */
  safeHeadValue: number | null | undefined;
  /**. The reader itself throwing — a quorum disagreement on `safe`. */
  failSafeHead: boolean;
  failGetLogs: boolean;
  structReturn: string | null;
  knownAddresses: Set<string>;
}

function harness(over: Partial<Harness> = {}): Harness {
  const db = createFakeFirestore();
  const h: Harness = {
    db,
    emitted: [],
    locks: new Set<string>(),
    logsByRange: [],
    headValue: 1_011,
    // Deep enough that the 12-confirmation ceiling (1_000) is what binds by
    // default, so every pre- cycle assertion keeps testing what it tested.
    safeHeadValue: 1_000,
    failSafeHead: false,
    failGetLogs: false,
    // depositor(word 0), recipient/counterparty(word 1), amount(word 2).
    // Word 1 is a REAL address: reads it as the economic counterparty and
    // refuses the stamp on a zero, so a zero here would silently make every
    // cycle-level stamp assertion below unreachable.
    structReturn: `0x${addrTopic(DEPOSITOR).slice(2)}${addrTopic(CONTRIBUTOR).slice(2)}${word(1n)}`,
    knownAddresses: new Set([LENDER, CONTRIBUTOR, DEPOSITOR]),
    deps: null as unknown as InstitutionWatcherDeps,
    ...over,
  };
  h.deps = {
    db: db as unknown as InstitutionWatcherDeps['db'],
    chainId: 8453,
    readHead: async () => h.headValue,
    ...(h.safeHeadValue === undefined ? {} : {
      // Read at CALL time, not capture time, so a test can advance the safe
      // head between cycles the way L1 batching actually does.
      readSafeHead: async () => {
        if (h.failSafeHead) throw new Error('quorum disagreement');
        const v = h.safeHeadValue;
        return v === null || v === undefined ? null : { number: v, hash: SAFE_HASH };
      },
    }),
    getLogs: async (f) => {
      if (h.failGetLogs) throw new Error('failed to meet quorum');
      // Faithful RPC: honor BOTH the address filter (single or array —) AND
      // the topic0-OR at position 0, so dropping any contract's address or any
      // event's topic0 from the filter provably drops its logs (the coverage RED).
      const addrs = typeof f.address === 'string' ? [f.address] : f.address;
      const t0 = f.topics[0];
      const topic0Set = t0 == null
        ? null
        : new Set(typeof t0 === 'string' ? [t0] : t0);
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
      const key = e.funding.canonicalEventId;
      if (h.locks.has(key)) return { emitted: false };
      h.locks.add(key);
      h.emitted.push(e);
      await db.collection(INSTITUTION_EMISSION_LOCK_COLLECTION)
        .doc(key).set({ canonical_event_id: key });
      return { emitted: true, peId: `pe_${h.emitted.length}` };
    },
    now: () => 1_700_000_000_000,
  };
  return h;
}

describe('institution watcher — attribution refuses to guess', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('reads the escrow depositor via the struct when the log names no actor', async () => {
    const funding = decodeInstitutionFundingLog(log({
      address: INSTITUTION_ADDRESSES.escrow,
      topics: [topicOf('EscrowFunded(bytes32,uint256)'), ENTITY],
      data: `0x${word(1n)}`,
    }))!;
    const report = emptyInstitutionWatcherReport();
    await processDecodedFunding(h.deps, funding, report);

    expect(report.emitted).toBe(1);
    expect(h.emitted[0].actorAddress).toBe(DEPOSITOR);
  });

  it('COUNTS and skips an escrow whose struct read fails — never guesses', async () => {
    h.structReturn = null;
    const funding = decodeInstitutionFundingLog(log({
      address: INSTITUTION_ADDRESSES.escrow,
      topics: [topicOf('EscrowFunded(bytes32,uint256)'), ENTITY],
      data: `0x${word(1n)}`,
    }))!;
    const report = emptyInstitutionWatcherReport();
    await processDecodedFunding(h.deps, funding, report);

    expect(report.structReadFailures).toBe(1);
    expect(report.emitted).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it('COUNTS and skips a funding by an address no Provian wallet holds', async () => {
    h.knownAddresses.clear();
    const report = emptyInstitutionWatcherReport();
    await processDecodedFunding(h.deps, decodeInstitutionFundingLog(log())!, report);

    expect(report.unattributed).toBe(1);
    expect(report.emitted).toBe(0);
  });
});

describe('institution watcher — one canonical log identity, one row', () => {
  it('emits once and reports the replay as a duplicate, not a second row', async () => {
    const h = harness();
    const funding = decodeInstitutionFundingLog(log())!;
    const report = emptyInstitutionWatcherReport();

    await processDecodedFunding(h.deps, funding, report);
    await processDecodedFunding(h.deps, funding, report);

    expect(report.emitted).toBe(1);
    expect(report.duplicatesSkipped).toBe(1);
    expect(h.emitted).toHaveLength(1);
  });

  it('two fundings in ONE transaction both emit — they are distinct events', async () => {
    const h = harness();
    const report = emptyInstitutionWatcherReport();
    // Same tx hash, different log index. Keying on the tx would drop one.
    await processDecodedFunding(h.deps, decodeInstitutionFundingLog(log({ logIndex: 7 }))!, report);
    await processDecodedFunding(h.deps, decodeInstitutionFundingLog(log({ logIndex: 12 }))!, report);

    expect(report.emitted).toBe(2);
    expect(report.duplicatesSkipped).toBe(0);
    expect(new Set(h.emitted.map((e) => e.funding.canonicalEventId)).size).toBe(2);
  });
});

// =============================================================================
// SCAN + CURSOR
// =============================================================================

describe('institution watcher — scanning and the cursor', () => {
  it('never requests a range wider than the chunk', async () => {
    const h = harness();
    const widths: number[] = [];
    const deps = {
      ...h.deps,
      getLogs: async (f: { fromBlock: number; toBlock: number }) => {
        widths.push(f.toBlock - f.fromBlock + 1);
        return [];
      },
    } as InstitutionWatcherDeps;

    await scanInstitutionFundingRange(deps, {
      fromBlock: 1, toBlock: 95, blockChunk: 10, report: emptyInstitutionWatcherReport(),
    });

    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeLessThanOrEqual(10);
  });

  it('200 to 500 block windows preserve emissions and complete coverage with fewer RPC windows',async()=>{
    const records=[log({blockNumber:250}),log({blockNumber:999,logIndex:8})];
    async function run(chunk:number){const h=harness();let windows=0;
      const deps={...h.deps,getLogs:async(f:{fromBlock:number;toBlock:number})=>{windows++;return records.filter(x=>x.blockNumber>=f.fromBlock&&x.blockNumber<=f.toBlock);}} as InstitutionWatcherDeps;
      const end=await scanInstitutionFundingRange(deps,{fromBlock:1,toBlock:1000,blockChunk:chunk,report:emptyInstitutionWatcherReport()});
      return {windows,end,emitted:h.emitted};
    }
    const old=await run(200),next=await run(500);expect(old.windows).toBe(5);expect(next.windows).toBe(2);expect(next.end).toBe(old.end);expect(next.emitted).toEqual(old.emitted);expect(next.emitted).toHaveLength(2);
  });

  it('holds the cursor at the failing chunk instead of skipping past it', async () => {
    const h = harness();
    h.failGetLogs = true;
    const minFailed = await scanInstitutionFundingRange(h.deps, {
      fromBlock: 100, toBlock: 129, blockChunk: 10, report: emptyInstitutionWatcherReport(),
    });
    expect(minFailed).toBe(100);
  });

  it('reports MAX_SAFE_INTEGER when the whole range was handled', async () => {
    const h = harness();
    const minFailed = await scanInstitutionFundingRange(h.deps, {
      fromBlock: 100, toBlock: 129, blockChunk: 10, report: emptyInstitutionWatcherReport(),
    });
    expect(minFailed).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a cold start begins at the finality ceiling, not at genesis', async () => {
    const h = harness();
    const report = await runInstitutionFundingWatcherCycle(h.deps);
    // head 1011 -> finalized through 1000; no checkpoint -> from == 1000.
    expect(report.finalizedThrough).toBe(1_000);
    expect(report.cursorFrom).toBe(1_000);
  });

  it('reports cursorAdvanced as its OWN fact, and emits what it finds', async () => {
    const h = harness();
    h.logsByRange = [log({ blockNumber: 1_000 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(1);
    expect(report.cursorAdvanced).toBe(true);
    expect(report.cursorTo).toBe(1_000);
  });

  // ===========================================================================
  // THE CYCLE ACTUALLY GRANTS THE STAMP (, found by the 1d reviewer leg)
  //
  // Every other stamp assertion in this repo calls `buildLinkedEvidenceMetadata`
  // / `evaluateFundingVerdict` directly, or hand-builds a witness and drives
  // `makeTransactionalEmitter`. NONE of them covered the production wiring
  // cycle -> scanInstitutionFundingRange -> processDecodedFunding -> witness.
  // Deleting the single `finality: { head, finalizedThrough: finalized }` line
  // from the cycle left the entire battery 68/68 GREEN while the funding trio
  // silently stopped paying. These close that: they assert the row the CYCLE
  // produced is stamped, and that `stampRefusals` the line added so a
  // silently-unstamped cycle is visible — actually moves.
  // ===========================================================================

  it('a row emitted BY THE CYCLE carries the witness and is STAMPED', async () => {
    const h = harness();
    h.logsByRange = [log({ blockNumber: 1_000 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(1);
    expect(report.stampRefusals).toBe(0);

    const emission = h.emitted[0];
    // The witness the CYCLE built, from the head IT read.
    expect(emission.finalityWitness).toEqual({
      head: 1_011,
      finalizedThrough: 1_000,
      observedBlock: 1_000,
      //. The safe head the CYCLE read, not a hand-built one.
      safeHead: { number: 1_000, hash: SAFE_HASH },
    });
    // And it earns the verdict — asserted through the same function production
    // uses to build the row, not by re-deriving the rule here.
    expect(evaluateFundingVerdict(emission)).toEqual({ verified: true });
    expect(buildLinkedEvidenceMetadata(emission, 8453).verified).toBe(true);
  });

  it('the cycle REFUSES the stamp when the counterparty struct reads zero', async () => {
    // The refusal path reachable end to end: the cycle only ever scans blocks
    // at or under the ceiling, so the finality refusals cannot fire here — this
    // is what makes `stampRefusals` a real, moving report line rather than a
    // constant 0.
    const h = harness();
    // The default log is a PROMISE funding, whose counterparty is the BORROWER
    // at struct word 0 (`Promise { borrower(0), lender(1), … }`) — so word 0 is
    // the one to zero out here. Getting this wrong is silent: the test would
    // read a real address and pass while asserting nothing.
    h.structReturn = `0x${word(0n)}${addrTopic(DEPOSITOR).slice(2)}${word(1n)}`;
    h.logsByRange = [log({ blockNumber: 1_000 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(1);
    expect(report.counterpartyReadFailures).toBe(1);
    expect(report.stampRefusals).toBe(1);
    // It still RECORDED — the refusal costs the payment, not the provenance.
    const meta = buildLinkedEvidenceMetadata(h.emitted[0], 8453);
    expect(meta.verified).toBeUndefined();
    expect(meta.evidence_verdict_refused).toBe('counterparty_unresolved');
  });

  // ===========================================================================
  // THE REORG FLOOR BOUNDS THE SCAN
  //
  // Stamping alone would have been a TRAP, and these are what prove it isn't one.
  // Emission is once-per-canonical-event and fenced correction, so a row
  // emitted above the safe head would refuse its stamp FOREVER — sealed at 0,
  // holding the lock that stops any later cycle from re-emitting it once L1
  // batching catches up. The block must not be reached at all until it is safe.
  // ===========================================================================

  it('does NOT emit a funding above the safe head — it WAITS for it', async () => {
    // Head 1_011 finalizes through 1_000, so the old ceiling covers this
    // funding. The safe head is one block short. Pre- this emitted and
    // paid; the danger now would be emitting it UNSTAMPED and permanently so.
    const h = harness({ safeHeadValue: 999 });
    h.logsByRange = [log({ blockNumber: 1_000 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(0);
    expect(report.stampRefusals).toBe(0);
    expect(h.locks.size).toBe(0);
    // Visible as its own fact: waiting on L1 batching, not stalled.
    expect(report.safeHead).toBe(999);
    expect(report.safeHeadBoundedScan).toBe(true);
  });

  it('and emits it on a LATER cycle once the batch lands — deferred, not lost', async () => {
    // The other half of the claim above. A funding withheld for safety that is
    // never picked up afterwards is not caution, it is a silent drop.
    const h = harness({ safeHeadValue: 999 });
    h.logsByRange = [log({ blockNumber: 1_000 })];
    await runInstitutionFundingWatcherCycle(h.deps);
    expect(h.emitted).toHaveLength(0);

    h.safeHeadValue = 1_000;
    const second = await runInstitutionFundingWatcherCycle(h.deps);
    expect(second.emitted).toBe(1);
    expect(second.stampRefusals).toBe(0);
    // And it is STAMPED — the whole point of having waited.
    expect(evaluateFundingVerdict(h.emitted[0])).toEqual({ verified: true });
  });

  it('FAIL-CLOSED: no safe-head reader at all -> scans nothing', async () => {
    // A hand-built deps object that predates. It must refuse to work
    // rather than fall back to the 12-confirmation ceiling, which is the exact
    // defect being fixed.
    const h = harness({ safeHeadValue: undefined });
    h.logsByRange = [log({ blockNumber: 1_000 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);
    expect(report.emitted).toBe(0);
    expect(report.cursorAdvanced).toBe(false);
    expect(report.safeHead).toBeNull();
  });

  it('FAIL-CLOSED: a chain with no safe block yet, and a throwing reader', async () => {
    // Both non-answers. A quorum disagreement on `safe` is exactly the case a
    // fallback would paper over, so it must scan nothing too.
    const cases = [harness({ safeHeadValue: null }), harness({ failSafeHead: true })];
    expect(cases).toHaveLength(2);
    for (const h of cases) {
      h.logsByRange = [log({ blockNumber: 1_000 })];
      const report = await runInstitutionFundingWatcherCycle(h.deps);
      expect(report.emitted).toBe(0);
      expect(report.cursorAdvanced).toBe(false);
      expect(report.safeHead).toBeNull();
    }
  });

  it('a cold start begins at the SAFE ceiling when it is the lower of the two', async () => {
    const h = harness({ safeHeadValue: 980 });
    const report = await runInstitutionFundingWatcherCycle(h.deps);
    expect(report.finalizedThrough).toBe(1_000);
    expect(report.cursorFrom).toBe(980);
  });

  it('does NOT report cursorAdvanced when there was nothing new to process', async () => {
    const h = harness();
    await runInstitutionFundingWatcherCycle(h.deps);
    // Second cycle at the same head: cursor is already at the ceiling.
    const second = await runInstitutionFundingWatcherCycle(h.deps);
    expect(second.cursorAdvanced).toBe(false);
  });

  it('returns early and advances nothing on a chain with no final block', async () => {
    const h = harness({ headValue: 3 });
    const report = await runInstitutionFundingWatcherCycle(h.deps);
    expect(report.finalizedThrough).toBeNull();
    expect(report.cursorAdvanced).toBe(false);
    expect(report.emitted).toBe(0);
  });
});

// =============================================================================
// POPULATION CORROBORATION
// =============================================================================

describe('institution watcher — one-call scan: coverage identical to the per-contract scan', () => {
  let h: Harness;
  const B = 105; // inside the scan range [100,129]
  const escrowLog = (): CanonicalEconomicLog => log({
    address: INSTITUTION_ADDRESSES.escrow,
    topics: [topicOf('EscrowFunded(bytes32,uint256)'), ENTITY],
    data: `0x${word(4_200_000n)}`, blockNumber: B, logIndex: 1,
  });
  const promiseLog = (): CanonicalEconomicLog => log({
    address: INSTITUTION_ADDRESSES.promise,
    topics: [topicOf('PromiseFunded(bytes32,address,uint256)'), ENTITY, addrTopic(LENDER)],
    data: `0x${word(10_000_000n)}`, blockNumber: B, logIndex: 2,
  });
  const poolLog = (): CanonicalEconomicLog => log({
    address: INSTITUTION_ADDRESSES.pool,
    topics: [topicOf('PoolContribution(bytes32,address,uint256,uint256)'), ENTITY, addrTopic(CONTRIBUTOR)],
    data: `0x${word(5_000_000n)}${word(9_000_000n)}`, blockNumber: B, logIndex: 3,
  });

  beforeEach(() => {
    h = harness();
    h.logsByRange = [escrowLog(), promiseLog(), poolLog()];
  });

  it('GREEN: ONE combined getLogs surfaces all three contracts, and the scan emits all three', async () => {
    const report = emptyInstitutionWatcherReport();
    await scanInstitutionFundingRange(h.deps, {
      fromBlock: 100, toBlock: 129, blockChunk: 10, report,
      finality: { head: 1_011, finalizedThrough: 1_000, safeHead: { number: 1_000, hash: SAFE_HASH } },
    });
    expect(report.fundingsDecoded).toBe(3);
    expect(new Set(h.emitted.map((e) => e.funding.spec.institution)))
      .toEqual(new Set(['escrow', 'promise', 'pool']));
  });

  it('RED coverage control: dropping ANY one contract (address or topic0) from the combined filter makes its fundings vanish', async () => {
    const { addresses, topic0s } = institutionLogFilters();

    // The real combined filter surfaces ALL THREE — the coverage the per-contract scan had.
    const all = await h.deps.getLogs({ address: addresses, topics: [topic0s], fromBlock: 100, toBlock: 129 });
    expect(new Set(all.map((l) => l.address))).toEqual(
      new Set([INSTITUTION_ADDRESSES.escrow, INSTITUTION_ADDRESSES.promise, INSTITUTION_ADDRESSES.pool]),
    );

    // Drop each contract's ADDRESS in turn — exactly that contract's funding disappears.
    // (If institutionLogFilters ever stopped emitting one address, the GREEN test above
    //  would see 2, not 3 — this proves that regression cannot pass silently.)
    for (const dropped of addresses) {
      const degraded = addresses.filter((a) => a !== dropped);
      const logs = await h.deps.getLogs({ address: degraded, topics: [topic0s], fromBlock: 100, toBlock: 129 });
      expect(logs.map((l) => l.address)).not.toContain(dropped);
      expect(logs.length).toBe(2);
    }

    // Drop a single event's TOPIC0 — that event vanishes too (the topic-OR is load-bearing).
    const withoutEscrowTopic = topic0s.filter((t) => t !== topicOf('EscrowFunded(bytes32,uint256)'));
    const noEscrow = await h.deps.getLogs({ address: addresses, topics: [withoutEscrowTopic], fromBlock: 100, toBlock: 129 });
    expect(noEscrow.map((l) => l.address)).not.toContain(INSTITUTION_ADDRESSES.escrow);
    expect(noEscrow.length).toBe(2);
  });
});

describe('institution watcher — the population is corroborated independently', () => {
  it('agrees when the durable lock population grew by exactly what was emitted', async () => {
    const h = harness();
    h.logsByRange = [log({ blockNumber: 1_000, logIndex: 7 }), log({ blockNumber: 1_000, logIndex: 8 })];
    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(2);
    expect(report.lockPopulationCount).toBe(2);
    expect(report.lockPopulationAgrees).toBe(true);
  });

  it('DISAGREES when a PE is emitted whose lock did not commit', async () => {
    // The double-emission precondition. The count() is a server-side aggregate
    // over the collection, not a re-walk of the cycle's own list, so it can and
    // must be able to contradict the cycle.
    const h = harness();
    h.deps = {
      ...h.deps,
      emitLinkedEvidencePE: async () => ({ emitted: true, peId: 'pe_ghost' }),
    } as InstitutionWatcherDeps;
    h.logsByRange = [log({ blockNumber: 1_000 })];

    const report = await runInstitutionFundingWatcherCycle(h.deps);

    expect(report.emitted).toBe(1);
    expect(report.lockPopulationCount).toBe(0);
    expect(report.lockPopulationAgrees).toBe(false);
  });
});

// =============================================================================
// TRANSACTIONAL EMISSION — PE and lock commit together or not at all
// =============================================================================

describe('institution watcher — the real emitter binds PE and lock in one transaction', () => {
  const funding = decodeInstitutionFundingLog(log())!;
  const emission: InstitutionFundingEmission = {
    funding, actorAddress: LENDER, walletId: 'w1', agentId: 'a1',
  };

  it('emits once, and a replay of the SAME canonical event does not emit again', async () => {
    const db = createFakeFirestore();
    const calls: Array<Record<string, unknown>> = [];
    // A stand-in for generatePE that honours the precondition/write contract:
    // precondition first (may throw), then the write, inside one transaction.
    const generate = (async (_deps: unknown, params: Record<string, unknown>) => {
      return db.runTransaction(async (txn) => {
        const pre = params.atomicEntityPrecondition as
          ((t: unknown) => Promise<void>) | undefined;
        if (pre) await pre(txn);
        const write = params.atomicEntityWrite as
          ((t: unknown, id: string) => void) | undefined;
        const peId = `pe_${calls.length + 1}`;
        if (write) write(txn, peId);
        calls.push(params);
        return { peId, peHash: 'h', prevHash: 'p' };
      });
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;

    const emit = makeTransactionalEmitter(
      db as unknown as Parameters<typeof makeTransactionalEmitter>[0],
      8453,
      generate,
      {} as Parameters<typeof makeTransactionalEmitter>[3],
    );

    const first = await emit(emission);
    const second = await emit(emission);

    expect(first.emitted).toBe(true);
    expect(second.emitted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('the metadata it hands generatePE carries NO verdict', async () => {
    const db = createFakeFirestore();
    const seen: Array<Record<string, unknown>> = [];
    const generate = (async (_d: unknown, params: Record<string, unknown>) => {
      seen.push(params.metadata as Record<string, unknown>);
      return db.runTransaction(async (txn) => {
        const write = params.atomicEntityWrite as ((t: unknown, id: string) => void) | undefined;
        if (write) write(txn, 'pe_1');
        return { peId: 'pe_1', peHash: 'h', prevHash: 'p' };
      });
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;

    await makeTransactionalEmitter(
      db as unknown as Parameters<typeof makeTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeTransactionalEmitter>[3],
    )(emission);

    expect(seen).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'verified')).toBe(false);
    expect(seen[0].canonical_event_id).toBe(`8453:${TX_A}:7`);
  });
});

// =============================================================================
// THE PRODUCTION DEPS FACTORY
// =============================================================================

/**
 * `buildBaseInstitutionWatcherDeps` had ZERO coverage, and its failure mode is
 * indistinguishable from the expected empty population: if the collection name,
 * the field name or the lowercase normalization were wrong, EVERY funding would
 * resolve to null, be counted `unattributed`, and the cursor would advance past
 * it permanently — while the report `{emitted: 0}` looked exactly like the
 * healthy empty population the module documents. Found by the 1b(ii) reviewer
 * leg. The registry guards this same shape for topic0s; this guards it for the
 * wallet lookup.
 */
/**
 * THE DECLARED LIMIT'S OTHER HALF.
 *
 * `evaluateFundingVerdict` documents that it can check only that a witness is
 * internally consistent and covers its funding — never that the reader behind it
 * was quorum-2 — and points at `buildBaseInstitutionWatcherDeps` as the place
 * that property "is asserted by test".
 *
 * IT WAS NOT. Until this block, the only coverage of that factory was the wallet
 * resolver below; nothing bound `readHead` / `getLogs` / `callContract` to the
 * two-operator seams at all. The docblock has asserted otherwise since,
 * which made the stamp's entire safety argument rest on a test that did not
 * exist — the guard-that-cannot-fail shape, one level up. Found while landing
 *, which would have inherited the same hole for `readSafeHead`.
 *
 * A single-endpoint reader here is invisible at runtime: every funding still
 * decodes, still attributes, still emits, still stamps. It would simply mean one
 * compromised RPC can manufacture money.
 */
describe('institution watcher — the production deps bind the QUORUM-2 seams', () => {
  /* eslint-disable @typescript-eslint/no-var-requires, global-require */
  const discovery = require('../onchain/economic-discovery') as
    typeof import('../onchain/economic-discovery');
  const rpc = require('../onchain/rpc-provider') as typeof import('../onchain/rpc-provider');
  /* eslint-enable @typescript-eslint/no-var-requires, global-require */

  function prodDeps(): InstitutionWatcherDeps {
    return buildBaseInstitutionWatcherDeps({
      db: {} as unknown as Parameters<typeof buildBaseInstitutionWatcherDeps>[0]['db'],
      generate: (async () => ({ peId: 'pe', peHash: 'h', prevHash: 'p' })) as never,
      peDeps: {} as never,
    });
  }

  afterEach(() => { jest.restoreAllMocks(); });

  it('readHead goes through readAgreedBaseHead, not a single provider', async () => {
    const spy = jest.spyOn(discovery, 'readAgreedBaseHead').mockResolvedValue(1_234);
    await expect(prodDeps().readHead()).resolves.toBe(1_234);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('readSafeHead goes through readAgreedBaseSafeHead — the binding', async () => {
    // THE ONE THAT MATTERS MOST for the reorg floor: the stamp checks coherence
    // and coverage of the safe head, never where the value came from. If this
    // were bound to a single endpoint, that endpoint could name any block it
    // liked as "L1-batched" and the floor would be decorative.
    const safe = { number: 1_000, hash: SAFE_HASH };
    const spy = jest.spyOn(discovery, 'readAgreedBaseSafeHead').mockResolvedValue(safe);
    const deps = prodDeps();
    expect(deps.readSafeHead).toBeDefined();
    await expect(deps.readSafeHead!()).resolves.toEqual(safe);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('getLogs goes through getAgreedBaseLogs, passing the filter through', async () => {
    const spy = jest.spyOn(discovery, 'getAgreedBaseLogs').mockResolvedValue([]);
    const filter = {
      address: INSTITUTION_ADDRESSES.promise,
      topics: [] as readonly (string | readonly string[] | null)[],
      fromBlock: 10,
      toBlock: 20,
    };
    await prodDeps().getLogs(filter);
    expect(spy).toHaveBeenCalledWith(filter);
  });

  it('callContract goes through the VERIFIER provider, on base', async () => {
    const call = jest.fn(async () => '0x00');
    const spy = jest.spyOn(rpc, 'getVerifierProvider')
      .mockReturnValue({ call } as never);
    await prodDeps().callContract('0xabc', '0xdef');
    expect(spy).toHaveBeenCalledWith('base');
    expect(call).toHaveBeenCalledWith({ to: '0xabc', data: '0xdef' });
  });
});

describe('institution watcher — the production address→wallet resolver', () => {
  function fakeDbWith(doc: Record<string, unknown> | null) {
    const seen: Array<{ collection: string; field: string; value: unknown }> = [];
    const db = {
      collection: (collection: string) => ({
        where: (field: string, _op: string, value: unknown) => ({
          limit: () => ({
            get: async () => {
              seen.push({ collection, field, value });
              return doc === null
                ? { empty: true, docs: [] }
                : { empty: false, docs: [{ id: 'doc_id', data: () => doc }] };
            },
          }),
        }),
      }),
    };
    return { db, seen };
  }

  function resolverFor(doc: Record<string, unknown> | null) {
    const { db, seen } = fakeDbWith(doc);
    const deps = buildBaseInstitutionWatcherDeps({
      db: db as unknown as Parameters<typeof buildBaseInstitutionWatcherDeps>[0]['db'],
      generate: (async () => ({ peId: 'pe', peHash: 'h', prevHash: 'p' })) as never,
      peDeps: {} as never,
    });
    return { resolve: deps.resolveWalletByAddress, seen };
  }

  it('queries agent_wallets by the `address` field, LOWERCASED', async () => {
    const { resolve, seen } = resolverFor({ agent_id: 'a1', id: 'w1' });
    await resolve('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');

    expect(seen).toHaveLength(1);
    // Addresses are stored lowercase in Firestore; a mixed-case equality query
    // silently matches nothing.
    expect(seen[0]).toEqual({
      collection: 'agent_wallets',
      field: 'address',
      value: '0xabcdef1234567890abcdef1234567890abcdef12',
    });
  });

  it('resolves a real wallet to its wallet id and agent id', async () => {
    const { resolve } = resolverFor({ agent_id: 'agent_x', id: 'wallet_x' });
    await expect(resolve('0x1111111111111111111111111111111111111111'))
      .resolves.toEqual({ walletId: 'wallet_x', agentId: 'agent_x' });
  });

  it('returns null for an unknown address — counted, never guessed', async () => {
    const { resolve } = resolverFor(null);
    await expect(resolve('0x1111111111111111111111111111111111111111'))
      .resolves.toBeNull();
  });

  it('refuses a wallet with no agent id rather than inventing a chain owner', async () => {
    const { resolve } = resolverFor({ id: 'wallet_x' });
    await expect(resolve('0x1111111111111111111111111111111111111111'))
      .resolves.toBeNull();
  });

  it("refuses a platform:'test' wallet — smoke agents never earn", async () => {
    const { resolve } = resolverFor({ agent_id: 'a1', id: 'w1', platform: 'test' });
    await expect(resolve('0x1111111111111111111111111111111111111111'))
      .resolves.toBeNull();
  });
});

/**
 * The route's operational pause, asserted at the SOURCE.
 *
 * Both sibling chain watchers gate on `activityMappingGate`; this one shipped
 * without it (1b(ii) reviewer leg). A behavioural test would need the whole
 * express app, so this binds to the source the way
 * `ordinary-intake-wiring.source.test.ts` does — the point is that the gate
 * cannot be deleted silently.
 */
describe('institution watcher — the scheduler route carries the operational pause', () => {
  it('retains the operational pause through the semantic scheduler wrapper', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const fsMod = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const pathMod = require('path') as typeof import('path');
    const server = fsMod.readFileSync(
      pathMod.resolve(__dirname, '../../server.ts'), 'utf8',
    );

    const routeIdx = server.indexOf("'/v1/internal/scheduler/institution-funding'");
    expect(routeIdx).toBeGreaterThan(0);
    const cycleIdx = server.indexOf('() => runInstitutionFundingWatcherCycle', routeIdx);
    expect(cycleIdx).toBeGreaterThan(routeIdx);

    const handler = server.slice(routeIdx, cycleIdx);
    expect(handler).toContain('authenticateScheduler');
    // The gate must come BEFORE the cycle, not merely appear somewhere later.
    expect(handler).toContain('runInstitutionWatcherScheduler');
    expect(handler).toContain('isActivityMappingEnabled');
  });
});

// -----------------------------------------------------------------------------
// normalizeBlockChunk — the INSTITUTION_WATCHER_BLOCK_CHUNK env lever
// -----------------------------------------------------------------------------

describe('normalizeBlockChunk env lever ', () => {
  const ENV = 'INSTITUTION_WATCHER_BLOCK_CHUNK';
  afterEach(() => { delete process.env[ENV]; });

  it('unset env, no request -> the free-tier-era default (10)', () => {
    delete process.env[ENV];
    expect(normalizeBlockChunk(undefined)).toBe(10);
  });

  it('the env lever moves the chunk when the caller passes nothing', () => {
    process.env[ENV] = '2000';
    expect(normalizeBlockChunk(undefined)).toBe(2000);
  });

  it('an explicit caller request outranks the env lever', () => {
    process.env[ENV] = '2000';
    expect(normalizeBlockChunk(50)).toBe(50);
  });

  it('RED controls: garbage env falls back; the provider refusal ceiling clamps', () => {
    process.env[ENV] = 'not-a-number';
    expect(normalizeBlockChunk(undefined)).toBe(10);
    process.env[ENV] = '-5';
    expect(normalizeBlockChunk(undefined)).toBe(10);
    process.env[ENV] = '50000';
    expect(normalizeBlockChunk(undefined)).toBe(10_000); // INSTITUTION_MAX_BLOCK_CHUNK
  });
});


describe('semantic read holds preserve the existing cursor', () => {
  it.each(['head', 'safe', 'disagreement'])('reports %s failure without reading logs or advancing', async (fault) => {
    const h = harness();
    const deps = h.deps;
    const getLogs = jest.fn(deps.getLogs);
    const error = fault === 'disagreement' ? 'economic_discovery_rpc_disagreement:safe_head' : 'unavailable';
    const report = await runInstitutionFundingWatcherCycle({ ...deps, getLogs,
      ...(fault === 'head' ? { readHead: async () => { throw new Error(error); } } : { readSafeHead: async () => { throw new Error(error); } }),
    });
    expect(report).toMatchObject({ status: 'held', hold_reason: fault === 'disagreement' ? 'provider_disagreement' : fault === 'head' ? 'head_unavailable' : 'safe_head_unavailable', cursorAdvanced: false });
    expect(getLogs).not.toHaveBeenCalled();
  });
});
