/**
 * settlement runtime — the inlet's PROJECTION half. The half that had no tests, and therefore had five
 * defects.
 *
 * THE STRUCTURAL CONTROL THAT WOULD HAVE CAUGHT ALL OF THEM
 *
 * Every `pe_history` fixture below is declared as `Partial<PEHistoryDocument>` and every
 * envelope fixture as `SealedEnvelopeFixture`. That is not decoration: TypeScript's
 * excess-property check on object literals makes a field name that does not exist in
 * `src/pe-history.ts` a COMPILE error. The M6 defects — reading `actor_address`,
 * `wallet_address`, and `economic_snapshot.workProductHash`, none of which exist — could not
 * have survived a single fixture typed this way, because the fixture could not have been
 * written. The previous test file synthesized its own untyped candidate shapes and was
 * therefore structurally incapable of catching any of it.
 *
 * That is the "self-referential control" the run contract names: a test that declares its own
 * copy of the data the code reads, instead of binding to the single source the code reads.
 * These fixtures bind.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { canonicalAgentBeneficiaryShareBps } from '../../agent-wallet/beneficiary-relationship';
import {
  hashBeneficiaryRoutingSnapshot,
  type BeneficiaryRoutingSnapshot,
} from '../beneficiary-routing';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { GENESIS_HASH } from '../../../pe-chain-validator';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from '../policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../policy/runtime-monetary-policy';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import { PVT9_ELIGIBILITY_CUT_LINE_MS, evaluateEligibility } from '../wp-ev/eligibility';
import type { SettlementDb } from './durable-settlement-store';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf } from './durable-settlement-store';
import {
  AGENT_WALLETS_COLLECTION,
  CORROBORATION_STATUSES,
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  WALLETS_COLLECTION,
  buildEligibilityCandidate,
  corroborationOf,
  counterpartyOf,
  createFirestoreInletSource,
  economicActorIdOf,
  NO_GENESIS_ANCHORS,
  projectEligibility,
  resolvePayee,
  workProductHashOf,
} from './claim-inlet-source';

const ADDR_HUMAN = '0x00000000000000000000000000000000000000h1'.replace('h1', 'a1');
const ADDR_AGENT = '0x00000000000000000000000000000000000000a2';
const POST_CUT_LINE = PVT9_ELIGIBILITY_CUT_LINE_MS + 5_000;
const POINTS = '1000000000000000000';

/**
 * The `provenance_envelopes` fields this module reads, named exactly as the relay's writers
 * spell them (`core/agent-bank/pe-utils.ts` `buildStoredDoc`).
 */
interface SealedEnvelopeFixture {
  /**
   * `provenance_envelopes` has no declared TypeScript document interface — nine writers build
   * it as an object literal — so this fixture cannot bind the way the `pe_history` one does.
   * The index signature is what lets it be passed where the module expects a stored doc.
   */
  [field: string]: unknown;
  id: string;
  prev_hash: string;
  hash: string;
  timestamp: number;
  action_type: string;
  user_id: string | null;
  counterparty_address?: string | null;
  counterparty_type?: string | null;
}

function envelope(overrides: Partial<SealedEnvelopeFixture> = {}): SealedEnvelopeFixture {
  return {
    id: 'pe-1',
    prev_hash: GENESIS_PREV_HASH,
    hash: `0x${'11'.repeat(32)}`,
    timestamp: POST_CUT_LINE,
    action_type: 'agent_task_completed',
    user_id: 'user-1',
    counterparty_address: null,
    counterparty_type: null,
    ...overrides,
  };
}

function history(overrides: Partial<PEHistoryDocument> = {}): Partial<PEHistoryDocument> {
  return {
    peId: 'pe-1',
    userId: 'user-1',
    timestamp: POST_CUT_LINE,
    attestationDepth: 'software',
    attestation_verified: true,
    mint_status: 'eligible',
    record_points_atomic: '1000000000000000000',
    corroboration_status: 'none',
    replication_pack: {
      input_hash: null,
      output_hash: `0x${'ab'.repeat(32)}`,
      model_id: null,
      model_checkpoint_hash: null,
      pack_hash: null,
    },
    ...overrides,
  };
}

/**
 * A linked-agent history SEALED the way production seals one.
 *
 * M9 — the fixtures here previously carried `beneficiary_routing_snapshot` with NO
 * `beneficiary_routing_snapshot_hash`, a shape production never writes (`pe-history.ts` writes
 * both). That let them exercise a resolver that trusted the snapshot verbatim. The commitment is
 * derived by the module's own hasher rather than pasted, so a fixture can never declare a
 * commitment the verifier would not itself compute.
 */
function linkedHistory(
  snapshot: BeneficiaryRoutingSnapshot,
  overrides: Partial<PEHistoryDocument> = {},
): Partial<PEHistoryDocument> {
  return history({
    beneficiary_routing_snapshot: snapshot,
    beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(snapshot),
    ...overrides,
  });
}

function routingSnapshot(
  overrides: Record<string, unknown> = {},
): BeneficiaryRoutingSnapshot {
  return {
    schema_version: 'beneficiary-routing/v1',
    pe_id: 'pe-1',
    economic_actor_id: 'agent-1',
    recorded_at_ms: POST_CUT_LINE,
    human_wallet_id: 'w-user-1',
    human_user_id: 'user-1',
    human_address: ADDR_HUMAN,
    // Bound to the canonical constructor rather than a bare literal: the branded type is
    // the module's own, so the fixture cannot declare a share the protocol would reject.
    agent_share_bps: canonicalAgentBeneficiaryShareBps({ bps: 2000 })!,
    ...overrides,
  } as unknown as BeneficiaryRoutingSnapshot;
}

