/**
 * F-A6 — the inbound USDC watcher seals the LOG-GRANULAR canonical
 * identity EXPLICITLY, matching the outbound watcher's fix.
 *
 * The inbound emit metadata carries `tx_hash` + `log_index` as SEPARATE fields
 * with no `canonical_event_id`, so the accrual's `firstEconomicEventId` fallback
 * keyed the financial-settlement mint-once on the BARE tx hash. Two USDC deposits
 * in ONE transaction (same tx, distinct log index) then collapsed onto ONE claim
 * and the second was refused a mint it earned. This suite proves the emit now
 * seals `chainId:txHash:logIndex` and that this is load-bearing — with a permanent
 * in-suite RED control showing the bare-tx key COLLIDES where the
 * log-granular key SEPARATES.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';

// buildBaseInboundDeps.emitFundingPE calls the module-level generatePE; mock it
// so the emit params (the explicitly-sealed observedCanonicalEventId) can be
// inspected in isolation, without exercising the real chain-tip/accrual machinery.
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_test', peHash: 'h', prevHash: 'p' })),
}));

import {
  buildBaseInboundDeps,
  type WatchedWallet,
  type InboundFundingEvent,
} from './inbound-usdc-watcher';
import { generatePE } from '../agent-bank/pe-utils';
import { canonicalLogIdentity } from './institution-funding-watcher';
import {
  financialSettlementMintClaimKey,
  FINANCIAL_SETTLEMENT_EVENT_GROUP,
} from './financial-settlement-mint-claim';
import type { AgentBankDeps } from '../agent-bank/types';

const BASE_CHAIN_ID = 8453;
const SETTLING = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FROM = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const genPEMock = generatePE as jest.Mock;

function testTxHash(label: string): string {
  return `0x${crypto.createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

const wallet: WatchedWallet = {
  walletId: 'w1',
  agentId: 'agent1',
  address: SETTLING,
  createdAtMs: 0,
  eligibilityStartBlock: 100,
  ownerType: 'agent',
};

function fundingEvent(txHash: string, logIndex: number): InboundFundingEvent {
  return {
    txHash,
    logIndex,
    blockNumber: 1500,
    fromAddress: FROM,
    amountUsd: 5,
    amountAtomic: '5000000',
    observedAtMs: 1234,
  };
}

// A chain-verified metadata shape (the emit refuses anything under-confirmed).
const metadata = (): Record<string, unknown> => ({
  tx_hash: 'ignored-by-explicit-seal',
  asset: 'USDC',
  verified: true,
  finality_confirmations: 12,
});

/** Drive the funding emit and return the observedCanonicalEventId it sealed. */
async function sealedCanonicalId(txHash: string, logIndex: number): Promise<unknown> {
  genPEMock.mockClear();
  const deps = buildBaseInboundDeps({
    db: createFakeFirestore() as unknown as Firestore,
  } as unknown as AgentBankDeps);
  await deps.emitFundingPE(wallet, fundingEvent(txHash, logIndex), metadata());
  expect(genPEMock).toHaveBeenCalledTimes(1);
  return (genPEMock.mock.calls[0][1] as { observedCanonicalEventId?: unknown }).observedCanonicalEventId;
}

describe('inbound USDC watcher — explicit log-granular canonical identity (F-A6 /)', () => {
  it('seals chainId:txHash:logIndex explicitly, NOT the bare tx hash', async () => {
    const tx = testTxHash('one-tx-two-deposits');
    const idLog0 = await sealedCanonicalId(tx, 0);
    const idLog1 = await sealedCanonicalId(tx, 1);

    // Each is the log-granular identity (one source for the format).
    expect(idLog0).toBe(canonicalLogIdentity(BASE_CHAIN_ID, tx, 0));
    expect(idLog1).toBe(canonicalLogIdentity(BASE_CHAIN_ID, tx, 1));
    // NOT the bare tx hash — that is exactly the fallback this seal outranks.
    expect(idLog0).not.toBe(tx);
    // Two deposits in one tx are DISTINCT canonical events.
    expect(idLog0).not.toBe(idLog1);
  });

  it('two deposits in ONE tx claim DISTINCT financial-settlement slots — RED control: the bare-tx key would collide', async () => {
    const tx = testTxHash('collision-control');
    const idLog0 = (await sealedCanonicalId(tx, 0)) as string;
    const idLog1 = (await sealedCanonicalId(tx, 1)) as string;

    const claim = (canonicalEventId: string) =>
      financialSettlementMintClaimKey({
        actionType: 'receive',
        canonicalEventGroup: FINANCIAL_SETTLEMENT_EVENT_GROUP,
        economicEvidenceState: 'verified',
        economicCanonicalEventId: canonicalEventId,
        walletAddress: SETTLING,
      });

    // WHAT THE WATCHER NOW SEALS: log-granular → two distinct claim slots, both mint.
    const green0 = claim(idLog0);
    const green1 = claim(idLog1);
    expect(green0).not.toBeNull();
    expect(green1).not.toBeNull();
    expect(green0!.settlingAddress).toBe(green1!.settlingAddress); // same actor
    expect(green0!.settlementEventId).not.toBe(green1!.settlementEventId); // distinct events

    // RED NEGATIVE CONTROL : the pre-fix bare-tx form. Both logs of one tx
    // resolve to the SAME (settling address, settlementEventId) slot — the second
    // deposit is refused the mint it earned. This is the defect the explicit seal
    // above prevents; if this ever stops colliding, the fix is no longer load-bearing.
    const redSame0 = claim(tx);
    const redSame1 = claim(tx);
    expect(redSame0).not.toBeNull();
    expect(redSame1).not.toBeNull();
    expect(redSame0!.settlingAddress).toBe(redSame1!.settlingAddress);
    expect(redSame0!.settlementEventId).toBe(redSame1!.settlementEventId); // COLLISION
  });
});
