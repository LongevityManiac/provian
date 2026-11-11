import { Wallet } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/wp4/durable-settlement-store';
import { createRecourseGasSigner } from './gas-signer';
import { MEMBERSHIP_CONSENT_OPERATIONS, assertCheckedMembershipConsent, executeMembershipConsent } from './membership-consent-operation';

/** One durable step, using the existing gas sponsor and shared nonce lease. */
export async function runMembershipConsentWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  const key = env.PVT9_SETTLEMENT_MINTER_KEY;
  if (!key) throw Error('recourse_membership_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(key), assertCheckedMembershipConsent);
  const lease = await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get();
  const pending: unknown = lease.get('pending_operation');
  let id: string;
  if (typeof pending === 'string') {
    if (!/^0x[0-9a-f]{64}$/.test(pending) || !(await db.collection(MEMBERSHIP_CONSENT_OPERATIONS).doc(pending).get()).exists) return null;
    id = pending;
  } else {
    const submitted = await db.collection(MEMBERSHIP_CONSENT_OPERATIONS).where('status', '==', 'submitted').limit(1).get();
    const rows = submitted.empty ? await db.collection(MEMBERSHIP_CONSENT_OPERATIONS).where('status', '==', 'queued').limit(1).get() : submitted;
    if (rows.empty) return null;
    id = rows.docs[0].id;
  }
  return { id, status: await executeMembershipConsent(db, id, signer) };
}
