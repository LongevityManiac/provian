/**
 * B11 — the cross-source financial-settlement mint-once claim,
 * closing the residual. Mirrors x402-tx-mint-claim.test.ts, plus the
 * cross-source collision the residual was about: two DIFFERENT PEs (two seal
 * keys, two sources) citing the SAME canonical (address, txHash) — the second
 * prepares as 'duplicate' and can never own the event.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { prepareFinancialSettlementMintClaim } from './financial-settlement-mint-claim';
import {
  applyMintOnceClaimDecision,
  inspectPreparedMintOnceClaimInTransaction,
} from './mint-once-claim';

const ADDRESS = '0xaaaa000000000000000000000000000000000002';
const TX = `0x${'e'.repeat(64)}`;

describe('prepared financial-settlement mint-once claim (B11,)', () => {
  it('prepares case-insensitively, in its OWN collection, with no write', async () => {
    const db = createFakeFirestore();
    const plan = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore,
      ADDRESS.toUpperCase().replace('0X', '0x'),
      TX.toUpperCase().replace('0X', '0x'),
      'pe_watcher_send',
      'agent_1',
      100,
    );
    expect(plan.claim_collection).toBe('financial_settlement_mint_claims');
    expect(plan.evidence).toMatchObject({
      relation: 'owner',
      claim: {
        claim_kind: 'financial_settlement',
        subject_id: ADDRESS,
        event_id: TX,
        owner_pe_id: 'pe_watcher_send',
      },
    });
    expect([...db.store.keys()].filter((k) => k.startsWith('financial_settlement_mint_claims/')))
      .toHaveLength(0);
  });

  it('rejects malformed address / tx identities before any write', async () => {
    const db = createFakeFirestore();
    await expect(prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, 'not-an-address', TX, 'pe_bad', 'agent_1', 100,
    )).rejects.toThrow('mint_once_claim_financial_settlement_binding_invalid');
    await expect(prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, '0xdeadbeef', 'pe_bad', 'agent_1', 100,
    )).rejects.toThrow('mint_once_claim_financial_settlement_binding_invalid');
  });

  it('[ RED — the double-mint scenario] a SECOND source citing the SAME (address,txHash) prepares as duplicate, never owner', async () => {
    const db = createFakeFirestore();
    // Source 1: the watcher's durable chain-verified `send` emit claims the event.
    const first = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, TX, 'pe_watcher_send', 'agent_1', 100,
    );
    expect(first.evidence.relation).toBe('owner');
    // Commit it the way writePEHistory does (create inside a transaction).
    await (db as unknown as Firestore).runTransaction(async (txn) => {
      const decision = await inspectPreparedMintOnceClaimInTransaction(
        db as unknown as Firestore, txn, first,
      );
      applyMintOnceClaimDecision(db as unknown as Firestore, txn, decision);
    });

    // Source 2: a hypothetically-durable self-report of the SAME on-chain act
    // (different PE id, different action type — nothing else keys them).
    const second = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, TX, 'pe_self_report_transfer', 'agent_1', 200,
    );
    expect(second.evidence.relation).toBe('duplicate');
    expect(second.evidence.claim.owner_pe_id).toBe('pe_watcher_send');

    // And a third party citing a stranger's settlement gets duplicate too —
    // the event is globally once, not per-user.
    const third = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, TX, 'pe_thief', 'agent_2', 300,
    );
    expect(third.evidence.relation).toBe('duplicate');
  });

  it('distinct settlements stay independent (no over-broad key)', async () => {
    const db = createFakeFirestore();
    const a = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, TX, 'pe_a', 'agent_1', 100,
    );
    const otherTx = `0x${'f'.repeat(64)}`;
    const b = await prepareFinancialSettlementMintClaim(
      db as unknown as Firestore, ADDRESS, otherTx, 'pe_b', 'agent_1', 100,
    );
    expect(a.evidence.claim.claim_id).not.toBe(b.evidence.claim.claim_id);
    expect(b.evidence.relation).toBe('owner');
  });
});