function db(): SettlementDb & { store: Map<string, Record<string, unknown>> } {
  return createFakeFirestore() as unknown as SettlementDb & {
    store: Map<string, Record<string, unknown>>;
  };
}

async function seedHuman(database: SettlementDb, userId: string, address: string): Promise<void> {
  await database.collection(WALLETS_COLLECTION).doc(`w-${userId}`).set({
    user_id: userId, type: 'human', address,
  });
}

async function seedAgent(
  database: SettlementDb,
  agentId: string,
  address: string,
  status = 'active',
): Promise<void> {
  await database.collection(AGENT_WALLETS_COLLECTION).doc(`wallet_aw_${agentId}`).set({
    id: `wallet_aw_${agentId}`, agent_id: agentId, address, status,
  });
}

describe('field mapping — each read is a claim about pe-history.ts', () => {
  it('reads the work-product hash from replication_pack.output_hash', () => {
    // `/v1/relay/work-product` assigns `output_hash: artifact_hash`; pe-history.ts documents
    // the field as "same as artifact_hash". This is the only durable landing place.
    expect(workProductHashOf(history())).toBe(`0x${'ab'.repeat(32)}`);

    // RED CONTROL: no replication pack -> no work-product hash. The defect this replaces read
    // `economic_snapshot.workProductHash`, a field that does not exist, and so returned null
    // for EVERY PE — making the assertion above and this control indistinguishable.
    expect(workProductHashOf(history({ replication_pack: null }))).toBeNull();
  });

  it('counts every real corroboration_status member and no invented one', () => {
    for (const status of CORROBORATION_STATUSES) {
      const projected = corroborationOf(
        history({ corroboration_status: status as PEHistoryDocument['corroboration_status'] }),
      );
      expect(projected?.received).toBe(true);
      expect(projected?.signalType).toBe(status);
    }
    // The union's unset value.
    expect(corroborationOf(history({ corroboration_status: 'none' }))?.received).toBe(false);

    // RED CONTROL: the spellings the defective version matched on ('received', 'corroborated')
    // are NOT members of the union, and must not count. If they did, this module would be
    // matching a shape nothing writes.
    const invented = corroborationOf({ corroboration_status: 'received' });
    expect(invented?.received).toBe(false);
    expect(CORROBORATION_STATUSES.has('received')).toBe(false);
    expect(CORROBORATION_STATUSES.has('corroborated')).toBe(false);
  });

  it('reads the counterparty off the sealed envelope so the ghost gate can fire', () => {
    expect(counterpartyOf(envelope())).toBeNull();
    const named = counterpartyOf(envelope({
      counterparty_address: ADDR_AGENT, counterparty_type: 'agent',
    }));
    expect(named).toEqual({ address: ADDR_AGENT, type: 'agent' });

    // THE POINT, as a behaviour rather than a field read: a PE naming a counterparty who has
    // NOT corroborated is a ghost, even carrying a complete replication pack. The defective
    // version hard-coded `counterparty: null`, so this gate could never fire.
    const ghost = projectEligibility({
      peId: 'pe-1',
      history: history({
        corroboration_status: 'none',
        replication_pack: {
          input_hash: `0x${'01'.repeat(32)}`,
          output_hash: `0x${'02'.repeat(32)}`,
          model_id: 'anthropic/x/1',
          model_checkpoint_hash: null,
          pack_hash: `0x${'03'.repeat(32)}`,
        },
      }),
      envelope: envelope({ counterparty_address: ADDR_AGENT, counterparty_type: 'agent' }),
      identity: {
        id: 'pe-1', prev_hash: GENESIS_PREV_HASH, hash: 'h', timestamp: POST_CUT_LINE,
        action_type: 'agent_task_completed', user_id: 'user-1',
      },
      chainVerified: true,
    });
    expect(ghost.workEvidence.counterparty).not.toBeNull();

    // RED CONTROL: the same PE with the counterparty corroborated carries a corroboration.
    const confirmed = projectEligibility({
      peId: 'pe-1',
      history: history({ corroboration_status: 'peer_verified' }),
      envelope: envelope({ counterparty_address: ADDR_AGENT, counterparty_type: 'agent' }),
      identity: null,
      chainVerified: true,
    });
    expect(confirmed.workEvidence.counterpartyCorroboration?.received).toBe(true);
  });

  it('prefers the SEALED economic actor id and refuses a self-contradictory record', () => {
    expect(economicActorIdOf(history())).toBe('user-1');
    expect(economicActorIdOf({
      userId: 'user-1',
      economic_snapshot: { economicActorId: 'user-1' },
    })).toBe('user-1');
    // Two different answers to "who earned this" is not an answer.
    expect(economicActorIdOf({
      userId: 'user-1',
      economic_snapshot: { economicActorId: 'user-9' },
    })).toBeNull();
    expect(economicActorIdOf({})).toBeNull();
  });

  it('never supplies a one-time anchor on the standard lane', () => {
    const projected = projectEligibility({
      peId: 'pe-1', history: history(), envelope: envelope(), identity: null, chainVerified: true,
    });
    // `settleStandardPEBatch` has no anchor concept; passing one would let an unenforced
    // anchor stand in as work evidence.
    expect(projected.workEvidence.oneTimeAnchor).toBeNull();
  });
});

