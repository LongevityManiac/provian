/**
 * Institution STANDING watcher (Trust Layer build §2.12,) — BondPool / CourtV2 chain witness.
 *
 * Proven: the registry is bound to deployed reality (addresses from the deployment file, topic0 =
 * keccak of each declared signature, pinned topic0s, EVERY action type a named record_only matrix
 * row — the "never mints by construction" invariant); decoding refuses malformed / removed / wrong-
 * contract logs; attribution follows the event (indexed actor, claim struct by role, the losing
 * escrow party for a verdict, the depositor for an escalation) and never guesses; the verified
 * stamp is earned from the finality witness (and a counterparty-less adverse event still earns it —
 * the row is record_only, the counterparty check is the minting siblings' same-owner fence); the
 * emitter locks per canonical log and hands generatePE the durable inlet + observed canonical id;
 * the cycle scans, emits and advances the cursor and fails closed with no safe head.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import { INSTITUTION_WATCHER_CHAIN_ID, INSTITUTION_ADDRESSES } from './institution-funding-watcher';
import {
  INSTITUTION_STANDING_EVENTS,
  INSTITUTION_STANDING_ACTION_TYPES,
  STANDING_ADVERSE_ACTION_TYPES,
  STANDING_INSTITUTION_ADDRESSES,
  INSTITUTION_STANDING_EMISSION_LOCK_COLLECTION,
  STANDING_NO_COUNTERPARTY_SENTINEL,
  buildStandingEvidenceMetadata,
  markPairedBondSlashes,
  decodeInstitutionStandingLog,
  emptyInstitutionStandingWatcherReport,
  evaluateStandingVerdict,
  institutionStandingLogFilters,
  makeStandingTransactionalEmitter,
  processDecodedStanding,
  resolveStandingParties,
  runInstitutionStandingWatcherCycle,
  type InstitutionStandingEmission,
  type InstitutionStandingWatcherDeps,
  type DecodedInstitutionStanding,
} from './institution-standing-watcher';

const TX_A = `0x${'a1'.repeat(32)}`;
const AGENT = '0x1111111111111111111111111111111111111111';
const CLAIMANT = '0x2222222222222222222222222222222222222222';
const ARB = '0x3333333333333333333333333333333333333333';
const DEPOSITOR = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x5555555555555555555555555555555555555555';
const SAFE_HASH = `0x${'5e'.repeat(32)}`;
const ENTITY = `0x${'cd'.repeat(32)}`;

const topicOf = (sig: string) => ethers.id(sig);
const addrTopic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
// Every on-chain struct read here has ≥3 words (claims: claimant, agent, filingFee…; escrows: depositor,
// recipient, amount…) — the decoder refuses shorter returns.
const struct2 = (w0: string, w1: string) =>
  `0x${w0.toLowerCase().slice(2).padStart(64, '0')}${w1.toLowerCase().slice(2).padStart(64, '0')}${word(1n)}`;

function log(address: string, topics: string[], data: string, over: Partial<CanonicalEconomicLog> = {}): CanonicalEconomicLog {
  return {
    address,
    topics,
    data,
    blockNumber: 900,
    blockHash: `0x${'b0'.repeat(32)}`,
    transactionHash: TX_A,
    logIndex: 3,
    removed: false,
    ...over,
  } as CanonicalEconomicLog;
}

const BOND = STANDING_INSTITUTION_ADDRESSES.bond_pool;
const COURT = STANDING_INSTITUTION_ADDRESSES.court;

const slashedLog = (over: Partial<CanonicalEconomicLog> = {}) => log(BOND,
  [topicOf('BondSlashed(address,bytes32,address,uint256,uint256)'), addrTopic(AGENT), ENTITY, addrTopic(CLAIMANT)],
  `0x${word(700n * 10n ** 18n)}${word(300n * 10n ** 18n)}`, over);
const abandonedLog = (over: Partial<CanonicalEconomicLog> = {}) => log(BOND, [topicOf('BondAbandoned(address,uint256)'), addrTopic(AGENT)], `0x${word(5n)}`, over);
const dismissedLog = () => log(BOND, [topicOf('ClaimDismissed(bytes32,address)'), ENTITY, addrTopic(AGENT)], '0x');
const verdictLog = (release: boolean) => log(COURT,
  [topicOf('Verdict(bytes32,bool,uint8,uint8)'), ENTITY], `0x${word(release ? 1n : 0n)}${word(2n)}${word(1n)}`);
const escalatedLog = () => log(COURT, [topicOf('Escalated(bytes32)'), ENTITY], '0x');
const forfeitedLog = () => log(COURT,
  [topicOf('ArbitratorSeatForfeited(bytes32,address,uint8,uint8)'), ENTITY, addrTopic(ARB)], `0x${word(1n)}${word(2n)}`);
const bondResolvedLog = () => log(COURT,
  [topicOf('BondClaimResolved(bytes32,address,uint8,uint256)'), ENTITY, addrTopic(AGENT)], `0x${word(3n)}${word(42n)}`);

// =============================================================================
// REGISTRY — bound to deployed reality; never mints by construction
// =============================================================================

describe('standing watcher — the registry is bound to deployed reality', () => {
  it('covers the BondPool + CourtV2 lifecycle (a non-empty, counted population)', () => {
    expect(INSTITUTION_STANDING_EVENTS.length).toBe(20);
    expect(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.institution)).size).toBe(2);
    expect(INSTITUTION_STANDING_ACTION_TYPES.length).toBe(19);
    // Every polarity is represented, and the adverse set is what Standing counts against an actor.
    expect(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.polarity))).toEqual(new Set(['adverse', 'neutral', 'positive']));
    expect([...STANDING_ADVERSE_ACTION_TYPES].sort()).toEqual([
      'bond_abandoned', 'bond_autonomy_downgraded', 'bond_claim_dismissed', 'bond_slashed',
      'court_arbitrator_collateral_slashed', 'court_arbitrator_seat_forfeited', 'court_verdict',
    ]);
  });

  it('addresses match the deployment file byte-for-byte (lowercased)', () => {
    const deployed = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../contracts/deployments/base-pvt9-institutions.json'), 'utf8',
    )) as { chainId: number; contracts: Record<string, { address: string }> };
    expect(deployed.chainId).toBe(INSTITUTION_WATCHER_CHAIN_ID);
    expect(STANDING_INSTITUTION_ADDRESSES.bond_pool).toBe(deployed.contracts.bondPool.address.toLowerCase());
    expect(STANDING_INSTITUTION_ADDRESSES.court).toBe(deployed.contracts.courtV2.address.toLowerCase());
    for (const s of INSTITUTION_STANDING_EVENTS) {
      expect(s.address).toBe(STANDING_INSTITUTION_ADDRESSES[s.institution]);
    }
  });

  it('every topic0 is keccak of its own declared signature, and the signatures exist in contracts/src', () => {
    const bondSol = fs.readFileSync(path.resolve(__dirname, '../../../../contracts/src/ProvianBondPool.sol'), 'utf8');
    const courtSol = fs.readFileSync(path.resolve(__dirname, '../../../../contracts/src/ProvianCourtV2.sol'), 'utf8');
    for (const s of INSTITUTION_STANDING_EVENTS) {
      expect(s.topic0).toBe(ethers.id(s.signature));
      // The event NAME is declared in the contract the spec binds to (the enum-typed BondVoteCast /
      // BondClaimResolved signatures use uint8, so the name is what the source can confirm).
      const sol = s.institution === 'bond_pool' ? bondSol : courtSol;
      expect(sol).toContain(`event ${s.event}(`);
    }
  });

  it('pins the adverse topic0s to independently-verified values', () => {
    const byName = Object.fromEntries(INSTITUTION_STANDING_EVENTS.map((s) => [s.signature, s.topic0]));
    // cast keccak "BondSlashed(address,bytes32,address,uint256,uint256)" etc., 2026-09-16.
    expect(byName['BondAbandoned(address,uint256)']).toBe(ethers.id('BondAbandoned(address,uint256)'));
    expect(byName['BondPosted(address,uint256,uint256,uint8)'])
      .toBe('0xce7331f1014b4869f38a3265a97ecfbdc4d43821f60398be547bc95e11c683b0');
    expect(byName['BondWithdrawn(address,uint256)'])
      .toBe('0x0d41118e36df44efb77a471fc49fb9c0be0406d802ef95520e9fbf606e65b455');
    expect(byName['BondRenewed(address,uint256)'])
      .toBe('0x88e516202d31db4eb44351eb912c75dc42460b335a5eed44861ddadd399defb1');
    expect(byName['BondToppedUp(address,uint256,uint256)'])
      .toBe('0x7440189f48490fd194d6a8d8ed2edabc6fed0723bb82388831a8b131e1f8d86f');
  });

  it('NEVER MINTS BY CONSTRUCTION — every action type is a NAMED record_only row of the generated matrix (RED: an eligible row here fails)', () => {
    const matrix = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json'), 'utf8',
    )) as { rows: Array<{ action_type: string; mint_disposition: string; base_action_weight_bps: number }> };
    const rows = new Map(matrix.rows.map((r) => [r.action_type, r]));
    let checked = 0;
    for (const t of INSTITUTION_STANDING_ACTION_TYPES) {
      const row = rows.get(t);
      expect(row).toBeDefined();
      expect(row!.mint_disposition).toBe('record_only');
      expect(row!.base_action_weight_bps).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(INSTITUTION_STANDING_ACTION_TYPES.length);
    // RED control: the same predicate over an ELIGIBLE row is false — the guard can fail.
    expect(rows.get('escrow_completed')!.mint_disposition).not.toBe('record_only');
    // The Jobs-join row lands beside the escrow row and is likewise record_only.
    expect(rows.get('job_completed')!.mint_disposition).toBe('record_only');
  });

  it('the log filter covers every address and topic0', () => {
    const { addresses, topic0s } = institutionStandingLogFilters();
    expect(new Set(addresses)).toEqual(new Set([BOND, COURT]));
    expect(new Set(topic0s)).toEqual(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.topic0)));
  });
});

// =============================================================================
// DECODE
// =============================================================================

describe('standing watcher — decoding', () => {
  it('decodes a BondSlashed: agent, claim id, claimant, both amounts as decimal strings', () => {
    const d = decodeInstitutionStandingLog(slashedLog())!;
    expect(d.spec.actionType).toBe('bond_slashed');
    expect(d.entityId).toBe(ENTITY);
    expect(d.fields).toEqual({ claimant_amount_atomic: (700n * 10n ** 18n).toString(), burned_amount_atomic: (300n * 10n ** 18n).toString() });
    expect(d.canonicalEventId).toBe(`8453:${TX_A}:3`);
  });
  it('decodes a Verdict bool + uint8 votes; REFUSES a bool that is neither 0 nor 1', () => {
    const d = decodeInstitutionStandingLog(verdictLog(true))!;
    expect(d.fields).toEqual({ release_to_recipient: true, votes_for_release: 2, votes_for_refund: 1 });
    const bad = log(COURT, [topicOf('Verdict(bytes32,bool,uint8,uint8)'), ENTITY], `0x${word(2n)}${word(2n)}${word(1n)}`);
    expect(decodeInstitutionStandingLog(bad)).toBeNull();
  });
  it('REFUSES a known topic emitted by the WRONG contract, a removed log, a short data word, a malformed entity topic', () => {
    expect(decodeInstitutionStandingLog(log(COURT, slashedLog().topics as string[], slashedLog().data))).toBeNull();
    expect(decodeInstitutionStandingLog(slashedLog({ removed: true }))).toBeNull();
    expect(decodeInstitutionStandingLog(log(BOND, slashedLog().topics as string[], `0x${word(1n)}`))).toBeNull();
    expect(decodeInstitutionStandingLog(log(BOND, [topicOf('ClaimDismissed(bytes32,address)'), '0x12', addrTopic(AGENT)], '0x'))).toBeNull();
  });
  it('ignores an unknown topic on a watched address (the setup events) — null, never a throw', () => {
    expect(decodeInstitutionStandingLog(log(BOND, [topicOf('CourtContractSet(address)'), addrTopic(COURT)], '0x'))).toBeNull();
  });
});

// =============================================================================
// ATTRIBUTION — the party the event names; never a guess
// =============================================================================

interface Harness {
  deps: InstitutionStandingWatcherDeps;
  emitted: InstitutionStandingEmission[];
  locks: Set<string>;
  logsByRange: CanonicalEconomicLog[];
  headValue: number;
  safeHeadValue: number | null | undefined;
  failSafeHead: boolean;
  failGetLogs: boolean;
  structReturn: string | null;
  structCalls: Array<{ to: string; selector: string }>;
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
    structReturn: struct2(CLAIMANT, AGENT),
    structCalls: [],
    knownAddresses: new Set([AGENT, CLAIMANT, ARB, DEPOSITOR, RECIPIENT]),
    deps: null as unknown as InstitutionStandingWatcherDeps,
    ...over,
  };
  h.deps = {
    db: db as unknown as InstitutionStandingWatcherDeps['db'],
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
    callContract: async (to, data) => {
      h.structCalls.push({ to, selector: data.slice(0, 10) });
      if (h.structReturn === null) throw new Error('rpc down');
      return h.structReturn;
    },
    resolveWalletByAddress: async (a) => (
      h.knownAddresses.has(a) ? { walletId: `w_${a.slice(2, 8)}`, agentId: `ag_${a.slice(2, 8)}` } : null
    ),
    emitStandingPE: async (e) => {
      const key = e.decoded.canonicalEventId;
      if (h.locks.has(key)) return { emitted: false };
      h.locks.add(key);
      h.emitted.push(e);
      return { emitted: true, peId: `pe_${h.emitted.length}` };
    },
    now: () => 1_700_000_000_000,
  };
  return h;
}

describe('standing watcher — attribution follows the event, never a guess', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  const report = () => emptyInstitutionStandingWatcherReport();

  it('BondSlashed → actor = slashed agent (indexed), counterparty = claimant (indexed); no struct read', async () => {
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(slashedLog())!, report());
    expect(p).toEqual({ actorAddress: AGENT, counterpartyAddress: CLAIMANT });
    expect(h.structCalls).toHaveLength(0);
  });
  it('BondAbandoned → actor = agent, NO counterparty (and that is not a failure)', async () => {
    const r = report();
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(abandonedLog())!, r);
    expect(p).toEqual({ actorAddress: AGENT, counterpartyAddress: null });
    expect(r.counterpartyReadFailures).toBe(0);
    expect(r.attributionFailures).toBe(0);
  });
  it('ClaimDismissed → actor = CLAIMANT (adverse to the claimant) via claims(bytes32) word 0, counterparty = agent (word 1)', async () => {
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(dismissedLog())!, report());
    expect(p).toEqual({ actorAddress: CLAIMANT, counterpartyAddress: AGENT });
    expect(h.structCalls).toEqual([{ to: BOND, selector: ethers.id('claims(bytes32)').slice(0, 10) }]);
  });
  it('BondClaimResolved → actor = AGENT via claims(bytes32) word 1, counterparty = claimant', async () => {
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(bondResolvedLog())!, report());
    expect(p).toEqual({ actorAddress: AGENT, counterpartyAddress: CLAIMANT });
  });
  it('Verdict lands on the LOSING party: release → depositor lost; refund → recipient lost (escrows(bytes32) on EscrowV4)', async () => {
    h.structReturn = struct2(DEPOSITOR, RECIPIENT);
    const release = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(verdictLog(true))!, report());
    expect(release).toEqual({ actorAddress: DEPOSITOR, counterpartyAddress: RECIPIENT });
    const refund = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(verdictLog(false))!, report());
    expect(refund).toEqual({ actorAddress: RECIPIENT, counterpartyAddress: DEPOSITOR });
    expect(h.structCalls[0]).toEqual({ to: INSTITUTION_ADDRESSES.escrow, selector: ethers.id('escrows(bytes32)').slice(0, 10) });
  });
  it('Escalated → actor = depositor, counterparty = recipient', async () => {
    h.structReturn = struct2(DEPOSITOR, RECIPIENT);
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(escalatedLog())!, report());
    expect(p).toEqual({ actorAddress: DEPOSITOR, counterpartyAddress: RECIPIENT });
  });
  it('ArbitratorSeatForfeited → actor = arbitrator (indexed), no counterparty', async () => {
    const p = await resolveStandingParties(h.deps, decodeInstitutionStandingLog(forfeitedLog())!, report());
    expect(p).toEqual({ actorAddress: ARB, counterpartyAddress: null });
  });
  it('RED — a struct read that fails DROPS the event (attribution failure, held for retry); a ZERO actor word likewise', async () => {
    h.structReturn = null;
    const r1 = report();
    expect(await resolveStandingParties(h.deps, decodeInstitutionStandingLog(dismissedLog())!, r1)).toBeNull();
    expect(r1.attributionFailures).toBe(1);
    h.structReturn = struct2(ethers.ZeroAddress, AGENT);
    const r2 = report();
    expect(await resolveStandingParties(h.deps, decodeInstitutionStandingLog(dismissedLog())!, r2)).toBeNull();
    expect(r2.attributionFailures).toBe(1);
  });
  it('COUNTS and skips an event by an address no Provian wallet holds', async () => {
    h.knownAddresses = new Set();
    const r = report();
    await processDecodedStanding(h.deps, decodeInstitutionStandingLog(slashedLog())!, r);
    expect(r.unattributed).toBe(1);
    expect(h.emitted).toHaveLength(0);
  });
});

// =============================================================================
// THE STAMP — earned from the finality witness, never asserted
// =============================================================================

const FULL_WITNESS = {
  // finalizedThroughBlock(head) = head − 11 (12 confirmations inclusive).
  head: 1_011, finalizedThrough: 1_000, observedBlock: 900, safeHead: { number: 1_000, hash: SAFE_HASH },
};

function emission(over: Partial<InstitutionStandingEmission> = {}): InstitutionStandingEmission {
  return {
    decoded: decodeInstitutionStandingLog(slashedLog())!,
    actorAddress: AGENT,
    walletId: 'w_agent',
    agentId: 'ag_agent',
    counterpartyAddress: CLAIMANT,
    finalityWitness: FULL_WITNESS,
    ...over,
  };
}

describe('standing watcher — the stamp is earned, never asserted', () => {
  it('GRANTS the verdict for a fully-witnessed, safe-head-covered event', () => {
    expect(evaluateStandingVerdict(emission())).toEqual({ verified: true });
    const md = buildStandingEvidenceMetadata(emission(), 8453);
    expect(md.verified).toBe(true);
    expect(md.standing).toBe('adverse');
    expect(md.event).toBe('BondSlashed');
    expect(md.claimant_amount_atomic).toBe((700n * 10n ** 18n).toString());
    expect(md.observed_by).toBe('institution_standing_watcher');
  });
  it('the metadata this watcher SEALS is what Standing counts — every adverse spec counts once, no other spec does', () => {
    const { deriveCompositionSignals, countsAsAdverse } = require('./actor-stats') as typeof import('./actor-stats');
    const base = emission();
    let adverseSpecs = 0;
    for (const spec of INSTITUTION_STANDING_EVENTS) {
      // The REAL sealed metadata (never a test-local copy of its shape), verified and unverified.
      for (const e of [emission({ decoded: { ...base.decoded, spec } }), emission({ decoded: { ...base.decoded, spec }, finalityWitness: undefined })]) {
        const counted = countsAsAdverse(spec.actionType, deriveCompositionSignals(buildStandingEvidenceMetadata(e, 8453), null));
        expect({ event: spec.event, counted }).toEqual({ event: spec.event, counted: spec.polarity === 'adverse' });
      }
      if (spec.polarity === 'adverse') adverseSpecs += 1;
    }
    expect(adverseSpecs).toBeGreaterThanOrEqual(7); // never a pass over zero adverse specs
    // RED: the same metadata without its canonical event id is NOT the watcher's row and counts nothing.
    const { canonical_event_id: _dropped, ...stripped } = buildStandingEvidenceMetadata(base, 8453);
    expect(countsAsAdverse('bond_slashed', deriveCompositionSignals(stripped, null))).toBe(false);
  });
  it('a downgrade emitted in the same transaction as a slash of the same agent is marked, sealed, and not counted again', () => {
    const { deriveCompositionSignals, countsAsAdverse } = require('./actor-stats') as typeof import('./actor-stats');
    const downgradeLog = (over: Partial<CanonicalEconomicLog> = {}) => log(BOND,
      [topicOf('AutonomyDowngrade(address,uint256,uint256)'), addrTopic(AGENT)], `0x${word(1n)}${word(2n)}`, { logIndex: 4, ...over });
    const decode = (l: CanonicalEconomicLog) => ({ decoded: decodeInstitutionStandingLog(l) });
    const counted = (d: ReturnType<typeof decodeInstitutionStandingLog>) =>
      countsAsAdverse(d!.spec.actionType, deriveCompositionSignals(buildStandingEvidenceMetadata(emission({ decoded: d! }), 8453), null));

    // One transaction: the slash and its downgrade. The pair is ONE adverse event.
    const pair = markPairedBondSlashes([decode(slashedLog()), decode(downgradeLog())]);
    expect(pair.map((r) => r.decoded!.spec.actionType)).toEqual(['bond_slashed', 'bond_autonomy_downgraded']);
    expect(pair[1].decoded!.pairedBondSlash).toBe(true);
    expect(buildStandingEvidenceMetadata(emission({ decoded: pair[1].decoded! }), 8453).paired_bond_slash).toBe(true);
    expect(pair.map((r) => counted(r.decoded))).toEqual([true, false]);
    // RED: unmarked (the pre-ruling watcher), the same two rows count twice.
    expect([decode(slashedLog()), decode(downgradeLog())].map((r) => counted(r.decoded))).toEqual([true, true]);

    // A downgrade in ANOTHER transaction, or for ANOTHER agent, is its own event and still counts.
    const otherTx = markPairedBondSlashes([decode(slashedLog()), decode(downgradeLog({ transactionHash: `0x${'cd'.repeat(32)}` }))]);
    expect(otherTx[1].decoded!.pairedBondSlash).toBeUndefined();
    expect(counted(otherTx[1].decoded)).toBe(true);
    const otherAgent = markPairedBondSlashes([
      decode(slashedLog()),
      decode(log(BOND, [topicOf('AutonomyDowngrade(address,uint256,uint256)'), addrTopic(CLAIMANT)], `0x${word(1n)}${word(2n)}`)),
    ]);
    expect(otherAgent[1].decoded!.pairedBondSlash).toBeUndefined();
  });

  it('a COUNTERPARTY-LESS adverse event (abandonment burn) still earns the stamp — the row is record_only, the fence is the minters\'', () => {
    const e = emission({ decoded: decodeInstitutionStandingLog(abandonedLog())!, counterpartyAddress: undefined });
    expect(evaluateStandingVerdict(e)).toEqual({ verified: true });
    expect(buildStandingEvidenceMetadata(e, 8453).counterparty_address).toBeNull();
    expect(STANDING_NO_COUNTERPARTY_SENTINEL.startsWith('standing:')).toBe(true);
  });
  it('REFUSES with no finality witness', () => {
    expect(evaluateStandingVerdict(emission({ finalityWitness: undefined }))).toEqual({ verified: false, reason: 'no_finality_witness' });
    expect(buildStandingEvidenceMetadata(emission({ finalityWitness: undefined }), 8453).verified).toBeUndefined();
  });
  it('REFUSES a witness about a DIFFERENT block, an underived ceiling, no safe head, a block above the safe head', () => {
    expect(evaluateStandingVerdict(emission({ finalityWitness: { ...FULL_WITNESS, observedBlock: 901 } })).verified).toBe(false);
    expect(evaluateStandingVerdict(emission({ finalityWitness: { ...FULL_WITNESS, finalizedThrough: 999 } })).verified).toBe(false);
    expect(evaluateStandingVerdict(emission({ finalityWitness: { head: 1_011, finalizedThrough: 1_000, observedBlock: 900 } })))
      .toEqual({ verified: false, reason: 'no_safe_head_witness' });
    expect(evaluateStandingVerdict(emission({ finalityWitness: { ...FULL_WITNESS, safeHead: { number: 899, hash: SAFE_HASH } } })))
      .toEqual({ verified: false, reason: 'above_safe_head' });
  });
});

// =============================================================================
// EMITTER — one PE per canonical log, locked
// =============================================================================

describe('standing watcher — the emitter carries the record inputs', () => {
  it('hands generatePE the durable inlet, counterparty, observed canonical id and the record action type; locks the log', async () => {
    const db = createFakeFirestore();
    let captured: Record<string, unknown> | null = null;
    const generate = (async (_d: unknown, params: Record<string, unknown>) => {
      await (db as unknown as { runTransaction: (fn: (t: unknown) => Promise<string>) => Promise<string> })
        .runTransaction(async (txn: unknown) => {
          await (params.atomicEntityPrecondition as (t: unknown) => Promise<void>)(txn);
          (params.atomicEntityWrite as (t: unknown, id: string) => void)(txn, 'pe_x');
          return 'pe_x';
        });
      captured = params;
      return { peId: 'pe_x' };
    }) as unknown as typeof import('../agent-bank/pe-utils').generatePE;

    const emit = makeStandingTransactionalEmitter(
      db as unknown as Parameters<typeof makeStandingTransactionalEmitter>[0],
      8453, generate, {} as Parameters<typeof makeStandingTransactionalEmitter>[3],
    );
    const res = await emit(emission());
    expect(res.emitted).toBe(true);
    const p = captured! as Record<string, unknown>;
    expect(p.durableViaOrdinaryIntake).toBe(true);
    expect(p.counterpartyAddress).toBe(CLAIMANT);
    expect(p.observedCanonicalEventId).toBe((emission().decoded as DecodedInstitutionStanding).canonicalEventId);
    expect(p.actionType).toBe('bond_slashed');
    expect((p.metadata as Record<string, unknown>).verified).toBe(true);
    const lock = db.store.get(`${INSTITUTION_STANDING_EMISSION_LOCK_COLLECTION}/${(emission().decoded as DecodedInstitutionStanding).canonicalEventId}`) as Record<string, unknown>;
    expect(lock.pe_id).toBe('pe_x');
    expect(lock.standing).toBe('adverse');
    // Replay: the lock holds; no second row.
    expect((await emit(emission())).emitted).toBe(false);
  });
});

// =============================================================================
// THE CYCLE
// =============================================================================

describe('standing watcher — the cycle', () => {
  it('the SCAN marks a slash-caused downgrade on the row it emits (the whole cycle, not just the helper)', async () => {
    const downgrade = log(BOND, [topicOf('AutonomyDowngrade(address,uint256,uint256)'), addrTopic(AGENT)], `0x${word(1n)}${word(2n)}`, { logIndex: 4 });
    const lone = log(BOND, [topicOf('AutonomyDowngrade(address,uint256,uint256)'), addrTopic(AGENT)], `0x${word(1n)}${word(2n)}`,
      { logIndex: 1, transactionHash: `0x${'ef'.repeat(32)}`, blockNumber: 901 });
    const h = harness({ logsByRange: [slashedLog(), downgrade, lone] });
    const { commitWatcherCheckpoint } = require('./watcher-address-admission') as typeof import('./watcher-address-admission');
    await commitWatcherCheckpoint(h.deps.db, 'pvt_institution_standing_watcher_checkpoints_v1', 8453,
      { lastProcessedBlock: null, membershipGeneration: 0 }, 899, 1);
    await runInstitutionStandingWatcherCycle(h.deps, { blockChunk: 100 });
    const rows = h.emitted.map((e) => ({ type: e.decoded.spec.actionType, tx: e.decoded.txHash, paired: e.decoded.pairedBondSlash === true }));
    expect(rows.filter((r) => r.type === 'bond_slashed')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'bond_autonomy_downgraded').map((r) => r.paired).sort()).toEqual([false, true]);
  });

  it('scans, emits by polarity, and advances the cursor', async () => {
    const h = harness({ logsByRange: [slashedLog(), abandonedLog({ blockNumber: 950, logIndex: 4 })] });
    // seed the checkpoint so the scan covers the logs
    const { commitWatcherCheckpoint } = require('./watcher-address-admission') as typeof import('./watcher-address-admission');
    await commitWatcherCheckpoint(h.deps.db, 'pvt_institution_standing_watcher_checkpoints_v1', 8453,
      { lastProcessedBlock: null, membershipGeneration: 0 }, 899, 1);
    const r = await runInstitutionStandingWatcherCycle(h.deps, { blockChunk: 100 });
    expect(r.eventsDecoded).toBe(2);
    expect(r.emitted).toBe(2);
    expect(r.emittedByPolarity.adverse).toBe(2);
    expect(r.emittedByType).toEqual({ bond_slashed: 1, bond_abandoned: 1 });
    expect(r.cursorAdvanced).toBe(true);
    expect(r.cursorTo).toBe(1_000); // min(finalizedThrough(1011)=1000, safeHead 1000)
    expect(r.stampRefusals).toBe(0);
  });
  it('FAILS CLOSED with no safe-head reader — scans nothing', async () => {
    const h = harness({ safeHeadValue: undefined, logsByRange: [slashedLog()] });
    const r = await runInstitutionStandingWatcherCycle(h.deps);
    expect(r.logsRead).toBe(0);
    expect(r.emitted).toBe(0);
    expect(r.cursorAdvanced).toBe(false);
  });
});
