
import crypto from 'crypto';

import { generatePE, type PeGenerationDeps } from '../agent-bank/pe-utils';

/** `record_only`, weight 0 — see `proposed-action-policy.ts`. */
export const HUMAN_WALLET_RECLAIM_PE_ACTION_TYPE = 'recovery_action' as const;
export const HUMAN_WALLET_RECLAIM_KIND = 'human_wallet_address_reclaimed' as const;

export function humanWalletReclaimPEId(newWalletId: string): string {
  return `pe_wallet_reclaim_${crypto.createHash('sha256').update(newWalletId, 'utf8').digest('hex')}`;
}

export async function emitHumanWalletReclaimPE(params: {
  readonly deps: PeGenerationDeps;
  readonly userId: string;
  readonly walletId: string;
  readonly address: string;
  readonly displacedWalletId: string;
  readonly genesisAlreadyGrantedForAddress: boolean;
  readonly occurredAtMs: number;
}): Promise<string | null> {
  try {
    const generated = await generatePE(params.deps, {
      walletId: params.walletId,
      agentId: params.userId,
      actorAddress: params.address,
      actionType: HUMAN_WALLET_RECLAIM_PE_ACTION_TYPE,
      peIdOverride: humanWalletReclaimPEId(params.walletId),
      timestampOverride: params.occurredAtMs,
      ownerType: 'human',
      walletAddress: params.address,
      metadata: {
        recovery_kind: HUMAN_WALLET_RECLAIM_KIND,
        address: params.address.toLowerCase(),
        displaced_wallet_id: params.displacedWalletId,
        proof: 'eip712_register_human_wallet',
        genesis_already_granted_for_address: params.genesisAlreadyGrantedForAddress,
        mints: 'nothing_record_only',
      },
    });
    return generated.peId;
  } catch (error) {
    console.warn('[human-register] Address reclaimed; reclaim receipt PE not written', {
      walletId: params.walletId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
