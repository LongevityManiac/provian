import type { BindDeps } from './link-human-binding';
import { unbindAgentFromHuman } from './link-human-binding';
import type { AgentWalletDocument } from './types';

/** The caller has authorized human deletion and released the human's wallets first. */
export async function endHumanBeneficiaryLinks(deps: BindDeps, userId: string): Promise<void> {
  const linked = await deps.db.collection('agent_wallets').where('linked_human_user_id', '==', userId).get();
  for (const doc of linked.docs) {
    // Re-read a query snapshot: another unlink may have finished while this deletion waited.
    const current = await deps.db.collection('agent_wallets').doc(doc.id).get();
    const wallet = current.exists ? current.data() as AgentWalletDocument : null;
    if (!wallet || wallet.linked_human_user_id !== userId) continue;
    await unbindAgentFromHuman(deps, { wallet, endedBy: 'linked_human' });
  }
}
