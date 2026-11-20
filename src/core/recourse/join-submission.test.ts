import { expect, it, vi } from 'vitest';
import { canClearJoinSubmission, readJoinSubmission, saveJoinSubmission } from './join-submission';
import type { MembershipConsentChallenge, MembershipTransitionView } from './membership-client';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
} }));

const hash = (byte: string) => `0x${byte.repeat(32)}`;
const saved = { transitionId: hash('11'), binding: hash('22'), operationId: hash('33'), expiresAt: '1300' };
const challenge = (expiresAt: string) => ({ consent: { binding: saved.binding, expiresAt } }) as MembershipConsentChallenge;
const view: MembershipTransitionView = { id: saved.transitionId, kind: 'join', status: 'consenting', pending: [], challenges: [challenge('1350')] };

it('recovers the uncertain submission on reopening and leaves the stale approval blocked', async () => {
  await saveJoinSubmission('wallet-one', saved);
  await expect(readJoinSubmission('wallet-two')).resolves.toBeNull();
  const recovered = await readJoinSubmission('wallet-one');
  expect(recovered).toEqual(saved);
  expect(canClearJoinSubmission(recovered!, view, null)).toBe(false);
});

it('checks definitive failure or verified expiry before making approval available again', () => {
  expect(canClearJoinSubmission(saved, view, { id: saved.operationId, status: 'failed', transactionHash: null })).toBe(true);
  expect(canClearJoinSubmission(saved, { ...view, challenges: [challenge('1600')] }, null)).toBe(false);
  expect(canClearJoinSubmission(saved, { ...view, challenges: [challenge('1601')] }, null)).toBe(true);
  expect(canClearJoinSubmission(saved, { ...view, challenges: [challenge('1601')] },
    { id: saved.operationId, status: 'submitted', transactionHash: hash('44') })).toBe(false);
  expect(canClearJoinSubmission(saved, { ...view, status: 'complete', challenges: [] }, null)).toBe(true);
});

it('unblocks other wallets after the saved approval is reconciled, including a deduplicated reply', () => {
  const remaining = { ...view, challenges: [{ consent: { binding: hash('44') } } as MembershipConsentChallenge] };
  const confirmed = { id: saved.operationId, status: 'confirmed', transactionHash: hash('55') } as const;
  expect(canClearJoinSubmission(saved, remaining, null)).toBe(true);
  expect(canClearJoinSubmission(saved, remaining, confirmed)).toBe(true);
  expect(canClearJoinSubmission(saved, view, confirmed)).toBe(false);
});
