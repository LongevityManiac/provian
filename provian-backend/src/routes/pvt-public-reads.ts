/**
 * The PVT public read surface, PVT9-era. ONE mount, seven endpoints.
 *
 * TWO GATES, by consumer (, the invariant: ). The phone app is
 * gated by NOT BEING PUBLISHED, not by `PUBLIC_LAUNCH`, so the four reads the
 * app actually consumes must serve a wallet-authed caller BEFORE the flip. They
 * carry `appClientDiscoveryGate()` open on launch OR when a Bearer credential
 * is present (the app always has one; an anonymous public-web visitor never
 * does, so the non-disclosure posture is unchanged). The rest stay flip-only:
 *
 * APP-CONSUMED (appClientDiscoveryGate — authed app pre-flip, else launch):
 * GET /v1/pvt/milestones — Abundance dashboard
 * GET /v1/pvt/weights — RelayAPIService.getWeights
 * GET /v1/pvt/balance/:wallet_address — PVT9 kernel balanceOf (see-balance)
 * GET /v1/pvt/allocation/:wallet_id — dual auth after the gate, 403 unless self
 *
 * PUBLIC-ONLY (publicDiscoveryGate — 404 until `PUBLIC_LAUNCH === 'true'`):
 * GET /v1/pvt/estimate (from routes/pvt-estimate.ts) — not app-consumed
 * GET /v1/pvt/weights/overrides
 * GET /v1/pvt/attestation-tiers
 *
 * WHAT STAYS DARK, and why it is not an oversight. `stats` and `tokenomics` are
 * NOT re-mounted. `stats` builds its multicall from PVT_STATS_REQUIRED_FN_NAMES
 * with `allowFailure: false`, and NINE of those eleven names are absent from the
 * deployed PVT9 ABI: `mintRate`, `epochDuration`, `totalBurned`,
 * `totalEverMinted`, `circulatingSupply`, `circuitBreakerTripped`,
 * `currentEpochMinted`, `effectiveMintRate`, `stakeRatioBps` (`totalSupply` and
 * `currentEpoch` are present). ALL SIX of PVT_STATS_OPTIONAL_FN_NAMES are absent
 * too, and `allowFailure` does not save them — it covers a call that REVERTS,
 * not a name missing from the local ABI, which throws at encode time. So 15 of
 * the 17 stats names throw while BUILDING the call array, before any RPC.
 * `tokenomics` needs `tokenomicSnapshot`, a twelfth name, also absent. Pointed
 * at the legacy address instead, they would publish retired PVTv8 economics as
 * if current. `mint-history` is dark for the same
 * class of reason: it reads `pvt_mint_batches`, which `wp11/cutover-inventory.ts`
 * declares LEGACY_MINT_BATCHES_COLLECTION and which the PVT9 settlement runtime
 * never writes — it writes `pvt9_settlement_batches_v1`. A PVT9-shaped successor
 * to any of the three is a new endpoint, not a re-mount.
 *
 * WHY NO `requireFeature('pvt')`. Its 503 body returns
 * `process.env.PVT_CONTRACT_ADDRESS` the retired PVTv8 address — and it keys
 * off `ENABLE_PVT`, which describes that same retired deployment. Adding it
 * would both publish a retired address and mean the flip does not actually open
 * these endpoints. `PUBLIC_LAUNCH` is the one lever, applied uniformly, so the
 * asymmetry that left the legacy `/weights/overrides` ungated cannot recur here.
 *
 * THE GATE GRANTS NOTHING. It only refuses. Reaching a route still requires
 * passing `createPvt9RuntimeBoundary()`, which is mounted ahead of every route
 * in server.ts and admits only its enumerated safe reads.
 */

