import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireConfiguredPvt9Runtime } from './pvt9-base-config.generated';

export const PVT9_UNCONFIGURED = 'PVT9_UNCONFIGURED' as const;

type RuntimeDecision = Readonly<{
  blocked: boolean;
  dependency: string | null;
}>;

/**
 * EXACT-PATH safe reads. Consulted with `.has(path)`, so every entry must be a
 * literal path with no parameter segment — see SAFE_PVT_RECORD_READ_PATTERNS
 * for the ones that carry a parameter.
 *
 * The five additions beyond the original three (estimate, milestones, weights,
 * attestation-tiers, weights/overrides) are the PVT9-era public read surface.
 * Admitting a path HERE does not make it live: each route carries its own
 * `publicDiscoveryGate()` and 404s until `PUBLIC_LAUNCH === 'true'`. This
 * boundary decides only that the request may reach a route at all.
 *
 * `stats`, `tokenomics` and `mint-history` are deliberately ABSENT and stay
 * blocked: the first two call contract functions the deployed PVT9 kernel does
 * not have (`mintRate`, `circulatingSupply`, `tokenomicSnapshot`, …), and the
 * third reads `pvt_mint_batches` — the legacy PVTv8 collection, which the PVT9
 * settlement runtime never writes.
 */
const SAFE_PVT_RECORD_READS = new Set([
  '/v1/pvt/accrual',
  '/v1/pvt/history',
  '/v1/pvt/network-stats',
  '/v1/pvt/estimate',
  '/v1/pvt/milestones',
  '/v1/pvt/weights',
  '/v1/pvt/weights/overrides',
  '/v1/pvt/attestation-tiers',
]);

/**
 * PARAMETERIZED safe reads. A Set consulted with `.has()` can never match
 * `/v1/pvt/balance/0xabc…`, so these two need their own arm. Each pattern is
 * anchored at both ends and admits exactly ONE segment after the prefix — a
 * deeper path (`/v1/pvt/balance/0xabc/mint`) does not match and stays blocked.
 */
const SAFE_PVT_RECORD_READ_PATTERNS: readonly RegExp[] = [
  /^\/v1\/pvt\/balance\/[^/]+$/,
  /^\/v1\/pvt\/allocation\/[^/]+$/,
];

/**
 * C-1: the two ANCHOR-INDEPENDENT trust-layer reads are admitted; the one that
 * needs an on-chain anchor is not.
 *
 * `GET /v1/pe/:pe_id/proof` and `GET /v1/pe/export/:wallet_id` read Firestore
 * records only — the PE's own hash, its chain link, and its anchoring state.
 * They are answerable, and truthfully, while the anchor runtime is quarantined.
 * Admitting them here does not open them: each carries its own
 * `publicDiscoveryGate()` (or agent auth) and 404s until `PUBLIC_LAUNCH === 'true'`.
 *
 * `POST /v1/pe/verify` was BLOCKED here as a second, independent refusal on
 * top of the router's own 503 while no anchor runtime existed. B10 (,
 * the design requires ARM) OPENED BOTH LAYERS DELIBERATELY in one change — exactly
 * the condition the old comment set ("both layers must be opened deliberately
 * if an anchor runtime is ever restored"): the daily anchoring schedulers are
 * live again on the deployed PEAnchor and the verify router carries a
 * read-only contract, so the proof check now has a written chain to be right
 * about. The list is retained EMPTY (not deleted) so a future re-quarantine is
 * a one-line addition with this history beside it.
 */
const LEGACY_PE_PROOF_PATHS: readonly RegExp[] = [];

// Audit 2026-08-05 (findings 6 + 7): the eight institution LIFECYCLE schedulers and the two
// eligibility RECOVERY schedulers are OPENED — they are the service side of the institution
// WRITES opened. Each still runs behind `authenticateScheduler` (SCHEDULER_SECRET), and
// none MINTS: the lifecycle handlers settle already-open institution writes (escrow/bond/court),
// and the two recovery handlers only RE-CLASSIFY already-recorded PEs — deferred-release moves
// mint_status deferred→eligible (it "Does NOT mint PVT"), pending-cache-backfill recovers
// pending_cache rows after a Redis blip. The PVT9 settlement runtime — the sole minter — is a
// different, separately-gated path and is untouched here.
//
// What STAYS blocked is only the genuinely retired legacy settlement no-op stubs: pvt-mint and
// advance-epoch (legacy PVTv8 minting). daily-pe-anchor and pe-anchor-backfill were REMOVED from
// this set by B10 (, the design requires ARM): the anchor runtime is restored on the deployed
// PEAnchor per those two paths are now live scheduler handlers behind scheduler auth,
// and blocking them here would silently re-freeze anchoring (the looks-live class).
const LEGACY_SCHEDULER_PATHS = new Set([
  '/v1/internal/scheduler/pvt-mint',
  '/v1/internal/scheduler/advance-epoch',
]);

function blocked(dependency: string): RuntimeDecision {
  return { blocked: true, dependency };
}

const PASS: RuntimeDecision = { blocked: false, dependency: null };

