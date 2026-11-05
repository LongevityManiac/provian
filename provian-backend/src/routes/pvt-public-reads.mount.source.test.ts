/**
 * THE MOUNT SITE, pinned against the real `server.ts`.
 *
 * `pvt-public-reads.integration.test.ts` drives `mountPvtPublicReads` and proves
 * the surface behaves. It cannot see whether server.ts CALLS it — server.ts
 * `app.listen`s at module scope and builds live Firestore/Redis clients, so it
 * is not importable under jest. That gap is exactly the FC-011 defect: for the
 * whole life of `createPVTEstimateRouter` without a mount, its behavioral suite
 * was green because the suite supplied the mount itself.
 *
 * So this file reads server.ts as SOURCE and pins two things a behavioral suite
 * structurally cannot:
 * 1. the mount call exists;
 * 2. it comes after `app.use(createPvt9RuntimeBoundary())` — a route
 * registered ahead of the boundary would bypass it, which
 * `pvt-public-reads.integration.test.ts` demonstrates on a live app.
 *
 * Both checks are pure functions of a source string, so the negative control can
 * hand them a source that actually violates each one — rather than asserting a
 * property of its own string surgery. Source-text pinning is the established
 * convention here for exactly this situation: see
 * `wp11/ordinary-intake-wiring.source.test.ts` and
 * `routes/pe-submit-mobile-attestation.source.test.ts`.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PVT_PUBLIC_READ_MOUNT_PATH } from './pvt-public-reads';

const SERVER_PATH = resolve(__dirname, '../server.ts');
const MOUNT_CALL = 'mountPvtPublicReads(app,';
const MOUNT_IMPORT = "from './routes/pvt-public-reads'";
const BOUNDARY_MOUNT = 'app.use(createPvt9RuntimeBoundary());';

/**
 * COMMENTS ARE NOT CODE, and a pin that cannot tell the difference recreates the
 * defect it exists to close. The first version of this file searched raw source,
 * so `// mountPvtPublicReads(app, agentBankDeps);` — seven endpoints gone from
 * production — left every guard in the tree green. Caught in review.
 *
 * Line comments and block comments both go. The strip is UNCONDITIONAL from
 * `//` to end of line, matching `stripCodeComments` in
 * `scripts/wp2/generate-pvt9-base-config.mjs`. An earlier version carved out a
 * `//` preceded by `:` so `https://…` would survive — and review showed that
 * carve-out was itself a hole: `disabled:// mountPvtPublicReads(app, …)` left
 * this file 11/11 green with the mount dead. Neither marker below shares a line
 * with a URL, so the carve-out bought nothing and cost the guard.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** Exactly one mount call, and the import that supplies it. */
function mountIsPresent(source: string): boolean {
  const code = stripComments(source);
  return code.includes(MOUNT_IMPORT) && code.split(MOUNT_CALL).length - 1 === 1;
}

/** The mount is behind the boundary. Fails closed if either marker is absent. */
function mountIsBehindBoundary(source: string): boolean {
  const code = stripComments(source);
  const boundaryAt = code.indexOf(BOUNDARY_MOUNT);
  const mountAt = code.indexOf(MOUNT_CALL);
  if (boundaryAt < 0 || mountAt < 0) return false;
  return mountAt > boundaryAt;
}

const REAL_SOURCE = readFileSync(SERVER_PATH, 'utf8');

describe('server.ts mounts the PVT public read surface', () => {
  it('imports and calls the one mount function, exactly once', () => {
    expect(mountIsPresent(REAL_SOURCE)).toBe(true);
  });

  it('mounts it AFTER the PVT9 runtime boundary, never before', () => {
    expect(mountIsBehindBoundary(REAL_SOURCE)).toBe(true);
  });

  it('the mount path the tests assert is the mount path the module exports', () => {
    expect(PVT_PUBLIC_READ_MOUNT_PATH).toBe('/v1/pvt');
  });

  describe('NEGATIVE CONTROLS — each pin shown failing on a source that violates it', () => {
    it('a tree with the mount deleted fails the presence pin', () => {
      const deleted = REAL_SOURCE.split(MOUNT_CALL).join('/* mount deleted */ (');
      expect(deleted).not.toContain(MOUNT_CALL);
      expect(mountIsPresent(deleted)).toBe(false);
    });

    // The review finding. Commenting the mount out is the cheapest way to lose
    // the whole surface, and it leaves the text in place — so a raw-source pin
    // sees a mount that no longer runs. Both comment styles, both pins.
    it('a tree with the mount LINE-COMMENTED fails both pins', () => {
      const commented = REAL_SOURCE.replace(`${MOUNT_CALL}`, `// ${MOUNT_CALL}`);
      expect(commented).toContain(MOUNT_CALL); // still present as text…
      expect(mountIsPresent(commented)).toBe(false); // …but not as code.
      expect(mountIsBehindBoundary(commented)).toBe(false);
    });

    it('a tree with the mount BLOCK-COMMENTED fails both pins', () => {
      const commented = REAL_SOURCE.replace(`${MOUNT_CALL}`, `/* ${MOUNT_CALL}`)
        .replace(' agentBankDeps);', ' agentBankDeps); */');
      expect(mountIsPresent(commented)).toBe(false);
      expect(mountIsBehindBoundary(commented)).toBe(false);
    });

    it('the boundary mount commented out fails the order pin, closed', () => {
      const commented = REAL_SOURCE.replace(BOUNDARY_MOUNT, `// ${BOUNDARY_MOUNT}`);
      expect(mountIsBehindBoundary(commented)).toBe(false);
    });

    it('a `//` hidden behind a colon still disables both pins', () => {
      // The review finding on the first fix: a `([^:])//` carve-out meant
      // `disabled:// mountPvtPublicReads(...)` read as live code.
      const sneaky = REAL_SOURCE.replace(MOUNT_CALL, `disabled:// ${MOUNT_CALL}`);
      expect(mountIsPresent(sneaky)).toBe(false);
      expect(mountIsBehindBoundary(sneaky)).toBe(false);
    });

    it('stripComments leaves the two markers it compares intact', () => {
      // The stripper must not shorten the file in a way that drops or reorders
      // the markers — that would make the order pin meaningless rather than red.
      const code = stripComments(REAL_SOURCE);
      expect(code).toContain(MOUNT_CALL);
      expect(code).toContain(BOUNDARY_MOUNT);
      expect(code.indexOf(MOUNT_CALL)).toBeGreaterThan(code.indexOf(BOUNDARY_MOUNT));
    });

    it('a tree with a SECOND mount call fails the presence pin', () => {
      // Two mounts would double-register the surface; "at least one" would miss it.
      const duplicated = REAL_SOURCE.replace(MOUNT_CALL, `${MOUNT_CALL} agentBankDeps);\n${MOUNT_CALL}`);
      expect(mountIsPresent(duplicated)).toBe(false);
    });

    it('a tree with the mount hoisted ahead of the boundary fails the order pin', () => {
      const boundaryAt = REAL_SOURCE.indexOf(BOUNDARY_MOUNT);
      const hoisted = REAL_SOURCE.slice(0, boundaryAt)
        + `${MOUNT_CALL} agentBankDeps);\n`
        + REAL_SOURCE.slice(boundaryAt);
      expect(mountIsBehindBoundary(hoisted)).toBe(false);
    });

    it('a tree missing the boundary altogether fails the order pin, closed', () => {
      const noBoundary = REAL_SOURCE.split(BOUNDARY_MOUNT).join('// boundary removed');
      expect(mountIsBehindBoundary(noBoundary)).toBe(false);
    });
  });
});
