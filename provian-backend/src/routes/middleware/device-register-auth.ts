/**
 * Device-Registration Authentication Middleware (POST /v1/devices/register ONLY)
 *
 * SECURITY INVARIANT (Spec M1, CRITICAL):
 *   The `agent_device_registration` setup token is REQUEST-UNBOUND and grants
 *   exactly ONE capability: registering a single device to an agent wallet. It
 *   MUST NOT be honoured by the global `authenticate` middleware (which is
 *   mounted on ~40 consequential routes: sessions/user-data/PE records)
 *   nor by any other /v1/devices/* verb or /v1/agent-attribution. This factory
 *   produces a middleware applied to POST /v1/devices/register ALONE.
 *
 * Routing by Authorization header shape:
 *   1. Contains "pvn_live_" -> the headless agent API key path. Delegate to the
 *      existing `authenticateAgent` middleware (sets req.agentWallet). This keeps
 *      `register-device --agent --api-key --api-secret` working unchanged.
 *   2. A bare token with NO "." and NO ":" -> peek setup_tokens/{tok}:
 *        - type === 'agent_device_registration' -> consume it (single-use,
 *          transactional, type-checked, fail-closed), revalidate the agent
 *          wallet inside the SAME transaction, then set req.agentWallet (NEVER
 *          req.user) so the existing devices.ts `if (agentWallet)` branch stamps
 *          owner_type=agent with zero logic changes (M2).
 *        - missing OR a different type (e.g. the human `device_registration`
 *          token) -> FALL THROUGH to the existing human `authenticate` path so
 *          the existing human email-token flow keeps working.
 *   3. Anything else (dot/colon present, wallet HMAC, DeviceKey, DeviceSignature)
 *      -> delegate to the existing `authenticateDeviceOwner` fallback.
 *
 * The token doc fields are HINTS only; the agent wallet doc is the source of
 * truth (M3). We re-read owner_address / agent_id from the wallet, and fail
 * closed if the wallet is missing or not active.
 *
 * NEVER console.log the token value or the inbound Authorization header (M6).
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { createAgentAuthMiddleware } from './agent-auth';
import type { AgentWalletDocument } from '../../core/agent-wallet/types';
import {
  getDeviceRegistrationId,
  hashDeviceRegistrationId,
} from './device-registration-id';

/** Literal stored in setup_tokens.type for the agent-device-registration flow. */
export const AGENT_DEVICE_REGISTRATION_TYPE = 'agent_device_registration' as const;

/**
 * Result of attempting to consume an agent-device-registration token.
 *   - { wallet }       -> token was valid and consumed; proceed as the agent.
 *   - { deny }         -> token doc claimed our type but is invalid (used /
 *                          expired / wallet missing / wallet inactive). Fail
 *                          CLOSED with 401.
 *   - { fallthrough }  -> token doc is absent OR a different type. Defer to the
 *                          existing human authenticate path.
 */
export type ConsumeAgentDeviceTokenResult =
  | { kind: 'wallet'; wallet: AgentWalletDocument }
  | { kind: 'deny' }
  | { kind: 'missing_idempotency' }
  | { kind: 'fallthrough' };

/**
 * Transactionally consume an agent-device-registration setup token.
 *
 * Single Firestore transaction, ALL reads before any write (M4, avoids TOCTOU):
 * 1. read setup_tokens/{token}
 * 2. if it does not exist OR type !== 'agent_device_registration' -> fallthrough
 * 3. if used OR expired -> deny
 * 4. read agent_wallets/{token.agent_wallet_id} (same txn)
 * 5. if missing OR status !== 'active' -> deny (M3 revalidation)
 * 6. mark used + used_at, return the loaded wallet doc
 *
 * VALIDATE BEFORE BURN : `mode: 'precheck'` runs steps 1-5 and SKIPS the
 * step-6 write. The auth middleware prechecks; the register handler calls
 * `mode: 'consume'` only after the request body has passed validation, so a
 * malformed or mangled paste (400 body) never consumes the invite. Single-use
 * is preserved because the consume-mode transaction re-runs every check: two
 * concurrent correct lines race at the burn, and the loser is either the same
 * idempotent registration (replayed) or denied.
 *
 * Pure (no req/res), so it can be unit-tested in isolation.
 */
