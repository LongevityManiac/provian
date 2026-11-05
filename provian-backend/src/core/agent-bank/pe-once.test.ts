/**
 * `generatePEOnce` one PE per named event, the lock created in the SAME transaction as the
 * envelope, so a retry of a writer that seals before it flips state never seals a second row.
 */
import { describe, it, expect } from '@jest/globals';
import { generatePEOnce, standingEventLockId, STANDING_EVENT_LOCKS_COLLECTION } from './pe-once';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps } from './types';
import type { generatePE } from './pe-utils';

type Gen = typeof generatePE;

/** A stand-in for generatePE that honors the two atomic hooks inside ONE transaction, as the real one does. */
function fakeGenerate(db: ReturnType<typeof createFakeFirestore>, sealedIds: string[], failAfterPrecondition = false): Gen {
  let n = 0;
  return (async (_deps: unknown, params: Parameters<Gen>[1]) => {
    const peId = `pe_${++n}_${params.walletId}`;
    await (db as unknown as { runTransaction: (fn: (t: unknown) => Promise<void>) => Promise<void> }).runTransaction(async (txn) => {
      await params.atomicEntityPrecondition?.(txn as never, { prevHash: 'p' });
      if (failAfterPrecondition) throw new Error('chain_tip_contention');
      (txn as { set: (ref: unknown, data: unknown) => void }).set(db.collection('provenance_envelopes').doc(peId), { pe_id: peId });
      params.atomicEntityWrite?.(txn as never, peId, { prevHash: 'p', newHash: 'h', timestamp: 1 });
    });
    sealedIds.push(peId);
    return { peId, peHash: 'h', prevHash: 'p' };
  }) as unknown as Gen;
}

const PARAMS = { walletId: 'w1', agentId: 'a1', actorAddress: '0x1', actionType: 'escrow_resolved', metadata: {} } as Parameters<Gen>[1];

describe('generatePEOnce', () => {
  it('seals once; a repeat call returns the SAME PE and seals nothing (RED: a bare generate seals twice)', async () => {
    const db = createFakeFirestore();
    const deps = { db } as unknown as AgentBankDeps;
    const sealed: string[] = [];
    const gen = fakeGenerate(db, sealed);
    const first = await generatePEOnce(deps, ['escrow_resolved', 'esc1', 'recipient'], PARAMS, gen);
    const again = await generatePEOnce(deps, ['escrow_resolved', 'esc1', 'recipient'], PARAMS, gen);
    expect(first).toEqual({ peId: sealed[0], sealed: true });
    expect(again).toEqual({ peId: sealed[0], sealed: false });
    expect(sealed).toHaveLength(1);
    expect(db.store.get(`${STANDING_EVENT_LOCKS_COLLECTION}/escrow_resolved__esc1__recipient`)).toMatchObject({ pe_id: sealed[0] });
    // RED control: the same two calls WITHOUT the lock seal two rows.
    await gen(deps, PARAMS);
    await gen(deps, PARAMS);
    expect(sealed).toHaveLength(3);
  });

  it('a different event (other role, other escrow) is its own row', async () => {
    const db = createFakeFirestore();
    const deps = { db } as unknown as AgentBankDeps;
    const sealed: string[] = [];
    const gen = fakeGenerate(db, sealed);
    await generatePEOnce(deps, ['escrow_resolved', 'esc1', 'recipient'], PARAMS, gen);
    await generatePEOnce(deps, ['escrow_resolved', 'esc1', 'depositor'], PARAMS, gen);
    await generatePEOnce(deps, ['escrow_resolved', 'esc2', 'recipient'], PARAMS, gen);
    expect(sealed).toHaveLength(3);
  });

  it('a seal that fails leaves NO lock, so the retry seals (PE and lock are one transaction)', async () => {
    const db = createFakeFirestore();
    const deps = { db } as unknown as AgentBankDeps;
    const sealed: string[] = [];
    await expect(generatePEOnce(deps, ['commons_challenge_resolved', 'c1', 'challenged'], PARAMS, fakeGenerate(db, sealed, true))).rejects.toThrow('chain_tip_contention');
    expect(db.store.has(`${STANDING_EVENT_LOCKS_COLLECTION}/commons_challenge_resolved__c1__challenged`)).toBe(false);
    const retry = await generatePEOnce(deps, ['commons_challenge_resolved', 'c1', 'challenged'], PARAMS, fakeGenerate(db, sealed));
    expect(retry.sealed).toBe(true);
    expect(sealed).toHaveLength(1);
  });

  it('lock ids are safe document ids', () => {
    expect(standingEventLockId(['escrow_resolved', 'esc/1', 'recipient'])).toBe('escrow_resolved__esc_1__recipient');
    expect(() => standingEventLockId([''])).toThrow();
  });
});
