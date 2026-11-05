/**
 * Backend CorroborationManager - regression coverage for the Pass-2
 * Capability-Truthfulness Audit findings #5 and #31.
 *
 * #5 (HIGH): the three first-party economic emitters (escrow/promise/job)
 *   hardcoded targetPeHash:'' so the manager falsy-guarded and the corroborated
 *   tier was unreachable. The manager ALSO read `.hash` from pe_history, whose
 *   canonical hash field is actually `peHash` - so even a supplied hash would
 *   mismatch. These tests pin both halves: resolveTargetPeHash reads the real
 *   hash, and emitBackendCorroboration validates against pe_history.peHash.
 *
 * #31 (LOW): client-submitted corroboration_signal PEs never upgraded their
 *   target. applyClientCorroboration is the new consumer: validate target
 *   exists, verified gate (hash match), not-self (authenticated submitter), then
 *   upgrade the target's corroboration_status.
 */

import {
  resolveTargetPeHash,
  emitBackendCorroboration,
  applyClientCorroboration,
} from './CorroborationManager';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { makeCorroborationTargetDocs } from '../../__test-helpers__/pe-doc-fixtures';

const mockGeneratePE = jest.fn();
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function depsFor(fs: FakeFirestore): AgentBankDeps {
  return { db: fs } as unknown as AgentBankDeps;
}

beforeEach(() => {
  mockGeneratePE.mockReset();
  mockGeneratePE.mockResolvedValue({ peId: 'pe_corr', peHash: 'corrhash', prevHash: 'prev' });
});

describe('resolveTargetPeHash (Pass-2 #5)', () => {
  it('returns the canonical peHash field from pe_history', async () => {
    const fs = createFakeFirestore();
    fs.store.set('pe_history/pe_target', { peHash: 'realhash', userId: 'userA' });
    expect(await resolveTargetPeHash(depsFor(fs), 'pe_target')).toBe('realhash');
  });

  it('falls back to `hash` for envelope-shaped docs', async () => {
    const fs = createFakeFirestore();
    fs.store.set('pe_history/pe_target', { hash: 'envhash' });
    expect(await resolveTargetPeHash(depsFor(fs), 'pe_target')).toBe('envhash');
  });

  it('returns "" when the target is genuinely missing (caller skips, never suppresses)', async () => {
    const fs = createFakeFirestore();
    expect(await resolveTargetPeHash(depsFor(fs), 'pe_missing')).toBe('');
    expect(await resolveTargetPeHash(depsFor(fs), '')).toBe('');
  });
});