import {
  Router,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { ethers } from 'ethers';
import type { RedisCache } from '../cache';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { publicDiscoveryGate, appClientDiscoveryGate } from './middleware/public-launch-gate';
import { createPVTDualAuthMiddleware } from './middleware/pvt-dual-auth';
import { createPVTEstimateRouter } from './pvt-estimate';
import { buildAllocationPayload } from './pvt-allocation-payload';
import { buildAttestationTierReference } from './pvt-attestation-tiers';
import { checkAllMilestones } from '../core/pvt/milestones';
import {
  buildWeightConfigResponse,
  loadWeightConfig,
  getEffectiveAttestationMultipliers,
} from '../core/pvt/pe-weight-framework';
// M5: aggregate-backed read (see economic-aggregate-read.ts).
import { readAggregateMintStatusCounts, readEconomicAccrualProjection } from '../core/pvt/policy/economic-aggregate-read';
import { requireConfiguredPvt9Runtime } from '../core/pvt/pvt9-base-config.generated';

/** The one mount path. Exported so the mount and its tests cannot disagree. */
export const PVT_PUBLIC_READ_MOUNT_PATH = '/v1/pvt';

export interface PvtPublicReadDeps extends AgentBankDeps {
  /**
   * Reads a PVT9 balance in atomic units. Defaults to the deployed kernel named
   * by the generated canonical config. Injectable so a test can exercise the
   * route without a live Base RPC — never to point the route at another token.
   */
  readPvt9Balance?: (address: string) => Promise<bigint>;
}

function handleError(res: Response, error: unknown): void {
  console.error('[PVTPublicReads] Error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

/** Per-IP budget, matching `pvt-estimate.ts` and the leaderboard pattern. */
const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_S = 60;
/** Blunts RPC amplification from distributed callers, which per-IP limiting cannot. */
const BALANCE_CACHE_TTL_S = 30;

/**
 * Every route here is UNAUTHENTICATED once the flip opens it, and two of them do
 * real work per request: `/balance/:address` issues a live `eth_call` to Base on
 * `BASE_RPC_URL` the SAME key the settlement runtime settlement runtime reads — and
 * `/milestones` falls through to seven Firestore counts plus a 5,000-doc
 * `pe_history` scan whenever its cache misses. Unmetered, either is a way for an
 * anonymous caller to spend the relay's chain-verification quota.
 *
 * Fails OPEN when Redis is unavailable, exactly like every other limiter in the
 * tree. That is the ratified convention, and it is a real residual: the balance
 * cache is the SAME Redis, so with Redis down neither control binds and an
 * anonymous caller can drive unmetered `eth_call`s. The cache bounds a different
 * axis — distinct addresses rather than requests — not this one. Stated rather
 * than implied; tracked in OPEN_ITEMS under the residuals.
 */
function createPerIpLimiter(cache: RedisCache, bucket: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(
        `rl:${bucket}:${clientIp}`, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_S,
      );
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }
    } catch (error) {
      console.error('[PVTPublicReads] Rate limit check failed:', error);
    }
    next();
  };
}

/**
 * Default balance reader: the deployed PVT9 kernel from the generated config.
 * Built lazily and once, so an unconfigured runtime fails at request time as a
 * 500 rather than taking the whole process down at import.
 */
function createDefaultPvt9BalanceReader(): (address: string) => Promise<bigint> {
  let contract: ethers.Contract | null = null;
  return async (address: string): Promise<bigint> => {
    if (contract === null) {
      const runtime = requireConfiguredPvt9Runtime();
      const provider = new ethers.JsonRpcProvider(
        process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        runtime.chainId,
      );
      contract = new ethers.Contract(
        runtime.address,
        runtime.abi as ethers.InterfaceAbi,
        provider,
      );
    }
    return (await contract.balanceOf(address)) as bigint;
  };
}

