/**
 * Reputation read API v0 — trust-consumption lane (bond lifecycle, agent-first launch).
 *
 * GET /v1/reputation/address/:address
 *
 * Chain-verified financial summary for a Base address KNOWN to Provian: a
 * proven external address (linked by the agent's own signature) or a native
 * sovereign agent-wallet address. Built for consumers deciding whether to
 * transact with the address — x402 services vetting payers, job boards
 * vetting agents.
 *
 * Honesty rules (Unknown = unknown, never an invented score):
 * - unknown address → `{ known: false }`, HTTP 200. No score, no guess.
 * - human wallet addresses resolve as UNKNOWN — humans did not opt into a
 * public reputation surface (see core/public-record/resolve.ts).
 * - only chain-verified events count (watchers + relay-verified transfers);
 * self-reported activity never inflates the summary.
 * - volume is bucketed, never exact; no PII, no counterparties, no tx
 * hashes, no balances (Tier-3 discipline).
 *
 * Free at launch; `pricing: "free_beta"` is the forward-compatibility field
 * for later PVT-denominated tiers.
 *
 * Public, unauthenticated, PUBLIC_LAUNCH-gated, per-IP rate limited,
 * Redis-cached with a Cache-Control hint for downstream caches.
 */

import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import {
  resolveRecordSubject,
  EVM_ADDRESS_PATTERN,
  type RecordSubject,
} from '../core/public-record/resolve';
import {
  summarizeChainVerifiedActivity,
  type ChainVerifiedActivitySummary,
} from '../core/public-record/financial-activity';
import { loadBondSignal, type BondSignal } from './agent-profile';
import { stripTier3Fields } from '../core/commons/publication';
import { getPublicApiBaseUrl } from '../provenance-links';

interface ReputationDeps {
  db: Firestore;
  cache: RedisCache;
}

const KNOWN_CACHE_TTL_SECONDS = 300;
const UNKNOWN_CACHE_TTL_SECONDS = 60;
const PRICING = 'free_beta';

const REPUTATION_DISCLAIMERS = [
  'Chain-verified events only; self-reported activity is excluded.',
  'Volume is bucketed, not exact. This is a factual activity summary, not a score or a recommendation.',
  'Every valid PE is proof its contributor owns; every act of work mints PVT once at its best-supported value.',
];

interface ReputationResponse {
  known: boolean;
  address: string;
  pricing: string;
  identity?: {
    /** How Provian knows this address. */
    address_type: 'native_agent_wallet' | 'proven_external';
    agent_wallet_id: string | null;
    display_name: string | null;
    /** Whether the agent behind this address is beneficiary-linked to a human. */
    linked_to_human: boolean;
    /** When the external link was proven (proven external addresses only). */
    proven_at: number | null;
    record_url: string;
  };
  financial?: ChainVerifiedActivitySummary;
  flags?: {
    bonded: boolean;
    bond_healthy: boolean;
    open_bond_claims: number;
    court_claims_upheld_against: number;
  };
  disclaimers: string[];
  generated_at: number;
}

async function countBondClaims(
  db: Firestore,
  walletId: string | null,
): Promise<{ open: number; upheld: number }> {
  if (!walletId) return { open: 0, upheld: 0 };
  try {
    const snap = await db.collection('bond_claims')
      .where('respondent_wallet_id', '==', walletId)
      .get();
    let open = 0;
    let upheld = 0;
    for (const doc of snap.docs) {
      const status = (doc.data() as { status?: string }).status;
      if (status === 'filed') open += 1;
      else if (status === 'upheld') upheld += 1;
    }
    return { open, upheld };
  } catch (error) {
    console.warn('[Reputation] bond claim count unavailable:', error);
    return { open: 0, upheld: 0 };
  }
}

function unknownResponse(address: string): ReputationResponse {
  return {
    known: false,
    address,
    pricing: PRICING,
    disclaimers: REPUTATION_DISCLAIMERS,
    generated_at: Date.now(),
  };
}

function buildKnownResponse(params: {
  address: string;
  subject: RecordSubject;
  financial: ChainVerifiedActivitySummary;
  bond: BondSignal;
  claims: { open: number; upheld: number };
}): ReputationResponse {
  const { address, subject, financial, bond, claims } = params;
  const resolved = subject.resolved!;
  const isExternal = subject.matched_by === 'proven_external_address';

  return {
    known: true,
    address,
    pricing: PRICING,
    identity: {
      address_type: isExternal ? 'proven_external' : 'native_agent_wallet',
      agent_wallet_id: resolved.walletId,
      display_name: resolved.displayName,
      linked_to_human: resolved.hasHumanLink,
      proven_at: isExternal ? subject.externalLink?.proven_at ?? null : null,
      record_url: `${getPublicApiBaseUrl()}/v1/agents/${encodeURIComponent(address)}/record`,
    },
    financial,
    flags: {
      bonded: bond.bond_active,
      bond_healthy: bond.bond_healthy,
      open_bond_claims: claims.open,
      court_claims_upheld_against: claims.upheld,
    },
    disclaimers: REPUTATION_DISCLAIMERS,
    generated_at: Date.now(),
  };
}

export function createReputationRouter(deps: ReputationDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // Belt-and-braces Tier-3 sanitizer (Commons pattern) — the response is
  // allowlist-built, this guards future drift.
  router.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => originalJson(stripTier3Fields(body))) as typeof res.json;
    next();
  });

  router.get('/address/:address', async (req: Request, res: Response) => {
    try {
      if (process.env.PUBLIC_LAUNCH !== 'true') {
        res.status(404).json({ error: 'not found' });
        return;
      }

      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(`rl:reputation:${clientIp}`, 60, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const raw = req.params.address;
      if (typeof raw !== 'string' || !EVM_ADDRESS_PATTERN.test(raw)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'address must be a 0x-prefixed 40-hex EVM address',
        });
        return;
      }
      // Firestore stores addresses lowercase — every equality lookup below
      // runs on the lowercased form regardless of the caller's casing.
      const address = raw.toLowerCase();

      const cacheKey = `reputation:${address}`;
      const cached = await cache.get<ReputationResponse>(cacheKey);
      if (cached) {
        res.set('Cache-Control', `public, max-age=${cached.known ? KNOWN_CACHE_TTL_SECONDS : UNKNOWN_CACHE_TTL_SECONDS}`);
        res.json(cached);
        return;
      }

      const subject = await resolveRecordSubject(db, address);
      if (!subject.found || !subject.resolved || !subject.resolved.userId) {
        const response = unknownResponse(address);
        await cache.set(cacheKey, response, UNKNOWN_CACHE_TTL_SECONDS);
        res.set('Cache-Control', `public, max-age=${UNKNOWN_CACHE_TTL_SECONDS}`);
        res.json(response);
        return;
      }

      const [financial, bond, claims] = await Promise.all([
        // Address-scoped: only events this address executed on-chain, even if
        // the agent identity also has activity on its other (native/external)
        // address.
        summarizeChainVerifiedActivity(db, subject.resolved.userId, { addressFilter: address }),
        loadBondSignal(db, subject.resolved.walletId),
        countBondClaims(db, subject.resolved.walletId),
      ]);

      const response = buildKnownResponse({ address, subject, financial, bond, claims });
      await cache.set(cacheKey, response, KNOWN_CACHE_TTL_SECONDS);
      res.set('Cache-Control', `public, max-age=${KNOWN_CACHE_TTL_SECONDS}`);
      res.json(response);
    } catch (error) {
      console.error('[Reputation] Error:', error);
      res.status(500).json({ error: 'Reputation lookup failed' });
    }
  });

  return router;
}
