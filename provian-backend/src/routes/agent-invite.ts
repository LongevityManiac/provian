/**
 * Agent Invite Router - Human invitations from agents, link requests, fleet codes
 *
 * Endpoints:
 * POST /:wallet_id/invite - Send invite email (API key auth, 5/day per wallet)
 * POST /:wallet_id/invite-human - Beneficiary invite email (API key auth, 3/day)
 * POST /:wallet_id/request-link - File a link request with a connection code; a
 * fleet code links directly
 * POST /:wallet_id/fleet-code - Any linked agent mints a one-hour, single-use
 * code that links another of its human's agents
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import type { RouterDeps, AgentInviteDocument, AgentWalletDocument } from '../core/agent-wallet/types';
import { sendAgentInvite, sendBeneficiaryInvite } from '../email';
import { isEmailSuppressed, signUnsubscribeToken } from '../core/email/suppression';
import { generatePE as generatePEAtomic } from '../core/agent-bank/pe-utils';
import { countVisibleAgentPEs } from '../core/agent-wallet/agent-pe-activity';
import { sendPushToUser } from '../core/notifications/pushDispatcher';
import {
  FLEET_CODE_HOURLY_LIMIT,
  consumeFleetCodeTransactional,
  agentHasLinkHistory,
  connectionTokenRef,
  fleetInviteId,
  isConnectionTokenExpired,
  isFleetIssuerLinked,
  mintFleetCode,
  resolveConnectionTokenRecord,
  type ConnectionTokenRecord,
} from '../core/agent-wallet/fleet-code';
import { bindAgentToHuman, BeneficiaryLinkConflictError } from '../core/agent-wallet/link-human-binding';
import { DEFAULT_AGENT_BENEFICIARY_SHARE_BPS } from '../core/agent-wallet/beneficiary-relationship';
import { buildAgentInstallLines } from '../core/agent-bootstrap-script';
import { resolveRelayUrl } from '../core/setup-command';
import { recordInviteAcceptedPE } from './agent-wallet';

/** The plain sentence an expired code gets at request-link. /create never reads expiry. */
const EXPIRED_CODE_HINT = 'This link code has expired (codes last one hour). Ask for a fresh code — from the Provian app under "Connect an agent", or from any of your linked agents (`fleet-code`) — and run the install line again; it picks up the same wallet.';

/**
 * Best-effort push to the human when a fleet code linked one of their agents, so
 * the new agent appears in the app without anyone opening a request. The app
 * already routes `agent_linked` to the Agent Hub (NotificationService). Never throws.
 */
async function pushFleetLinkToHuman(
  db: RouterDeps['db'],
  humanUserId: string,
  linked: { inviteId: string; agentWalletId: string; agentName: string; issuerName: string },
): Promise<void> {
  try {
    await sendPushToUser(db, humanUserId, {
      title: 'Agent linked',
      body: `${linked.agentName} is now linked to your wallet — onboarded by ${linked.issuerName}.`,
      data: {
        type: 'agent_linked',
        invite_id: linked.inviteId,
        agent_wallet_id: linked.agentWalletId,
        agent_name: linked.agentName,
        linked_via: 'fleet_code',
      },
      priority: 'high',
    });
  } catch (err) {
    console.error('[AgentInvite] fleet-link push failed (non-fatal):', err);
  }
}

/**
 * Send a marketing invite ONLY when a working unsubscribe can accompany it and
 * the recipient has not opted out (audit 2026-08-05, finding 17). Returns false
 * without sending in either case; the invite RECORD is unaffected. Fail-closed:
 * an unconfigured UNSUBSCRIBE_TOKEN_SECRET yields a null token and no send.
 */
