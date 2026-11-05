/**
 * cutover reconciliation — durable ordinary-PE accrual intake tests.
 *
 * Locks down:
 * 1. The intake row is co-committed with the chain-tip transaction on every
 * best-effort generatePE call (PE ⟺ intake), and the stored replay params
 * are IDENTICAL to the params the live accrual call fires.
 * 2. Durable callers (awaitAccrual: true) write NO intake row — their replay
 * source is their own source outbox + durable-accrual-effects; two replay
 * authorities for one PE would be a correctness hazard.
 * 3. The intake grants NO authority: status is the single terminal literal
 * 'recorded', the builder rejects durable-transport params, and the
 * validator fail-closes on any shape drift (Unknown = Block).
 * 4. Replay-integrity binding: mutated rows fail verification.
 */
import { describe, it, expect } from '@jest/globals';
import { generatePE, type GeneratePEParams } from '../../agent-bank/pe-utils';
import type { AgentBankDeps } from '../../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION,
  buildOrdinaryAccrualIntake,
  hashOrdinaryAccrualReplayParams,
  isOrdinaryAccrualIntakeDocument,
  sanitizeOrdinaryAccrualReplayParams,
  verifyOrdinaryAccrualIntakeBinding,
  type OrdinaryAccrualIntakeDocument,
} from './ordinary-accrual-intake';
import type { RecordPEAccrualParams } from '../../../pvt-accrual';

const INTAKE = (peId: string) => `${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${peId}`;
const PE = (peId: string) => `provenance_envelopes/${peId}`;

const baseAccrualParams: RecordPEAccrualParams = {
  peId: 'pe_test_1',
  userId: 'agent_x',
  actionType: 'escrow_created',
  integrationSource: 'agent_bank_generate_pe',
  attestationDepth: 'software',
  peHash: 'hash_abc',
  timestamp: 1234,
};

function makeDeps(db: FakeFirestore) {
  const accrualCalls: Array<Record<string, unknown>> = [];
  const deps = {
    db,
    cache: {},
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async (p: Record<string, unknown>) => { accrualCalls.push(p); },
  } as unknown as AgentBankDeps;
  return { deps, accrualCalls };
}

const baseParams: GeneratePEParams = {
  walletId: 'wallet_1',
  agentId: 'agent_x',
  actorAddress: '0xAGENT',
  actionType: 'escrow_created',
  metadata: { foo: 1 },
};

