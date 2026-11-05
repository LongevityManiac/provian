import { describe, expect, it } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { requireConfiguredPvt9Runtime } from './pvt9-base-config.generated';
import { classifyPvt9RuntimeRequest, createPvt9RuntimeBoundary } from './wp2-runtime-boundary';

const isBlocked = (method: string, path: string) =>
  classifyPvt9RuntimeRequest(method, path).blocked;

describe('runtime boundary narrow runtime boundary', () => {
  it('the seam now RESOLVES: PVT9 is configured against the live Base deployment', () => {
    // Changed when the runtime was configured with the real deployed kernel. The seam used
    // to throw PVT9_UNCONFIGURED unconditionally; the contract is deployed and verified, so
    // that throw was stale rather than protective. What it must NOT do is confer authority:
    // the very next test proves every blocked path is still refused.
    const runtime = requireConfiguredPvt9Runtime();
    expect(runtime.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(runtime.chainId).toBe(8453);
  });

  it('admits only the exact safe GET/HEAD PVT record reads', () => {
    const EXACT_SAFE_READS = [
      '/v1/pvt/accrual',
      '/v1/pvt/history',
      '/v1/pvt/network-stats',
      '/v1/pvt/estimate',
      '/v1/pvt/milestones',
      '/v1/pvt/weights',
      '/v1/pvt/weights/overrides',
      '/v1/pvt/attestation-tiers',
    ];
    // The count is the claim. A silently shortened list would let every
    // assertion below pass while admitting fewer paths than the ruling opened.
    expect(EXACT_SAFE_READS).toHaveLength(8);

    for (const path of EXACT_SAFE_READS) {
      expect(isBlocked('GET', path)).toBe(false);
      expect(isBlocked('HEAD', path)).toBe(false);
      expect(isBlocked('POST', path)).toBe(true);
      expect(isBlocked('PUT', path)).toBe(true);
      expect(isBlocked('DELETE', path)).toBe(true);
    }

    expect(isBlocked('GET', '/v1/pvt')).toBe(true);
    expect(isBlocked('GET', '/v1/pvt/future-record-only-read')).toBe(true);
    expect(isBlocked('HEAD', '/v1/pvt/unknown')).toBe(true);
  });

  it('admits the two PARAMETERIZED safe reads, which a Set could never match', () => {
    // The reason this arm exists: `SAFE_PVT_RECORD_READS.has(path)` cannot match
    // a path carrying a parameter, so listing these among the exact paths would
    // have looked correct and admitted nothing.
    const PARAMETERIZED_SAFE_READS = [
      '/v1/pvt/balance/0xabcdef0123456789abcdef0123456789abcdef01',
      '/v1/pvt/allocation/wallet_abc-123',
    ];
    expect(PARAMETERIZED_SAFE_READS).toHaveLength(2);

    for (const path of PARAMETERIZED_SAFE_READS) {
      expect(isBlocked('GET', path)).toBe(false);
      expect(isBlocked('HEAD', path)).toBe(false);
      expect(isBlocked('POST', path)).toBe(true);
      expect(isBlocked('DELETE', path)).toBe(true);
    }

    // Anchored at both ends and exactly ONE segment deep: the bare prefix and a
    // deeper path are still blocked, so the pattern cannot become a namespace.
    for (const path of [
      '/v1/pvt/balance',
      '/v1/pvt/allocation',
      '/v1/pvt/balance/0xabc/mint',
      '/v1/pvt/allocation/wallet/settle',
      '/v1/pvt/balances/0xabc',
    ]) {
      expect(isBlocked('GET', path)).toBe(true);
    }
  });

  it.each([
    '/v1/pvt/stats',
    '/v1/pvt/tokenomics',
    '/v1/pvt/mint-history',
    '/v1/governance/proposals',
    '/v1/internal/scheduler/pvt-mint',
    '/v1/internal/scheduler/advance-epoch',
  ])('blocks the explicit legacy operation %s', (path) => {
    expect(isBlocked('GET', path)).toBe(true);
  });

  // Audit 2026-08-05 (findings 6 + 7): the eight LIFECYCLE + two RECOVERY schedulers are OPENED.
  // Positive control that they now pass the boundary (they remain behind authenticateScheduler and
  // none mints). RED against the pre-fix blocklist: every one of these returned true before.
  it.each([
    '/v1/internal/scheduler/auto-release',
    '/v1/internal/scheduler/defaults',
    '/v1/internal/scheduler/expired-pools',
    '/v1/internal/scheduler/court-deadlines',
    '/v1/internal/scheduler/general-dispute-deadlines',
    '/v1/internal/scheduler/bond-renewals',
    '/v1/internal/scheduler/abandoned-bonds',
    '/v1/internal/scheduler/expired-claims',
    '/v1/internal/scheduler/deferred-release',
    '/v1/internal/scheduler/pending-cache-backfill',
  ])('opens the lifecycle/recovery scheduler %s (findings 6+7)', (path) => {
    expect(isBlocked('POST', path)).toBe(false);
  });

  // The retired legacy settlement stubs stay blocked. B10 (, the design requires
  // ARM) removed daily-pe-anchor + pe-anchor-backfill from this set: they are
  // live scheduler handlers again (deployed PEAnchor per), asserted OPEN
  // below.
  it.each([
    '/v1/internal/scheduler/pvt-mint',
    '/v1/internal/scheduler/advance-epoch',
  ])('keeps the retired settlement stub %s blocked', (path) => {
    expect(isBlocked('POST', path)).toBe(true);
  });

  // B10 : the restored anchor schedulers pass the boundary (they run
  // behind authenticateScheduler and anchor Merkle roots — no PVT movement).
  // RED against the pre-B10 blocklist: both returned true before the change.
  it.each([
    '/v1/internal/scheduler/daily-pe-anchor',
    '/v1/internal/scheduler/pe-anchor-backfill',
  ])('opens the restored anchor scheduler %s (B10,)', (path) => {
    expect(isBlocked('POST', path)).toBe(false);
  });

  it('C-1 → B10: all three trust-layer surfaces are admitted now anchoring is restored', () => {
    // The two record reads were admitted under C-1 all along; POST /verify was
    // the deliberately-double-blocked third. B10 opened both layers in
    // one change — the exact condition C-1 set — so all three pass the boundary
    // (each still behind its own discovery gate / agent auth).
    expect(isBlocked('GET', '/v1/pe/id/proof')).toBe(false);
    expect(isBlocked('GET', '/v1/pe/export/wallet')).toBe(false);
    expect(isBlocked('POST', '/v1/pe/verify')).toBe(false);
    expect(isBlocked('GET', '/v1/pe/verify')).toBe(false);
  });

  it('keeps Forum record operations live (challenges answer by burn-to-present inside the forum; the Court namespace stays dark)', () => {
    expect(isBlocked('GET', '/v1/commons/registry/agents')).toBe(false);
    expect(isBlocked('GET', '/v1/commons/forum/posts')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/forum/post')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/forum/post/id/vote')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/forum/post/id/challenge')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/forum/challenge/id/answer')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/court/disputes')).toBe(true);
  });

  it('opens the institution runtimes — Court, Bonds, Jobs, escrow/promises/pools writes, admin PVT ', () => {
    // Reads AND writes now pass the boundary for the direct agent-rail institutions. These are
    // agent-/admin-authenticated and record-only / tx_hash-verifying (no signer in the router
    // deps) — admitting them here activates no on-chain value movement.
    for (const prefix of ['/v1/escrow', '/v1/promises', '/v1/pools']) {
      expect(isBlocked('GET', `${prefix}/record-id`)).toBe(false);
      expect(isBlocked('POST', `${prefix}/record-id`)).toBe(false);
    }
    expect(isBlocked('GET', '/v1/jobs')).toBe(false);
    expect(isBlocked('POST', '/v1/jobs/post')).toBe(false);
    expect(isBlocked('GET', '/v1/court/cases')).toBe(false);
    expect(isBlocked('POST', '/v1/court/dispute/general')).toBe(false);
    expect(isBlocked('GET', '/v1/bonds')).toBe(false);
    expect(isBlocked('POST', '/v1/bonds/post')).toBe(false);
    // admin PVT: the POLICY (classification) and GENESIS (read/audit + kill) surfaces open...
    expect(isBlocked('POST', '/v1/admin/pvt/policy/pending/x/classify')).toBe(false);
    expect(isBlocked('GET', '/v1/admin/pvt/genesis/audit')).toBe(false);

    // : `/v1/commons/jobs` the human-jobs pay/hire path the
    // phone app drives — is now OPENED here too (it is the same no-signer, tx_hash-verifying class
    // already open at the direct `/v1/jobs`). The pre-launch surface gate still keeps it dark to
    // anonymous callers; this boundary no longer 503s it for the authed app.
    expect(isBlocked('GET', '/v1/commons/jobs')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/jobs/post')).toBe(false);
    expect(isBlocked('POST', '/v1/commons/jobs/job-1/fund')).toBe(false);

    // NEGATIVE CONTROL — the legacy/absent runtimes, the governance boundary-dormant governance weight applier,
    // and the OTHER dark Commons economic aliases stay blocked, so "opens the institutions" is a
    // bounded change, not a blanket PASS. opened jobs ONLY; market/bank/court/bonds/gov stay
    // blocked (no bond/court/market/bank levers in scope).
    expect(isBlocked('GET', '/v1/admin/pvt/weights')).toBe(true);      // governance boundary-dormant weight applier
    expect(isBlocked('POST', '/v1/admin/pvt/weights/governance/review/7')).toBe(true);
    expect(isBlocked('POST', '/v1/pvt/accrual')).toBe(true);           // pvt runtime write
    expect(isBlocked('POST', '/v1/governance/proposals')).toBe(true);  // dormant governance
    expect(isBlocked('POST', '/v1/internal/scheduler/pvt-mint')).toBe(true); // legacy scheduler
    expect(isBlocked('GET', '/v1/commons/court/cases')).toBe(true);   // Commons court dark (§A5)
    expect(isBlocked('GET', '/v1/commons/market/listings')).toBe(false);  // Market lit
    expect(isBlocked('GET', '/v1/commons/institutions/stats')).toBe(false);       // Escrow stats open
    expect(isBlocked('GET', '/v1/commons/bonds/stats')).toBe(false);      // Bonds stats open
    expect(isBlocked('GET', '/v1/commons/governance/proposals')).toBe(true); // Commons gov dark
    expect(isBlocked('POST', '/v1/commons/court/disputes/id/vote')).toBe(true); // Commons court alias dark
  });

  it.each([
    '/v1/commons/court/cases',
    '/v1/commons/court/stats',
    '/v1/commons/governance/proposals',
  ])('blocks dependent Commons aliases for every method: %s', (path) => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isBlocked(method, path)).toBe(true);
    }
  });

  // `/v1/commons/jobs` is the Commons economic alias opened at the boundary (the app's
  // human-jobs pay/hire path). It passes for every method. (also opened `/v1/commons/market`,
  // the read face of the same board — pinned by its own case below; the prefix-scoping RED control
  // now rides `/v1/commons/court/jobs`, a still-blocked institution containing the substring.)
  it.each([
    '/v1/commons/jobs',
    '/v1/commons/jobs/post',
    '/v1/commons/jobs/job-1/fund',
    '/v1/commons/jobs/job-1/escrow',
    '/v1/commons/jobs/job-1/complete',
  ])('passes the human-jobs alias for every method: %s', (path) => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isBlocked(method, path)).toBe(false);
    }
  });

  it.each([
    '/v1/commons/market',
    '/v1/commons/market/jobs',
    '/v1/commons/market/stats',
  ])('passes the Market (the hiring board read face) for every method: %s', (path) => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isBlocked(method, path)).toBe(false);
    }
  });

  it.each([
    '/v1/commons/institutions/stats',
    '/v1/commons/bonds/stats',
  ])('passes the Escrow and Bonds stats reads: %s', (path) => {
    expect(isBlocked('GET', path)).toBe(false);
  });

  it(' RED control: opening jobs + market is prefix-scoped, not substring-matched', () => {
    expect(isBlocked('GET', '/v1/commons/court/jobs')).toBe(true);
    expect(isBlocked('GET', '/v1/commons/court/market')).toBe(true);
    expect(isBlocked('GET', '/v1/commons/marketplace')).toBe(false); // not in any blocked namespace
  });

  it('rejects blocked requests before auth, database, provider, or signer dependencies run', async () => {
    const touched: string[] = [];
    const touch = (name: string): RequestHandler => (_req, _res, next) => {
      touched.push(name);
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(createPvt9RuntimeBoundary());
    app.use(touch('auth'), touch('database'), touch('provider'), touch('signer'));
    app.use((_req, res) => res.status(204).end());

    for (const [method, path] of [
      ['get', '/v1/pvt/unknown'],
      ['post', '/v1/pvt/accrual'],
      ['post', '/v1/commons/court/list'],    // /jobs, market, bank, bonds opened; court STAYS blocked
      ['post', '/v1/commons/court/disputes'],
      ['post', '/v1/governance/proposals'],
      ['post', '/v1/admin/pvt/weights/governance/review/7'],
      ['get', '/v1/admin/pvt/weights/audit-log'],
      ['post', '/v1/admin/pvt/weights/unknown-child'],
      ['post', '/V1/ADMIN/PVT/WEIGHTS/UNKNOWN-CHILD'],
      ['post', '/v1/internal/scheduler/pvt-mint'],
      ['post', '/V1/COMMONS/COURT/LIST'],
      ['post', '/V1/PVT/ACCRUAL'],
      ['post', '/V1/GoVeRnAnCe/PrOpOsAlS'],
      ['post', '/V1/InTeRnAl/ScHeDuLeR/PvT-MiNt'],
    ] as const) {
      touched.length = 0;
      const response = await request(app)[method](path).send({ amount: '1' });
      expect(response.status).toBe(503);
      // Configuring PVT9 changed the REASON a dependent path is refused, never the fact.
      // This is the load-bearing assertion of the whole boundary: a configured kernel must
      // not silently activate a legacy or dependent runtime.
      expect(response.body.code).toBe('PVT9_DEPENDENCY_UNAVAILABLE');
      expect(touched).toEqual([]);
    }
  });

  it('allows the safe PVT reads, Registry/Forum records, AND the institutions to reach normal dependencies', async () => {
    const touched: string[] = [];
    const touch = (name: string): RequestHandler => (_req, _res, next) => {
      touched.push(name);
      next();
    };
    const app = express();
    app.use(createPvt9RuntimeBoundary());
    app.use(touch('auth'), touch('database'), touch('provider'), touch('signer'));
    app.use((_req, res) => res.status(204).end());

    for (const [method, path] of [
      ['get', '/v1/pvt/accrual'],
      ['head', '/v1/pvt/history'],
      ['get', '/v1/pvt/network-stats'],
      ['get', '/v1/commons/registry/agents'],
      ['post', '/v1/commons/forum/post'],
      // the opened institution runtimes reach their own auth/handlers past the boundary.
      ['post', '/v1/escrow/create'],
      ['post', '/v1/court/dispute/general'],
      ['post', '/v1/bonds/post'],
      ['get', '/v1/jobs'],
      ['get', '/v1/admin/pvt/genesis/audit'],
      // the human-jobs Commons alias reaches its own auth/handlers past the boundary.
      ['post', '/v1/commons/jobs/job-1/fund'],
    ] as const) {
      touched.length = 0;
      const response = await request(app)[method](path);
      expect(response.status).toBe(204);
      expect(touched).toEqual(['auth', 'database', 'provider', 'signer']);
    }
  });
});
