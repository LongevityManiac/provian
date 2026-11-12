import { prepareDepartureCredentials, retainDepartureCredentials, advanceMembershipDeparture } from '../core/recourse/membership-departure';
import { discoverOwnerRecovery } from '../core/recourse/owner-recovery-discovery';
import { discoverRestorationHistory } from '../core/recourse/restoration-history';
import { runOwnerOperationWorker } from '../core/recourse/owner-operation-runtime';
import { readBreakEntitlement } from '../core/recourse/break-entitlement-store';
import { discoverBreakRecovery } from '../core/recourse/break-recovery-discovery';
import { runBreakDeploymentWorker } from '../core/recourse/break-deployment-runtime';
import { queueBreakDeployment, readBreakDeployment } from '../core/recourse/break-deployment-queue';
import { queueBreakRegistration, readBreakRegistration, runBreakRegistrationWorker } from '../core/recourse/break-registration';
import { queueBreakRestoration, readBreakRestoration, reconcileBreakRestoration, confirmBreakRestoration } from '../core/recourse/break-restoration-queue';
import { queueOwnerOperation, readOwnerOperation } from '../core/recourse/owner-operation-queue';
import { randomBytes } from 'crypto';
import { Router, type RequestHandler, type Request } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { isActiveHumanWallet } from '../core/wallet/active-human-wallet';
import { identityHash, primaryBindingIdentity, ownedBindingIdentity, ownershipBindingMessage, registerOwnership, RECOURSE_COLLECTIONS,
  type OwnershipBinding } from '../core/recourse/ownership';
import { currentProtocolDeployment } from '../core/protocol/runtime';
import { selectExternalProofFence, revalidateExternalProofFence } from '../core/external-address/proof-head';
import { createRecourseChainPort } from '../core/recourse/chain-ledger';
import { prepareMemberBindingConsent } from '../core/recourse/member-binding-requirement';
import type { MemberBindingConsent } from '../core/recourse/member-binding';
import { readPrivateMembershipView } from '../core/recourse/private-membership-view';
import { readRecoursePoolState, recoursePoolConfig } from '../core/recourse/pool-state';
import { RECOURSE_RATIO_COLLECTION, publicRecourseResources } from '../core/recourse/pool-ratio';
import { parseAgentRecoveryRequest, recoverAgentOwnership } from '../core/recourse/agent-recovery';
import { parseHumanRecoveryRequest, recoverHumanOwnership } from '../core/recourse/human-recovery';
import { parseAuxiliaryRecoveryRequest, recoverAuxiliaryOwnership } from '../core/recourse/auxiliary-recovery';
import { prepareRestorationRequest, submitRestorationRequest, RESTORATION_REQUESTS } from '../core/recourse/restoration-request';
import { queueBindingOperation } from '../core/recourse/binding-operation';
import { runBindingWorker } from '../core/recourse/binding-runtime';
import { readPublishedRecourseRule } from '../core/recourse/membership-rule';
import { authenticatePrivateRecourse } from './middleware/recourse-private';
import { addressRecoveryBinding } from '../core/recourse/address-binding';
import { prepareMembershipTransition, ownedMembershipTransition } from '../core/recourse/membership-preparation';
import { queueMembershipConsent, MEMBERSHIP_CONSENT_OPERATIONS, parseMembershipConsentRequest } from '../core/recourse/membership-consent-operation';
import { readSponsoredOperation } from '../core/recourse/sponsored-operation-queue';
import { runMembershipConsentWorker, runMembershipDebitWorker } from '../core/recourse/membership-runtime';
import { prepareMembershipDebit, parseMembershipPaymentSelection } from '../core/recourse/membership-debit-preparation';
import { queueMembershipDebit, ownedMembershipDebit, parseMembershipDebitRequest, MEMBERSHIP_DEBIT_OPERATIONS } from '../core/recourse/membership-debit-operation';

