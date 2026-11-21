import express, { type Request } from 'express';
import request from 'supertest';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createRecourseRouter } from './recourse';
import { identityHash, RECOURSE_COLLECTIONS } from '../core/recourse/ownership';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { MEMBERSHIP_CONSENT_OPERATIONS, parseMembershipConsentRequest } from '../core/recourse/membership-consent-operation';
import { MEMBERSHIP_BINDING_AWAITING_FINALITY, PRIVATE_MEMBERSHIP_TRANSITIONS } from '../core/recourse/private-membership-transition';
import { MEMBERSHIP_DEBIT_OPERATIONS, parseMembershipDebitRequest } from '../core/recourse/membership-debit-operation';
import { PRIVATE_MEMBERSHIP_COLLECTIONS } from '../core/recourse/private-membership-reservation';
import * as restoration from '../core/recourse/restoration-request';
import * as auxiliaryRecovery from '../core/recourse/auxiliary-recovery';
import * as poolState from '../core/recourse/pool-state';
import * as membershipDomain from '../core/recourse/private-membership-domain';
import * as membershipScan from '../core/recourse/private-membership-scan';
import * as monthlyDisplay from '../core/recourse/monthly-approval-display';
import type { RecourseDisplayPool } from '../core/recourse/pool-display';
import { recourseMembershipRuleHash, type RecourseMembershipRule } from '../core/recourse/membership-rule';
import { joinPrivateMembership } from '../core/recourse/private-membership-calendar';
import * as protocol from '../core/protocol/runtime';
import * as monthly from '../core/recourse/monthly-approval';
import type { ProtocolDeployment } from '../core/protocol/pointer';

const chainBlock = `0x${'0b'.repeat(32)}`;
const chainPool = `0x${'cd'.repeat(20)}`;
const displayMonth = 2026 * 12 + 10;
const displayRule: RecourseMembershipRule = {
  schema: 'provian-recourse-membership/v1', chainId: 8453, pointer: `0x${'9a'.repeat(20)}`,
  firstMonth: displayMonth, participationBurnAtomic: '100', noEarningsContributionAtomic: '200', earningsBps: 100,
};
const ruleHash = recourseMembershipRuleHash(displayRule);
const pool: RecourseDisplayPool = {
  pool: chainPool, kernel: chainPool, block: 100, blockHash: chainBlock, revision: '1',
  timestamp: Date.UTC(2026, 10, 21) / 1000, observedAtMs: Date.now(), month: String(displayMonth),
  reserveAtomic: '900', participationBurnAtomic: '100', noEarningsContributionAtomic: '200',
  earningsBps: 100, signedRuleHash: ruleHash, schedule: [{ rule: displayRule, ruleHash }],
};
const poolKey = 'recourse_public_resources_v1/display';

test('the display loads without chain reads, reconciliation, or a private scan while binding challenges require fresh verification', async () => {
  const db = createFakeFirestore();
  const userId = 'user_recourse_reader', account = `0x${'ae'.repeat(20)}`, zero = `0x${'00'.repeat(32)}`;
  const ownerIdentity = identityHash('human', userId);
  db.store.set('wallets/wallet_recourse_reader', { address: account, type: 'human', user_id: userId });
  db.store.set(poolKey, { ...pool });
  const deployment = { pointer: displayRule.pointer, addresses: { kernel: pool.kernel } } as ProtocolDeployment;
  const readDeployment = jest.spyOn(protocol, 'currentProtocolDeployment').mockResolvedValue(deployment);
  const readPool = jest.spyOn(poolState, 'readRecoursePoolState').mockRejectedValue(Error('recourse_chain_unavailable'));
  const reconcile = jest.spyOn(membershipDomain, 'reconcilePrivateMembershipDomain').mockRejectedValue(Error('unavailable'));
  const scan = jest.spyOn(membershipScan, 'readPrivateMembershipScan').mockRejectedValue(Error('unavailable'));
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.user = { id: userId } as Request['user']; next();
  }));
  const read = () => request(app).get('/v1/recourse/pool').set('Authorization', 'Bearer TEST_ONLY');
  try {
    expect((await request(app).get('/v1/recourse/pool')).status).toBe(401);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ identity: zero, primaryIdentity: null, walletAddress: account,
      reserveAtomic: '900', membership: { enrolled: false, details: { status: 'not_member' } } });
    expect(db.store.size).toBe(2);

    db.store.set(`${PRIVATE_MEMBERSHIP_COLLECTIONS.owners}/${ownerIdentity}`, { ownerIdentity });
    const checking = await read();
    expect(checking.status).toBe(200);
    expect(checking.body).toMatchObject({ reserveAtomic: '900', membershipChecking: true, membership: null });
    expect(readDeployment).not.toHaveBeenCalled();
    expect(readPool).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();

    const challenge = await request(app).post('/v1/recourse/binding-challenge').set('Authorization', 'Bearer TEST_ONLY')
      .send({ address: account, signingRoot: chainBlock, recoveryCommitment: chainBlock });
    expect(readDeployment).toHaveBeenCalledWith({ fresh: true });
    expect(readPool).toHaveBeenCalledWith(expect.stringMatching(/^0x[0-9a-f]{64}$/), deployment);
    expect(challenge.body).toEqual({ error: 'recourse_chain_unavailable' });
    expect(challenge.body.binding).toBeUndefined();
  } finally { readPool.mockRestore(); readDeployment.mockRestore(); reconcile.mockRestore(); scan.mockRestore(); }
});

