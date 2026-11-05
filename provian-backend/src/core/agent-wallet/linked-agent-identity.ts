/**
 * Cheap, identity-only projection for the human's linked-agent read.
 *
 * The full Agent Hub projection enriches every wallet with PE counts, capture
 * health, and external-wallet proof. Those are useful details, but none is
 * needed to answer the first and most important question on Earn: "is an agent
 * linked to me?" Keeping this projection explicit also prevents the fast path
 * from accidentally exposing another field from the agent-wallet document.
 */

export interface LinkedAgentIdentity {
  wallet_id: string;
  agent_id: string;
  display_name: string;
  address: string;
  platform: string;
  created_at: number;
  solana_address: string | null;
  last_pe_date: string | null;
}

export function projectLinkedAgentIdentity(
  walletId: string,
  wallet: FirebaseFirestore.DocumentData,
): LinkedAgentIdentity {
  const agentId = typeof wallet.agent_id === 'string' ? wallet.agent_id : '';
  const chainAddresses = wallet.chain_addresses;
  const solanaAddress = chainAddresses !== null
    && typeof chainAddresses === 'object'
    && typeof chainAddresses.solana === 'string'
    ? chainAddresses.solana
    : null;

  return {
    wallet_id: walletId,
    agent_id: agentId,
    display_name: typeof wallet.display_name === 'string' && wallet.display_name
      ? wallet.display_name
      : agentId,
    address: typeof wallet.address === 'string' ? wallet.address : '',
    platform: typeof wallet.platform === 'string' ? wallet.platform : '',
    created_at: typeof wallet.created_at === 'number' ? wallet.created_at : 0,
    solana_address: solanaAddress,
    last_pe_date: typeof wallet.last_pe_date === 'string' ? wallet.last_pe_date : null,
  };
}