export async function consumeAgentDeviceToken(
  db: Firestore,
  token: string,
  registrationId: string | null = null,
  mode: 'precheck' | 'consume' = 'consume',
): Promise<ConsumeAgentDeviceTokenResult> {
  const tokenRef = db.collection('setup_tokens').doc(token);

  return db.runTransaction<ConsumeAgentDeviceTokenResult>(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    if (!tokenSnap.exists) {
      return { kind: 'fallthrough' };
    }

    const data = tokenSnap.data() as {
      type?: string;
      used?: boolean;
      expires_at?: number;
      agent_wallet_id?: string;
      registration_id_sha256?: string;
    };

    // Not our token type -> let the existing human path handle it.
    if (data.type !== AGENT_DEVICE_REGISTRATION_TYPE) {
      return { kind: 'fallthrough' };
    }

    // From here on the doc is unambiguously an agent-device token: any defect
    // fails CLOSED (never falls through to the human path).
    if (registrationId === null) return { kind: 'missing_idempotency' };
    const registrationIdHash = hashDeviceRegistrationId(registrationId);
    const idempotentReplay = data.used === true
      && data.registration_id_sha256 === registrationIdHash;
    if (data.used === true && !idempotentReplay) return { kind: 'deny' };
    if (!idempotentReplay
      && (typeof data.expires_at !== 'number' || data.expires_at <= Date.now())) {
      return { kind: 'deny' };
    }
    if (typeof data.agent_wallet_id !== 'string' || data.agent_wallet_id.length === 0) {
      return { kind: 'deny' };
    }

    // Source of truth: the agent wallet doc (token fields are hints). Read it
    // inside the SAME transaction so a concurrent suspend/revoke cannot race.
    const walletRef = db.collection('agent_wallets').doc(data.agent_wallet_id);
    const walletSnap = await tx.get(walletRef);
    if (!walletSnap.exists) {
      return { kind: 'deny' };
    }
    const wallet = walletSnap.data() as AgentWalletDocument;
    if (wallet.status !== 'active') {
      return { kind: 'deny' };
    }

    // All reads done; perform the single write (never in precheck mode).
    if (!idempotentReplay && mode === 'consume') {
      tx.update(tokenRef, {
        used: true,
        used_at: Date.now(),
        registration_id_sha256: registrationIdHash,
      });
    }

    return { kind: 'wallet', wallet };
  });
}

/**
 * Result of validating/consuming a HUMAN `device_registration` setup token.
 * `deny` covers every invalid state (missing doc, wrong type, used with a
 * different registration id, expired) — the human path has no fallthrough:
 * `authenticate` 401s a bare token it cannot consume.
 */
export type ConsumeHumanDeviceTokenResult =
  | { kind: 'user'; userId: string }
  | { kind: 'deny' };

/**
 * The human email-token twin of `consumeAgentDeviceToken`, extracted from the
 * inline transaction `server.ts::authenticate` used to run so the burn can be
 * deferred (validate-before-burn): `authenticate` prechecks (no write),
 * the register handler consumes after body validation. Identical checks in
 * both modes; the idempotent-replay contract (same registration id replays a
 * used token) is unchanged.
 */
export async function consumeHumanDeviceToken(
  db: Firestore,
  token: string,
  registrationId: string,
  mode: 'precheck' | 'consume',
): Promise<ConsumeHumanDeviceTokenResult> {
  const registrationIdHash = hashDeviceRegistrationId(registrationId);
  const tokenRef = db.collection('setup_tokens').doc(token);
  const consumed = await db.runTransaction<{ user_id: string } | null>(async (tx) => {
    const fresh = await tx.get(tokenRef);
    if (!fresh.exists) return null;
    const setupToken = fresh.data() as {
      type?: string;
      used?: boolean;
      expires_at?: number;
      user_id?: string;
      registration_id_sha256?: string;
    } | undefined;
    if (!setupToken || setupToken.type !== 'device_registration') {
      return null;
    }
    const idempotentReplay = setupToken.used === true
      && setupToken.registration_id_sha256 === registrationIdHash;
    if (setupToken.used === true && !idempotentReplay) return null;
    if (!idempotentReplay
      && (typeof setupToken.expires_at !== 'number' || setupToken.expires_at <= Date.now())) {
      return null;
    }
    if (typeof setupToken.user_id !== 'string' || setupToken.user_id.length === 0) return null;
    if (!idempotentReplay && mode === 'consume') {
      tx.update(tokenRef, {
        used: true,
        used_at: Date.now(),
        registration_id_sha256: registrationIdHash,
      });
    }
    return { user_id: setupToken.user_id };
  });
  return consumed === null ? { kind: 'deny' } : { kind: 'user', userId: consumed.user_id };
}

