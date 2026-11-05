/**
 * THE PE-TYPE-REGISTRY CODE-STATE READ, RECORDED AS EXECUTABLE ASSERTIONS.
 *
 * OPEN_ITEMS ("PE-type registry / weight-framework wiring on the PVT9-era backend") asked
 * for a code-state read: is the action-type→tier registry (a) live and consumed by the
 * PVT9-era eligibility path, (b) present but unwired, or (c) dead governance surface —
 * "then wire or delete accordingly". This suite IS that read, pinned so it cannot silently
 * regress. The answer, in three parts:
 *
 *   (a) LIVE AND CONSUMED — the action-policy gate (`resolveActionPolicyAtRecordTime`,
 *       recognition set = 162 cut-line identifiers + 73 verified emitters, unknown types
 *       fail closed into the pending-policy queue as `record_only`) is called on the live
 *       record path (`pvt-accrual.ts`), which seals the `recordPointsAtomic` that PVT9
 *       settlement later consumes verbatim. The catalog (`pe_type_catalog`) is seeded at
 *       boot, observes every recorded type, and its category feeds the public estimate
 *       surface (`estimate.ts` → `getCategoryForActionType` → `calculatePEWeight`).
 *
 *   (b) does not apply — nothing here is present-but-unwired.
 *
 *   (c) THE `pe-type/propose` ENDPOINT DOES NOT EXIST — it was never built on the
 *       PVT9-era backend, so there is no dead surface to wire OR delete. The pending-policy
 *       queue (automatic observation + alert on first sight of an unknown identifier) is
 *       the propose mechanism. The ONE pe-type route that does exist is read-only:
 *       `GET /governance/pe-types` (commons.ts) lists community-documented types off the
 *       LIVE catalog — its own comment records the migration away from the dead
 *       `pe_type_proposals` collection. The route-shape assertion below keeps this answer
 *       true: any MUTATING pe-type verb, or any route path containing `propose`, fails the
 *       suite and forces the answer to be re-recorded deliberately.
 *
 * Every scanner here carries its own negative control (a violating source must fire it),
 * per the run-contract rule that an assertion observed only green is not evidence.
 */

import fs from 'fs';
import path from 'path';

import { resolveActionPolicyAtRecordTime } from './action-policy-gate';
import { calculatePEWeight, getActionTypeTier, getAllTierAssignments } from '../pe-weight-framework';

const BACKEND_ROOT = path.resolve(__dirname, '../../../..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
}

