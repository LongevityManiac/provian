/**
 * Contract Registry Routes
 *
 * Admin-managed registry of known smart contract addresses for the
 * CryptoTransactionClassifier. Allows updating contract classifications
 * without app releases.
 *
 * POST /v1/admin/contract-registry  - Admin: add/update a contract entry
 * GET  /v1/contract-registry        - Public: fetch all entries (HMAC-signed)
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { safeSecretCompare } from './middleware/admin-secret';

// Valid categories and risk tiers (must match CryptoTransactionClassifier types)
const VALID_CATEGORIES = [
  'token_transfer', 'token_approval', 'dex_swap', 'prediction_market',
  'nft_trade', 'defi_lending', 'defi_staking', 'bridge', 'governance',
  'contract_deploy', 'unknown',
] as const;

const VALID_RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
const VALID_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'] as const;

const REGISTRY_COLLECTION = 'contract_registry';
const CACHE_KEY = 'contract_registry:all';
const CACHE_TTL = 300; // 5 minutes

interface ContractRegistryEntry {
  address: string;
  chain: string;
  platform: string;
  category: string;
  riskTier: string;
  description: string;
  implementation_type: 'reference' | 'ecosystem';
  created_at: number;
  updated_at: number;
}

export function createContractRegistryRouter(deps: AgentBankDeps): Router {
  const router = Router();

  // =========================================================================
  // POST / - Admin: add or update a contract registry entry
  // =========================================================================
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Admin auth via x-admin-secret header (constant-time compare).
      if (!safeSecretCompare(req.headers['x-admin-secret'], process.env.AGENT_BANK_ADMIN_SECRET)) {
        return res.status(401).json({ error: 'admin_auth_failed' });
      }

      const { address, chain, platform, category, riskTier, description, implementation_type } = req.body;

      // Validate required fields
      if (!address || !chain || !platform || !category || !riskTier || !description) {
        return res.status(400).json({
          error: 'Missing required fields: address, chain, platform, category, riskTier, description',
        });
      }

      // Validate address format (0x-prefixed hex, 42 chars)
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({ error: 'Invalid address format (must be 0x-prefixed, 40 hex chars)' });
      }

      // Validate chain
      if (!VALID_CHAINS.includes(chain as typeof VALID_CHAINS[number])) {
        return res.status(400).json({ error: `Invalid chain. Must be one of: ${VALID_CHAINS.join(', ')}` });
      }

      // Validate category
      if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      // Validate riskTier
      if (!VALID_RISK_TIERS.includes(riskTier as typeof VALID_RISK_TIERS[number])) {
        return res.status(400).json({ error: `Invalid riskTier. Must be one of: ${VALID_RISK_TIERS.join(', ')}` });
      }

      const now = Date.now();
      const docId = `${chain}:${address.toLowerCase()}`;
      // Validate implementation_type if provided
      const validImplTypes = ['reference', 'ecosystem'] as const;
      const implType = implementation_type && validImplTypes.includes(implementation_type)
        ? implementation_type
        : 'ecosystem';

      const entry: ContractRegistryEntry = {
        address: address.toLowerCase(),
        chain,
        platform,
        category,
        riskTier,
        description,
        implementation_type: implType,
        created_at: now,
        updated_at: now,
      };

      // Upsert - merge to preserve created_at on updates
      const docRef = deps.db.collection(REGISTRY_COLLECTION).doc(docId);
      const existingDoc = await docRef.get();
      if (existingDoc.exists) {
        entry.created_at = existingDoc.data()?.created_at || now;
      }
      await docRef.set(entry);

      // Invalidate Redis cache
      await deps.cache.del(CACHE_KEY);

      console.log(`[ContractRegistry] Added/updated ${docId}: ${platform} (${category})`);
      res.json({ success: true, id: docId, entry });
    } catch (err) {
      console.error('[ContractRegistry] POST error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Create the public GET router for contract registry.
 * Separate from admin router so it mounts at a different path.
 */
export function createContractRegistryPublicRouter(deps: AgentBankDeps): Router {
  const router = Router();

  // =========================================================================
  // GET / - Public: fetch all registry entries with HMAC signature
  // =========================================================================
  router.get('/', async (_req: Request, res: Response) => {
    try {
      // Check Redis cache first
      const cached = await deps.cache.get<{ entries: ContractRegistryEntry[]; signature: string }>(CACHE_KEY);
      if (cached) {
        return res.json(cached);
      }

      // Firestore fallback
      const snapshot = await deps.db.collection(REGISTRY_COLLECTION).get();
      const entries: ContractRegistryEntry[] = snapshot.docs.map((doc) => doc.data() as ContractRegistryEntry);

      // SECURITY (C-12): Use HMAC-SHA256, not SHA-256(secret + ':' + payload).
      // The plain hash construction is forgeable via length-extension attacks.
      // The mobile client currently does not verify this signature (the
      // signing secret was bundled in the binary and removed in M-10), so the
      // operative integrity guarantees are HTTPS + wallet auth on the
      // endpoint. The signature is retained for any future server-to-server
      // verifier (e.g., a trusted SDK consumer that holds the shared secret
      // out-of-band). When such a verifier is added it MUST use HMAC-SHA256
      // - never plain SHA-256 of secret || payload.
      const signingSecret = process.env.REGISTRY_SIGNING_SECRET;
      let signature = '';
      if (signingSecret) {
        const payload = JSON.stringify(entries);
        signature = crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
      }

      const response = { entries, signature };

      // Cache in Redis
      await deps.cache.set(CACHE_KEY, response, CACHE_TTL);

      res.json(response);
    } catch (err) {
      console.error('[ContractRegistry] GET error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
