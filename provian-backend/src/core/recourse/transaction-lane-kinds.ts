import { Interface, concat, hashMessage, sha256 } from 'ethers';
import type { Firestore, Transaction as FirestoreTransaction } from 'firebase-admin/firestore';
import { BINDING_OPERATIONS, assertCheckedBindingOperation, bindingOperationCalldata, checkBindingOperation, confirmBindingRegistration,
  readConfirmedBinding, type CheckedBindingOperation, type IdentityAttestor } from './binding-operation';
import { ownershipBindingMessage, type OwnershipBinding } from './ownership';
import { OWNER_OPERATIONS, assertCheckedOwnerOperation, checkOwnerOperation } from './owner-operation-queue';
import { parseRecoveryOwnerOperation, recoveryOperationCall, recoveryOperationId } from './owner-operation';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { findExecutedOwnerOperation } from './owner-operation-executed';
import { RESTORATION_REQUESTS } from './restoration-request';
import { BREAK_DEPLOYMENTS, assertCheckedBreakDeployment, checkBreakDeployment, type CheckedBreakDeployment } from './break-deployment-queue';
import { parseAccountDeploymentRequest, accountDeploymentDigest, type AccountDeploymentRequest } from './break-deployment-data';
import { breakRegistrationAdapter } from './break-registration';
import { membershipConsentAdapter } from './membership-consent-operation';
import { membershipDebitAdapter } from './membership-debit-operation';
import type { SponsoredOperationAdapter, SponsoredOperationPlan } from './sponsored-operation-worker';
import { finalizedOwnerTransaction } from './transaction-finality';
import type { LaneKind, LanePrepared, LaneRow, LaneTerminal } from './transaction-lane';

/** A binding is sent only while its owner signature still has this long left on chain. */
export const BINDING_SEND_MARGIN_MS = 20_000;
const code = (error: unknown) => error instanceof Error ? error.message : '';

export interface BindingLanePorts {
  check: typeof checkBindingOperation;
  registration: typeof readConfirmedBinding;
  now?: () => number;
}
/** Ownership binding. An expired owner signature closes as `binding_expired`
 * without gas; the agent re-signs on its own and the app on its next action. */
export function bindingLaneKind(db: Firestore, attestor: IdentityAttestor,
  ports: BindingLanePorts = { check: checkBindingOperation, registration: readConfirmedBinding }): LaneKind {
  const now = ports.now ?? Date.now;
  const binding = (row: LaneRow): OwnershipBinding => {
    const value = row.data.binding as OwnershipBinding;
    if (hashMessage(ownershipBindingMessage(value)) !== row.id) throw Error('recourse_binding_record_invalid');
    return value;
  };
  const member = (row: LaneRow) => row.data.memberConsent as CheckedBindingOperation['memberConsent'];
  return { name: 'binding', collection: BINDING_OPERATIONS,
    async prepare(row, gasPayer): Promise<LanePrepared> {
      const value = binding(row);
      let prior: Awaited<ReturnType<typeof readConfirmedBinding>>;
      try { prior = await ports.registration(value); }
      catch (error) {
        if (code(error) === 'recourse_binding_operation_retired') return { kind: 'finish', status: 'failed', reason: code(error) };
        throw error;
      }
      if (prior) {
        await confirmBindingRegistration(db, prior, member(row));
        return { kind: 'finish', status: 'confirmed', reason: 'binding_executed_by_other_submitter' };
      }
      if (value.expiresAtMs <= now() + BINDING_SEND_MARGIN_MS) return { kind: 'finish', status: 'failed', reason: 'binding_expired' };
      let plan: CheckedBindingOperation;
      try { plan = await ports.check(db, value, String(row.data.ownerSignature), attestor, undefined, member(row)); }
      catch (error) {
        if (['recourse_binding_operation_retired', 'recourse_binding_operation_owner_mismatch'].includes(code(error))) {
          return { kind: 'finish', status: 'failed', reason: code(error) };
        }
        throw error;
      }
      assertCheckedBindingOperation(plan);
      const { id: _id, ...fields } = plan;
      return { kind: 'sign', plan: { executor: plan.executor, calldata: plan.calldata, fields: { ...fields, gasSigner: gasPayer } } };
    },
    expected(row) {
      const value = binding(row);
      return { executor: String(row.data.executor), calldata: bindingOperationCalldata(value, String(row.data.ownerSignature),
        String(row.data.identitySignature), String(row.data.revision), member(row)) };
    },
    async settle(row, receipt): Promise<LaneTerminal> {
      let registration: Awaited<ReturnType<typeof readConfirmedBinding>>;
      try { registration = await ports.registration(binding(row)); }
      catch (error) {
        if (code(error) === 'recourse_binding_operation_retired') return { status: 'failed', reason: code(error) };
        throw error;
      }
      if (registration) {
        await confirmBindingRegistration(db, registration, member(row));
        return { status: 'confirmed', reason: 'binding_finalized' };
      }
      if (receipt.status === 1) throw Error('recourse_binding_event_unconfirmed');
      return { status: 'failed', reason: 'transaction_reverted' };
    },
  };
}

