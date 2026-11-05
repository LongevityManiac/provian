/**
 * GET /v1/wallet/launch-state — the launch switch, as the app reads it.
 *
 * The app's Connect screen offers the MCP and SDK options and the npx / CLI / MCP fleet
 * commands; they need the published packages and the open `/mcp` surface, which arrive at the
 * flip. The Devices note names the same moment. Each reads THIS answer, so nothing in the app or
 * relay needs an edit at the flip: setting `PUBLIC_LAUNCH=true` opens `/mcp`, turns the
 * wallet-create welcome's MCP pointer from `opens_at_launch` into a plain URL, and flips this read.
 *
 * One predicate: `isPublicDiscoveryOpen` (exactly `PUBLIC_LAUNCH === 'true'`, the value the
 * welcome's `gated()` reads). Unknown is closed. Read per request, never captured at mount.
 *
 * Wallet auth: the answer is a single boolean, but an anonymous read that says "not launched"
 * would disclose the network before the flip, which the public gates exist to prevent.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { isPublicDiscoveryOpen } from './middleware/public-launch-gate';

export interface LaunchStateResponse {
  /** The flip has happened: the published packages and `/mcp` are live. */
  launched: boolean;
  /** The hosted MCP server an agent adds (open when `launched`). */
  mcp_url: string;
}

export function launchState(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): LaunchStateResponse {
  const apiBase = (env.API_BASE_URL || 'https://api.provian.ai').replace(/\/+$/, '');
  return { launched: isPublicDiscoveryOpen(env), mcp_url: `${apiBase}/mcp` };
}

export interface LaunchStateRouterDeps {
  authenticate: RequestHandler;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function createLaunchStateRouter(deps: LaunchStateRouterDeps): Router {
  const router = Router();
  router.get('/', deps.authenticate, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(launchState(deps.env ?? process.env));
  });
  return router;
}