describe('the record-time seal reaches settlement (2026-08-16 seam ruling)', () => {
  // The snapshot is built by the REAL producer and sealed by the REAL hasher — the single
  // sources the projection reads through `verifiedSnapshot` — never a hand-declared shape
  // (the self-referential control the run contract names).
  function sealedHistory(overrides: Partial<PEHistoryDocument> = {}): {
    doc: Partial<PEHistoryDocument>;
    snapshot: ReturnType<typeof computeRecordSnapshot>;
  } {
    const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
      peId: 'pe-1',
      economicActorId: 'user-1',
      actionType: 'compute_session',
      recordedAtMs: POST_CUT_LINE,
      occurrenceOrdinal: 1,
      dailyOrdinal: 1,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'software',
      linkageState: 'unlinked',
      evidenceState: 'verified',
      canonicalEventId: 'compute_session:lineage-1',
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: 'lineage-1',
      genesisReservation: null,
    });
    const doc = history({
      actionType: 'compute_session',
      // The exact production shape of a row: NO replication pack, NO corroboration,
      // NO tx hash. Its only evidence is the record-time seal.
      replication_pack: null,
      corroboration_status: 'none',
      economic_snapshot: snapshot,
      economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
      ...overrides,
    } as Partial<PEHistoryDocument>);
    return { doc, snapshot };
  }

  it('a -shaped row (sealed eligible+verified, nothing else) projects the seal and evaluates ELIGIBLE', () => {
    const { doc, snapshot } = sealedHistory();
    // Precondition, asserted so a future policy change fails loudly instead of making this
    // test pass over the wrong population: the record path really does seal this eligible.
    expect(snapshot.mintDisposition).toBe('eligible');
    expect(snapshot.recordTimeFactors.evidenceState).toBe('verified');

    const projected = projectEligibility({
      peId: 'pe-1',
      history: doc,
      envelope: envelope({ action_type: 'compute_session' }),
      identity: {
        id: 'pe-1', prev_hash: GENESIS_PREV_HASH, hash: `0x${'11'.repeat(32)}`,
        timestamp: POST_CUT_LINE, action_type: 'compute_session', user_id: 'user-1',
      },
      chainVerified: true,
    });
    expect(projected.workEvidence.recordTimeSeal).toEqual({ evidenceState: 'verified' });

    const verdict = evaluateEligibility(projected);
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind === 'eligible') expect(verdict.evidence).toEqual(['record_time_seal']);
  });

  it('RED CONTROL — a TAMPERED snapshot projects NO seal and the row refuses as the ghost it is', () => {
    const { doc, snapshot } = sealedHistory();
    // One field moved after sealing: the hash no longer verifies, so the mutable
    // `pe_history` record cannot smuggle in a verdict the record path never sealed.
    (doc as Record<string, unknown>).economic_snapshot = {
      ...snapshot,
      recordTimeFactors: { ...snapshot.recordTimeFactors, evidenceState: 'verified' as const },
      recordPointsAtomic: '999999999999999999999',
    };
    const projected = projectEligibility({
      peId: 'pe-1', history: doc, envelope: envelope(), identity: null, chainVerified: true,
    });
    expect(projected.workEvidence.recordTimeSeal).toBeNull();
    expect(evaluateEligibility(projected).kind).toBe('ineligible');
  });

  it('RED CONTROL — a snapshot TRANSPLANTED from another PE projects NO seal', () => {
    const { doc } = sealedHistory({ peId: 'pe-2' } as Partial<PEHistoryDocument>);
    // The snapshot is sealed for pe-1; the history row claims pe-2. Binding check refuses.
    const projected = projectEligibility({
      peId: 'pe-2', history: doc, envelope: envelope(), identity: null, chainVerified: true,
    });
    expect(projected.workEvidence.recordTimeSeal).toBeNull();
  });

  it('a GENESIS row is BYTE-UNTOUCHED by the seal — its evidence stays the one-time anchor', () => {
    const { doc } = sealedHistory({ is_genesis_grant: true } as Partial<PEHistoryDocument>);
    const projected = projectEligibility({
      peId: 'pe-1', history: doc, envelope: envelope(), identity: null, chainVerified: true,
      oneTimeAnchor: `0x${'9'.repeat(64)}`,
    });
    expect(projected.workEvidence.recordTimeSeal).toBeNull();
    expect(projected.workEvidence.oneTimeAnchor).toBe(`0x${'9'.repeat(64)}`);
  });

  it('RED CONTROL — a sealless row still refuses ghost_pe_no_work_evidence', () => {
    const projected = projectEligibility({
      peId: 'pe-1',
      history: history({ replication_pack: null, corroboration_status: 'none' }),
      envelope: envelope(),
      identity: {
        id: 'pe-1', prev_hash: GENESIS_PREV_HASH, hash: `0x${'11'.repeat(32)}`,
        timestamp: POST_CUT_LINE, action_type: 'agent_task_completed', user_id: 'user-1',
      },
      chainVerified: true,
    });
    expect(projected.workEvidence.recordTimeSeal).toBeNull();
    const verdict = evaluateEligibility(projected);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind === 'ineligible') {
      expect(verdict.reasons).toContain('ghost_pe_no_work_evidence');
    }
  });
});

