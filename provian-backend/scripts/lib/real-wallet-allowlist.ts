/**
 * Shared allowlist resolver for the network-stats consignment scripts
 * (mark-test-wallets.ts, rebuild-network-pe-counters.ts).
 *
 * The allowlist names the REAL wallets — everything else is test data by
 * the invariant: . Entries may be wallet doc ids
 * (exact match) or 0x addresses (case-insensitive). Resolution is
 * fail-closed: an entry matching zero docs aborts (typo protection — an
 * empty allowlist would consign the real wallet too), and an address
 * matching more than one doc aborts (demand the unambiguous doc id).
 */

import type admin from 'firebase-admin';

/** the operator’s real human wallet — the single allowlisted default. */
export const DEFAULT_REAL_WALLETS = ['0xe326648bdf12a802c8b811037c527ada833f5d77'];

export interface WalletRow {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

export interface ResolvedAllowlist {
  /** wallets doc ids that are REAL. */
  realWalletIds: Set<string>;
  /** every id a real wallet owns: doc id, user_id, agent_id. */
  realIdSet: Set<string>;
  /** the full wallets scan, reused by callers. */
  allWallets: WalletRow[];
}

export function parseAllowlistArgs(argv: string[]): { entries: string[]; apply: boolean; syncAgentWallets: boolean } {
  let entries: string[] = [...DEFAULT_REAL_WALLETS];
  let apply = false;
  let syncAgentWallets = false;
  for (const a of argv.slice(2)) {
    if (a === '--apply') apply = true;
    else if (a === '--sync-agent-wallets') syncAgentWallets = true;
    else if (a.startsWith('--real=')) {
      entries = a.slice('--real='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--real-file=')) {
      const { readFileSync } = require('fs') as typeof import('fs');
      entries = readFileSync(a.slice('--real-file='.length), 'utf8')
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (entries.length === 0) {
    throw new Error('Allowlist resolved to zero entries — refusing (this would consign every wallet).');
  }
  return { entries, apply, syncAgentWallets };
}

export async function resolveAllowlist(
  db: admin.firestore.Firestore,
  entries: string[],
): Promise<ResolvedAllowlist> {
  const snapshot = await db.collection('wallets').get();
  const allWallets: WalletRow[] = snapshot.docs.map((d) => ({ id: d.id, data: d.data() }));

  const realWalletIds = new Set<string>();
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const byId = allWallets.filter((w) => w.id === entry);
    const byAddress = allWallets.filter(
      (w) => typeof w.data.address === 'string' && w.data.address.toLowerCase() === lower,
    );
    const matches = byId.length > 0 ? byId : byAddress;
    if (matches.length === 0) {
      throw new Error(`Allowlist entry matched NO wallets doc: ${entry} — aborting (fail-closed).`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Allowlist address matched ${matches.length} wallets docs: ${entry} — pass the doc id instead.`,
      );
    }
    realWalletIds.add(matches[0]!.id);
  }

  const realIdSet = new Set<string>();
  for (const w of allWallets) {
    if (!realWalletIds.has(w.id)) continue;
    realIdSet.add(w.id);
    if (typeof w.data.user_id === 'string' && w.data.user_id) realIdSet.add(w.data.user_id);
    if (typeof w.data.agent_id === 'string' && w.data.agent_id) realIdSet.add(w.data.agent_id);
  }

  return { realWalletIds, realIdSet, allWallets };
}