export interface OwnerLanePorts {
  check: typeof checkOwnerOperation;
  verify: typeof verifyRecoveryAuthorization;
  executed: typeof findExecutedOwnerOperation;
}
/** Exact owner-proven rotation or restoration intent. No generic call enters. */
export function ownerOperationLaneKind(db: Firestore,
  ports: OwnerLanePorts = { check: checkOwnerOperation, verify: verifyRecoveryAuthorization, executed: findExecutedOwnerOperation }): LaneKind {
  const operation = (row: LaneRow) => {
    const value = parseRecoveryOwnerOperation(row.data.operation);
    if (recoveryOperationId(value) !== row.id) throw Error('recourse_owner_worker_record_mismatch');
    return value;
  };
  const external = async (row: LaneRow): Promise<LaneTerminal | null> => {
    const found = await ports.executed(operation(row), String(row.data.executor), String(row.data.queuedAtBlockHash));
    if (!found) return null;
    return { status: 'confirmed', reason: found.superseded ? 'authorization_superseded' : 'authorization_executed_by_other_sponsor',
      fields: { transactionHash: found.transactionHash, sponsoredTransactionHash: row.data.transactionHash ?? null } };
  };
  return { name: 'owner_operation', collection: OWNER_OPERATIONS,
    async prepare(row, gasPayer): Promise<LanePrepared> {
      const value = operation(row);
      let plan: Awaited<ReturnType<typeof checkOwnerOperation>>;
      try { plan = await ports.check(value, undefined, gasPayer); }
      catch (error) {
        // Nothing was signed. Only a retired deployment or consumed owner nonce retires it.
        if (['recourse_owner_operation_retired', 'recourse_owner_operation_stale'].includes(code(error))) {
          return { kind: 'finish', ...(await external(row) ?? { status: 'failed', reason: code(error) }) };
        }
        throw error;
      }
      assertCheckedOwnerOperation(plan);
      if (plan.gasPayer !== gasPayer || plan.executor !== row.data.executor) throw Error('recourse_owner_worker_wrong_gas_payer');
      return { kind: 'sign', plan: { executor: plan.executor, calldata: plan.calldata, fields: {} } };
    },
    expected(row) { return { executor: String(row.data.executor), calldata: recoveryOperationCall(operation(row)) }; },
    async settle(row, receipt): Promise<LaneTerminal> {
      const value = operation(row);
      if (receipt.status === 0) return await external(row) ?? { status: 'failed', reason: 'transaction_reverted' };
      try {
        await ports.verify({ kernel: value.kernel, identity: value.identity, destination: value.destination,
          consumedCommitment: sha256(concat([value.proof.recoverySecret, value.proof.signingRoot])),
          nextCommitment: value.proof.nextCommitment, nextSigningRoot: value.proof.nextSigningRoot,
          nonce: value.nonce, transactionHash: String(row.data.transactionHash) });
      } catch (error) {
        // Receipt success is final; current credentials still need their own verifier.
        if (code(error) === 'recourse_authorization_superseded') return { status: 'confirmed', reason: 'authorization_superseded' };
        throw error;
      }
      return { status: 'confirmed', reason: 'authorization_finalized' };
    },
    async onFinish(tx: FirestoreTransaction, row: LaneRow, terminal: LaneTerminal) {
      const value = operation(row);
      if (!value.restoration) return;
      const requestRef = db.collection(RESTORATION_REQUESTS).doc(value.restoration.request);
      const request = await tx.get(requestRef);
      if (!request.exists || request.get('destination') !== value.destination) throw Error('recourse_restoration_scope_unverified');
      if (request.get('ownerOperationId') !== row.id) {
        const successorId: unknown = request.get('ownerOperationId');
        if (terminal.status !== 'failed' || typeof successorId !== 'string' || !/^0x[0-9a-f]{64}$/.test(successorId)) throw Error('recourse_restoration_scope_unverified');
        const successorRecord = await tx.get(db.collection(OWNER_OPERATIONS).doc(successorId));
        const successor = parseRecoveryOwnerOperation(successorRecord.get('operation'));
        if (recoveryOperationId(successor) !== successorId || successor.identity !== value.identity
          || successor.destination !== value.destination || successor.nonce !== value.nonce
          || BigInt(successor.revision) <= BigInt(value.revision)
          || successor.restoration?.request !== value.restoration.request
          || successor.restoration.lossHash !== value.restoration.lossHash
          || successor.restoration.maximumLoss !== value.restoration.maximumLoss) throw Error('recourse_restoration_scope_unverified');
        return;
      }
      const hash = terminal.fields?.transactionHash ?? row.data.transactionHash ?? null;
      tx.update(requestRef, { status: terminal.status === 'confirmed' ? 'awaiting_determination' : 'authorization_failed',
        authorizationTxHash: hash, authorizationFinalizedAtMs: Date.now() });
    },
  };
}

