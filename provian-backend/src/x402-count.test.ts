/**
 * WS7: x402_payment_count must increment on the SOVEREIGN agent wallet that
 * made the payment, resolved by the on-chain payer address (EIP-3009 signer) -
 * NOT by the human owner's user_id (the x402 PE is ingested on the human
 * session path).
 */

import { ethers } from 'ethers';
import { incrementX402PaymentCount } from './pvt-accrual';

function makeDb(walletData?: Record<string, unknown>) {
  const update = jest.fn().mockResolvedValue(undefined);
  const docs = walletData ? [{ ref: { update }, data: () => walletData }] : [];
  const query = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue({ empty: docs.length === 0, docs }),
  };
  const db = { collection: jest.fn().mockReturnValue(query) };
  return { db, query, update };
}

describe('incrementX402PaymentCount (WS7)', () => {
  const addr = ethers.Wallet.createRandom().address; // checksummed

  it('queries the LOWERCASE stored address (agent_wallets.address is stored lowercase)', async () => {
    const { db, query, update } = makeDb({ platform: 'sdk' });
    // Pass a checksummed payer; the helper validates then LOWERCASES for the
    // byte-exact Firestore query (querying the checksummed form would 404 the
    // wallet — the bug this guards).
    await incrementX402PaymentCount(db as never, addr);
    expect(query.where).toHaveBeenCalledWith('address', '==', addr.toLowerCase());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toHaveProperty('x402_payment_count');
  });

  it('matches a lowercase-stored wallet end-to-end (filter-honoring db) — credit actually lands', async () => {
    // A realistic db that honors the address filter byte-exactly, like Firestore.
    const update = jest.fn().mockResolvedValue(undefined);
    const stored = { address: addr.toLowerCase(), platform: 'sdk' };
    let queried: unknown;
    const query: Record<string, unknown> = {
      where: jest.fn((f: string, _o: string, v: unknown) => {
        if (f === 'address') queried = v;
        return query;
      }),
      limit: jest.fn(() => query),
      get: jest.fn(async () => {
        const match = stored.address === queried;
        return { empty: !match, docs: match ? [{ ref: { update }, data: () => stored }] : [] };
      }),
    };
    const db = { collection: jest.fn(() => query) };
    await incrementX402PaymentCount(db as never, addr); // checksummed input
    // The credit lands precisely because the helper queried the lowercase form.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips test-platform wallets (no badge farming via smoke-test agents)', async () => {
    const { db, update } = makeDb({ platform: 'test' });
    await incrementX402PaymentCount(db as never, addr);
    expect(update).not.toHaveBeenCalled();
  });

  it('no-ops when no agent wallet matches the payer address', async () => {
    const { db, update } = makeDb(undefined);
    await incrementX402PaymentCount(db as never, addr);
    expect(update).not.toHaveBeenCalled();
  });

  it('no-ops (and does not query) on an invalid payer address', async () => {
    const { db } = makeDb({ platform: 'sdk' });
    await incrementX402PaymentCount(db as never, 'not-an-address');
    expect(db.collection).not.toHaveBeenCalled();
  });
});
