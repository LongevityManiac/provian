/**
 * getHumanJobEscrowFunding must return the on-chain fields a human poster
 * needs to build the approve + createEscrow + fundEscrow sequence — the SAME
 * values the relay's verifyFunding binds. A field swap (recipient↔depositor) or a
 * dropped field would make the app build a tx that never verifies, so this pins
 * each field to a DISTINCT value and RED-controls the poster gate + currency branch.
 */
import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { getHumanJobEscrowFunding } from './human-jobs';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const POSTER = 'wallet_poster';
const STRANGER = 'wallet_stranger';
// Distinct, so a recipient↔depositor swap in the passthrough is detectable.
const DEPOSITOR_ADDR = '0x1111111111111111111111111111111111111111';
const RECIPIENT_ADDR = '0x2222222222222222222222222222222222222222';
const BASE_INSTITUTIONS_ESCROW_V4 = '0x96560fDF49e563eFCdc2d502934676DC074732d0';
const PVT9_KERNEL_LOWER = '0x8811441914381143b9408c5c32247367f86f173a';
const AUTO_RELEASE_MS = 1_800_000_000_000;
const ORIGINAL_ENV = { ...process.env };

function makeDeps(db: FakeFirestore): CommonsDeps {
  return { db } as unknown as CommonsDeps;
}

function seed(db: FakeFirestore, currency: 'pvt' | 'usdc'): void {
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
    job_id: 'hjob1',
    poster_wallet_id: POSTER,
    escrow_id: 'esc_1',
  });
  db.store.set('escrows/esc_1', {
    escrow_id: 'esc_1',
    currency,
    chain: 'base',
    status: 'created',
    depositor_address: DEPOSITOR_ADDR,
    recipient_address: RECIPIENT_ADDR,
    amount_pvt: '1000000000000000000',
    amount_usdc: 5,
    auto_release_at: AUTO_RELEASE_MS,
  });
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    ENABLE_PVT_PRINCIPAL: 'true',
    // The V3 USDC escrow address, so the USDC currency-branch control can resolve
    // its contract (PVT resolves from the canonical pvt-principal config, no env).
    ESCROW_CONTRACT_ADDRESS_BASE: '0x00000000000000000000000000000000000000e5',
  };
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('getHumanJobEscrowFunding (on-chain fields)', () => {
  it('returns the escrow fields the app needs, each mapped to the RIGHT field', async () => {
    const db = createFakeFirestore();
    seed(db, 'pvt');
    const funding = await getHumanJobEscrowFunding(makeDeps(db), POSTER, 'hjob1');

    expect(funding.currency).toBe('pvt');
    expect(funding.contract_address).toBe(BASE_INSTITUTIONS_ESCROW_V4);
    expect(funding.amount_pvt).toBe('1000000000000000000');
    // Distinct values: recipient is the RECIPIENT, depositor is the DEPOSITOR — not swapped.
    expect(funding.recipient_address).toBe(RECIPIENT_ADDR);
    expect(funding.depositor_address).toBe(DEPOSITOR_ADDR);
    expect(funding.recipient_address).not.toBe(funding.depositor_address);
    expect(funding.auto_release_at).toBe(AUTO_RELEASE_MS);
    expect(funding.chain).toBe('base');
    // token_address is the canonical PVT9 kernel — the ERC-20 the poster approves.
    expect(funding.token_address).toBe(PVT9_KERNEL_LOWER);
  });

  it('CONTROL: a USDC escrow hands out the canonical USDC token, never the PVT kernel (currency branch,)', async () => {
    const db = createFakeFirestore();
    seed(db, 'usdc');
    const funding = await getHumanJobEscrowFunding(makeDeps(db), POSTER, 'hjob1');
    expect(funding.currency).toBe('usdc');
    // USDC hires are funded in-app, so the poster needs the USDC ERC-20 to approve.
    expect(funding.token_address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(funding.token_address).not.toBe(PVT9_KERNEL_LOWER);
    expect(funding.amount_pvt).toBeUndefined();
    expect(funding.amount_usdc).toBe(5);
  });

  it('the hired participant can read the escrow (funding stays poster-only)', async () => {
    const db = createFakeFirestore();
    seed(db, 'pvt');
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
      job_id: 'hjob1', poster_wallet_id: POSTER, accepted_applicant_wallet_id: 'wallet_aw_hired', escrow_id: 'esc_1',
    });
    const funding = await getHumanJobEscrowFunding(makeDeps(db), 'wallet_aw_hired', 'hjob1');
    expect(funding.escrow_id).toBe('esc_1');
    expect(funding.onchain_escrow_id).toBeNull();
    await expect(getHumanJobEscrowFunding(makeDeps(db), STRANGER, 'hjob1')).rejects.toThrow(/poster or the hired/);
  });

  it('RED: a non-poster caller is refused (poster-only)', async () => {
    const db = createFakeFirestore();
    seed(db, 'pvt');
    await expect(getHumanJobEscrowFunding(makeDeps(db), STRANGER, 'hjob1')).rejects.toThrow(/poster/i);
  });

  it('RED: a job with no escrow yet is rejected', async () => {
    const db = createFakeFirestore();
    db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob2`, {
      job_id: 'hjob2',
      poster_wallet_id: POSTER,
    });
    await expect(getHumanJobEscrowFunding(makeDeps(db), POSTER, 'hjob2')).rejects.toThrow(/escrow/i);
  });
});
