import { getBytes, type Wallet } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createRecourseGasSigner } from './gas-signer';
import { assertCheckedRecourseExecution, prepareDeterminationExecution, prepareRecordedPoolExecution,
  verifyRecourseExecution, type CheckedRecourseExecution } from './determination-execution';
import { executeRecourseCall, resumeRecourseCall, RECOURSE_EXECUTIONS, type RecourseExecutionCall } from './execution-transaction';
import { recheckQueuedDetermination, type DeterminationWorkflowPort } from './determination-workflow';
import { recordDeterminationOutcome } from './determination-outcome';
import { findPoolWithdrawal } from './pool-withdrawal';

type ExecutionWallet = Pick<Wallet, 'address' | 'signTransaction'>;
/** The authority remains an operator-held key, never a public relay endpoint.
 * The separate attestor certifies witnessed evidence; gas sponsorship alone
 * cannot choose a finding, an affected balance or a restoration destination. */
export function createDeterminationWorkflowPort(db: Firestore, wallets: {
  readonly authority: ExecutionWallet;
  readonly gas: ExecutionWallet;
  readonly attestor: Pick<Wallet, 'address' | 'signMessage'>;
}): DeterminationWorkflowPort {
  const authority = createRecourseGasSigner(wallets.authority, assertCheckedRecourseExecution);
  const gas = createRecourseGasSigner(wallets.gas, assertCheckedRecourseExecution);
  const signerFor = (address: string) => {
    const result = [authority, gas].find(signer => signer.address === address);
    if (!result) throw Error('recourse_execution_signer_mismatch');
    return result;
  };
  return {
    recheck: row => recheckQueuedDetermination(db, row),
    prepare: (value, kind) => prepareDeterminationExecution(value, kind, {
      address: wallets.attestor.address.toLowerCase(), signDigest: hash => wallets.attestor.signMessage(getBytes(hash)),
    }),
    recorded: (requests, kind, request) => prepareRecordedPoolExecution(db, requests, kind, undefined, {
      address: wallets.attestor.address.toLowerCase(), signDigest: hash => wallets.attestor.signMessage(getBytes(hash)),
    }, request),
    execute: async (value: RecourseExecutionCall) => {
      const checked = value as CheckedRecourseExecution;
      // The runtime brand, not the structural cast, grants signing capability.
      assertCheckedRecourseExecution(checked);
      return executeRecourseCall(db, checked, signerFor(value.signer), verifyRecourseExecution);
    },
    resume: async id => {
      const row = await db.collection(RECOURSE_EXECUTIONS).doc(id).get();
      if (!row.exists || row.get('signedTransaction') === undefined) return null;
      const plan = row.get('plan') as RecourseExecutionCall;
      if (!plan || typeof plan.signer !== 'string') throw Error('recourse_execution_record_changed');
      return resumeRecourseCall(db, id, signerFor(plan.signer));
    },
    record: (request, transactions) => recordDeterminationOutcome(db, request, transactions),
    delivered: async request => {
      const event=await findPoolWithdrawal(db,request);
      return event?{transactionHash:event.transactionHash}:null;
    },
  };
}
