import type { RequestHandler } from 'express';

/**
 * Terminal response for the superseded unified-wallet agent creation route.
 * Native agents must use the PoP-bound canonical registration service mounted
 * at /v1/agent/wallet/create; this handler intentionally performs no reads or
 * writes so a compatibility caller cannot create a partial `wallets` row.
 */
export const retiredLegacyAgentWalletCreateHandler: RequestHandler = (_req, res) => {
  res.status(410).json({
    error: 'legacy_agent_wallet_creation_retired',
    migration: {
      challenge: 'GET /v1/agent/wallet/challenge?public_key=<public_key>&registration_id=<stable_registration_id>&agent_id=<stable_agent_id>',
      register: 'POST /v1/agent/wallet/create',
    },
  });
};
