import express, { type Request } from 'express';
import request from 'supertest';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createRecourseRouter } from './recourse';
import { identityHash, RECOURSE_COLLECTIONS } from '../core/recourse/ownership';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { MEMBERSHIP_CONSENT_OPERATIONS } from '../core/recourse/membership-consent-operation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS } from '../core/recourse/private-membership-transition';
import { MEMBERSHIP_DEBIT_OPERATIONS } from '../core/recourse/membership-debit-operation';
import { PRIVATE_MEMBERSHIP_COLLECTIONS } from '../core/recourse/private-membership-reservation';
import * as restoration from '../core/recourse/restoration-request';
import * as auxiliaryRecovery from '../core/recourse/auxiliary-recovery';

test('auxiliary recovery requires owner authentication and returns only a generic error', async () => {
  const db = createFakeFirestore(), app = express(); app.use(express.json());
  const recover = jest.spyOn(auxiliaryRecovery, 'recoverAuxiliaryOwnership');
  app.use('/v1/recourse', createRecourseRouter({ db } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: 'wallet_aw_aux' } as Request['agentWallet']; next();
  }));
  try {
    expect((await request(app).post('/v1/recourse/recover-address').send({ preimage: 'SECRET' })).status).toBe(401);
    const denied = await request(app).post('/v1/recourse/recover-address').set('Authorization', 'Bearer TEST_ONLY').send({ preimage: 'SECRET' });
    expect(denied.status).toBe(400); expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.body).toEqual({ error: 'recourse_recovery_refused' }); expect(recover).not.toHaveBeenCalled();
  } finally { recover.mockRestore(); }
});

