/**
 * Consolidated Express `Request` augmentation.
 *
 * Various auth/parsing middlewares attach properties to the request object at
 * runtime. This is the single source of truth for those properties so handlers
 * can read them with full type-safety instead of `(req as any).<field>`.
 *
 * Each property is OPTIONAL because it is only present after the corresponding
 * middleware has run. Handlers must still null-check (the type system cannot know
 * which middleware preceded a given handler) — but the field SHAPE is now typed.
 *
 * Previously these lived as separate `declare global` blocks in agent-auth.ts,
 * and device-auth.ts. They are merged here to avoid scattered
 * (and potentially conflicting) duplicate declarations of the same field.
 */

import type { AgentWalletDocument } from '../core/agent-wallet/types';
import type { DeviceDocument } from '../routes/middleware/device-auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Wallet-auth identity, set by the wallet `authenticate` middleware. */
      user?: { id: string; device_id: string };

      /** Agent API-key wallet, set by `createAgentAuthMiddleware` (agent-auth.ts). */
      agentWallet?: AgentWalletDocument;


      /** Device document, set by `createDeviceAuthMiddleware` (device-auth.ts). */
      device?: DeviceDocument;

      /**
       * HOW `createDeviceAuthMiddleware` authenticated `device`: `device_signature` = the
       * P-256 key signed this exact request (Path A); `bearer` = the DeviceKey/Basic
       * secret (Path B). Every device — Secure Enclave ones included — holds a bearer
       * secret, so a device's `signing_method` says what it CAN do, never what THIS
       * request did. Unset is treated as `bearer` (fail closed).
       */
      deviceAuthMethod?: 'device_signature' | 'bearer';

      /** Mobile wallet-auth payload consumed by `getAuthenticatedWallet` (commons-auth.ts). */
      walletAuth?: { user_id: string };

      /** Wallet-recorder auth fields, set by `authenticateWalletRecorder` (no agent session). */
      userId?: string;
      agentId?: string;
      authType?: 'wallet' | 'agent_session';

      /** Owning wallet id, set by the GitHub witness `authenticateWalletOwner` middleware. */
      walletOwnerId?: string;

      /**
       * Deferred setup-token burn (validate-before-burn), stamped by the
       * device-registration precheck paths and consumed by the register
       * handler AFTER body validation via `burnPendingDeviceSetupToken`.
       */
      pendingDeviceSetupToken?: {
        kind: 'device_registration' | 'agent_device_registration';
        token: string;
      };

      /** Dual-auth identity for the PVT router, set by `authenticatePVTDual` (pvt.ts). */
      pvtAuth?: {
        type: 'wallet' | 'agent';
        userId: string;
        walletAddress?: string;
      };

      /**
       * Raw (unparsed) request body string, captured by the express.json `verify`
       * hook. Used by signature-verification middlewares that must hash the exact
       * bytes the client signed.
       */
      rawBody?: string;
    }
  }
}

export {};
