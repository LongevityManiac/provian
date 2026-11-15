import { Wallet } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
import { createRecourseGasSigner } from './gas-signer';
import { MEMBERSHIP_CONSENT_OPERATIONS, assertCheckedMembershipConsent, executeMembershipConsent } from './membership-consent-operation';
import { MEMBERSHIP_DEBIT_OPERATIONS, assertCheckedMembershipDebit, executeMembershipDebit } from './membership-debit-operation';

async function pendingOperation(db: Firestore, signer: string, collection: string): Promise<string | null> {
  const lease = await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer).get();
  const pending: unknown = lease.get('pending_operation');
  if (typeof pending === 'string') {
    if (!/^0x[0-9a-f]{64}$/.test(pending) || !(await db.collection(collection).doc(pending).get()).exists) return null;
    return pending;
  }
  const submitted = await db.collection(collection).where('status', '==', 'submitted').limit(1).get();
  const rows = submitted.empty ? await db.collection(collection).where('status', '==', 'queued').limit(1).get() : submitted;
  return rows.empty ? null : rows.docs[0].id;
}

/** One durable step, using the existing gas sponsor and shared nonce lease. */
export async function runMembershipConsentWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  const key = env.PVT9_SETTLEMENT_MINTER_KEY;
  if (!key) throw Error('recourse_membership_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(key), assertCheckedMembershipConsent);
  const id = await pendingOperation(db, signer.address, MEMBERSHIP_CONSENT_OPERATIONS);
  if (!id) return null;
  return { id, status: await executeMembershipConsent(db, id, signer) };
}
export async function runMembershipDebitWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  const key = env.PVT9_SETTLEMENT_MINTER_KEY;
  if (!key) throw Error('recourse_membership_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(key), assertCheckedMembershipDebit);
  const id = await pendingOperation(db, signer.address, MEMBERSHIP_DEBIT_OPERATIONS);
  if (!id) return null;
  return { id, status: await executeMembershipDebit(db, id, signer) };
}
