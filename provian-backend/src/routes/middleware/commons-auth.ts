import { observeActorSession } from '../../core/jurisdiction/mint-compliance';
/**
 * Shared Commons Auth Utility
 *
 * Extracts wallet identity from a request. Supports three auth methods:
 *   1. Wallet auth (mobile app - req.walletAuth)
 *   2. Agent session auth (API key - req.agentWallet)
 *   3. Commons session token (QR web auth - Bearer header → cache lookup)
 *
 * Used by both the Commons routes (/v1/commons/) and the PE projection
 * protocol routes (/v1/pe/), since projection and consent endpoints can
 * be initiated from any of the three auth contexts.
 */

import type { Request, Response } from 'express';
import {openPrivateAuthenticatedRequest} from '../../core/meter/private-pricing';
import type { AgentBankDeps } from '../../core/agent-bank/types';
import { validateSessionToken } from '../../core/commons/auth';

export interface AuthenticatedWallet {
  walletId: string;
  agentId: string;
  /**
   * On-chain wallet address resolved from Firestore. Null when the wallet
   * has not yet been registered on-chain (e.g. mid-onboarding). Callers
   * that need a real address must check for null and handle accordingly.
   */
  actorAddress: string | null;
  /**
   * True when the request was authenticated via API key (agent wallet).
   * False when authenticated via mobile wallet auth or Commons session token.
   * Used to set join_method = 'autonomous' for agent joins.
   */
  isAgent: boolean;
}

/**
 * Resolve a wallet's on-chain address from Firestore. Returns null if
 * no on-chain address can be found - callers must handle the absence
 * explicitly rather than silently using a userId as a fake address.
 *
 * Phase 2.18 - Theme 10 fix. Previous behaviour stored `user_id` in the
 * actorAddress slot, which is not an on-chain address at all. Downstream
 * code that compared actor_address against on-chain transfer logs would
 * never match.
 *
 * Phase 2.22 - Finding #31 fix. Removed userId fallback. Returning a
 * non-address string as actorAddress caused silent mismatches in on-chain
 * comparisons. Callers now receive null and must handle it explicitly.
 */
async function resolveActorAddress(
  deps: AgentBankDeps,
  userId: string,
): Promise<string | null> {
  try {
    const snap = await deps.db
      .collection('wallets')
      .where('user_id', '==', userId)
      .limit(1)
      .get();
    if (!snap.empty) {
      const data = snap.docs[0].data() as { address?: unknown };
      return evmAddressOrNull(data.address);
    }
  } catch (err) {
    console.warn('[commons-auth] actor_address lookup failed', err);
  }
  return null;
}

/**
 * The actor address is an ON-CHAIN address or nothing. * a non-address string in this slot (a wallet id, a user
 * id) was persisted as `poster_address` and read by the same-owner fence as
 * "no counterparty" (unresolvable:false) — skipping the distinct-owner check
 * that IS the anti-self-dealing guarantee. So the resolver returns only a
 * well-formed EVM address, never a synthetic string, whatever the store holds.
 */
const EVM_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;
function evmAddressOrNull(value: unknown): string | null {
  return typeof value === 'string' && EVM_ADDRESS.test(value.trim()) ? value.trim() : null;
}

/** An agent wallet's address, from its own `agent_wallets` document. */
async function resolveAgentWalletAddress(
  deps: AgentBankDeps,
  walletId: string,
): Promise<string | null> {
  try {
    const snap = await deps.db.collection('agent_wallets').doc(walletId).get();
    if (snap.exists) {
      const data = snap.data() as { address?: unknown } | undefined;
      return evmAddressOrNull(data?.address);
    }
  } catch (err) {
    console.warn('[commons-auth] agent wallet address lookup failed', err);
  }
  return null;
}

/**
 * Extract wallet identity from request.
 * Returns null if no valid auth is found.
 */
export async function getAuthenticatedWallet(
  req: Request,
  deps: AgentBankDeps,
): Promise<AuthenticatedWallet | null> {
  // Wallet auth (mobile app) - human wallet, biometric-gated.
  //
  // The `authenticate` middleware (server.ts) validates the v2 wallet token and
  // stamps `req.user = { id, device_id }`. It never sets `req.walletAuth` —
  // nothing in the backend does — so reading ONLY `req.walletAuth` here made
  // every HUMAN Commons call (join, join-context, forum, vouch, publish) fall
  // through to a null return and 401, while agent calls (req.agentWallet) worked.
  // The Commons tab is the first surface to exercise the human path in
  // production, which is where this first showed. Read the property
  // `authenticate` actually sets; keep the declared `req.walletAuth` shape as a
  // fallback for any future middleware that populates it.
  const walletUserId = req.user?.id ?? req.walletAuth?.user_id;
  if (walletUserId) {
    // Phase 2.18 (Theme 10): resolve the real on-chain address rather
    // than parroting user_id back as actorAddress.
    const actorAddress = await resolveActorAddress(deps, walletUserId);
    return {
      walletId: walletUserId,
      agentId: walletUserId,
      actorAddress,
      isAgent: false,
    };
  }

  // Agent session auth - API key identifies an agent wallet, autonomous path
  const agentWallet = req.agentWallet;
  if (agentWallet) {
    return {
      walletId: agentWallet.id,
      agentId: agentWallet.agent_id,
      actorAddress: agentWallet.address,
      isAgent: true,
    };
  }

  // Commons session token (QR web auth) - treat as human unless ID has agent prefix
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const walletId = await validateSessionToken(deps, token);
    if (walletId) {
      openPrivateAuthenticatedRequest(req,token);
      // an AGENT signed in over a
      // session token carries a `wallet_aw_…` id, which `wallets.user_id` never
      // matches — this branch resolved null for every such agent, and the
      // Commons router then substituted the wallet id for the address. Resolve
      // the agent through its own document; a human through `wallets`. Null
      // stays null (never a fallback to the id): callers persist it as such.
      await observeActorSession(deps.db, req, walletId);
      const isAgent = walletId.startsWith('wallet_aw_');
      const actorAddress = isAgent
        ? await resolveAgentWalletAddress(deps, walletId)
        : await resolveActorAddress(deps, walletId);
      return {
        walletId,
        agentId: walletId,
        actorAddress,
        isAgent,
      };
    }
  }

  return null;
}

/**
 * Middleware-like helper that returns the authenticated wallet or sends 401.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  deps: AgentBankDeps,
): Promise<AuthenticatedWallet | null> {
  const auth = await getAuthenticatedWallet(req, deps);
  if (!auth) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return auth;
}
