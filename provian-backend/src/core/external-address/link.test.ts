/**
 * Proven-address link record tests: bind, idempotent re-prove (fence
 * preserved), and rejection of a re-bind to a different agent.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  writeProvenAddress,
  getProvenAddress,
  listProvenAddresses,
  hasProvenExternalAddress,
  setProvenAddressBaselineNonce,
  createProvenAddressProofEvidence,
  PROVEN_ADDRESS_CHAIN,
  PROVEN_ADDRESS_CHAIN_ID,
  PROVEN_ADDRESS_SCHEMA,
  type ProvenAddressRecord,
  PROVEN_ADDRESSES_COLLECTION,
} from './link';

function rec(overrides: Partial<ProvenAddressRecord> = {}): ProvenAddressRecord {
  const provenAtMs = overrides.proven_at_ms ?? 10_000;
  const provenAtBlock = overrides.proven_at_block ?? 5_000;
  const observedHead = overrides.proof_observed_head_block ?? provenAtBlock - 1;
  const proofMethod = overrides.proof_method ?? 'eip191_eoa';
  const proofEvidence = overrides.proof_evidence ?? createProvenAddressProofEvidence({
    challengeId: 'challenge-fixture',
    challengeMessage: 'fixture proof message',
    signature: '0xdeadbeef',
    proofMethod,
    verifiedAtMs: provenAtMs,
  });
  return {
    schema_version: PROVEN_ADDRESS_SCHEMA,
    economic_eligibility: 'active_go_forward_only',
    address: '0xABC0000000000000000000000000000000000001',
    agent_id: 'agent_a',
    wallet_id: 'agent_a',
    proven_at_ms: provenAtMs,
    proven_at_block: provenAtBlock,
    proof_observed_head_block: observedHead,
    proof_block_number: overrides.proof_block_number ?? observedHead - 11,
    proof_block_hash: `0x${'ab'.repeat(32)}`,
    proof_min_confirmations: 12,
    proof_rpc_operator_ids: ['operator-a', 'operator-b'],
    chain: PROVEN_ADDRESS_CHAIN,
    chain_id: PROVEN_ADDRESS_CHAIN_ID,
    proof_method: proofMethod,
    signature_hash: proofEvidence.signature_sha256,
    proof_evidence: proofEvidence,
    initial_reputation_tier: 1,
    baseline_nonce: 7,
    created_at: provenAtMs,
    ...overrides,
  };
}

describe('writeProvenAddress', () => {
  it('binds a new address (lowercased doc id) and reads it back', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const res = await writeProvenAddress(db, rec());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.already_proven).toBe(false);
      expect(res.record.address).toBe('0xabc0000000000000000000000000000000000001');
    }
    const raw = fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/0xabc0000000000000000000000000000000000001`);
    expect(raw).toBeTruthy();
    const got = await getProvenAddress(db, '0xABC0000000000000000000000000000000000001');
    expect(got?.agent_id).toBe('agent_a');
  });

  it('is idempotent for the same agent and preserves the ORIGINAL fence', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec({ proven_at_block: 5_000, proven_at_ms: 10_000 }));
    // Re-prove later with a higher block - must NOT move proven_at_block.
    const res = await writeProvenAddress(db, rec({ proven_at_block: 9_999, proven_at_ms: 99_999 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.already_proven).toBe(true);
      expect(res.record.proven_at_block).toBe(5_000);
      expect(res.record.proven_at_ms).toBe(10_000);
    }
  });

  it('rejects a re-bind to a DIFFERENT agent', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec({ agent_id: 'agent_a', wallet_id: 'agent_a' }));
    const res = await writeProvenAddress(db, rec({ agent_id: 'agent_b', wallet_id: 'agent_b' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('address_bound_to_other_agent');
    // Original binding stands.
    const got = await getProvenAddress(db, rec().address);
    expect(got?.agent_id).toBe('agent_a');
  });
});

describe('setProvenAddressBaselineNonce', () => {
  it('never changes the exact proof-block baseline on a modern record', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec({ baseline_nonce: 500 }));
    const first = await setProvenAddressBaselineNonce(db, rec().address, 500);
    expect(first).toBe(500);
    expect((await getProvenAddress(db, rec().address))?.baseline_nonce).toBe(500);
    const second = await setProvenAddressBaselineNonce(db, rec().address, 999);
    expect(second).toBe(500);
    expect((await getProvenAddress(db, rec().address))?.baseline_nonce).toBe(500);
  });

  it('cannot silently initialize a missing or legacy baseline', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const address = rec().address.toLowerCase();
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${address}`, {
      address,
      agent_id: 'agent_a',
      wallet_id: 'agent_a',
      proven_at_block: 5_000,
    });
    await expect(setProvenAddressBaselineNonce(db, address, 42))
      .rejects.toThrow('proven_address_reproof_required');
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${address}`)?.baseline_nonce)
      .toBeUndefined();
    await expect(setProvenAddressBaselineNonce(db, '0xnotbound', 42))
      .rejects.toThrow('proven_address_reproof_required');
  });
});

describe('listProvenAddresses', () => {
  it('fails the whole enumeration when any stored row is malformed', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec());
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/malformed`, {
      address: 'malformed',
      // agent_id deliberately absent: this row must never disappear silently.
    });
    await expect(listProvenAddresses(db))
      .rejects.toThrow('proven_address_enumeration_invalid:malformed');
  });

  it('keeps a legacy identity record-only until its original agent re-proves', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const address = rec().address.toLowerCase();
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${address}`, {
      address,
      agent_id: 'agent_a',
      wallet_id: 'agent_a',
      proven_at_ms: 1,
      proven_at_block: 5_000,
      initial_reputation_tier: 2,
    });

    await expect(listProvenAddresses(db)).resolves.toEqual([]);
    await expect(setProvenAddressBaselineNonce(db, address, 900))
      .rejects.toThrow('proven_address_reproof_required');
    const takeover = await writeProvenAddress(db, rec({
      agent_id: 'agent_b',
      wallet_id: 'agent_b',
    }));
    expect(takeover).toEqual({ ok: false, reason: 'address_bound_to_other_agent' });

    const upgraded = await writeProvenAddress(db, rec({
      proven_at_ms: 20_000,
      proven_at_block: 8_001,
      baseline_nonce: 900,
    }));
    expect(upgraded).toMatchObject({
      ok: true,
      already_proven: false,
      upgraded_legacy: true,
      record: {
        proof_observed_head_block: 8_000,
        proof_block_number: 7_989,
        proven_at_block: 8_001,
        baseline_nonce: 900,
      },
    });
    await expect(listProvenAddresses(db)).resolves.toHaveLength(1);
  });
});

describe('hasProvenExternalAddress (display-only "external wallet linked" indicator)', () => {
  it('true once the agent has an economically-active proven address', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec({ agent_id: 'agent_a', wallet_id: 'agent_a' }));
    await expect(hasProvenExternalAddress(db, 'agent_a')).resolves.toBe(true);
  });

  it('RED CONTROL: false for an agent that has no proven address at all', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await writeProvenAddress(db, rec({ agent_id: 'agent_a', wallet_id: 'agent_a' }));
    // A different agent must not inherit agent_a's linked wallet.
    await expect(hasProvenExternalAddress(db, 'agent_other')).resolves.toBe(false);
  });

  it('RED CONTROL: a legacy/uneconomic row reads as NOT linked and never throws', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    // Well-formed identity but legacy schema (not proven-address/v2 economic).
    // listProvenAddresses would THROW on this; the display helper must not.
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/0xdef0000000000000000000000000000000000009`, {
      address: '0xdef0000000000000000000000000000000000009',
      agent_id: 'agent_legacy',
      wallet_id: 'agent_legacy',
      schema_version: 'proven-address/v1',
    });
    await expect(hasProvenExternalAddress(db, 'agent_legacy')).resolves.toBe(false);
  });

  it('empty agent id is false without touching the collection', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await expect(hasProvenExternalAddress(db, '')).resolves.toBe(false);
  });
});