interface Owner { readonly type: 'human' | 'agent'; readonly id: string; readonly walletId: string }
async function resolveOwner(req: Request, deps: AgentBankDeps): Promise<Owner> {
  if (req.agentWallet && !req.user) return { type: 'agent', id: req.agentWallet.id, walletId: req.agentWallet.id };
  if (!req.user || req.agentWallet) throw new Error('recourse_auth_required');
  const snapshots = await deps.db.collection('wallets').where('user_id', '==', req.user.id).where('type', '==', 'human').limit(10).get();
  const active = snapshots.docs.filter(doc => isActiveHumanWallet(doc.data()));
  if (active.length !== 1) throw new Error('recourse_active_wallet_required');
  return { type: 'human', id: req.user.id, walletId: active[0].id };
}

/** Bodies are never logged: recovery credentials must not enter request/error telemetry. */
export function createRecourseRouter(deps: AgentBankDeps, authenticateOwner: RequestHandler): Router {
  const router = Router();
  router.use(authenticatePrivateRecourse(deps.db));
  router.post('/restoration-history/:identity', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await discoverRestorationHistory(deps.db, String(req.params.identity))); }
    catch { res.status(404).json({ error: 'recourse_restoration_history_unavailable' }); }
  });
  router.post('/owner-recovery-state/:identity/:nonce', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await discoverOwnerRecovery(deps.db, String(req.params.identity), String(req.params.nonce))); }
    catch { res.status(404).json({ error: 'recourse_owner_discovery_unavailable' }); }
  });
  router.post('/break-recovery-state/:origin/:identity', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await discoverBreakRecovery(deps.db,String(req.params.origin),String(req.params.identity))); }
    catch { res.status(404).json({error:'recourse_break_discovery_unavailable'}); }
  });
  router.post('/break-entitlements/:origin/:identity', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await readBreakEntitlement(deps.db, String(req.params.origin), String(req.params.identity))); }
    catch { res.status(404).json({ error: 'recourse_break_entitlement_unavailable' }); }
  });
  router.get('/membership-rules/:hash', async (req, res) => {
    try {
      const deployment = await currentProtocolDeployment();
      res.json(await readPublishedRecourseRule(deps.db, String(req.params.hash), deployment.pointer));
    } catch { res.status(503).json({ error: 'recourse_rule_unavailable' }); }
  });
  router.get('/resources', async (_req, res) => {
    try {
      const config = await recoursePoolConfig();
      const snapshot = await deps.db.collection(RECOURSE_RATIO_COLLECTION).doc(config.address).get();
      if (!snapshot.exists) throw new Error('recourse_resources_unavailable');
      res.json(publicRecourseResources(snapshot.data(), config.address));
    } catch { res.status(503).json({ error: 'recourse_resources_unavailable' }); }
  });
  // The independent secret plus fresh-key proof authenticate recovery. Requiring
  // the lost API credential here would make the recovery path unusable.
  router.post('/recover-human', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await recoverHumanOwnership(deps, parseHumanRecoveryRequest(req.body)));
    } catch {
      res.status(400).json({ error: 'recourse_recovery_refused' });
    } finally {
      req.body = undefined;
      req.rawBody = undefined;
    }
  });
  router.post('/recover-agent', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const input = parseAgentRecoveryRequest(req.body);
      res.json(await recoverAgentOwnership(deps, input));
    } catch {
      // Do not echo credentials, signatures, provider errors or owner existence.
      res.status(400).json({ error: 'recourse_recovery_refused' });
    } finally {
      req.body = undefined;
      req.rawBody = undefined;
    }
  });
  router.post('/owner-operations/recovery', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const queued=await queueOwnerOperation(deps.db,req.body);
      try { await runOwnerOperationWorker(deps.db); } catch { /* durable operation is resumed by the authenticated scheduler */ }
      res.json(await readOwnerOperation(deps.db,queued.id));
    }
    catch { res.status(400).json({ error: 'recourse_owner_operation_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.post('/owner-operations/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await readOwnerOperation(deps.db, String(req.params.id))); }
    catch { res.status(404).json({ error: 'recourse_owner_operation_unavailable' }); }
  });
  router.post('/break-deployments', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const queued = await queueBreakDeployment(deps.db, req.body);
      try { await runBreakDeploymentWorker(deps.db); } catch { /* The durable scheduler resumes the exact transaction. */ }
      res.json(await readBreakDeployment(deps.db, queued.id));
    } catch { res.status(400).json({ error: 'recourse_break_deployment_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.post('/break-deployments/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await readBreakDeployment(deps.db, String(req.params.id))); }
    catch { res.status(404).json({ error: 'recourse_break_deployment_unavailable' }); }
  });
  router.post('/break-registrations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const queued = await queueBreakRegistration(deps.db, req.body);
      try { await runBreakRegistrationWorker(deps.db); } catch { /* The durable scheduler resumes the exact transaction. */ }
      res.json(await readBreakRegistration(deps.db, queued.id));
    } catch { res.status(400).json({ error: 'recourse_break_registration_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.post('/break-registrations/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await readBreakRegistration(deps.db, String(req.params.id))); }
    catch { res.status(404).json({ error: 'recourse_break_registration_unavailable' }); }
  });
  router.post('/break-restorations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await queueBreakRestoration(deps.db, req.body)); }
    catch { res.status(400).json({ error: 'recourse_break_restoration_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.post('/break-restorations/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await reconcileBreakRestoration(deps.db, String(req.params.id))); }
    catch (error) {
      if (error instanceof Error && error.message === 'recourse_authorization_not_finalized') {
        try { res.json(await readBreakRestoration(deps.db, String(req.params.id))); return; } catch { /* Preserve the generic unavailable response. */ }
      }
      res.status(404).json({ error: 'recourse_break_restoration_unavailable' });
    }
  });
  router.post('/break-restorations/:id/receipt', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'transactionHash'
        || !('transactionHash' in body) || typeof body.transactionHash !== 'string') throw Error('break_restoration_invalid');
      res.json(await confirmBreakRestoration(deps.db, String(req.params.id), body.transactionHash));
    } catch { res.status(400).json({ error: 'recourse_break_restoration_unconfirmed' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.use(authenticateOwner);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/recover-address', async (req, res) => {
    try {
      res.json(await recoverAuxiliaryOwnership(deps, await resolveOwner(req, deps), parseAuxiliaryRecoveryRequest(req.body)));
    } catch { res.status(400).json({ error: 'recourse_recovery_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.post('/membership-transitions', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'kind'
        || !('kind' in body) || (body.kind !== 'join' && body.kind !== 'leave' && body.kind !== 'renew')) throw Error('recourse_membership_input');
      res.json(await prepareMembershipTransition(deps.db, identityHash(owner.type, owner.id), { kind: body.kind }));
    } catch { res.status(400).json({ error: 'recourse_membership_unavailable' }); }
  });
  router.get('/membership-transitions', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), ownerIdentity = identityHash(owner.type, owner.id);
      const row = await deps.db.collection(RECOURSE_COLLECTIONS.owners).doc(ownerIdentity).get();
      const id: unknown = row.get('membershipTransition');
      if (id == null) { res.json(null); return; }
      if (typeof id !== 'string') throw Error('recourse_membership_unknown');
      res.json(await prepareMembershipTransition(deps.db, ownerIdentity, { id }));
    } catch { res.status(503).json({ error: 'recourse_membership_unavailable' }); }
  });
  router.get('/membership-transitions/:id', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      res.json(await prepareMembershipTransition(deps.db, identityHash(owner.type, owner.id), { id: String(req.params.id) }));
    } catch { res.status(404).json({ error: 'recourse_membership_unavailable' }); }
  });
  router.get('/membership-departures/:id', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      res.json(await prepareDepartureCredentials(deps.db,identityHash(owner.type,owner.id),String(req.params.id)));
    } catch { res.status(400).json({error:'recourse_departure_refused'}); }
  });
  router.post('/membership-departures/:id', async (req, res) => {
    try {
      const owner = await resolveOwner(req,deps), ownerIdentity = identityHash(owner.type,owner.id), id=String(req.params.id);
      await retainDepartureCredentials(deps.db,ownerIdentity,id,req.body);
      try { await advanceMembershipDeparture(deps.db,ownerIdentity,id); } catch { /* Retained revocation proofs remain retryable. */ }
      res.status(202).json({retained:true});
    } catch { res.status(400).json({error:'recourse_departure_refused'}); }
    finally { req.body=undefined;req.rawBody=undefined; }
  });
  router.post('/membership-consents', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'consent,domain,exitSecret,ownerSignature,standing,transitionId') throw Error('recourse_membership_input');
      const input = parseMembershipConsentRequest({ ...body, attestorSignature: 'standing' in body && body.standing ? '0x00' : null });
      const { attestorSignature: _unused, ...request } = input;
      const result = await queueMembershipConsent(deps.db, identityHash(owner.type, owner.id), request);
      try { await runMembershipConsentWorker(deps.db); } catch { /* Exact durable bytes remain queued for the scheduler. */ }
      res.status(202).json(result);
    } catch { res.status(400).json({ error: 'recourse_membership_consent_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.get('/membership-consents/:id', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), id = String(req.params.id);
      if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('recourse_membership_unknown');
      const row = await deps.db.collection(MEMBERSHIP_CONSENT_OPERATIONS).doc(id).get();
      const request = parseMembershipConsentRequest(row.get('request'));
      await ownedMembershipTransition(deps.db, identityHash(owner.type, owner.id), request.transitionId);
      res.json(await readSponsoredOperation(deps.db, MEMBERSHIP_CONSENT_OPERATIONS, id));
    } catch { res.status(404).json({ error: 'recourse_membership_unavailable' }); }
  });
  router.post('/membership-debit-challenges', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !['payer', 'amounts,payer'].includes(Object.keys(body).sort().join(',')) || !('payer' in body) || typeof body.payer !== 'string') throw Error('recourse_membership_input');
      res.json(await prepareMembershipDebit(deps.db, identityHash(owner.type, owner.id), body.payer,
        'amounts' in body ? parseMembershipPaymentSelection(body.amounts) : undefined));
    } catch { res.status(400).json({ error: 'recourse_membership_debit_unavailable' }); }
  });
  router.post('/membership-debits', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'debit,domain,reservationId') throw Error('recourse_membership_input');
      const { attestorSignature: _unused, ...input } = parseMembershipDebitRequest({ ...body, attestorSignature: '0x00' });
      const result = await queueMembershipDebit(deps.db, identityHash(owner.type, owner.id), input);
      try { await runMembershipDebitWorker(deps.db); } catch { /* Exact durable bytes remain queued for the scheduler. */ }
      res.status(202).json(result);
    } catch { res.status(400).json({ error: 'recourse_membership_debit_refused' }); }
    finally { req.body = undefined; req.rawBody = undefined; }
  });
  router.get('/membership-debits/:id', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), id = String(req.params.id);
      if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('recourse_membership_unknown');
      const row = await deps.db.collection(MEMBERSHIP_DEBIT_OPERATIONS).doc(id).get();
      const input = parseMembershipDebitRequest(row.get('request'));
      await ownedMembershipDebit(deps.db, identityHash(owner.type, owner.id), input.reservationId);
      res.json(await readSponsoredOperation(deps.db, MEMBERSHIP_DEBIT_OPERATIONS, id));
    } catch { res.status(404).json({ error: 'recourse_membership_debit_unavailable' }); }
  });
  router.post('/restoration-intents', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps), body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !['block,transactionHash', 'block,identity,transactionHash'].includes(Object.keys(body).sort().join(','))
        || !('transactionHash' in body) || typeof body.transactionHash !== 'string'
        || !('block' in body) || typeof body.block !== 'number') throw new Error('recourse_restoration_request_invalid');
      const identity = 'identity' in body ? await ownedBindingIdentity(deps.db, owner, body.identity) : await primaryBindingIdentity(deps.db, owner);
      res.json(await prepareRestorationRequest(deps.db, identity, { transactionHash: body.transactionHash, block: body.block }));
    } catch { res.status(400).json({ error: 'recourse_restoration_request_refused' }); }
  });
  router.post('/restoration-requests', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !['block,recoveryRequestId,restorationRequestId,transactionHash', 'block,identity,recoveryRequestId,restorationRequestId,transactionHash'].includes(Object.keys(body).sort().join(','))
        || !('transactionHash' in body) || typeof body.transactionHash !== 'string'
        || !('block' in body) || typeof body.block !== 'number'
        || !('recoveryRequestId' in body) || typeof body.recoveryRequestId !== 'string'
        || !('restorationRequestId' in body) || typeof body.restorationRequestId !== 'string') {
        res.status(400).json({ error: 'recourse_restoration_request_invalid' }); return;
      }
      const identity = 'identity' in body ? await ownedBindingIdentity(deps.db, owner, body.identity) : await primaryBindingIdentity(deps.db, owner);
      res.json(await submitRestorationRequest(deps.db, identity, {
        transactionHash: body.transactionHash, block: body.block, recoveryRequestId: body.recoveryRequestId, restorationRequestId: body.restorationRequestId,
      }));
    } catch { res.status(400).json({ error: 'recourse_restoration_request_refused' }); }
  });
  router.get('/restoration-requests', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const bindings = await deps.db.collection(RECOURSE_COLLECTIONS.identities).where('ownerIdentity', '==', identityHash(owner.type, owner.id)).get();
      const groups = await Promise.all(bindings.docs.map(async binding => {
        const identity = await ownedBindingIdentity(deps.db, owner, binding.id);
        const rows = await deps.db.collection(RESTORATION_REQUESTS).where('identity', '==', identity).get();
        return rows.docs.map(doc => ({ requestId: doc.id, identity, status: doc.get('status'),
          transactionHash: doc.get('transactionHash'), destination: doc.get('destination'), createdAtMs: doc.get('createdAtMs') }));
      }));
      res.json({ requests: groups.flat() });
    } catch { res.status(503).json({ error: 'recourse_unavailable' }); }
  });
  router.get('/pool', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const portfolio = await deps.db.collection(RECOURSE_COLLECTIONS.owners).doc(identityHash(owner.type, owner.id)).get();
      let identity: string;
      if (portfolio.get('primaryBinding') !== undefined) identity = await primaryBindingIdentity(deps.db, owner);
      else {
        const addresses = await deps.db.collection(RECOURSE_COLLECTIONS.addresses).where('ownerIdentity', '==', identityHash(owner.type, owner.id)).get();
        const bindings = addresses.docs.filter(row => row.get('chainBindingStatus') === 'confirmed')
          .map(row => String(row.get('identity'))).sort();
        identity = bindings.length ? await ownedBindingIdentity(deps.db, owner, bindings[0]) : `0x${'00'.repeat(32)}`;
      }
      const pool = await readRecoursePoolState(identity);
      const membership = await readPrivateMembershipView(deps.db, identityHash(owner.type, owner.id), pool);
      res.json({ ...pool, identity, membership });
    } catch { res.status(503).json({ error: 'recourse_unavailable' }); }
  });
  router.post('/binding-challenge', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || !('address' in body) || typeof body.address !== 'string'
        || !('signingRoot' in body) || typeof body.signingRoot !== 'string'
        || !('recoveryCommitment' in body) || typeof body.recoveryCommitment !== 'string') {
        res.status(400).json({ error: 'recourse_binding_invalid' }); return;
      }
      const deployment = await currentProtocolDeployment();
      const binding: OwnershipBinding = { identity: addressRecoveryBinding({ chainId: '8453', pointer: deployment.pointer.toLowerCase(), origin: body.address.toLowerCase() }),
        address: body.address.toLowerCase(), signingRoot: body.signingRoot.toLowerCase(), recoveryCommitment: body.recoveryCommitment.toLowerCase(),
        kernel: deployment.addresses.kernel.toLowerCase(), nonce: `0x${randomBytes(32).toString('hex')}`,
        expiresAtMs: Date.now() + 5 * 60_000 };
      const memberConsent = await prepareMemberBindingConsent(deps.db, identityHash(owner.type, owner.id), binding);
      res.json({ binding, message: ownershipBindingMessage(binding), memberConsent });
    } catch (error: unknown) {
      const code = error instanceof Error && /^recourse_[a-z_]+$/.test(error.message) ? error.message : 'recourse_unavailable';
      res.status(code === 'recourse_unavailable' ? 503 : 400).json({ error: code });
    }
  });
  router.post('/bind', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const body = req.body as { binding?: OwnershipBinding; signature?: unknown; memberConsent?: MemberBindingConsent } | undefined;
      if (!body?.binding || typeof body.signature !== 'string') {
        res.status(400).json({ error: 'recourse_binding_invalid' }); return;
      }
      // Canonical encoding rejects malformed fields before RPC or persistence.
      ownershipBindingMessage(body.binding);
      const deployment = await currentProtocolDeployment();
      if (body.binding.kernel !== deployment.addresses.kernel.toLowerCase()
        || body.binding.identity !== addressRecoveryBinding({ chainId: '8453', pointer: deployment.pointer.toLowerCase(), origin: body.binding.address })) {
        res.status(400).json({ error: 'recourse_binding_invalid' }); return;
      }
      const fence = await selectExternalProofFence();
      const chain = createRecourseChainPort();
      const admissionBlock = fence.observedHeadBlock;
      const admissionBlockHash = await chain.blockHash(admissionBlock);
      if (!admissionBlockHash) throw new Error('recourse_admission_unavailable');
      const balanceAtomic = await chain.balance(body.binding.kernel, body.binding.address, admissionBlockHash);
      await revalidateExternalProofFence(fence);
      if (await chain.blockHash(admissionBlock) !== admissionBlockHash) throw new Error('recourse_admission_reorg');
      const record = await registerOwnership(deps.db, { binding: body.binding, signature: body.signature,
        authenticatedIdentity: identityHash(owner.type, owner.id), owner, nowMs: Date.now(), fence,
        admissionBlock, admissionBlockHash, balanceAtomic });
      if (record.chainBindingStatus === 'confirmed') {
        res.json({ binding: record, operationId: record.bindingDigest }); return;
      }
      const operationId = await queueBindingOperation(deps.db, body.binding, body.signature, undefined, undefined, body.memberConsent);
      // Queue persistence precedes gas execution. A busy settlement signer is
      // resumed by the authenticated scheduler; no detached Cloud Run task.
      try { await runBindingWorker(deps.db); } catch { /* durable queued work remains */ }
      res.status(202).json({ binding: record, operationId });
    } catch (error: unknown) {
      const code = error instanceof Error && /^recourse_[a-z_]+$/.test(error.message) ? error.message : 'recourse_unavailable';
      res.status(code === 'recourse_unavailable' ? 503 : 400).json({ error: code });
    }
  });
  router.get('/ownership', async (req, res) => {
    try {
      const owner = await resolveOwner(req, deps);
      const portfolio = await deps.db.collection(RECOURSE_COLLECTIONS.owners).doc(identityHash(owner.type, owner.id)).get();
      const identity = portfolio.get('primaryBinding') === undefined ? null : await primaryBindingIdentity(deps.db, owner);
      const [identityRecord, addresses] = await Promise.all([
        identity === null ? null : deps.db.collection(RECOURSE_COLLECTIONS.identities).doc(identity).get(),
        deps.db.collection(RECOURSE_COLLECTIONS.addresses).where('ownerIdentity', '==', identityHash(owner.type, owner.id)).get(),
      ]);
      res.json({ identity, recoveryCommitment: identityRecord?.get('recoveryCommitment') ?? null,
        addresses: addresses.docs.map(doc => doc.data()) });
    } catch { res.status(503).json({ error: 'recourse_unavailable' }); }
  });
  return router;
}
