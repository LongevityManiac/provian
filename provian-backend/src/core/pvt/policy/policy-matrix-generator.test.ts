import { jest } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  assertRetiredTypesHaveNoLiveEmitter,
  collectRequiredPolicyIdentifiers,
  discoverStaticEmitters,
  missingRequiredPolicyIdentifiers,
  parseActionTypeUnion,
  readEmitterSource,
  renderPolicyMatrix,
  matchesSignedPolicy,
} from '../../../../scripts/generate-pvt-policy-matrix';
import {
  PROPOSED_ACTION_POLICY_ENTRIES,
  PROPOSED_ACTION_POLICY_MANIFEST,
  RETIRED_MATRIX_ACTION_TYPES,
} from './proposed-action-policy';

const repoRoot = path.resolve(__dirname, '../../../../..');
const mobileSource = fs.readFileSync(
  path.join(repoRoot, 'src/core/provenance/types.ts'),
  'utf8',
);

/**
 * ===========================================================================
 * RECURRENCE TRIPWIRE — flake DIAGNOSED AND FIXED (close-out, item 7).
 * ===========================================================================
 * The mechanism was a readdir→readFile TOCTOU in `discoverStaticEmitters` it
 * walks the live source tree (`provian-backend/src` among the roots), and a
 * CONCURRENT jest worker running `cutover-wp12r2.test.ts` plants and unlinks
 * `__scan_probe_*.ts` there. A file listed by readdir then unlinked before the
 * read threw ENOENT and reddened the whole generator; on rerun the planting was
 * gone, so it passed. The scan now skips a file that vanished mid-scan
 * (`readEmitterSource` → ENOENT → null), with a deterministic regression + a
 * negative control below. This instrumentation is KEPT (it asserts nothing and
 * cannot red the build) as cheap evidence should a DIFFERENT tree-mutation race
 * ever appear — e.g. `check:wp2` run concurrently with `npm test`, which mutates
 * types.ts, a file this suite also reads at module eval.
 *
 * So every run of this suite emits its own conditions. This is instrumentation,
 * NOT a guard: it asserts nothing and can never fail the suite on its own. A
 * tripwire that can red the build is a new flake source, which is the opposite
 * of the ruling.
 *
 * WHAT IT CAPTURES AND WHY EACH ITEM EARNS ITS PLACE:
 * - `seed` / `ordering` the operator named these. Jest's `--randomize` seed and this
 * file's position in the worker's queue are what a "passes alone, fails in a
 * full run" story turns on.
 * - `sourceDigest` / `sourceMtime` THE LEADING HYPOTHESIS, and the reason a
 * seed alone would not have been enough. The one previously EXPLAINED failure
 * of this exact file (D-, the "false RED I caused") was `check:wp2` running
 * CONCURRENTLY with `npm test` it transiently mutates 31 files, and this
 * suite reads the tree directly. If that is what happened again, the digest
 * here will not match the committed file's and the question is answered
 * without a re-investigation. If it DOES match, that hypothesis is dead and
 * the next investigation starts from a real elimination.
 * - `parsedCount` distinguishes "read a mutated file" from "read the right
 * file and still disagreed".
 */
const TRIPWIRE = (() => {
  const stat = fs.statSync(path.join(repoRoot, 'src/core/provenance/types.ts'));
  return {
    decision: 'standing invariant',
    suite: 'policy-matrix-generator',
    // Jest's run seed (29.4+). Constant across runs unless `--randomize` or
    // `--seed` is passed — which is itself part of the evidence: a recurrence
    // under an UNCHANGING seed rules out ordering as the cause outright.
    seed: typeof jest.getSeed === 'function' ? jest.getSeed() : null,
    randomized: process.argv.some((a) => a.includes('randomize')),
    ordering: {
      argvPosition: process.argv.findIndex((a) => a.includes('policy-matrix-generator')),
      workerId: process.env.JEST_WORKER_ID ?? null,
      startedAt: new Date().toISOString(),
    },
    source: {
      // The file this suite parses, hashed AT READ TIME — a concurrent mutation
      // is exactly what this is here to catch.
      digest: crypto.createHash('sha256').update(mobileSource).digest('hex').slice(0, 16),
      bytes: mobileSource.length,
      mtime: stat.mtime.toISOString(),
    },
    parsedCount: parseActionTypeUnion(mobileSource).size,
  };
})();

