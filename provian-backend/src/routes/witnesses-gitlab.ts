/**
 * Express dispatch for the GitLab webhook handler + minimal install
 * management. Mirrors routes/witnesses-github.ts.
 *
 * Mounted by server.ts at `/v1/witnesses` so the full paths are
 * `POST /v1/witnesses/gitlab/webhook` and `…/gitlab/installs*`.
 *
 * GitLab has no GitHub-App-style OAuth install dance for project webhooks.
 * Registration is two calls. `begin` (body { project_id }) returns a public
 * SSH key the relay generated for this attempt; the registrant adds it to the
 * project as a deploy key with write permission, which needs Maintainer.
 * `verify` (body { project_id, project_path }) has the relay ask gitlab.com,
 * with the key, whether it may push to that path — sending no changes
 * (core/witnesses/forge-deploy-key.ts); on success it returns the
 * per-install webhook secret, which the user sets as the project webhook's
 * Secret token. No forge credential ever reaches the relay. Only projects on
 * gitlab.com can be registered; a registration without that proof, or a
 * delivery whose project path is not the proven one, authenticates nothing.
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
  installControlProven,
  isUsableInstallationId,
  markServiceInstallRevoked,
  ServiceInstallOwnedByOtherUserError,
} from '../core/witnesses/service-installs';
import {
  beginDeployKeyAttempt,
  deployKeyInstructions,
  httpStatusForVerifyFailure,
  normalizeProjectPath,
  verifyDeployKeyAttempt,
  type ProbeRunner,
} from '../core/witnesses/forge-deploy-key';
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

/** Test seam: how the deploy key is tried against the forge (default: the SSH probe in forge-deploy-key.ts). */
export interface WitnessesGitLabRouterOptions {
  runProbe?: ProbeRunner;
  now?: () => number;
}

/**
 * Answer 500 for a handler that throws, instead of leaving the request open:
 * an unanswered request holds its connection until the server's deadline.
 */
