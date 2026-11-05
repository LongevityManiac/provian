/**
 *. `GET /v1/agent/wallet/:wallet_id` heals pending badge awards before it reads. A badge
 * record that does not validate stays unpublished (the reconcile still fails closed) but no longer
 * fails the read: the wallet is served with the badges it already holds. Any OTHER failure still
 * answers 500.
 * RED CONTROL RECORD (pre-fix source): the integrity case answered 500.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockReconcile = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
jest.mock('../core/agent-wallet/badge-provenance', () => ({
  ...(jest.requireActual('../core/agent-wallet/badge-provenance') as object),
  reconcileBadgeAwards: (...args: unknown[]) => mockReconcile(...args),
}));
jest.mock('../core/agent-wallet/beneficiary-relationship', () => ({
  ...(jest.requireActual('../core/agent-wallet/beneficiary-relationship') as object),
  readValidatedBeneficiaryRelationship: async () => ({ state: 'unlinked' }),
}));
jest.mock('../core/agent-wallet/agent-pe-activity', () => ({
  ...(jest.requireActual('../core/agent-wallet/agent-pe-activity') as object),
  countVisibleAgentPEs: async () => 7,
}));
const WALLET = {
  id: 'wallet_aw_iso', agent_id: 'iso-agent', address: `0x${'c'.repeat(40)}`, status: 'active',
  badges: [{ id: 'linked', earned_at: 1 }],
};
jest.mock('./middleware/agent-auth', () => ({
  createAgentAuthMiddleware: () => (req: { agentWallet?: unknown }, _res: unknown, next: () => void) => {
    req.agentWallet = WALLET;
    next();
  },
}));

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps } from '../core/agent-wallet/types';
import { BadgeProvenanceIntegrityError } from '../core/agent-wallet/badge-provenance';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';

function app() {
  const fake = createFakeFirestore();
  fake.store.set(`agent_wallets/${WALLET.id}`, { ...WALLET });
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null, set: async () => undefined, del: async () => undefined,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as RouterDeps;
  const a = express();
  a.use(express.json());
  a.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return a;
}

describe('the wallet read survives a badge record that does not validate', () => {
  beforeEach(() => { mockReconcile.mockReset(); });

  it('a badge integrity refusal is logged and the wallet is still served', async () => {
    mockReconcile.mockRejectedValueOnce(new BadgeProvenanceIntegrityError('wallet_binding'));
    const res = await request(app()).get(`/v1/agent/wallet/${WALLET.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet_id: WALLET.id, agent_id: WALLET.agent_id, badges: WALLET.badges, pe_count: 7 });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('RED: any other reconcile failure still answers 500', async () => {
    mockReconcile.mockRejectedValueOnce(new Error('firestore unavailable'));
    const res = await request(app()).get(`/v1/agent/wallet/${WALLET.id}`);
    expect(res.status).toBe(500);
  });

  it('GREEN baseline: a clean reconcile serves the wallet', async () => {
    const res = await request(app()).get(`/v1/agent/wallet/${WALLET.id}`);
    expect(res.status).toBe(200);
  });
});
