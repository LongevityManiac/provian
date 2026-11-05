/**
 * the lineage verifier, and the RED controls the rule demands.
 *
 * The rule has four prohibitions and one positive requirement, and every one of
 * them is exercised here with a CONSTRUCTIBLE violating case (a guard
 * whose violation a literal type forbids is a guard that cannot fail — which is
 * why `verifyEconomicSessionLineage` takes `unknown`).
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import {
  ECONOMIC_SESSION_LINEAGE_PREFIX,
  deriveEconomicSessionLineageId,
  isAccountDerivedLineageId,
  verifyEconomicSessionLineage,
} from './economic-session-lineage';

const DEVICE = 'dev_attested_abc123';
const OTHER_DEVICE = 'dev_attested_zzz999';
const START = Date.UTC(2026, 7, 3, 9, 0);
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const USER = 'user_human_42';

function claimFor(deviceId: string, over: Record<string, unknown> = {}) {
  return {
    v: 2,
    session_started_at_ms: START,
    session_nonce: NONCE,
    session_ordinal: 1,
    id: deriveEconomicSessionLineageId({
      attestedDeviceId: deviceId, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    }),
    ...over,
  };
}

/** Shape refusals: [reason, claim]. Driven by the `it.each` below and by the exhaustiveness control. */
const SHAPE_REFUSALS: ReadonlyArray<[string, unknown]> = [
  ['malformed_claim', 'not-an-object'],
  ['malformed_claim', { no_version_key: true }],
  // the population `unsupported_version` EXISTS for: a genuine stale
  // v1 artifact from the / SDK, which has no `session_ordinal` at
  // all. It used to answer `malformed_claim`, because the shape check ran
  // first — so the by-name failure fired only for a forged v2 claim with an
  // edited `v`, never for the migration case it was written for.
  ['unsupported_version', {
    v: 1,
    session_started_at_ms: 1_700_000_000_000,
    session_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    id: `pesl1_${'c'.repeat(40)}`,
  }],
  ['unsupported_version', { ...claimFor(DEVICE), v: 3 }],
  ['invalid_nonce', { ...claimFor(DEVICE), session_nonce: 'NOTHEX' }],
  ['invalid_nonce', { ...claimFor(DEVICE), session_nonce: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' }],
  ['invalid_session_start', { ...claimFor(DEVICE), session_started_at_ms: -1 }],
  ['invalid_session_start', { ...claimFor(DEVICE), session_started_at_ms: 1.5 }],
  ['invalid_session_ordinal', { ...claimFor(DEVICE), session_ordinal: 0 }],
  ['invalid_session_ordinal', { ...claimFor(DEVICE), session_ordinal: 1.5 }],
  ['invalid_id_format', { ...claimFor(DEVICE), id: 'pesl2_nothex' }],
  ['invalid_id_format', { ...claimFor(DEVICE), id: 'wrongprefix_' + '0'.repeat(40) }],
];

/**
 * One real input per refusal arm — [claim, authenticated device, account ids]. The exhaustiveness
 * control runs every one of these itself, so its population never depends on which tests ran first.
 */
const REFUSAL_INPUTS: ReadonlyArray<[unknown, string | null, string[]]> = [
  [undefined, DEVICE, []],
  [{ ...claimFor(DEVICE), id: `${ECONOMIC_SESSION_LINEAGE_PREFIX}${'0'.repeat(40)}` }, DEVICE, []],
  [{
    ...claimFor(DEVICE),
    id: `${ECONOMIC_SESSION_LINEAGE_PREFIX}${crypto.createHash('sha256').update(USER, 'utf8').digest('hex').slice(0, 40)}`,
  }, DEVICE, [USER]],
  [claimFor(DEVICE), null, []],
  ...SHAPE_REFUSALS.map(([, claim]): [unknown, string, string[]] => [claim, DEVICE, [USER]]),
];

describe('the derivation', () => {
  it('is deterministic and shaped as declared', () => {
    const id = deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    });
    expect(id).toBe(deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    }));
    expect(id.startsWith(ECONOMIC_SESSION_LINEAGE_PREFIX)).toBe(true);
    expect(id).toMatch(/^pesl2_[0-9a-f]{40}$/);
  });

  /**
   * THE CROSS-PACKAGE VECTOR, pinned as a LITERAL on both sides.
   *
   * The first cut recomputed the expectation from an inline `JSON.stringify` in
   * each suite — so each side only ever compared itself against itself, and the
   * reviewer proved it: renaming `attested_device_id` in the SDK derivation AND
   * its own test literal (the tandem edit anyone touching "the SDK side" makes)
   * left BOTH suites green while the two implementations produced different ids.
   * The production consequence is worse than the fence re-raising: the relay 400s
   * before the chain-tip advance, so a silent divergence would stop every
   * observer-emitted PE from being RECORDED, with nothing red anywhere.
   *
   * This literal is the binding. Changing the derivation on either side must move
   * this string, in both packages, in one commit.
   */
  it('THE CROSS-PACKAGE VECTOR — pinned literal, mirrored in the SDK suite', () => {
    expect(deriveEconomicSessionLineageId({
      attestedDeviceId: 'dev_vector',
      sessionStartedAtMs: 1785715200000,
      sessionNonce: '00112233445566778899aabbccddeeff',
      sessionOrdinal: 1,
    })).toBe('pesl2_0065b35cc24445e9d233d9bdde368b8c7e423c42');
  });

  it('the ORDINAL is inside the digest, so it cannot be edited after minting', () => {
    // the registry's monotonicity guarantee is only worth something if
    // the ordinal is bound. If it sat beside the id instead of inside it, a
    // client could present any ordinal it liked with a valid id.
    const a = deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    });
    const b = deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 2,
    });
    expect(a).not.toBe(b);
    // And an edited ordinal on an otherwise valid claim is refused.
    expect(verifyEconomicSessionLineage({ ...claimFor(DEVICE), session_ordinal: 2 }, DEVICE))
.toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('every preimage component changes the id', () => {
    const base = deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    });
    const variants = [
      deriveEconomicSessionLineageId({ attestedDeviceId: OTHER_DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1 }),
      deriveEconomicSessionLineageId({ attestedDeviceId: DEVICE, sessionStartedAtMs: START + 1, sessionNonce: NONCE, sessionOrdinal: 1 }),
      deriveEconomicSessionLineageId({ attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE.replace(/0$/, '1'), sessionOrdinal: 1 }),
    ];
    expect(new Set([base, ...variants]).size).toBe(4);
  });
});

describe('GREEN — a claim minted for the authenticated device verifies', () => {
  it('accepts and returns the id', () => {
    const v = verifyEconomicSessionLineage(claimFor(DEVICE), DEVICE, [USER]);
    expect(v).toEqual({ ok: true, lineageId: claimFor(DEVICE).id });
  });

  it('ONE session, ONE id: two claims from the same session are equal', () => {
    // The causal-session rule. Two PEs captured in the same runtime session
    // carry the same nonce and start, so they resolve to the same lineage.
    const a = verifyEconomicSessionLineage(claimFor(DEVICE), DEVICE);
    const b = verifyEconomicSessionLineage(claimFor(DEVICE), DEVICE);
    expect(a.ok && b.ok && a.lineageId === b.lineageId).toBe(true);
  });

  it('a DIFFERENT session on the same device is a different lineage', () => {
    const other = { ...claimFor(DEVICE), session_nonce: 'ffffffffffffffffffffffffffffffff' };
    const rebuilt = { ...other, id: deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: other.session_nonce, sessionOrdinal: 1,
    }) };
    const a = verifyEconomicSessionLineage(claimFor(DEVICE), DEVICE);
    const b = verifyEconomicSessionLineage(rebuilt, DEVICE);
    expect(a.ok && b.ok && a.lineageId !== b.lineageId).toBe(true);
  });
});

