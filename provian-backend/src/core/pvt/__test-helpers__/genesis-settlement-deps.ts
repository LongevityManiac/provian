/**
 * ONE genesis settlement-deps double, shared by every suite that drives a
 * Genesis qualification through `processGenesisQualification` to `complete`.
 *
 * Why shared, not copied: the emit path is a stand-in for production `generatePE`
 * (which needs chain-tip infrastructure the fake store does not carry). Two
 * independently hand-rolled stand-ins would be the exact self-referential-control
 * shape the run contract warns about — a control that agrees with its own copy of
 * the shape rather than the one the code reads. This module is the single copy:
 * the unit suite (`genesis-award-state-machine.test.ts`) and the route end-to-end
 * control (`agent-wallet-genesis-signup.test.ts`) both settle through it, so a
 * qualification the REAL `/create` route emits is finalized by the same emitter
 * the unit tests trust.
 */

import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';

import type { AgentBankDeps } from '../../agent-bank/types';
import { hashRecordEconomicSnapshot } from '../policy/monetary-accounting';
import type { GenesisStateMachineDeps } from '../genesis-award-state-machine';
import type { FakeFirestore } from './fake-firestore';

export interface GenesisSettlementHarness {
  readonly deps: GenesisStateMachineDeps;
  readonly emitted: () => number;
  readonly accrualCalls: () => number;
}

export interface GenesisSettlementDepsOptions {
  /** Fail the first accrual to prove crash-safe resume; then succeed. */
  readonly failAccrualOnce?: boolean;
  /** Use production SSHSIG verification instead of the always-true test seam. */
  readonly useRealActivationVerifier?: boolean;
}

/**
 * Build a genesis settlement-deps harness over `fake`. The emitter reproduces
 * `generatePE`'s canonical PE content byte-for-byte (json-stable-stringify over
 * the same field set), writes the provisional envelope, and drives accrual — the
 * happy path production takes, minus the chain-tip infra the fake store lacks.
 */
export function makeGenesisSettlementDeps(
  fake: FakeFirestore,
  options: GenesisSettlementDepsOptions = {},
): GenesisSettlementHarness {
  let emitted = 0;
  let accrualCalls = 0;
  let failAccrual = options.failAccrualOnce === true;
  const recordPEAccrual: AgentBankDeps['recordPEAccrual'] = async (params) => {
    accrualCalls += 1;
    if (failAccrual) {
      failAccrual = false;
      throw new Error('injected accrual failure');
    }
    const row = {
      peId: params.peId,
      peHash: params.peHash,
      userId: params.userId,
      actionType: params.actionType,
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      record_points_atomic: params.economicSnapshot?.recordPointsAtomic ?? '0',
      economic_snapshot_hash: params.economicSnapshot
        ? hashRecordEconomicSnapshot(params.economicSnapshot)
        : null,
    };
    if (params.meter) {
      // PE METER: stand in for the meter seal — write the act key it would (a Genesis grant takes
      // no legs and no TTL until it mints). The sink is not called, so the relay intake stays
      // staged, exactly as after a crash between the seal and the batch commit.
      const keyRef = fake.collection(METER_ACT_KEYS_COLLECTION).doc(params.peId);
      if ((await keyRef.get()).exists) return;
      await keyRef.set({
        schema: 'provian.meter-act-key.v1',
        relay_pe_id: params.peId,
        client_pe_id: params.meter.clientPeId,
        pe_hash: params.meter.peHash,
        prev_hash: params.meter.prevHash,
        device_id: params.meter.deviceId,
        batch_hash: params.meter.batchHash,
        actor_id: params.userId,
        timestamp: params.timestamp,
        action_type: params.actionType,
        row: { ...row, is_genesis_grant: params.isGenesisGrant === true },
        legs: null,
        unit: 'none',
        held_reason: null,
        side: {},
        created_at_ms: params.timestamp,
        expire_at: null,
      });
      return;
    }
    const ref = fake.collection('pe_history').doc(params.peId);
    const existing = await ref.get();
    if (existing.exists) return;
    await ref.set({
      peId: params.peId,
      peHash: params.peHash,
      userId: params.userId,
      actionType: params.actionType,
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      record_points_atomic: params.economicSnapshot?.recordPointsAtomic ?? '0',
      economic_snapshot_hash: params.economicSnapshot
        ? hashRecordEconomicSnapshot(params.economicSnapshot)
        : null,
    });
  };

  const deps = {
    db: fake as unknown as Firestore,
    cache: {} as GenesisStateMachineDeps['cache'],
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual,
    ...(options.useRealActivationVerifier
      ? {}
      : { verifyGenesisActivationApproval: () => true }),
    emitGenesisPE: async (agentDeps, params) => {
      emitted += 1;
      const prevHash = crypto.createHash('sha256')
        .update(`prev:${params.peIdOverride}`).digest('hex');
      const canonicalContent = {
        id: params.peIdOverride!,
        wallet_id: params.walletId,
        agent_id: params.agentId,
        action_type: params.actionType,
        actor_address: params.actorAddress,
        timestamp: params.timestampOverride!,
        prev_hash: prevHash,
        attestation_type: 'software',
        metadata: params.metadata,
        compute: params.compute ?? null,
        geo: params.geo ?? null,
        execution_env: params.execution_env ?? null,
        cited_pe_ids: params.cited_pe_ids ?? null,
        parent_goal_pe_id: params.parent_goal_pe_id ?? null,
      };
      const peHash = crypto.createHash('sha256')
        .update(stableStringify(canonicalContent) || '')
        .digest('hex');
      await fake.runTransaction(async (txn) => {
        await params.atomicEntityPrecondition?.(
          txn as unknown as FirebaseFirestore.Transaction,
          { prevHash },
        );
        txn.set(fake.collection('provenance_envelopes').doc(params.peIdOverride!), {
          ...canonicalContent,
          hash: peHash,
          user_id: params.agentId,
          policy_action_type: params.accrualActionType ?? params.actionType,
          integration_source: 'agent_bank_generate_pe',
          counterparty_address: params.counterpartyAddress || null,
          counterparty_type: params.counterpartyAddress ? 'agent' : null,
          session_lineage: null,
          self_referencing: false,
          trust_level_at_creation: null,
          created_at: params.timestampOverride!,
          durability: 'provisional',
        });
        params.atomicEntityWrite?.(
          txn as unknown as FirebaseFirestore.Transaction,
          params.peIdOverride!,
          { prevHash, newHash: peHash, timestamp: params.timestampOverride! },
        );
      });
      await agentDeps.recordPEAccrual({
        peId: params.peIdOverride!,
        userId: params.agentId,
        actionType: params.actionType,
        integrationSource: 'test-genesis-emitter',
        attestationDepth: 'software',
        peHash,
        timestamp: params.timestampOverride!,
        economicSnapshot: params.economicSnapshot,
        isGenesisGrant: true,
        throwOnError: true,
      });
      return { peId: params.peIdOverride!, peHash, prevHash };
    },
  } as GenesisStateMachineDeps;

  return {
    deps,
    emitted: () => emitted,
    accrualCalls: () => accrualCalls,
  };
}