test('restoration selects an owned auxiliary binding and privately lists all owned requests, including without a primary', async () => {
  const fake = createFakeFirestore(), walletId = 'wallet_aw_restoration', ownerIdentity = identityHash('agent', walletId);
  const h = (b: string) => `0x${b.repeat(32)}`;
  const primary = h('21'), auxiliary = h('22'), foreign = h('23'), transactionHash = h('24'), recoveryRequestId = h('25');
  const owner = { ownerIdentity, ownerType: 'agent', ownerId: walletId, walletId };
  fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`, { ...owner, primaryBinding: primary });
  for (const identity of [primary, auxiliary]) fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, {
    ...owner, identity, primaryBinding: identity === primary });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${foreign}`, {
    ...owner, identity: foreign, ownerIdentity: identityHash('agent', 'other'), ownerId: 'other', walletId: 'other' });
  for (const identity of [primary, auxiliary, foreign]) fake.store.set(`${restoration.RESTORATION_REQUESTS}/${identity}`, {
    identity, status: 'prepared', transactionHash, createdAtMs: 1 });
  const prepare = jest.spyOn(restoration, 'prepareRestorationRequest').mockResolvedValue({
    request: h('26'), lossHash: h('27'), maximumLoss: '100', kernel: `0x${'28'.repeat(20)}` });
  const submit = jest.spyOn(restoration, 'submitRestorationRequest').mockResolvedValue({ requestId: h('26'), status: 'authorized' });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  try {
    for (const [route, body, spy] of [
      ['restoration-intents', { transactionHash, block: 100 }, prepare],
      ['restoration-requests', { transactionHash, block: 100, recoveryRequestId }, submit],
    ] as const) {
      expect((await request(app).post(`/v1/recourse/${route}`).send({ ...body, identity: auxiliary })).status).toBe(401);
      for (const identity of [foreign, h('99'), ownerIdentity, null, { identity: auxiliary }]) {
        expect((await request(app).post(`/v1/recourse/${route}`).set('Authorization', 'Bearer TEST_ONLY').send({ ...body, identity })).status).toBe(400);
      }
      expect(spy).not.toHaveBeenCalled();
      const response = await request(app).post(`/v1/recourse/${route}`).set('Authorization', 'Bearer TEST_ONLY').send({ ...body, identity: auxiliary });
      expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(spy).toHaveBeenLastCalledWith(fake, auxiliary, body);
      expect((await request(app).post(`/v1/recourse/${route}`).set('Authorization', 'Bearer TEST_ONLY').send(body)).status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(fake, primary, body);
    }
    const list = await request(app).get('/v1/recourse/restoration-requests').set('Authorization', 'Bearer TEST_ONLY');
    expect(list.status).toBe(200); expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.requests.map((r: { identity: string }) => r.identity).sort()).toEqual([primary, auxiliary]);
    expect(JSON.stringify(list.body)).not.toContain(foreign);
    delete fake.store.get(`${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`)!.primaryBinding;
    expect((await request(app).post('/v1/recourse/restoration-intents').set('Authorization', 'Bearer TEST_ONLY')
      .send({ transactionHash, block: 100, identity: auxiliary })).status).toBe(200);
    // A forged binding row cannot borrow a valid private owner key to expose another wallet's requests.
    fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${foreign}`)!.ownerIdentity = ownerIdentity;
    const denied = await request(app).get('/v1/recourse/restoration-requests').set('Authorization', 'Bearer TEST_ONLY');
    expect(denied.status).toBe(503); expect(JSON.stringify(denied.body)).not.toContain(foreign);
  } finally { prepare.mockRestore(); submit.mockRestore(); }
});

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
test('membership operation status is owner-only, no-store and never returns private payloads or signatures', async () => {
  const fake = createFakeFirestore(), walletId = 'wallet_aw_member', ownerIdentity = identityHash('agent', walletId);
  const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
  const transitionId = h('12'), id = h('13');
  fake.store.set(`${PRIVATE_MEMBERSHIP_TRANSITIONS}/${transitionId}`, { ownerIdentity: identityHash('agent', 'other') });
  fake.store.set(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`, { status: 'queued', transactionHash: null,
    request: { transitionId, domain: { chainId: '8453', pointer: a('14'), kernel: a('15'), pool: a('16') },
      consent: { binding: h('17'), account: a('18'), nonce: '0', joined: true, revision: '1', ruleHash: h('19'), expiresAt: '2000' },
      ownerSignature: '0x1111', attestorSignature: '0x2222' } });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  expect((await request(app).get(`/v1/recourse/membership-consents/${id}`)).status).toBe(401);
  expect((await request(app).post('/v1/recourse/membership-transitions').send({ kind: 'join' })).status).toBe(401);
  expect((await request(app).get(`/v1/recourse/membership-consents/${id}`).set('Authorization', 'Bearer TEST_ONLY')).status).toBe(404);
  fake.store.get(`${PRIVATE_MEMBERSHIP_TRANSITIONS}/${transitionId}`)!.ownerIdentity = ownerIdentity;
  const response = await request(app).get(`/v1/recourse/membership-consents/${id}`).set('Authorization', 'Bearer TEST_ONLY');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ id, status: 'queued', transactionHash: null });
});
test('payment status does not expose another owner reservation or its exact financial mandate', async () => {
  const fake = createFakeFirestore(), walletId = 'wallet_aw_payer', ownerIdentity = identityHash('agent', walletId);
  const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
  const reservationId = h('12'), id = h('13');
  fake.store.set(`${PRIVATE_MEMBERSHIP_COLLECTIONS.reservations}/${reservationId}`, {
    reservation: { ownerIdentity: identityHash('agent', 'other'), id: reservationId, kind: 'debit' } });
  fake.store.set(`${MEMBERSHIP_DEBIT_OPERATIONS}/${id}`, { status: 'queued', transactionHash: null,
    request: { reservationId, domain: { chainId: '8453', pointer: a('14'), kernel: a('15'), pool: a('16') },
      debit: { binding: h('17'), payer: a('18'), nonce: '0', month: '24322', burn: '100', reserve: '0', generation: '1', revision: '1', ruleHash: h('19'), expiresAt: '2000' },
      ownerSignature: '0x1111', attestorSignature: '0x2222' } });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  expect((await request(app).post('/v1/recourse/membership-debits').send({})).status).toBe(401);
  expect((await request(app).get(`/v1/recourse/membership-debits/${id}`).set('Authorization', 'Bearer TEST_ONLY')).status).toBe(404);
  fake.store.set(`${PRIVATE_MEMBERSHIP_COLLECTIONS.reservations}/${reservationId}`, { reservation: { ownerIdentity, id: reservationId, kind: 'debit' } });
  const response = await request(app).get(`/v1/recourse/membership-debits/${id}`).set('Authorization', 'Bearer TEST_ONLY');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ id, status: 'queued', transactionHash: null });
});

test('active transition discovery is authenticated and scoped to the caller after a lost response', async () => {
  const fake = createFakeFirestore(), walletId = 'wallet_aw_resume', ownerIdentity = identityHash('agent', walletId);
  const id = `0x${'31'.repeat(32)}`;
  const preparation = await import('../core/recourse/membership-preparation');
  const prepare = jest.spyOn(preparation, 'prepareMembershipTransition').mockResolvedValue({ id, kind: 'join', status: 'preparing', challenges: [], pending: [] });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  try {
    expect((await request(app).get('/v1/recourse/membership-transitions')).status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${identityHash('agent', 'other')}`, { membershipTransition: id });
    const absent = await request(app).get('/v1/recourse/membership-transitions').set('Authorization', 'Bearer TEST_ONLY');
    expect(absent.status).toBe(200); expect(absent.body).toBe(null); expect(prepare).not.toHaveBeenCalled();
    fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`, { membershipTransition: id });
    const found = await request(app).get('/v1/recourse/membership-transitions').set('Authorization', 'Bearer TEST_ONLY');
    expect(found.status).toBe(200); expect(found.headers['cache-control']).toBe('no-store');
    expect(prepare).toHaveBeenCalledWith(fake, ownerIdentity, { id });
    expect(found.body).toEqual({ id, kind: 'join', status: 'preparing', challenges: [], pending: [] });
  } finally { prepare.mockRestore(); }
});
