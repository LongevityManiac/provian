/**
 * Express dispatch for the GitLab webhook handler + minimal install
 * management. Mirrors routes/witnesses-github.ts.
 *
 * Mounted by server.ts at `/v1/witnesses` so the full paths are
 * `POST /v1/witnesses/gitlab/webhook` and `…/gitlab/installs*`.
 *
 * GitLab has no GitHub-App-style OAuth install dance for project webhooks:
 * the user creates a webhook in their GitLab project settings (URL =
 * the webhook endpoint, Secret token = the app-wide GITLAB_WEBHOOK_SECRET)
 * and registers the project's numeric id with the relay so inbound
 * deliveries attribute to their wallet. The install-management endpoints
 * below are that registration surface (DeviceKey auth, owner-scoped).
 *
 * Config is loaded at factory time (read-once-at-startup pattern). Disabling
 * the connector means unsetting GITLAB_WEBHOOK_SECRET and restarting - routes
 * stay mounted but the webhook returns 503.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { handleGitLabWebhook } from '../core/witnesses/gitlab-webhook';
import { loadGitLabAppConfig } from '../core/witnesses/gitlab-app-config';
import {
  createServiceInstall,
  getServiceInstallByInstallationId,
  getServiceInstallsByUser,
  markServiceInstallRevoked,
  ServiceInstallOwnedByOtherUserError,
} from '../core/witnesses/service-installs';
import { generatePE } from '../core/agent-bank/pe-utils';
import { createDeviceAuthMiddleware } from './middleware/device-auth';
import { createWalletOwnerAuthMiddleware } from './middleware/wallet-owner-auth';

const PROVIDER = 'gitlab' as const;
// GitLab project ids are positive integers. Accept the string form.
const PROJECT_ID_RE = /^[0-9]{1,18}$/;

/**
 * Emit a `service_install_revoked` PE for a user-initiated GitLab disconnect.
 * Best-effort (returns null on failure): the install row mutated by
 * markServiceInstallRevoked is the source of truth; this is the audit-trail
 * PE. Shared by this router's own revoke route and the cross-provider
 * wallet-auth revoke in routes/witnesses-installs.ts so the emission site
 * stays in this file (which the pinned policy-matrix emitter inventory names).
 */
export async function emitGitLabInstallRevokedPE(
  deps: AgentBankDeps,
  userId: string,
  installationId: string,
): Promise<string | null> {
  try {
    const { peId } = await generatePE(deps, {
      walletId: userId,
      agentId: userId,
      actorAddress: '',
      actionType: 'service_install_revoked',
      metadata: { provider: PROVIDER, installation_id: installationId },
    });
    return peId;
  } catch (err) {
    console.warn('[GitLabWitness] revoked PE emission failed:', err);
    return null;
  }
}

