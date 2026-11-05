/**
 * item 4 — only the linked human sets the reply policy, under wallet auth; an agent learns it
 * on its thread reads (and a person's thread reads carry nothing new). Every guard has a RED control.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('./middleware/wallet-auth', () => ({
  ...(jest.requireActual('./middleware/wallet-auth') as object),
  verifyWalletAuthToken: async (token: string) => (token.startsWith('human:')
    ? { ok: true, userId: token.slice('human:'.length), deviceId: 'dev_1' }
    : { ok: false, status: 401, error: 'invalid_wallet_auth' }),
}));

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { createAgentReplyPolicyRouter } from './agent-reply-policy';
import { createThreadsRouter } from './threads';

const HUMAN = 'user_frank';
const AGENT_WALLET = 'wallet_aw_atlas';
const MOUNT = '/v1/agent/wallet';

function build(opts: { rateLimited?: boolean } = {}) {
  const fake = createFakeFirestore();
  const rl = jest.fn(async () => (opts.rateLimited ? { allowed: false, current: 31, limit: 30, retryAfter: 60 } : { allowed: true, current: 1, limit: 30 }));
  const deps = {
    db: fake as unknown as Firestore,
    cache: { isEnabled: () => true, checkRateLimitStrict: rl, checkRateLimit: async () => ({ allowed: true, current: 1, limit: 100 }) },
  } as unknown as AgentBankDeps;
  const seed = () => fake.collection('agent_wallets').doc(AGENT_WALLET).set({
    id: AGENT_WALLET, agent_id: 'atlas', address: '0x1', status: 'active', linked_human_user_id: HUMAN,
  });
  const app = express();
  app.use(express.json());
  // The agent-key middleware the real relay runs on /v1/agent/wallet: an agent credential arrives
  // AUTHENTICATED (req.agentWallet set), so a 401 below is the route refusing it, not a missing shim.
  app.use(MOUNT, (req: Request, _res: Response, next: NextFunction) => {
    if (req.headers.authorization === 'Bearer agent') (req as unknown as { agentWallet: unknown }).agentWallet = { id: AGENT_WALLET, agent_id: 'atlas', address: '0x1' };
    next();
  }, createAgentReplyPolicyRouter(deps));
  // The thread routes behind a stand-in for the Commons dual-auth shim.
  app.use('/v1/threads', (req: Request, _res: Response, next: NextFunction) => {
    const h = req.headers.authorization ?? '';
    if (h === 'Bearer agent') (req as unknown as { agentWallet: unknown }).agentWallet = { id: AGENT_WALLET, agent_id: 'atlas', address: '0x1' };
    if (h === 'Bearer person') (req as unknown as { user: unknown }).user = { id: HUMAN, device_id: 'dev_1' };
    next();
  }, createThreadsRouter(deps));
  return { app, fake, seed, rl };
}

const setPolicy = (app: express.Express, auth: string | null, mode: unknown) => {
  const r = request(app).post(`${MOUNT}/${AGENT_WALLET}/reply-policy`);
  return (auth ? r.set('Authorization', auth) : r).send({ mode });
};

describe('reply policy — owner state, set by the linked human only', () => {
  it('the linked human reads the default, sets ask_me_first, and the agent is told it on every thread read', async () => {
    const { app, fake, seed } = build();
    await seed();
    const before = await request(app).get(`${MOUNT}/${AGENT_WALLET}/reply-policy`).set('Authorization', `Bearer human:${HUMAN}`);
    expect(before.body).toEqual({ wallet_id: AGENT_WALLET, mode: 'answer_anyone', linked_human: HUMAN });
    const set = await setPolicy(app, `Bearer human:${HUMAN}`, 'ask_me_first');
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ wallet_id: AGENT_WALLET, mode: 'ask_me_first', linked_human: HUMAN });
    expect((await fake.collection('agent_wallets').doc(AGENT_WALLET).get()).data()?.reply_policy).toMatchObject({ mode: 'ask_me_first', set_by_user_id: HUMAN });
    await fake.collection('commons_threads').doc('thr_1').set({
      thread_id: 'thr_1', anchor_kind: 'profile', anchor_id: AGENT_WALLET, party_a: AGENT_WALLET, party_b: 'wallet_aw_ann',
      parties: { [AGENT_WALLET]: { kind: 'agent', id: AGENT_WALLET }, wallet_aw_ann: { kind: 'agent', id: 'wallet_aw_ann' } },
      opened_by: 'wallet_aw_ann', backing: { kind: 'relationship' }, created_at: 1, last_message_at: 1, message_count: 0,
      read_cursors: { [AGENT_WALLET]: 0, wallet_aw_ann: 1 },
    });
    for (const path of ['/v1/threads', '/v1/threads/unread', '/v1/threads/thr_1/messages']) {
      const r = await request(app).get(path).set('Authorization', 'Bearer agent');
      expect(r.status).toBe(200);
      expect(r.body.reply_policy).toEqual({ mode: 'ask_me_first', linked_human: HUMAN });
    }
  });

  it('a person\'s own thread reads carry no reply_policy', async () => {
    const { app, seed } = build();
    await seed();
    const r = await request(app).get('/v1/threads').set('Authorization', 'Bearer person');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('reply_policy');
  });

  it('RED: an agent credential (or no credential) can never write it', async () => {
    const { app, fake, seed } = build();
    await seed();
    for (const auth of ['Bearer pvn_live_x:pvns_y', 'Bearer agent', null]) {
      const r = await setPolicy(app, auth, 'answer_anyone');
      expect(r.status).toBe(401);
    }
    expect((await fake.collection('agent_wallets').doc(AGENT_WALLET).get()).data()?.reply_policy).toBeUndefined();
  });

  it('RED: another human gets 403, a bad mode 400, and the limiter refuses with 429 — nothing written', async () => {
    const { app, fake, seed } = build();
    await seed();
    expect((await setPolicy(app, 'Bearer human:user_someone_else', 'ask_me_first')).status).toBe(403);
    expect((await setPolicy(app, `Bearer human:${HUMAN}`, 'ignore_everyone')).status).toBe(400);
    const limited = build({ rateLimited: true });
    await limited.seed();
    expect((await setPolicy(limited.app, `Bearer human:${HUMAN}`, 'ask_me_first')).status).toBe(429);
    expect((await fake.collection('agent_wallets').doc(AGENT_WALLET).get()).data()?.reply_policy).toBeUndefined();
    expect((await limited.fake.collection('agent_wallets').doc(AGENT_WALLET).get()).data()?.reply_policy).toBeUndefined();
  });
});
