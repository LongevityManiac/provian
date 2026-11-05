/**
 * INSTALLED-BASE COMPATIBILITY SUITE (close-out, item 8).
 *
 * WHY THIS EXISTS. Three removals in the run broke contracts the ordinary
 * suites could not see — because those suites drive HEAD's client against HEAD's
 * relay, so a change made in LOCKSTEP on both sides passes even when it strands
 * the fielded installed base. The worst was the registration-fingerprint change
 * (dropping `agent_session_id`): every already-registered agent's stored
 * `request_fingerprint_sha256` would then fail to reproduce, and credential
 * recovery for the ENTIRE installed base would answer
 * `agent_wallet_registration_recovery_identity_mismatch`. The ordinary
 * round-trip test never saw it because it recomputes the fingerprint at HEAD on
 * both sides.
 *
 * This suite pins the cross-layer contracts the CURRENTLY INSTALLED daemon
 * release / published SDK / CLI depend on, as FROZEN golden vectors, and fails
 * on any HEAD change that would break them. It is boot-free and deterministic so
 * it can run in the pre-push gate and nightly CI. The SDK-side half (the durable
 * identity `contextHash`) lives in `provian-agent-sdk/src/installed-base-compat.test.ts`.
 */
import { describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';

import { agentWalletRegistrationRequestFingerprint, createAgentWalletRouter } from './routes/agent-wallet';
import { createAgentInviteRouter } from './routes/agent-invite';
import type { RouterDeps } from './core/agent-wallet/types';
import { DEFAULT_GOVERNANCE } from './core/agent-wallet/types';
import { resolveServedBundle, resolveServedBundleSha256, __clearServedBundleCache } from './routes/served-bundle';
import { SDK_LATEST, SDK_MIN_SUPPORTED, parseSemver, compareSemver } from './core/sdk-version';
import { verifyWalletAuthTokenWithBinding, type WalletAuthDeps } from './routes/middleware/wallet-auth';

const REPO_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// 1. The registration-fingerprint contract — the marquee guard.
// ---------------------------------------------------------------------------
// A frozen input every fielded agent's stored fingerprint is representative of,
// and the sha256 HEAD's relay MUST reproduce. Captured 2026-09-16 from
// `agentWalletRegistrationRequestFingerprint` at HEAD. If the canonical changes
// in any way — a dropped/added/reordered key, a renamed schema — this goes RED.
const GOLDEN_FINGERPRINT_INPUT = {
  registrationId: 'compat-golden-registration-0001',
  agentName: 'Compat Golden Agent',
  agentId: 'compat-golden-agent',
  platform: 'sdk',
  chains: ['base'] as const,
  callbackUrl: null,
  governance: DEFAULT_GOVERNANCE,
  constitutionAccepted: true,
  constitutionVersion: '1.0.0',
  constitutionAcceptedAt: 1784000000000,
  parentWalletId: null,
  connectionToken: null,
  // A pre-retirement agent's stored fingerprint was computed WITH a real session id.
  agentSessionId: 'legacy-session-abc',
};
const GOLDEN_FINGERPRINT = '8359e82d63123880d163cdb48b2cb8bf5e54f1bc7ad6449bdaf0f3a481f6dfca';

// ---------------------------------------------------------------------------
// The currently-published versions the installed base runs. Pinned so a bump of
// the real package.json without updating this record is caught (§3), and so the
// suite states plainly what "installed" means.
// ---------------------------------------------------------------------------
const INSTALLED_SDK_VERSION = '1.10.0';
const INSTALLED_CLI_VERSION = '1.4.0';

function readPkgVersion(rel: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel, 'package.json'), 'utf8')) as { version?: string };
  if (typeof pkg.version !== 'string') throw new Error(`no version in ${rel}/package.json`);
  return pkg.version;
}

