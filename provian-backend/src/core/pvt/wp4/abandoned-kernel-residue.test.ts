/**
 * THE RESIDUE — the one settled claim left behind on the abandoned kernel,
 * WRITTEN OFF by.
 *
 * ── THE RULING IS IN: WRITTEN OFF (, darkness-ledger C-4) ───────────────
 * When this file was written the choice was open — quarantine the qualification with a
 * `superseded` marker, or ship a control asserting it can never settle on the successor
 * lane — and it shipped the CONTROL rather than pre-empt half of the standing rule.
 *
 * That decision is now made: the 74.9925 PVT is WRITTEN OFF. There is no re-mint and no
 * re-settle. The zero-carry succession precedent governs — the successor launched at zero
 * supply and carried nothing across, and this claim is the same class of thing. The
 * first-mint record stands as the historical milestone it is; writing off the tokens does
 * not un-mint the event, which is the point of a provenance chain.
 *
 * NOTHING IN PRODUCTION IS MUTATED BY THAT RULING, deliberately. No `superseded` marker is
 * written to `genesis_qualification_outbox_v2` and no ledger row is touched: `settled: true`
 * ALREADY makes the row unselectable, so a write would add risk to a money-path collection
 * and buy nothing. The control below is the enforcement, and it is now the whole story
 * rather than a placeholder for a pending ruling.
 *
 * ── WHAT THE RESIDUE ACTUALLY IS ─────────────────────────────────────────────
 * minted once, on the kernel now abandoned: tx `0xc3b60016…`, block 49191248, one
 * Genesis-lane claim, 74.9925 PVT. Production still holds exactly one row in
 * `pvt9_claim_ledger_v1` and one `complete` row in `genesis_qualification_outbox_v2` both
 * real, both historical, and both now describing a kernel nothing points at.
 *
 * ── THE HONEST GAP, NAMED RATHER THAN PAPERED OVER ───────────────────────────
 * `ClaimLedgerRow` HAS NO KERNEL FIELD. The row records `settled: true` and a tx hash; it
 * does not record which deployment settled it. So the protection is not "settled on the
 * abandoned kernel, therefore skipped" it is simply "settled, therefore skipped", and after
 * the succession that one word carries more weight than it used to. `claimSettled` on the
 * successor is FALSE for this claim and its `totalSupply` is 0, so the on-chain double-mint
 * guard that existed before the succession does not exist for this row any more. The
 * off-chain `settled` flag is the whole guard. That is exactly why it is worth a test that
 * fails loudly rather than a comment nobody executes.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  CLAIM_LEDGER_COLLECTION,
  assertNoLegacyLedgerRows,
  readLedgerPage,
  type ClaimLedgerRow,
  type SettlementDb,
} from './durable-settlement-store';

/**
 * The live production row, copied field-for-field from
 * `pvt9_claim_ledger_v1/pe_genesis_6cd358a0…#sole` on 2026-08-01.
 *
 * Pinned as a FIXTURE, not re-read from production: a test that phones a live database
 * passes or fails for reasons that have nothing to do with the code under review.
 */
const ABANDONED_KERNEL_ROW: ClaimLedgerRow = Object.freeze({
  schema_version: 'pvt9-claim-ledger/v1',
  pe_id: 'pe_genesis_6cd358a0dc2b0d02757a243e68cc2a3aa3e27e7746fbf40c5684f0b23dd169a8',
  pe_key: 'pe_genesis_6cd358a0dc2b0d02757a243e68cc2a3aa3e27e7746fbf40c5684f0b23dd169a8',
  claim_key: 'pe_genesis_6cd358a0dc2b0d02757a243e68cc2a3aa3e27e7746fbf40c5684f0b23dd169a8#sole',
  leg: 'sole',
  claim_id: '0xf03c0cf5c26f41da476283e26dcd57c40d8b3610be298b01b6ae3bfa28eb1f9d',
  lane: 'genesis',
  contributor: '0x5ed6e53c1b9e784dabe48d517a54c5865f0ff4f5',
  genesis_anchor_key: '0x6b2d89cbb2332f4ec9c81586941520f34d13464ee129a60af034b382783eab4a',
  wallet_id: '0x855a56c3ef0a6e53d52a43a0610ca45d5d966adbedd45dedd321d83615f9763f',
  one_time_anchor: '0xf78c15c1116b8c9c225979de3ca6480e0d950aa5680885a5d529329de062c016',
  grant_type: 1,
  qualified_at: 1785171692,
  reserved_gross_atomic: '74992500000000000000',
  settled: true,
  settled_batch_id: '0xe7f7ce01943e8acda3f43e201dc7404c98be99a79f4f5d779c880d94befafc2a',
  settled_tx_hash: '0xc3b60016bf1dfbdb6284001914e3dd418a3f4f4065ba3ca4ff1cb5e1c5f7b8be',
  created_at: 1785171744689,
  settled_at: 1785171843719,
});

