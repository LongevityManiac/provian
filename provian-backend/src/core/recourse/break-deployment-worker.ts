import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { BREAK_DEPLOYMENTS, checkBreakDeployment, assertCheckedBreakDeployment, type CheckedBreakDeployment } from './break-deployment-queue';
import { parseBreakDeploymentRequest, breakDeploymentDigest, type BreakDeploymentRequest } from './break-deployment-data';
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
  return executeSponsoredOperation<BreakDeploymentRequest, CheckedBreakDeployment>(db, id, signer, {
    collection: BREAK_DEPLOYMENTS, parse: parseBreakDeploymentRequest, id: breakDeploymentDigest,
    target: request => request.factory, calldata: request => factory.encodeFunctionData('deploy', [request.initialRoot]),
    check: ports.check, assert: assertCheckedBreakDeployment, satisfied: plan => plan.alreadyDeployed,
    obsolete: error => error instanceof Error && error.message === 'break_deployment_retired', finalized: ports.finalized,
  });
}
