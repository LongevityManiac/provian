/**
 * Ops follow-up 2026-10-07 — a wallet born before relationship documents existed resolves
 * unlinked ONLY from its own evidence; every doubt keeps the integrity failure (Unknown = Block).
 * Production case: 13 `platform: 'test'` wallets (2026-07-08..07-22) whose acts rested in
 * pending_review because every beneficiary read threw `beneficiary_relationship_integrity:missing`.
 */

import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { canonicalAgentPeHash } from '../agent-wallet/canonical-agent-pe-chain';
import { resolveBeneficiary } from './beneficiary';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';

const AGENT = 'legacy-agent';
const WALLET = 'wallet_aw_legacy-0001';
const ADDRESS = `0x${'5'.repeat(40)}`;
const cache = { setBeneficiaryStatus: async () => undefined } as unknown as RedisCache;

function birthPe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: 'pe_birth', wallet_id: WALLET, agent_id: AGENT, user_id: AGENT, action_type: 'agent_wallet_created',
    actor_address: ADDRESS, timestamp: 1_783_476_862_615, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { badges: [], wallet_type: 'agent_self_signup', platform: 'test' },
    compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
    trust_level_at_creation: 'basic', created_at: 1_783_476_862_615, durability: 'durable',
    ...overrides,
  };
  return { ...raw, hash: canonicalAgentPeHash(raw) };
}

async function seed(opts: {
  wallet?: Record<string, unknown>;
  legacy?: Array<[string, Record<string, unknown>]>;
  acts?: Array<[string, Record<string, unknown>]>;
} = {}): Promise<FakeFirestore> {
  const db = createFakeFirestore();
  await db.collection('agent_wallets').doc(WALLET).set({
    id: WALLET, agent_id: AGENT, address: ADDRESS, status: 'active', platform: 'test',
    linked_human_wallet_id: null, linked_human_user_id: null, linked_human_address: null,
    operational_reserve_ratio: null, rotation_count: 0, ...(opts.wallet ?? {}),
  });
  for (const [id, data] of opts.legacy ?? [['pe_birth', birthPe()]]) {
    await db.collection('identity_pes_legacy_v1').doc(id).set(data);
  }
  for (const [id, data] of opts.acts ?? []) await db.collection('identity_acts_v1').doc(id).set(data);
  return db;
}

async function resolve(db: FakeFirestore): Promise<string> {
  try {
    const entry = await resolveBeneficiary(AGENT, cache, db as unknown as Firestore);
    return entry.linked ? 'linked' : 'unlinked';
  } catch (error) {
    return `throws:${(error as Error).message}`;
  }
}

const MISSING = 'throws:beneficiary_relationship_integrity:missing';

describe('resolveBeneficiary — a pre-relationship wallet without a relationship document', () => {
  it('GREEN: an authentic birth certificate, no link fields and no link history → unlinked', async () => {
    expect(await resolve(await seed())).toBe('unlinked');
  });

  it('GREEN: a badge-policy update in its history does not bear a relationship', async () => {
    const policy = { id: 'pe_pol', user_id: AGENT, action_type: 'policy_updated', metadata: { policy_key: 'badge_qualification' } };
    expect(await resolve(await seed({ legacy: [['pe_birth', birthPe()], ['pe_pol', policy]] }))).toBe('unlinked');
  });

  const refused: Array<[string, Parameters<typeof seed>[0]]> = [
    ['a linked-human field on the wallet', { wallet: { linked_human_user_id: 'user_h' } }],
    ['a parent wallet', { wallet: { parent_wallet_id: 'wallet_aw_parent' } }],
    ['a share value', { wallet: { operational_reserve_bps: 2000 } }],
    ['a rotated key', { wallet: { rotation_count: 1 } }],
    ['a tampered birth certificate (hash no longer reproduces)', { legacy: [['pe_birth', { ...birthPe(), timestamp: 1 }]] }],
    ['a birth certificate for another address', { legacy: [['pe_birth', birthPe({ actor_address: `0x${'6'.repeat(40)}` })]] }],
    ['a birth certificate carrying a relationship binding', { legacy: [['pe_birth', birthPe({ metadata: { beneficiary_relationship: { state: 'unlinked' } } })]] }],
    ['no birth certificate', { legacy: [] }],
    ['two birth certificates', { legacy: [['pe_birth', birthPe()], ['pe_birth2', birthPe({ id: 'pe_birth2' })]] }],
    ['a legacy link PE in its history', { legacy: [['pe_birth', birthPe()], ['pe_link', { id: 'pe_link', user_id: AGENT, action_type: 'agent_linked_to_human', metadata: {} }]] }],
    ['a post-meter link identity act', { acts: [['pe_act', { actor_id: AGENT, act: { action_type: 'agent_unlinked_from_human' } }]] }],
    ['a post-meter policy_updated identity act', { acts: [['pe_act', { actor_id: AGENT, act: { action_type: 'policy_updated' } }]] }],
  ];
  it.each(refused)('RED: %s keeps the integrity failure', async (_label, opts) => {
    expect(await resolve(await seed(opts))).toBe(MISSING);
  });
});