describe('installed-base compatibility (item 8)', () => {
  describe('registration fingerprint — the recovery contract', () => {
    it('HEAD reproduces the frozen golden fingerprint for a fielded registration', () => {
      expect(agentWalletRegistrationRequestFingerprint(GOLDEN_FINGERPRINT_INPUT)).toBe(GOLDEN_FINGERPRINT);
    });

    it('RED control: agent_session_id is load-bearing — dropping it changes the hash', () => {
      // The exact break: if the canonical stops binding agent_session_id, a
      // pre-retirement registration (stored WITH a session id) can no longer be
      // reproduced, and its owner is refused credential recovery. Proving the two
      // hashes DIFFER is proving the key is part of the identity, so a future drop
      // cannot pass the golden above silently.
      const dropped = { ...GOLDEN_FINGERPRINT_INPUT, agentSessionId: null };
      expect(agentWalletRegistrationRequestFingerprint(dropped)).not.toBe(GOLDEN_FINGERPRINT);
    });

    it('the fingerprint is a stable pure function (same input → same hash)', () => {
      const a = agentWalletRegistrationRequestFingerprint(GOLDEN_FINGERPRINT_INPUT);
      const b = agentWalletRegistrationRequestFingerprint({ ...GOLDEN_FINGERPRINT_INPUT });
      expect(a).toBe(b);
    });
  });

  describe('route surface — the installed client’s call targets are still mounted', () => {
    // Boot-free: construct the agent-wallet router and read its registered route
    // stack. The SDK + CLI call these; removing one (as removed the connect
    // route) would break the fielded client. deps are only dereferenced inside
    // handlers, so a stub is enough to enumerate the routes.
    function registeredPaths(): string[] {
      const app = express();
      // Both routers the SDK/CLI drive under /v1/agent/wallet (create/PoP/recovery
      // on the wallet router, request-link on the invite router).
      app.use('/v1/agent/wallet', createAgentWalletRouter({} as unknown as RouterDeps));
      app.use('/v1/agent/wallet', createAgentInviteRouter({} as unknown as RouterDeps));
      const router = (app._router ?? (app as unknown as { router: { stack: unknown[] } }).router);
      const paths = new Set<string>();
      const collect = (stack: Array<{ route?: { path?: string }; handle?: { stack?: unknown[] } }>): void => {
        for (const layer of stack) {
          if (layer.route?.path) paths.add(layer.route.path);
          else if (layer.handle && Array.isArray(layer.handle.stack)) {
            collect(layer.handle.stack as typeof stack);
          }
        }
      };
      collect((router as { stack: unknown[] }).stack as Parameters<typeof collect>[0]);
      return [...paths];
    }

    it('the agent-wallet routes the SDK depends on are registered', () => {
      const paths = registeredPaths();
      // The core create + PoP + recovery surface the SDK/CLI drive.
      for (const required of ['/create', '/challenge', '/parent-challenge']) {
        expect(paths).toContain(required);
      }
      // request-link (bootstrap) and recovery-escrow (credential recovery),
      // parametrised by wallet id, must both still be present.
      expect(paths.some((p) => p.includes('request-link'))).toBe(true);
      expect(paths.some((p) => p.includes('recovery-escrow'))).toBe(true);
    });

    it('RED control: the retired relay-connect route is NOT reintroduced on this router', () => {
      const paths = registeredPaths();
      expect(paths.some((p) => p.includes('connect'))).toBe(false);
    });
  });

  describe('SDK / CLI version compatibility', () => {
    it('the pinned installed versions match the real package.json (no silent drift)', () => {
      expect(INSTALLED_SDK_VERSION).toBe(readPkgVersion('provian-agent-sdk'));
      expect(INSTALLED_CLI_VERSION).toBe(readPkgVersion('provian-cli'));
      // The relay's advertised latest tracks the SDK package version.
      expect(SDK_LATEST).toBe(INSTALLED_SDK_VERSION);
    });

    it('the installed SDK and CLI are at or above the relay’s minimum supported version', () => {
      expect(parseSemver(INSTALLED_SDK_VERSION)).not.toBeNull();
      expect(parseSemver(INSTALLED_CLI_VERSION)).not.toBeNull();
      expect(parseSemver(SDK_MIN_SUPPORTED)).not.toBeNull();
      expect(compareSemver(INSTALLED_SDK_VERSION, SDK_MIN_SUPPORTED)).toBeGreaterThanOrEqual(0);
      expect(compareSemver(INSTALLED_CLI_VERSION, SDK_MIN_SUPPORTED)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('daemon self-update — the served bundle is intact and self-consistent', () => {
    const bundlePath = path.join(REPO_ROOT, 'provian-backend', 'bootstrap-bundle', 'agent.js');

    it('the served bundle is present, non-empty, and its digest is self-consistent', () => {
      __clearServedBundleCache();
      const bundle = resolveServedBundle(bundlePath);
      expect(bundle).not.toBeNull();
      expect(bundle!.length).toBeGreaterThan(0);
      // What the release-manifest route serves to a self-updating daemon must equal
      // the digest of the bytes it will fetch at /v1/bootstrap/agent.js. Both go
      // through this one resolver, so a divergence here is a broken self-update.
      const sha = crypto.createHash('sha256').update(bundle!).digest('hex');
      expect(resolveServedBundleSha256(bundlePath)).toBe(sha);
    });
  });

  describe('installed app builds — wallet-auth ', () => {
    // FROZEN: the v2 token iPhone builds 2026101602 and 2026101702 mint (RelayAPIService):
    // `iat`/`exp` in epoch MILLISECONDS from one Date.now(), exp = iat + 90 000, a UUID jti,
    // a lowercase-hex HMAC-SHA256 over the base64 payload. These builds are in people's hands;
    // the relay must accept them however HEAD's own client changes.
    const INSTALLED_APP_TOKEN_LIFETIME_MS = 90_000;
    const secret = 'installed-base-secret';
    const binding = { method: 'GET', path: '/v1/devices', bodyHash: crypto.createHash('sha256').update('').digest('hex') };
    const installedToken = (lifetimeMs: number) => {
      const now = Date.now();
      const payloadB64 = Buffer.from(JSON.stringify({
        sub: 'user_installed', device_id: 'device_00112233445566778899aabbccddeeff',
        iat: now, exp: now + lifetimeMs, jti: crypto.randomUUID(),
        mth: binding.method, pth: binding.path, bh: binding.bodyHash,
      })).toString('base64');
      return `${payloadB64}.${crypto.createHmac('sha256', secret).update(payloadB64).digest('hex')}`;
    };
    const deps = (): WalletAuthDeps => {
      const seen = new Set<string>();
      return {
        cache: {
          isEnabled: () => true,
          setNx: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)),
          getUserAuthSecret: async () => secret,
          setUserAuthSecret: async () => undefined,
        } as never,
        db: { collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }) } as never,
      };
    };

    it('the relay accepts the installed builds\' token', async () => {
      const result = await verifyWalletAuthTokenWithBinding(installedToken(INSTALLED_APP_TOKEN_LIFETIME_MS), binding, deps());
      expect(result).toEqual({ ok: true, userId: 'user_installed', deviceId: 'device_00112233445566778899aabbccddeeff' });
    });

    it('RED control: a token past the relay\'s lifetime bound is refused, so the pass above is not vacuous', async () => {
      const result = await verifyWalletAuthTokenWithBinding(installedToken(16 * 60 * 1000), binding, deps());
      expect(result).toMatchObject({ ok: false, status: 401 });
    });
  });
});