/**
 * The deferred-burn marker the precheck paths stamp on the request, and the
 * one function the register handler calls to burn it after body validation.
 * Returns true when the token is consumed (or idempotently replayed); false
 * when a race or state change invalidated it since the precheck — the handler
 * responds 401 in that case, exactly as the old burn-at-auth did.
 */
export interface PendingDeviceSetupTokenBurn {
  kind: 'device_registration' | 'agent_device_registration';
  token: string;
}

export async function burnPendingDeviceSetupToken(
  db: Firestore,
  pending: PendingDeviceSetupTokenBurn,
  registrationId: string,
): Promise<boolean> {
  if (pending.kind === 'agent_device_registration') {
    const result = await consumeAgentDeviceToken(db, pending.token, registrationId, 'consume');
    return result.kind === 'wallet';
  }
  const result = await consumeHumanDeviceToken(db, pending.token, registrationId, 'consume');
  return result.kind === 'user';
}

/**
 * Build the POST /v1/devices/register auth middleware.
 *
 * @param db Firestore instance.
 * @param authenticateDeviceOwner The existing dual (human wallet HMAC / agent
 *   API key) device-owner middleware from server.ts. Used as the fallback for
 *   the human `device_registration` email token and for any non-agent-device
 *   credential shape.
 */
export function createDeviceRegisterAuth(
  db: Firestore,
  authenticateDeviceOwner: RequestHandler,
): RequestHandler {
  const authenticateAgent = createAgentAuthMiddleware(db);

  return async function deviceRegisterAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Defer to the existing fallback so its (consistent) error shape applies.
      authenticateDeviceOwner(req, res, next);
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();

    // Path 1: headless agent API key (pvn_live_...:pvns_...). Keep the existing
    // agent device-registration path working unchanged.
    if (authHeader.includes('pvn_live_')) {
      authenticateAgent(req, res, next);
      return;
    }

    // Path 2: bare one-time token shape (64 hex chars: NO dot, NO colon).
    // Anything with a dot/colon is a wallet HMAC v2 token or DeviceKey/Basic
    // and belongs to the existing device-owner path.
    if (!token.includes('.') && !token.includes(':')) {
      // The bare one-time token is 64 hex chars; anything else (empty, '/', …)
      // used to reach `.doc(token)`, throw, and answer 503 (2026-10-17).
      if (!/^[0-9a-f]{64}$/.test(token)) {
        res.status(401).json({ error: 'Invalid token format' });
        return;
      }
      let result: ConsumeAgentDeviceTokenResult;
      try {
        // PRECHECK only : full validation, no burn. The register
        // handler burns via burnPendingDeviceSetupToken after the body
        // validates, so a mangled paste never consumes the invite.
        result = await consumeAgentDeviceToken(db, token, getDeviceRegistrationId(req), 'precheck');
      } catch (error) {
        // Transaction infrastructure error: fail closed for an agent-device
        // attempt is impossible to distinguish here, so surface 503 rather
        // than silently granting access.
        console.error('[DeviceRegisterAuth] Token consumption error:', error);
        res.status(503).json({ error: 'Authentication service temporarily unavailable' });
        return;
      }

      if (result.kind === 'wallet') {
        // M2: set req.agentWallet (the full loaded doc), NEVER req.user.
        req.agentWallet = result.wallet;
        req.pendingDeviceSetupToken = { kind: AGENT_DEVICE_REGISTRATION_TYPE, token };
        next();
        return;
      }
      if (result.kind === 'deny') {
        // M4: wrong-state agent-device token fails closed.
        res.status(401).json({ error: 'Invalid or expired registration token' });
        return;
      }
      if (result.kind === 'missing_idempotency') {
        res.status(400).json({ error: 'Idempotency-Key is required for device registration' });
        return;
      }
      // result.kind === 'fallthrough': not an agent-device token. Defer to the
      // existing human authenticate path (handles the human `device_registration`
      // email token and wallet HMAC).
      authenticateDeviceOwner(req, res, next);
      return;
    }

    // Path 3: dot/colon present (wallet HMAC, DeviceKey, Basic) -> fallback.
    authenticateDeviceOwner(req, res, next);
  };
}
