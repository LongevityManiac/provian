/**
 * Regression tests for Capability-Truthfulness audit Pass-2 findings #23 and
 * #13, updated for the real MCP server.
 *
 * The original findings: mcp.json advertised descriptor-only "tools" whose
 * schemas drifted from the REST endpoints they described (#23) and claimed a
 * retired PVT-weighted economic vote as live (#13). The settlement runtime fix goes further:
 * the descriptor's tools array is now IMPORTED from the shared tool core that
 * the /mcp endpoint and `npx @provian/mcp` actually serve
 * (src/mcp/core/tools.ts), so the advertised tool set cannot drift from
 * reality by construction. These tests pin that invariant, the corrected
 * proof-of-possession auth instructions (wallet-create was falsely described
 * as "no auth"), and the truthful governance story in ecosystem/openapi.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { mountOpenAPIRoutes } from './openapi';
import { createEcosystemRouter } from './ecosystem';
import { createAgentPromisesRouter } from './agent-promises';
import { createAgentPoolsRouter } from './agent-pools';
import { PROVIAN_TOOLS } from '../mcp/core/tools';

interface McpTool {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

function buildApp(): Express {
  const app = express();
  mountOpenAPIRoutes(app);
  app.use('/v1/ecosystem', createEcosystemRouter());
  return app;
}

/**
 * Pre-flip truthfulness predicate (audit 2026-08-16 item 5): the @provian npm
 * packages are unpublished (E404), so a served discovery descriptor may not
 * advertise an npx install or a local stdio transport. Encoded as a predicate
 * so the suite can show it FAILING on the pre-fix descriptor shape.
 */
function uninstallableAdvertisements(descriptor: unknown): string[] {
  const issues: string[] = [];
  if (JSON.stringify(descriptor).includes('npx')) {
    issues.push('descriptor text references an npx install');
  }
  const mcp = (descriptor as { mcp?: { local?: unknown } }).mcp;
  if (mcp && mcp.local !== undefined) {
    issues.push('local stdio transport advertised while the package is unpublished');
  }
  return issues;
}

