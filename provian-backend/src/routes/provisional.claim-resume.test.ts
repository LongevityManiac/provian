/** Corrective Pass 8: provisional claim is terminally retired because it was a
 * partial native-agent registration path. Existing provisional evidence stays
 * untouched; callers receive canonical registration/migration guidance. */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// PoP is exercised by its own suite; here we mock it to isolate the resume path.
jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  verifyAndConsumePopChallenge: jest.fn(async () => ({ ok: true })),
}));

import { createProvisionalRouter, type ProvisionalRouterDeps } from './provisional';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { makePeHistoryDoc } from '../__test-helpers__/pe-doc-fixtures';
import type { Firestore } from 'firebase-admin/firestore';

const IDENTIFIER = 'abc';
const OWNER = 'user_real';
const PUBKEY = 'a'.repeat(128); // 64-byte uncompressed secp256k1 hex (post-strip)

function buildApp(fake: FakeFirestore): Express {
  const deps: ProvisionalRouterDeps = {
    db: fake as unknown as Firestore,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true })) as never,
      get: jest.fn(async () => null) as never,
      set: jest.fn(async () => undefined) as never,
      del: jest.fn(async () => undefined) as never,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined) as never,
    deriveAddressFromPublicKey: (_pk: string) => '0xderived',
  };
  const app = express();
  app.use(express.json());
  // Inject wallet auth (server.ts applies this in prod).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: OWNER, device_id: 'dev_1' };
    next();
  });
  app.use('/v1/provisional', createProvisionalRouter(deps));
  return app;
}

function seedClaimedButUnmigrated(fake: FakeFirestore): void {
  fake.store.set(`provisional_wallets/${IDENTIFIER}`, {
    identifier: IDENTIFIER,
    created_at: 1_000,
    pe_count: 2,
    estimated_pvt: 2,
    claimed: true,
    claim_token: 'tok123',
    owner_user_id: OWNER,
    chain_tip_hash: 'genesis',
    migration_status: 'pending', // crashed/failed mid-migration
    claimed_wallet_id: 'wallet_aw_x',
  });
  // Two PEs still stranded under the provisional owner id.
  fake.store.set('pe_history/pe_1', makePeHistoryDoc({ peId: 'pe_1', userId: `provisional_${IDENTIFIER}`, timestamp: 1 }));
  fake.store.set('pe_history/pe_2', makePeHistoryDoc({ peId: 'pe_2', userId: `provisional_${IDENTIFIER}`, timestamp: 2 }));
}

const claimBody = {
  claim_token: 'tok123',
  identifier: IDENTIFIER,
  public_key: PUBKEY,
  challenge_id: 'chal_1',
  signature: 'deadbeef',
};

describe('retired provisional wallet claim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns terminal migration guidance and writes nothing for a pending legacy claim', async () => {
    const fake = createFakeFirestore();
    seedClaimedButUnmigrated(fake);
    const app = buildApp(fake);
    const before = new Map([...fake.store.entries()].map(([key, value]) => [key, { ...value }]));

    const res = await request(app).post('/v1/provisional/claim').send(claimBody);

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      error: 'provisional_wallet_claim_retired',
      migration: {
        register: 'POST /v1/agent/wallet/create',
      },
    });
    expect(fake.store).toEqual(before);
    expect([...fake.store.keys()].some((key) => key.startsWith('agent_wallets/'))).toBe(false);
    expect([...fake.store.keys()].some((key) => key.startsWith('wallets/'))).toBe(false);
  });

  it('does not inspect or mutate corrupted legacy claim state', async () => {
    const fake = createFakeFirestore();
    seedClaimedButUnmigrated(fake);
    fake.store.set(`provisional_wallets/${IDENTIFIER}`, {
      ...fake.store.get(`provisional_wallets/${IDENTIFIER}`)!,
      owner_user_id: null, // corrupted state
    });
    const app = buildApp(fake);
    const before = new Map([...fake.store.entries()].map(([key, value]) => [key, { ...value }]));

    const res = await request(app).post('/v1/provisional/claim').send(claimBody);

    expect(res.status).toBe(410);
    expect(fake.store).toEqual(before);
  });

  it('is terminal even for a previously completed legacy claim', async () => {
    const fake = createFakeFirestore();
    seedClaimedButUnmigrated(fake);
    fake.store.set(`provisional_wallets/${IDENTIFIER}`, {
      ...fake.store.get(`provisional_wallets/${IDENTIFIER}`)!,
      migration_status: 'complete',
    });
    const app = buildApp(fake);

    const res = await request(app).post('/v1/provisional/claim').send(claimBody);

    expect(res.status).toBe(410);
  });
});