describe('cutover reconciliation ordinary-accrual intake — builder + validator', () => {
  it('builds a valid, binding-verified intake row', () => {
    const doc = buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'hash_abc',
      accrualParams: { ...baseAccrualParams },
    });
    expect(doc.schema_version).toBe(ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION);
    expect(doc.status).toBe('recorded');
    expect(doc.pe_id).toBe('pe_test_1');
    expect(doc.pe_hash).toBe('hash_abc');
    expect(doc.prev_hash).toBe('0x0000');
    expect(doc.recorded_at_ms).toBe(1234);
    expect(isOrdinaryAccrualIntakeDocument(doc)).toBe(true);
    expect(verifyOrdinaryAccrualIntakeBinding(doc)).toBe(true);
  });

  it('rejects a durable caller (throwOnError: true) — two replay authorities are forbidden', () => {
    expect(() => buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'hash_abc',
      accrualParams: { ...baseAccrualParams, throwOnError: true },
    })).toThrow('ordinary_accrual_intake_durable_caller_rejected');
  });

  it('rejects a peHash binding mismatch', () => {
    expect(() => buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'DIFFERENT',
      accrualParams: { ...baseAccrualParams },
    })).toThrow('ordinary_accrual_intake_pe_hash_binding_mismatch');
  });

  it('sanitization strips transport fields and undefined members deterministically', () => {
    const withNoise: RecordPEAccrualParams = {
      ...baseAccrualParams,
      throwOnError: false,
      inputSummary: undefined,
      citedPeIds: null,
    };
    const clean = sanitizeOrdinaryAccrualReplayParams(withNoise);
    expect('throwOnError' in clean).toBe(false);
    expect('durableTestCrashAt' in clean).toBe(false);
    expect('inputSummary' in clean).toBe(false);
    // null members are preserved (they are meaningful values).
    expect((clean as Record<string, unknown>).citedPeIds).toBeNull();
    // Deterministic: same input → same hash, key order irrelevant.
    const reordered = sanitizeOrdinaryAccrualReplayParams({
      timestamp: 1234,
      peHash: 'hash_abc',
      attestationDepth: 'software',
      integrationSource: 'agent_bank_generate_pe',
      actionType: 'escrow_created',
      userId: 'agent_x',
      peId: 'pe_test_1',
      citedPeIds: null,
    });
    expect(hashOrdinaryAccrualReplayParams(clean)).toBe(hashOrdinaryAccrualReplayParams(reordered));
  });

  it('validator fail-closes on shape drift (Unknown = Block)', () => {
    const good = buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'hash_abc',
      accrualParams: { ...baseAccrualParams },
    });
    // extra key
    expect(isOrdinaryAccrualIntakeDocument({ ...good, extra: 1 })).toBe(false);
    // missing key
    const { prev_hash: _p, ...missing } = good;
    expect(isOrdinaryAccrualIntakeDocument(missing)).toBe(false);
    // wrong schema / status
    expect(isOrdinaryAccrualIntakeDocument({ ...good, schema_version: 'v2' })).toBe(false);
    expect(isOrdinaryAccrualIntakeDocument({ ...good, status: 'settled' })).toBe(false);
    // params/pe binding mismatches
    expect(isOrdinaryAccrualIntakeDocument({
      ...good,
      accrual_params: { ...good.accrual_params, peId: 'pe_other' },
    })).toBe(false);
    expect(isOrdinaryAccrualIntakeDocument({
      ...good,
      accrual_params: { ...good.accrual_params, peHash: 'other_hash' },
    })).toBe(false);
    // a durable-transport marker smuggled into the stored payload is corruption
    expect(isOrdinaryAccrualIntakeDocument({
      ...good,
      accrual_params: { ...good.accrual_params, throwOnError: true },
    })).toBe(false);
    expect(isOrdinaryAccrualIntakeDocument(null)).toBe(false);
    expect(isOrdinaryAccrualIntakeDocument('row')).toBe(false);
  });

  it('binding verification detects post-commit mutation', () => {
    const good = buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'hash_abc',
      accrualParams: { ...baseAccrualParams },
    });
    const mutated: OrdinaryAccrualIntakeDocument = {
      ...good,
      accrual_params: { ...good.accrual_params, actionType: 'escrow_created' as string, userId: 'attacker' },
    };
    expect(verifyOrdinaryAccrualIntakeBinding(good)).toBe(true);
    expect(verifyOrdinaryAccrualIntakeBinding(mutated)).toBe(false);
  });

  it('binding verification with expected tip enforces pe_hash/prev_hash (the canary self-check)', () => {
    const good = buildOrdinaryAccrualIntake({
      prevHash: '0x0000',
      peHash: 'hash_abc',
      accrualParams: { ...baseAccrualParams },
    });
    // Matching tip passes.
    expect(verifyOrdinaryAccrualIntakeBinding(good, { peHash: 'hash_abc', prevHash: '0x0000' })).toBe(true);
    // A different committed pe_hash or prev_hash is rejected — the row can never
    // be resurrected against a tip it was not committed under.
    expect(verifyOrdinaryAccrualIntakeBinding(good, { peHash: 'hash_other', prevHash: '0x0000' })).toBe(false);
    expect(verifyOrdinaryAccrualIntakeBinding(good, { peHash: 'hash_abc', prevHash: '0xDEAD' })).toBe(false);
  });
});

