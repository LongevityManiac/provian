/**
 * PRE-LAUNCH SURFACE GATE — one place that closes every PUBLIC-VIEW surface an anonymous caller
 * could reach before the launch flip.
 *
 * WHY A CENTRAL GATE AND NOT 78 EDITS. `publicDiscoveryGate` already existed and was already
 * correct, and it was mounted on exactly three routers. Everything else was one forgotten line
 * away from open, and a full AST sweep found it had been forgotten a lot: with `PUBLIC_LAUNCH`
 * false and discovery "closed", an unauthenticated caller could still read
 * `GET /v1/agents/directory` (200), the whole Commons read surface (200), the contract registry
 * (200), the PE type catalog and proposals (200) — and reach the VALIDATOR of the two doors that
 * issue agent credentials, `GET /v1/agent/wallet/challenge` and `/parent-challenge` (400).
 *
 * A 400 where a 401 belongs is the signature: the request got past every gate and was refused by
 * the handler's own argument checking. That is not a closed door, it is an open door with a form
 * behind it.
 *
 * Per-route fixes would leave the same failure mode in place for the NEXT route. This gate is
 * mounted once, ahead of everything, and its surface list is asserted against the generated
 * reachability matrix by `pre-launch-surface-gate.test.ts` so a newly added open route fails a
 * test instead of quietly serving the world.
 *
 * WHAT STAYS CLOSED vs WHAT OPENS. "Live, not shown" narrows this gate to the PUBLIC VIEW
 * only — the marketing/discovery/community surfaces a launch would reveal. The agent RAIL is
 * opened so an operator can invite an agent from the app the way a human would and the agent can
 * complete its own signup: `/v1/agent/wallet` (challenge/create/invite/accept), the agent
 * connect door, the permissionless PE-type discovery surfaces, the scam-contract list, and bond
 * state. `PUBLIC_LAUNCH` stays `false`; only the marketing/community VIEW stays dark. The Commons
 * surface stays closed in full (§A5): it IS the public community view, and nothing in the agent
 * rail routes through it.
 *
 * FAIL CLOSED. Only the exact string `'true'` in `PUBLIC_LAUNCH` opens these surfaces. Unset,
 * `'TRUE'`, `'1'`, `'yes'`, whitespace — all closed. 404, not 403, because a 403 confirms the
 * surface exists, which is the disclosure being closed.
 *
 * THIS GATE ADDS A REFUSAL. It grants nothing, authenticates nobody, and cannot open a surface
 * that was closed by some other means: it either 404s or calls `next()`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasBearerCredential } from './public-launch-gate';

export const PUBLIC_LAUNCH_ENV = 'PUBLIC_LAUNCH';

/**
 * Surfaces HARD-closed before launch: 404 for EVERY caller, credentialed or not, until the flip.
 * Prefix match on the request path.
 *
 * This is the PUBLIC-VIEW set: marketing/discovery/community disclosure that a launch would
 * reveal. Derived from the AST reachability matrix plus a live unauthenticated probe of every
 * open GET against production; every entry here was observed either serving data (200), reaching
 * a handler's validator (400), or crashing inside a handler (500) with no credential presented.
 * The phone app does not consume any of these as a wallet-runtime fetch, so the operator’s app-posture
 * ruling does not reach them. (The former `/v1/attestation` B6 commerce-attestation
 * surface was removed outright in; merchants verify via `/v1/present` only.)
 *
 * The agent-rail surfaces that USED to sit here (`/v1/agent/wallet`, `/v1/relay/agent/connect`,
 * the `/v1/pe/*` discovery surfaces, `/v1/security/scam-contracts`, `/v1/bonds`, `/v1/provisional`)
 * were removed in so the invite → signup flow works with `PUBLIC_LAUNCH` still false. They
 * are the deliberate-exception set in `pre-launch-surface-gate.test.ts`.
 */
export const CLOSED_PRE_LAUNCH_PREFIXES: readonly string[] = [
  '/v1/admin/contract-registry',
  '/v1/agent/profile',        // agent disclosure
  '/v1/agents',               // directory (200), profiles, records, badges
  // decision 5: the public earning-type projection behind provian.ai/proposals
  // (queue + rulings + served matrix). A public VIEW like every other — closed
  // pre-flip, opens with everything else. The submit path is unaffected (this is
  // /v1/pe/earning-proposals, not /v1/pe/submit).
  '/v1/pe/earning-proposals',
  '/v1/leaderboard',
  '/v1/names',                // work package O8 name registry public forward lookup (name→agent).
                              // Dark pre-flip; opens with Commons.
  '/v1/pledges',              // work package O5 burn-backed public pledge verify.
                              // Dark pre-flip; opens with Commons.
  '/v1/reputation',
  '/v1/standing',             // work package O9 burn-backed standing-export public verify.
                              // Dark pre-flip; opens with Commons.
  '/v1/x402',                 // : the public x402 seller list. A public VIEW of the
                              // sellers the agent directory also lists; dark pre-flip like it.
                              // (The facilitator's own report route is /v1/internal/x402, untouched.)
];

