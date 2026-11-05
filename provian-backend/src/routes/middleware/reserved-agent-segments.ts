/**
 * Reserved-segment pass-through for the legacy /v1/agents/:agentId routes.
 *
 * server.ts registers the legacy AI-controls agent lookup
 * (`app.get('/v1/agents/:agentId', authenticate, …)` and its PUT/DELETE
 * siblings) THOUSANDS of lines before the public agent-directory router is
 * mounted on the same prefix. Express matches routes in registration order,
 * so without this guard the param route swallows every single-segment
 * /v1/agents/* path — `GET /v1/agents/directory` resolved with
 * `agentId="directory"` and 401'd unauthenticated callers before the PUBLIC
 * `GET /directory` handler was ever consulted (live-verified on prod
 * 2026-07-07; the ecosystem guide advertises that route as a public read).
 *
 * The guard runs BEFORE `authenticate` in the route chain and calls
 * `next('route')` for reserved names, which skips the rest of the legacy
 * route's handler stack and lets Express continue to the routers mounted
 * later. Real agent ids are untouched — auth on the legacy lookup is exactly
 * as strict as before.
 *
 * If you add a NEW single-segment path under /v1/agents (mounted after
 * ~server.ts:2440), add its first segment here or it will be shadowed the
 * same way. Two-segment paths (`/:identifier/profile`, `/:id/record`,
 * `/:id/badge.svg`, `/profile/:wallet_id`) are not affected.
 */

import type { NextFunction, Request, Response } from 'express';

/** First path segments under /v1/agents that belong to later-mounted routers. */
export const RESERVED_AGENT_SEGMENTS: ReadonlySet<string> = new Set(['directory']);

export function skipReservedAgentSegments(req: Request, _res: Response, next: NextFunction): void {
  if (RESERVED_AGENT_SEGMENTS.has(req.params.agentId)) {
    next('route');
    return;
  }
  next();
}
