import express, { type Request } from 'express';
import request from 'supertest';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createRecourseRouter } from './recourse';
import { identityHash, RECOURSE_COLLECTIONS } from '../core/recourse/ownership';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';

test('authenticated auxiliary-first ownership lists only that owner with no primary recovery authority', async () => {
  const fake = createFakeFirestore(), walletId = 'wallet_aw_auxiliary_first';
  const ownerIdentity = identityHash('agent', walletId), binding = `0x${'12'.repeat(32)}`;
  const account = `0x${'13'.repeat(20)}`;
  fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`, {
    ownerIdentity, ownerType: 'agent', ownerId: walletId, walletId,
  });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${account}`, { ownerIdentity, identity: binding, address: account });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/another`, {
    ownerIdentity: identityHash('agent', 'someone-else'), identity: `0x${'14'.repeat(32)}`, address: 'PRIVATE_OTHER_ADDRESS',
  });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  expect((await request(app).get('/v1/recourse/ownership')).status).toBe(401);
  const response = await request(app).get('/v1/recourse/ownership').set('Authorization', 'Bearer TEST_ONLY');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ identity: null, recoveryCommitment: null,
    addresses: [{ ownerIdentity, identity: binding, address: account }] });
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE_OTHER_ADDRESS');
});
