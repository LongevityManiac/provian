/**
 * Pass-2 #38 regression: the human's Delegation PE must show the agent's
 * `display_name`, not the raw opaque id.
 *
 * The prior inline resolver queried `agent_wallets.where('wallet_id' == userId)`
 * (no such field - wallet_id IS the doc id) and read `.data().name` (no such
 * field), so `agentName` always fell back to the opaque userId. The fix mirrors
 * resolveBeneficiary: agent_id query first, doc-id fallback, reading
 * `display_name`.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveAgentDisplayName } from './pvt-accrual';
import type { Firestore } from 'firebase-admin/firestore';

interface WalletData {
  agent_id?: string;
  display_name?: string;
}

/**
 * Minimal in-memory agent_wallets stub. `byAgentId` keys the `.where('agent_id')`
 * query; `byDocId` keys the `.doc(id)` fallback. A query for a missing agent_id
 * returns empty; a doc fetch for a missing id returns exists:false.
 */
function makeDb(opts: {
  byAgentId?: Record<string, WalletData>;
  byDocId?: Record<string, WalletData>;
}): Firestore {
  const byAgentId = opts.byAgentId ?? {};
  const byDocId = opts.byDocId ?? {};
  return {
    collection(name: string) {
      if (name !== 'agent_wallets') throw new Error(`unexpected collection ${name}`);
      return {
        where(_field: string, _op: string, value: string) {
          const match = byAgentId[value];
          return {
            limit() {
              return {
                async get() {
                  return match
                    ? { empty: false, docs: [{ data: () => match }] }
                    : { empty: true, docs: [] };
                },
              };
            },
          };
        },
        doc(id: string) {
          return {
            async get() {
              const data = byDocId[id];
              return { exists: data !== undefined, data: () => data };
            },
          };
        },
      };
    },
  } as unknown as Firestore;
}

describe('resolveAgentDisplayName (Pass-2 #38)', () => {
  it('resolves display_name via the agent_id query (session PE path)', async () => {
    const db = makeDb({ byAgentId: { 'agent-atlas': { display_name: 'Atlas' } } });
    expect(await resolveAgentDisplayName(db, 'agent-atlas')).toBe('Atlas');
  });

  it('resolves display_name via the doc-id fallback (device PE path)', async () => {
    const db = makeDb({ byDocId: { 'wallet_aw_123': { display_name: 'Atlas' } } });
    expect(await resolveAgentDisplayName(db, 'wallet_aw_123')).toBe('Atlas');
  });

  it('falls back to the userId when no agent wallet matches', async () => {
    const db = makeDb({});
    expect(await resolveAgentDisplayName(db, 'wallet_aw_missing')).toBe('wallet_aw_missing');
  });

  it('falls back to the userId when the doc exists but has no display_name', async () => {
    // Exactly the prior-bug shape: a real doc whose `name` field does not exist.
    const db = makeDb({ byDocId: { 'wallet_aw_x': { agent_id: 'agent-x' } } });
    expect(await resolveAgentDisplayName(db, 'wallet_aw_x')).toBe('wallet_aw_x');
  });

  it('never reads a `wallet_id` field or a `name` field (regression guard)', async () => {
    // The doc carries the OLD field names only; the resolver must ignore them
    // and fall back, proving it no longer reads `.name`.
    const db = makeDb({
      byDocId: { 'wallet_aw_legacy': { display_name: undefined, ...( { name: 'ShouldBeIgnored', wallet_id: 'x' } as object ) } },
    });
    expect(await resolveAgentDisplayName(db, 'wallet_aw_legacy')).toBe('wallet_aw_legacy');
  });
});
