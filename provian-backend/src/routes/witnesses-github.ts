/** GitHub App webhook ingress authenticates and durably stores before acknowledgement.
 * Earning, corroboration and PR gate reconciliation run under the scheduled inbox worker.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { acceptGitHubWebhook } from '../core/witnesses/github-webhook-inbox';
import { loadGitHubAppConfig } from '../core/witnesses/github-app-config';
import {
  startPendingConnect,
  markPendingCompleted,
  pollAndFinalize,
  buildInstallUrl,
  isValidState,
} from '../core/witnesses/github-connect';
import {
  getServiceInstallByInstallationId,
  getServiceInstallsByUser,
  markServiceInstallRevoked,
} from '../core/witnesses/service-installs';
import { emitServiceInstallRevokedPE } from '../core/witnesses/github-connect';
import { createDeviceAuthMiddleware } from './middleware/device-auth';
import { createWalletOwnerAuthMiddleware } from './middleware/wallet-owner-auth';

/**
 * Factory: returns a Router with POST /github/webhook mounted.
 *
 * Mounted by server.ts at `/v1/witnesses` so the full path is
 * `POST /v1/witnesses/github/webhook`.
 *
 * Config is loaded at factory time (matches the existing
 * read-once-at-startup pattern). Disabling the connector means
 * unsetting GITHUB_APP_WEBHOOK_SECRET and restarting - the route
 * stays mounted but every request returns 503.
 */
