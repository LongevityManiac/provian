import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T, type PrivateMembershipTransition } from './private-membership-transition';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { readMembershipJournal } from './private-membership-journal';
import { findMembershipSuccessionCheckpoint } from './membership-succession-checkpoint';
import { reconcilePrivateMembershipThrough } from './private-membership-reconcile';
import { readPrivateMembershipSuccession, commitPrivateMembershipSuccession } from './private-membership-succession';
import { reconcileAddressIssuance } from './private-issuance-succession';

/** Idempotent private catchup, called before a view or a new authorization.
 * Every successor is traversed independently. This sends no transaction and
 * cannot publish a pointer, choose a cutoff or revive a discarded payment. */
export async function reconcilePrivateMembershipDomain(db: Firestore, ownerIdentity: string): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity)) throw Error('recourse_membership_domain_owner');
  const addresses = await db.collection(R.addresses).where('ownerIdentity', '==', ownerIdentity).get();
  await reconcileAddressIssuance(db,addresses.docs.map(r => String(r.get('address'))));
  for (;;) {
    const accountRow = await db.collection(C.owners).doc(ownerIdentity).get(), owner = await db.collection(R.owners).doc(ownerIdentity).get();
    if (!owner.exists) throw Error('recourse_membership_domain_owner');
    const account = accountRow.exists ? accountRow.data() as PrivateMembershipAccount : null;
    const transitionId: unknown = owner.get('membershipTransition');
    const transitionRow = typeof transitionId === 'string' ? await db.collection(T).doc(transitionId).get() : null;
    const transition = transitionRow?.exists ? transitionRow.data() as PrivateMembershipTransition : null;
    if (!account && !transition) return;
    if (transition && transition.ownerIdentity !== ownerIdentity) throw Error('recourse_membership_domain_transition');
    const journal = account ? await readMembershipJournal(db,account) : [];
    const source = journal.at(-1)?.position ?? transition;
    if (!source) throw Error('recourse_membership_domain_source');
    const boundary = await findMembershipSuccessionCheckpoint({ pool: source.pool, kernel: source.kernel });
    if (!boundary) return;
    const from = Math.min(account?.checkpoint.block ?? Number.MAX_SAFE_INTEGER, transition?.checkpoint.block ?? Number.MAX_SAFE_INTEGER);
    if (from <= boundary.cutoff.block) await reconcilePrivateMembershipThrough(db,ownerIdentity,from,boundary.cutoff);
    const proof = await readPrivateMembershipSuccession(db,ownerIdentity,boundary.successor);
    await commitPrivateMembershipSuccession(db,proof);
  }
}
