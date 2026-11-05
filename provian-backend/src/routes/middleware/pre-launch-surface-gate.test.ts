/**
 * CONTROL FOR THE PRE-LAUNCH SURFACE GATE.
 *
 * Every claim here is paired with the observation it replaces. The paths and the status codes in
 * `STILL_CLOSED` are not invented: each was probed unauthenticated against production
 * (`https://api.provian.ai`) with `PUBLIC_LAUNCH=false` and answered exactly what is recorded.
 * The gate's job is to turn every one of those into a 404.
 *
 * NARROWED the gate to the public VIEW. The agent-rail surfaces that used to be closed
 * (`/v1/agent/wallet`, the `/v1/pe/*` discovery surfaces — `/v1/relay/agent/connect` was retired by,
 * `/v1/security/scam-contracts`, `/v1/bonds`, `/v1/provisional`) now PASS the gate so the invite →
 * signup flow works with `PUBLIC_LAUNCH` still false. `OPENED_RAIL` is the paired assertion for
 * that: the exact paths that used to 404 now call `next()`, while `STILL_CLOSED` proves the
 * public-view disclosure prefixes are untouched. The operator bypass is gone — its sole purpose
 * was exercising the closed agent-signup door, which is now simply open.
 *
 * The last test is the one that matters over time: it re-derives the open set from the AST
 * reachability matrix and asserts the gate covers it OR names it a deliberate exception. A newly
 * added ungated route fails there rather than quietly serving the world.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import {
  CLOSED_PRE_LAUNCH_PREFIXES,
  APP_AUTHED_PRELAUNCH_PREFIXES,
  isClosedPreLaunch,
  isAppAuthedPreLaunch,
  isCredentialedAgentLookup,
  preLaunchSurfaceGate,
} from './pre-launch-surface-gate';

/**
 * Observed unauthenticated responses from production, `PUBLIC_LAUNCH=false`, that are STILL closed
 * public-view disclosure after. 200 = served real data. 500 = reached the handler and
 * crashed. Every one must be a 404 now.
 */
const STILL_CLOSED: ReadonlyArray<{ path: string; was: number }> = [
  { path: '/v1/agents/directory', was: 200 },
  { path: '/v1/commons/artifacts', was: 200 },
  { path: '/v1/commons/feed', was: 200 },
  { path: '/v1/commons/forum/channels', was: 200 },
  { path: '/v1/commons/forum/trending', was: 200 },
  { path: '/v1/commons/institutions', was: 200 },
  { path: '/v1/commons/register/requirements', was: 200 },
  { path: '/v1/commons/registry', was: 200 },
  { path: '/v1/commons/stats', was: 200 },
  { path: '/v1/contract-registry', was: 200 },
  { path: '/v1/commons/agent/probe-0001/published-pes', was: 500 },
  { path: '/v1/commons/agent/probe-0001/vouches', was: 500 },
  // decision 5: the earning-type projection was a live OPEN read (200);
  // it is now a public VIEW, closed pre-flip like every other.
  { path: '/v1/pe/earning-proposals', was: 200 },
];

/**
 * The exact paths that used to 404 at this gate and now PASS, so the app can invite an
 * agent and the agent can complete its own signup with `PUBLIC_LAUNCH` still false. Each was in
 * the old closed set; each is now a deliberate exception.
 */
const OPENED_RAIL: readonly string[] = [
  '/v1/agent/wallet/challenge',
  '/v1/agent/wallet/parent-challenge',
  '/v1/pe/propose-type',
  '/v1/pe/proposals',
  '/v1/pe/type-catalog',
  '/v1/pe/conformance/action-types',
  '/v1/security/scam-contracts',
  '/v1/bonds/some-bond-id',
];

function run(
  path: string,
  env: Record<string, string | undefined>,
  headers: Record<string, unknown> = {},
): { status: number | null; nexted: boolean } {
  const gate = preLaunchSurfaceGate(env);
  let status: number | null = null;
  let nexted = false;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  gate({ path, headers } as unknown as Request, res, (() => { nexted = true; }) as NextFunction);
  return { status, nexted };
}