export function createWitnessesGitLabRouter(deps: AgentBankDeps): Router {
  const router = Router();
  const config = loadGitLabAppConfig();
  const authenticateDevice = createDeviceAuthMiddleware(deps.db);
  const authenticateWalletOwner = createWalletOwnerAuthMiddleware({
    db: deps.db,
    cache: deps.cache,
  });

  /**
   * Shared registration body for both auth variants (DeviceKey and wallet).
   * The two variants differ ONLY in how the owning wallet id is resolved:
   * device.owner_wallet_id (CLI/daemon) vs req.walletOwnerId (phone). Same
   * id space, same idempotency, same one-time-secret disclosure rule.
   */
  async function registerInstallForUser(
    userId: string,
    req: Request,
    res: Response,
  ): Promise<Response> {
    const projectIdRaw = (req.body as Record<string, unknown> | undefined)?.project_id;
    const projectId =
      typeof projectIdRaw === 'number'
        ? String(projectIdRaw)
        : typeof projectIdRaw === 'string'
          ? projectIdRaw.trim()
          : null;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) {
      return res.status(400).json({ error: 'invalid_project_id' });
    }

    // Guard against hijacking a project another wallet already registered.
    const existing = await getServiceInstallByInstallationId(deps.db, PROVIDER, projectId);
    if (existing && existing.revoked_at === null && existing.user_id !== userId) {
      // Owner mismatch - 409 (the project is already linked to someone else).
      return res.status(409).json({ error: 'project_already_linked' });
    }

    let created: Awaited<ReturnType<typeof createServiceInstall>>;
    try {
      created = await createServiceInstall(deps.db, {
        user_id: userId,
        provider: PROVIDER,
        installation_id: projectId,
      });
    } catch (err) {
      // The read-then-set check above can race two first registrations; the
      // transactional guard inside createServiceInstall is the one that holds.
      if (err instanceof ServiceInstallOwnedByOtherUserError) {
        return res.status(409).json({ error: 'project_already_linked' });
      }
      throw err;
    }
    const { doc, secretIssued } = created;

    let peId: string | null = null;
    if (!existing) {
      try {
        const { peId: id } = await generatePE(deps, {
          walletId: userId,
          agentId: userId,
          actorAddress: '',
          actionType: 'service_install_created',
          metadata: { provider: PROVIDER, installation_id: projectId },
        });
        peId = id;
      } catch {
        // PE emission is best-effort; the install row is the source of truth.
      }
    }
    // B2 : the per-install secret is disclosed ONCE — on the call that
    // minted it (pitfall #26 pattern). A re-POST on an active install returns
    // null + already_issued; rotation = revoke, then re-register.
    return res.status(200).json({
      linked: true,
      project_id: projectId,
      pe_id: peId,
      webhook_secret: secretIssued ? doc.webhook_secret : null,
      webhook_secret_already_issued: !secretIssued,
      setup: secretIssued
        ? 'In your GitLab project: Settings > Webhooks > Add new webhook. URL: '
          + 'https://api.provian.ai/v1/witnesses/gitlab/webhook — Secret token: the webhook_secret '
          + 'above (shown only this once) — Triggers: Push events + Merge request events.'
        : 'Secret already issued for this project. To rotate: POST '
          + `/v1/witnesses/gitlab/installs/${projectId}/revoke, then re-register.`,
    });
  }

  /**
   * POST /gitlab/installs - DeviceKey auth, body { project_id }.
   * Registers a GitLab project under the caller's wallet so inbound
   * webhook deliveries for that project attribute to them. Idempotent for
   * re-registration (createServiceInstall resets installed_at / clears
   * revoked_at). Emits a service_install_created PE on first registration.
   */
  router.post('/gitlab/installs', authenticateDevice, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret) {
      return res.status(503).json({ error: 'gitlab_webhook_not_configured' });
    }
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    return registerInstallForUser(userId, req, res);
  });

  /**
   * POST /gitlab/wallet/installs - Wallet auth, body { project_id }.
   * Phone-initiated variant of POST /gitlab/installs (B3,): the
   * mobile app has no DeviceKey identity, so the in-app Earn connect flow
   * registers through the request-bound wallet auth token instead. Same id
   * space (wallets doc id), same one-time webhook_secret disclosure, same
   * hijack guard. Mirrors the /github/connect/wallet/* precedent.
   */
  router.post(
    '/gitlab/wallet/installs',
    authenticateWalletOwner,
    async (req: Request, res: Response) => {
      if (!config.enabled || !config.webhookSecret) {
        return res.status(503).json({ error: 'gitlab_webhook_not_configured' });
      }
      return registerInstallForUser(req.walletOwnerId as string, req, res);
    },
  );

  /**
   * GET /gitlab/installs - DeviceKey auth. Lists the caller's linked GitLab
   * projects (active and revoked).
   */
  router.get('/gitlab/installs', authenticateDevice, async (req: Request, res: Response) => {
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    const installs = await getServiceInstallsByUser(deps.db, userId);
    return res.status(200).json({
      installs: installs
        .filter((i) => i.provider === PROVIDER)
        .map((i) => ({
          installation_id: i.installation_id,
          installed_at: i.installed_at,
          revoked_at: i.revoked_at ?? null,
        })),
    });
  });

  /**
   * POST /gitlab/installs/:installation_id/revoke - DeviceKey auth. Caller
   * must own the install. Sets revoked_at; the webhook handler then returns
   * 410 for that project. Idempotent on an already-revoked install.
   */
  router.post(
    '/gitlab/installs/:installation_id/revoke',
    authenticateDevice,
    async (req: Request, res: Response) => {
      const installationId = req.params.installation_id;
      if (!installationId) {
        return res.status(400).json({ error: 'missing_installation_id' });
      }
      const userId = req.device?.owner_wallet_id;
      if (!userId) {
        return res.status(401).json({ error: 'no_device_owner' });
      }
      const install = await getServiceInstallByInstallationId(deps.db, PROVIDER, installationId);
      if (!install || install.user_id !== userId) {
        // 404 (not 403) so a probe can't enumerate other users' installs.
        return res.status(404).json({ error: 'install_not_found' });
      }
      if (install.revoked_at !== null) {
        return res.status(200).json({ revoked: true, idempotent: true });
      }
      await markServiceInstallRevoked(deps.db, PROVIDER, installationId);
      const peId = await emitGitLabInstallRevokedPE(deps, userId, installationId);
      return res.status(200).json({ revoked: true, pe_id: peId });
    },
  );

  /**
   * POST /gitlab/webhook - no auth middleware; the handler verifies the
   * X-Gitlab-Token itself (verify-before-parse). rawBody is captured by the
   * express.json() verify hook in server.ts.
   */
  router.post('/gitlab/webhook', async (req: Request, res: Response) => {
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
    const result = await handleGitLabWebhook(deps, {
      rawBody,
      tokenHeader: req.header('X-Gitlab-Token') ?? undefined,
      eventType: req.header('X-Gitlab-Event') ?? undefined,
      deliveryId: req.header('X-Gitlab-Event-UUID') ?? undefined,
      config,
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
