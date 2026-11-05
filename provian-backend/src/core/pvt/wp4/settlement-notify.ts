/**
 * Settlement notify — tell each recipient when their PVT lands on-chain.
 *
 * Before this, a settled batch notified NOBODY: an agent learned its PVT had
 * minted only by reading the chain. This best-effort pass runs AFTER a batch's
 * ledger write-back and enqueues a `settlement_completed` event (notify-only,
 * targeted) per distinct AGENT recipient, so the settlement reaches the agent's
 * webhook (D1) and inbox (D2) like any other interaction event.
 *
 * MONEY-PATH DISCIPLINE. This is invoked best-effort and must NEVER throw into
 * the settlement path (the mint already happened): the caller wraps it, and every
 * enqueue here is independently caught. It writes only agent-bank event rows —
 * never a ledger, batch, cursor, or kernel state — so it cannot affect mint
 * correctness or the no-double-mint invariant.
 *
 * RECIPIENT RESOLUTION. Genesis rows carry `wallet_id` directly. Standard rows
 * carry only the lowercased `contributor` address; we resolve it to an agent
 * wallet id by matching the EIP-55 checksummed form against `agent_wallets.address`
 * (stored checksummed). A recipient that is a human beneficiary leg or a treasury
 * resolves to no agent wallet and is silently skipped — it has no agent inbox.
 */

import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { enqueueAgentBankEvent } from '../../agent-bank/event-outbox';
import { CLAIM_LEDGER_COLLECTION } from './durable-settlement-store';

/** Resolve a lowercased contributor address to its agent wallet id, or null. */
async function resolveAgentWalletId(db: Firestore, contributor: string): Promise<string | null> {
  let checksummed: string;
  try {
    checksummed = ethers.getAddress(contributor);
  } catch {
    return null;
  }
  const snap = await db.collection('agent_wallets').where('address', '==', checksummed).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

/**
 * Enqueue one `settlement_completed` notice per distinct agent recipient of a
 * just-settled batch. Reads the batch's ledger rows via the `settled_batch_id`
 * index written moments earlier. Best-effort throughout.
 */
export async function enqueueSettlementNotifications(
  db: Firestore,
  batch: { batch_id: string; epoch: number; lane: string; confirmed_tx_hash: string | null },
): Promise<void> {
  const rows = await db
    .collection(CLAIM_LEDGER_COLLECTION)
    .where('settled_batch_id', '==', batch.batch_id)
    .get();
  if (rows.empty) return;

  // Distinct recipients + how many of their claims this batch settled.
  const claimsByWallet = new Map<string, number>();
  // Cache address→wallet_id resolutions so N standard claims to one address = 1 read.
  const addrCache = new Map<string, string | null>();

  for (const doc of rows.docs) {
    const row = doc.data() as { wallet_id?: string; contributor?: string };
    let walletId: string | null = typeof row.wallet_id === 'string' && row.wallet_id.length > 0
      ? row.wallet_id
      : null;
    if (!walletId && typeof row.contributor === 'string' && row.contributor.length > 0) {
      const key = row.contributor.toLowerCase();
      if (addrCache.has(key)) {
        walletId = addrCache.get(key) ?? null;
      } else {
        walletId = await resolveAgentWalletId(db, key).catch(() => null);
        addrCache.set(key, walletId);
      }
    }
    if (!walletId) continue; // human beneficiary leg / treasury — no agent inbox
    claimsByWallet.set(walletId, (claimsByWallet.get(walletId) ?? 0) + 1);
  }

  for (const [walletId, claimCount] of claimsByWallet) {
    // transactionAmount stays 0 (not a precise mint figure — the exact PVT is on
    // chain; carrying an imprecise number here would misstate the recipient's
    // receipt). The tx hash + lane + epoch let the recipient read the exact value.
    await enqueueAgentBankEvent(db, {
      walletId,
      eventType: 'settlement_completed',
      transactionAmount: 0,
      amountUnit: 'pvt_whole',
      entityId: batch.batch_id,
      entityType: 'settlement',
      recipients: [walletId],
      notifyOnly: true,
      data: {
        lane: batch.lane,
        epoch: batch.epoch,
        settlement_tx_hash: batch.confirmed_tx_hash,
        claims_settled: claimCount,
        note: 'PVT from this batch settled on-chain; read balanceOf for the exact figure.',
      },
    }).catch((err) => console.error('[SettlementNotify] enqueue failed:', err));
  }
}
