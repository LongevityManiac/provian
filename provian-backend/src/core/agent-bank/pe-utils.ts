import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Agent Bank - Shared PE Generation Utility
 *
 * Generates Provenance Envelopes for Agent Bank actions and enqueues them
 * for batched writing. Used by escrow, court, scheduler, webhooks, etc.
 *
 * SECURITY (Phase H audit, finding H-3, Theme 7/1):
 * Every PE generated here MUST have its prev_hash resolved atomically from
 * the per-chain `pe_chain_tips` document. The previous implementation
 * accepted `prevHash: 'CHAIN_TIP'` as a sentinel string and wrote it
 * verbatim into the PE content - which silently broke the append-only
 * hash chain invariant (Security Invariant #5) for every Agent Bank,
 * Commons, PVT, and governance PE in the system. That sentinel is now
 * rejected at runtime; the function resolves the real chain tip via
 * advanceChainTipAtomic inside a Firestore transaction.
 *
 * Chain owner: we key `pe_chain_tips` by `agentId`. This matches the
 * `user_id` field on the stored PE and the accrual path, so human and
 * agent wallets share one chain per identity.
 */

import crypto from 'crypto';
import { deriveCompositionSignals } from '../pvt/actor-stats';
import type admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import type { AgentBankDeps } from './types';
import { advanceChainTipAtomic, isThenable } from '../../pe-chain-validator';
import { resolveX402PayerAddress, resolveX402SettlementTxHash, resolveX402ChainVerified } from '../../pvt-accrual';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { normalizeOutputDigests } from '../provenance/output-digests';
import type { WitnessClass } from '../pvt/policy/evidence-class';
import { deriveEmitterWitnessClass, deriveOutputDigestsFromMetadata } from '../pvt/policy/emitter-witness';
import { readComputeTokens } from '../pvt/origin-pricing-inputs';
import { relayWitnessedOriginsFor, type RelayObservation } from '../pvt/relay-observation-witness';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from '../pvt/wp11/ordinary-accrual-intake';
import type { RecordEconomicSnapshot } from '../pvt/policy/monetary-accounting';
import {
  buildRelayActIntake,
  METER_RELAY_ACTS_COLLECTION,
  priceRelayAct,
  relayPeOf,
  resolveRelaySealTargets,
  sealRelayPe,
  stageRelayActInTransaction,
  type RelayActIntake,
} from '../meter/meter-relay-authored';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import { buildIdentityAct, isIdentityActType, stageIdentityActInTransaction } from '../meter/identity-acts';
import { buildSpeechWindowAct, stageSpeechWindowActInTransaction } from '../commons/speech-window-acts';
import { peHashOf as wirePeHashOf, type PeV2 } from '../meter/meter-wire';

/** Firestore collection holding Provenance Envelope documents. */
const PE_COLLECTION = 'provenance_envelopes';

export interface ComputeTelemetry {
  duration_ms?: number | null;
  tokens_processed?: number | null;
  records_processed?: number | null;
  output_cardinality?: number | null;
  cpu_seconds?: number | null;
  memory_peak_mb?: number | null;
  energy_joules?: number | null;
  gpu_seconds?: number | null;
  model_parameters?: number | null;
  framework?: string | null;
  hardware_class?: string | null;
}

export interface GeoProvenance {
  latitude?: number | null;
  longitude?: number | null;
  altitude_m?: number | null;
  accuracy_m?: number | null;
  hardware_attested: boolean;
  region_code?: string | null;
}

export interface ExecutionEnv {
  os?: string | null;
  os_version?: string | null;
  runtime?: string | null;
  runtime_version?: string | null;
  container?: boolean | null;
  tee_type?: string | null;
  tee_version?: string | null;
}

export interface GeneratePEParams {
  walletId: string;
  agentId: string;
  /**
   * The actor's on-chain address, or null when none is resolvable (a wallet
   * mid-onboarding). null is stored
   * as null — never a wallet/user id standing in for an address, which the
   * same-owner fence reads as "no counterparty" and skips.
   */
  actorAddress: string | null;
  actionType: string;
  metadata: Record<string, unknown>;
  /** Trusted wallet-owner classification for economic linkage. */
  ownerType?: 'human' | 'agent';
  /** Trusted actor wallet address when available. */
  walletAddress?: string | null;
  /** The counterparty's on-chain address; null/undefined when none is resolvable (never a wallet id). */
  counterpartyAddress?: string | null;
  /**
   * 2026-10-01 : the verified signer of the transaction a chain
   * watcher read, when it differs from the counterparty (value that reached the
   * wallet through a contract). The same-owner fence checks it as well.
   */
  transactionSignerAddress?: string | null;
  /**
   * Action type recorded for PVT accrual when it must differ from the PE's
   * own `action_type`. Example: the agent-wallet birth certificate is the PE
   * `agent_wallet_created` but accrues under `wallet_created` so it stays
   * subject to the per-device setup rate limit (Security Invariant #9).
   * Defaults to `actionType` when omitted.
   */
  accrualActionType?: string;
  // Extended structural fields - null if not available, never required
  compute?: ComputeTelemetry | null;
  geo?: GeoProvenance | null;
  execution_env?: ExecutionEnv | null;
  cited_pe_ids?: string[] | null;
  parent_goal_pe_id?: string | null;
  /**
   * Prompt 1 (forward-only): external input origins this PE's work consumed.
   * Any caller-shaped value is accepted; it is normalized to its canonical
   * three-state form before hashing/storage. PURE PROVENANCE with ZERO mint
   * effect — carried on the canonical chain doc, never read by the sealing
   * computation. Absent (null / not an array) → the key is omitted so the PE is
   * byte-identical to a pre-change one.
   */
  input_origins?: unknown;
  /**
   * Trust Layer build §2.3 (forward-only): what this PE PRODUCED — hash + type tag (+ optional
   * public locator). Normalized like `input_origins`; absent → key omitted (legacy-identical
   * hash). Indexed by hash so a consumer's captured digest resolves to this PE and signer.
   */
  output_digests?: unknown;
  /**
   * : the witness class the EMITTER vouches for (relay-assigned, unhashed).
   * Watchers say `chain_witnessed`, forge webhooks `forge_witnessed`, relay-verified institution
   * rows `relay_verified`; a self-report omits it and seals `actor_declared` (fail-closed).
   */
  witnessClass?: WitnessClass;
  /**
   * the SEALED hardware-witness summary (`sealedHardwareWitness()`) the lane produced for THIS
   * PE, when it ran admission. The only source of the attested region / launch measurement the
   * vocabulary counts (and only under the `hardware_rooted` class). Never the raw request slot.
   */
  sealedHardwareWitness?: Record<string, unknown> | null;
  /**
   * (Commons communication): the live speech window this act was written under (from
   * `core/commons/speech-window.ts::assertSpeechWindow`). Forwarded into the accrual so the
   * sealed record points are reserved against the window's budget — the invariant that a
   * wallet's speech inside one window mints strictly less than the burn that opened it. Omit on
   * every non-speech path.
   */
  speechWindow?: { readonly burnId: string; readonly burnAmountAtomic: string } | null;
  /**
   * Fact-base fixes item 4 : a relay-composed emitter's OWN verified observation
   * (HMAC-verified forge webhook, chain watcher / on-chain verification) and EXACTLY the origins it
   * derived from that verified event. Those origins — and only those — are witnessed at pricing; an
   * origin unioned in from a device body or read from a self-report is never in `derivedOrigins`.
   * NEVER set on the sovereign lane or any actor-reported path. Omit everywhere else.
   */
  relayObservation?: RelayObservation | null;
  /** Deterministic id for a durable outbox. Omit for ordinary PEs. */
  peIdOverride?: string;
  /** Authoritative occurrence time for a durable outbox. Omit for ordinary PEs. */
  timestampOverride?: number;
  /** Precomputed exact economics sealed by a trusted reservation state machine. */
  economicSnapshot?: RecordEconomicSnapshot | null;
  /** Wait for pe_history acknowledgement instead of fire-and-forget. */
  awaitAccrual?: boolean;
  /**
   * opt in to the DURABLE economic path via the cutover reconciliation ordinary-accrual
   * intake row this function already co-commits inside the chain-tip
   * transaction.
   *
   * Without it a caller seals `record_only` however good its evidence is
   * (`pvt-accrual.ts::resolveOperationalDisposition` "no durable replay
   * source ⇒ record_only"), which proved is one of the three conditions
   * that together seal `eligible`.
   *
   * IT IS OPT-IN, and deliberately so. Flipping it for a caller changes that
   * caller's sealed disposition, so it is a per-site decision, never a default.
   *
   * INVALID WITH `awaitAccrual: true` that branch SKIPS the intake co-commit
   * (a durable caller is expected to own its source outbox), so the claim
   * would have no committed row to verify against and the accrual would refuse
   * it and warn. The combination throws here rather than shipping a caller
   * that silently seals `record_only` while believing it is durable — the
   * defect wearing a marker.
   */
  durableViaOrdinaryIntake?: boolean;
  /**
   * the canonical event identity OBSERVED for this PE, sealed
   * independently of the evidence verdict.
   *
   * `economicCanonicalEventId` is otherwise derived from
   * `metadata.verified === true`, which couples the IDENTITY of an event to the
   * VERDICT about it. For a verdict-less observer that coupling is wrong: it
   * observed a specific log and knows exactly which one, and the row should say
   * so even while the verdict is still absent.
   *
   * Sealing it does NOT make anything eligible — proved `evidenceState:
   * 'verified'` is a SEPARATE necessary condition, so a row with an id and no
   * verdict seals `pending_evidence` and pays 0.
   *
   * Deliberately a param rather than a change to the metadata gate: every other
   * caller's sealed snapshot stays byte-identical.
   */
  observedCanonicalEventId?: string | null;
  /**
   * the canonical COMPLETION id this PE is a witness of (see
   * `core/pvt/completion-claim.ts` for the exact forms). Set ONLY by the
   * institution-completion watcher for an escrow release / resolution paid to
   * the recipient, after resolving the relay escrow the observed bytes32 id is
   * pinned on. It keys the `completion` mint-once claim so the on-chain witness
   * and the resolver-promoted off-chain confirmation of ONE job collide on one
   * document. Forwarded only when set, so every other caller's stored intake
   * row is byte-identical to before.
   */
  completionCanonicalId?: string | null;
  /** Retired compatibility field. Exact Genesis value requires economicSnapshot. */
  fixedEstimatedPVT?: number | null;
  /** Retired compatibility marker; exact Genesis authority is in economicSnapshot. */
  isGenesisGrant?: boolean;
  /**
   * Retired PVTv8 audit context. Current Genesis never releases or re-debits
   * legacy pool/source ledgers through these fields.
   */
  genesisWalletId?: string | null;
  genesisFundingSourceAddress?: string | null;
  /**
   * WS4 — optional atomic entity co-write. When provided, the entity document is
   * committed in the SAME Firestore transaction as the PE document and the
   * chain-tip advance, so the PE and its entity are durable-or-nothing together
   * (no orphan in either direction). Invoked INSIDE the transaction with the live
   * txn and the new PE id. It MUST only write (no reads — the tip read already
   * happened) and MUST be safe to re-run on transaction retry (build the entity
   * payload from captured values; no external side effects). Throwing rolls the
   * whole transaction back (no PE, no entity, no tip advance). Used by the Commons
   * writers (forum / human-jobs / vouching); omitted on every other path.
   */
  atomicEntityWrite?: (
    txn: admin.firestore.Transaction,
    peId: string,
    context?: { prevHash: string; newHash: string; timestamp: number },
  ) => void;
  /** Optional read-only half paired with atomicEntityWrite. Firestore runs it
   * before the chain-tip/PE/entity writes, allowing a canonical registration
   * to serialize uniqueness, idempotency, checkpoint, and admission reads in
   * the same transaction. */
  atomicEntityPrecondition?: (
    txn: admin.firestore.Transaction,
    context: { prevHash: string },
  ) => Promise<void>;
}

export interface GeneratedPE {
  peId: string;
  peHash: string;
  prevHash: string;
}

class ExistingDeterministicPE extends Error {
  constructor(
    readonly prevHash: string,
    readonly peHash: string,
    /** `priced`: its act key exists; `staged`: its intake awaits pricing; `legacy`: a pre-meter envelope. */
    readonly state: 'priced' | 'staged' | 'legacy',
    readonly intake: RelayActIntake | null,
  ) {
    super('deterministic_pe_already_exists');
  }
}

/**
 * The three dependencies this module actually touches, declared as its contract.
 *
 * It was typed `AgentBankDeps` — a fourteen-member interface whose `cache: RedisCache`
 * is required and never read here. That over-declaration is not cosmetic: it locked PE
 * generation to callers who happen to hold an Agent Bank deps bag, so the human
 * wallet-registration path (which has `db`/`peBuffer`/`recordPEAccrual` and no cache)
 * could not use the canonical emitter at all without a cast. Narrowing to what is used
 * is backward compatible in the direction that matters — every existing caller passes a
 * superset and keeps type-checking unchanged.
 */
export type PeGenerationDeps = Pick<AgentBankDeps, 'db' | 'peBuffer' | 'recordPEAccrual'>;

/**
 * Generate and enqueue a PE with an atomically-advanced chain tip.
 *
 * The PE content - including its `prev_hash` field - is computed inside
 * a Firestore transaction that serializes chain advancement. Two concurrent
 * calls on the same `agentId` are guaranteed to see distinct prev_hash
 * values, so the hash chain stays append-only.
 */
export async function generatePE(
  deps: PeGenerationDeps,
  params: GeneratePEParams,
): Promise<GeneratedPE> {
  const now = params.timestampOverride ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('PE timestamp must be a non-negative safe integer');
  }
  //. `awaitAccrual: true` SKIPS the intake co-commit below, so a durable
  // claim made alongside it would have no committed row to verify against: the
  // accrual would refuse the marker, warn, and seal `record_only` while the
  // caller believed it was durable. Refuse the combination at the door rather
  // than ship that silence.
  if (params.durableViaOrdinaryIntake === true && params.awaitAccrual === true) {
    throw new Error('generatePE_durable_via_intake_conflicts_with_awaitAccrual');
  }
  const peId = params.peIdOverride ?? `pe_${uuidv4()}`;
  if (!/^pe_[A-Za-z0-9_-]{1,240}$/.test(peId)) {
    throw new Error('PE id override is invalid');
  }

  // Prompt 1: normalize `input_origins` ONCE so the hashed content and the
  // stored doc carry byte-identical bytes. `null` (absent) means the key is
  // omitted from the canonical content below — a PE that observed no origins is
  // then byte-identical to every PE written before this field existed.
  const normalizedInputOrigins = normalizeInputOrigins(params.input_origins);
  // Fact-base fixes item 4: key the emitter's relay-derived origins against what is actually sealed.
  const relayWitnessedOrigins = relayWitnessedOriginsFor(params.relayObservation, normalizedInputOrigins);
  // Trust Layer build §2.3/§2.8: an explicit `output_digests` / `witnessClass` wins; otherwise a
  // relay-composed lane derives BOTH from the verified event it observed, by identifier type
  // (`emitter-witness.ts`). An unverified body derives nothing and seals actor_declared.
  const normalizedOutputDigests = normalizeOutputDigests(params.output_digests)
    ?? deriveOutputDigestsFromMetadata(params.metadata);
  const witnessClass: WitnessClass = deriveEmitterWitnessClass({
    declared: params.witnessClass,
    metadata: params.metadata,
    observedCanonicalEventId: params.observedCanonicalEventId ?? null,
  });
  const witnessedAtMs = Date.now();

  // Canonical PE content builder. The SAME object shape MUST be used both to
  // compute the chain-tip hash (inside advanceChainTipAtomic) and to build the
  // enqueued/stored document - otherwise the stored `hash` diverges from the
  // value the chain tip advanced to, and `prev_hash` of the next PE no longer
  // equals this PE's stored hash, silently breaking the append-only chain
  // (Security Invariant #5). The five extended structural fields are part of
  // the canonical content and MUST appear in both, even when null:
  // json-stable-stringify serializes null-valued keys, so omitting them
  // changes the hash.
  const buildContent = (prevHashVal: string) => ({
    id: peId,
    wallet_id: params.walletId,
    agent_id: params.agentId,
    action_type: params.actionType,
    actor_address: params.actorAddress,
    timestamp: now,
    prev_hash: prevHashVal,
    attestation_type: 'software',
    metadata: params.metadata,
    // Extended structural fields - included when provided, null otherwise
    compute: params.compute ?? null,
    geo: params.geo ?? null,
    execution_env: params.execution_env ?? null,
    cited_pe_ids: params.cited_pe_ids ?? null,
    parent_goal_pe_id: params.parent_goal_pe_id ?? null,
    // Prompt 1: forward-only. Present (`[]` or populated) only when the caller
    // observed origins; omitted (→ legacy-identical hash) otherwise.
    ...(normalizedInputOrigins !== null ? { input_origins: normalizedInputOrigins } : {}),
    ...(normalizedOutputDigests !== null ? { output_digests: normalizedOutputDigests } : {}),
  });

  // PE METER : the relay authors a PE v2 — the same object its owner receives
  // sealed and can later prove — and its hash is the v2 hash. Identity fields move to the v2 slots;
  // everything else in the canonical content is carried verbatim.
  const relayPeFor = (prevHashVal: string): PeV2 => {
    const { id: _id, prev_hash: _prev, timestamp: _ts, action_type: _at, ...content } = buildContent(prevHashVal);
    return relayPeOf({ peId, actorId: params.agentId, prevHash: prevHashVal, timestamp: now, actionType: params.actionType, content });
  };
  const peHashOf = (prevHashVal: string): string => wirePeHashOf(relayPeFor(prevHashVal));

  // Pre-meter envelopes (read only by the deterministic-id replay check until the migration).
  const peRef = deps.db.collection(PE_COLLECTION).doc(peId);

  // Metadata.commit_sha forwarding for cross-witness mint-once dedup - the
  // same commit must mint once whether the observer, a GitHub webhook, or a
  // GitLab webhook witnesses it (consumed inside buildAccrualParams below).
  const commitSha = typeof params.metadata?.commit_sha === 'string'
    ? params.metadata.commit_sha
    : null;

  // sovereign agent-work occurrence mint-once. Forwarded ONLY when this is
  // a VERIFIED sovereign-work PE (metadata.verified === true is stamped by the
  // sovereign-pe route only after the per-occurrence agent-key binding verifies
  // against binding_signer). Both id and signer must be present; otherwise null
  // so recordPEAccrual neither claims nor mints an occurrence. A bare relay PE
  // never carries sovereign_work, so it can never reach this branch.
  const sovereignWorkOccurrence =
    params.metadata?.sovereign_work === true
    && params.metadata?.verified === true
    && typeof params.metadata?.occurrence_id === 'string'
    && typeof params.metadata?.binding_signer === 'string'
      ? {
        occurrenceId: params.metadata.occurrence_id,
        signerAddress: params.metadata.binding_signer,
      }
      : null;

  // cutover reconciliation durable ordinary intake: ONE pure builder produces the exact accrual
  // input for BOTH the intake row (co-committed inside the tip transaction for
  // best-effort callers) and the live recordPEAccrual call after the advance,
  // so the stored replay source and the fired accrual can never drift. Pure by
  // construction (a function of the committed PE hash only), so it is safe to
  // call inside the transaction on a contention retry.
  const buildAccrualParams = (
    committedPeHash: string,
  ): Parameters<AgentBankDeps['recordPEAccrual']>[0] => ({
    peId,
    userId: params.agentId,
    actionType: params.accrualActionType ?? params.actionType,
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: committedPeHash,
    timestamp: now,
    commitSha,
    //. Built INSIDE the shared builder on purpose: this same object is
    // both stored as the intake row and fired as the live accrual call, so the
    // marker cannot be present on one and absent from the other. The accrual
    // verifies the two are byte-identical and refuses otherwise.
    ...(params.durableViaOrdinaryIntake === true
      ? { durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE }
      : {}),
    // Lineage / goal linkage - persisted with the act as its citation record
    // (the retired PVTv8 minting engine read them for lineage attribution;
    // consumption edges pay nothing under).
    citedPeIds: params.cited_pe_ids ?? null,
    parentGoalPeId: params.parent_goal_pe_id ?? null,
    fixedEstimatedPVT: params.fixedEstimatedPVT ?? null,
    isGenesisGrant: params.isGenesisGrant === true,
    // #27 (Pass-2): forward the genesis reservation key so a suppressed accrual
    // releases the reservation (caps + per-source ledger). Null on non-genesis.
    genesisWalletId: params.genesisWalletId ?? null,
    genesisFundingSourceAddress: params.genesisFundingSourceAddress ?? null,
    // x402: credit x402_payment_count to the SOVEREIGN agent wallet that paid.
    // Same shared resolver the /v1/relay/action + device /v1/pe/submit paths
    // use; undefined (no-op) for every non-x402 PE generated via this helper.
    x402PayerAddress: resolveX402PayerAddress(
      params.accrualActionType ?? params.actionType,
      params.metadata,
    ),
    // x402 cross-source mint-once dedup key (settlement tx) - exactly-once
    // minting across the SDK self-report + the chain-verified watcher.
    x402SettlementTxHash: resolveX402SettlementTxHash(
      params.accrualActionType ?? params.actionType,
      params.metadata,
    ),
    // Option B (x402 watcher-only mint): only a chain-verified outbound-watcher
    // emit stamps metadata.chain_verified === true, so only it can mint / count
    // x402. Every self-report path resolves false → x402_unverified (0 PVT).
    x402ChainVerified: resolveX402ChainVerified(
      params.accrualActionType ?? params.actionType,
      params.metadata,
    ),
    // sovereign agent-work occurrence mint-once keys (both or neither).
    sovereignWorkOccurrenceId: sovereignWorkOccurrence?.occurrenceId ?? null,
    sovereignWorkSignerAddress: sovereignWorkOccurrence?.signerAddress ?? null,
    // Identity/count-only anti-farming. Amounts remain provenance metadata.
    counterpartyAddress: params.counterpartyAddress ?? null,
    economicTransactionSigner: params.transactionSignerAddress ?? null,
    // Trusted server verifiers stamp metadata.verified only after validating
    // the canonical event. A tx hash without that verdict remains pending
    // evidence.
    economicEvidenceState: params.metadata.verified === true ? 'verified' : undefined,
    // an EXPLICITLY observed identity wins. It is a fact about which log
    // was seen, not a consequence of the verdict about it, so a verdict-less
    // observer still binds its row to the exact event. Falls back to the
    // verdict-gated derivation for every other caller, unchanged.
    economicCanonicalEventId: params.observedCanonicalEventId
      ?? (params.metadata.verified === true
        ? firstEconomicEventId(params.metadata)
        : null),
    economicSnapshot: params.economicSnapshot ?? null,
    ownerType: params.ownerType,
    walletAddress: params.walletAddress ?? params.actorAddress,
    // the completion claim key, forwarded only when the caller resolved one.
    ...(typeof params.completionCanonicalId === 'string' && params.completionCanonicalId.length > 0
      ? { completionCanonicalId: params.completionCanonicalId }
      : {}),
    throwOnError: params.awaitAccrual === true,
    // Trust Layer build §2.1: every generatePE lane's origins enter the ONE graph. No device vouches
    // for a relay-composed body, so `submissionWitness` stays null. Fact-base fixes item 4
    // (2026-09-23): a relay-composed emitter's OWN verified observation witnesses EXACTLY the origins
    // it derived from that event (`relayWitnessedOrigins`); every other origin — and every PE whose
    // caller passes no observation (sovereign, institution rows, self-reports) — records
    // witnessed=false and adds zero, byte-identical to before.
    inputOrigins: normalizedInputOrigins,
    submissionWitness: null,
    ...(relayWitnessedOrigins ? { relayWitnessedOrigins } : {}),
    witnessObservedTokens: null,
    bodyDeclaredTokens: readComputeTokens(params.compute ?? null),
    // attested region / measurement ONLY from the lane-supplied SEALED witness under the
    // hardware_rooted class; witnessed payment ONLY from verified Base USDC evidence under the
    // chain_witnessed class (a metadata `hardware_witness` / self-reported amount is never read).
    compositionSignals: deriveCompositionSignals(params.metadata, params.execution_env ?? null, {
      witnessClass,
      sealedHardwareWitness: params.sealedHardwareWitness ?? null,
    }),
    outputDigests: normalizedOutputDigests,
    witnessClass,
    witnessedAtMs,
    // the speech window (burn id + verified amount), forwarded only when the caller holds
    // one, so every other caller's stored intake row is byte-identical to before.
    ...(params.speechWindow
      ? { speechWindow: { burnId: params.speechWindow.burnId, burnAmountAtomic: params.speechWindow.burnAmountAtomic } }
      : {}),
  });

  // Whom the PE is sealed to (its owner; an agent's linked human), resolved before the
  // transaction — sealing itself is synchronous and runs inside it, over the attempt's prev hash.
  const sealTargets = await resolveRelaySealTargets(deps.db, {
    actorId: params.agentId,
    walletId: params.walletId,
    ownerType: params.ownerType,
  });
  let stagedIntake: RelayActIntake | null = null;
  const intakeRef = privateRetentionCollection(deps.db, METER_RELAY_ACTS_COLLECTION).doc(peId);
  const actKeyRef = privateRetentionCollection(deps.db, METER_ACT_KEYS_COLLECTION).doc(peId);

  // Atomic chain tip advance. The relay's transient intake for this act (pricing inputs + the PE
  // sealed to its owner — never a readable PE) and the caller's entity write, when supplied, ride
  // the same transaction, so tip, entity and replay source commit together. The hash callback and
  // co-writes may re-run on contention; both rebuild from the attempt's prevHash.
  let prev_hash: string;
  let new_hash: string;
  let replayed: ExistingDeterministicPE | null = null;
  try {
    ({ prev_hash, new_hash } = await advanceChainTipAtomic(
      deps.db,
      params.agentId,
      peHashOf,
      undefined,
      (txn, { prevHash, newHash }) => {
        const pe = relayPeFor(prevHash);
        stagedIntake = buildRelayActIntake({
          pe,
          actorId: params.agentId,
          accrual: buildAccrualParams(newHash),
          sealed: sealRelayPe(pe, sealTargets),
          nowMs: Date.now(),
        });
        stageRelayActInTransaction(txn, deps.db, stagedIntake);
        // An identity-bearing act's record is identity state the relay keeps (item 7): written
        // with the tip so the identity record that names this pe id can always be validated.
        if (isIdentityActType(params.actionType)) {
          stageIdentityActInTransaction(txn, deps.db, buildIdentityAct({
            actorId: params.agentId,
            walletId: params.walletId,
            policyActionType: params.accrualActionType ?? params.actionType,
            act: stagedIntake.act,
            nowMs: Date.now(),
          }));
        }
        // A speech act made under a talking pass: record which pass and which entities it touched,
        // so revoking the pass's burn can find and revoke the speech without a stored PE.
        if (params.speechWindow) {
          stageSpeechWindowActInTransaction(txn, deps.db, buildSpeechWindowAct({
            peId,
            burnId: params.speechWindow.burnId,
            actionType: params.actionType,
            metadata: params.metadata,
            nowMs: Date.now(),
          }));
        }
        if (params.atomicEntityWrite) {
          // Fail closed if the entity co-write is async: an awaited write would
          // escape this transaction and reintroduce the exact orphan WS4 fixes.
          const entityResult: unknown = params.atomicEntityWrite(txn, peId, {
            prevHash,
            newHash,
            timestamp: now,
          });
          if (isThenable(entityResult)) {
            throw new Error(
              'atomicEntityWrite must be synchronous (write-only); a returned Promise breaks PE+entity atomicity',
            );
          }
        }
      },
      params.peIdOverride || params.atomicEntityPrecondition
        ? async (txn, context) => {
          await params.atomicEntityPrecondition?.(txn, context);
          if (!params.peIdOverride) return;
          // A deterministic id already recorded: its act key (31 days), its unpriced intake, or —
          // until the migration removes them — a pre-meter envelope.
          const [keySnap, intakeSnap, legacySnap] = [await txn.get(actKeyRef), await txn.get(intakeRef), await txn.get(peRef)];
          type Existing = { actor: unknown; ts: unknown; prev: unknown; hash: unknown; state: 'priced' | 'staged' | 'legacy' };
          const existing: Existing | null = keySnap.exists
            ? { actor: keySnap.data()?.actor_id, ts: keySnap.data()?.timestamp, prev: keySnap.data()?.prev_hash, hash: keySnap.data()?.pe_hash, state: 'priced' }
            : intakeSnap.exists
              ? { actor: intakeSnap.data()?.actor_id, ts: intakeSnap.data()?.act?.timestamp, prev: intakeSnap.data()?.act?.prev_hash, hash: intakeSnap.data()?.act?.pe_hash, state: 'staged' }
              : legacySnap.exists
                ? { actor: legacySnap.data()?.agent_id, ts: legacySnap.data()?.timestamp, prev: legacySnap.data()?.prev_hash, hash: legacySnap.data()?.hash, state: 'legacy' }
                : null;
          if (existing === null) return;
          const legacyHash = (prev: string): string => crypto.createHash('sha256')
            .update(stableStringify(buildContent(prev)) || '').digest('hex');
          if (existing.actor !== params.agentId
            || existing.ts !== now
            || typeof existing.prev !== 'string'
            || typeof existing.hash !== 'string'
            || (existing.state === 'legacy' ? legacyHash(existing.prev) : peHashOf(existing.prev)) !== existing.hash) {
            throw new Error('deterministic_pe_id_collision');
          }
          throw new ExistingDeterministicPE(
            existing.prev,
            existing.hash,
            existing.state,
            existing.state === 'staged' ? (intakeSnap.data() as RelayActIntake) : null,
          );
        }
        : undefined,
    ));
  } catch (error) {
    if (!(error instanceof ExistingDeterministicPE)) throw error;
    prev_hash = error.prevHash;
    new_hash = error.peHash;
    replayed = error;
  }

  const peHash = new_hash;
  // A replay of a deterministic id never advances the chain again. An act already priced is done;
  // one whose emitter died between the tip commit and pricing is priced now (pricing is idempotent
  // on the act key), which is how a crash after durability but before economic acknowledgement
  // heals. A pre-meter envelope re-runs its own accrual exactly as before the meter.
  let intake: RelayActIntake;
  if (replayed !== null) {
    if (replayed.state === 'priced') return { peId, peHash, prevHash: prev_hash };
    if (replayed.state === 'legacy') {
      await deps.recordPEAccrual(buildAccrualParams(peHash));
      return { peId, peHash, prevHash: prev_hash };
    }
    if (replayed.intake === null) throw new Error('relay_act_intake_unreadable');
    intake = replayed.intake;
  } else {
    if (stagedIntake === null) throw new Error('relay_act_intake_not_staged');
    intake = stagedIntake;
  }

  const handleAccrualFailure = (err: unknown) => {
    // A dropped pricing is recoverable: the intake row stays until the replay sweep prices it.
    console.error(`[PE] Relay act pricing failed for ${peId} (action=${params.actionType}):`, err);
    void deps.db
      .collection('pe_accrual_failures')
      .doc(peId)
      .set({
        pe_id: peId,
        user_id: params.agentId,
        action_type: params.accrualActionType ?? params.actionType,
        pe_hash: peHash,
        timestamp: now,
        error: err instanceof Error ? err.message : String(err),
        recorded_at: Date.now(),
        retried: false,
      })
      .catch((markerErr) =>
        console.error(`[PE] Failed to write accrual-failure marker for ${peId}:`, markerErr),
      );
  };
  // The intake carries the accrual inputs built above, so its depth is this emitter's own
  // 'hardware' | 'software'; narrowing it back restores the deps signature without a cast.
  const pricing = priceRelayAct(deps.db, intake, {
    record: (accrual) => deps.recordPEAccrual({
      ...accrual,
      attestationDepth: accrual.attestationDepth === 'hardware' ? 'hardware' : 'software',
    }),
  });
  if (params.awaitAccrual) {
    try {
      await pricing;
    } catch (err) {
      handleAccrualFailure(err);
      throw err;
    }
  } else {
    pricing.catch(handleAccrualFailure);
  }

  return { peId, peHash, prevHash: prev_hash };
}

