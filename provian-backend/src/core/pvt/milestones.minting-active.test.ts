/**
 * `minting_active` must not be a claim about a retired deployment.
 *
 * `GET /v1/pvt/milestones` was unmounted, so the field it publishes was never
 * public. opens the endpoint at flip, and review caught that the field was
 * still `!!(process.env.PVT_CONTRACT_ADDRESS && process.env.PVT_MINTER_KEY)` * two retired PVTv8-era variables, one of which (`PVT_MINTER_KEY`) is
 * signer-free everywhere that name appears and therefore never evidenced a mint
 * capability at all.
 *
 * That value was wrong in BOTH directions: set, it asserted live minting from a
 * retired deployment; unset, it asserted no minting while PVT9 has minted on
 * Base mainnet.
 *
 * It is now a NAMED CONSTANT meaning "no automatic mint runtime is exposed to
 * callers" true, stable, and consistent with `x-pvt9-runtime.mint_active:
 * false` in `GET /v1/openapi.json`, which opens to the same unauthenticated
 * audience on the same flip. Deriving it from `requireConfiguredPvt9Runtime()`
 * would have published `true` against openapi's `false`; reconciling those two
 * public surfaces is a public-claim decision tracked for the operator in OPEN_ITEMS.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { RedisCache } from '../../cache';
import { checkAllMilestones } from './milestones';

const LEGACY_ENV = ['PVT_CONTRACT_ADDRESS', 'PVT_MINTER_KEY'] as const;

function makeCache(): RedisCache {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  } as unknown as RedisCache;
}

function deps() {
  return {
    db: createFakeFirestore() as unknown as Firestore,
    cache: makeCache(),
    peBuffer: { enqueue: jest.fn() },
  } as never;
}

describe('milestones.minting_active', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of LEGACY_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of LEGACY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('does not change when the retired PVTv8 variables are set or unset', async () => {
    // defect 4: the value now derives from the settlement rail's OWN
    // arming token — armed here so the invariance leg runs at the live truth.
    process.env.PVT9_SETTLEMENT_ARMED = 'yes-settle-real-pvt';
    const withoutLegacy = await checkAllMilestones(deps());

    process.env.PVT_CONTRACT_ADDRESS = '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa';
    process.env.PVT_MINTER_KEY = 'not-a-key';
    const withLegacy = await checkAllMilestones(deps());

    expect(withoutLegacy.minting_active).toBe(withLegacy.minting_active);
    expect(withoutLegacy.minting_active).toBe(true);
    delete process.env.PVT9_SETTLEMENT_ARMED;
  });

  it('[ RED pair] an UNARMED environment answers false — the value is derived, not a constant', async () => {
    delete process.env.PVT9_SETTLEMENT_ARMED;
    const unarmed = await checkAllMilestones(deps());
    expect(unarmed.minting_active).toBe(false);
  });

  it('agrees with the openapi x-pvt9-runtime block it goes public alongside', () => {
    // Both are unauthenticated and both open at the same flip. Bound to the
    // openapi SOURCE rather than a restated literal, so the two cannot drift
    // into contradiction without this failing.
    const openapi = fs.readFileSync(
      path.join(__dirname, '../../routes/openapi.ts'), 'utf8',
    );
    // Both surfaces derive from the SAME arming expression — pinned by source.
    expect(openapi).toContain('mint_active: settlementArmed');
    expect(openapi).toContain('process.env[ARMED_ENV] === ARMING_TOKEN');
  });

  it('NEGATIVE CONTROL: the retired expression it replaced DID vary with those variables', () => {
    // The exact predicate that shipped before the fix, so the assertion above is
    // shown to be observing a real difference rather than a constant.
    const retired = () => !!(process.env.PVT_CONTRACT_ADDRESS && process.env.PVT_MINTER_KEY);
    expect(retired()).toBe(false);
    process.env.PVT_CONTRACT_ADDRESS = '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa';
    process.env.PVT_MINTER_KEY = 'not-a-key';
    expect(retired()).toBe(true);
  });

  it('the source no longer reads either retired variable', () => {
    const source = fs.readFileSync(path.join(__dirname, 'milestones.ts'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[^\S\n]*\/\/.*$/gm, '');
    for (const key of LEGACY_ENV) {
      expect(executable).not.toContain(`process.env.${key}`);
    }
    // …and the control that the stripper did not simply eat the file.
    expect(executable).toContain('minting_active:');
  });
});