describe('both chain-start sentinels legitimate writers write are recognized', () => {
  async function candidateWithPrevHash(prevHash: string) {
    const database = db();
    await database.collection(PE_HISTORY_COLLECTION).doc('pe-1').set(history() as never);
    await database.collection(ENVELOPES_COLLECTION).doc('pe-1').set(
      envelope({ prev_hash: prevHash }) as never,
    );
    return buildEligibilityCandidate(database, 'pe-1', NO_GENESIS_ANCHORS);
  }

  it("recognizes 'genesis' (core/pe/constants) — the server/mobile writer convention", async () => {
    const candidate = await candidateWithPrevHash(GENESIS_PREV_HASH);
    expect(candidate?.chainVerified).toBe(true);
  });

  it("recognizes '0x0000' (pe-chain-validator GENESIS_HASH) — what advanceChainTipAtomic puts on every durable chain's first PE", async () => {
    // Both production wallet_created rows carry exactly this and refused
    // `chain_not_verified` pre-fix.
    const candidate = await candidateWithPrevHash(GENESIS_HASH);
    expect(candidate?.chainVerified).toBe(true);
  });

  it('RED CONTROL — a non-sentinel prev_hash with no predecessor is NOT chain-verified', () => {
    return candidateWithPrevHash('0xdead').then((candidate) => {
      expect(candidate?.chainVerified).toBe(false);
    });
  });
});

