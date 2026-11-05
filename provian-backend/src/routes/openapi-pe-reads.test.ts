/**
 * Finding 23 — the OpenAPI spec must expose the two LIVE PE record reads
 * (`GET /v1/pe/{pe_id}/proof`, `GET /v1/pe/export/{wallet_id}`) while keeping the
 * unavailable `POST /v1/pe/verify` hidden. They were previously invisible:
 * export was listed in `unavailableExact` (deleted from the spec) and proof was
 * never defined.
 */

import { buildOpenAPISpec } from './openapi';

describe('OpenAPI PE record reads (finding 23)', () => {
  const spec = buildOpenAPISpec() as { paths: Record<string, Record<string, unknown>> };

  it('exposes GET /v1/pe/{pe_id}/proof as a public read', () => {
    const proof = spec.paths['/v1/pe/{pe_id}/proof'];
    expect(proof).toBeDefined(); // RED: was never defined
    const get = proof.get as { security?: unknown[] };
    expect(get).toBeDefined();
    expect(get.security).toEqual([]); // public (PUBLIC_LAUNCH-gated, no API auth)
  });

  it('exposes GET /v1/pe/export/{wallet_id} (agent-auth)', () => {
    const exportPath = spec.paths['/v1/pe/export/{wallet_id}'];
    expect(exportPath).toBeDefined(); // RED: was deleted via unavailableExact
    expect(exportPath.get).toBeDefined();
  });

  it('RED paired control: POST /v1/pe/verify stays hidden (it checks an unconfigured anchor)', () => {
    expect(spec.paths['/v1/pe/verify']).toBeUndefined();
  });

  // the pre-flip deletions are FLIP-CONDITIONAL. Post-flip the live agent
  // rails and /v1/pe/verify are documented; /v1/governance/* stays deleted in every
  // posture because those routers are mounted by nothing. The launched leg is the
  // negative control for the pre-flip expectations above — without it, a filter
  // hardcoded to hide live rails forever would pass this suite unnoticed.
  it('lifts the agent-rail filter at PUBLIC_LAUNCH, keeping unmounted governance hidden', () => {
    const prior = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true';
    try {
      const launchedSpec = buildOpenAPISpec() as { paths: Record<string, unknown> };
      expect(launchedSpec.paths['/v1/escrow/create']).toBeDefined();
      expect(launchedSpec.paths['/v1/pvt/estimate']).toBeDefined();
      expect(Object.keys(launchedSpec.paths).some((p) => p.startsWith('/v1/jobs/'))).toBe(true);
      expect(Object.keys(launchedSpec.paths).some((p) => p.startsWith('/v1/court/'))).toBe(true);
      // Unmounted governance and the legacy PVTv8-era reads stay hidden in EVERY posture.
      expect(Object.keys(launchedSpec.paths).filter((p) => p.startsWith('/v1/governance/'))).toEqual([]);
      expect(launchedSpec.paths['/v1/pvt/stats']).toBeUndefined();
      expect(launchedSpec.paths['/v1/pvt/mint-history']).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.PUBLIC_LAUNCH; else process.env.PUBLIC_LAUNCH = prior;
    }
  });
});
