/**
 * origin-independence — the pure witness + independence + volume decision (, Prompt 3).
 * Every branch has a RED control: a positive (counted / observed) paired with the negative that
 * must add zero. A test over an empty population is a distinct status, never a silent pass.
 */

import {
  decideOrigin,
  computeOriginIndependence,
  type OriginResolution,
  type SealedOriginRef,
} from './origin-independence';
import type { InputOrigin } from '../provenance/input-origins';

const origin = (id: string, hash = `sha256:${id}`): InputOrigin => ({
  hash,
  origin_identifier: id,
  witnessed: true,
});

const RESOLVED: OriginResolution = {
  witnessed: true,
  witness: { identity: 'dev_x', tier: 'software' },
  owner: 'evm:0xexternal',
  privateHashed: false,
  identitySetUnresolvable: false,
  sameParty: false,
  closedLoop: false,
};

describe('decideOrigin — the two-question fence', () => {
  it('COUNTS a witnessed, resolvable, independent, non-loop origin', () => {
    const d = decideOrigin(origin('evm:0xexternal'), RESOLVED);
    expect(d.counted).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.owner).toBe('evm:0xexternal');
    expect(d.witness).toEqual({ identity: 'dev_x', tier: 'software' });
  });

  // RED controls: each negative must add zero, paired with the positive above.
  it('unwitnessed -> counts zero (reason unwitnessed), witness dropped', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, witnessed: false });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('unwitnessed');
    expect(d.witness).toBeNull();
  });
  it('private/hashed -> counts zero (reason private_hashed)', () => {
    const d = decideOrigin(origin('private_file'), { ...RESOLVED, privateHashed: true });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('private_hashed');
  });
  it('unresolvable owner -> counts zero (reason unresolvable_owner)', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, owner: null });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('unresolvable_owner');
  });
  it('same party (owner inside signer identity set) -> counts zero (reason same_party)', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, sameParty: true });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('same_party');
  });
  it('closed loop -> counts zero (reason closed_loop)', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, closedLoop: true });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('closed_loop');
  });
  it('identity set unresolvable -> counts zero (reason owner_set_unresolvable), fail-closed', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, identitySetUnresolvable: true });
    expect(d.counted).toBe(false);
    expect(d.reason).toBe('owner_set_unresolvable');
  });

  // Reason PRIORITY: an origin can fail more than one test; the recorded reason is the first
  // (most fundamental) that applies. Unwitnessed wins over everything.
  it('reason priority — unwitnessed wins even when same-party and closed-loop also hold', () => {
    const d = decideOrigin(origin('x'), {
      witnessed: false, witness: null, owner: 'evm:0xself', privateHashed: true,
      identitySetUnresolvable: true, sameParty: true, closedLoop: true,
    });
    expect(d.reason).toBe('unwitnessed');
  });
  it('reason priority — same_party wins over closed_loop', () => {
    const d = decideOrigin(origin('x'), { ...RESOLVED, sameParty: true, closedLoop: true });
    expect(d.reason).toBe('same_party');
  });
});

describe('computeOriginIndependence — distinct owners', () => {
  const decide = (rs: OriginResolution[]): SealedOriginRef[] =>
    rs.map((r, i) => decideOrigin(origin(`o${i}`), r));

  it('counts N distinct witnessed independent owners', () => {
    const r = computeOriginIndependence(decide([
      { ...RESOLVED, owner: 'a' }, { ...RESOLVED, owner: 'b' }, { ...RESOLVED, owner: 'c' },
    ]));
    expect(r.independentOriginCount).toBe(3);
  });

  it('DEDUPES by owner — five origins owned by one external party count once', () => {
    const r = computeOriginIndependence(decide([
      { ...RESOLVED, owner: 'lab-x' }, { ...RESOLVED, owner: 'lab-x' },
      { ...RESOLVED, owner: 'lab-x' }, { ...RESOLVED, owner: 'lab-x' }, { ...RESOLVED, owner: 'lab-x' },
    ]));
    expect(r.independentOriginCount).toBe(1);
  });

  // RED control: an uncounted origin (even with a distinct owner) must not raise the count.
  it('RED — uncounted origins (same-party/unresolvable) add nothing', () => {
    const r = computeOriginIndependence(decide([
      { ...RESOLVED, owner: 'a' },                     // counts
      { ...RESOLVED, owner: 'b', sameParty: true },     // same party -> 0
      { ...RESOLVED, owner: null },                     // unresolvable -> 0
      { ...RESOLVED, owner: 'c', witnessed: false },    // unwitnessed -> 0
    ]));
    expect(r.independentOriginCount).toBe(1);
  });

  // Empty population is a distinct, non-passing shape : zero origins -> zero, not vacuous.
  it('empty population -> count 0 (byte-identical to today on the multiplier)', () => {
    const r = computeOriginIndependence([]);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins).toHaveLength(0);
  });
});
