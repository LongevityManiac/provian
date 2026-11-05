/** Observability metadata only. Never an auth, pricing, eligibility or settlement input. */
import type { Firestore } from 'firebase-admin/firestore';

export type ParticipantClass = 'operator' | 'canary' | 'fixture' | 'external';
export function participantClass(value: unknown): ParticipantClass | null {
  return value === 'operator' || value === 'canary' || value === 'fixture' || value === 'external' ? value : null;
}

/** Resolve a server-owned identity; request bodies never supply this field. */
export async function ownerParticipantClass(db: Firestore, ownerId: string): Promise<ParticipantClass> {
  const migration = await db.collection('ops_participant_migrations_v1').doc('launch').get();
  const planned = migration.data()?.owner_classes as Record<string, unknown> | undefined;
  const frozen = participantClass(planned?.[ownerId]);
  if (frozen && migration.data()?.status === 'planned') return frozen;
  for (const collection of ['agent_wallets', 'wallets', 'users']) {
    const doc = await db.collection(collection).doc(ownerId).get();
    const value = participantClass(doc.data()?.network_class);
    if (value) return value;
  }
  const wallets = await db.collection('wallets').where('user_id', '==', ownerId).limit(2).get();
  const classes = new Set(wallets.docs.map(doc => participantClass(doc.data().network_class)).filter(value => value !== null));
  if (classes.size > 1) throw new Error('owner participant class is ambiguous');
  return [...classes][0] ?? 'external';
}

/** Immutable registration time is distinct from the last time this phone checked in. */
export function newMobileDeviceRegistration(id: string, name: string, now: number): {
  id: string; name: string; created_at: number; last_seen: number;
} {
  return { id, name, created_at: now, last_seen: now };
}
