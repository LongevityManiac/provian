/**
 * closed-loop-detector — the structural test that stops ONE operator wearing MANY wallets from
 * faking independence by having them cite each other (, Prompt 3).
 *
 * THE RULE IS CLOSURE, NOT LOW DIVERSITY. A cluster of signers is closed when its members' citations
 * resolve ESSENTIALLY ONLY to identities inside the cluster — the ring cites inward and nothing else.
 * That is the farm signal. Crucially, only an origin whose OWNER is ANOTHER PROVIAN SIGNER can be
 * part of a ring: a citation to an external party (a calibration lab, arXiv, npm, a domain) is
 * OUTWARD to a party that never cites back, so a cluster that cites the outside world at all is NOT
 * closed and is never flagged. A sensor citing the same lab forever, and a never-before-cited public
 * origin, both count — exactly as required. Witnessed stuffing (a real observed loop over many real
 * PUBLIC origins) is the accepted residual; no detector for it.
 *
 * The traversal is BOUNDED (cluster + edge caps): a cluster too large to prove closed is NOT flagged
 * (conservative against FALSE-flagging a legitimate citation). A read error is `unresolvable` and
 * likewise flags nothing — the origin counts. So the detector can only ever ADD a `closed_loop`
 * reason to origins that resolve into a provably-closed ring; it never withholds base and never
 * over-flags on uncertainty.
 */

export interface ClosedLoopDeps {
  /** The owners a signer has cited historically (from the reference graph). */
  readonly readOutEdgeOwners: (signer: string) => Promise<readonly string[]>;
  /** Map an owner party to the Provian signer that IS it, or null when the owner is external. */
  readonly ownerToSigner: (owner: string) => Promise<string | null>;
}

export interface ClosedLoopResult {
  /** The subset of the input candidate owners that resolve into a provably-closed ring. */
  readonly closedLoopOwners: ReadonlySet<string>;
  /** The signer ids in the detected closed cluster (empty when not closed). */
  readonly clusterMembers: ReadonlySet<string>;
  /** True when a read failed — the caller flags nothing (origins count normally). */
  readonly unresolvable: boolean;
}

const DEFAULT_MAX_CLUSTER = 64;
const DEFAULT_MAX_EDGES = 4096;

const EMPTY: ClosedLoopResult = {
  closedLoopOwners: new Set(), clusterMembers: new Set(), unresolvable: false,
};

/**
 * Detect whether `signer` (with the pending edges to `candidateOwners`) sits in a closed ring, and
 * if so which of those candidate owners resolve into it. `candidateOwners` are the owners of the
 * CURRENT PE that already passed the witnessed/resolvable/independent tests — only those can be
 * demoted by a ring.
 */
export async function detectClosedLoopOwners(
  deps: ClosedLoopDeps,
  params: {
    signer: string;
    candidateOwners: readonly string[];
    /**
     * The candidate owners cited through `pe:` CONSUMPTION edges (§2.1). For these — and ONLY
     * these — closure requires a CYCLE back to the acting signer: a leaf/DAG citation (A builds on
     * B's PE; B cites nothing) is the ordinary shape of consumption, not a ring. Every OTHER owner
     * (an `evm:`/`domain:`/`repo:` party that prices the independence multiplier) keeps the
     * rule unchanged: a cluster that cites inward and nothing else IS closed (1 on
     * the Trust Layer build: relaxing that for priced owners let an acyclic internal chain earn 1.5×).
     */
    ringRequiredOwners?: ReadonlySet<string>;
    maxCluster?: number;
    maxEdges?: number;
  },
): Promise<ClosedLoopResult> {
  const maxCluster = params.maxCluster ?? DEFAULT_MAX_CLUSTER;
  const maxEdges = params.maxEdges ?? DEFAULT_MAX_EDGES;
  if (params.candidateOwners.length === 0) return EMPTY;

  try {
    // Map each candidate owner to a signer (or null = external). An owner that is not a signer can
    // never be in a ring, so a PE that cites ANY external candidate owner cannot be in a closed loop
    // (the cluster would cite outward) — short-circuit to "nothing flagged".
    const candidateSigners = new Map<string, string>(); // owner -> signer
    for (const owner of params.candidateOwners) {
      const s = await deps.ownerToSigner(owner);
      if (s === null) {
        // The current PE cites an external party -> its cluster cites outward -> not closed.
        return EMPTY;
      }
      candidateSigners.set(owner, s);
    }

    // BFS the citation graph from `signer` over inward (signer-owned) edges. Any member citing an
    // EXTERNAL owner, or exceeding the caps, means the component is not a provable closed ring.
    const cluster = new Set<string>([params.signer]);
    // The current PE's pending edges are part of the graph the moment it mints — seed them.
    for (const s of candidateSigners.values()) cluster.add(s);
    const queue: string[] = [...cluster];
    let edgesWalked = 0;
    // Trust Layer build (2026-09-16, one graph): for `pe:` consumption edges (`ringRequiredOwners`)
    // closure additionally needs a CYCLE back to the acting signer — see the param doc. Priced
    // owners keep the pure closure rule.
    let cycleBackToSigner = false;
    const ringRequired = params.ringRequiredOwners ?? new Set<string>();

    while (queue.length > 0) {
      if (cluster.size > maxCluster || edgesWalked > maxEdges) {
        // Too large to prove closed — do not flag (conservative against false-flagging).
        return EMPTY;
      }
      const node = queue.shift()!;
      const owners = node === params.signer
        // For the acting signer, its pending citations are the candidate owners (the historical
        // graph does not yet carry this PE's edge). Historical out-edges are unioned in too.
        ? [...params.candidateOwners, ...(await deps.readOutEdgeOwners(node))]
        : await deps.readOutEdgeOwners(node);
      for (const owner of owners) {
        edgesWalked += 1;
        if (edgesWalked > maxEdges) return EMPTY;
        const ownerSigner = candidateSigners.get(owner) ?? await deps.ownerToSigner(owner);
        if (ownerSigner === null) {
          // A member cites an external party — the cluster cites outward — NOT closed.
          return EMPTY;
        }
        if (node !== params.signer && ownerSigner === params.signer) cycleBackToSigner = true;
        if (!cluster.has(ownerSigner)) {
          cluster.add(ownerSigner);
          queue.push(ownerSigner);
        }
      }
    }

    // A closed ring needs at least two distinct mutually-citing signers (a lone self-citation is
    // caught by the same-party fence, not here).
    if (cluster.size < 2) return EMPTY;

    // Closed: every cited owner across the cluster resolves to a cluster member (we returned early
    // otherwise). Flag the current PE's candidate owners that resolve into the cluster — a `pe:`
    // consumption owner only when the walk also proved a cycle back to the signer.
    const closedLoopOwners = new Set<string>();
    for (const [owner, s] of candidateSigners) {
      if (!cluster.has(s)) continue;
      if (ringRequired.has(owner) && !cycleBackToSigner) continue;
      closedLoopOwners.add(owner);
    }
    if (closedLoopOwners.size === 0) return EMPTY;
    return { closedLoopOwners, clusterMembers: cluster, unresolvable: false };
  } catch {
    return { closedLoopOwners: new Set(), clusterMembers: new Set(), unresolvable: true };
  }
}
