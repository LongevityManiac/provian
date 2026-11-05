/**
 * Dual-auth + ownership tests for the genesis status route (the security logic
 * that was previously inline in server.ts and untested). Verifies:
 *   - either-auth: agent api-key (pvn_live_ prefix) OR human wallet auth (dotted)
 *   - IDOR closed: an agent reads ONLY its own wallet; a human reads ONLY their
 *     own wallet or a linked agent
 *   - fail-closed: missing/other/unlinked wallet => 403; bad/absent creds => 401
 *   - existence is not probeable (missing wallet and unauthorized both 403)
 *   - getGenesisWalletStatus runs ONLY after the ownership gate passes
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { createGenesisStatusRouter, type WalletAuthVerifyResult } from './genesis-status';

const AGENT_SELF = 'wallet_aw_self';
const HUMAN_SELF_WALLET = 'wallet_human_self';
const HUMAN_USER = 'user_self';
const LINKED_AGENT_WALLET = 'wallet_aw_linked';

function buildApp(getStatus = jest.fn(async () => ({ ok: true }))) {
  const fake = createFakeFirestore();
  // The human's own wallet.
  fake.store.set(`wallets/${HUMAN_SELF_WALLET}`, { type: 'human', user_id: HUMAN_USER, address: '0xh' });
  // Another human's wallet (not the caller's).
  fake.store.set('wallets/wallet_human_other', { type: 'human', user_id: 'user_other', address: '0xo' });
  // An agent wallet linked to the caller human.
  fake.store.set(`agent_wallets/${LINKED_AGENT_WALLET}`, { linked_human_user_id: HUMAN_USER });
  // An unlinked agent wallet.
  fake.store.set('agent_wallets/wallet_aw_unlinked', { linked_human_user_id: null });

  // Fake agent api-key middleware: 'pvn_live_good:...' authenticates as AGENT_SELF;
  // anything else 401s (mirrors the real middleware sending its own error).
  const authenticateAgent = (req: Request, res: Response, next: (err?: unknown) => void): void => {
    const token = (req.headers.authorization ?? '').substring(7);
    if (token.startsWith('pvn_live_good')) {
      req.agentWallet = { id: AGENT_SELF } as unknown as NonNullable<Request['agentWallet']>;
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid credentials' });
  };

  // Fake wallet-auth verifier: 'good.sig' => HUMAN_USER; else 401.
  const verifyWalletAuthToken = async (token: string): Promise<WalletAuthVerifyResult> => {
    if (token.startsWith('good.')) return { ok: true, userId: HUMAN_USER, deviceId: 'd1' };
    return { ok: false, status: 401, error: 'Invalid token signature' };
  };

  const router = createGenesisStatusRouter({
    db: fake as unknown as Firestore,
    verifyWalletAuthToken,
    authenticateAgent,
    getGenesisWalletStatus: getStatus as unknown as (db: Firestore, walletId: string) => Promise<unknown>,
  });
  const app = express();
  app.use('/v1/genesis/status', router);
  return { app, getStatus };
}

const AGENT_TOKEN = 'pvn_live_goodkey0000000000000000:pvns_secret';
const HUMAN_TOKEN = 'good.deadbeef';

describe('genesis-status dual-auth + ownership', () => {
  it('401 without an Authorization header', async () => {
    const { app, getStatus } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${AGENT_SELF}`);
    expect(res.status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('401 for a token that is neither an api-key nor a wallet token', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${AGENT_SELF}`).set('Authorization', 'Bearer just-a-uuid-no-dot');
    expect(res.status).toBe(401);
  });

  it('agent reads its OWN wallet -> 200 and status runs', async () => {
    const { app, getStatus } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${AGENT_SELF}`).set('Authorization', `Bearer ${AGENT_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('agent reading ANOTHER wallet -> 403 (IDOR closed), status never runs', async () => {
    const { app, getStatus } = buildApp();
    const res = await request(app).get('/v1/genesis/status/wallet_aw_someone_else').set('Authorization', `Bearer ${AGENT_TOKEN}`);
    expect(res.status).toBe(403);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('agent with bad credentials -> 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${AGENT_SELF}`).set('Authorization', 'Bearer pvn_live_badkey:pvns_x');
    expect(res.status).toBe(401);
  });

  it('human reads their OWN wallet -> 200', async () => {
    const { app, getStatus } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${HUMAN_SELF_WALLET}`).set('Authorization', `Bearer ${HUMAN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('human reads a LINKED agent wallet -> 200', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${LINKED_AGENT_WALLET}`).set('Authorization', `Bearer ${HUMAN_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('human reading another human\'s wallet -> 403', async () => {
    const { app, getStatus } = buildApp();
    const res = await request(app).get('/v1/genesis/status/wallet_human_other').set('Authorization', `Bearer ${HUMAN_TOKEN}`);
    expect(res.status).toBe(403);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('human reading an UNLINKED agent wallet -> 403', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/v1/genesis/status/wallet_aw_unlinked').set('Authorization', `Bearer ${HUMAN_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('human reading a NON-EXISTENT wallet -> 403 (existence not probeable)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/v1/genesis/status/wallet_does_not_exist').set('Authorization', `Bearer ${HUMAN_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('human with an invalid wallet token -> 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/v1/genesis/status/${HUMAN_SELF_WALLET}`).set('Authorization', 'Bearer bad.sig');
    expect(res.status).toBe(401);
  });
});
