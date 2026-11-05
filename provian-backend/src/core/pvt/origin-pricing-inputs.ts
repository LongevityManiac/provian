/**
 * origin-pricing-inputs — the mint-time orchestrator that turns a PE's `input_origins` into the
 * pricing input `independent_origin_count` (, Prompt 3), and — since
 * the Trust Layer build (§2.1–§2.4) — into the ONE reference graph's edges,
 * including `pe:` consumption edges.
 *
 * It ties the money-layer pieces together at accrual time and is the ONLY place the accrual calls:
 * 1. `resolveSignerIdentitySet` who the signer IS (fail-closed; a read failure counts ZERO).
 * 2. `resolveOriginOwner` the public-authority owner of each origin (pure table), PLUS the two
 * async resolvers: `pe:` → the cited PE's signer (`pe-origin-resolver.ts`) and `pkg:` → the
 * registry publisher (`pkg-owner-resolver.ts`).
 * 3. relay-authoritative WITNESSING — an origin is witnessed iff a non-actor witness vouched THIS
 * submission (`submissionWitness`, taken from device registration / a verified relay
 * observation, NEVER the body) AND the body marked that origin witnessed. A SIGNED citation
 * (`out:<kind>:<id>`,) is witnessed by exactly that same rule: the producer's
 * signature establishes only WHO MADE the output (its owner, `output-citation.ts`), never that
 * the citing act was witnessed — so a declared citation of a public signed output counts zero.
 * 4. `detectClosedLoopOwners` demote owners that sit in a provably-closed citation ring. The
 * candidate set includes `pe:` owners, so a `pe:` ring is flagged on the same walk.
 * 5. `recordOriginEdges` persist every edge (best-effort; a graph-write failure never fails the
 * mint, because the provenance itself is already immutable on `provenance_envelopes`).
 *
 * MONEY-SAFETY: this module only ever computes the independent origin count; it changes NO price by itself.
 * A `pe:` origin is NEVER counted (§2.2: `reason:'consumption_edge'`, or `closed_loop` inside a ring,
 * or `same_party` for a self/principal cite) — so a PE with only `pe:` origins prices byte-identically
 * to one with none. Every failure path is fail-closed: an unresolvable identity set, an unwitnessed
 * origin, an unresolved owner, a same-party owner, or a closed-loop owner each add ZERO to the count.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import type { InputOrigin } from '../provenance/input-origins';
import type { BeneficiaryCacheEntry } from './beneficiary';
import {
  decideOrigin,
  computeOriginIndependence,
  type OriginResolution,
  type SealedOriginRef,
  type SealedWitness,
} from './origin-independence';
import { resolveOriginOwner } from './origin-owner-resolver';
import { resolveSignerIdentitySet } from './signer-identity-set';
import { detectClosedLoopOwners } from './closed-loop-detector';
import { makeOwnerToSigner } from './origin-owner-to-signer';
import {
  buildOriginEdges,
  recordOriginEdges,
  readSignerCitedOwners,
  type CitedPeDetail,
  type OriginEdge,
} from './origin-reference-graph';
import {
  isPeOriginIdentifier,
  resolvePeOrigins,
  signerOwner,
  type ResolvedPeOrigin,
} from './pe-origin-resolver';
import {
  isOutputCitationIdentifier,
  outputCitationKey,
  outputCitationVerdictKey,
  resolveOutputCitations,
  type ResolvedOutputCitation,
} from './output-citation';
import { resolvePkgOwners } from './pkg-owner-resolver';
import { originKey, type RelayWitnessedOrigins } from './relay-observation-witness';

export interface OriginPricingParams {
  /** The graph node id = the signer's economic actor id (agent_id / user_id). ownerToSigner emits
   * this same namespace, so the detector's edges line up by construction. */
  readonly economicActorId: string;
  /** The signer's own native address, when known (folds into its identity set). */
  readonly walletAddress: string | null;
  /** The id of the PE being sealed — the graph edge key and the mint-once anchor. */
  readonly peId: string;
  readonly nowMs: number;
  /** The PE's `input_origins` (from `provenance_envelopes`, hashed into the preimage). */
  readonly inputOrigins: readonly InputOrigin[];
  /**
   * §2.1 — the RETIRED citation vocabulary, still accepted at ingress for installed clients. Each
   * id not already declared as a `pe:` origin is folded into the graph as an UNWITNESSED `pe:` edge
   * (recorded, counts zero, adds zero) so the one graph is complete going forward without a second
   * vocabulary. Absent/null → nothing folded.
   */
  readonly citedPeIds?: readonly string[] | null;
  /** The relay-authoritative non-actor witness for THIS submission, or null when none vouched. Taken
   * from device registration / a verified relay observation — NEVER from the envelope body. */
  readonly submissionWitness: SealedWitness | null;
  /**
   * Fact-base fixes item 4 (2026-09-23): the relay's OWN verified observation (forge webhook / chain
   * watcher) as the witness for EXACTLY the origins the relay derived from that event (keyed
   * `origin_identifier|hash`). Absent/null on every other lane — byte-identical to before.
   */
  readonly relayWitnessedOrigins?: RelayWitnessedOrigins | null;
  /** Tokens a witness observed for the act (body-bound observation), or null. */
  readonly witnessObservedTokens: number | null;
  /** The actor-declared `compute.tokens_processed` (recorded, adds zero to the multiplier). */
  readonly bodyDeclaredTokens: number | null;
  /**
   * PE METER: the act's batch. Its edges are NOT written here — they are returned
   * (`stagedEdges`) and written, with their per-pair counts, by the batch commit that creates the
   * act's key (exactly once). The edges earlier acts of the same batch staged are visible to this
   * act's closed-loop walk exactly as if they had been written already (the pre-meter order).
   */
  readonly batchEdges?: BatchOriginEdges | null;
}

