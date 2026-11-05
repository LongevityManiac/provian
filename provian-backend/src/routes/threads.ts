import {acknowledgeDelivery,type PendingDeliveryApproval} from '../core/commons/agent-delivery';
import {pollCommonsDelivery,refuseCommonsStream} from './commons-delivery';
/**
 * THREADS — bilateral Commons communication.
 *
 * Mounted at /v1/threads behind the Commons dual-auth shim (agent API key → req.agentWallet;
 * wallet auth → req.user; Commons session token). Every route is party-authenticated: a thread is
 * readable and writable ONLY by its two parties. Content is E2E ciphertext the relay stores and
 * never reads; the only fact a route verifies is an attached presentation (verify-at-submit).
 *
 * PUT /keys publish my x25519 message key
 * GET /keys/:partyId read a party's message key (any authenticated wallet)
 * POST / open a thread (anchor + first message)
 * GET / my threads (+ unread); an agent caller also gets `reply_policy`
 * GET /unread my unread threads (the attention center read)
 * GET /:threadId the thread (party only)
 * GET /:threadId/messages messages (party only; ?limit&before&before_id)
 * POST /:threadId/messages post a TEXT message (seals a `commons_thread_message` PE);
 * a presentation request / presentation / deliverable is
 * relay-originated only and refused here with 400
 * POST /:threadId/read advance my read cursor
 * GET /:threadId/presentation-requests
 * POST /:threadId/presentation-requests request the other party to present
 * POST /:threadId/presentation-requests/:id/present present (verify-at-submit)
 */

import { canonicalPeAnchorReadContract } from '../core/presentation/anchor-contract';
import { Router, type Request, type Response } from 'express';
import { requireAuth } from './middleware/commons-auth';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/agent-bank/errors';
import { RailHandshakeError } from '../core/rail/handshake';
import { SpeechWindowRequiredError, partyRefOf } from '../core/commons/speech-window';
import { publishMessageKey, readMessageKey } from '../core/commons/message-keys';
import {
  getThread,
  getThreadView,
  listMessages,
  listThreadPresentationRequests,
  listThreads,
  pendingThreadPresentationRequestsFor,
  markRead,
  openThread,
  postMessage,
  presentInThread,
  requestPresentationInThread,
  unreadThreadsFor,
  type ThreadActor,
} from '../core/commons/threads';
import { toPartyFacingRequest } from '../core/pe/presentation-request';
import { readAgentReplyPolicy, type AgentReplyPolicy } from '../core/commons/reply-policy';
import { loadCommerceAttestationKeys } from '../core/presentation/jws-key-material';