export function createPvtPublicReadRouter(deps: PvtPublicReadDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  const readPvt9Balance = deps.readPvt9Balance ?? createDefaultPvt9BalanceReader();
  const authenticatePVTDual = createPVTDualAuthMiddleware({ db, cache });
  const limit = createPerIpLimiter(cache, 'pvt-public-read');

  /**
   * Cached balance read. Keyed by lowercased address, so RPC cost is bounded by
   * DISTINCT ADDRESSES asked for rather than by requests received — a per-IP
   * limiter alone does not bound a distributed caller. Callers may see a value
   * up to `BALANCE_CACHE_TTL_S` old. A cache failure degrades to the direct
   * read, never to an error.
   *
   * STORED AS AN OBJECT, NOT A BARE STRING, and that is load-bearing. Upstash
   * serializes a string unchanged and parses the response with `JSON.parse`, so
   * `"74992500000000000000"` comes back as a NUMBER — every round balance would
   * have failed a `typeof === 'string'` check and re-hit the chain on every
   * request, which is precisely the amplification this cache exists to bound.
   * Wrapping it in `{ wei }` keeps the digits inside a JSON string, where they
   * survive the round trip. The digit-shape check is belt-and-braces: a
   * poisoned or truncated entry falls through to the chain rather than
   * throwing out of `BigInt`.
   */
  const readCachedPvt9Balance = async (address: string): Promise<bigint> => {
    const key = `pvt9:balance:${address.toLowerCase()}`;
    try {
      const cached = await cache.get<{ wei?: unknown }>(key);
      if (cached && typeof cached.wei === 'string' && /^\d+$/.test(cached.wei)) {
        return BigInt(cached.wei);
      }
    } catch {
      // A malformed or unreadable cache entry must never fail the request:
      // fall through to the chain read.
    }
    const balance = await readPvt9Balance(address);
    try {
      await cache.set(key, { wei: balance.toString() }, BALANCE_CACHE_TTL_S);
    } catch {
      // A cache write failure must not fail the request.
    }
    return balance;
  };

  // Per-route, never `router.use(...)`: this router shares its mount path with
  // the estimate router, and router-level middleware answering 404 would
  // swallow requests meant for a sibling. Same reasoning as agent-leaderboard.
  //
  // Written out at each call site rather than hoisted into a `gate` const so
  // the identifier is visible where the route is declared — both to a reader
  // and to scripts/route-reachability-matrix.mjs, which classifies posture by
  // the middleware NAMES appearing in the registration.

  router.get('/milestones', appClientDiscoveryGate(), limit, async (_req: Request, res: Response) => {
    try {
      res.json(await checkAllMilestones(deps));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/weights', appClientDiscoveryGate(), limit, async (_req: Request, res: Response) => {
    try {
      res.json(buildWeightConfigResponse());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/weights/overrides', publicDiscoveryGate(), limit, async (_req: Request, res: Response) => {
    try {
      const config = await loadWeightConfig();
      if (!config || !config.foundation_overrides) {
        res.json({ overrides: {}, expires_at: null, message: 'No active prospective action-weight overrides.' });
        return;
      }

      const isExpired = config.foundation_override_expires
        && Date.now() > config.foundation_override_expires;

      res.json({
        overrides: isExpired ? {} : config.foundation_overrides,
        expires_at: config.foundation_override_expires || null,
        is_expired: isExpired || false,
        updated_at: config.updated_at || null,
        message: isExpired
          ? 'Prospective action-weight overrides have expired. Frozen defaults are active.'
          : `${Object.keys(config.foundation_overrides).length} active prospective action-weight override(s). Bootstrap economic authority remains with Provian Technologies, LLC, signing through its bootstrap wallet; the Foundation Safe is not a setter.`,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/attestation-tiers', publicDiscoveryGate(), limit, async (_req: Request, res: Response) => {
    try {
      res.json(buildAttestationTierReference(await getEffectiveAttestationMultipliers()));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/balance/:wallet_address', appClientDiscoveryGate(), limit, async (req: Request, res: Response) => {
    try {
      const { wallet_address } = req.params;
      if (!ethers.isAddress(wallet_address)) {
        res.status(400).json({ error: 'Invalid wallet address' });
        return;
      }

      const balance = await readCachedPvt9Balance(wallet_address);
      res.json({
        wallet_address,
        balance: ethers.formatEther(balance),
        balance_raw: balance.toString(),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(
    '/allocation/:wallet_id',
    appClientDiscoveryGate(),
    limit,
    authenticatePVTDual,
    async (req: Request, res: Response) => {
      try {
        const auth = req.pvtAuth;
        const { wallet_id } = req.params;

        if (!auth) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }

        // Self only, on BOTH paths. The dual-auth middleware resolves who the
        // caller is; this is the check that they asked about themselves.
        if (auth.userId !== wallet_id) {
          res.status(403).json({ error: 'Can only view own allocation' });
          return;
        }

        let accrualSubjectId = auth.userId;
        let balanceAddress = auth.walletAddress ?? '';

        if (auth.type === 'agent') {
          const walletDoc = await db.collection('agent_wallets').doc(auth.userId).get();
          if (!walletDoc.exists) {
            res.status(404).json({ error: 'Wallet not found' });
            return;
          }
          const wallet = walletDoc.data()!;
          accrualSubjectId = wallet.agent_id;
          balanceAddress = wallet.address ?? '';
        }

        // settlementProjection is deliberately NOT supplied. The only reader in
        // the tree, readContractSettlementFactors, reads PVTv8 economic-state
        // functions (effectiveMintRate, circuitBreakerTripped, …) that the PVT9
        // kernel does not have, so aiming it at PVT9 buys two failing RPC legs
        // per request and a chain error string in the response. The typed
        // 'factors_not_supplied' reason says the true thing instead.
        const accrual = await readEconomicAccrualProjection(db, accrualSubjectId, {
          settlementProjection: null,
        });

        // PE METER: the unminted / minted counts are the subject's running totals by
        // current mint_status (the aggregate moves every status transition as
        // −before/+after), one point read — never a count() over stored PEs.
        const byStatus = await readAggregateMintStatusCounts(db, accrualSubjectId, 'contributor');

        let onChainBalance = '0';
        if (balanceAddress) {
          try {
            onChainBalance = ethers.formatEther(await readCachedPvt9Balance(balanceAddress));
          } catch {
            // A read failure is not an allocation failure; the record points
            // below are the load-bearing part of this response.
          }
        }

        res.json(buildAllocationPayload({
          walletId: auth.userId,
          onChainBalance,
          accrual,
          unmintedPeCount: byStatus.eligible ?? 0,
          mintedPeCount: byStatus.minted ?? 0,
        }));
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  return router;
}

/**
 * THE mount. server.ts calls this and nothing else for the PVT read surface, and
 * the integration suite drives the app this function assembles — so a router
 * dropped here fails a behavioral test, and this call deleted from server.ts
 * fails the mount-site pin. Neither can be green on its own.
 */
export function mountPvtPublicReads(app: Express, deps: PvtPublicReadDeps): void {
  app.use(PVT_PUBLIC_READ_MOUNT_PATH, createPVTEstimateRouter({ cache: deps.cache, db: deps.db }));
  app.use(PVT_PUBLIC_READ_MOUNT_PATH, createPvtPublicReadRouter(deps));
}