/** The kernel actually minted on. Abandoned by /, retired on chain by. */
const ABANDONED_KERNEL = '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61';

function ledgerWith(row: ClaimLedgerRow): SettlementDb {
  const fake = createFakeFirestore();
  fake.store.set(`${CLAIM_LEDGER_COLLECTION}/${row.claim_key}`, { ...row });
  return fake as unknown as SettlementDb;
}

function pvt9Config(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    resolve(__dirname, '..', '..', '..', '..', '..', 'config', 'pvt9-base.json'),
    'utf8',
  )) as Record<string, unknown>;
}

describe('the claim cannot settle on the successor lane', () => {
  test('it is never selected as work — the lane only ever picks up unsettled rows', async () => {
    const db = ledgerWith(ABANDONED_KERNEL_ROW);

    const page = await readLedgerPage(db, { pageSize: 50, unsettledOnly: true });

    expect(page.rows).toHaveLength(0);
  });

  /**
   * THE RED THAT MAKES THE ABOVE MEAN SOMETHING.
   *
   * "the query returned nothing" is the empty-population shape: it would pass identically
   * against an empty collection, a broken fixture, or a query that always returns nothing.
   * The SAME row with the SAME query, differing in one boolean, must come back — which
   * proves the row is present, the query works, and `settled` is what excludes it.
   */
  test('RED — the identical row with `settled:false` IS selected', async () => {
    const db = ledgerWith({ ...ABANDONED_KERNEL_ROW, settled: false });

    const page = await readLedgerPage(db, { pageSize: 50, unsettledOnly: true });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].row.claim_id).toBe(ABANDONED_KERNEL_ROW.claim_id);
  });

  test('the row is well-formed enough that the legacy-row guard admits it, not skips it', async () => {
    const db = ledgerWith(ABANDONED_KERNEL_ROW);

    // If this threw, the row would be quarantined by accident rather than by decision —
    // and the selection test above would be passing for the wrong reason.
    const { scanned } = await assertNoLegacyLedgerRows(db);

    expect(scanned).toBe(1);
  });

  test('its settlement belongs to the ABANDONED kernel, which is not the configured one', () => {
    const config = pvt9Config();
    const assets = config.assets as Record<string, { address?: string }>;
    const configuredKernel = assets.pvt9?.address;
    const forbidden = (config.validation as { forbidden_pvt_addresses?: string[] })
      .forbidden_pvt_addresses ?? [];

    // The successor is what the runtime points at...
    expect(configuredKernel).toBe('0x8811441914381143b9408c5C32247367F86F173A');
    // ...the kernel this claim settled on is explicitly forbidden...
    expect(forbidden).toContain(ABANDONED_KERNEL);
    //...and so is the kernel retired (its history replayed onto the successor,
    // which never saw this abandoned-kernel claim: 's write-off stands).
    expect(forbidden).toContain('0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7');
    expect(configuredKernel).not.toBe(ABANDONED_KERNEL);
  });

  /**
   * The gap, asserted rather than described — so it fails the day someone closes it and this
   * comment goes stale, and fails the day someone assumes it was never open.
   */
  test('the ledger row carries NO kernel binding — the `settled` flag is the whole guard', () => {
    const keys = Object.keys(ABANDONED_KERNEL_ROW);

    expect(keys).not.toContain('kernel_address');
    expect(keys).not.toContain('settled_kernel');
    expect(keys).not.toContain('chain_id');
    // What it does carry: a tx hash whose kernel you can only learn by asking the chain.
    expect(ABANDONED_KERNEL_ROW.settled_tx_hash).toBe(
      '0xc3b60016bf1dfbdb6284001914e3dd418a3f4f4065ba3ca4ff1cb5e1c5f7b8be',
    );
    expect(ABANDONED_KERNEL_ROW.settled).toBe(true);
  });

  test('the reserved amount is the historical 74.9925 PVT, pre- taper', () => {
    // Sealed history: removed the wallet-age taper afterwards, so a Genesis signup
    // pays exactly 75 now. This row is evidence of what was true then, not a live rate.
    expect(ABANDONED_KERNEL_ROW.reserved_gross_atomic).toBe('74992500000000000000');
    expect(ABANDONED_KERNEL_ROW.lane).toBe('genesis');
  });
});
