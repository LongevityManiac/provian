import { test, expect } from 'vitest';
import { assertManifestSuccession, POINTER_SLOTS } from './pointer-manifest-succession.mjs';

const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const zero = a(0);
const live = () => Array.from({ length: 10 }, (_, i) => a(100 + i));
const replace = (set, slot, value) => set.map((address, i) => (i === slot ? value : address));

test('an unchanged manifest and a first publication are accepted', () => {
  expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: live() })).not.toThrow();
  expect(() => assertManifestSuccession({ revision: 0n, current: Array(10).fill(zero), next: live() })).not.toThrow();
});

test('replacing only the settlement adapter beside the same token is refused', () => {
  const next = replace(live(), POINTER_SLOTS.settlementAdapter, a(900));
  expect(() => assertManifestSuccession({ revision: 1n, current: live(), next }))
    .toThrow('pointer_manifest_settlement_adapter_replaced_under_same_token');
  // Address case is not a difference.
  const upper = live().map(address => '0x' + address.slice(2).toUpperCase());
  expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: upper })).not.toThrow();
});

test('the adapter may change only together with the token', () => {
  const whole = live().map((_, i) => a(500 + i));
  expect(() => assertManifestSuccession({ revision: 3n, current: live(), next: whole })).not.toThrow();
  const tokenAndAdapter = replace(replace(live(), POINTER_SLOTS.token, a(700)), POINTER_SLOTS.settlementAdapter, a(701));
  expect(() => assertManifestSuccession({ revision: 3n, current: live(), next: tokenAndAdapter })).not.toThrow();
});

test('the pool and the token-bound institutions are held to the same rule', () => {
  expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: replace(live(), POINTER_SLOTS.recoursePool, a(900)) }))
    .toThrow('pointer_manifest_recourse_pool_replaced_under_same_token');
  for (const slot of [POINTER_SLOTS.escrow, POINTER_SLOTS.projectPool, POINTER_SLOTS.bonds, POINTER_SLOTS.court]) {
    expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: replace(live(), slot, a(900)) }))
      .toThrow('pointer_manifest_institution_replaced_under_same_token');
  }
  // Verifiers and promises may be replaced beside the same token, as the pointer allows.
  for (const slot of [POINTER_SLOTS.eligibilityVerifier, POINTER_SLOTS.beneficiaryVerifier, POINTER_SLOTS.promises]) {
    expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: replace(live(), slot, a(900)) })).not.toThrow();
  }
});

test('malformed input is refused, never passed', () => {
  expect(() => assertManifestSuccession({ revision: 1, current: live(), next: live() })).toThrow('pointer_manifest_revision_invalid');
  expect(() => assertManifestSuccession({ revision: 1n, current: live().slice(1), next: live() })).toThrow('pointer_manifest_current_invalid');
  expect(() => assertManifestSuccession({ revision: 1n, current: live(), next: replace(live(), 9, 'nope') })).toThrow('pointer_manifest_next_invalid');
  expect(() => assertManifestSuccession({ revision: 0n, current: live(), next: live() })).toThrow('pointer_manifest_unpublished_set_not_empty');
  expect(() => assertManifestSuccession({ revision: 2n, current: Array(10).fill(zero), next: live() })).toThrow('pointer_manifest_current_token_missing');
});
