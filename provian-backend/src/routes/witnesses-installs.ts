/**
 * Cross-provider service-install reads + revoke for the PHONE (wallet auth).
 *
 * B3 : the mobile Earn tab's forge connect flow needs "list my
 * connected forges" and "disconnect one" under the app's own auth. The
 * per-provider routers expose these under DeviceKey auth only (CLI/daemon);
 * the phone has no DeviceKey identity, so this router is the wallet-auth
 * counterpart. One list call serves all three providers so the Earn hub
 * resolves per-surface status with a single request.
 *
 * Mounted by server.ts at `/v1/witnesses` so the full paths are
 * `GET /v1/witnesses/installs` and
 * `POST /v1/witnesses/installs/:provider/:installation_id/revoke`.
 *
 * Deliberately config-independent: listing and revoking already-recorded
 * installs works whether or not new connects are currently enabled (same
 * stance as GET /github/installs). Registration stays in the per-provider
 * routers because it needs each provider's config gate and one-time-secret
 * response shape.
 *
 * MASKING INVARIANT (B2,): list responses use explicit field
 * mapping and must NEVER include `webhook_secret` the per-install secret
 * is disclosed exactly once, by the registration response that minted it.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import {
  getServiceInstallByInstallationId,
  getServiceInstallsByUser,
  installForgeAccountScope,
  markServiceInstallRevoked,
  type ServiceInstallProvider,
} from '../core/witnesses/service-installs';
import { emitServiceInstallRevokedPE } from '../core/witnesses/github-connect';
import { createWalletOwnerAuthMiddleware } from './middleware/wallet-owner-auth';
import { emitBitbucketInstallRevokedPE } from './witnesses-bitbucket';
import { emitGitLabInstallRevokedPE } from './witnesses-gitlab';

const PROVIDERS: readonly ServiceInstallProvider[] = ['github', 'gitlab', 'bitbucket'];

function isProvider(value: unknown): value is ServiceInstallProvider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function createWitnessesInstallsRouter(deps: AgentBankDeps): Router {
  const router = Router();
  const authenticateWalletOwner = createWalletOwnerAuthMiddleware({
    db: deps.db,
    cache: deps.cache,
  });

  /**
   * GET /installs - Wallet auth. Lists the caller's service installs across
   * ALL providers (active and revoked; revoked rows carry a non-null
   * `revoked_at` so the client can render history). An empty list is a
   * normal 200.
   */
  router.get('/installs', authenticateWalletOwner, async (req: Request, res: Response) => {
    const userId = req.walletOwnerId as string;
    const installs = await getServiceInstallsByUser(deps.db, userId);
    return res.status(200).json({
      installs: installs.map((i) => ({
        provider: i.provider,
        installation_id: i.installation_id,
        installed_at: i.installed_at,
        revoked_at: i.revoked_at ?? null,
        // Part 2: the STABLE scope author mappings are keyed to, so the
        // owner's Contributors view can list the mappings on THIS install.
        // github: null until the first signed delivery stamps it.
        forge_account_id: installForgeAccountScope(i),
        forge_account_login: i.forge_account_login ?? null,
      })),
    });
  });

  /**
   * POST /installs/:provider/:installation_id/revoke - Wallet auth. Caller
   * must own the install. Sets revoked_at and emits a
   * service_install_revoked PE carrying the correct provider. Idempotent on
   * an already-revoked install. Wallet-auth counterpart of the per-provider
   * DeviceKey revoke routes; rotation for gitlab/bitbucket per-install
   * secrets is revoke + re-register (B2).
   */
  router.post(
    '/installs/:provider/:installation_id/revoke',
    authenticateWalletOwner,
    async (req: Request, res: Response) => {
      const provider = req.params.provider;
      if (!isProvider(provider)) {
        return res.status(400).json({ error: 'invalid_provider' });
      }
      const installationId = req.params.installation_id;
      if (!installationId) {
        return res.status(400).json({ error: 'missing_installation_id' });
      }
      const userId = req.walletOwnerId as string;
      const install = await getServiceInstallByInstallationId(deps.db, provider, installationId);
      if (!install || install.user_id !== userId) {
        // 404 (not 403) so a probe can't enumerate other users' installs.
        return res.status(404).json({ error: 'install_not_found' });
      }
      if (install.revoked_at !== null) {
        return res.status(200).json({ revoked: true, idempotent: true });
      }
      await markServiceInstallRevoked(deps.db, provider, installationId);
      // Best-effort per-provider emitters (null on failure — the install row
      // is the source of truth). The emission sites deliberately live in each
      // provider's own module: those are the files the pinned policy-matrix
      // emitter inventory names, so this router must not carry its own
      // action-type literal.
      const peId =
        provider === 'github'
          ? await emitServiceInstallRevokedPE(deps, userId, installationId)
          : provider === 'gitlab'
            ? await emitGitLabInstallRevokedPE(deps, userId, installationId)
            : await emitBitbucketInstallRevokedPE(deps, userId, installationId);
      return res.status(200).json({ revoked: true, pe_id: peId });
    },
  );

  return router;
}
