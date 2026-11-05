/**
 * Scam Contract Blocklist API
 *
 * Public endpoint serving the scam contract blocklist.
 * Source of truth: Firestore `security_config/scam_contracts` document.
 * Falls back to a hardcoded static list if Firestore doc doesn't exist.
 *
 * Auth: None (public). Rate-limited by global middleware.
 * Cache: Redis 1 hour.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';

// =============================================================================
// TYPES
// =============================================================================

export interface ScamListDeps {
  cache: RedisCache;
  db: Firestore;
}

interface ScamListResponse {
  version: string;
  contracts: string[];
  deployers: string[];
  updated_at: string;
}

// =============================================================================
// STATIC FALLBACK - used when Firestore doc doesn't exist yet
// =============================================================================

/**
 * The list served when Firestore holds none. 2026-10-17 bug check: it carried the 0x
 * AllowanceHolder (the app's own swap target), the Uniswap Universal Router and the MetaMask swap
 * router as "fake DEX routers" — and was what production served. `scam-list.test.ts` pins every
 * contract the relay's own commerce lane recognises out of it.
 */
export const STATIC_SCAM_FALLBACK: ScamListResponse = {
  version: '2026-10-17',
  contracts: [
    // Inferno Drainer
    '0x0000db5c8b030ae20308ac975898e09f02bafc36',
    '0x0000db5c8b030ae20308ac975898e09f02bafc60',
    '0x00000000009726632680af5d2a2f4e2e4e72cc5f',
    '0x000000000dfde7deaf24138722987c9a6991e2d4',
    '0x0000000000a84d1a9b0063a910315c7ffa9cd248',
    '0x00000000ae347930bd1e7b0f35588b92280f9e75',
    '0x000000000dbb4df3108756af562fbb75fc1e8a6c',
    '0x000000004f43c49e93c970e84001853a51612302',
    // Pink Drainer
    '0x000000000000aaeb6d7670e522a718067cc6c302',
    '0x00000000000006b6baa3b1c96b9230ad8b8e3588',
    '0x0000000099cb7fc48a935bceb9f05bbae54e8987',
    '0x00000000f1fc3e8d0d2d259052b46e4a0e3b92d9',
    '0x0000000017db7e85d60a9114b05f6dbb73802bcc',
    // Angel Drainer
    '0x00000000000040e22a4736e4a4e1005e0048c509',
    '0x000000000000f5a96ab2c441deca478f11206c5c',
    '0x000000000000b34831d5889a8a1a84a193a41666',
    // MS Drainer
    '0x00000000000047f4789d9fca2a09f37d0e23985a',
    '0x000000000000175a8b9bc586346178900e984d88',
    '0x00000000000083b2f6f4c6dda4b6e9a9b3c8fd27',
  ],
  deployers: [
    '0x0000db5c8b030ae20308ac975898e09f02bafc36',
    '0x9d1b1669c73b033dfe47ae5a0164ab96df25b944',
    '0x29230c905e308fee88c8e81c511a5641c62e0323',
    '0xb0ba367fe36130ea3c6280e08f84236ce6e1a6f6',
    '0x736ddc3ada29f7be34b8e84f8ceb54aadc5db7e3',
    '0x4de23f3f0fb3318287378adbde030cf61714b2f3',
  ],
  updated_at: '2026-10-17T00:00:00Z',
};

// =============================================================================
// CACHE KEY + TTL
// =============================================================================

const CACHE_KEY = 'security:scam-contracts';
const CACHE_TTL_SECONDS = 3600; // 1 hour

// =============================================================================
// ROUTER
// =============================================================================

export function createScamListRouter(deps: ScamListDeps): Router {
  const { cache, db } = deps;
  const router = Router();

  /**
   * GET /v1/security/scam-contracts
   *
   * Returns the full scam contract blocklist with version info.
   * Public - no auth required.
   */
  router.get('/scam-contracts', async (_req: Request, res: Response) => {
    try {
      // 1. Check Redis cache
      const cached = await cache.get<ScamListResponse>(CACHE_KEY);
      if (cached) {
        res.json(cached);
        return;
      }

      // 2. Read from Firestore
      const doc = await db.collection('security_config').doc('scam_contracts').get();

      let response: ScamListResponse;

      if (doc.exists) {
        const data = doc.data();
        response = {
          version: (data?.version as string) || STATIC_SCAM_FALLBACK.version,
          contracts: (data?.contracts as string[]) || STATIC_SCAM_FALLBACK.contracts,
          deployers: (data?.deployers as string[]) || STATIC_SCAM_FALLBACK.deployers,
          updated_at: (data?.updated_at as string) || STATIC_SCAM_FALLBACK.updated_at,
        };
      } else {
        // Firestore doc doesn't exist yet - use static fallback
        response = STATIC_SCAM_FALLBACK;
      }

      // 3. Cache in Redis for 1 hour
      await cache.set(CACHE_KEY, response, CACHE_TTL_SECONDS);

      res.json(response);
    } catch (error) {
      console.error('[ScamList] Error fetching scam list:', error);
      // On any error, return the static fallback - never leave the client unprotected
      res.json(STATIC_SCAM_FALLBACK);
    }
  });

  return router;
}
