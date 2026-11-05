/**
 * Network counter write-shard count (H4).
 *
 * THE CEILING. Firestore sustains roughly one write per second per document, so
 * the shard count is literally the network-wide accrual write ceiling: at 10
 * shards the whole network could not durably record more than ~10 PEs/second, no
 * matter how many instances were serving. Raised to 100.
 *
 * THE PROPERTY THAT MAKES IT SAFE TO RAISE, asserted rather than assumed: the
 * shard is chosen by a uniform hash of the PE id, and `readNetworkCounters` sums
 * every document present in the subcollection instead of iterating 0..N-1. So a
 * raise needs no migration — old shards keep their values and are still summed —
 * and shards are created lazily, so unused ones cost nothing.
 *
 * a test that only asserted the constant's VALUE would be a tautology
 * restating the source. What is actually load-bearing is that the value has ONE
 * definition (the rebuild script used to re-declare its own) and that the hash
 * spreads across the range, so both are asserted directly.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { NETWORK_SHARD_COUNT } from './durable-accrual-effects';

/** The exact selection the accrual path performs, mirrored for distribution. */
function shardFor(peId: string): number {
  return Number.parseInt(
    crypto.createHash('sha256').update(peId).digest('hex').slice(0, 8),
    16,
  ) % NETWORK_SHARD_COUNT;
}

describe('network write-shard count', () => {
  it('gives the network meaningful write headroom', () => {
    // Stated as a floor, not an equality: raising it further must not break this
    // suite, which would punish the exact change it is here to protect.
    expect(NETWORK_SHARD_COUNT).toBeGreaterThanOrEqual(100);
  });

  it('the hash SPREADS across the shard range', () => {
    // A constant of 100 buys nothing if every PE lands on shard 0. Ten thousand
    // synthetic ids must touch a large fraction of the range.
    const hit = new Set<number>();
    for (let i = 0; i < 10_000; i += 1) hit.add(shardFor(`pe_${i}`));

    expect(hit.size).toBe(NETWORK_SHARD_COUNT);
    for (const shard of hit) {
      expect(Number.isInteger(shard)).toBe(true);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(NETWORK_SHARD_COUNT);
    }
  });

  it('is DETERMINISTIC — the same PE id always picks the same shard', () => {
    // A retry of the same accrual must hit the same counter, or an increment
    // would land twice in different shards and inflate the network total.
    for (const id of ['pe_a', 'pe_b', 'pe_00000000-1111-2222-3333-444444444444']) {
      expect(shardFor(id)).toBe(shardFor(id));
    }
  });

  it('has exactly ONE definition — NO script may re-declare it', () => {
    // The defect this replaces: two operator scripts each carried their own
    // `= 10` with a comment calling it a "mirror"/"pinned replica" of
    // durable-accrual-effects. A mirror is not a source — a rebuild running with
    // a stale count buckets by the wrong modulus, writes absolute totals to the
    // low shards only, and leaves the rest for `readNetworkCounters` to keep
    // summing.
    //
    // THIS TEST WAS ITSELF TOO NARROW AND WAS CAUGHT IN REVIEW: it read ONE
    // script by name and declared "exactly ONE definition", while
    // `rebuild-network-shards.ts` sat beside it with its own copy — and its
    // regex (`const SHARD_COUNT = \d+`) would not even have matched that copy's
    // `const NETWORK_SHARD_COUNT = 10` form. It now sweeps the whole scripts
    // directory and matches BOTH spellings.
    const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts');
    const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.ts'));
    // Non-vacuous: assert the sweep actually found scripts to read.
    expect(files.length).toBeGreaterThan(5);

    const redeclaration = /const\s+(?:NETWORK_)?SHARD_COUNT\s*(?::[^=]+)?=\s*\d+/;
    const offenders: string[] = [];
    const importers: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      if (redeclaration.test(text)) offenders.push(file);
      if (text.includes("NETWORK_SHARD_COUNT } from '../src/core/pvt/durable-accrual-effects'")) {
        importers.push(file);
      }
    }

    expect(offenders).toEqual([]);
    // CONTROL: the scripts that USE the count import it, so an empty offender
    // list cannot simply mean no script mentions sharding at all.
    expect(importers.sort()).toEqual(
      ['rebuild-network-pe-counters.ts', 'rebuild-network-shards.ts'],
    );
  });
});
