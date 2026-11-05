/**
 * B11 — cross-source mint-once for the priced chain-financial family,
 * closing the residual: one canonical on-chain settlement (send /
 * receive / swap / agent_* transfer) can never mint through two sources or two
 * seal keys. Byte-for-byte the x402 claim shape (`x402-tx-mint-claim.ts`),
 * keyed (settling address, txHash) in its own kind/collection so x402's
 * existing claims are untouched.
 *
 * Prepared today by the ONE durable chain-verified source (the outbound-USDC
 * watcher's emit). If `/transfer/record` or `/swap/record` is ever promoted to
 * a durable inlet, its accrual prepares the SAME claim for the SAME
 * (address, txHash) and comes back `duplicate` recording for chain
 * integrity, minting 0 — instead of silently double-minting. The
 * pending-evidence resolver's mode-(b) chain-receipt branch consults the same
 * registry (the third potential seal path for one canonical event).
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';
import { solanaClaimInstructionEvent, solanaClaimSubject } from '../external-address/solana-keys';

/**
 * The ARMED template's canonical-event group for the priced chain-financial
 * family. Family membership derives from the policy row's own group (never a
 * redeclared type list,); this is the group's name, used to READ it.
 */
export const FINANCIAL_SETTLEMENT_EVENT_GROUP = 'base_chain_financial_settlement';

// The claim key is the SEALED canonical event id, verbatim. Primary form is
// the log-granular `chainId:txHash:logIndex` (canonicalLogIdentity — the
// watcher seals it explicitly per /; review defect 1: a bare-tx key
// collapsed two same-tx transfers onto one claim). A bare tx hash is also
// accepted for a genuinely tx-granular producer.
const CHAIN_LOG_EVENT = /^\d{1,10}:0x[0-9a-fA-F]{64}:\d{1,6}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The (settling address, canonical event) key the seal claims for a row of the
 * priced chain-financial family, or null when the row cannot claim. Only a
 * chain-verified submission claims (`economicEvidenceState === 'verified'` is
 * stamped solely by trusted server verifiers), the event id must be tx-keyed,
 * the settling address must be a well-formed EVM address, and `x402_payment`
 * is excluded (it carries its own kind). ONE derivation, read by the seal
 * (`pvt-accrual.ts`) and by the pending-cache backfill's pre-promotion slot
 * inspection — a pre-fix row's expected claim is reconstructed from the exact
 * rule the seal applies, never a restated copy of it.
 */
export function financialSettlementMintClaimKey(input: {
  readonly actionType: string;
  readonly canonicalEventGroup: string | null | undefined;
  readonly economicEvidenceState?: string | null;
  readonly economicCanonicalEventId?: string | null;
  readonly walletAddress?: string | null;
}): { readonly settlingAddress: string; readonly settlementEventId: string } | null {
  if (input.canonicalEventGroup !== FINANCIAL_SETTLEMENT_EVENT_GROUP
    || input.actionType === 'x402_payment'
    || input.economicEvidenceState !== 'verified') {
    return null;
  }
  const rawEventId = typeof input.economicCanonicalEventId === 'string'
    ? input.economicCanonicalEventId.trim()
    : '';
  // follow-up — a Solana settlement (the x402 facilitator lane): the settling
  // address is a base58 key and the event `solana:<base58 signature>:<instruction index>`. Both
  // enter the claim store as their exact bytes in hex (`solana-keys.ts`), because the store
  // lowercases and base58 is case-sensitive. A Solana address with an EVM event (or the reverse)
  // claims nothing.
  const solanaSubject = solanaClaimSubject(typeof input.walletAddress === 'string' ? input.walletAddress.trim() : null);
  if (solanaSubject !== null) {
    const solanaEvent = solanaClaimInstructionEvent(rawEventId);
    return solanaEvent === null ? null : { settlingAddress: solanaSubject, settlementEventId: solanaEvent };
  }
  const settlementEventId = CHAIN_LOG_EVENT.test(rawEventId) || TX_HASH.test(rawEventId)
    ? rawEventId
    : null;
  const settlingAddress = typeof input.walletAddress === 'string'
    && ADDRESS.test(input.walletAddress.trim())
    ? input.walletAddress.trim()
    : null;
  return settlementEventId && settlingAddress ? { settlingAddress, settlementEventId } : null;
}

/**
 * Prepare without mutating Firestore. writePEHistory commits the returned
 * canonical claim together with the PE row or rejects a concurrent race.
 */
export async function prepareFinancialSettlementMintClaim(
  db: Firestore,
  settlingAddress: string,
  txHash: string,
  peId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'financial_settlement',
    subjectId: settlingAddress,
    eventId: txHash,
    peId,
    userId,
    nowMs,
  });
}
