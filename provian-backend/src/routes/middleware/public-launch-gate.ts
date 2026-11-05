/**
 * The one predicate that decides whether PUBLIC discovery surfaces exist.
 *
 * "Public discovery" means anything an UNAUTHENTICATED visitor can reach that
 * describes the network or the agents in it: the leaderboard, agent profiles,
 * public provenance records, badges. Before the launch flip none of it should
 * be reachable — not because the data is secret, but because reaching it
 * discloses that the network, its agents, and the Genesis campaign exist.
 *
 * WHY THIS IS A MODULE. The convention already existed and was already correct
 * (`process.env.PUBLIC_LAUNCH !== 'true'` → 404), but it was written out
 * per-router, so a new public surface was one forgotten line away from being
 * open. The leaderboard and the agent-profile/provenance routes were exactly
 * that: both served 200 to an anonymous caller with `PUBLIC_LAUNCH=false`, and
 * the leaderboard payload carried a `genesis_agent` badge.
 *
 * FAIL CLOSED ON UNKNOWN. Only the exact string `'true'` opens the surface.
 * Unset, empty, `'TRUE'`, `'1'`, `'yes'`, whitespace — every one of them is a
 * closed gate. There is no truthiness coercion, because a variable that got
 * mangled in a deploy must not read as consent.
 *
 * This gate ADDS a refusal. It grants nothing and opens nothing.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isMcpAccessPermitted, type McpAccessEnv } from '../mcp-access';

/** The variable that opens public discovery. */
export const PUBLIC_LAUNCH_ENV = 'PUBLIC_LAUNCH';

/**
 * True only for the exact string `'true'`. Every other value — including
 * absent, `'TRUE'`, `'1'`, and `' true '` — is closed.
 */
export function isPublicDiscoveryOpen(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[PUBLIC_LAUNCH_ENV] === 'true';
}

/**
 * Express middleware: 404 every request on this router while public discovery
 * is closed. Mount it FIRST on any router that serves unauthenticated
 * network/agent data.
 *
 * 404 rather than 403 on purpose: a 403 confirms the surface exists, which is
 * the disclosure this is closing.
 */
export function publicDiscoveryGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Read per REQUEST, not at mount: a router captured at boot cannot be
    // re-closed, and admission that depends on a captured value is a lie about
    // when the decision was made.
    if (!isPublicDiscoveryOpen(env)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
}

/**
 * Pull the API-key ID (the part before the `:` in `Bearer <key>:<secret>`) off a
 * request. Parsing only — never validation; the value is used solely to consult
 * the MCP onboarding allowlist, exactly as `/mcp` admission does.
 */
function bearerApiKeyId(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const separator = token.indexOf(':');
  if (separator === -1) return null;
  const keyId = token.slice(0, separator);
  return keyId.length > 0 ? keyId : null;
}

/**
 * The non-empty Bearer token on a request, or null. Parsing only — this NEVER
 * validates the token. It answers exactly one question: "did the caller present
 * a credential at all?" which is what separates the phone app (always sends a
 * wallet HMAC / agent key) from an anonymous public-web visitor (sends nothing).
 * Shared so the app-client gate here and the pre-launch surface gate cannot
 * drift on what "credential present" means (self-referential control).
 */
export function hasBearerCredential(req: Request): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length).trim().length > 0;
}

/**
 * Discovery admission for surfaces the PHONE APP consumes that would otherwise
 * be dark until the launch flip.
 *
 * WHY THIS EXISTS (the invariant: ,). The phone apps are gated
 * by NOT BEING PUBLISHED, not by `PUBLIC_LAUNCH`. A wallet-authed human on the
 * unpublished app, against production, must see their real PVT9 balance and
 * spend it with `PUBLIC_LAUNCH` still false. `publicDiscoveryGate` (launch-only)
 * makes that impossible: it 404s the app's own reads before the flip. This
 * predicate admits on public launch OR when the caller presents ANY Bearer
 * credential — which the app always does and an anonymous public-web visitor
 * never does. The public-web non-disclosure posture is therefore UNCHANGED:
 * a keyless caller still gets 404.
 *
 * It is NOT an authorization control and validates NOTHING — exactly like
 * {@link isAgentRecordDiscoveryAdmissible}, it decides DISCOVERY only. A route
 * that needs real authz keeps its own auth middleware AFTER the gate (e.g.
 * `/allocation` runs `authenticatePVTDual`, which is the check that a caller may
 * see the requested wallet). The data these reads expose is public at flip and,
 * for `/balance`, public on-chain regardless; this suppresses casual discovery,
 * not a determined prober who already knows the exact path and sends a token.
 */
export function isAppClientDiscoveryAdmissible(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isPublicDiscoveryOpen(env) || hasBearerCredential(req);
}

/**
 * Express middleware form of {@link isAppClientDiscoveryAdmissible}. Mount it
 * PER ROUTE (never `router.use`), exactly as `publicDiscoveryGate` is mounted,
 * on the app-consumed read routes that must serve the unpublished app pre-flip.
 * 404 (not 403) on refusal, to preserve non-disclosure against anonymous
 * callers.
 */
export function appClientDiscoveryGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAppClientDiscoveryAdmissible(req, env)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
}

/**
 * Discovery admission for the two agent-record READ paths that
 * `get_agent_record` reaches — its primary (`/v1/agents/:id/record`) and its
 * fallback (`/v1/agents/:id/profile`).
 *
 * WHY A SECOND PREDICATE. `publicDiscoveryGate` is auth-blind: it opens ONLY on
 * `PUBLIC_LAUNCH === 'true'`. That is correct for the leaderboard and the
 * network-wide surfaces, but it defeats the MCP onboarding rule for these two:
 * an agent key admitted at `/mcp` (routes/mcp-access.ts) passes the transport
 * door and then hits a 404 here, so it can never actually read an agent's public
 * record while the product is dark — which is the entire point of
 * onboarding-before-launch.
 *
 * This predicate adds EXACTLY that one exemption and nothing else: it admits on
 * public launch OR when the caller presents a key while MCP onboarding is on,
 * judged by the SAME `isMcpAccessPermitted` the `/mcp` gate uses (open on
 * `MCP_AGENT_ONBOARDING`; retired the key allowlist). It does NOT open the
 * surface to anonymous (keyless) callers or when onboarding is off — those still
 * 404. The `keyId !== null` check keeps this narrower than `/mcp` itself: a
 * keyless caller is admitted to the transport but not to reading a record early.
 * The data it exposes (an agent's public provenance record/profile) is open to
 * everyone at launch anyway. It grants no write and touches no other route.
 */
export function isAgentRecordDiscoveryAdmissible(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (isPublicDiscoveryOpen(env)) return true;
  const keyId = bearerApiKeyId(req);
  return keyId !== null && isMcpAccessPermitted(keyId, env as McpAccessEnv);
}

/**
 * Express middleware form of {@link isAgentRecordDiscoveryAdmissible}. Mount it
 * PER ROUTE (never `router.use`) on the agent record/profile read routes only,
 * exactly as `publicDiscoveryGate` is mounted, so it closes its own routes and
 * lets everything else fall through.
 */
export function agentRecordDiscoveryGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAgentRecordDiscoveryAdmissible(req, env)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
}
