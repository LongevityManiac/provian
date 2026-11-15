import { Wallet } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createRecourseGasSigner } from './gas-signer';
import { BREAK_DEPLOYMENTS, assertCheckedBreakDeployment } from './break-deployment-queue';
import { executeBreakDeployment } from './break-deployment-worker';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';

export async function runBreakDeploymentWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  if (!env.PVT9_SETTLEMENT_MINTER_KEY) throw Error('break_deployment_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(env.PVT9_SETTLEMENT_MINTER_KEY), assertCheckedBreakDeployment);
  const pending: unknown = (await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get()).get('pending_operation');
  let id: string;
  if (typeof pending === 'string') {
    if (!/^0x[0-9a-f]{64}$/.test(pending) || !(await db.collection(BREAK_DEPLOYMENTS).doc(pending).get()).exists) return null;
    id = pending;
  } else {
    const submitted = await db.collection(BREAK_DEPLOYMENTS).where('status', '==', 'submitted').limit(1).get();
    const rows = submitted.empty ? await db.collection(BREAK_DEPLOYMENTS).where('status', '==', 'queued').limit(1).get() : submitted;
    if (rows.empty) return null; id = rows.docs[0].id;
  }
  return { id, status: await executeBreakDeployment(db, id, signer) };
}
