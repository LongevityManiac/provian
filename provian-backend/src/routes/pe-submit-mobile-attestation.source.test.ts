import fs from 'fs';
import path from 'path';

/**
 * Endpoint-wiring regression coverage. Behavioral ownership/no-effect tests
 * exercise the real guard in pe-submit-mobile-device-ownership.test.ts; this
 * check binds the server-trusted tier resolver to the route that uses it.
 *
 * The single-PE mobile submit (`POST /v1/pe/submit/mobile`) is retired (PE
 * meter, 2026-10-03); its resolver now serves the phone's daily batch,
 * `POST /v1/meter/batch/mobile`. The resolver assertions are unchanged; the
 * route assertions moved to the batch route.
 */
describe('mobile PE attestation endpoint wiring', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('the resolver walks ownership → contradictory owner → bound signature → tier, and fails ownership closed', () => {
    const resolverStart = server.indexOf('async function resolveMobilePEAttestationTier');
    const resolverEnd = server.indexOf('\napp.', resolverStart);
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    const resolver = server.slice(resolverStart, resolverEnd);

    expect(resolver).toContain('canonicalDeviceEconomicAttestationTier');
    const rawOwnerGuard = resolver.indexOf('getAuthenticatedHumanMobileDevice(');
    const contradictoryOwnerGuard = resolver.indexOf("device.owner_type !== 'human'");
    const signatureVerification = resolver.indexOf('verifyBoundDeviceSignature');
    const attestationSelection = resolver.indexOf('resolveAttestationTierFromSigning({');
    expect(rawOwnerGuard).toBeGreaterThanOrEqual(0);
    expect(contradictoryOwnerGuard).toBeGreaterThan(rawOwnerGuard);
    expect(signatureVerification).toBeGreaterThan(contradictoryOwnerGuard);
    expect(attestationSelection).toBeGreaterThan(signatureVerification);
    expect(resolver).toContain("return { ok: false, error: 'invalid_device_ownership' }");
    expect(resolver).not.toContain("device.owner_type || 'human'");
    expect(resolver).not.toMatch(/const tier:\s*'software'\s*\|\s*'hardware'/);
  });

  it('the phone batch route refuses invalid ownership before resolving a tier, and a tier failure before ingesting', () => {
    const routeStart = server.indexOf("app.post('/v1/meter/batch/mobile', authenticate,");
    expect(routeStart).toBeGreaterThanOrEqual(0);
    const route = server.slice(routeStart, server.indexOf('\napp.', routeStart + 1));

    const ownershipCheck = route.indexOf('authenticateRequestHumanMobileDevice(db, req, tokenDeviceId)');
    const ownershipFailure = route.indexOf("res.status(401).json({ error: 'invalid_device_ownership' })");
    const tierResolution = route.indexOf('resolveMobilePEAttestationTier({');
    const tierFailure = route.indexOf('res.status(401).json({ error: tierOutcome.error })');
    const ingest = route.indexOf('ingestMeterBatch(');
    expect(ownershipCheck).toBeGreaterThanOrEqual(0);
    expect(ownershipFailure).toBeGreaterThan(ownershipCheck);
    expect(tierResolution).toBeGreaterThan(ownershipFailure);
    expect(tierFailure).toBeGreaterThan(tierResolution);
    expect(ingest).toBeGreaterThan(tierFailure);
    expect(route).toContain('attestationTier: tier,');
  });
});