test('an auxiliary-only owner reads committed membership and only its own monthly approval display', async () => {
  const db = createFakeFirestore(), walletId = 'wallet_aw_aux_member', ownerIdentity = identityHash('agent', walletId);
  const identity = `0x${'ab'.repeat(32)}`, account = `0x${'ac'.repeat(20)}`;
  const owner = { ownerIdentity, ownerType: 'agent', ownerId: walletId, walletId };
  const ownerKey = `${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`;
  db.store.set(ownerKey, { ...owner, membershipFixedDebitBinding: identity });
  db.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, { ...owner, identity, primaryBinding: false });
  db.store.set(`${RECOURSE_COLLECTIONS.addresses}/${account}`, { ownerIdentity, identity, address: account, chainBindingStatus: 'confirmed' });
  db.store.set(poolKey, { ...pool });
  db.store.set(`${PRIVATE_MEMBERSHIP_COLLECTIONS.owners}/${ownerIdentity}`, {
    ownerIdentity, version: 1, checkpoint: { pool: pool.pool, block: pool.block, blockHash: pool.blockHash },
    needsScan: true, pendingReservation: 'in-flight',
    episode: joinPrivateMembership(null, displayMonth, () => ({ rule: displayRule, ruleHash })),
  });
  const approval = { status: 'approved', burnLimit: '100', reserveLimit: '200', earningsBpsLimit: 100 } as const;
  const readMonthly = jest.spyOn(monthlyDisplay, 'readMonthlyApprovalDisplay').mockResolvedValue(approval);
  const chainMonthly = jest.spyOn(monthly, 'readRecourseMonthlyApproval').mockRejectedValue(Error('offline'));
  const app = express();
  app.use('/v1/recourse', createRecourseRouter({ db } as unknown as AgentBankDeps, (req, _res, next) => {
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  try {
    const response = await request(app).get('/v1/recourse/pool');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ identity, primaryIdentity: null, membership: { enrolled: true }, monthlyApproval: approval });
    expect(readMonthly).toHaveBeenCalledWith(db, ownerIdentity, identity, expect.objectContaining({ signedRuleHash: ruleHash }));
    expect(chainMonthly).not.toHaveBeenCalled();
    readMonthly.mockRejectedValueOnce(Error('display unavailable'));
    const unavailable = await request(app).get('/v1/recourse/pool');
    expect(unavailable.body).toMatchObject({ membership: { enrolled: true }, monthlyApproval: null });
    db.store.get(ownerKey)!.membershipFixedDebitBinding = `0x${'fe'.repeat(32)}`;
    readMonthly.mockClear();
    expect((await request(app).get('/v1/recourse/pool')).body.monthlyApproval).toBeNull();
    expect(readMonthly).not.toHaveBeenCalled();
  } finally { readMonthly.mockRestore(); chainMonthly.mockRestore(); }
});

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
  fake.store.set(`recourse_determination_workflows_v1/${primary}`, { transactions: { reverse: h('31') } });
  fake.store.set(`recourse_determination_workflows_v1/${foreign}`, { transactions: { reverse: h('32') } });
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
      ['restoration-requests', { transactionHash, block: 100, recoveryRequestId, restorationRequestId:h('26') }, submit],
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
    expect(list.body.requests.find((row: { identity: string }) => row.identity === primary).reversalTransactionHash).toBe(h('31'));
    expect(list.body.requests.find((row: { identity: string }) => row.identity === auxiliary).reversalTransactionHash).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain(h('32'));
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
  const consent = { binding: h('17'), account: a('18'), nonce: '0', joined: true, revision: '1', ruleHash: h('19'), expiresAt: '2000' };
  const operationRequest = { transitionId, domain: { chainId: '8453', pointer: a('14'), kernel: a('15'), pool: a('16') }, consent,
    standing: { consent, admissionMonth:'23640',rejoinPayments:[],fixedChargePayer:true, burnLimit: '100', reserveLimit: '100', earningsBpsLimit: 100,
      exitCommitment: h('20'), exitSalt: h('21') }, exitSecret: null, ownerSignature: '0x1111', attestorSignature: '0x2222' };
  // Invalid persisted payloads also return 404; prove this fixture reaches the ownership check.
  expect(parseMembershipConsentRequest(operationRequest)).toEqual(operationRequest);
  fake.store.set(`${MEMBERSHIP_CONSENT_OPERATIONS}/${id}`, { status: 'queued', transactionHash: null, request: operationRequest });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  expect((await request(app).get(`/v1/recourse/membership-consents/${id}`)).status).toBe(401);
  expect((await request(app).post('/v1/recourse/membership-transitions').send({ kind: 'join' })).status).toBe(401);
  const denied = await request(app).get(`/v1/recourse/membership-consents/${id}`).set('Authorization', 'Bearer TEST_ONLY');
  expect(denied.status).toBe(404); expect(denied.headers['cache-control']).toBe('no-store');
  expect(denied.body).toEqual({ error: 'recourse_membership_unavailable' });
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
  const operationRequest = { reservationId, domain: { chainId: '8453', pointer: a('14'), kernel: a('15'), pool: a('16') },
    debit: { binding: h('17'), payer: a('18'), nonce: '0', month: '24322', burn: '100', reserve: '0', generation: '1', revision: '1', ruleHash: h('19'), expiresAt: '2000' },
    attestorSignature: '0x2222' };
  // Invalid persisted payloads also return 404; prove this fixture reaches the ownership check.
  expect(parseMembershipDebitRequest(operationRequest)).toEqual(operationRequest);
  fake.store.set(`${MEMBERSHIP_DEBIT_OPERATIONS}/${id}`, { status: 'queued', transactionHash: null, request: operationRequest });
  const app = express(); app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db: fake } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: walletId } as Request['agentWallet']; next();
  }));
  expect((await request(app).post('/v1/recourse/membership-debits').send({})).status).toBe(401);
  const denied = await request(app).get(`/v1/recourse/membership-debits/${id}`).set('Authorization', 'Bearer TEST_ONLY');
  expect(denied.status).toBe(404); expect(denied.headers['cache-control']).toBe('no-store');
  expect(denied.body).toEqual({ error: 'recourse_membership_debit_unavailable' });
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

test('join reports confirmation pending separately from an unavailable membership', async () => {
  const db = createFakeFirestore(), app = express();
  const preparation = await import('../core/recourse/membership-preparation');
  const prepare = jest.spyOn(preparation, 'prepareMembershipTransition');
  app.use(express.json());
  app.use('/v1/recourse', createRecourseRouter({ db } as unknown as AgentBankDeps, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer TEST_ONLY') { res.sendStatus(401); return; }
    req.agentWallet = { id: 'wallet_waiting' } as Request['agentWallet'];
    next();
  }));
  const join = () => request(app).post('/v1/recourse/membership-transitions').set('Authorization', 'Bearer TEST_ONLY').send({ kind: 'join' });
  try {
    prepare.mockRejectedValueOnce(Error(MEMBERSHIP_BINDING_AWAITING_FINALITY))
      .mockRejectedValueOnce(Error('unrelated_failure'));
    const pending = await join();
    expect(pending.status).toBe(409);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(pending.body).toEqual({ error: MEMBERSHIP_BINDING_AWAITING_FINALITY });
    const refused = await join();
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'recourse_membership_unavailable' });
  } finally { prepare.mockRestore(); }
});