describe('resolvePayee', () => {
  it('resolves a human wallet as HumanResolving', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    const resolved = await resolvePayee(database, history(), POINTS);
    expect(resolved).toEqual({
      kind: 'resolved',
      legs: [{
        leg: 'sole',
        contributor: ADDR_HUMAN,
        beneficiaryClass: BeneficiaryClass.HumanResolving,
        bps: 10_000,
        pointsAtomic: POINTS,
      }],
    });
  });

  it('resolves an unlinked agent wallet as AutonomousAgent', async () => {
    const database = db();
    await seedAgent(database, 'agent-7', ADDR_AGENT);
    const resolved = await resolvePayee(database, history({ userId: 'agent-7' }), POINTS);
    expect(resolved).toEqual({
      kind: 'resolved',
      legs: [{
        leg: 'sole',
        contributor: ADDR_AGENT,
        beneficiaryClass: BeneficiaryClass.AutonomousAgent,
        bps: 10_000,
        pointsAtomic: POINTS,
      }],
    });
  });

  it('RED CONTROL: refuses when no wallet exists for the actor at all', async () => {
    const resolved = await resolvePayee(db(), history({ userId: 'nobody' }), POINTS);
    expect(resolved).toEqual({ kind: 'refused', reason: 'payee_wallet_not_found' });
  });

  it('resolves a human wallet referenced by its DOCUMENT id — the forge-witness shape (2026-08-16)', async () => {
    // `service_installs.user_id` IS a `wallets` doc id, and the GitHub witness seals it as
    // the economic actor verbatim — every solo service:* forge row in production carries
    // exactly this shape and refused `payee_wallet_not_found` pre-fix. The doc id is the
    // wallet; `user_id` inside it is the OWNER, a different namespace entirely.
    const database = db();
    await database.collection(WALLETS_COLLECTION).doc('wallet_f99-doc-id').set({
      id: 'wallet_f99-doc-id', user_id: 'user-owner-1', type: 'human', address: ADDR_HUMAN,
    });
    const resolved = await resolvePayee(database, history({ userId: 'wallet_f99-doc-id' }), POINTS);
    expect(resolved).toEqual({
      kind: 'resolved',
      legs: [{
        leg: 'sole',
        contributor: ADDR_HUMAN,
        beneficiaryClass: BeneficiaryClass.HumanResolving,
        bps: 10_000,
        pointsAtomic: POINTS,
      }],
    });
  });

  it('RED CONTROL: the doc-id fallback accepts ONLY a human wallet doc', async () => {
    // A non-human doc under the same id namespace must not resolve through the fallback —
    // the type check is what keeps the mirror as narrow as the agent original.
    const database = db();
    await database.collection(WALLETS_COLLECTION).doc('wallet_not-human').set({
      id: 'wallet_not-human', user_id: 'user-owner-2', type: 'watch_only', address: ADDR_HUMAN,
    });
    expect(await resolvePayee(database, history({ userId: 'wallet_not-human' }), POINTS))
      .toEqual({ kind: 'refused', reason: 'payee_wallet_not_found' });
  });

  it("RED CONTROL: a doc whose own `id` field does not claim the actor is refused", async () => {
    // Mirrors mint-recipient-resolver's directWalletCandidate binding: the doc reached by
    // id must itself claim that identity.
    const database = db();
    await database.collection(WALLETS_COLLECTION).doc('wallet_mismatched').set({
      id: 'wallet_something-else', user_id: 'user-owner-4', type: 'human', address: ADDR_HUMAN,
    });
    expect(await resolvePayee(database, history({ userId: 'wallet_mismatched' }), POINTS))
      .toEqual({ kind: 'refused', reason: 'payee_wallet_not_found' });
  });

  it('RED CONTROL: the doc-id fallback never fires for a non-wallet_-prefixed actor', async () => {
    const database = db();
    await database.collection(WALLETS_COLLECTION).doc('someone-else').set({
      user_id: 'user-owner-3', type: 'human', address: ADDR_HUMAN,
    });
    expect(await resolvePayee(database, history({ userId: 'someone-else' }), POINTS))
      .toEqual({ kind: 'refused', reason: 'payee_wallet_not_found' });
  });

  it('refuses an agent wallet that is not active, address notwithstanding', async () => {
    const database = db();
    await seedAgent(database, 'agent-8', ADDR_AGENT, 'suspended');
    expect(await resolvePayee(database, history({ userId: 'agent-8' }), POINTS))
      .toEqual({ kind: 'refused', reason: 'payee_wallet_unusable' });

    // RED CONTROL: the identical wallet, active, resolves — so the refusal is about `status`.
    await seedAgent(database, 'agent-8', ADDR_AGENT, 'active');
    expect((await resolvePayee(database, history({ userId: 'agent-8' }), POINTS)).kind).toBe('resolved');
  });

  it('refuses when one actor id resolves to BOTH an agent and a human wallet', async () => {
    const database = db();
    await seedAgent(database, 'both', ADDR_AGENT);
    await seedHuman(database, 'both', ADDR_HUMAN);
    expect(await resolvePayee(database, history({ userId: 'both' }), POINTS))
      .toEqual({ kind: 'refused', reason: 'payee_identity_ambiguous' });
  });

  it('PAYS BOTH PARTIES of a linked-agent PE, as two legs of one act', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedAgent(database, 'agent-1', ADDR_AGENT);

    // M7 refused this outright (`linked_agent_split_unwired`) on the belief that a two-payee
    // split was inexpressible. It is not: the kernel dedupes on `claimSettled[claimId]`, which
    // is per claim ITEM, so two legs settle independently under two derived ids.
    const linked = await resolvePayee(database, linkedHistory(routingSnapshot()), POINTS, 'pe-1');

    expect(linked.kind).toBe('resolved');
    if (linked.kind !== 'resolved') throw new Error('unreachable');
    expect(linked.legs.map((l) => l.leg)).toEqual(['agent', 'beneficiary']);
    expect(linked.legs[0].contributor).toBe(ADDR_AGENT);
    expect(linked.legs[1].contributor).toBe(ADDR_HUMAN);
    expect(linked.legs[0].pointsAtomic).toBe('200000000000000000');
    expect(linked.legs[1].pointsAtomic).toBe('800000000000000000');
    // The parts sum to the whole — the act is neither over- nor under-paid.
    expect(linked.legs.reduce((s, l) => s + BigInt(l.pointsAtomic), 0n)).toBe(BigInt(POINTS));
    // Both legs terminate at a verified human, so both settle under the human floor. Classing
    // the agent leg as autonomous would price the same act differently by an accident of
    // representation.
    for (const leg of linked.legs) {
      expect(leg.beneficiaryClass).toBe(BeneficiaryClass.HumanResolving);
    }

    // RED CONTROL: the SAME record without the snapshot is one sole leg to the human, so the
    // two-leg result above is caused by the routing snapshot and not by the fixture at large.
    const unsplit = await resolvePayee(database, history(), POINTS);
    if (unsplit.kind !== 'resolved') throw new Error('unreachable');
    expect(unsplit.legs).toHaveLength(1);
    expect(unsplit.legs[0].leg).toBe('sole');
  });

  it('REFUSES a linked-agent PE whose agent wallet cannot be resolved', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    // No agent wallet seeded: the snapshot names an actor that does not resolve to an address.
    const refused = await resolvePayee(
      database,
      linkedHistory(routingSnapshot({ economic_actor_id: 'agent-missing' })),
      POINTS,
      'pe-1',
    );
    expect(refused).toEqual({ kind: 'refused', reason: 'linked_agent_routing_invalid' });
  });

  it('M9 — resolves a linked agent recorded under its wallet_aw_ DOCUMENT id', async () => {
    // `beneficiary_routing_snapshot.economic_actor_id` is `params.userId`, which for an agent
    // recorded under a `wallet_aw_`-prefixed id is the document id, not `agent_id`. The sole
    // path always handled that; the split path did not, so this whole class of linked-agent PEs
    // refused `linked_agent_routing_invalid` on every pass and was never paid.
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await database.collection('agent_wallets').doc('wallet_aw_direct').set({
      agent_id: 'some-other-agent-id', address: ADDR_AGENT, status: 'active',
    });

    const resolved = await resolvePayee(
      database,
      linkedHistory(routingSnapshot({ economic_actor_id: 'wallet_aw_direct' })),
      POINTS,
      'pe-1',
    );
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('unreachable');
    expect(resolved.legs.map((l) => l.contributor)).toEqual([ADDR_AGENT, ADDR_HUMAN]);

    // RED CONTROL: a `wallet_aw_` id with NO such document still refuses, so the lookup above
    // succeeded because the document exists and not because the prefix is waved through.
    expect(await resolvePayee(
      database,
      linkedHistory(routingSnapshot({ economic_actor_id: 'wallet_aw_absent' })),
      POINTS,
      'pe-1',
    )).toEqual({ kind: 'refused', reason: 'linked_agent_routing_invalid' });
  });

  it('M9 — REFUSES a routing snapshot that is not sealed to its own commitment', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedAgent(database, 'agent-1', ADDR_AGENT);

    // THE FORGERY: `pe_history` is the mutable enrichment record. A row whose snapshot was
    // rewritten to pay 99% to an attacker-chosen address must not settle. The sealed hash still
    // commits to the ORIGINAL snapshot, so the mismatch is the whole defence.
    const honest = routingSnapshot();
    const tampered = routingSnapshot({
      human_address: `0x${'ee'.repeat(20)}`,
      agent_share_bps: canonicalAgentBeneficiaryShareBps({ bps: 5000 })!,
    });
    const forged = history({
      beneficiary_routing_snapshot: tampered,
      beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(honest),
    });
    expect(await resolvePayee(database, forged, POINTS, 'pe-1'))
      .toEqual({ kind: 'refused', reason: 'linked_agent_routing_uncommitted' });

    // A snapshot with NO commitment beside it is refused too — absence is not permission.
    const uncommitted = history({ beneficiary_routing_snapshot: honest });
    expect(await resolvePayee(database, uncommitted, POINTS, 'pe-1'))
      .toEqual({ kind: 'refused', reason: 'linked_agent_routing_uncommitted' });

    // A snapshot correctly sealed but bound to a DIFFERENT PE cannot be replayed onto this one.
    const otherPe = routingSnapshot({ pe_id: 'pe-somewhere-else' });
    expect(await resolvePayee(database, history({
      beneficiary_routing_snapshot: otherPe,
      beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(otherPe),
    }), POINTS, 'pe-1'))
      .toEqual({ kind: 'refused', reason: 'linked_agent_routing_invalid' });

    // GREEN CONTROL: the honest, correctly sealed record resolves — so every refusal above is
    // caused by the tampering and not by the commitment check rejecting everything.
    expect((await resolvePayee(database, linkedHistory(honest), POINTS, 'pe-1')).kind).toBe('resolved');
  });

  it('M9 — pays the human leg at the LIVE address, not the record-time one', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedAgent(database, 'agent-1', ADDR_AGENT);
    const sealed = linkedHistory(routingSnapshot());

    // The human's wallet address changes after record time. The snapshot fixes the SHARE so the
    // split cannot be repriced; it must not fix the DESTINATION, or PVT is minted irreversibly
    // to an address the human no longer controls.
    const moved = `0x${'cd'.repeat(20)}`;
    await seedHuman(database, 'user-1', moved);

    const resolved = await resolvePayee(database, sealed, POINTS, 'pe-1');
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('unreachable');
    expect(resolved.legs[1].contributor).toBe(moved);
    // The share is untouched by the move — that is what the snapshot is for.
    expect(resolved.legs[0].pointsAtomic).toBe('200000000000000000');
    expect(resolved.legs[1].pointsAtomic).toBe('800000000000000000');

    // RED CONTROL: with the human wallet gone entirely the leg refuses rather than falling back
    // to the record-time address, so the live read is genuinely the source of the answer.
    await database.collection('wallets').doc('w-user-1').set({
      user_id: 'user-1', type: 'agent', address: moved,
    });
    expect(await resolvePayee(database, sealed, POINTS, 'pe-1'))
      .toEqual({ kind: 'refused', reason: 'payee_wallet_not_found' });
  });
});