/**
 * The sealed `economicCanonicalEventId` the identity a resolution must later
 * match (`monetary-accounting.ts:1146`) and the key any per-event exactly-once
 * rule is written against.
 *
 * ORDER IS LOAD-BEARING, and it was WRONG until. `tx_hash` ranked first
 * and `canonical_event_id` last, so an emitter supplying BOTH sealed the
 * transaction hash and discarded the exact identity it had just computed.
 * A transaction hash identifies a TRANSACTION; one transaction can carry
 * several canonical events — two promise fundings, two USDC transfers, a
 * batched multicall. It is therefore a strictly WEAKER identity, and inferring
 * it must never outrank an emitter that states the exact one.
 *
 * Probed, not reasoned: driving the real `generatePE` with both keys sealed the
 * tx hash, and two fundings in one transaction sealed ONE id for BOTH — so
 * log-granular exactly-once silently degraded to per-transaction. The permanent
 * controls for all three properties live in `pe-utils.test.ts`.
 *
 * An EXPLICIT `canonical_event_id` now wins. The tx-hash family is retained as
 * the fallback for the many emitters that legitimately have no finer identity
 * (both USDC watchers, the transfer-record route), so this reorders precedence
 * without changing what any of them seal.
 */
function firstEconomicEventId(metadata: Record<string, unknown>): string | null {
  for (const key of ['canonical_event_id', 'tx_hash', 'txHash', 'transaction_hash', 'settlementTxHash']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * DEPRECATED: Pre-Phase-H helper. Historically named `generateSchedulerPE`
 * because scheduler jobs "don't have access to the caller's chain tip".
 * They do now - `advanceChainTipAtomic` reads the tip from Firestore, which
 * is authoritative. This shim delegates to the atomic variant so any
 * lingering scheduler caller stays correct while we migrate.
 */
export async function generateSchedulerPE(
  deps: AgentBankDeps,
  params: GeneratePEParams,
): Promise<GeneratedPE> {
  return generatePE(deps, params);
}
