/**
 * a ROTATED agent's beneficiary relationship is validated against an address lineage proven
 * from SEALED PEs (the registration-index-pinned `agent_wallet_created` PE + each sealed
 * `agent_key_rotated` PE), never from `chain_addresses.evm`. A REAL agent wallet (route-created) is
 * rotated through the REAL rotation transition (`rotated-agent` fixture).
 *
 * RED CONTROL RECORD (pre-fix source, which read the birth address from `chain_addresses.evm`):
 * - `chain_addresses` absent (a wallet whose creating SDK reported none,) threw
 * `beneficiary_relationship_integrity:rotation_history_birth_address`;
 * - `chain_addresses.evm` overwritten with the current address (the incident) threw
 * `beneficiary_relationship_integrity:rotation_history_lineage`.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('./proof-of-possession', () => ({
  ...(jest.requireActual('./proof-of-possession') as object),
  verifyAndConsumePopChallenge: async (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => ({
    ok: true as const,
    registration_context: { ...expected, credential_recovery_generation: challengeId === 'challenge-1' ? null : 0 },
  }),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));

import {
  readValidatedBeneficiaryRelationship,
  readValidatedBeneficiaryRelationshipInTransaction,
} from './beneficiary-relationship';
import { resolveBeneficiary } from '../pvt/beneficiary';
import type { RedisCache } from '../../cache';
import { IDENTITY_ACTS_COLLECTION } from '../meter/identity-acts';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../pvt/native-wallet-registration';
import {
  AGENT_ID,
  SIGNER_ONE,
  SIGNER_TWO,
  buildAgentRoute,
  createAgentWallet,
  rotateAgent,
  type FakeDb,
} from '../pvt/__test-helpers__/rotated-agent';

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });
const cache = {
  getBeneficiaryStatus: async () => null,
  setBeneficiaryStatus: async () => undefined,
} as unknown as RedisCache;

async function agent(rotations: number) {
  const { app, fake } = buildAgentRoute();
  const walletId = await createAgentWallet(app);
  const signers = [SIGNER_ONE, SIGNER_TWO];
  for (let i = 0; i < rotations; i += 1) {
    await tick();
    await rotateAgent(fake, walletId, signers[i], { now: Date.now(), head: 500 + i * 300 });
  }
  const key = `agent_wallets/${walletId}`;
  const db = fake as unknown as Firestore;
  const wallet = () => fake.store.get(key) as Record<string, unknown>;
  const patch = (p: Record<string, unknown>) => fake.store.set(key, { ...wallet(), ...p });
  const read = () => readValidatedBeneficiaryRelationship({ db, wallet: wallet() });
  const readInTxn = () => db.runTransaction((txn) => readValidatedBeneficiaryRelationshipInTransaction({ db, txn, wallet: wallet() }));
  return { fake, walletId, key, wallet, patch, read, readInTxn, db };
}

function withoutChainAddresses(w: Record<string, unknown>): Record<string, unknown> {
  const { chain_addresses: _drop, ...rest } = w;
  return rest;
}

describe('a rotated agent\'s beneficiary lineage is proven from sealed PEs', () => {
  test('GREEN: rotated twice with NO chain_addresses — both readers and resolveBeneficiary validate', async () => {
    const a = await agent(2);
    a.fake.store.set(a.key, withoutChainAddresses(a.wallet()));
    expect(a.wallet().rotation_count).toBe(2);
    await expect(a.read()).resolves.toMatchObject({ wallet_id: a.walletId });
    await expect(a.readInTxn()).resolves.toMatchObject({ wallet_id: a.walletId });
    await expect(resolveBeneficiary(AGENT_ID, cache, a.db)).resolves.toMatchObject({ linked: false });
  });

  test('GREEN: chain_addresses.evm overwritten with the CURRENT address (the incident) no longer matters', async () => {
    const a = await agent(1);
    a.patch({ chain_addresses: { evm: SIGNER_ONE.address, solana: '4Jxy9nbNxjsNnwrEyGePnXkVrGJWmPQKeLccL3zuR2K2' } });
    await expect(a.read()).resolves.toBeDefined();
    await expect(a.readInTxn()).resolves.toBeDefined();
  });

  test('GREEN: an unrotated wallet validates exactly as before (no index or PE reads needed)', async () => {
    const a = await agent(0);
    a.fake.store.delete(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(AGENT_ID)}`);
    await expect(a.read()).resolves.toBeDefined();
    await expect(a.readInTxn()).resolves.toBeDefined();
  });

  test('RED: a rotation whose sealed PE is gone is refused by both readers', async () => {
    const a = await agent(1);
    const rotationAct = [...a.fake.store.entries()].find(([k, v]) => k.startsWith(`${IDENTITY_ACTS_COLLECTION}/`)
      && ((v as Record<string, unknown>).act as Record<string, unknown>).action_type === 'agent_key_rotated');
    expect(rotationAct).toBeDefined();
    a.fake.store.delete(rotationAct![0]);
    await expect(a.read()).rejects.toThrow('beneficiary_relationship_integrity:rotation_pe_not_in_chain');
    await expect(a.readInTxn()).rejects.toThrow('beneficiary_relationship_integrity:rotation_pe_not_in_chain');
  });

  test('RED: a rotation-history entry that no longer matches its sealed PE is refused', async () => {
    const a = await agent(1);
    const entryKey = [...a.fake.store.keys()].find((k) => k.startsWith(`${a.key}/rotation_history/`));
    expect(entryKey).toBeDefined();
    a.fake.store.set(entryKey!, { ...(a.fake.store.get(entryKey!) as Record<string, unknown>), rotated_at: (a.wallet().last_rotated_at as number) - 1 });
    await expect(a.read()).rejects.toThrow('beneficiary_relationship_integrity:');
  });

  test('RED: a rotated wallet whose registration index is missing or names another wallet is refused', async () => {
    const a = await agent(1);
    const indexKey = `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(AGENT_ID)}`;
    a.fake.store.set(indexKey, { ...(a.fake.store.get(indexKey) as Record<string, unknown>), wallet_id: 'wallet_aw_other' });
    await expect(a.read()).rejects.toThrow('beneficiary_relationship_integrity:rotation_history_registration_index');
    a.fake.store.delete(indexKey);
    await expect(a.readInTxn()).rejects.toThrow('beneficiary_relationship_integrity:rotation_history_registration_index');
  });

  test('RED: a rotated wallet whose CURRENT address is not the lineage terminal is refused', async () => {
    const a = await agent(1);
    a.patch({ address: SIGNER_TWO.address });
    await expect(a.read()).rejects.toThrow('beneficiary_relationship_integrity:');
  });
});
