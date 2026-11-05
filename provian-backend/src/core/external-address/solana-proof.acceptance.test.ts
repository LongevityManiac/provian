/**
 * follow-up — PROVING A SOLANA ADDRESS PAYS NOTHING, through the REAL `generatePE`
 * and the REAL `recordPEAccrual` over a fake Firestore (only the slot read is injected).
 *
 * The receipt is the existing `external_address_proven` act — record_only for every owner in the
 * armed matrix — sealed on the owner's own chain with `chain: 'solana'` and `no_pvt: true`. No
 * matrix row and no template moved for this. The RED control proves the same harness CAN mint (an
 * eligible financial act sealed beside it), so "mints 0" is a fact about the act, not the harness.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import crypto from 'crypto';
import type { FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('../pvt/beneficiary', () => ({
  resolveBeneficiary: async () => ({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('../pvt/delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from '../../pvt-accrual';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import { meterActRow } from '../pvt/__test-helpers__/meter-acts';
import { base58Encode } from './solana-keys';
import { issueSolanaChallengeFor, proveSolanaAddress, type SolanaProofOwner } from './solana-proof';

const DAY = Date.UTC(2026, 9, 4, 12, 0, 0);
const SLOT = 300_000_000;

function key() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    address: base58Encode(Buffer.from(jwk.x, 'base64url')),
    sign: (m: string) => base58Encode(crypto.sign(null, Buffer.from(m, 'utf8'), privateKey)),
  };
}

function deps(): AgentBankDeps {
  const store = new Map<string, unknown>();
  return {
    db: mockDb,
    cache: {
      isEnabled: () => true,
      async set(k: string, v: unknown) { store.set(k, v); },
      async setNx(k: string, v: unknown) { if (store.has(k)) return false; store.set(k, v); return true; },
      async get<T>(k: string) { return store.has(k) ? (store.get(k) as T) : null; },
      async del(k: string) { store.delete(k); },
    },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: (p: Record<string, unknown>) => recordPEAccrual(p as unknown as Parameters<typeof recordPEAccrual>[0]),
  } as unknown as AgentBankDeps;
}

const AGENT: SolanaProofOwner = { ownerType: 'agent', agentId: 'agentS', walletId: 'wS', ownerEvmAddress: '0xaaaa00000000000000000000000000000000000a' };
const PERSON: SolanaProofOwner = { ownerType: 'human', userId: 'personS', walletId: 'hwS', ownerEvmAddress: '0xcccc00000000000000000000000000000000000c' };

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  mockDb.store.set('agent_wallets/wS', { id: 'wS', agent_id: 'agentS', address: AGENT.ownerEvmAddress, platform: 'claude', status: 'active' });
  mockDb.store.set('wallets/hwS', { id: 'hwS', user_id: 'personS', type: 'human', address: PERSON.ownerEvmAddress });
});
afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('the Solana proof receipt is a record, never money', () => {
  it.each<[string, SolanaProofOwner]>([['agent', AGENT], ['person', PERSON]])('%s: external_address_proven seals record_only on the owner\'s chain and mints 0', async (_label, owner) => {
    const d = deps();
    const k = key();
    const ch = await issueSolanaChallengeFor(d.cache, owner, k.address);
    const result = await proveSolanaAddress(d, {
      owner, address: k.address, challengeId: ch.challenge_id, signature: k.sign(ch.message), origin: 'native', env: {},
    }, { getHeadSlot: async () => SLOT });
    expect(result).toMatchObject({ ok: true, proven_at_slot: SLOT });
    // The receipt is priced asynchronously by the meter path; give it its turn.
    await new Promise((r) => setImmediate(r));
    const row = meterActRow(mockDb.store, result.pe_id as string);
    expect(row).toMatchObject({
      actionType: 'external_address_proven',
      userId: owner.ownerType === 'agent' ? 'agentS' : 'personS',
      mint_disposition: 'record_only',
      estimatedPVT: 0,
    });
  });

  it('RED control (the harness can mint): an eligible financial act sealed the same way mints > 0', async () => {
    await generatePE(deps(), {
      walletId: 'wS', agentId: 'agentS', actorAddress: AGENT.ownerEvmAddress, actionType: 'send', ownerType: 'agent',
      walletAddress: AGENT.ownerEvmAddress, counterpartyAddress: '0x5000000000000000000000000000000000000005',
      metadata: { verified: true, tx_hash: `0x${'ab'.repeat(32)}` }, observedCanonicalEventId: `8453:0x${'ab'.repeat(32)}:1`,
      peIdOverride: 'pe_control_send', timestampOverride: DAY, awaitAccrual: true,
    });
    const row = meterActRow(mockDb.store, 'pe_control_send');
    expect(row).toMatchObject({ actionType: 'send', mint_status: 'eligible' });
    expect(row?.estimatedPVT as number).toBeGreaterThan(0);
  });
});