describe('createFirestoreInletSource', () => {
  async function seedPe(
    database: SettlementDb,
    peId: string,
    overrides: { history?: Partial<PEHistoryDocument>; envelope?: Partial<SealedEnvelopeFixture> } = {},
  ): Promise<void> {
    await database.collection(PE_HISTORY_COLLECTION).doc(peId)
      .set(history({ peId, ...overrides.history }) as Record<string, unknown>);
    await database.collection(ENVELOPES_COLLECTION).doc(peId)
      .set(envelope({ id: peId, hash: `0x${peId.length.toString(16).padStart(64, '0')}`, ...overrides.envelope }) as unknown as Record<string, unknown>);
  }

  it('offers an eligible PE with a real payee, and reports the read count', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-a');

    const page = await createFirestoreInletSource({ db: database })
      .loadPage({ pageSize: 10 });

    expect(page.readCount).toBe(1);
    expect(page.candidates.length).toBe(1);
    expect(page.lastKey).toBe('pe-a');
    const candidate = page.candidates[0];
    expect(candidate.lane).toBe('standard');
    expect(candidate.contributor).toBe(ADDR_HUMAN);
    expect(candidate.eligibility.chainVerified).toBe(true);
    expect(candidate.eligibility.relayMintStatus).toBe('eligible');
    expect(candidate.eligibility.workEvidence.workProductHash).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('reports readCount and lastKey for rows it FILTERED, not just offered', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-a');
    await seedPe(database, 'pe-b');
    // pe-a already claimed: filtered out, but still READ.
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-a', 'sole'))
      .set({ pe_id: 'pe-a', pe_key: 'pe-a' });

    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 2 });

    expect(page.readCount).toBe(2);
    expect(page.candidates.map((c) => c.peId)).toEqual(['pe-b']);
    // THE POINT: the cursor is the last row READ. Deriving it from the offered set would work
    // here by luck; the control below is the case where it would not.
    expect(page.lastKey).toBe('pe-b');
  });

  it('RED CONTROL: a page whose every row is filtered still reports a cursor', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-a');
    await seedPe(database, 'pe-b');
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-a', 'sole'))
      .set({ pe_id: 'pe-a', pe_key: 'pe-a' });
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-b', 'sole'))
      .set({ pe_id: 'pe-b', pe_key: 'pe-b' });

    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 2 });

    expect(page.candidates).toEqual([]);
    expect(page.readCount).toBe(2);
    // Without this the inlet would restart at the top of the same page forever.
    expect(page.lastKey).toBe('pe-b');
  });

  it('does not offer Genesis rows on the standard lane', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-g', { history: { is_genesis_grant: true } });

    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.readCount).toBe(1);
    expect(page.candidates).toEqual([]);

    // RED CONTROL: the identical row without the Genesis marker IS offered.
    await seedPe(database, 'pe-s', { history: { is_genesis_grant: false } });
    const next = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(next.candidates.map((c) => c.peId)).toEqual(['pe-s']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // the settlement-interleaved order that deviated on VALUE.
  //
  // The failing interleaving, precisely: the inlet REGISTERS the daemon incumbent
  // (`coding_session`, base 1.0×) before the forge webhook (base 3.0×) arrives. The
  // forge then finds a registered incumbent, `evaluateCommitWitness` returns 'none',
  // and the commit mints ONCE at the incumbent's uncorroborated value instead of the
  // forge's proof-tier value. Mint-once always held; only value deviated.
  //
  // The takeover cannot fix it from its side — demoting a registered incumbent would
  // strand a settleable claim. So the inlet does not register a commit-bearing PE
  // while a cross-witness could still take the slot. These controls pin BOTH sides of
  // that window, because a deferral with no proven upper bound is a stranded claim.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the commit cross-witness deferral', () => {
    const WINDOW_MS = 72 * 60 * 60 * 1000;
    const SHA = 'a'.repeat(40);

    it('does NOT offer a commit-bearing PE while the takeover window is still open', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-commit', { history: { commit_sha: SHA } });

      // One minute after the commit was recorded: a forge webhook could still arrive.
      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      // Read, so the cursor still advances — deferred, not dropped.
      expect(page.readCount).toBe(1);
      expect(page.lastKey).toBe('pe-commit');
      expect(page.candidates).toEqual([]);
    });

    it('DOES offer it once the window has closed — the deferral is bounded', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-commit', { history: { commit_sha: SHA } });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + WINDOW_MS + 1,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-commit']);
    });

    it('the boundary is exact — AT the window edge it is already offered', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-commit', { history: { commit_sha: SHA } });

      // `now < recordedAt + WINDOW` is the deferral test, so equality must NOT defer.
      // Asserted because an off-by-one here is the difference between "bounded" and
      // "bounded except at one instant nobody ever evaluates".
      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + WINDOW_MS,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-commit']);
    });

    // ── RED: the OTHER orderings are unchanged ────────────────────────────────
    it('RED — a PE with no commit_sha is offered inside the same window', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-plain');

      // Identical instant to the deferring case above. If this were also deferred, the
      // guard would be delaying the whole standard lane rather than commit PEs, and the
      // first assertion would be evidence of the wrong thing.
      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-plain']);
    });

    it('RED — an unreadable commit row is NOT deferred (bad data cannot strand a claim)', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      // A commit marker with no usable record time. Deferring on this would compare
      // against NaN, never become false, and strand the claim forever — so the guard
      // must fall through to today's behaviour instead.
      await seedPe(database, 'pe-bad', {
        history: { commit_sha: SHA, timestamp: undefined as unknown as number },
      });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-bad']);
    });

    it('RED — an empty commit_sha is not treated as a commit', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-empty', { history: { commit_sha: '   ' } });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-empty']);
    });

    it('production leaves the clock unset and still defers by real time', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      // Recorded "now" rather than at the fixture's fixed past instant, so the default
      // Date.now path is the one under test — otherwise this suite would only ever prove
      // the injected clock works.
      await seedPe(database, 'pe-fresh', {
        history: { commit_sha: SHA, timestamp: Date.now() },
      });

      const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
      expect(page.candidates).toEqual([]);
    });
  });

  describe('the completion cross-witness deferral (the same rule for the completion kind)', () => {
    const WINDOW_MS = 72 * 60 * 60 * 1000;
    const CANONICAL = 'escrow:esc_22222222-2222-4222-8222-222222222222';

    it('does NOT offer a resolver-promoted OFF-CHAIN completion witness while its takeover window is open', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-offchain', {
        history: { completion_canonical_id: CANONICAL, completion_witness: 'counterparty_confirmation' },
      });

      // One minute after the delivery was recorded: the escrow release could still land.
      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      // Read, so the cursor still advances — deferred, not dropped.
      expect(page.readCount).toBe(1);
      expect(page.lastKey).toBe('pe-offchain');
      expect(page.candidates).toEqual([]);
    });

    it('DOES offer it once the window has closed — the deferral is bounded', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-offchain', {
        history: { completion_canonical_id: CANONICAL, completion_witness: 'counterparty_confirmation' },
      });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + WINDOW_MS,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-offchain']);
    });

    it('RED — the ON-CHAIN completion witness is offered inside the same window (nothing can take it over)', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-onchain', {
        history: { completion_canonical_id: CANONICAL, completion_witness: 'onchain_release' },
      });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-onchain']);
    });

    it('RED — a PE with no completion marker is offered inside the same window', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-plain');

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-plain']);
    });

    it('RED — an unreadable completion row is NOT deferred (bad data cannot strand a claim)', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-bad', {
        history: {
          completion_canonical_id: CANONICAL,
          completion_witness: 'counterparty_confirmation',
          timestamp: undefined as unknown as number,
        },
      });

      const page = await createFirestoreInletSource({
        db: database,
        now: () => POST_CUT_LINE + 60_000,
      }).loadPage({ pageSize: 10 });

      expect(page.candidates.map((c) => c.peId)).toEqual(['pe-bad']);
    });

    it('production leaves the clock unset and still defers by real time (completion kind)', async () => {
      const database = db();
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-fresh-completion', {
        history: {
          completion_canonical_id: CANONICAL,
          completion_witness: 'counterparty_confirmation',
          timestamp: Date.now(),
        },
      });

      const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
      expect(page.candidates).toEqual([]);
    });
  });

  describe(' a speech PE registers only under a FINAL talking-pass burn', () => {
    const BURN = 'b'.repeat(64);
    async function seedSpeech(database: SettlementDb, finality: 'provisional' | 'final' | 'revoked' | 'legacy'): Promise<void> {
      await seedHuman(database, 'user-1', ADDR_HUMAN);
      await seedPe(database, 'pe-speech', {
        history: { actionType: 'commons_post_created' },
        envelope: { action_type: 'commons_post_created' },
      });
      await database.collection('speech_window_reservations').doc('pe-speech')
        .set({ pe_id: 'pe-speech', burn_id: BURN, action_type: 'commons_post_created' });
      const row: Record<string, unknown> = { status: 'recorded', verified: true, wallet_id: 'w', amount_atomic: '15' };
      if (finality === 'provisional') row.finality = 'provisional';
      if (finality === 'final') row.finality = 'final';
      if (finality === 'revoked') Object.assign(row, { status: 'revoked', verified: false, finality: 'failed' });
      await database.collection('pvt_burn_records').doc(BURN).set(row);
    }

    it('RED CONTROL: holds it (skip, not drop) while the window burn is provisional; never offers it once revoked', async () => {
      for (const finality of ['provisional', 'revoked'] as const) {
        const database = db();
        await seedSpeech(database, finality);
        const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
        expect(page.candidates).toEqual([]);
        // Skip, not drop: the row was read and the cursor moved past it.
        expect(page.readCount).toBe(1);
        expect(page.lastKey).toBe('pe-speech');
      }
    });

    it('offers it once the window burn is final (or legacy — recorded at finality before the ruling)', async () => {
      for (const finality of ['final', 'legacy'] as const) {
        const database = db();
        await seedSpeech(database, finality);
        const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
        expect(page.candidates.map((c) => c.peId)).toEqual(['pe-speech']);
      }
    });

    it('an already-registered speech PE pays no burn read (the settled backlog costs nothing)', async () => {
      const database = db();
      await seedSpeech(database, 'provisional');
      await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-speech', 'sole')).set({ pe_id: 'pe-speech', pe_key: 'pe-speech' });
      // Any read of the speech gate's collections throws: a registered leg must never reach it.
      const guarded = {
        ...database,
        collection: (name: string) => {
          if (name === 'speech_window_reservations' || name === 'pvt_burn_records') throw new Error(`unexpected read of ${name}`);
          return database.collection(name);
        },
      } as SettlementDb;
      const page = await createFirestoreInletSource({ db: guarded }).loadPage({ pageSize: 10 });
      expect(page.candidates).toEqual([]);
      expect(page.readCount).toBe(1);
    });
  });

  it('selects only mint_status === eligible', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-m', { history: { mint_status: 'minted' } });
    await seedPe(database, 'pe-e');

    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.candidates.map((c) => c.peId)).toEqual(['pe-e']);
    expect(page.readCount).toBe(1);
  });

  it('marks a PE whose predecessor envelope is absent as chain-unverified', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    await seedPe(database, 'pe-orphan', {
      envelope: { prev_hash: `0x${'de'.repeat(32)}` },
    });

    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.candidates[0].eligibility.chainVerified).toBe(false);

    // RED CONTROL: seed the predecessor and the same PE verifies. Without this, a resolver
    // hard-wired to `false` would pass the assertion above.
    await database.collection(ENVELOPES_COLLECTION).doc('pe-parent')
      .set(envelope({ id: 'pe-parent', hash: `0x${'de'.repeat(32)}` }) as unknown as Record<string, unknown>);
    const again = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(again.candidates[0].eligibility.chainVerified).toBe(true);
  });

  it('offers an unresolvable payee with its REFUSAL REASON and no address', async () => {
    const database = db();
    await seedPe(database, 'pe-nopayee');
    const page = await createFirestoreInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.candidates[0].contributor).toBe('');
    expect(page.candidates[0].contributorRefusal).toBe('payee_wallet_not_found');
  });

  it('pages with a RAW cursor, never a case-folded one', async () => {
    const database = db();
    await seedHuman(database, 'user-1', ADDR_HUMAN);
    // Mixed case on purpose: Firestore orders byte-wise, so 'pe-B' sorts BEFORE 'pe-a'.
    // Lower-casing the cursor after reading 'pe-B' would resume after 'pe-b' and skip 'pe-a'.
    await seedPe(database, 'pe-B');
    await seedPe(database, 'pe-a');

    const source = createFirestoreInletSource({ db: database });
    const first = await source.loadPage({ pageSize: 1 });
    expect(first.lastKey).toBe('pe-B');
    const second = await source.loadPage({ pageSize: 1, startAfterKey: first.lastKey });
    expect(second.candidates.map((c) => c.peId)).toEqual(['pe-a']);

    // RED CONTROL: the case-folded cursor the defective version used skips 'pe-a' entirely.
    const folded = await source.loadPage({ pageSize: 1, startAfterKey: first.lastKey!.toLowerCase() });
    expect(folded.candidates).toEqual([]);
  });
});