describe('discovery doc truthfulness (audit #23 / #13)', () => {
  let app: Express;
  let priorLaunch: string | undefined;

  beforeAll(() => {
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true'; // discovery routes are launch-gated
    app = buildApp();
  });

  afterAll(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  // ---- #23 (superseded by settlement runtime): the descriptor's tools ARE the served tools ----
  describe('mcp.json tool truthfulness (#23 / settlement runtime)', () => {
    it('advertises exactly the tool set the MCP transports serve', async () => {
      const res = await request(app).get('/.well-known/mcp.json');
      expect(res.status).toBe(200);
      const tools = res.body.tools as McpTool[];
      expect(tools.map((t) => t.name).sort()).toEqual(PROVIAN_TOOLS.map((t) => t.name).sort());
      for (const tool of tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.description.length).toBeGreaterThan(20);
      }
    });

    it('advertises the remote /mcp URL and never an uninstallable local package (pre-flip)', async () => {
      const res = await request(app).get('/.well-known/mcp.json');
      const mcp = res.body.mcp as {
        remote: { transport: string; url: string };
        local?: unknown;
      };
      expect(mcp.remote.transport).toBe('streamable-http');
      expect(mcp.remote.url).toMatch(/\/mcp$/);
      // Audit 2026-08-16 item 5: @provian/mcp is unpublished (npm E404) until
      // the B5 flip publishes it, so the descriptor must not hand a
      // discovering agent an install command that cannot work. The local
      // stdio block returns in the same act that publishes the package.
      expect(mcp.local).toBeUndefined();
      expect(uninstallableAdvertisements(res.body)).toEqual([]);
    });

    it('[negative control] the pre-fix descriptor shape is exactly what the guard rejects', () => {
      // The shape the descriptor had before the fix (mcp.local + npx text).
      // Feeding it through the same predicate proves the guard is falsifiable.
      const preFix = {
        mcp: {
          remote: { transport: 'streamable-http', url: 'https://api.provian.ai/mcp' },
          local: {
            transport: 'stdio',
            package: '@provian/mcp',
            command: 'npx',
            args: ['-y', '@provian/mcp'],
          },
        },
        auth: { instructions: 'Local `npx @provian/mcp` runs the durable flow.' },
      };
      const violations = uninstallableAdvertisements(preFix);
      expect(violations).toContain('descriptor text references an npx install');
      expect(violations).toContain('local stdio transport advertised while the package is unpublished');
    });

    it('describes wallet creation as a PoP challenge/sign flow, never "no auth"', async () => {
      const res = await request(app).get('/.well-known/mcp.json');
      const auth = res.body.auth as { instructions: string };
      expect(auth.instructions).not.toMatch(/\(no auth\)/i);
      expect(auth.instructions.toLowerCase()).toContain('proof-of-possession');
      expect(auth.instructions).toContain('/v1/agent/wallet/challenge');
      expect(auth.instructions).toContain('signature');
      expect(auth.instructions.toLowerCase()).toContain('never sees the private key');
    });

    it('references the llms.txt agent index', async () => {
      const res = await request(app).get('/.well-known/mcp.json');
      const docs = res.body.docs as Record<string, string>;
      expect(docs.llms_txt).toBe('https://provian.ai/llms.txt');
    });
  });

  // ---- #13: no dormant economic-governance surface is advertised as live ----
  describe('governance discovery (#13)', () => {
    it('mcp.json drops the retired economic pvt_vote and its false weight claim', async () => {
      const res = await request(app).get('/.well-known/mcp.json');
      const tools = res.body.tools as McpTool[];
      expect(tools.find((t) => t.name === 'pvt_vote')).toBeUndefined();
      for (const tool of tools) {
        expect(tool.description.toLowerCase()).not.toContain('weight equals your earned pvt balance');
      }
    });

    it('ecosystem preserves the future the operator-direct boundary without activating authority machinery', async () => {
      const res = await request(app).get('/v1/ecosystem');
      expect(res.status).toBe(200);
      const gov = res.body.services.governance;
      expect(gov).toEqual({ status: 'dormant_non_gating' });
      expect(res.body.future_authority_boundary).toEqual({
        direct_bootstrap_administrator_and_economic_policy_setter: '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3',
        role: 'sole_direct_bootstrap_administrator_and_economic_policy_setter',
        governance_safe_executor_proposal_vote_timelock: 'dormant_non_gating',
        handoff_or_interposition_authorized: false,
      });
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain('authority unassigned');
    });

    it('openapi.json omits every governance route and every legacy PVT read, in the launched posture too', async () => {
      // This suite mounts with PUBLIC_LAUNCH=true, so this asserts the LAUNCHED
      // spec (the agent-rail filter lifts at flip). Unmounted governance
      // and the legacy PVTv8-era reads stay hidden in every posture; the live,
      // launch-gated estimator is documented at launch.
      const res = await request(app).get('/v1/openapi.json');
      expect(res.status).toBe(200);
      const paths = res.body.paths as Record<string, unknown>;
      expect(Object.keys(paths).filter((path) => path.startsWith('/v1/governance/'))).toEqual([]);
      expect(paths).toHaveProperty('/v1/pvt/accrual');
      expect(paths).toHaveProperty('/v1/pvt/history');
      expect(paths).toHaveProperty('/v1/pvt/network-stats');
      expect(paths).toHaveProperty('/v1/pvt/estimate');
      expect(paths).not.toHaveProperty('/v1/pvt/stats');
      expect(paths).not.toHaveProperty('/v1/pvt/mint-history');
      expect(paths).not.toHaveProperty('/v1/pe/verify');
      // B10 + the block DERIVES from the runtimes it
      // describes. This app instance runs with no armed env, so the honest
      // answer here is the unarmed/unconfigured one — deployed stays true
      // (a chain fact), everything runtime-conditional answers false/null.
      expect(res.body['x-pvt9-runtime']).toMatchObject({
        status: 'configured',
        deployed: true,
        mint_active: false,
        settlement_active: false,
        pe_anchoring_active: false,
        pe_onchain_verify_endpoint: null,
      });
    });

    it('SHUTDOWN COVERAGE: past the accrual end line the ecosystem statement says minting ended', async () => {
      const saved = process.env.PVT_ACCRUAL_END_MS;
      process.env.PVT_ACCRUAL_END_MS = '1';
      try {
        const res = await request(app).get('/v1/ecosystem');
        expect(res.status).toBe(200);
        expect(res.body.current_status.statement).toContain('Provian has ended PVT minting');
        // RED against the live statement checked in the next test.
        expect(res.body.current_status.statement).not.toContain('The PVT kernel is live on Base');
      } finally {
        if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
        else process.env.PVT_ACCRUAL_END_MS = saved;
      }
    });

    it('ecosystem states current eligibility truth without internal work-package jargon', async () => {
      const res = await request(app).get('/v1/ecosystem');
      expect(res.status).toBe(200);
      expect(res.body.current_status).toMatchObject({
        provenance_envelopes: 'live',
      });
      expect(res.body.current_status.statement).toContain('The PVT kernel is live on Base');
      expect(res.body.current_status.statement).toContain('no amount, schedule, or value is guaranteed');
      expect(res.body.current_status.future_eligibility).toContain('mint-once supplements and non-work events do not mint separately');
      // Standing copy rules: no kernel version token, no "most is just recorded" downplay.
      expect(JSON.stringify(res.body.current_status)).not.toMatch(/PVT\d|PVTv\d/);
      expect(res.body.current_status.future_eligibility).not.toContain('most action types record without minting');
      // B10 + DERIVED — this instance has no anchor env, so
      // the surface honestly answers unavailable (the armed leg is covered in
      // the derived-truth test below).
      expect(res.body.services.pe_onchain_verification).toMatchObject({
        status: 'unavailable',
        endpoints: [],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/\bWP\d+\b|Gate 1/);
    });

    it('[ derivation control] with the settlement + anchor env ARMED, both surfaces flip to the armed truth', async () => {
      process.env.PVT9_SETTLEMENT_ARMED = 'yes-settle-real-pvt';
      process.env.PVT_MINTER_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
      process.env.PE_ANCHOR_CONTRACT_ADDRESS = '0x889A59A847e490c5Cc91f281468AbAacc100a9fD';
      try {
        // The spec is built at MOUNT time (env is boot-stable in prod), so the
        // armed leg needs a FRESH app mounted under the armed env.
        const armedApp = buildApp();
        const oa = await request(armedApp).get('/v1/openapi.json');
        expect(oa.body['x-pvt9-runtime']).toMatchObject({
          status: 'armed',
          mint_active: true,
          settlement_active: true,
          pe_anchoring_active: true,
          pe_onchain_verify_endpoint: '/v1/pe/verify',
        });
        const eco = await request(armedApp).get('/v1/ecosystem');
        expect(eco.body.services.pe_onchain_verification).toMatchObject({
          status: 'available',
          endpoints: ['POST /v1/pe/verify', 'GET /v1/meter/proofs'],
        });
        expect(eco.body.pvt9).toMatchObject({ mint_active: true, settlement_active: true });
      } finally {
        delete process.env.PVT9_SETTLEMENT_ARMED;
        delete process.env.PVT_MINTER_KEY;
        delete process.env.PE_ANCHOR_CONTRACT_ADDRESS;
      }
    });

    // the promise/pool rails' discovery status was a hardcoded `env_gated`
    // while ENABLE_PROMISES is on in production. It is now derived from the
    // same `isFeatureEnabled` call the routes' `requireFeature` gate makes. Bound to
    // the REAL routers: for each env state, discovery says `live` exactly when the
    // gate lets a request through (401 auth-required) and `env_gated` exactly when
    // it answers 503 — so a hardcoded status in either direction goes RED here.
    it('[ derivation control] promises/pools status matches what their requireFeature gate does', async () => {
      const prior = { promises: process.env.ENABLE_PROMISES, pools: process.env.ENABLE_POOLS };
      const railApp = (): Express => {
        const a = buildApp();
        const deps = { db: {}, cache: {} } as never;
        a.use('/v1/promises', createAgentPromisesRouter(deps));
        a.use('/v1/pools', createAgentPoolsRouter(deps));
        return a;
      };
      const seen: string[] = [];
      try {
        for (const state of [
          { promises: 'true', pools: undefined },
          { promises: undefined, pools: 'true' },
          { promises: 'false', pools: 'false' },
        ] as const) {
          if (state.promises === undefined) delete process.env.ENABLE_PROMISES; else process.env.ENABLE_PROMISES = state.promises;
          if (state.pools === undefined) delete process.env.ENABLE_POOLS; else process.env.ENABLE_POOLS = state.pools;
          const a = railApp();
          const eco = await request(a).get('/v1/ecosystem');
          const promisesGate = await request(a).get('/v1/promises/marketplace');
          const poolsGate = await request(a).get('/v1/pools/active');
          expect([401, 503]).toContain(promisesGate.status);
          expect([401, 503]).toContain(poolsGate.status);
          const expectedPromises = promisesGate.status === 503 ? 'env_gated' : 'live';
          const expectedPools = poolsGate.status === 503 ? 'env_gated' : 'live';
          expect(eco.body.services.promises).toMatchObject({ status: expectedPromises, settlement: expectedPromises });
          expect(eco.body.services.pools).toEqual({ status: expectedPools, settlement: expectedPools });
          expect(eco.body.services.promises.human_promises).toMatchObject({ status: 'live' });
          expect(eco.body.services.promises).not.toHaveProperty('local_offline_p2p_promises');
          seen.push(`${expectedPromises}/${expectedPools}`);
        }
        // Population control : all three states were evaluated and BOTH
        // outcomes were reached on each rail — never a pass over one branch.
        expect(seen).toEqual(['live/env_gated', 'env_gated/live', 'env_gated/env_gated']);
      } finally {
        if (prior.promises === undefined) delete process.env.ENABLE_PROMISES; else process.env.ENABLE_PROMISES = prior.promises;
        if (prior.pools === undefined) delete process.env.ENABLE_POOLS; else process.env.ENABLE_POOLS = prior.pools;
      }
    });
  });
});