/** A gate call is a CALL, not a comment: identifier immediately followed by an open paren. */
function sourceCallsGate(source: string): boolean {
  return /resolveActionPolicyAtRecordTime\s*\(/.test(source)
    && /from ['"].*action-policy-gate['"]/.test(source);
}

/**
 * Route registrations that would change the recorded answer: a MUTATING verb on any
 * pe-type path, or ANY verb on a path containing `propose`. The read-only
 * `GET /governance/pe-types` listing is deliberately NOT matched — it is the one
 * legitimate surface and is pinned as such by the positive assertion below.
 */
function findPeTypeProposeRoutes(source: string): readonly string[] {
  const mutating = /\.(?:post|put|patch|delete)\s*\(\s*['"`][^'"`]*pe[-_]type[^'"`]*['"`]/g;
  const propose = /\.(?:get|post|put|patch|delete|use)\s*\(\s*['"`][^'"`]*pe[-_]type[^'"`]*propose[^'"`]*['"`]/g;
  return [...source.matchAll(mutating), ...source.matchAll(propose)].map((m) => m[0]);
}

/**
 * the contributor-facing WRITE forms for proposing/documenting an
 * earning type are deleted. A submitted envelope is the only submission a
 * contributor ever makes. This scanner catches any MUTATING verb on the
 * `earning-proposals`, `type-catalog`, or `propose-type` paths, so a
 * reintroduced write form (the propose POST, the type-catalog/propose-type
 * enrich POST, or any endorse/upvote POST) fails the suite. Read-only GETs are
 * deliberately NOT matched — the reads survive the deletion.
 */
function findEarningWriteForms(source: string): readonly string[] {
  const re = /\.(?:post|put|patch|delete)\s*\(\s*['"`][^'"`]*(?:earning-proposal|type-catalog|propose-type)[^'"`]*['"`]/g;
  return [...source.matchAll(re)].map((m) => m[0]);
}

/** An empty Firestore: every read misses, so the gate sees a truly unknown identifier. */
function emptyDb(): unknown {
  return {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }),
  };
}

describe('PE-type registry — code-state verdict (a): live and consumed', () => {
  it('the live record path consults the action-policy gate (source pin)', () => {
    const accrual = readSource('src/pvt-accrual.ts');
    expect(sourceCallsGate(accrual)).toBe(true);
  });

  it('the estimate surface consumes the live registry through the SAME gate (source pin)', () => {
    // C-2 REPOINTED this pin rather than deleting it. The estimate used to
    // reach the registry via `getCategoryForActionType` and price with
    // `calculatePEWeight` — the retired float table, which disagreed with the
    // record path in both directions. It now resolves through
    // `resolveActionPolicyAtRecordTime`, the identical gate the accrual above
    // consults, and takes its category off the resulting action policy.
    const estimator = readSource('src/core/pvt/policy/record-path-estimate.ts');
    expect(sourceCallsGate(estimator)).toBe(true);
  });

  it('the estimate surface no longer PRICES with the retired weight framework', () => {
    // The C-2 quarantine, as an executable guard rather than a comment: a
    // user-facing earnings surface must not reach the float tier table. This is
    // the assertion that goes red if someone reintroduces the second system.
    for (const path of [
      'src/core/pvt/estimate.ts',
      'src/core/pvt/policy/record-path-estimate.ts',
    ]) {
      const source = readSource(path);
      expect(/calculatePEWeight\s*\(/.test(source)).toBe(false);
      expect(/HUMAN_TRUST_BONUS/.test(source)).toBe(false);
    }
    // POSITIVE CONTROL — the framework is still importable and still used for
    // its non-pricing jobs, so the absence above is a real quarantine and not
    // an artefact of the module having been deleted.
    const framework = readSource('src/core/pvt/pe-weight-framework.ts');
    expect(/export function calculatePEWeight/.test(framework)).toBe(true);
    const accrual = readSource('src/pvt-accrual.ts');
    expect(/from ['"].*pe-weight-framework['"]/.test(accrual)).toBe(true);
  });

  it('the catalog is seeded and observed on the live server (source pin)', () => {
    const server = readSource('src/server.ts');
    expect(/seedCatalog\s*\(/.test(server)).toBe(true);
    const accrual = readSource('src/pvt-accrual.ts');
    expect(/recordActionTypeObservation\s*\(/.test(accrual)).toBe(true);
  });

  it('NEGATIVE CONTROL — the source scanners fire on a violating source', () => {
    // A record path that dropped the gate import or the call must be detected.
    expect(sourceCallsGate('const x = resolveActionPolicyAtRecordTime(db, input);')).toBe(false);
    expect(sourceCallsGate(
      "import { resolveActionPolicyAtRecordTime } from './core/pvt/policy/action-policy-gate';\n"
      + '// resolveActionPolicyAtRecordTime is documented but never called',
    )).toBe(false);
    expect(sourceCallsGate(
      "import { resolveActionPolicyAtRecordTime } from './core/pvt/policy/action-policy-gate';\n"
      + 'const r = await resolveActionPolicyAtRecordTime(db, input);',
    )).toBe(true);
  });

  it('an UNKNOWN action type fails closed: pending queue, record_only, never a mint disposition', async () => {
    const resolution = await resolveActionPolicyAtRecordTime(
      emptyDb() as Parameters<typeof resolveActionPolicyAtRecordTime>[0],
      { actionType: 'zz_registry_state_probe_type', recordedAtMs: 1_753_000_000_000 },
    );
    expect(resolution.status).toBe('pending_policy');
    expect(resolution.mintDisposition).toBe('record_only');
  });

  it('POSITIVE CONTROL — a known launch identifier resolves differently, so the unknown case is not vacuous', async () => {
    const resolution = await resolveActionPolicyAtRecordTime(
      emptyDb() as Parameters<typeof resolveActionPolicyAtRecordTime>[0],
      { actionType: 'wallet_created', recordedAtMs: 1_753_000_000_000 },
    );
    expect(resolution.status).not.toBe('pending_policy');
  });

  it('the tier registry is non-empty and resolution order holds: explicit > category > default', () => {
    const tiers = getAllTierAssignments();
    expect(Object.keys(tiers).length).toBeGreaterThan(0);
    const explicitType = Object.keys(tiers)[0];
    expect(getActionTypeTier(explicitType)).toBe(tiers[explicitType]);
    // An unknown type with no category falls to the default tier, not zero and not a throw.
    const unknown = calculatePEWeight({
      userId: 'registry-state-probe',
      actionType: 'zz_registry_state_probe_type',
      attestationDepth: 'software',
      occurrenceCount: 1,
      dailyPECount: 1,
      isHumanLinked: false,
      isDuplicate: false,
    });
    expect(unknown.estimatedPVT).toBeGreaterThan(0);
  });
});

describe('PE-type registry — code-state verdict (c): pe-type/propose is NOT a surface', () => {
  it('no pe-type route is mounted anywhere on the backend', () => {
    const routesDir = path.join(BACKEND_ROOT, 'src/routes');
    const routeFiles = fs.readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `src/routes/${f}`);
    const scanned = ['src/server.ts', ...routeFiles];
    // Anti-empty-population: the scan covers the server and a real route set.
    expect(scanned.length).toBeGreaterThan(10);
    const hits = scanned.flatMap((rel) => findPeTypeProposeRoutes(readSource(rel))
      .map((hit) => `${rel}: ${hit}`));
    expect(hits).toEqual([]);
    // The one legitimate READ surface exists exactly where the verdict says it does —
    // pinned so the "read-only listing" half of the answer cannot rot either.
    expect(/router\.get\(\s*'\/governance\/pe-types'/.test(readSource('src/routes/commons.ts')))
      .toBe(true);
  });

  it('NEGATIVE CONTROL — a propose or mutating pe-type route would fire the scanner', () => {
    expect(findPeTypeProposeRoutes("app.post('/v1/pe-type/propose', authenticate, handler);").length)
      .toBeGreaterThan(0);
    expect(findPeTypeProposeRoutes("router.get('/pe-type/propose', h)").length).toBe(1);
    expect(findPeTypeProposeRoutes("router.put('/pe_type/catalog', h)").length).toBe(1);
    // And the read-only listing shape does NOT fire — the scanner is selective, not broad.
    expect(findPeTypeProposeRoutes("router.get('/governance/pe-types', h)").length).toBe(0);
  });
});

describe('PE-type registry — code-state verdict (d): the earning-type WRITE forms are gone ', () => {
  it('no earning-proposal / type-catalog / propose-type write form is mounted anywhere', () => {
    const routesDir = path.join(BACKEND_ROOT, 'src/routes');
    const routeFiles = fs.readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `src/routes/${f}`);
    const scanned = ['src/server.ts', ...routeFiles];
    // Anti-empty-population: the scan covers the server and a real route set.
    expect(scanned.length).toBeGreaterThan(10);
    const hits = scanned.flatMap((rel) => findEarningWriteForms(readSource(rel))
      .map((hit) => `${rel}: ${hit}`));
    expect(hits).toEqual([]);
    // The READ surfaces survive the write-form deletion — pinned so "reads kept,
    // writes removed" cannot silently become "all removed" or "writes back".
    expect(/router\.get\(\s*['"]\/earning-proposals['"]/.test(readSource('src/routes/earning-proposals.ts')))
      .toBe(true);
    expect(/router\.get\(\s*['"]\/type-catalog['"]/.test(readSource('src/routes/pe-proposals.ts')))
      .toBe(true);
  });

  it('NEGATIVE CONTROL — a reintroduced write form fires the scanner; a read does not', () => {
    expect(findEarningWriteForms("router.post('/earning-proposals', h)").length).toBe(1);
    expect(findEarningWriteForms("router.post('/type-catalog', enrich)").length).toBe(1);
    expect(findEarningWriteForms("router.post('/propose-type', enrich)").length).toBe(1);
    expect(findEarningWriteForms("router.post('/earning-proposals/:action_type/upvote', h)").length).toBe(1);
    expect(findEarningWriteForms("router.post('/type-catalog/:type_name/upvote', upvote)").length).toBe(1);
    // Reads and unrelated writes do NOT fire — the scanner is selective.
    expect(findEarningWriteForms("router.get('/earning-proposals', h)").length).toBe(0);
    expect(findEarningWriteForms("router.get('/type-catalog', list)").length).toBe(0);
    expect(findEarningWriteForms("router.post('/v1/pe/submit', h)").length).toBe(0);
  });
});