describe('pre-launch surface gate', () => {
  describe('public-view disclosure stays closed', () => {
    it.each(STILL_CLOSED)('$path (was $was) → 404', ({ path }) => {
      const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' });
      expect(status).toBe(404);
      expect(nexted).toBe(false);
    });

    // The population must be non-empty and must be the whole list, or "disclosure stays closed"
    // is a claim about nothing. A universally-quantified assertion over an accidentally-empty
    // table passes identically to a correct one.
    it('evaluated the whole still-closed population', () => {
      expect(STILL_CLOSED.length).toBe(13);
    });

    // Express matches routes case-insensitively, so an upper-cased path reaches the same handler.
    // RED control: the raw predicate does NOT recognise the upper-cased form — that is the gap the
    // gate's own lowercasing closes. Without it these would call next() and serve the world.
    it.each(STILL_CLOSED)('$path upper-cased → still 404', ({ path }) => {
      const upper = path.toUpperCase();
      expect(isClosedPreLaunch(upper)).toBe(false);
      const { status, nexted } = run(upper, { PUBLIC_LAUNCH: 'false' });
      expect(status).toBe(404);
      expect(nexted).toBe(false);
    });

  });

  describe('the agent rail now PASSES the gate ', () => {
    // The paired control: the exact same paths that STILL_CLOSED-style probes recorded at 400/500
    // before now reach the route. This is what makes the narrowing real and not a no-op.
    it.each(OPENED_RAIL)('%s → next(), not 404', (path) => {
      const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' });
      expect(nexted).toBe(true);
      expect(status).toBe(null);
    });

    it('non-empty rail population', () => {
      expect(OPENED_RAIL.length).toBe(8); // the retired /v1/relay/agent/connect entry is gone
    });

    // The control the narrowing turns on: an opened prefix passes while a disclosure prefix in the
    // SAME run still 404s. If someone re-broadened the closed list back over the rail, the first
    // assertion flips; if someone emptied the closed list entirely, the second flips.
    it('opens the rail without opening the public view', () => {
      expect(run('/v1/agent/wallet/challenge', { PUBLIC_LAUNCH: 'false' }).nexted).toBe(true);
      expect(run('/v1/agents/directory', { PUBLIC_LAUNCH: 'false' }).status).toBe(404);
      expect(run('/v1/commons/feed', { PUBLIC_LAUNCH: 'false' }).status).toBe(404);
      expect(run('/v1/leaderboard', { PUBLIC_LAUNCH: 'false' }).status).toBe(404);
    });
  });

  describe('fail closed on unknown', () => {
    it.each(['true '])('PUBLIC_LAUNCH=%p does not open the gate', (value) => {
      expect(run('/v1/agents/directory', { PUBLIC_LAUNCH: value }).status).toBe(404);
    });

    it.each([undefined, '', 'TRUE', '1', 'yes', 'True'])(
      'PUBLIC_LAUNCH=%p does not open the gate',
      (value) => {
        expect(run('/v1/agents/directory', { PUBLIC_LAUNCH: value }).status).toBe(404);
      },
    );

    it('only the exact string "true" opens it', () => {
      expect(run('/v1/agents/directory', { PUBLIC_LAUNCH: 'true' }).nexted).toBe(true);
    });
  });

  describe('the gate is a refusal, not a redirect', () => {
    it('passes through paths it does not close', () => {
      for (const p of ['/health', '/v1/users', '/v1/pe/submit', '/v1/devices/register']) {
        expect(run(p, { PUBLIC_LAUNCH: 'false' }).nexted).toBe(true);
      }
    });

    it('does not close a path that merely shares a prefix STRING', () => {
      // `/v1/agentsomething` must not be caught by the `/v1/agents` entry.
      expect(isClosedPreLaunch('/v1/agentsomething')).toBe(false);
      expect(isClosedPreLaunch('/v1/agents')).toBe(true);
      expect(isClosedPreLaunch('/v1/agents/directory')).toBe(true);
    });

    it('the closed set is exactly the public-view prefixes (commons + contract-registry moved to app-authed; earning-proposals projection)', () => {
      expect([...CLOSED_PRE_LAUNCH_PREFIXES]).toEqual([
        '/v1/admin/contract-registry',
        '/v1/agent/profile',
        '/v1/agents',
        '/v1/pe/earning-proposals',
        '/v1/leaderboard',
        '/v1/names',
        '/v1/pledges',
        '/v1/reputation',
        '/v1/standing',
        '/v1/x402',
      ]);
    });

    it(': closes the public x402 seller list pre-flip, never the facilitator report route', () => {
      expect(run('/v1/x402/sellers', {}).status).toBe(404);
      expect(run('/v1/x402/sellers', {}, { authorization: 'Bearer x' }).status).toBe(404);
      expect(run('/v1/x402/sellers', { PUBLIC_LAUNCH: 'true' }).nexted).toBe(true);
      // The facilitator's shared-secret report route lives under /v1/internal and passes the gate.
      expect(run('/v1/internal/x402/facilitator-settlement', {}).nexted).toBe(true);
      expect(isClosedPreLaunch('/v1/x402something')).toBe(false);
    });

    it('the app-authed set is exactly the phone-app-consumed prefixes (+ community opt-in)', () => {
      expect([...APP_AUTHED_PRELAUNCH_PREFIXES]).toEqual([
        '/v1/commons',
        '/v1/community',
        '/v1/contract-registry',
        '/v1/threads',
        '/v1/wants',
      ]);
    });
  });

  /**
   * . The phone app is gated by not being published, not by
   * PUBLIC_LAUNCH, so the two prefixes it consumes — `/v1/commons` (the human-jobs pay/hire path
   * + forum/profile reads) and `/v1/contract-registry` must PASS the gate for a CREDENTIALED
   * caller pre-flip, while an ANONYMOUS caller still 404s (public-web non-disclosure unchanged).
   */
  describe('app-authed surfaces open to a credentialed caller pre-flip ', () => {
    const CRED = { authorization: 'Bearer throwaway-app-token' };

    it.each([
      '/v1/commons/jobs/job-1/fund',
      '/v1/commons/jobs/job-1/escrow',
      '/v1/commons/feed',
      '/v1/contract-registry',
    ])('%s → next() WITH a Bearer credential, PUBLIC_LAUNCH=false', (path) => {
      const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' }, CRED);
      expect(nexted).toBe(true);
      expect(status).toBe(null);
    });

    // RED CONTROL: the SAME paths, SAME closed flip, but NO credential → 404. Without this, the
    // pass above could not distinguish "credential opened it" from "the gate never closed it".
    it.each([
      '/v1/commons/jobs/job-1/fund',
      '/v1/commons/feed',
      '/v1/contract-registry',
    ])('%s → 404 pre-flip for an ANONYMOUS caller (no credential)', (path) => {
      const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' });
      expect(status).toBe(404);
      expect(nexted).toBe(false);
    });

    // SCOPE CONTROL: the credential exemption is scoped to the app-authed prefixes only. A
    // hard-closed prefix stays 404 EVEN with a credential — the operator keeps it behind the flip for
    // everyone.
    it.each(['/v1/reputation/x', '/v1/agents/directory', '/v1/leaderboard'])(
      '%s stays 404 pre-flip even WITH a Bearer credential (hard-closed, not app-authed)',
      (path) => {
        const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' }, CRED);
        expect(status).toBe(404);
        expect(nexted).toBe(false);
      },
    );

    it('isAppAuthedPreLaunch matches only the app-authed prefixes', () => {
      expect(isAppAuthedPreLaunch('/v1/commons')).toBe(true);
      expect(isAppAuthedPreLaunch('/v1/commons/jobs/x/fund')).toBe(true);
      expect(isAppAuthedPreLaunch('/v1/contract-registry')).toBe(true);
      expect(isAppAuthedPreLaunch('/v1/commonsomething')).toBe(false);
      expect(isAppAuthedPreLaunch('/v1/reputation')).toBe(false);
      expect(isAppAuthedPreLaunch('/v1/agents')).toBe(false);
    });
  });

  /**
   * BURN-TO-PRESENT: the agent-to-agent LOOKUP read opens to a CREDENTIALED agent
   * caller pre-flip (decided requirement) while an anonymous caller still 404s and
   * the rest of `/v1/agents` stays dark.
   */
  describe('agent-to-agent provenance lookup opens to a credentialed caller pre-flip', () => {
    const CRED = { authorization: 'Bearer pvn_live_x:pvns_y' };

    it('GET /v1/agents/:id/provenance → next() WITH a Bearer credential, PUBLIC_LAUNCH=false', () => {
      const { status, nexted } = run('/v1/agents/agent-123/provenance', { PUBLIC_LAUNCH: 'false' }, CRED);
      expect(nexted).toBe(true);
      expect(status).toBe(null);
    });

    // RED CONTROL: the SAME path, SAME closed flip, but NO credential → 404. Without
    // this, the pass above could not distinguish "credential opened it" from "the
    // gate never closed it".
    it('GET /v1/agents/:id/provenance → 404 pre-flip for an ANONYMOUS caller', () => {
      const { status, nexted } = run('/v1/agents/agent-123/provenance', { PUBLIC_LAUNCH: 'false' });
      expect(status).toBe(404);
      expect(nexted).toBe(false);
    });

    // SCOPE CONTROL: the carve-out is EXACTLY the provenance lookup. The directory
    // and other `/v1/agents` disclosure stay 404 EVEN with a credential; `/record`
    // is not carved out here (it has its own MCP-onboarding gate).
    it.each([
      '/v1/agents/directory',
      '/v1/agents/agent-123/record',
      '/v1/agents/agent-123/badge.svg',
      '/v1/agents/agent-123/profile',
    ])('%s stays 404 pre-flip even WITH a Bearer credential (not the provenance lookup)', (path) => {
      const { status, nexted } = run(path, { PUBLIC_LAUNCH: 'false' }, CRED);
      expect(status).toBe(404);
      expect(nexted).toBe(false);
    });

    it('isCredentialedAgentLookup matches only /v1/agents/:id/provenance', () => {
      expect(isCredentialedAgentLookup('/v1/agents/agent-123/provenance')).toBe(true);
      expect(isCredentialedAgentLookup('/v1/agents/0xabc/provenance')).toBe(true);
      expect(isCredentialedAgentLookup('/v1/agents/agent-123/record')).toBe(false);
      expect(isCredentialedAgentLookup('/v1/agents/directory')).toBe(false);
      expect(isCredentialedAgentLookup('/v1/agents/agent-123/provenance/extra')).toBe(false);
      expect(isCredentialedAgentLookup('/v1/agents')).toBe(false);
    });
  });

  /**
   * THE ANTI-DRIFT CONTROL. Everything above tests paths someone remembered to list. This
   * re-derives the ungated set from the AST reachability matrix and fails if the gate does not
   * cover it — so the next forgotten route is a red test, not a live disclosure.
   */
  describe('coverage against the generated reachability matrix', () => {
    it('covers every statically-open route, or names it as a deliberate exception', () => {
      const out = execFileSync(
        'node',
        [resolve(__dirname, '../../../scripts/route-reachability-matrix.mjs'), '--json'],
        { encoding: 'utf8', maxBuffer: 64 << 20 },
      );
      const { rows } = JSON.parse(out) as { rows: Array<{ method: string; full: string; posture: string }> };
      const open = rows.filter((r) => r.posture === 'OPEN');
      expect(open.length).toBeGreaterThan(0); // an empty population proves nothing

      /**
       * DELIBERATE EXCEPTIONS — reachable unauthenticated by design, and NOT closed here.
       *
       * Two groups: (1) the device/app bootstrap and inbound-integration paths that closing
       * would break onboarding and third-party callbacks rather than close a disclosure; and
       * (2) the agent RAIL opened by so the invite → signup flow works pre-launch —
       * credential doors that answer 400/401 and the permissionless PE-type / scam / bond
       * discovery surfaces. Each retains its own authentication and validation requirements.
       */
      const EXCEPT = [
        // (1) bootstrap / inbound-integration
        '/v1/users', '/v1/devices', '/v1/pe/submit', '/v1/pe/submit-sovereign',
        '/v1/pe/projection', '/v1/pe/consent', '/v1/notify', '/v1/enterprise/pilot',
        '/v1/witnesses', '/v1/admin/pvt/policy', '/v1/ecosystem', '/v1/pvt/network-stats',
        '/v1/wallet/agent/create', '/v1/admin/health',
        '/v1/bootstrap', // hosted `curl … | sh` agent onboarding (script + bundle); public by design, pre-flip
        '/v1/sdk/version', // advisory SDK-staleness signal; public + ungated by design so agents learn
                           // staleness pre-launch. Discloses only static version strings (latest/min/
                           // upgrade command), no user/wallet data. See core/sdk-version.ts.
        '/v1/catalog/harnesses', // the SIGNED harness catalog every agent device polls.
                       // Public and ungated by design and by necessity: devices exist pre-flip
                       // (Atlas does), and a device that cannot reach this keeps its compiled-in
                       // catalog — so gating it would only make the self-update channel dark, never
                       // safer. Read-only; the document says where OpenClaw keeps session records,
                       // which is a public fact, and its integrity comes from an Ed25519 signature
                       // verified against a key compiled into the SDK, never from who may fetch it.
                       // No user, wallet, or device data, and no key material on the serving path.
        '/v1/catalog/release', // the SIGNED daemon-release manifest, the self-update
                       // channel. Public and ungated for the SAME reasons as /v1/catalog/harnesses,
                       // signed by the SAME Ed25519 authority: it names the current bundle's version
                       // + hash (a public fact), and the daemon refuses to run bytes whose hash does
                       // not match it. Read-only; no user/wallet/device data, no key material served.
        '/v1/gates/github', // PR-bound signed challenges and explicit presentation submission for our private repositories.
        '/v1/present', // burn-to-present VERIFICATION surface (jwks + verify + floor). Public by
                       // design and by decision: a presentation is handed to an external
                       // counterparty with no Provian account, so its verify surface must be
                       // reachable at launch with no account/flip. Read-only; discloses only
                       // what a presentation the presenter chose to hand over already carries.
        '/v1/schema', // Trust Layer §2.10: the ONE versioned PE schema (GET /v1/schema/pe). Public
                      // and ungated by design — an external builder needs it to construct a PE
                      // without reading the relay source, and it is generated from the relay's own
                      // constants. Read-only; discloses only the public schema (field assignments,
                      // witness/evidence classes, predicate grammar, the SIGNED template digest),
                      // no user/wallet/device data and no key material.

        // (2) the agent rail opened by
        '/v1/agent/wallet', '/v1/pe/propose-type',
        '/v1/pe/proposals', '/v1/pe/type-catalog', '/v1/pe/conformance',
        // NOTE: /v1/pe/earning-proposals is NO LONGER an exception — decision 5
        // moved it into CLOSED_PRE_LAUNCH_PREFIXES (it is a public VIEW, closed pre-flip).
        '/v1/security/scam-contracts', '/v1/bonds', '/v1/provisional',
      ];
      const uncovered = open
        .filter((r) => !isClosedPreLaunch(r.full.replace(/:[A-Za-z_]+/g, 'x')))
        // app-authed prefixes are covered too — the gate closes them to anonymous callers
        // (a credential is required pre-flip), so they are not an open disclosure.
        .filter((r) => !isAppAuthedPreLaunch(r.full.replace(/:[A-Za-z_]+/g, 'x')))
        .filter((r) => !EXCEPT.some((e) => r.full === e || r.full.startsWith(`${e}/`)))
        .map((r) => `${r.method} ${r.full}`);

      expect(uncovered).toEqual([]);
    });
  });
});