describe('RED — every prohibition in the rule, with a constructible violation', () => {
  it('absent claim -> the fence holds (not an error)', () => {
    expect(verifyEconomicSessionLineage(undefined, DEVICE))
.toEqual({ ok: false, reason: 'absent' });
    expect(verifyEconomicSessionLineage(null, DEVICE))
.toEqual({ ok: false, reason: 'absent' });
  });

  it('CLIENT-CHOSEN: a random id does not verify', () => {
    const forged = { ...claimFor(DEVICE), id: `${ECONOMIC_SESSION_LINEAGE_PREFIX}${'0'.repeat(40)}` };
    expect(verifyEconomicSessionLineage(forged, DEVICE))
.toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('WRONG DEVICE: an id minted for another device does not verify here', () => {
    // The binding that makes it verifiable rather than declared: the relay
    // recomputes with the device IT authenticated.
    expect(verifyEconomicSessionLineage(claimFor(OTHER_DEVICE), DEVICE))
.toEqual({ ok: false, reason: 'digest_mismatch' });
    // ...and the same claim IS valid for the device it was minted for, which
    // proves the refusal above is about the binding and not about the fixture.
    expect(verifyEconomicSessionLineage(claimFor(OTHER_DEVICE), OTHER_DEVICE).ok).toBe(true);
  });

  it('ACCOUNT-DERIVED: an id built from the account identity is refused BY NAME', () => {
    const hashed = crypto.createHash('sha256').update(USER, 'utf8').digest('hex').slice(0, 40);
    const accountDerived = { ...claimFor(DEVICE), id: `${ECONOMIC_SESSION_LINEAGE_PREFIX}${hashed}` };
    expect(verifyEconomicSessionLineage(accountDerived, DEVICE, [USER]))
.toEqual({ ok: false, reason: 'account_derived_id' });
    // The raw account id, and a wallet address, are refused the same way.
    expect(isAccountDerivedLineageId(USER, [USER])).toBe(true);
    expect(isAccountDerivedLineageId('0xABC', [null, undefined, '', '0xabc'])).toBe(true);
    // Positive control: an honest id is NOT flagged, so the guard is not a
    // blanket refusal wearing a specific name.
    expect(isAccountDerivedLineageId(claimFor(DEVICE).id, [USER, '0xabc'])).toBe(false);
  });

  it('RELAY-SYNTHESIZED: with no attested device there is nothing to bind to', () => {
    expect(verifyEconomicSessionLineage(claimFor(DEVICE), null))
.toEqual({ ok: false, reason: 'no_attested_device' });
    expect(verifyEconomicSessionLineage(claimFor(DEVICE), '   '))
.toEqual({ ok: false, reason: 'no_attested_device' });
  });

  it.each(SHAPE_REFUSALS)('fails closed with %s', (reason, claim) => {
    const v = verifyEconomicSessionLineage(claim, DEVICE, [USER]);
    expect(v).toEqual({ ok: false, reason });
  });

  it('the refusal set is EXHAUSTIVE over the reasons this module declares', () => {
    // this used to compare the declared union against a HAND-WRITTEN
    // literal in this file, which proved only that the union equalled the
    // literal: adding a seventh reason plus one line to the literal, with no
    // test at all, passed. The self-referential-control shape, in the very
    // test whose job was to catch an untested arm.
    //
    // A reason enters `exercised` only by having been RETURNED by the module
    // under a real input, and every input is run HERE (the set used to be
    // filled as a side effect of the tests above, so `jest --randomize` running
    // this control first saw only part of it).
    const exercised = new Set<string>();
    for (const [claim, device, accountIds] of REFUSAL_INPUTS) {
      const v = verifyEconomicSessionLineage(claim, device, accountIds);
      expect(v.ok).toBe(false);
      if (!v.ok) exercised.add(v.reason);
    }
    expect(exercised.size).toBeGreaterThan(0);
    const declared = new Set(
      require('fs').readFileSync(`${__dirname}/economic-session-lineage.ts`, 'utf8')
        .split('export type EconomicSessionLineageRejection =')[1]
        .split(';')[0]
        .match(/'([a-z_]+)'/g)!
        .map((s: string) => s.replace(/'/g, '')),
    );
    expect([...declared].sort()).toEqual([...exercised].sort());
  });
});
