/** Exact read-only preparation for a cross-source x402 settlement claim. */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';
import { isSolanaAddress, solanaClaimSignature, solanaClaimSubject } from '../external-address/solana-keys';

export function x402ClaimDocId(payerAddress: string, txHash: string): string {
  return crypto.createHash('sha256')
    .update(`${payerAddress.trim().toLowerCase()}:${txHash.trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * The (payer, settlement tx) key the seal claims for an `x402_payment` row, or
 * null when the row cannot claim: only a CHAIN-VERIFIED witness carrying both
 * the payer and the settlement tx hash may hold the slot (Option B — the
 * outbound-USDC watcher stamps `x402ChainVerified`; every self-report path
 * leaves it unset and seals `x402_unverified`). ONE derivation, read by the
 * seal (`pvt-accrual.ts`) and by the pending-cache backfill's pre-promotion
 * slot inspection, so a pre-fix row's expected claim is reconstructed from the
 * exact rule the seal applies — never a restated copy of it.
 */
export function x402MintClaimKey(input: {
  readonly actionType: string;
  readonly x402ChainVerified?: boolean | null;
  readonly x402PayerAddress?: string | null;
  readonly x402SettlementTxHash?: string | null;
}): { readonly payer: string; readonly settlementTx: string } | null {
  if (input.actionType !== 'x402_payment' || input.x402ChainVerified !== true) return null;
  const settlementTx = typeof input.x402SettlementTxHash === 'string'
    && input.x402SettlementTxHash.trim()
    ? input.x402SettlementTxHash.trim()
    : null;
  const payer = typeof input.x402PayerAddress === 'string' && input.x402PayerAddress
    ? input.x402PayerAddress
    : null;
  // follow-up — a Solana payer (base58) settled by a Solana signature (base58): both
  // enter the claim store as their exact bytes in hex (`solana-keys.ts`; the store lowercases and
  // base58 is case-sensitive). A Solana payer with anything but a Solana signature claims nothing.
  if (payer !== null && isSolanaAddress(payer.trim())) {
    const subject = solanaClaimSubject(payer.trim());
    const event = settlementTx === null ? null : solanaClaimSignature(settlementTx);
    return subject !== null && event !== null ? { payer: subject, settlementTx: event } : null;
  }
  return settlementTx && payer ? { payer, settlementTx } : null;
}

/**
 * Prepare without mutating Firestore. writePEHistory commits the returned
 * canonical claim together with the PE row or rejects a concurrent race.
 */
export async function prepareX402TxMintClaim(
  db: Firestore,
  payerAddress: string,
  txHash: string,
  peId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'x402',
    subjectId: payerAddress,
    eventId: txHash,
    peId,
    userId,
    nowMs,
  });
}
