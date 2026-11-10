import { Wallet } from 'ethers';
import { createRecourseGasSigner } from './gas-signer';
import type { Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/wp4/durable-settlement-store';
import { BINDING_OPERATIONS, configuredIdentityAttestor, assertCheckedBindingOperation } from './binding-operation';
import { executeBindingOperation } from './binding-worker';

/** One durable step per scheduler/request. Submitted work always resumes first;
 * the shared lease leaves settlement untouched while an owned nonce is pending. */
export async function runBindingWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env):
Promise<{ id: string; status: string } | null> {
  const key = env.PVT9_SETTLEMENT_MINTER_KEY;
  if (!key) throw new Error('recourse_binding_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(key), assertCheckedBindingOperation), attestor = configuredIdentityAttestor(env);
  const lease = await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get();
  const reserved: unknown = lease.get('pending_operation');
  let id: string;
  if (typeof reserved === 'string') {
    if (!reserved.startsWith('binding:')) return null;
    id = reserved.slice('binding:'.length);
  } else {
    const submitted = await db.collection(BINDING_OPERATIONS).where('status', '==', 'submitted').limit(1).get();
    const rows = submitted.empty ? await db.collection(BINDING_OPERATIONS).where('status', '==', 'queued').limit(1).get() : submitted;
    if (rows.empty) return null;
    id = rows.docs[0].id;
  }
  return { id, status: await executeBindingOperation(db, id, signer, attestor) };
}