function handleError(res: Response, error: unknown): void {
  if (error instanceof SpeechWindowRequiredError) {
    res.status(error.status).json({ error: error.message, reason: error.reason, present_to: error.presentTo });
  } else if (error instanceof RailHandshakeError) {
    res.status(error.status).json({ error: error.message, reason: error.reason });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[Threads] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function createThreadsRouter(deps: AgentBankDeps): Router {
  const { cache } = deps;
  const router = Router();

  const actorOf = (auth: { walletId: string; agentId: string; actorAddress: string | null; isAgent: boolean }): ThreadActor => ({
    walletId: auth.walletId, agentId: auth.agentId, actorAddress: auth.actorAddress, isAgent: auth.isAgent,
  });

  // item 4: an agent reading its mail is told its owner's reply policy, which it follows.
  // Only an agent caller; a person's reads carry nothing new.
  const replyPolicyFor = async (auth: { walletId: string; isAgent: boolean }): Promise<{ reply_policy?: AgentReplyPolicy }> => {
    if (!auth.isAgent) return {};
    const policy = await readAgentReplyPolicy(deps.db, auth.walletId);
    return policy ? { reply_policy: policy } : {};
  };

  const rateLimited = async (res: Response, key: string, limit: number, windowSec: number): Promise<boolean> => {
    const rl = await cache.checkRateLimit(key, limit, windowSec);
    if (!rl.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter });
      return true;
    }
    return false;
  };

  router.post('/events/poll', (req: Request, res: Response) => { void pollCommonsDelivery(req, res, deps); });
  router.get('/events', refuseCommonsStream);
  router.post('/events', refuseCommonsStream);

  router.post('/events/ack', async (req: Request, res: Response) => {
    try {
      if (!req.agentWallet) { res.status(403).json({ error: 'Agent API credentials required' }); return; }
      const pending: unknown = req.body?.pending;
      const resolved: unknown = req.body?.resolved_approval_id;
      if (!Number.isSafeInteger(req.body?.sequence) || pending !== undefined && (!pending || typeof pending !== 'object'
        || typeof (pending as Record<string,unknown>).approval_id !== 'string' || typeof (pending as Record<string,unknown>).message_id !== 'string'
        || typeof (pending as Record<string,unknown>).thread_id !== 'string' || !Number.isSafeInteger((pending as Record<string,unknown>).sequence))
        || resolved !== undefined && (typeof resolved !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(resolved))) throw new ValidationError('Invalid acknowledgment');
      if (pending) {
        const value = pending as PendingDeliveryApproval;
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(value.approval_id) || !/^msg_[a-f0-9]{24}$/.test(value.message_id)) throw new ValidationError('Invalid pending approval');
        const [request,message] = await Promise.all([deps.db.collection('human_approval_requests_v1').doc(value.approval_id).get(),deps.db.collection('commons_thread_messages').doc(value.message_id).get()]);
        const r=request.data(),m=message.data();
        if (!r || r.agent_wallet_id!==req.agentWallet.id || !m || m.pe_id!==r.subject_pe_id || m.thread_id!==value.thread_id || value.sequence!==req.body.sequence) throw new ForbiddenError('Approval is not bound to your message');
        await getThread(deps,value.thread_id,req.agentWallet.id);
      }
      await acknowledgeDelivery(deps.db, req.agentWallet.id, req.body.sequence, pending as PendingDeliveryApproval|undefined, resolved as string|undefined);
      res.json({ acknowledged: true });
    } catch (error) { handleError(res, error); }
  });

  // Exact message lookup for notification consumers: no encrypted history query.
  router.get('/events/messages/:messageId', async (req: Request, res: Response) => {
    try {
      if (!req.agentWallet) { res.status(403).json({ error: 'Agent API credentials required' }); return; }
      if (!/^msg_[a-f0-9]{24}$/.test(req.params.messageId)) throw new ValidationError('Invalid message id');
      const snapshot = await deps.db.collection('commons_thread_messages').doc(req.params.messageId).get();
      const message = snapshot.data();
      if (!message || typeof message.thread_id !== 'string') throw new NotFoundError('Message not found');
      const thread = await getThread(deps, message.thread_id, req.agentWallet.id);
      const policy = await replyPolicyFor({ walletId: req.agentWallet.id, isAgent: true });
      let approval: Record<string,unknown> | undefined;
      if (req.query.approval_id !== undefined) {
        if (typeof req.query.approval_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(req.query.approval_id)) throw new ValidationError('Invalid approval id');
        const request = await deps.db.collection('human_approval_requests_v1').doc(req.query.approval_id).get();
        approval=request.data();
        if (!approval || approval.agent_wallet_id !== req.agentWallet.id || approval.subject_pe_id !== message.pe_id) throw new ForbiddenError('Approval is not yours');
      } else if (policy.reply_policy?.mode === 'ask_me_first' && message.author_id !== policy.reply_policy.linked_human) {
        const approvals = await deps.db.collection('human_approval_requests_v1').where('agent_wallet_id', '==', req.agentWallet.id).where('subject_pe_id', '==', message.pe_id).orderBy('created_at_ms','desc').limit(1).get();
        approval=approvals.docs[0]?.data();
      }
      res.json({ thread, messages: [message], ...policy,
        ...(approval ? { approval: { request_id: approval.request_id, status: approval.status, decision: approval.decision, expires_at_ms: approval.expires_at_ms } } : {}) });
    } catch (error) { handleError(res, error); }
  });

  // ─── Message keys ───────────────────────────────────────────────────────

  router.put('/keys', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const record = await publishMessageKey(deps.db, partyRefOf(auth), req.body?.pubkey, Date.now());
      res.json({ key: record });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/keys/:partyId', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const record = await readMessageKey(deps.db, req.params.partyId);
      if (!record) {
        res.status(404).json({ error: 'No message key published for this party' });
        return;
      }
      res.json({ key: record });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Threads ────────────────────────────────────────────────────────────

  router.post('/', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      if (await rateLimited(res, `rl:threads:open:${auth.walletId}`, 20, 60)) return;
      const result = await openThread(deps, actorOf(auth), {
        anchor: req.body?.anchor,
        counterparty: req.body?.counterparty ?? null,
        message: req.body?.message ?? {},
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const threads = await listThreads(deps, auth.walletId);
      res.json({ threads, count: threads.length, ...(await replyPolicyFor(auth)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/unread', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const threads = await unreadThreadsFor(deps, auth.walletId);
      res.json({ threads, count: threads.length, ...(await replyPolicyFor(auth)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // (item 9, the bell): the thread presentation requests waiting on ME to present, across
  // every thread. Registered before `/:threadId` so the literal path is never read as a thread id.
  router.get('/presentation-requests/pending', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const requests = await pendingThreadPresentationRequestsFor(deps, auth.walletId, Date.now());
      res.json({ requests: requests.map((r) => toPartyFacingRequest(r, auth.walletId)), count: requests.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/:threadId', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const thread = await getThreadView(deps, req.params.threadId, auth.walletId);
      res.json({ thread });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/:threadId/messages', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const thread = await getThreadView(deps, req.params.threadId, auth.walletId);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined;
      const beforeId = typeof req.query.before_id === 'string' ? req.query.before_id : undefined;
      if (beforeId && (!before || !/^[A-Za-z0-9_-]+$/.test(beforeId))) throw new ValidationError('before_id requires before and a valid message id');
      const messages = await listMessages(deps, thread, { limit, before, beforeId });
      // The caller's own read cursor, so a reader can page back to it and mark read only what it was shown.
      res.json({ thread, messages, count: messages.length, reader_id: auth.walletId, read_cursor: thread.read_cursors?.[auth.walletId] ?? 0, ...(await replyPolicyFor(auth)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/:threadId/messages', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      if (await rateLimited(res, `rl:threads:msg:${auth.walletId}`, 60, 60)) return;
      const thread = await getThread(deps, req.params.threadId, auth.walletId);
      const message = await postMessage(deps, actorOf(auth), thread, req.body ?? {});
      res.status(201).json({ message });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/:threadId/read', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const thread = await getThread(deps, req.params.threadId, auth.walletId);
      const upTo = req.body?.up_to;
      if (upTo !== undefined && typeof upTo !== 'number') throw new ValidationError('up_to must be a number (unix ms)');
      await markRead(deps, thread, auth.walletId, Date.now(), upTo);
      res.json({ read: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ─── Presentations inside a thread ──────────────────────────────────────

  router.get('/:threadId/presentation-requests', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const thread = await getThread(deps, req.params.threadId, auth.walletId);
      const requests = await listThreadPresentationRequests(deps, thread, auth.walletId);
      res.json({ requests: requests.map((r) => toPartyFacingRequest(r, auth.walletId)), count: requests.length });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/:threadId/presentation-requests', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      if (await rateLimited(res, `rl:threads:preq:${auth.walletId}`, 10, 60)) return;
      const thread = await getThread(deps, req.params.threadId, auth.walletId);
      const result = await requestPresentationInThread(deps, actorOf(auth), thread, req.body ?? {});
      res.status(201).json({ request: toPartyFacingRequest(result.request, auth.walletId), message: result.message });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/:threadId/presentation-requests/:requestId/present', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req, res, deps);
      if (!auth) return;
      const thread = await getThread(deps, req.params.threadId, auth.walletId);
      const material = loadCommerceAttestationKeys(process.env);
      const result = await presentInThread(deps, actorOf(auth), thread, req.params.requestId, req.body ?? {}, {
        publicKeys: material.ok ? material.keys : [],
        // item 3: pe_fact verifies against the canonical PEAnchor, as the public route does.
        peAnchorContract: canonicalPeAnchorReadContract(),
      });
      res.json({ request: toPartyFacingRequest(result.request, auth.walletId), message: result.message });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