/** Join and departure consents, monthly debits and break recovery steps share one shape. */
export function sponsoredLaneKind<R, P extends SponsoredOperationPlan>(name: string, adapter: SponsoredOperationAdapter<R, P>): LaneKind {
  const request = (row: LaneRow): R => {
    const value = adapter.parse(row.data.request);
    if (adapter.id(value) !== row.id) throw Error('recourse_sponsor_record_mismatch');
    return value;
  };
  return { name, collection: adapter.collection,
    async prepare(row, gasPayer): Promise<LanePrepared> {
      const value = request(row), data = adapter.calldata(value), target = adapter.target(value, row.data.executor);
      let plan: P;
      try { plan = await adapter.check(value); }
      catch (error) {
        if (adapter.obsolete(error)) return { kind: 'finish', status: 'failed', reason: code(error) || 'obsolete' };
        throw error;
      }
      adapter.assert(plan);
      if (plan.id !== row.id || plan.executor !== target || plan.calldata !== data) throw Error('recourse_sponsor_plan_mismatch');
      if (plan.gasPayer !== gasPayer) return { kind: 'finish', status: 'failed', reason: 'recourse_sponsor_gas_payer_changed' };
      if (adapter.satisfied(plan)) return { kind: 'finish', status: 'confirmed', reason: 'already_satisfied' };
      return { kind: 'sign', plan: { executor: plan.executor, calldata: plan.calldata, fields: {} } };
    },
    expected(row) { const value = request(row); return { executor: adapter.target(value, row.data.executor), calldata: adapter.calldata(value) }; },
    async settle(row, receipt): Promise<LaneTerminal> {
      if (receipt.status !== 1) return { status: 'failed', reason: 'transaction_reverted' };
      if (adapter.reconcileConfirmed) await adapter.reconcileConfirmed(request(row), String(row.data.transactionHash));
      return { status: 'confirmed', reason: 'transaction_confirmed' };
    },
  };
}

const factory = new Interface(['function deploy(bytes32) returns(address)']);
export function breakDeploymentAdapter(check: typeof checkBreakDeployment = checkBreakDeployment):
SponsoredOperationAdapter<AccountDeploymentRequest, CheckedBreakDeployment> {
  return { lane: true, collection: BREAK_DEPLOYMENTS, parse: parseAccountDeploymentRequest, id: accountDeploymentDigest,
    target: value => value.factory, calldata: value => factory.encodeFunctionData('deploy', [value.initialRoot]),
    check: value => check(value), assert: assertCheckedBreakDeployment, satisfied: plan => plan.alreadyDeployed,
    obsolete: error => error instanceof Error && ['break_deployment_retired', 'break_deployment_owner_changed'].includes(error.message),
    finalized: finalizedOwnerTransaction };
}

/** Every relay-driven Recourse transaction kind, all sent by the one lane. */
export function recourseLaneKinds(db: Firestore, attestor: IdentityAttestor): readonly LaneKind[] {
  return [
    bindingLaneKind(db, attestor),
    ownerOperationLaneKind(db),
    sponsoredLaneKind('membership_consent', membershipConsentAdapter(db)),
    sponsoredLaneKind('membership_debit', membershipDebitAdapter(db)),
    sponsoredLaneKind('break_deployment', breakDeploymentAdapter()),
    sponsoredLaneKind('break_registration', breakRegistrationAdapter()),
  ];
}