/**
 * Surfaces the PHONE APP consumes that must serve a wallet-authed caller BEFORE the flip
 * (, the invariant: the apps are gated by not being published, not by
 * PUBLIC_LAUNCH). Prefix match. These stay 404 for an ANONYMOUS (keyless) caller pre-flip —
 * so the public-web non-disclosure posture is UNCHANGED — but a caller presenting a Bearer
 * credential (which the app always does) passes.
 *
 * /v1/commons — the human-jobs pay/hire path (post → accept → fund → complete),
 * plus the app's forum/profile Commons reads. NOTE: the runtime
 * boundary (wp2-runtime-boundary.ts) independently 503s the Commons
 * ECONOMIC institutions — only `/v1/commons/jobs` is opened there
 *; market/bank/court/bonds/governance stay 503 even here.
 * /v1/contract-registry — CryptoTransactionClassifier's known-contract supplement.
 * /v1/community — the identity-free community-updates opt-in
 * (routes/community.ts). The onboarding/settings
 * screens and the CLI call it with a Bearer present;
 * the handler authenticates nobody and stores no
 * identity. Anonymous public-web stays 404 pre-flip.
 *
 * This is NOT authorization: routes behind these prefixes keep their own auth (the human-jobs
 * routes are poster-/worker-only via `requireAuth`). This gate suppresses anonymous discovery.
 */
export const APP_AUTHED_PRELAUNCH_PREFIXES: readonly string[] = [
  '/v1/commons',
  '/v1/community',
  '/v1/contract-registry',
  // Commons communication: threads (bilateral, party-authed) and the wants board (posting
  // is Commons speech the app and the SDK drive with a credential). Anonymous public-web stays
  // 404 pre-flip; the reads open with everything else at the flip.
  '/v1/threads',
  '/v1/wants',
];

export function isPublicLaunchOpen(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[PUBLIC_LAUNCH_ENV] === 'true';
}

export function isClosedPreLaunch(path: string): boolean {
  return CLOSED_PRE_LAUNCH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function isAppAuthedPreLaunch(path: string): boolean {
  return APP_AUTHED_PRELAUNCH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The agent-to-agent LOOKUP read (burn-to-present READS): one agent reading
 * ANOTHER agent's full public provenance record. Sits UNDER `/v1/agents` (which is
 * hard-closed for anonymous callers), but is a decided requirement to be reachable
 * agent-to-agent at launch WITHOUT the PUBLIC_LAUNCH flip. So a CREDENTIALED caller
 * (any Bearer — an agent) passes pre-flip, exactly like the app-authed surfaces,
 * while an anonymous public-web caller still 404s and the rest of `/v1/agents`
 * (directory, badges, other disclosure) stays dark. The per-route
 * `appClientDiscoveryGate` on `/provenance` applies the same Bearer admission.
 */
export function isCredentialedAgentLookup(path: string): boolean {
  return /^\/v1\/agents\/[^/]+\/provenance$/.test(path);
}

export function preLaunchSurfaceGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Read per REQUEST, never captured at mount: a gate that cannot be re-closed without a
    // redeploy is a gate that lies about when its decision was made.
    if (isPublicLaunchOpen(env)) { next(); return; }

    // Express routes case-insensitively, so match on the lowercased path: `/V1/AGENTS/...`
    // reaches the same handler as `/v1/agents/...` and must meet the same gate.
    const path = req.path.toLowerCase();

    // App-consumed surfaces open to a credentialed caller (the app) pre-flip, but stay dark
    // for anonymous callers (fall through to the 404 below when no Bearer is present).
    if (isAppAuthedPreLaunch(path) && hasBearerCredential(req)) { next(); return; }

    // The agent-to-agent lookup read (burn-to-present) opens to a credentialed
    // caller pre-flip, exactly like the app-authed surfaces — anonymous still 404s.
    if (isCredentialedAgentLookup(path) && hasBearerCredential(req)) { next(); return; }

    if (isClosedPreLaunch(path) || isAppAuthedPreLaunch(path)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    next();
  };
}