describe('emitBackendCorroboration - validates against pe_history.peHash (Pass-2 #5)', () => {
  it('emits the corroboration PE and upgrades the target when the real peHash matches', async () => {
    const fs = createFakeFirestore();
    // Production-shaped pe_history doc: canonical hash lives under `peHash`,
    // there is NO `hash` field. Pre-fix the manager read `.hash` (undefined)
    // and rejected, so this would never have fired.
    fs.store.set('pe_history/pe_target', {
      peHash: 'realhash',
      userId: 'agent_depositor',
      corroboration_status: 'none',
    });

    await emitBackendCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'realhash',
      signalType: 'escrow_completed',
      corroboratingParty: 'wallet_depositor',
      evidence: JSON.stringify({ escrow_id: 'e1' }),
      evidenceRef: 'e1',
      walletId: 'wallet_depositor',
      agentId: 'agent_depositor',
      actorAddress: '0xdep',
    });
    await flushMicrotasks();

    // A corroboration_signal PE was created (the chain advances).
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(mockGeneratePE).toHaveBeenCalledWith(
      depsFor(fs),
      expect.objectContaining({ actionType: 'corroboration_signal' }),
    );
    // The target's corroboration_status was upgraded (escrow_completed → peer_verified).
    expect(fs.store.get('pe_history/pe_target')).toMatchObject({
      corroboration_status: 'peer_verified',
    });
  });

  it('rejects (does not emit) when the supplied hash mismatches the stored peHash', async () => {
    const fs = createFakeFirestore();
    fs.store.set('pe_history/pe_target', { peHash: 'realhash' });

    await emitBackendCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'WRONGHASH',
      signalType: 'escrow_completed',
      corroboratingParty: 'wallet_depositor',
      evidence: 'x',
      walletId: 'w',
      agentId: 'a',
      actorAddress: '0x',
    });
    await flushMicrotasks();

    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('rejects an invalid signal (missing targetPeHash) - never suppresses a valid one', async () => {
    const fs = createFakeFirestore();
    fs.store.set('pe_history/pe_target', { peHash: 'realhash' });

    await emitBackendCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: '',
      signalType: 'escrow_completed',
      corroboratingParty: 'wallet_depositor',
      evidence: 'x',
      walletId: 'w',
      agentId: 'a',
      actorAddress: '0x',
    });

    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('rejects self-corroboration when the corroborating party IS the target author (sweep #7)', async () => {
    // Production-shaped target: pe_history keys the author under userId (NOT
    // wallet_id/agent_id). The guard previously read wallet_id/agent_id (always
    // undefined) and never fired. It must reject a party corroborating its own PE.
    const fs = createFakeFirestore();
    const { envelope, history } = makeCorroborationTargetDocs({
      peId: 'pe_target', userId: 'agent_self', hash: 'realhash',
    });
    fs.store.set('pe_history/pe_target', history);
    fs.store.set('provenance_envelopes/pe_target', envelope);

    await emitBackendCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'realhash',
      signalType: 'escrow_completed',
      corroboratingParty: 'agent_self', // == the target's userId/author
      evidence: 'x',
      walletId: 'agent_self',
      agentId: 'agent_self',
      actorAddress: '0x',
    });

    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('applyClientCorroboration - client-submitted corroboration consumer (Pass-2 #31)', () => {
  function seedTarget(fs: FakeFirestore, authorUserId: string, hash = 'targethash'): void {
    // Production-shaped pair from the shared builder: envelope (authoritative
    // author + canonical hash) + derived pe_history mirror (peHash, no hash/metadata).
    const { envelope, history } = makeCorroborationTargetDocs({
      peId: 'pe_target', userId: authorUserId, hash,
    });
    fs.store.set('provenance_envelopes/pe_target', envelope);
    fs.store.set('pe_history/pe_target', history);
  }

  it('records a MINT-NEUTRAL marker for a genuine cross-party corroboration (no 1.1x grant)', async () => {
    const fs = createFakeFirestore();
    seedTarget(fs, 'userB');

    const result = await applyClientCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'targethash',
      signalType: 'counterparty_attestation',
      // Forgeable client field — must NOT become the attestor.
      corroboratingParty: 'system',
      submitterIdentities: ['userA', '0xUserA'],
      corroboratingPeId: 'pe_corroborator',
      evidenceRef: 'promise_1',
    });

    expect(result).toEqual({ applied: true });
    const target = fs.store.get('pe_history/pe_target')!;
    // MINT-NEUTRAL (product decision): corroboration_status (the field
    // PVT9 claim inlet reads for the corroborated tier) is UNTOUCHED — stays 'none'.
    expect(target.corroboration_status).toBe('none');
    // Visibility/reputation markers ARE recorded, stamped with the non-forgeable
    // authenticated attestor (not the client 'system' party field).
    expect(target).toMatchObject({
      client_corroboration_last_by: 'userA',
      client_corroboration_signal_type: 'counterparty_attestation',
      client_corroborating_pe_id: 'pe_corroborator',
      client_corroboration_evidence_ref: 'promise_1',
    });
    expect(target.client_corroboration_last_at).toEqual(expect.any(Number));
    // The mint-driving attestor field was NOT stamped by the client path
    // (the builder seeds it null; the client path leaves it untouched).
    expect(target.corroboration_source).toBeNull();
  });

  it('rejects self-corroboration against the AUTHENTICATED submitter (not the forgeable party field)', async () => {
    const fs = createFakeFirestore();
    seedTarget(fs, 'userB');

    const result = await applyClientCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'targethash',
      // Attacker claims a third-party 'system' party, but is authenticated as userB.
      signalType: 'counterparty_attestation',
      corroboratingParty: 'system',
      submitterIdentities: ['userB'],
    });

    expect(result).toEqual({ applied: false, reason: 'self_corroboration' });
    expect(fs.store.get('pe_history/pe_target')).toMatchObject({ corroboration_status: 'none' });
  });

  it('rejects a hash mismatch (verified gate)', async () => {
    const fs = createFakeFirestore();
    seedTarget(fs, 'userB');

    const result = await applyClientCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: 'GUESSED_WRONG',
      signalType: 'counterparty_attestation',
      corroboratingParty: 'userA',
      submitterIdentities: ['userA'],
    });

    expect(result).toEqual({ applied: false, reason: 'hash_mismatch' });
    expect(fs.store.get('pe_history/pe_target')).toMatchObject({ corroboration_status: 'none' });
  });

  it('rejects a missing target', async () => {
    const fs = createFakeFirestore();
    const result = await applyClientCorroboration(depsFor(fs), {
      targetPeId: 'pe_does_not_exist',
      targetPeHash: 'whatever',
      signalType: 'counterparty_attestation',
      corroboratingParty: 'userA',
      submitterIdentities: ['userA'],
    });
    expect(result).toEqual({ applied: false, reason: 'target_not_found' });
  });

  it('rejects missing fields', async () => {
    const fs = createFakeFirestore();
    const result = await applyClientCorroboration(depsFor(fs), {
      targetPeId: 'pe_target',
      targetPeHash: '',
      signalType: 'counterparty_attestation',
      corroboratingParty: 'userA',
      submitterIdentities: ['userA'],
    });
    expect(result).toEqual({ applied: false, reason: 'missing_fields' });
  });
});
