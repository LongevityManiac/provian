/**
 * Express dispatch for the Bitbucket webhook handler + minimal install
 * management. Mirrors routes/witnesses-gitlab.ts.
 *
 * Mounted by server.ts at `/v1/witnesses` so the full paths are
 * `POST /v1/witnesses/bitbucket/webhook` and `…/bitbucket/installs*`.
 *
 * Bitbucket has no GitHub-App-style OAuth install dance: the user creates a
 * webhook in their Bitbucket repository settings (URL = the webhook endpoint,
 * Secret = the app-wide BITBUCKET_WEBHOOK_SECRET) and registers the
 * repository's UUID with the relay so inbound deliveries attribute to their
 * wallet. The install-management endpoints below are that registration surface
 * (DeviceKey auth, owner-scoped).
 *
 * Config is loaded at factory time (read-once-at-startup pattern). Disabling
 * the connector means unsetting BITBUCKET_WEBHOOK_SECRET and restarting -
 * routes stay mounted but the webhook returns 503.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { handleBitbucketWebhook, normalizeRepoUuid } from '../core/witnesses/bitbucket-webhook';
import { loadBitbucketAppConfig } from '../core/witnesses/bitbucket-app-config';
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

const PROVIDER = 'bitbucket' as const;
// Bitbucket repository UUIDs are UUIDs, optionally wrapped in braces. We
// normalize (strip braces, lowercase) before use, so accept either form.
const REPO_UUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

/**
 * Emit a `service_install_revoked` PE for a user-initiated Bitbucket
 * disconnect. Best-effort (returns null on failure): the install row mutated
 * by markServiceInstallRevoked is the source of truth; this is the
 * audit-trail PE. Shared by this router's own revoke route and the
 * cross-provider wallet-auth revoke in routes/witnesses-installs.ts so the
 * emission site stays in this file (which the pinned policy-matrix emitter
 * inventory names).
 */
export async function emitBitbucketInstallRevokedPE(
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
    console.warn('[BitbucketWitness] revoked PE emission failed:', err);
    return null;
  }
}

export function createWitnessesBitbucketRouter(deps: AgentBankDeps): Router {
  const router = Router();
  const config = loadBitbucketAppConfig();
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
    const repoUuidRaw = (req.body as Record<string, unknown> | undefined)?.repo_uuid;
    const candidate = typeof repoUuidRaw === 'string' ? repoUuidRaw.trim() : null;
    if (!candidate || !REPO_UUID_RE.test(candidate)) {
      return res.status(400).json({ error: 'invalid_repo_uuid' });
    }
    const repoUuid = normalizeRepoUuid(candidate);

    // Guard against hijacking a repo another wallet already registered.
    const existing = await getServiceInstallByInstallationId(deps.db, PROVIDER, repoUuid);
    if (existing && existing.revoked_at === null && existing.user_id !== userId) {
      return res.status(409).json({ error: 'repo_already_linked' });
    }

    let created: Awaited<ReturnType<typeof createServiceInstall>>;
    try {
      created = await createServiceInstall(deps.db, {
        user_id: userId,
        provider: PROVIDER,
        installation_id: repoUuid,
      });
    } catch (err) {
      // The read-then-set check above can race two first registrations; the
      // transactional guard inside createServiceInstall is the one that holds.
      if (err instanceof ServiceInstallOwnedByOtherUserError) {
        return res.status(409).json({ error: 'repo_already_linked' });
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
          metadata: { provider: PROVIDER, installation_id: repoUuid },
        });
        peId = id;
      } catch {
        // PE emission is best-effort; the install row is the source of truth.
      }
    }
    // B2 : per-install secret disclosed ONCE — on the minting call
    // (pitfall #26 pattern). Rotation = revoke, then re-register.
    return res.status(200).json({
      linked: true,
      repo_uuid: repoUuid,
      pe_id: peId,
      webhook_secret: secretIssued ? doc.webhook_secret : null,
      webhook_secret_already_issued: !secretIssued,
      setup: secretIssued
        ? 'In your Bitbucket repository: Repository settings > Webhooks > Add webhook. URL: '
          + 'https://api.provian.ai/v1/witnesses/bitbucket/webhook — Secret: the webhook_secret '
          + 'above (shown only this once) — Triggers: Repository push + Pull request merged.'
        : 'Secret already issued for this repository. To rotate: POST '
          + `/v1/witnesses/bitbucket/installs/${repoUuid}/revoke, then re-register.`,
    });
  }

  /**
   * POST /bitbucket/installs - DeviceKey auth, body { repo_uuid }.
   * Registers a Bitbucket repository under the caller's wallet so inbound
   * webhook deliveries for that repo attribute to them. Idempotent for
   * re-registration. Emits a service_install_created PE on first registration.
   */
  router.post('/bitbucket/installs', authenticateDevice, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret) {
      return res.status(503).json({ error: 'bitbucket_webhook_not_configured' });
    }
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    return registerInstallForUser(userId, req, res);
  });

  /**
   * POST /bitbucket/wallet/installs - Wallet auth, body { repo_uuid }.
   * Phone-initiated variant of POST /bitbucket/installs (B3,): the
   * mobile app has no DeviceKey identity, so the in-app Earn connect flow
   * registers through the request-bound wallet auth token instead. Same id
   * space (wallets doc id), same one-time webhook_secret disclosure, same
   * hijack guard. Mirrors the /github/connect/wallet/* precedent.
   */
  router.post(
    '/bitbucket/wallet/installs',
    authenticateWalletOwner,
    async (req: Request, res: Response) => {
      if (!config.enabled || !config.webhookSecret) {
        return res.status(503).json({ error: 'bitbucket_webhook_not_configured' });
      }
      return registerInstallForUser(req.walletOwnerId as string, req, res);
    },
  );

  /**
   * GET /bitbucket/installs - DeviceKey auth. Lists the caller's linked
   * Bitbucket repositories (active and revoked).
   */
  router.get('/bitbucket/installs', authenticateDevice, async (req: Request, res: Response) => {
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
   * POST /bitbucket/installs/:installation_id/revoke - DeviceKey auth. Caller
   * must own the install. Sets revoked_at; the webhook handler then returns
   * 410 for that repo. Idempotent on an already-revoked install.
   */
  router.post(
    '/bitbucket/installs/:installation_id/revoke',
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
      const peId = await emitBitbucketInstallRevokedPE(deps, userId, installationId);
      return res.status(200).json({ revoked: true, pe_id: peId });
    },
  );

  /**
   * POST /bitbucket/webhook - no auth middleware; the handler verifies the
   * X-Hub-Signature HMAC itself (verify-before-parse). rawBody is captured by
   * the express.json() verify hook in server.ts.
   */
  router.post('/bitbucket/webhook', async (req: Request, res: Response) => {
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
    const result = await handleBitbucketWebhook(deps, {
      rawBody,
      signatureHeader: req.header('X-Hub-Signature') ?? undefined,
      eventKey: req.header('X-Event-Key') ?? undefined,
      deliveryId: req.header('X-Request-UUID') ?? undefined,
      config,
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
