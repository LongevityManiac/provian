import type { RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { assertRecoursePrivateAccess, verifyRecoursePrivateAccess } from '../../core/recourse/private-access';
import { parseRecoveryOwnerOperation } from '../../core/recourse/owner-operation';
import { OWNER_OPERATIONS } from '../../core/recourse/owner-operation-queue';
import { parseAccountDeploymentRequest } from '../../core/recourse/break-deployment-data';
import { BREAK_DEPLOYMENTS } from '../../core/recourse/break-deployment-queue';
import { parseBreakRegistration } from '../../core/recourse/break-registration-data';
import { BREAK_REGISTRATIONS } from '../../core/recourse/break-registration';
import { breakRestorationDetails, parseBreakRestorationRequest } from '../../core/recourse/break-restoration-data';
import { BREAK_RESTORATIONS } from '../../core/recourse/break-restoration-queue';

const privatePrefix = /^\/(?:owner-operations|owner-recovery-state|restoration-history|break-entitlements|break-recovery-state|break-deployments|break-registrations|break-restorations)(?:\/|$)/i;

/** Bind ID-based requests to the stored target, never to the caller's own
 * assertion of its owner. No worker or chain reconciliation runs before this. */
async function targetIdentity(db: Firestore, path: string, request: unknown): Promise<string> {
  const restorationHistory = /^restoration-history\/(0x[0-9a-f]{64})$/.exec(path);
  if (restorationHistory && request === null) return restorationHistory[1];
  const ownerDiscovery = /^owner-recovery-state\/(0x[0-9a-f]{64})\/(0|[1-9][0-9]*)$/.exec(path);
  if (ownerDiscovery && request === null) return ownerDiscovery[1];
  if (path === 'owner-operations/recovery') return parseRecoveryOwnerOperation(request).identity;
  if (path === 'break-deployments') return parseAccountDeploymentRequest(request).identity;
  if (path === 'break-registrations') return parseBreakRegistration(request).deployment.identity;
  if (path === 'break-restorations') return breakRestorationDetails(parseBreakRestorationRequest(request)).identity;
  const discovery = /^break-(?:entitlements|recovery-state)\/0x[0-9a-f]{40}\/(0x[0-9a-f]{64})$/.exec(path);
  if (discovery && request === null) return discovery[1];
  const operation = /^(owner-operations|break-deployments|break-registrations|break-restorations)\/(0x[0-9a-f]{64})(\/receipt)?$/.exec(path);
  if (!operation || (operation[3] ? operation[1] !== 'break-restorations' : request !== null)) throw Error('recourse_private_access_refused');
  const collections: Record<string, string> = { 'owner-operations': OWNER_OPERATIONS,
    'break-deployments': BREAK_DEPLOYMENTS, 'break-registrations': BREAK_REGISTRATIONS, 'break-restorations': BREAK_RESTORATIONS };
  const row = await db.collection(collections[operation[1]]).doc(operation[2]).get();
  if (!row.exists) throw Error('recourse_private_access_refused');
  if (operation[1] === 'owner-operations') return parseRecoveryOwnerOperation(row.get('operation')).identity;
  if (operation[1] === 'break-deployments') return parseAccountDeploymentRequest(row.get('request')).identity;
  if (operation[1] === 'break-registrations') return parseBreakRegistration(row.get('request')).deployment.identity;
  const identity: unknown = row.get('identity');
  if (typeof identity !== 'string' || !/^0x[0-9a-f]{64}$/.test(identity)) throw Error('recourse_private_access_refused');
  return identity;
}

/** Recovery discovery uses an independent hash credential, not a possibly lost
 * login or the recovery preimage alone. Credentials never appear in a URL. */
export function authenticatePrivateRecourse(db: Firestore): RequestHandler {
  return async (req, res, next) => {
    if (!privatePrefix.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.once('finish', () => { req.body = undefined; req.rawBody = undefined; });
    try {
      const envelope: unknown = req.body;
      req.body = undefined; req.rawBody = undefined;
      if (req.method !== 'POST' || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || Object.keys(envelope).sort().join(',') !== 'authorization,request'
        || !('authorization' in envelope) || !('request' in envelope)) throw Error('recourse_private_access_refused');
      const path = req.path.slice(1), request: unknown = envelope.request;
      const access = await verifyRecoursePrivateAccess(db, { authorization: envelope.authorization, path, request, nowMs: Date.now() });
      const identity = await targetIdentity(db, path, request);
      assertRecoursePrivateAccess(access, { identity, path, request });
      req.body = request;
      next();
    } catch {
      req.body = undefined; req.rawBody = undefined;
      res.status(404).json({ error: 'recourse_private_unavailable' });
    }
  };
}