export function createWitnessesGitHubRouter(deps: AgentBankDeps): Router {
  const router = Router();
  const config = loadGitHubAppConfig();
  const authenticateDevice = createDeviceAuthMiddleware(deps.db);

  // -------------------------------------------------------------------------
  // Wallet auth for the phone-initiated connect flow.
  //
  // Extracted to middleware/wallet-owner-auth.ts (shared with the GitLab /
  // Bitbucket wallet install variants and the cross-provider installs
  // router). Resolves the wallet auth token to the wallets-collection doc
  // id (req.walletOwnerId), matching the DeviceKey path's owner_wallet_id
  // id space. Wallet auth and agent session auth stay strictly separate.
  // -------------------------------------------------------------------------
  const authenticateWalletOwner = createWalletOwnerAuthMiddleware({
    db: deps.db,
    cache: deps.cache,
  });

  // -------------------------------------------------------------------------
  // Connect flow (step 4c) - user-initiated install via CLI / mobile.
  //
  // The USER authorizes ON github.com. Provian never collects a GitHub
  // credential, never holds a token. The flow only registers a pending
  // session keyed by a 32-byte hex state nonce; GitHub redirects the
  // user's browser back to /setup-callback with installation_id; the
  // CLI's authenticated /connect/poll then materializes the
  // service_installs row + emits the service_install_created PE.
  //
  // All connect endpoints require GITHUB_APP_SLUG to be configured.
  // The webhook endpoint above does NOT - it's independent.
  // -------------------------------------------------------------------------

  /**
   * POST /github/connect/start - DeviceKey auth, body { state: hex64 }.
   * Returns { install_url, expires_at }. Refuses 503 when connect not
   * configured.
   */
  router.post('/github/connect/start', authenticateDevice, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret || !config.appSlug) {
      return res.status(503).json({ error: 'github_connect_not_configured' });
    }
    const state = (req.body as Record<string, unknown> | undefined)?.state;
    if (!isValidState(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    const pending = await startPendingConnect(deps, state, userId);
    if (!pending) {
      // State collision with a different user - refuse
      return res.status(409).json({ error: 'state_in_use' });
    }
    return res.status(200).json({
      install_url: buildInstallUrl(config.appSlug, state),
      expires_at: pending.expires_at,
    });
  });

  /**
   * POST /github/connect/wallet/start - Wallet auth, body { state: hex64 }.
   * Phone-initiated variant of /connect/start: same pending-connect
   * collection, same state-nonce threat model (32-byte nonce, 5-min TTL,
   * per-state doc, cross-user collision refused). Returns
   * { install_url, expires_at }.
   */
  router.post('/github/connect/wallet/start', authenticateWalletOwner, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret || !config.appSlug) {
      return res.status(503).json({ error: 'github_connect_not_configured' });
    }
    const state = (req.body as Record<string, unknown> | undefined)?.state;
    if (!isValidState(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }
    const userId = req.walletOwnerId as string;
    const pending = await startPendingConnect(deps, state, userId);
    if (!pending) {
      return res.status(409).json({ error: 'state_in_use' });
    }
    return res.status(200).json({
      install_url: buildInstallUrl(config.appSlug, state),
      expires_at: pending.expires_at,
    });
  });

  /**
   * GET /github/connect/wallet/poll?state=hex64 - Wallet auth.
   * Phone-initiated variant of /connect/poll. Identical semantics:
   * wrong-user reads as 'expired' (no existence leak), first poll after
   * completion materializes the install + emits the
   * service_install_created PE, subsequent polls are idempotent.
   */
  router.get('/github/connect/wallet/poll', authenticateWalletOwner, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret || !config.appSlug) {
      return res.status(503).json({ error: 'github_connect_not_configured' });
    }
    const state = req.query.state;
    if (!isValidState(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }
    const userId = req.walletOwnerId as string;
    const result = await pollAndFinalize(deps, state, userId);
    return res.status(200).json(result);
  });

  /**
   * GET /github/setup-callback - NO auth (GitHub redirects the user's
   * browser here; GitHub cannot authenticate to us). Looks up pending
   * by state, marks completed with the supplied installation_id, and
   * returns a small HTML response. The install is NOT created here -
   * the authenticated CLI poll creates it after validating the state's
   * user_id matches the auth context.
   *
   * Response body is intentionally generic ("you may close this
   * window") for both success and unknown/expired state cases so the
   * URL can't be used to enumerate valid state values.
   */
  router.get('/github/setup-callback', async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret || !config.appSlug) {
      return res.status(503).type('text/html').send(
        '<!doctype html><meta charset="utf-8"><title>Provian</title>' +
        '<p>GitHub App connector is not configured for this environment. You may close this window.</p>',
      );
    }
    const state = req.query.state;
    const installationId = req.query.installation_id;
    const setupAction = req.query.setup_action;
    if (typeof setupAction !== 'string' || setupAction !== 'install') {
      return res.status(200).type('text/html').send(
        '<!doctype html><meta charset="utf-8"><title>Provian</title>' +
        '<p>No install action to record. You may close this window.</p>',
      );
    }
    // A GitHub installation id is a decimal integer. Anything else is refused here
    // (markPendingCompleted refuses it too) so no attacker-shaped value is recorded.
    if (typeof installationId !== 'string' || typeof state !== 'string' || !/^[0-9]{1,20}$/.test(installationId)) {
      return res.status(400).type('text/html').send(
        '<!doctype html><meta charset="utf-8"><title>Provian</title>' +
        '<p>Missing required parameters. You may close this window.</p>',
      );
    }
    await markPendingCompleted(deps, state, installationId);
    // Generic 200 either way - success or no-op (unknown / expired / already-completed)
    return res.status(200).type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Provian</title>' +
      '<p>GitHub App install received. You may close this window and return to your terminal.</p>',
    );
  });

  /**
   * GET /github/connect/poll?state=hex64 - DeviceKey auth.
   * Returns { status, install_id?, pe_id? }. Idempotent on completion.
   * Wrong-user → 'expired' (no information leak).
   */
  router.get('/github/connect/poll', authenticateDevice, async (req: Request, res: Response) => {
    if (!config.enabled || !config.webhookSecret || !config.appSlug) {
      return res.status(503).json({ error: 'github_connect_not_configured' });
    }
    const state = req.query.state;
    if (!isValidState(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    const result = await pollAndFinalize(deps, state, userId);
    return res.status(200).json(result);
  });

  /**
   * GET /github/installs - DeviceKey auth. Returns the authenticated
   * user's connected GitHub installs as
   * `{ installs: [{ installation_id, installed_at, revoked_at }] }`.
   *
   * Consume-only list view for the mobile "connected services" screen and
   * the CLI. Returns both active and revoked installs (revoked rows carry a
   * non-null `revoked_at`) so the client can render history; an empty list
   * is a normal 200 response. Does NOT gate on the connect config - listing
   * your own already-recorded installs is independent of whether new
   * connects are currently enabled.
   */
  router.get('/github/installs', authenticateDevice, async (req: Request, res: Response) => {
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    const installs = await getServiceInstallsByUser(deps.db, userId);
    return res.status(200).json({
      installs: installs.map((i) => ({
        installation_id: i.installation_id,
        installed_at: i.installed_at,
        revoked_at: i.revoked_at ?? null,
      })),
    });
  });

  /**
   * POST /github/installs/:installation_id/revoke - DeviceKey auth.
   * Caller must own the install. Sets revoked_at, emits a
   * service_install_revoked PE. Idempotent on an already-revoked install.
   *
   * Does NOT call GitHub to uninstall. The user removes the app on
   * github.com themselves; the relay simply stops honoring the install
   * (the webhook handler from step 4b already returns 410 for revoked
   * installs).
   */
  router.post('/github/installs/:installation_id/revoke', authenticateDevice, async (req: Request, res: Response) => {
    const installationId = req.params.installation_id;
    if (!installationId) {
      return res.status(400).json({ error: 'missing_installation_id' });
    }
    const userId = req.device?.owner_wallet_id;
    if (!userId) {
      return res.status(401).json({ error: 'no_device_owner' });
    }
    const install = await getServiceInstallByInstallationId(deps.db, 'github', installationId);
    if (!install) {
      return res.status(404).json({ error: 'install_not_found' });
    }
    if (install.user_id !== userId) {
      // Owner mismatch - return 404 (not 403) so a probe can't enumerate other
      // users' installations.
      return res.status(404).json({ error: 'install_not_found' });
    }
    if (install.revoked_at !== null) {
      return res.status(200).json({ revoked: true, idempotent: true });
    }
    await markServiceInstallRevoked(deps.db, 'github', installationId);
    const peId = await emitServiceInstallRevokedPE(deps, userId, installationId);
    return res.status(200).json({ revoked: true, pe_id: peId });
  });

  router.post('/github/webhook', async (req: Request, res: Response) => {
    // rawBody is captured by app.use(express.json({ verify: ... })) at
    // server.ts:142-149. Body is also already JSON-parsed by the time
    // we get here, but we DO NOT use req.body - the handler re-parses
    // rawBody itself, AFTER signature verification, to enforce
    // verify-before-parse.
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';

    const signatureHeader = req.header('X-Hub-Signature-256') ?? undefined;
    const eventType = req.header('X-GitHub-Event') ?? undefined;
    const deliveryId = req.header('X-GitHub-Delivery') ?? undefined;

    const result = await acceptGitHubWebhook(deps, {
      rawBody,
      signatureHeader,
      eventType,
      deliveryId,
      config,
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