function isPathInNamespace(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The Commons institution namespaces this boundary refuses — the SINGLE source
 * of truth for "which institutions are closed to the human surface".
 *
 * It is exported because the Commons discovery catalog (`core/commons/feed.ts`)
 * must report exactly this set and nothing else. Those two drifted apart once
 * already: opened `/v1/commons/jobs` here, the catalog kept reporting
 * Jobs as unavailable, and the app told every user that a working pay/hire
 * surface was closed. `core/commons/feed.wp2.test.ts` now binds the catalog to
 * this constant so the same drift fails a test instead of shipping.
 */
// Escrow (`bank`) and Bonds (`bonds`) open — their Commons namespaces are
// the read-only public stats the Work tab's Escrow and Bonds tiles show (`GET /bank/stats`,
// `GET /bonds/stats`; no write route exists under either). Court stays closed (not activated,).
export const BLOCKED_COMMONS_INSTITUTIONS = ['court', 'governance'] as const;

/**
 * Path classifier for the runtime boundary runtime boundary.
 *
 * OPENED the institution runtimes — Court, Bonds, Jobs, escrow/promises/pools WRITES, and
 * the admin PVT policy/genesis surfaces — so an operator can invite an agent from the app and the
 * agent can transact through the relay ("live, not shown"). What stays refused is what is
 * structurally absent, legacy, or a dormant authority path:
 * - every PVT path except the enumerated safe GET/HEAD record reads (the legacy
 * `routes/pvt.ts` router is deleted; the PVT9-shaped endpoints are unbuilt — see the
 * ten-endpoint ruling),
 * - the legacy PE-anchor verify (no anchor runtime is configured),
 * - the dormant economic governance lane,
 * - `/v1/admin/pvt/weights` the governance boundary-dormant governance weight applier (opening it would be a
 * governance authority path); `/v1/admin/pvt/policy` and `/v1/admin/pvt/genesis` DO open,
 * - the legacy settlement schedulers, and
 * - the Commons economic aliases, which stay dark as defense in depth behind the pre-launch
 * surface gate that closes all of `/v1/commons` (§A5). (The forum→Court escalation route was
 * RETIRED by challenges resolve by burn-to-present — so no rule names it any more.)
 *
 * The institution WRITE surfaces this now admits are agent- or admin-authenticated and only
 * record intent / verify a caller-broadcast `tx_hash`; the router deps carry no signer, so
 * admitting a path here activates no on-chain value movement.
 */
export function classifyPvt9RuntimeRequest(method: string, pathname: string): RuntimeDecision {
  const normalizedMethod = method.toUpperCase();
  const path = (pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname).toLowerCase();

  if (isPathInNamespace(path, '/v1/pvt')) {
    const safeRead = SAFE_PVT_RECORD_READS.has(path)
      || SAFE_PVT_RECORD_READ_PATTERNS.some((pattern) => pattern.test(path));
    if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && safeRead) {
      return PASS;
    }
    return blocked('pvt_runtime');
  }

  if (LEGACY_PE_PROOF_PATHS.some((pattern) => pattern.test(path))) return blocked('legacy_pe_anchor');
  if (path === '/v1/governance' || path.startsWith('/v1/governance/')) return blocked('legacy_economic_governance');
  // opened `/v1/admin/pvt/policy` (classification, flag-gated) and `/v1/admin/pvt/genesis`
  // (admin read/audit + one-way kill). `/v1/admin/pvt/weights` STAYS blocked: it carries the
  // `POST /governance/review/:proposal_id` weight applier (`applyWeightChangeToRelay`), a
  // governance authority path governance boundary keeps dormant. Opening it would cross the authority boundary,
  // and nothing in the invite → signup flow needs it.
  if (isPathInNamespace(path, '/v1/admin/pvt/weights')) return blocked('legacy_pvt_admin');
  if (LEGACY_SCHEDULER_PATHS.has(path)) return blocked('legacy_settlement_scheduler');

  // §A5 / Commons economic aliases were the human-web (public-view) reflections of the
  // now-open agent-rail institutions, refused here as defense-in-depth behind the pre-launch
  // surface gate.  OPENS `/v1/commons/jobs` the human-jobs
  // pay/hire path (post → accept → fund → complete) the phone app drives — because it is the
  // SAME no-signer class already open at the direct `/v1/jobs` API: the router deps carry no
  // signer, the funding routes only VERIFY a caller-broadcast `tx_hash` (verifyFunding's on-chain
  // expectedFrom/recipient binding), and settlement is the human's own non-custodial on-chain tx.
  // OPENS `/v1/commons/market` the Market is now the read face of
  // the SAME Commons hiring board (`/market/jobs` + `/market/stats` read `commons_human_jobs`;
  // no signer, no write). The other economic institutions STAY blocked (no bond/court/bank
  // levers), and the surface gate still keeps `/v1/commons` dark to ANONYMOUS callers.
  for (const institution of BLOCKED_COMMONS_INSTITUTIONS) {
    if (isPathInNamespace(path, `/v1/commons/${institution}`)) return blocked(institution);
  }

  return PASS;
}

export function createPvt9RuntimeBoundary(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const decision = classifyPvt9RuntimeRequest(req.method, req.path);
    if (!decision.blocked) return next();

    try {
      // The canonical state is `status: "configured"` against the live Base kernel, so this no
      // longer throws PVT9_UNCONFIGURED on the normal path — the refusal below is the
      // PVT9_DEPENDENCY_UNAVAILABLE branch. The try/catch is retained defensively: were the
      // config ever reverted to unconfigured, a blocked path must still fail closed with
      // PVT9_UNCONFIGURED. Either way this seam supplies no authority or signer.
      requireConfiguredPvt9Runtime();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === PVT9_UNCONFIGURED) {
        res.status(503).json({
          error: PVT9_UNCONFIGURED,
          code: PVT9_UNCONFIGURED,
          dependency: decision.dependency,
          message: 'PVT9 is not deployed or configured; minting, settlement, and this dependent operation are unavailable.',
        });
        return;
      }
      next(error);
      return;
    }

    // Configuring PVT9 alone cannot silently activate a legacy/dependent path.
    res.status(503).json({
      error: 'PVT9_DEPENDENCY_UNAVAILABLE',
      code: 'PVT9_DEPENDENCY_UNAVAILABLE',
      dependency: decision.dependency,
      message: 'This dependent operation requires a separately implemented and approved runtime.',
    });
  };
}
