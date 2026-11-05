/**
 * READ-ONLY audit (no writes, no flags): count published PE projections and how
 * many expose a counterparty.
 *
 * Context: while the #33 mutual-consent gate was inert (it read
 * pe_history.counterparty_address, an always-undefined envelope-only field), a
 * counterparty projection could in principle have been published without consent.
 * BUT code analysis shows publishPE — the ONLY writer to commons_published_pes —
 * threw NotFound for every PE since the original Commons commit (`.where('id')`
 * on pe_history, which has no `id` field), so nothing could ever be published.
 * This script confirms that empirically against production data.
 *
 * Expected result: total=0. Any projection with counterparty_wallet_id != null is
 * one to review for retraction. This script ONLY reports — it never deletes.
 *
 * Usage: tsx scripts/audit-published-counterparties.ts
 */

import admin from 'firebase-admin';
import { COMMONS_COLLECTIONS } from '../src/core/commons/types';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function main(): Promise<void> {
  const snap = await db.collection(COMMONS_COLLECTIONS.PUBLISHED_PES).get();
  const total = snap.size;
  const withCounterparty = snap.docs.filter((d) => {
    const cp = (d.data() as { counterparty_wallet_id?: unknown }).counterparty_wallet_id;
    return typeof cp === 'string' && cp.length > 0;
  });

  console.log(`[audit] commons_published_pes total projections = ${total}`);
  console.log(`[audit] projections exposing a counterparty = ${withCounterparty.length}`);
  if (withCounterparty.length > 0) {
    console.log('[audit] counterparty projections (for review — NO action taken):');
    for (const d of withCounterparty) {
      const p = d.data() as { pe_id?: string; published_by?: string; counterparty_wallet_id?: string };
      console.log(`  - pe_id=${p.pe_id} published_by=${p.published_by} counterparty=${p.counterparty_wallet_id}`);
    }
  } else {
    console.log('[audit] None. Consistent with publishPE never having succeeded — nothing to retract.');
  }
}

main().catch((err) => {
  console.error('[audit] failed:', err);
  process.exit(1);
});
