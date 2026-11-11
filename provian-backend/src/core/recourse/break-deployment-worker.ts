import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { BREAK_DEPLOYMENTS, checkBreakDeployment, assertCheckedBreakDeployment, type CheckedBreakDeployment } from './break-deployment-queue';
import { parseAccountDeploymentRequest, accountDeploymentDigest, type AccountDeploymentRequest } from './break-deployment-data';
import { finalizedOwnerTransaction } from './transaction-finality';
import { executeSponsoredOperation, type SponsoredOperationSigner } from './sponsored-operation-worker';

const factory = new Interface(['function deploy(bytes32) returns(address)']);
export type BreakDeploymentSigner = SponsoredOperationSigner<CheckedBreakDeployment>;
export interface BreakDeploymentWorkerPorts {
  check: typeof checkBreakDeployment;
  finalized: typeof finalizedOwnerTransaction;
}
/** Deployment grants no restoration authority and moves no token. */
export async function executeBreakDeployment(db: Firestore, id: string, signer: BreakDeploymentSigner,
  ports: BreakDeploymentWorkerPorts = { check: checkBreakDeployment, finalized: finalizedOwnerTransaction }): Promise<'submitted' | 'confirmed' | 'failed'> {
  return executeSponsoredOperation<AccountDeploymentRequest, CheckedBreakDeployment>(db, id, signer, {
    collection: BREAK_DEPLOYMENTS, parse: parseAccountDeploymentRequest, id: accountDeploymentDigest,
    target: request => request.factory, calldata: request => factory.encodeFunctionData('deploy', [request.initialRoot]),
    check: ports.check, assert: assertCheckedBreakDeployment, satisfied: plan => plan.alreadyDeployed,
    obsolete: error => error instanceof Error && ['break_deployment_retired', 'break_deployment_owner_changed'].includes(error.message), finalized: ports.finalized,
  });
}
