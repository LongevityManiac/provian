import { observeActorSession } from '../../core/jurisdiction/mint-compliance';
import {openPrivateAuthenticatedRequest} from '../../core/meter/private-pricing';
/**
 * Agent API Key Authentication Middleware
 *
 * Auth flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Split into api_key:api_secret
 * 3. Look up api_key_index/{prefix} → wallet_id
 * 4. Load agent_wallets/{wallet_id} → stored hash + salt
 * 5. scrypt verify (constant-time comparison)
 * 6. Attach wallet document to req.agentWallet
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyApiCredentialAsync } from '../../core/agent-wallet/api-key';
import type { AgentWalletDocument } from '../../core/agent-wallet/types';
import { cache } from '../../cache';
import { isValidFirestoreDocumentId } from '../../firestore-document-id';

// The `req.agentWallet` augmentation lives in src/types/express.d.ts (consolidated).

/** Cache TTL for wallet document lookups (seconds) */
const WALLET_CACHE_TTL_S = 30;

/**
 * Invalidate the cached agent wallet document by wallet_id.
 * Looks up the api_key_index to find the cache key prefix, then deletes from Redis.
 * Call this whenever wallet status is set to disabled/suspended/revoked for instant revocation.
 */
export async function invalidateAgentWalletCache(db: Firestore, walletId: string): Promise<void> {
  try {
    // Find the api_key_index entry pointing to this wallet
    const indexQuery = await db.collection('api_key_index')
      .where('wallet_id', '==', walletId)
      .limit(1)
      .get();
    if (!indexQuery.empty) {
      const prefix = indexQuery.docs[0].id;
      await cache.del(`agent_wallet:${prefix}`);
    }
  } catch (error) {
    console.error(`[AgentAuth] Failed to invalidate cache for wallet ${walletId}:`, error);
  }
}

/**
 * Create an authenticateAgent middleware bound to the given Firestore instance.
 */
export function createAgentAuthMiddleware(db: Firestore): RequestHandler {
  return async function authenticateAgent(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
   try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7); // Remove 'Bearer '
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) {
      res.status(401).json({ error: 'Invalid credential format. Expected api_key:api_secret' });
      return;
    }

    const apiKey = token.slice(0, colonIdx);
    const apiSecret = token.slice(colonIdx + 1);

    if (!apiKey.startsWith('pvn_live_') || !apiSecret.startsWith('pvns_')) {
      res.status(401).json({ error: 'Invalid credential format' });
      return;
    }

    // Look up wallet by api key prefix - check Redis cache first to avoid
    // 2 Firestore reads per request (#1: agent auth bottleneck fix)
    const prefix = apiKey.slice(0, 24);
    // F62: the prefix becomes a Firestore document path (`.doc(prefix)` below).
    // `.doc()` throws SYNCHRONOUSLY on a '/' (and other reserved shapes); in this
    // async middleware that throw would reject uncaught and crash the process.
    // Reject any prefix that is not a valid single document-id BEFORE it reaches
    // `.doc()`. A real api-key prefix is `pvn_live_<hex>` and always passes.
    if (!isValidFirestoreDocumentId(prefix)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const cacheKey = `agent_wallet:${prefix}`;

    let wallet: AgentWalletDocument | null = await cache.get<AgentWalletDocument>(cacheKey);

    // Always revalidate the small credential index, even on a wallet-cache hit.
    // Credential recovery and key rotation transactionally delete the old
    // prefix; trusting a cached wallet without this check would leave the
    // superseded secret usable until the 30-second cache TTL expired.
    const indexDoc = await db.collection('api_key_index').doc(prefix).get();
    if (!indexDoc.exists) {
      await cache.del(cacheKey).catch(() => {});
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const indexData = indexDoc.data() as { wallet_id: string };
    if (wallet && (wallet.id !== indexData.wallet_id || wallet.api_key_prefix !== prefix)) {
      await cache.del(cacheKey).catch(() => {});
      wallet = null;
    }

    if (!wallet) {
      // Cache miss - the prefix-to-wallet binding above remains authoritative.
      const walletDoc = await db.collection('agent_wallets').doc(indexData.wallet_id).get();
      if (!walletDoc.exists) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      wallet = walletDoc.data() as AgentWalletDocument;

      // Cache the wallet document (NOT the auth result - scrypt must still run)
      await cache.set(cacheKey, wallet, WALLET_CACHE_TTL_S);
    }

    // When changing wallet status elsewhere, call invalidateAgentWalletCache()
    // for instant revocation instead of waiting for the 30s cache TTL to expire.
    if (wallet.status !== 'active') {
      res.status(403).json({ error: `Wallet is ${wallet.status}` });
      return;
    }

    // Verify credentials via async scrypt (constant-time, non-blocking)
    // This always runs even on cache hit - it's the anti-brute-force protection
    const valid = await verifyApiCredentialAsync(
      apiKey,
      apiSecret,
      wallet.api_key_hash,
      wallet.api_key_salt,
    );

    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    req.agentWallet = wallet;
    await observeActorSession(db, req, wallet.agent_id);
    openPrivateAuthenticatedRequest(req,apiSecret);
    next();
   } catch (err) {
    // F62: no caller-supplied header may take the process down. A synchronous
    // throw from `.doc()` (or any transient Firestore/cache error) answers 503
    // here instead of rejecting uncaught. Never fail open to `next()`.
    console.error('[AgentAuth] middleware error:', err);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
   }
  };
}