/** The edges a batch's acts have staged so far (unwritten until the batch commits). */
export interface BatchOriginEdges {
  readonly staged: OriginEdge[];
}

export function newBatchOriginEdges(): BatchOriginEdges {
  return { staged: [] };
}

/** The owners a signer cited in edges staged earlier in this batch (unresolved excluded). */
function stagedOwnersOf(batch: BatchOriginEdges | null | undefined, signer: string): string[] {
  if (!batch) return [];
  const owners: string[] = [];
  for (const e of batch.staged) {
    if (e.signer === signer && typeof e.owner === 'string' && e.owner.length > 0) owners.push(e.owner);
  }
  return owners;
}

export interface OriginPricingInputs {
  /** Distinct witnessed, independent, non-loop owners — the independence multiplier's input. */
  readonly independentOriginCount: number;
  /** The per-origin decision detail, sealed onto the economic snapshot (informational). */
  readonly origins: readonly SealedOriginRef[];
  /** True when the signer's identity set could not be resolved (every origin fail-closed to 0). */
  readonly identitySetUnresolvable: boolean;
  /** True when the closed-loop graph read failed (nothing demoted; origins count normally). */
  readonly closedLoopUnresolvable: boolean;
  /** Count of edges written to the reference graph (0 on a best-effort write failure). */
  readonly edgesRecorded: number;
  /** §2.1: the `pe:` edges this PE carries (declared), by cited PE id. */
  readonly consumptionEdges: readonly { citedPeId: string; citedSigner: string; citedActionType: string | null; reason: string | null }[];
  /** PE METER: the edges for the batch commit to write (absent/null when written here, or none). */
  readonly stagedEdges?: readonly OriginEdge[] | null;
}

/**
 * Extract the actor-declared token count from a submission's `compute` telemetry (`{ tokens_processed
 * }`), or null when absent/unusable. This is the BODY figure — recorded as `actorDeclared`, never the
 * observed volume (only a witness's count is observed). A non-integer/negative/non-finite value is
 * treated as absent (Unknown = Block). Shared by every submit path that threads the money layer.
 */
