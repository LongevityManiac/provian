import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { prepareX402TxMintClaim, x402ClaimDocId } from './x402-tx-mint-claim';

const PAYER = '0xaaaa000000000000000000000000000000000001';
const TX = `0x${'d'.repeat(64)}`;

describe('prepared x402 mint-once claim', () => {
  it('has a stable case-insensitive key and preparation makes no write', async () => {
    expect(x402ClaimDocId(PAYER, TX)).toBe(
      x402ClaimDocId(PAYER.toUpperCase().replace('0X', '0x'), TX.toUpperCase().replace('0X', '0x')),
    );
    const db = createFakeFirestore();
    const plan = await prepareX402TxMintClaim(
      db as unknown as Firestore,
      PAYER,
      TX,
      'pe_watcher',
      'agent_1',
      100,
    );
    expect(plan.evidence).toMatchObject({
      relation: 'owner',
      claim: {
        claim_kind: 'x402',
        subject_id: PAYER,
        event_id: TX,
        owner_pe_id: 'pe_watcher',
      },
    });
    expect(db.store.get(`x402_tx_mint_claims/${x402ClaimDocId(PAYER, TX)}`))
      .toBeUndefined();
  });

  it('rejects malformed payer and transaction identities before any write', async () => {
    const db = createFakeFirestore();
    await expect(prepareX402TxMintClaim(
      db as unknown as Firestore,
      'not-an-address',
      TX,
      'pe_bad_payer',
      'agent_1',
      100,
    )).rejects.toThrow('mint_once_claim_x402_binding_invalid');
    await expect(prepareX402TxMintClaim(
      db as unknown as Firestore,
      PAYER,
      '0xdeadbeef',
      'pe_bad_tx',
      'agent_1',
      100,
    )).rejects.toThrow('mint_once_claim_x402_binding_invalid');
    expect([...db.store.keys()].filter((key) => key.startsWith('x402_tx_mint_claims/')))
      .toHaveLength(0);
  });
});