function answering(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      console.error('[GitLabWitness] route failed:', err instanceof Error ? err.message : 'unknown error');
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

export function createWitnessesGitLabRouter(deps: AgentBankDeps, options: WitnessesGitLabRouterOptions = {}): Router {
  const router = Router();
  const config = loadGitLabAppConfig();
  const authenticateDevice = createDeviceAuthMiddleware(deps.db);
  const authenticateWalletOwner = createWalletOwnerAuthMiddleware({
    db: deps.db,
    cache: deps.cache,
  });

  const now = options.now ?? Date.now;

  /** The project id from the body, or null after answering 400. */
  function parseInstallationId(req: Request, res: Response): string | null {
    const projectIdRaw = (req.body as Record<string, unknown> | undefined)?.project_id;
    const projectId =
      typeof projectIdRaw === 'number'
        ? String(projectIdRaw)
        : typeof projectIdRaw === 'string'
          ? projectIdRaw.trim()
          : null;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) {
      res.status(400).json({ error: 'invalid_project_id' });
      return null;
    }
    return projectId;
  }

  /**
   * An ACTIVE registration that proved control holds the project: no other
   * wallet can begin or verify for it.
   */
  async function heldByAnotherProvenWallet(userId: string, installationId: string): Promise<boolean> {
    const existing = await getServiceInstallByInstallationId(deps.db, PROVIDER, installationId);
    return existing !== null && existing.revoked_at === null && existing.user_id !== userId
      && installControlProven(existing);
  }

  /** Step 1 (both auth variants): a fresh deploy key for this wallet and project. */
  async function beginForUser(userId: string, req: Request, res: Response): Promise<Response> {
    const installationId = parseInstallationId(req, res);
    if (installationId === null) return res;
    if (await heldByAnotherProvenWallet(userId, installationId)) {
      return res.status(409).json({ error: 'project_already_linked' });
    }
    const attempt = await beginDeployKeyAttempt(deps.db, {
      walletId: userId,
      provider: PROVIDER,
      installationId,
      now: now(),
    });
    return res.status(200).json({
      project_id: installationId,
      public_key: attempt.publicKey,
      key_fingerprint: attempt.keyFingerprint,
      expires_at: attempt.expiresAt,
      instructions: deployKeyInstructions(PROVIDER),
    });
  }

  /**
   * Step 2 (both auth variants): prove the deploy key reads the named path,
   * then register. The same wallet registering again keeps its webhook secret.
   */
  async function verifyForUser(userId: string, req: Request, res: Response): Promise<Response> {
    const installationId = parseInstallationId(req, res);
    if (installationId === null) return res;
    const projectPath = normalizeProjectPath(PROVIDER, (req.body as Record<string, unknown> | undefined)?.project_path);
    if (projectPath === null) {
      return res.status(400).json({ error: 'invalid_project_path' });
    }
    if (await heldByAnotherProvenWallet(userId, installationId)) {
      return res.status(409).json({ error: 'project_already_linked' });
    }

    const verified = await verifyDeployKeyAttempt(deps.db, {
      walletId: userId,
      provider: PROVIDER,
      installationId,
      projectPath,
      ...(options.runProbe ? { runner: options.runProbe } : {}),
      now,
    });
    if (!verified.ok) {
      return res.status(httpStatusForVerifyFailure(verified.reason)).json({ error: verified.reason });
    }

    const existing = await getServiceInstallByInstallationId(deps.db, PROVIDER, installationId);
    const heldByOther = existing !== null && existing.revoked_at === null && existing.user_id !== userId;
    let created: Awaited<ReturnType<typeof createServiceInstall>>;
    try {
      created = await createServiceInstall(deps.db, {
        user_id: userId,
        provider: PROVIDER,
        installation_id: installationId,
        control_proof: verified.proof,
      });
    } catch (err) {
      // Two wallets verifying at once: the transactional guard inside
      // createServiceInstall decides.
      if (err instanceof ServiceInstallOwnedByOtherUserError) {
        return res.status(409).json({ error: 'project_already_linked' });
      }
      throw err;
    }
    const { doc, secretIssued } = created;

    let peId: string | null = null;
    if (!existing || heldByOther) {
      try {
        const { peId: id } = await generatePE(deps, {
          walletId: userId,
          agentId: userId,
          actorAddress: '',
          actionType: 'service_install_created',
          metadata: { provider: PROVIDER, installation_id: installationId },
        });
        peId = id;
      } catch {
        // PE emission is best-effort; the install row is the source of truth.
      }
    }
    const removeKey = 'The relay has deleted its private key. Remove the deploy key from the project now; it is never used again.';
    // The per-install secret is disclosed ONCE — on the call that minted it
    // (pitfall #26 pattern). Rotation = revoke, then register again.
    return res.status(200).json({
      linked: true,
      control_proven: true,
      project_id: installationId,
      project_path: projectPath,
      pe_id: peId,
      webhook_secret: secretIssued ? doc.webhook_secret : null,
      webhook_secret_already_issued: !secretIssued,
      setup: secretIssued
        ? 'In your GitLab project: Settings > Webhooks > Add new webhook. URL: '
          + 'https://api.provian.ai/v1/witnesses/gitlab/webhook — Secret token: the webhook_secret '
          + 'above (shown only this once) — Triggers: Push events + Merge request events. '
          + removeKey
        : 'Secret already issued for this project. To rotate: POST '
          + `/v1/witnesses/gitlab/installs/${installationId}/revoke, then register again. `
          + removeKey,
    });
  }

  function configured(res: Response): boolean {
    if (config.enabled && config.webhookSecret) return true;
    res.status(503).json({ error: 'gitlab_webhook_not_configured' });
    return false;
  }

  /** Registration is begin + verify; the single-call form names that. */
  function registrationMoved(res: Response): Response {
    return res.status(400).json({
      error: 'deploy_key_proof_required',
      hint: 'Register in two steps: POST /v1/witnesses/gitlab/installs/begin with { project_id }, add the returned '
        + 'public_key to the project as a deploy key, then POST /v1/witnesses/gitlab/installs/verify with '
        + '{ project_id, project_path } (wallet auth: /v1/witnesses/gitlab/wallet/installs/begin and /verify).',
    });
  }

  function deviceOwner(req: Request, res: Response): string | null {
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      res.status(401).json({ error: 'no_device_owner' });
      return null;
    }
    return userId;
  }

  /** POST /gitlab/installs/begin - DeviceKey auth, body { project_id }. */
  router.post('/gitlab/installs/begin', authenticateDevice, answering(async (req: Request, res: Response) => {
    if (!configured(res)) return res;
    const userId = deviceOwner(req, res);
    return userId === null ? res : beginForUser(userId, req, res);
  }));

  /**
   * POST /gitlab/installs/verify - DeviceKey auth, body { project_id, project_path }.
   * Registers the project under the caller's wallet so inbound webhook
   * deliveries for it attribute to them. Emits service_install_created on first
   * registration.
   */
  router.post('/gitlab/installs/verify', authenticateDevice, answering(async (req: Request, res: Response) => {
    if (!configured(res)) return res;
    const userId = deviceOwner(req, res);
    return userId === null ? res : verifyForUser(userId, req, res);
  }));

  /**
   * POST /gitlab/wallet/installs/begin and /verify - wallet auth. The phone's
   * variants (it has no DeviceKey identity): same id space, same proof, same
   * one-time webhook_secret disclosure, same hijack guard.
   */
  router.post('/gitlab/wallet/installs/begin', authenticateWalletOwner, answering(async (req: Request, res: Response) => {
    if (!configured(res)) return res;
    return beginForUser(req.walletOwnerId as string, req, res);
  }));
  router.post('/gitlab/wallet/installs/verify', authenticateWalletOwner, answering(async (req: Request, res: Response) => {
    if (!configured(res)) return res;
    return verifyForUser(req.walletOwnerId as string, req, res);
  }));

  router.post('/gitlab/installs', authenticateDevice, answering(async (_req: Request, res: Response) => registrationMoved(res)));
  router.post('/gitlab/wallet/installs', authenticateWalletOwner, answering(async (_req: Request, res: Response) => registrationMoved(res)));

  /**
   * GET /gitlab/installs - DeviceKey auth. Lists the caller's linked GitLab
   * projects (active and revoked).
   */
  router.get('/gitlab/installs', authenticateDevice, answering(async (req: Request, res: Response) => {
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
          control_proven: installControlProven(i),
        })),
    });
  }));

  /**
   * POST /gitlab/installs/:installation_id/revoke - DeviceKey auth. Caller
   * must own the install. Sets revoked_at; the webhook handler then returns
   * 410 for that project. Idempotent on an already-revoked install.
   */
  router.post(
    '/gitlab/installs/:installation_id/revoke',
    authenticateDevice,
    answering(async (req: Request, res: Response) => {
      const installationId = req.params.installation_id;
      if (!installationId) {
        return res.status(400).json({ error: 'missing_installation_id' });
      }
      if (!isUsableInstallationId(installationId)) {
        return res.status(404).json({ error: 'install_not_found' });
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
    }),
  );

  /**
   * POST /gitlab/webhook - no auth middleware; the handler verifies the
   * X-Gitlab-Token itself (verify-before-parse). rawBody is captured by the
   * express.json() verify hook in server.ts.
   */
  router.post('/gitlab/webhook', answering(async (req: Request, res: Response) => {
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
    const result = await handleGitLabWebhook(deps, {
      rawBody,
      tokenHeader: req.header('X-Gitlab-Token') ?? undefined,
      eventType: req.header('X-Gitlab-Event') ?? undefined,
      deliveryId: req.header('X-Gitlab-Event-UUID') ?? undefined,
      config,
    });
    res.status(result.status).json(result.body);
  }));

  return router;
}