async function sendMarketingEmailGuarded(
  db: RouterDeps['db'],
  email: string,
  send: (unsubscribeToken: string) => Promise<boolean>,
  context: string,
): Promise<void> {
  const token = signUnsubscribeToken(email);
  if (!token) {
    console.warn(`[AgentInvite] ${context}: email skipped — unsubscribe not configured (no invite email before a working unsubscribe exists)`);
    return;
  }
  try {
    if (await isEmailSuppressed(db, email)) {
      console.warn(`[AgentInvite] ${context}: email skipped — recipient is on the suppression list`);
      return;
    }
  } catch (err) {
    // Fail closed on a suppression-read error: do not risk emailing an opted-out
    // address because Firestore hiccuped.
    console.error(`[AgentInvite] ${context}: suppression check failed, skipping send:`, err);
    return;
  }
  await send(token).catch(() => {});
}

/**
 * Best-effort push to the human a connection-code link request is addressed to. Never throws:
 * the request is durable before this runs, and the app also discovers it by polling
 * GET /v1/agent/wallet/link-requests. The payload carries only what the app needs to open the
 * request (`invite_id`, `agent_wallet_id`) and the agent's display name.
 */
export async function pushLinkRequestToHuman(
  db: RouterDeps['db'],
  humanUserId: string,
  request: { inviteId: string; agentWalletId: string; agentName: string },
): Promise<void> {
  try {
    await sendPushToUser(db, humanUserId, {
      title: 'Agent link request',
      body: `${request.agentName} asked to link to your wallet. Tap to review.`,
      data: {
        type: 'agent_link_request',
        invite_id: request.inviteId,
        agent_wallet_id: request.agentWalletId,
        agent_name: request.agentName,
      },
      priority: 'high',
    });
  } catch (err) {
    console.error('[AgentInvite] link-request push failed (non-fatal):', err);
  }
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DAILY_INVITE_LIMIT = 5;

export function createAgentInviteRouter(deps: RouterDeps): Router {
  const { db, cache, peBuffer, recordPEAccrual } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // =========================================================================
  // POST /:wallet_id/invite - Send invite (API key auth, 5/day limit)
  // =========================================================================
  router.post('/:wallet_id/invite', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const { email } = req.body as { email?: string };

      // Validate email
      if (!email || typeof email !== 'string') {
        res.status(400).json({ error: 'email is required' });
        return;
      }
      // Basic email format check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Invalid email format' });
        return;
      }

      // Rate limit: 5 invites per day per wallet (Redis)
      const rateLimitResult = await cache.checkRateLimit(
        `rl:invite:${wallet_id}`, DAILY_INVITE_LIMIT, 86400,
      );
      if (!rateLimitResult.allowed) {
        res.status(429).json({
          error: `Invite limit reached. Max ${DAILY_INVITE_LIMIT} invites per day.`,
          retry_after: rateLimitResult.retryAfter,
        });
        return;
      }

      // Check for duplicate invite (same wallet + email, not expired)
      const existingInvite = await db
        .collection('agent_invites')
        .where('agent_wallet_id', '==', wallet_id)
        .where('email', '==', email)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      if (!existingInvite.empty) {
        const existing = existingInvite.docs[0].data() as AgentInviteDocument;
        if (existing.expires_at > Date.now()) {
          res.status(409).json({ error: 'An active invite already exists for this email' });
          return;
        }
      }

      const now = Date.now();
      const inviteId = `inv_${uuidv4()}`;

      const inviteDoc: AgentInviteDocument = {
        id: inviteId,
        agent_wallet_id: wallet_id,
        agent_display_name: wallet.display_name,
        email,
        status: 'pending',
        created_at: now,
        expires_at: now + INVITE_EXPIRY_MS,
      };

      // Store invite doc + send email via Resend
      await db.collection('agent_invites').doc(inviteId).set(inviteDoc);

      void sendMarketingEmailGuarded(
        db,
        email,
        (unsubToken) => sendAgentInvite(email, wallet.display_name, inviteId, unsubToken, wallet_id, req.body?.language),
        `agent_invite ${inviteId}`,
      );

      // PE for invite via atomic helper (H-3 fix).
      await generatePEAtomic(deps, {
        walletId: wallet_id,
        agentId: wallet.agent_id,
        actorAddress: wallet.address,
        actionType: 'agent_invite_sent',
        metadata: {
          invite_id: inviteId,
          // Do not store email in PE - privacy
          email_hash: crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16),
        },
      });

      res.status(201).json({
        invite_id: inviteId,
        email,
        status: 'pending',
        expires_at: new Date(now + INVITE_EXPIRY_MS).toISOString(),
      });

    } catch (error) {
      console.error('[AgentInvite] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/invite-human - Enhanced beneficiary invite (API key auth)
  // =========================================================================
  const BENEFICIARY_INVITE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const DAILY_BENEFICIARY_INVITE_LIMIT = 3;

  router.post('/:wallet_id/invite-human', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const { human_email, message: personalMessage } = req.body as {
        human_email?: string;
        message?: string;
      };

      if (!human_email || typeof human_email !== 'string') {
        res.status(400).json({ error: 'human_email is required' });
        return;
      }
      // live visible-PE count, never a stored per-wallet tally.
      const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(human_email)) {
        res.status(400).json({ error: 'Invalid email format' });
        return;
      }
      if (personalMessage && typeof personalMessage === 'string' && personalMessage.length > 500) {
        res.status(400).json({ error: 'Message must be under 500 characters' });
        return;
      }
      // F53/F56: reject markup at the source. This message is interpolated into a
      // Provian-branded, DKIM-signed email; the template also HTML-escapes it, but
      // rejecting `<`/`>` here refuses the phishing payload before it is ever
      // stored or sent.
      if (typeof personalMessage === 'string' && /[<>]/.test(personalMessage)) {
        res.status(400).json({ error: 'Message must not contain markup characters (< or >)' });
        return;
      }

      // Rate limit: 3/day per wallet
      const rateLimitResult = await cache.checkRateLimit(
        `rl:invite-human:${wallet_id}`, DAILY_BENEFICIARY_INVITE_LIMIT, 86400,
      );
      if (!rateLimitResult.allowed) {
        res.status(429).json({
          error: `Beneficiary invite limit reached. Max ${DAILY_BENEFICIARY_INVITE_LIMIT} per day.`,
          retry_after: rateLimitResult.retryAfter,
        });
        return;
      }

      // Rate limit: 1 per email per 7 days
      const emailLimitResult = await cache.checkRateLimit(
        `rl:invite-human-email:${crypto.createHash('sha256').update(human_email.toLowerCase()).digest('hex').slice(0, 16)}`,
        1, 7 * 86400,
      );
      if (!emailLimitResult.allowed) {
        res.status(429).json({
          error: 'This email was recently invited. Try again later.',
          retry_after: emailLimitResult.retryAfter,
        });
        return;
      }

      // Beneficiary changes are prospective record-time boundaries. Prior PEs
      // already carry immutable recipient/split snapshots, so an invite cannot
      // copy any existing aggregate estimate into a second wallet. Keep the
      // compatibility field explicitly zero until clients remove it.
      const signingBonusPVT = 0;

      const now = Date.now();
      const inviteId = `inv_${uuidv4()}`;

      const inviteDoc: AgentInviteDocument = {
        id: inviteId,
        agent_wallet_id: wallet_id,
        agent_display_name: wallet.display_name,
        email: human_email,
        status: 'pending',
        created_at: now,
        expires_at: now + BENEFICIARY_INVITE_EXPIRY_MS,
        invite_type: 'beneficiary',
        signing_bonus_pvt: signingBonusPVT,
        agent_pe_count: livePeCount,
      };

      await db.collection('agent_invites').doc(inviteId).set(inviteDoc);

      // Send enhanced email (fire-and-forget, unsubscribe-guarded)
      void sendMarketingEmailGuarded(
        db,
        human_email,
        (unsubToken) => sendBeneficiaryInvite(
          human_email,
          wallet.display_name,
          inviteId,
          wallet_id,
          signingBonusPVT,
          livePeCount,
          unsubToken,
          personalMessage,
          req.body?.language,
        ),
        `beneficiary_invite ${inviteId}`,
      );

      // PE for invite via atomic helper (H-3 fix).
      await generatePEAtomic(deps, {
        walletId: wallet_id,
        agentId: wallet.agent_id,
        actorAddress: wallet.address,
        actionType: 'agent_invite_sent',
        metadata: {
          invite_id: inviteId,
          invite_type: 'beneficiary',
          email_hash: crypto.createHash('sha256').update(human_email.toLowerCase()).digest('hex').slice(0, 16),
          signing_bonus_pvt: signingBonusPVT,
        },
      });

      res.status(201).json({
        invite_id: inviteId,
        status: 'sent',
        signing_bonus_pvt: signingBonusPVT,
        agent_pe_count: livePeCount,
        expires_at: now + BENEFICIARY_INVITE_EXPIRY_MS,
      });

    } catch (error) {
      console.error('[AgentInvite] Beneficiary invite error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/request-link - Connection-code-driven link REQUEST
  //
  // Closes the onboarding gap: a brand-new UNLINKED agent, holding the
  // connection code its human handed it, asks to be linked to that human. The
  // human then AUTHORIZES the link in-app via the existing accept-invite anchor
  // (wallet auth + biometric + bindAgentToHuman).
  //
  // BOUNDARY (must not weaken): with a HUMAN code this creates a REQUEST, never
  // a bind. It writes no relationship, moves no economics, and calls no bind. It
  // only records which human issued the code (read-only lookup — a human code
  // stays multi-use for link requests) so the human can DISCOVER the request
  // in-app. The human is the security anchor: only they, proving their wallet,
  // may accept.
  //
  // THE ONE EXCEPTION — a FLEET code : the human's own link to
  // the issuing agent is the authority. A live, unconsumed fleet code links THIS
  // agent to the code's human directly — single-use (transactionally consumed),
  // only for a NEW agent with no link history at all (agentHasLinkHistory:
  // never linked, never unlinked; a consumed code binds nothing again, it only
  // finishes a link that is still live), only to that same human, only while the
  // issuing agent is still active and linked to them — through the SAME
  // bindAgentToHuman path and the SAME invite_accepted PE the Accept uses.
  //
  // EXPIRY : every code, human or fleet, is refused here once past its
  // expires_at (410 connection_token_expired). /create never checks expiry —
  // wallet creation has no containment. The hosted install script asks
  // GET /v1/bootstrap/agent/code first, so a dead code stops before it writes.
  // =========================================================================
  router.post('/:wallet_id/request-link', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const { connection_token } = req.body as { connection_token?: string };
      if (!connection_token || typeof connection_token !== 'string') {
        res.status(400).json({ error: 'connection_token is required' });
        return;
      }

      // live visible-PE count, never a stored per-wallet tally.
      const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);

      // Read-only resolution of the code: who issued it, its kind, expiry and (for a
      // fleet code) its single-use state. Nothing is burned by this read.
      const record = await resolveConnectionTokenRecord(deps, connection_token);
      if (!record) {
        res.status(404).json({
          error: 'connection_token_issuer_unresolved',
          hint: 'The connection code is unknown. Ask your human to generate a fresh code in the app.',
        });
        return;
      }
      const issuerUserId = record.issuerUserId;

      if (record.kind === 'fleet') {
        // The issuing (main) agent is the code's authority, never its subject.
        if (record.issuedByAgentWalletId === wallet_id) {
          res.status(409).json({
            error: 'fleet_code_issuer_cannot_link_itself',
            hint: 'A fleet code links another of your human\'s agents. Hand it to that agent; it runs the install line on its own machine.',
          });
          return;
        }
        // This agent already consumed this code (a retry), whatever the clock says:
        //   - the link stands (linked to this code's human now) → finish the
        //     bookkeeping (e.g. after the invite_accepted PE failed);
        //   - the consume committed but its BIND did not (review 2 #5: the bind
        //     threw) → the same agent's retry completes the bind, still subject
        //     to the never-linked checks (here, and again inside the bind's
        //     transaction);
        //   - the code already bound and that link has since ended → refused: a
        //     bound code binds nothing again, and a link the human ended is
        //     re-made only by the human.
        if (record.used && record.usedByWalletId === wallet_id) {
          const fresh = await db.collection('agent_wallets').doc(wallet_id).get();
          const current = fresh.exists ? fresh.data() as AgentWalletDocument : null;
          if (current && current.linked_human_user_id === issuerUserId) {
            await linkViaFleetCode(res, wallet, connection_token, record, livePeCount);
            return;
          }
          if (current && current.linked_human_user_id) {
            res.status(409).json({ error: 'agent_already_linked' });
            return;
          }
          if (!current || record.bindCompleted || await agentHasLinkHistory(db, wallet_id)) {
            res.status(409).json({
              error: 'connection_token_already_used',
              hint: 'This fleet code was already used. A link your human ended is re-made only by your human, in the app.',
            });
            return;
          }
          await linkViaFleetCode(res, wallet, connection_token, record, livePeCount);
          return;
        }
      }

      // BOUNDARY: never request a link for an already-linked agent. Same human →
      // idempotent no-op; different human → conflict (an agent has one human).
      if (wallet.linked_human_user_id) {
        if (wallet.linked_human_user_id === issuerUserId) {
          res.status(200).json({ status: 'already_linked' });
          return;
        }
        res.status(409).json({ error: 'agent_already_linked' });
        return;
      }

      // "Link codes expire in an hour" — enforced here, for every code.
      if (isConnectionTokenExpired(record, Date.now())) {
        res.status(410).json({ error: 'connection_token_expired', hint: EXPIRED_CODE_HINT });
        return;
      }

      if (record.kind === 'fleet') {
        // A fleet code reaches only a NEW, never-linked agent :
        // any durable link history — including a link the human ended — is
        // refused before the code is touched.
        if (await agentHasLinkHistory(db, wallet_id)) {
          res.status(409).json({
            error: 'fleet_code_requires_new_agent',
            hint: 'A fleet code links only a new agent that has never been linked. To link this agent, your human accepts its request in the app.',
          });
          return;
        }
        await linkViaFleetCode(res, wallet, connection_token, record, livePeCount);
        return;
      }

      // Idempotency: reuse a live pending request to the same human rather than
      // stacking duplicates (a re-run of connect-agent must not spam requests).
      const existing = await db.collection('agent_invites')
        .where('agent_wallet_id', '==', wallet_id)
        .where('for_human_user_id', '==', issuerUserId)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!existing.empty) {
        const ex = existing.docs[0].data() as AgentInviteDocument;
        if ((ex.expires_at ?? 0) > Date.now()) {
          res.status(200).json({ request_id: ex.id, status: 'pending', reused: true, expires_at: ex.expires_at });
          return;
        }
      }

      // Rate limit: 3/day per wallet (mirrors invite-human).
      const rateLimitResult = await cache.checkRateLimit(
        `rl:request-link:${wallet_id}`, DAILY_BENEFICIARY_INVITE_LIMIT, 86400,
      );
      if (!rateLimitResult.allowed) {
        res.status(429).json({
          error: `Link-request limit reached. Max ${DAILY_BENEFICIARY_INVITE_LIMIT} per day.`,
          retry_after: rateLimitResult.retryAfter,
        });
        return;
      }

      const now = Date.now();
      const inviteId = `inv_${uuidv4()}`;
      const inviteDoc: AgentInviteDocument = {
        id: inviteId,
        agent_wallet_id: wallet_id,
        agent_display_name: wallet.display_name,
        // No email: this request is delivered by in-app discovery, not email.
        status: 'pending',
        created_at: now,
        expires_at: now + BENEFICIARY_INVITE_EXPIRY_MS,
        invite_type: 'beneficiary',
        signing_bonus_pvt: 0,
        agent_pe_count: livePeCount,
        for_human_user_id: issuerUserId,
        origin: 'connection_token',
      };
      await db.collection('agent_invites').doc(inviteId).set(inviteDoc);

      // Record-only PE, same as the other invite paths.
      await generatePEAtomic(deps, {
        walletId: wallet_id,
        agentId: wallet.agent_id,
        actorAddress: wallet.address,
        actionType: 'agent_invite_sent',
        metadata: {
          invite_id: inviteId,
          invite_type: 'beneficiary',
          origin: 'connection_token',
        },
      });

      // Item 4: tell the human a request is waiting. The app already handles
      // `agent_link_request` (a tap opens LinkAccept for this invite) and polls
      // GET /link-requests for its attention bell, so this is best-effort: a
      // push failure never fails the request.
      await pushLinkRequestToHuman(db, issuerUserId, {
        inviteId,
        agentWalletId: wallet_id,
        agentName: wallet.display_name,
      });

      res.status(201).json({
        request_id: inviteId,
        status: 'pending',
        expires_at: now + BENEFICIARY_INVITE_EXPIRY_MS,
      });

    } catch (error) {
      console.error('[AgentInvite] request-link error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // The fleet-code link. Called by request-link for a fleet
  // code that is live and unconsumed, or already consumed by THIS agent (a
  // retry). Order: the issuer's authority → the human's canonical wallet → the
  // transactional single-use consume → the same bind the Accept uses → one
  // deterministic accepted invite record → the same invite_accepted PE → push.
  // Every step is idempotent for the consuming agent, so a retry after any
  // partial failure finishes the SAME link and can never create a second one.
  // =========================================================================
  async function linkViaFleetCode(
    res: Response,
    wallet: AgentWalletDocument,
    code: string,
    record: ConnectionTokenRecord,
    livePeCount: number,
  ): Promise<void> {
    const humanUserId = record.issuerUserId;
    try {
      // 1. The authority: the issuing agent must still be active and linked to
      //    this same human. A code dies with the link that minted it — for any
      //    NEW bind. A RESUME whose link already stands (this agent consumed the
      //    code and is linked to this human now) binds nothing: it only writes
      //    the missing bookkeeping, so the issuer's later state does not matter
      //    (review 2 #5 — the issuer unlinking between a 503 and the retry must
      //    not strand the record).
      const issuedBy = record.issuedByAgentWalletId;
      const issuerSnap = issuedBy ? await db.collection('agent_wallets').doc(issuedBy).get() : null;
      const issuer = issuerSnap && issuerSnap.exists ? issuerSnap.data() as AgentWalletDocument : null;
      const ownSnap = await db.collection('agent_wallets').doc(wallet.id).get();
      const own = ownSnap.exists ? ownSnap.data() as AgentWalletDocument : null;
      const linkStands = record.used && record.usedByWalletId === wallet.id
        && own !== null && own.linked_human_user_id === humanUserId;
      if (!issuedBy
        || (!linkStands && !isFleetIssuerLinked(issuer, humanUserId))) {
        res.status(409).json({
          error: 'fleet_code_issuer_not_linked',
          hint: 'The agent that issued this code is no longer linked to that human. Ask for a fresh code.',
        });
        return;
      }
      const issuerName = issuer?.display_name ?? 'one of your linked agents';

      // 2. The human's one canonical wallet — the same resolution the Accept uses.
      const humanWallets = await db.collection('wallets')
        .where('user_id', '==', humanUserId)
        .where('type', '==', 'human')
        .limit(2)
        .get();
      if (humanWallets.size !== 1) {
        res.status(409).json({
          error: humanWallets.empty
            ? 'canonical_human_wallet_registration_required'
            : 'canonical_human_wallet_registration_ambiguous',
        });
        return;
      }
      const humanWalletId = humanWallets.docs[0].id;
      const humanData = humanWallets.docs[0].data() as { address?: unknown };
      const humanAddress = typeof humanData.address === 'string' ? humanData.address : null;

      // 3. Transport limit (same key as a link request), then the single-use flip.
      if (!record.used) {
        const rateLimitResult = await cache.checkRateLimit(
          `rl:request-link:${wallet.id}`, DAILY_BENEFICIARY_INVITE_LIMIT, 86400,
        );
        if (!rateLimitResult.allowed) {
          res.status(429).json({
            error: `Link-request limit reached. Max ${DAILY_BENEFICIARY_INVITE_LIMIT} per day.`,
            retry_after: rateLimitResult.retryAfter,
          });
          return;
        }
      }
      const now = Date.now();
      const consumed = await consumeFleetCodeTransactional(db, {
        code, walletId: wallet.id, humanUserId, nowMs: now,
      });
      if (!consumed.ok) {
        if (consumed.reason === 'already_used') {
          res.status(409).json({
            error: 'connection_token_already_used',
            hint: 'A fleet code links exactly one agent. Ask any of your linked agents for a fresh code (`fleet-code`).',
          });
        } else if (consumed.reason === 'expired') {
          res.status(410).json({ error: 'connection_token_expired', hint: EXPIRED_CODE_HINT });
        } else {
          res.status(404).json({
            error: 'connection_token_issuer_unresolved',
            hint: 'The connection code is unknown. Ask for a fresh code.',
          });
        }
        return;
      }

      // 4. The bind — the SAME bindAgentToHuman path the Accept uses, at the
      //    default share, for the agent that consumed the code, and only while
      //    that consume's bind has not committed (review 2 #5: a bind that threw
      //    after the consume is completed by the same agent's retry). The bind's
      //    own transaction re-checks the code (consumed by this agent, not yet
      //    bound) and marks it bound. A code whose bind committed never binds
      //    again: it finishes a link that is live now, or it is refused.
      const freshSnap = await db.collection('agent_wallets').doc(wallet.id).get();
      const current = freshSnap.exists ? freshSnap.data() as AgentWalletDocument : wallet;
      if (current.linked_human_user_id !== humanUserId) {
        if (current.linked_human_user_id) {
          res.status(409).json({ error: 'agent_already_linked' });
          return;
        }
        if (consumed.resumed && consumed.bindCompleted) {
          res.status(409).json({
            error: 'connection_token_already_used',
            hint: 'This fleet code was already used. A link your human ended is re-made only by your human, in the app.',
          });
          return;
        }
        await bindAgentToHuman(deps, {
          wallet: current,
          humanWalletId,
          humanUserId,
          humanAddress,
          agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
          fleet: { code },
        });
      } else if (!consumed.bindCompleted) {
        // The link stands but the code does not say so (a code consumed before
        // the marker existed, or a link the human made meanwhile): record it,
        // idempotently, so the code can never bind again.
        await connectionTokenRef(db, code).update({ bind_completed: true, bind_completed_at: now });
      }

      // 5. The link record: ONE deterministic accepted agent_invites doc per code.
      const inviteId = fleetInviteId(code);
      const inviteRef = db.collection('agent_invites').doc(inviteId);
      let acceptedAt = now;
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(inviteRef);
        if (snap.exists) {
          const existingInvite = snap.data() as Record<string, unknown>;
          if (existingInvite.agent_wallet_id !== wallet.id || existingInvite.accepted_by_user_id !== humanUserId) {
            throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
          }
          if (typeof existingInvite.accepted_at === 'number') acceptedAt = existingInvite.accepted_at;
          return;
        }
        const inviteDoc: AgentInviteDocument = {
          id: inviteId,
          agent_wallet_id: wallet.id,
          agent_display_name: current.display_name,
          status: 'accepted',
          created_at: now,
          expires_at: now + BENEFICIARY_INVITE_EXPIRY_MS,
          invite_type: 'beneficiary',
          signing_bonus_pvt: 0,
          agent_pe_count: livePeCount,
          for_human_user_id: humanUserId,
          origin: 'connection_token',
          accepted_at: acceptedAt,
          accepted_by_user_id: humanUserId,
          accepted_by_wallet_id: humanWalletId,
          accepted_via: 'fleet_code',
          issued_by_agent_wallet_id: issuedBy,
        };
        txn.set(inviteRef, inviteDoc);
      });

      // A pending request this agent filed to the same human earlier is answered
      // by this link (so no dead "authorize" card lingers). Best-effort, no PE.
      try {
        const pending = await db.collection('agent_invites')
          .where('agent_wallet_id', '==', wallet.id)
          .where('for_human_user_id', '==', humanUserId)
          .where('status', '==', 'pending')
          .get();
        for (const doc of pending.docs) {
          await doc.ref.update({
            status: 'accepted',
            accepted_at: acceptedAt,
            accepted_by_user_id: humanUserId,
            accepted_by_wallet_id: humanWalletId,
            accepted_via: 'fleet_code',
            issued_by_agent_wallet_id: issuedBy,
          });
        }
      } catch (tidyErr) {
        console.error('[AgentInvite] fleet-link pending-request tidy failed (non-fatal):', tidyErr);
      }

      // 6. The SAME invite_accepted PE the Accept emits, on the human's chain
      //    (one emitter, routes/agent-wallet.ts). Deterministic id: a retry reuses it.
      try {
        await recordInviteAcceptedPE(deps, {
          humanWalletId,
          humanUserId,
          humanAddress,
          inviteId,
          agentWalletId: wallet.id,
          agentDisplayName: current.display_name,
          agentAddress: current.address,
          acceptedAt,
          extraMetadata: { accepted_via: 'fleet_code', issued_by_agent_wallet_id: issuedBy },
        });
      } catch (peErr) {
        console.error('[AgentInvite] fleet-link invite_accepted PE failed:', peErr);
        res.status(503).json({
          error: 'invite_acceptance_pe_pending',
          retry: 'Run request-link again with the same code; it resumes this link.',
        });
        return;
      }

      // 7. Tell the human: the new agent appears in the app with no tap.
      await pushFleetLinkToHuman(db, humanUserId, {
        inviteId,
        agentWalletId: wallet.id,
        agentName: current.display_name,
        issuerName,
      });

      res.status(201).json({ status: 'linked', linked_via: 'fleet_code', request_id: inviteId });
    } catch (error) {
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      throw error;
    }
  }

  // =========================================================================
  // POST /:wallet_id/fleet-code — any linked agent issues a link code for
  // another of its human's agents. Agent API auth + ownership.
  // The code is a normal PROV-XXXX-XXXX connection code: user_id = the issuer's
  // linked human, kind 'fleet', one hour, single-use for linking. The response
  // carries the install line the other agent runs on its OWN box (its key is
  // generated there — nothing here ever carries a key).
  // =========================================================================
  router.post('/:wallet_id/fleet-code', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // Authoritative read: the auth middleware may hold a wallet cached for up
      // to 30 s, and the authority here is the CURRENT status and link.
      const snap = await db.collection('agent_wallets').doc(wallet_id).get();
      const current = snap.exists ? snap.data() as AgentWalletDocument : null;
      if (!current || current.status !== 'active') {
        res.status(409).json({ error: 'agent_not_active' });
        return;
      }
      if (!current.linked_human_user_id) {
        res.status(403).json({
          error: 'not_linked',
          hint: 'Only an agent linked to its human can onboard that human\'s other agents. Finish your own link first (your human taps Accept in the Provian app).',
        });
        return;
      }

      const limit = await cache.checkRateLimit(`rl:fleet-code:${wallet_id}`, FLEET_CODE_HOURLY_LIMIT, 3600);
      if (!limit.allowed) {
        res.status(429).json({
          error: `Fleet-code limit reached. Max ${FLEET_CODE_HOURLY_LIMIT} per hour.`,
          retry_after: limit.retryAfter,
        });
        return;
      }

      const { code, expiresAt } = await mintFleetCode(db, {
        humanUserId: current.linked_human_user_id,
        issuerWalletId: wallet_id,
        nowMs: Date.now(),
      });
      res.status(201).json({
        code,
        expires_at: expiresAt,
        install_line: buildAgentInstallLines(code, resolveRelayUrl()),
      });
    } catch (error) {
      console.error('[AgentInvite] fleet-code error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
