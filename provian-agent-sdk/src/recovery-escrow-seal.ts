import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * recovery-escrow-seal — seal the agent's own wallet key to its recovering human's phone anchor
 * and escrow ONLY the ciphertext.
 *
 * One implementation behind every caller: wallet creation (`resumeAgentWalletRegistration`, so the
 * hosted install, `onboard`, `createChildAgentWallet` and any programmatic create escrow at birth),
 * the bootstrap's own step, and the daemon's heal (`recovery-escrow-heal.ts`). It lives in its own
 * module so the creation primitive can call it without importing the bootstrap orchestrator.
 *
 * The relay stores only the sealed blob and the PUBLIC anchor; it can never open it. The key is
 * sealed on this machine and never leaves it in the clear.
 */

import { hexToBytes } from '@noble/hashes/utils';
import { sealToAnchor, toB64u, fromB64u } from './agent-key-recovery';

export interface SealAndEscrowInput {
  relayUrl: string;
  walletId: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
  anchorPubkeyB64u: string;
}

/**
 * Seal the raw 32-byte private key to the phone anchor and POST the ciphertext.
 * The relay stores only the sealed blob; this is the sole recovery path for a
 * lost machine. Throws on any non-2xx so a caller never reports an un-escrowed
 * wallet as recoverable.
 */
export async function sealAndEscrow(
  input: SealAndEscrowInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  fetchImpl = guardedFetcher(fetchImpl);
  const anchorPub = fromB64u(input.anchorPubkeyB64u);
  const keyBytes = hexToBytes(input.privateKey.replace(/^0x/, ''));
  const sealed = sealToAnchor(anchorPub, keyBytes);
  const url = `${input.relayUrl.replace(/\/+$/, '')}/v1/agent/wallet/${input.walletId}/recovery-escrow`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}:${input.apiSecret}`,
    },
    body: JSON.stringify({
      sealed_key_blob: toB64u(sealed),
      recovery_anchor_pubkey: input.anchorPubkeyB64u,
    }),
  });
  if (!res.ok) {
    throw new Error(`recovery escrow failed (${res.status})`);
  }
}
