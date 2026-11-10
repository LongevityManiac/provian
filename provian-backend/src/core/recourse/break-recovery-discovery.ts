import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { RECOURSE_COLLECTIONS } from './ownership';
import { BREAK_RESTORATIONS, reconcileBreakRestoration } from './break-restoration-queue';
import { breakRestorationDetails, parseBreakRestorationRequest } from './break-restoration-data';
import { breakEntitlementId, checkStoredBreakEntitlement } from './break-entitlement-store';

/** Public transaction witnesses, not a credential grant. A restored device
 * authenticates each candidate against finalized chain receipts and its seed.
 * The relay address only tells it whether the address-index cut is unfinished. */
export interface BreakRecoveryDiscovery {
  identity: string; origin: string; relayDestination: string;
  candidates: Array<{ transactionHash: string; prepared: {
    phase: 'restore_balance'; kernel: string; ownerIntent: string; data: string; executor: string; authority: string;
    identity: string; destination: string; amount: string; manifestHash: string;
  } }>;
}
export async function discoverBreakRecovery(db: Firestore, origin: string, identity: string): Promise<BreakRecoveryDiscovery> {
  breakEntitlementId(origin,identity);
  const owner = await db.collection(RECOURSE_COLLECTIONS.identities).doc(identity).get();
  const walletId: unknown = owner.get('walletId'), type: unknown = owner.get('ownerType');
  if (!owner.exists || typeof walletId !== 'string' || !['human','agent'].includes(String(type))) throw Error('break_discovery_owner_missing');
  const wallet = await db.collection(type === 'human' ? 'wallets' : 'agent_wallets').doc(walletId).get();
  const destination: unknown = wallet.get('address');
  if (typeof destination !== 'string' || !/^0x[0-9a-f]{40}$/i.test(destination)) throw Error('break_discovery_wallet_invalid');
  const rows = await db.collection(BREAK_RESTORATIONS).where('identity','==',identity).get();
  const candidates: BreakRecoveryDiscovery['candidates'] = [];
  for (const row of rows.docs) {
    const request = parseBreakRestorationRequest(row.get('request')), details = breakRestorationDetails(request);
    if (details.identity !== identity) throw Error('break_discovery_record_changed');
    try {
      await checkStoredBreakEntitlement(origin,identity,{identity,amount:details.amount,commitment:details.commitment,proof:details.snapshotProof});
    } catch (error) {
      // Older breaks have another immutable root. All other failures remain
      // visible instead of turning an unavailable chain into an empty result.
      if (error instanceof Error && error.message === 'break_entitlement_proof_invalid') continue;
      throw error;
    }
    const status = await reconcileBreakRestoration(db,row.id);
    if (status.status !== 'confirmed') continue;
    if (!status.transactionHash) throw Error('break_discovery_receipt_missing');
    const executor: unknown = row.get('executor'), authority: unknown = row.get('authority');
    if (typeof executor !== 'string' || !/^0x[0-9a-f]{40}$/.test(executor)
      || typeof authority !== 'string' || !/^0x[0-9a-f]{40}$/.test(authority)) throw Error('break_discovery_record_changed');
    candidates.push({transactionHash:status.transactionHash,prepared:{phase:'restore_balance',...request,executor,authority,
      identity,destination:details.destination,amount:details.amount,manifestHash:(await currentProtocolDeployment()).manifestHash}});
  }
  return {identity,origin,relayDestination:destination.toLowerCase(),candidates};
}
