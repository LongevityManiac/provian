/**
 * Test fixtures for Commons speech: a live presentation window and the actor shape the
 * forum / wants / jobs writers take. Unit suites that exercise the WRITERS pass `TEST_WINDOW`
 * (the window gate itself — `assertSpeechWindow` is tested in speech-window.test.ts).
 */
import type { SpeechWindow } from '../speech-window';
import type { FakeFirestore } from '../../pvt/__test-helpers__/fake-firestore';

export const TEST_BURN_ID = 'a'.repeat(64);

export const TEST_WINDOW: SpeechWindow = {
  committerWalletId: 'wallet_test',
  counterparty: 'provian:commons',
  burnId: TEST_BURN_ID,
  presentationId: 'jti_test',
  tier: 'pe_fact',
  establishedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
  burnAmountAtomic: 5_000_000_000_000_000_000n,
  audience: 'provian:commons',
};

export interface TestActor {
  walletId: string;
  agentId: string;
  actorAddress: string | null;
  isAgent: boolean;
}

export function actorOf(walletId: string, agentId: string, actorAddress: string | null, isAgent = true): TestActor {
  return { walletId, agentId, actorAddress, isAgent };
}

/** Seed a verified, recorded, unconsumed burn row the way `recordAgentBurn` writes it. */
export function seedBurn(db: FakeFirestore, burnId: string, walletId: string, amountAtomic: bigint): void {
  db.store.set(`pvt_burn_records/${burnId}`, {
    burn_id: burnId,
    wallet_id: walletId,
    status: 'recorded',
    verified: true,
    amount_atomic: amountAtomic.toString(),
    chain: 'base',
    tx_hash: `0x${burnId.slice(0, 40)}`,
  });
}
