/**
 * PUT /v1/agent/wallet/:wallet_id/link-human — beneficiary-share consent
 * (F48, S2 2026-09-10).
 *
 * The beneficiary split is the HUMAN's economic term (the human chooses the bps
 * at invite/connection time —, OPEN_ITEMS:3835). This route used to let
 * the AGENT rewrite its OWN share under agent API auth ALONE (the party that
 * benefits, silently cutting the human's share). The agent-auth-only rewrite is
 * removed: the write now requires the linked human's EIP-191 signature over the
 * canonical change payload, exactly as POST /link-human / /unlink-human.
 *
 * RED control: without a valid human signature the write is refused and
 * updateAgentBeneficiaryShareBps is NEVER called (revert the signature gate and
 * the no-signature case goes green through to the helper). Positive control: a
 * valid signature from the linked human's address performs the change once.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Only the share-write helper is stubbed; the rest of link-human-binding
// (canonicalAgentBeneficiaryShareBps, BeneficiaryLinkConflictError) stays real.
const mockUpdateShare = jest.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
jest.mock('../core/agent-wallet/link-human-binding', () => ({
  ...(jest.requireActual('../core/agent-wallet/link-human-binding') as object),
  updateAgentBeneficiaryShareBps: (...args: unknown[]) => mockUpdateShare(...args),
}));

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import stableStringify from 'json-stable-stringify';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() {
        const d = col(name).get(id);
        return { exists: d !== undefined, id, data: () => d };
      },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore): RouterDeps {
  return {
    db,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })),
      checkRateLimitStrict: jest.fn(async () => ({ allowed: true, current: 0, limit: 5 })),
      isEnabled: () => true,
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    } as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

function seedLinkedAgent(
  col: (n: string) => Map<string, Doc>,
  humanAddress: string,
): { walletId: string; humanWalletId: string; bearer: string } {
  const creds = generateApiCredentials();
  const walletId = 'wallet_aw_1';
  const humanWalletId = 'human_wallet_1';
  col('agent_wallets').set(walletId, {
    id: walletId,
    agent_id: 'agent-1',
    address: '0xAGENTADDR',
    api_key_hash: creds.api_key_hash,
    api_key_salt: creds.api_key_salt,
    api_key_prefix: creds.api_key_prefix,
    status: 'active',
    linked_human_wallet_id: humanWalletId,
    linked_human_user_id: 'human_user_1',
    linked_human_address: humanAddress.toLowerCase(),
  } as unknown as Doc);
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: walletId });
  col('wallets').set(humanWalletId, { id: humanWalletId, type: 'human', address: humanAddress });
  return { walletId, humanWalletId, bearer: `Bearer ${creds.api_key}:${creds.api_secret}` };
}

function buildApp() {
  const { db, col } = makeFirestore();
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(makeDeps(db)));
  return { app, col };
}

const NEW_BPS = 5000; // the agent tries to grab 50% (human's share → 50%)

describe('PUT /:wallet_id/link-human — F48 human consent for beneficiary share', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('RED control: agent API auth alone, NO human signature → 400 and no share write', async () => {
    const { app, col } = buildApp();
    const human = ethers.Wallet.createRandom();
    const { walletId, bearer } = seedLinkedAgent(col, human.address);

    const res = await request(app)
      .put(`/v1/agent/wallet/${walletId}/link-human`)
      .set('Authorization', bearer)
      .send({ operational_reserve_bps: NEW_BPS });

    expect(res.status).toBe(400);
    expect(mockUpdateShare).not.toHaveBeenCalled();
  });

  it('a signature from a NON-human key is rejected (401) and no share write happens', async () => {
    const { app, col } = buildApp();
    const human = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const { walletId, humanWalletId, bearer } = seedLinkedAgent(col, human.address);

    const timestamp = Date.now();
    const payload = stableStringify({
      action: 'update_beneficiary_share',
      agent_wallet_id: walletId,
      human_wallet_id: humanWalletId,
      link_epoch: 1,
      operational_reserve_bps: NEW_BPS,
      timestamp,
    });
    const signature = await attacker.signMessage(payload || '');

    const res = await request(app)
      .put(`/v1/agent/wallet/${walletId}/link-human`)
      .set('Authorization', bearer)
      .send({ operational_reserve_bps: NEW_BPS, signature, timestamp, link_epoch: 1 });

    expect(res.status).toBe(401);
    expect(mockUpdateShare).not.toHaveBeenCalled();
  });

  it('positive control: a valid signature from the linked human performs the change once', async () => {
    const { app, col } = buildApp();
    const human = ethers.Wallet.createRandom();
    const { walletId, humanWalletId, bearer } = seedLinkedAgent(col, human.address);

    const timestamp = Date.now();
    const payload = stableStringify({
      action: 'update_beneficiary_share',
      agent_wallet_id: walletId,
      human_wallet_id: humanWalletId,
      link_epoch: 1,
      operational_reserve_bps: NEW_BPS,
      timestamp,
    });
    const signature = await human.signMessage(payload || '');

    const res = await request(app)
      .put(`/v1/agent/wallet/${walletId}/link-human`)
      .set('Authorization', bearer)
      .send({ operational_reserve_bps: NEW_BPS, signature, timestamp, link_epoch: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet_id: walletId, operational_reserve_bps: NEW_BPS });
    expect(mockUpdateShare).toHaveBeenCalledTimes(1);
    const [, params] = mockUpdateShare.mock.calls[0] as unknown as [unknown, { agentShareBps: number; authorization?: { action: string; linkEpoch: number; payloadSha256: string } }];
    expect(params.agentShareBps).toBe(NEW_BPS);
    // the verified signature travels to the helper as a single-use authorization.
    expect(params.authorization).toMatchObject({ action: 'update_beneficiary_share', linkEpoch: 1 });
    expect(params.authorization?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a human signature bound to a DIFFERENT bps cannot authorize this change (401)', async () => {
    const { app, col } = buildApp();
    const human = ethers.Wallet.createRandom();
    const { walletId, humanWalletId, bearer } = seedLinkedAgent(col, human.address);

    const timestamp = Date.now();
    // Human consented to 2000 bps; the agent submits 5000 with that signature.
    const consentedPayload = stableStringify({
      action: 'update_beneficiary_share',
      agent_wallet_id: walletId,
      human_wallet_id: humanWalletId,
      link_epoch: 1,
      operational_reserve_bps: 2000,
      timestamp,
    });
    const signature = await human.signMessage(consentedPayload || '');

    const res = await request(app)
      .put(`/v1/agent/wallet/${walletId}/link-human`)
      .set('Authorization', bearer)
      .send({ operational_reserve_bps: NEW_BPS, signature, timestamp, link_epoch: 1 });

    expect(res.status).toBe(401);
    expect(mockUpdateShare).not.toHaveBeenCalled();
  });
});