export function readComputeTokens(compute: unknown): number | null {
  if (typeof compute !== 'object' || compute === null) return null;
  const raw = (compute as { tokens_processed?: unknown }).tokens_processed;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

/** Witnessed token telemetry for economic facts; it has no pricing authority. */
export function deviceWitnessObservedTokens(input: { readonly bodyBound: boolean; readonly compute: unknown }): number | null {
  return input.bodyBound ? readComputeTokens(input.compute) : null;
}

/**
 * Resolve the independence pricing input for one PE. Async (registry + graph reads), but every sub-call is
 * fail-closed, so this never throws into the accrual seal. Deterministic given the same registry state.
 */
export async function resolveOriginPricingInputs(
  db: Firestore,
  cache: RedisCache,
  params: OriginPricingParams,
  /** Injected for tests; production uses the real chain-validating resolver. */
  resolveBeneficiaryFn?: (
    userId: string, cache: RedisCache, db: Firestore,
  ) => Promise<BeneficiaryCacheEntry>,
): Promise<OriginPricingInputs> {
  const declaredBody = Array.isArray(params.inputOrigins) ? params.inputOrigins : [];
  const declaredBodyIds = new Set(declaredBody.map((o) => o.origin_identifier));
  const folded: InputOrigin[] = [];
  for (const id of Array.isArray(params.citedPeIds) ? params.citedPeIds : []) {
    if (typeof id !== 'string' || !/^pe_[A-Za-z0-9_-]{1,240}$/.test(id)) continue;
    const originId = `pe:${id}`;
    if (declaredBodyIds.has(originId) || folded.some((o) => o.origin_identifier === originId)) continue;
    // hash placeholder = the identifier until the resolver supplies the cited PE's sealed hash (below).
    folded.push({ hash: originId, origin_identifier: originId, witnessed: false });
  }
  const declared: readonly InputOrigin[] = [...declaredBody, ...folded];
  if (declared.length === 0) {
    return {
      independentOriginCount: 0,
      origins: [],
      identitySetUnresolvable: false,
      closedLoopUnresolvable: false,
      edgesRecorded: 0,
      consumptionEdges: [],
    };
  }

  // 0. : the relay derives no citation from a content hash any more (the per-output
  //    digest index grew with history and is retired). A consumer cites what it received SIGNED.
  const origins: readonly InputOrigin[] = declared;

  // 1. The signer's identity set (fail-closed: a read failure makes every origin owner_set_unresolvable).
  const identitySet = await resolveSignerIdentitySet(
    db, cache,
    { economicActorId: params.economicActorId, walletAddress: params.walletAddress },
    resolveBeneficiaryFn,
  );

  // 1b. §2.1 — resolve `pe:` origins to the cited PE's signer (relay-authoritative, per-doc reads).
  //     A read failure resolves every `pe:` to unresolvable (recorded, counts zero, never guessed).
  let peResolved: Map<string, ResolvedPeOrigin | null> = new Map();
  try {
    peResolved = await resolvePeOrigins(db, origins);
  } catch {
    peResolved = new Map();
  }
  // A folded legacy citation carries the cited PE's sealed hash as its `hash` once resolved.
  for (const o of folded) {
    const r = peResolved.get(o.origin_identifier);
    if (r && r.citedPeHash) (o as { hash: string }).hash = r.citedPeHash;
  }
  // 1c. §2.11 — resolve `pkg:` origins to their registry publisher (best-effort, cached, fail-closed).
  let pkgResolved = new Map<string, string | null>();
  try {
    pkgResolved = await resolvePkgOwners(cache, origins);
  } catch {
    pkgResolved = new Map();
  }
  // 1d. — SIGNED citations (`out:<kind>:<id>`): verify the producer's signature
  //     against its REGISTERED key (wallet / device / app) and map the signer to its actor through the
  //     per-identity registries only. This names the OWNER only. A failure resolves to no owner
  //     (recorded, counts zero, never guessed).
  let outResolved: Map<string, ResolvedOutputCitation> = new Map();
  try {
    outResolved = await resolveOutputCitations(db, origins);
  } catch {
    outResolved = new Map();
  }

  // 2. Per-origin resolution (owner, witnessed, same-party, private) — WITHOUT the loop verdict yet.
  const relay = params.relayWitnessedOrigins ?? null;
  const relayKeys = new Set(relay ? relay.originKeys : []);
  const citedPeDetail = new Map<string, CitedPeDetail>();
  const resolutions: OriginResolution[] = origins.map((origin) => {
    const id = origin.origin_identifier;
    const isPe = isPeOriginIdentifier(id);
    const pe = isPe ? (peResolved.get(id) ?? null) : null;
    // A signed citation: OWNED by the producer actor its verified signature names (unsigned / bad
    // signature / unknown signer → no owner). WITNESSED only by the citing act's own witness, below.
    const isOut = isOutputCitationIdentifier(id);
    const out = isOut ? (outResolved.get(outputCitationVerdictKey(origin)) ?? null) : null;
    const table = resolveOriginOwner(id);
    const owner = isPe
      ? (pe ? signerOwner(pe.citedSigner) : null)
      : isOut
        ? (out !== null && out.producerActorId !== null ? signerOwner(out.producerActorId) : null)
        : (table.owner ?? pkgResolved.get(id) ?? null);
    if (pe) citedPeDetail.set(id, { citedPeId: pe.citedPeId, citedSigner: pe.citedSigner, citedActionType: pe.citedActionType });
    // Fact-base fixes item 4: an origin the relay DERIVED from its own verified observation (never a
    // `pe:` edge) is witnessed by that observation — independent of any body flag.
    const relayDerived = relay !== null && !isPe && !isOut && relayKeys.has(originKey(origin));
    // (1): the producer's signature never witnesses the citing act — a signed
    // citation is witnessed by the same rule as every other body origin.
    const witnessed = relayDerived || (params.submissionWitness !== null && origin.witnessed === true);
    const sameParty = owner !== null && identitySet.identities.has(owner);
    return {
      witnessed,
      witness: relayDerived ? relay!.witness : params.submissionWitness,
      owner,
      privateHashed: table.privateHashed,
      identitySetUnresolvable: identitySet.unresolvable,
      sameParty,
      closedLoop: false,
      // §2.2 carried: a citation (declared `pe:` or signed `out:`) is a consumption edge — recorded,
      // indexed per pair, and adds ZERO to the citer's independence multiplier.
      consumptionEdge: isPe || isOut,
    };
  });

  // 3. First-pass decision — the counted owners are the demotable candidates; `pe:` owners that
  //    passed the fence (witnessed, resolved, not same-party) join the ring walk too (§2.1: one graph).
  const firstPass = origins.map((origin, i) => decideOrigin(origin, resolutions[i]));
  const candidateOwners = [...new Set(
    firstPass
      .filter((o) => o.owner !== null && (o.counted || o.reason === 'consumption_edge'))
      .map((o) => o.owner as string),
  )];
  // The `pe:` consumption owners need a proven CYCLE to be flagged; priced owners keep closure.
  const ringRequiredOwners = new Set(
    firstPass
      .filter((o) => o.owner !== null && o.reason === 'consumption_edge')
      .map((o) => o.owner as string),
  );

  // 4. Closed-loop detection over the candidate owners (fail-closed: a read failure flags nothing).
  const detector = await detectClosedLoopOwners(
    {
      ownerToSigner: makeOwnerToSigner(db),
      readOutEdgeOwners: async (signer) => {
        const persisted = [...(await readSignerCitedOwners(db, signer)).owners.keys()];
        const staged = stagedOwnersOf(params.batchEdges, signer);
        return staged.length === 0 ? persisted : [...new Set([...persisted, ...staged])];
      },
    },
    { signer: params.economicActorId, candidateOwners, ringRequiredOwners },
  );

  // 5. Final decision — re-decide only the origins whose owner the detector flagged.
  const decided = origins.map((origin, i) => {
    const res = resolutions[i];
    if (res.owner !== null && detector.closedLoopOwners.has(res.owner)) {
      return decideOrigin(origin, { ...res, closedLoop: true });
    }
    return firstPass[i];
  });

  const { independentOriginCount, origins: sealed } = computeOriginIndependence(decided);

  // 6. Persist every edge (best-effort — a graph failure must never fail the mint). On the meter
  //    path the batch commit writes them (with their pair counts) when it creates the act's key.
  //    One PE citing the SAME output twice is one citation (one edge), not two: of the entries naming
  //    one output, the first whose producer resolved is kept (else the first), so a bad duplicate
  //    can neither add an edge nor displace the valid one.
  const keptCitation = new Map<string, number>();
  sealed.forEach((o, i) => {
    if (!isOutputCitationIdentifier(o.origin_identifier)) return;
    const key = outputCitationKey(o);
    const prev = keptCitation.get(key);
    if (prev === undefined || (sealed[prev].owner === null && o.owner !== null)) keptCitation.set(key, i);
  });
  const edgeOrigins = sealed.filter((o, i) =>
    !isOutputCitationIdentifier(o.origin_identifier) || keptCitation.get(outputCitationKey(o)) === i);
  let edgesRecorded = 0;
  let stagedEdges: OriginEdge[] | null = null;
  if (params.batchEdges) {
    stagedEdges = buildOriginEdges({
      signer: params.economicActorId, peId: params.peId, origins: edgeOrigins, nowMs: params.nowMs, citedPeDetail,
    });
    params.batchEdges.staged.push(...stagedEdges);
    edgesRecorded = stagedEdges.length;
  } else {
    try {
      edgesRecorded = await recordOriginEdges(db, {
        signer: params.economicActorId, peId: params.peId, origins: edgeOrigins, nowMs: params.nowMs,
        citedPeDetail,
      });
    } catch {
      edgesRecorded = 0;
    }
  }

  const consumptionEdges = sealed
    .filter((o) => citedPeDetail.has(o.origin_identifier))
    .map((o) => {
      const d = citedPeDetail.get(o.origin_identifier)!;
      return { citedPeId: d.citedPeId, citedSigner: d.citedSigner, citedActionType: d.citedActionType ?? null, reason: o.reason };
    });

  return {
    independentOriginCount,
    origins: sealed,
    identitySetUnresolvable: identitySet.unresolvable,
    closedLoopUnresolvable: detector.unresolvable,
    edgesRecorded,
    consumptionEdges,
    stagedEdges,
  };
}