describe('cutover reconciliation ordinary-accrual intake — generatePE co-commit (PE ⟺ intake)', () => {
  // PE METER : `generatePE` no longer writes an envelope or this cutover reconciliation intake row. Its
  // replay source is the relay-act intake (`meter_relay_acts_v1`), co-committed with the chain tip
  // for EVERY call — best-effort and durable alike — and deleted once the act is priced.
  const RELAY_INTAKE = (peId: string) => `meter_relay_acts_v1/${peId}`;
  const replayView = (fired: Record<string, unknown>) => {
    // Transport fields the pricing call adds, not stored accrual inputs. `accrualReceivedAtMs` is the
    // intake's own committed time (shutdown coverage), asserted against the row below.
    const { throwOnError: _t, meter: _m, accrualReceivedAtMs: _r, ...rest } = fired;
    return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  };

  it('a best-effort generatePE call co-commits the relay intake with the tip, and the stored replay params equal the fired accrual params', async () => {
    const db = createFakeFirestore();
    const { deps, accrualCalls } = makeDeps(db);

    const res = await generatePE(deps, { ...baseParams });

    const intake = db.store.get(RELAY_INTAKE(res.peId)) as Record<string, unknown> | undefined;
    expect(intake).toBeDefined();
    expect(db.store.get(PE(res.peId))).toBeUndefined();
    expect(db.store.get(INTAKE(res.peId))).toBeUndefined();
    const act = intake!.act as Record<string, unknown>;
    expect(act.pe_hash).toBe(res.peHash);
    expect(act.prev_hash).toBe(res.prevHash);
    expect(db.store.get('pe_chain_tips/agent_x')!.hash).toBe(res.peHash);
    expect(intake!.durable).toBe(false);

    // The live accrual call fired with the SAME params the intake stored (minus the transport
    // fields) — replay source and live input cannot drift.
    expect(accrualCalls).toHaveLength(1);
    expect(accrualCalls[0].throwOnError).toBeUndefined();
    expect(accrualCalls[0].meter).toBeDefined();
    expect(intake!.accrual).toEqual(replayView(accrualCalls[0]));
    expect(accrualCalls[0].accrualReceivedAtMs).toBe(intake!.created_at_ms);
  });

  it('a durable generatePE call (awaitAccrual: true) stages the same relay intake, marked durable', async () => {
    const db = createFakeFirestore();
    const { deps, accrualCalls } = makeDeps(db);

    const res = await generatePE(deps, { ...baseParams, awaitAccrual: true });

    const intake = db.store.get(RELAY_INTAKE(res.peId)) as Record<string, unknown> | undefined;
    expect(intake).toBeDefined();
    expect(intake!.durable).toBe(true);
    expect(db.store.get(INTAKE(res.peId))).toBeUndefined();
    expect(accrualCalls).toHaveLength(1);
    expect(accrualCalls[0].throwOnError).toBe(true);
    expect(intake!.accrual).toEqual(replayView(accrualCalls[0]));
  });

  it('an entity co-write failure rolls back PE + tip + intake together (fail-closed)', async () => {
    const db = createFakeFirestore();
    const { deps, accrualCalls } = makeDeps(db);

    await expect(generatePE(deps, {
      ...baseParams,
      atomicEntityWrite: () => { throw new Error('entity_write_failed'); },
    })).rejects.toThrow('entity_write_failed');

    // Nothing landed: no PE, no intake, no tip advance, no accrual fired.
    expect([...db.store.keys()].filter((k) => k.startsWith('provenance_envelopes/'))).toHaveLength(0);
    expect([...db.store.keys()].filter((k) => k.startsWith('meter_relay_acts_v1/'))).toHaveLength(0);
    expect([...db.store.keys()].filter((k) => k.startsWith(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/`))).toHaveLength(0);
    expect(db.store.get('pe_chain_tips/agent_x')).toBeUndefined();
    expect(accrualCalls).toHaveLength(0);
  });
});