// Emitted unconditionally, so a CI log for ANY run — green or red — carries the
// conditions. `process.stdout` rather than `console.log` because Jest buffers
// and can drop console output from a failing worker, which is precisely the run
// whose evidence matters.
process.stdout.write(`\n[ tripwire] ${JSON.stringify(TRIPWIRE)}\n`);

describe('PVT policy matrix completeness generator', () => {
  it('accepts new emitter locations for an existing signed type, but refuses policy and catalog drift', () => {
    const signed = fs.readFileSync(path.join(repoRoot, 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json'), 'utf8');
    const current = renderPolicyMatrix().rendered;
    expect(matchesSignedPolicy(signed, current)).toBe(true);
    const changed = JSON.parse(current);
    changed.rows[0].maintained_sources.static_emitter_files.push('src/new-location.ts');
    expect(matchesSignedPolicy(signed, JSON.stringify(changed))).toBe(true);
    changed.rows[0].base_action_weight_bps += 1;
    expect(matchesSignedPolicy(signed, JSON.stringify(changed))).toBe(false);
    const catalog = JSON.parse(current);
    catalog.counts.required_identifiers += 1;
    expect(matchesSignedPolicy(signed, JSON.stringify(catalog))).toBe(false);
    const membership = JSON.parse(current);
    membership.rows[0].maintained_sources.mobile_action_type_union = !membership.rows[0].maintained_sources.mobile_action_type_union;
    expect(matchesSignedPolicy(signed, JSON.stringify(membership))).toBe(false);
  });
  it('parses all 208 ActionType members despite semicolons in comments', () => {
    // -3 — the retired-ladder aliases agent_wallet_funded /
    // agent_first_transaction / agent_sustained_activity were removed from the
    // mobile ActionType union with the matrix deletion (203 → 200); adds
    // link_spend, the Stripe Link spend witness (200 → 201).
    const parsed = parseActionTypeUnion(mobileSource);
    // +human_approval; +7 Commons communication types; 2026-09-23 (fact-base item 3):
    // -1 — the union now ends at agent_insurance_payout_executed.
    expect(parsed.size).toBe(208);
    expect(parsed.has('wallet_created')).toBe(true);
    expect(parsed.has('agent_insurance_payout_executed')).toBe(true);
  });

  it('is unaffected by an additional early comment semicolon mutation', () => {
    const mutated = mobileSource.replace(
      'export type ActionType =',
      '// mutation; this semicolon must not terminate the alias\nexport type ActionType =',
    );
    expect(parseActionTypeUnion(mutated)).toEqual(parseActionTypeUnion(mobileSource));
  });

  it('detects deletion of every required identifier from the policy entry set', () => {
    const required = collectRequiredPolicyIdentifiers();
    const complete = new Set(PROPOSED_ACTION_POLICY_ENTRIES.map((entry) => entry.action_type));
    expect(missingRequiredPolicyIdentifiers(required, complete)).toEqual([]);
    for (const identifier of required) {
      const mutated = new Set(complete);
      mutated.delete(identifier);
      expect(missingRequiredPolicyIdentifiers(required, mutated)).toContain(identifier);
    }
  });

  // /. The item-2 STOP guard forbids a retired matrix type from
  // having a live property-literal emitter. A guard observed only GREEN proves
  // nothing, so its throw branch is exercised here against a CONSTRUCTED
  // violation, and the real map is asserted to pass over a NON-EMPTY population.
  describe('retired-type live-emitter guard (item-2 STOP)', () => {
    it('GREEN: the real emitter map has no live emitter for any retired type', () => {
      const emitters = discoverStaticEmitters();
      // Not vacuous: the retired set and the live emitter map are both non-empty,
      // so this is a real universally-quantified pass, not a pass over zero items.
      expect(RETIRED_MATRIX_ACTION_TYPES.length).toBeGreaterThan(0);
      expect(emitters.size).toBeGreaterThan(0);
      expect(() =>
        assertRetiredTypesHaveNoLiveEmitter(RETIRED_MATRIX_ACTION_TYPES, emitters),
      ).not.toThrow();
    });

    it('RED control: a retired type WITH a live emitter makes the guard throw', () => {
      // Resurrect an emitter for a retired type. If the guard could not fire,
      // deleting a matrix row would silently mask a real emitter — the defect
      // this guard exists to catch.
      const resurrected = RETIRED_MATRIX_ACTION_TYPES[0];
      const violating = new Map<string, readonly string[]>([
        [resurrected, ['provian-backend/src/core/agent-bank/resurrected-emitter.ts']],
      ]);
      expect(() =>
        assertRetiredTypesHaveNoLiveEmitter(RETIRED_MATRIX_ACTION_TYPES, violating),
      ).toThrow(new RegExp(`live emitter.*${resurrected}`));
    });
  });

  it('aligns the artifact policy version and records TSX, SDK, and CLI emitter roots', () => {
    const artifact = JSON.parse(renderPolicyMatrix().rendered) as {
      policy_version: string;
      counts: { mobile: number };
      rows: Array<{
        maintained_sources: { static_emitter_files: string[] };
      }>;
    };
    expect(artifact.policy_version).toBe(PROPOSED_ACTION_POLICY_MANIFEST.policy_version);
    expect(artifact.counts.mobile).toBe(208); // -3 retired-ladder aliases; +link_spend; +human_approval; +7 Commons communication types; 2026-09-23: -1 (fact-base item 3)
    const files = artifact.rows.flatMap((row) => row.maintained_sources.static_emitter_files);
    expect(files.some((file) => file.endsWith('.tsx'))).toBe(true);
    expect(files.some((file) => file.startsWith('provian-agent-sdk/src/'))).toBe(true);

    // THE CLI IS NO LONGER AN EMITTER ROOT, and that is the point.
    // `agent_linked` was the CLI's only static emitter; it moved to the relay's
    // connect handler so the record no longer depends on a client choosing to
    // report it. This assertion was previously `some(... 'provian-cli/src/')`.
    // Inverting it rather than deleting it keeps the guard load-bearing: if
    // anyone re-introduces a client-side PE emitter in the CLI, this fires and
    // forces the "should a client be the sole source of this record?" question
    // back into the open instead of letting it slip in.
    expect(files.some((file) => file.startsWith('provian-cli/src/'))).toBe(false);
    // ...and the relay-side emitter that replaced it IS recorded.
    expect(files.some((file) => file.endsWith('server.ts'))).toBe(true);
  });

  // flake, DIAGNOSED AND FIXED (close-out, item 7). The suite went RED
  // in a concurrent full jest pass and green on rerun because `discoverStaticEmitters`
  // walks the live source tree (`readdirSync` then `readFileSync`), and
  // `cutover-wp12r2.test.ts` plants+unlinks `__scan_probe_*.ts` under
  // `provian-backend/src` — one of those roots. A file listed by readdir then
  // unlinked before the read threw ENOENT, and the whole generator with it. The
  // scan now treats a vanished file as "not a stable emitter" and skips it. These
  // make the race deterministic (a reader that returns null for one file) instead
  // of racing a real unlink, and the negative control proves only ENOENT is swallowed.
  describe('emitter scan tolerates a file vanishing mid-scan (flake fix)', () => {
    it('readEmitterSource: content for a real file, null for a vanished (ENOENT) path', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmg-enoent-'));
      try {
        const real = path.join(dir, 'real.ts');
        fs.writeFileSync(real, "const x = { actionType: 'demo_type' };\n");
        expect(readEmitterSource(real)).toContain('demo_type');
        // The exact race: a path readdir listed but that was unlinked before read.
        expect(readEmitterSource(path.join(dir, 'vanished.ts'))).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('NEGATIVE CONTROL — readEmitterSource re-throws a non-ENOENT error (it does not blanket-swallow)', () => {
      // Reading a directory is EISDIR, not ENOENT. A fix that swallowed EVERY error
      // would hide real problems; this proves only the vanished-file case is skipped.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmg-eisdir-'));
      try {
        expect(() => readEmitterSource(dir)).toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('discoverStaticEmitters does not throw when a listed file vanishes before read, and still collects survivors', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmg-scan-'));
      try {
        const survivor = path.join(root, 'survivor.ts');
        const vanisher = path.join(root, 'vanisher.ts');
        fs.writeFileSync(survivor, "x = { actionType: 'survivor_action' };\n");
        fs.writeFileSync(vanisher, "x = { actionType: 'vanished_action' };\n");
        // Inject the reader so `vanisher` reads as gone (ENOENT → null) exactly as a
        // concurrent unlink between readdir and read would produce — no real race.
        const readFile = (file: string): string | null =>
          file === vanisher ? null : readEmitterSource(file);
        const emitters = discoverStaticEmitters([root], readFile);
        expect(emitters.has('survivor_action')).toBe(true);
        expect(emitters.has('vanished_action')).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});


describe('repository split historical emitter pins', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const { withPinnedRetiredEmitters } = require('../../../../scripts/generate-pvt-policy-matrix') as typeof import('../../../../scripts/generate-pvt-policy-matrix');
  const root = path.resolve(__dirname, '../../../../..');
  const inventory = fs.readFileSync(path.join(root, 'config/integrity/retired-emitter-pins.json'));
  const matrix = fs.readFileSync(path.join(root, 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json'));
  it('keeps the signed historical pairs while preserving every live emitter', () => {
    const live = new Map([['new_live_work', ['provian-backend/src/new-live.ts']]]);
    const result = withPinnedRetiredEmitters(live, inventory, matrix, () => false);
    expect(result.get('new_live_work')).toEqual(['provian-backend/src/new-live.ts']);
    const pins = JSON.parse(inventory.toString('utf8'));
    for (const pair of pins.pairs) expect(result.get(pair.action_type)).toContain(pair.file);
    expect(withPinnedRetiredEmitters(new Map(), inventory, matrix, () => false).has('new_live_work')).toBe(false);
  });
  it('refuses an altered inventory or a forged self-consistent matrix', () => {
    expect(() => withPinnedRetiredEmitters(new Map(), Buffer.concat([inventory, Buffer.from(' ')]), matrix)).toThrow('inventory changed');
    expect(() => withPinnedRetiredEmitters(new Map(), inventory, Buffer.concat([matrix, Buffer.from(' ')]))).toThrow('matrix bytes changed');
    const changed = JSON.parse(inventory.toString('utf8'));
    changed.pairs.push({action_type:'forged_work',file:'unapproved.ts'});
    expect(() => withPinnedRetiredEmitters(new Map(), Buffer.from(JSON.stringify(changed)), matrix)).toThrow('inventory changed');
  });
  it('refuses restored retired source before it can enter the live scan', () => {
    expect(() => withPinnedRetiredEmitters(new Map(), inventory, matrix, () => true)).toThrow('source restored');
    const pair = JSON.parse(inventory.toString('utf8')).pairs[0];
    expect(() => withPinnedRetiredEmitters(new Map([[pair.action_type,[pair.file]]]), inventory, matrix, () => false)).toThrow('found in live scan');
  });
});
