/**
 * Genesis milestone detector tests (Part B/C/E): first-transaction (nonce),
 * sustained-activity (thresholds), exactly-once marker dedup, claim release on
 * payout failure, and the agent-facing status reader.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  scanFirstTransactions,
  scanSustainedActivity,
  getGenesisWalletStatus,
  buildFirstTxDeps,
  milestoneEventType,
  type FirstTxScanDeps,
  type SustainedScanDeps,
  type MilestoneWallet,
} from './genesis-milestones';
import { releaseSuppressedGenesisReservation, invalidateGenesisConfigCache } from './genesis-campaign';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import type { AgentBankDeps } from '../agent-bank/types';

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

const W1: MilestoneWallet = { walletId: 'w1', agentId: 'a1', address: '0xw1', createdAtMs: 1000 };
const W2: MilestoneWallet = { walletId: 'w2', agentId: 'a2', address: '0xw2', createdAtMs: 1000 };

describe('genesis-milestones', () => {
  describe('scanFirstTransactions', () => {
    function deps(
      fake: FakeFirestore,
      opts: { nonces?: Record<string, number>; payThrows?: boolean; paid?: string[] } = {},
    ): FirstTxScanDeps {
      const wallets: Record<string, MilestoneWallet> = { w1: W1, w2: W2 };
      return {
        db: db(fake),
        listFundedWalletIds: async () => ['w1', 'w2'],
        resolveWallet: async (id) => wallets[id] ?? null,
        getTransactionCount: async (addr) => (opts.nonces?.[addr] ?? 0),
        payMilestone: async (wallet) => {
          if (opts.payThrows) throw new Error('pay boom');
          opts.paid?.push(wallet.walletId);
          return { bountyPvt: 2500 };
        },
        now: () => 5000,
      };
    }

    it('emits for wallets with outbound nonce > 0 and skips the rest', async () => {
      const fake = createFakeFirestore();
      const paid: string[] = [];
      const report = await scanFirstTransactions(deps(fake, { nonces: { '0xw1': 3, '0xw2': 0 }, paid }));
      expect(report.emitted).toBe(1);
      expect(report.not_yet).toBe(1);
      expect(report.bounty_pvt_granted).toBe(2500);
      expect(paid).toEqual(['w1']);
      expect(fake.store.get('genesis_wallet_firsttx/w1')).toMatchObject({ nonce: 3 });
      expect(fake.store.get('genesis_wallet_firsttx/w2')).toBeUndefined();
    });

    it('dedups via the per-wallet marker on re-scan', async () => {
      const fake = createFakeFirestore();
      const paid: string[] = [];
      await scanFirstTransactions(deps(fake, { nonces: { '0xw1': 1 }, paid }));
      const second = await scanFirstTransactions(deps(fake, { nonces: { '0xw1': 1 }, paid }));
      expect(second.already_marked).toBeGreaterThanOrEqual(1);
      expect(paid).toEqual(['w1']); // paid once
    });

    it('releases the marker when payout fails', async () => {
      const fake = createFakeFirestore();
      const report = await scanFirstTransactions(deps(fake, { nonces: { '0xw1': 1, '0xw2': 1 }, payThrows: true }));
      expect(report.errors).toBe(2);
      expect(report.emitted).toBe(0);
      expect(fake.store.get('genesis_wallet_firsttx/w1')).toBeUndefined();
    });
  });

  describe('scanSustainedActivity', () => {
    function deps(
      fake: FakeFirestore,
      opts: { candidates?: MilestoneWallet[]; payThrows?: boolean; paid?: string[] } = {},
    ): SustainedScanDeps {
      return {
        db: db(fake),
        loadThresholds: async () => ({ minPeCount: 20, minStreakDays: 7 }),
        listSustainedCandidates: async () => opts.candidates ?? [W1],
        payMilestone: async (wallet) => {
          if (opts.payThrows) throw new Error('pay boom');
          opts.paid?.push(wallet.walletId);
          return { bountyPvt: 6000 };
        },
        now: () => 5000,
      };
    }

    it('emits for each sustained candidate once', async () => {
      const fake = createFakeFirestore();
      const paid: string[] = [];
      const report = await scanSustainedActivity(deps(fake, { candidates: [W1, W2], paid }));
      expect(report.emitted).toBe(2);
      expect(report.bounty_pvt_granted).toBe(12000);
      expect(paid).toEqual(['w1', 'w2']);
    });

    it('dedups via the sustained marker on re-scan', async () => {
      const fake = createFakeFirestore();
      const paid: string[] = [];
      await scanSustainedActivity(deps(fake, { candidates: [W1], paid }));
      const second = await scanSustainedActivity(deps(fake, { candidates: [W1], paid }));
      expect(second.already_marked).toBe(1);
      expect(paid).toEqual(['w1']);
    });

    it('releases the marker when payout fails', async () => {
      const fake = createFakeFirestore();
      const report = await scanSustainedActivity(deps(fake, { candidates: [W1], payThrows: true }));
      expect(report.errors).toBe(1);
      expect(fake.store.get('genesis_wallet_sustained/w1')).toBeUndefined();
    });
  });

  describe('identity-agnostic human path', () => {
    it('milestoneEventType emits neutral events for humans, agent-native for agents', () => {
      expect(milestoneEventType('human', 'first_transaction')).toBe('wallet_first_transaction');
      expect(milestoneEventType('human', 'sustained_activity')).toBe('wallet_sustained_activity');
      expect(milestoneEventType('agent', 'first_transaction')).toBe('agent_first_transaction');
      expect(milestoneEventType(undefined, 'sustained_activity')).toBe('agent_sustained_activity');
    });

    it('resolveWallet falls back to the unified wallets collection for a human wallet', async () => {
      const fake = createFakeFirestore();
      // A human wallet exists only in `wallets` (type human), not in agent_wallets.
      fake.store.set('wallets/human_w1', {
        type: 'human', user_id: 'user_42', address: '0xHUMAN', created_at: 1234,
      });
      const deps = buildFirstTxDeps({ db: db(fake) } as unknown as AgentBankDeps);
      const resolved = await deps.resolveWallet('human_w1');
      expect(resolved).not.toBeNull();
      // Accrual identity is the human's user_id (so PVT lands on the human ledger).
      expect(resolved?.agentId).toBe('user_42');
      expect(resolved?.ownerType).toBe('human');
      expect(resolved?.address).toBe('0xhuman');
    });

    it('resolveWallet returns null for an unknown wallet id (neither collection)', async () => {
      const fake = createFakeFirestore();
      const deps = buildFirstTxDeps({ db: db(fake) } as unknown as AgentBankDeps);
      expect(await deps.resolveWallet('nope')).toBeNull();
    });

    it('resolveWallet fails closed for a human wallet missing user_id (no misroute)', async () => {
      const fake = createFakeFirestore();
      fake.store.set('wallets/human_nouid', { type: 'human', address: '0xX', created_at: 1 });
      const deps = buildFirstTxDeps({ db: db(fake) } as unknown as AgentBankDeps);
      expect(await deps.resolveWallet('human_nouid')).toBeNull();
    });

    it('resolveFirstTxFloor lazily fences a human wallet (no-retro): establishes baseline, then earns only on growth', async () => {
      const fake = createFakeFirestore();
      const deps = buildFirstTxDeps({ db: db(fake) } as unknown as AgentBankDeps);
      const imported: MilestoneWallet = { walletId: 'human_imp', agentId: 'user_imp', address: '0ximp', createdAtMs: 1, ownerType: 'human' };
      // First sighting of an IMPORTED wallet with prior history (nonce 50): pins
      // the baseline and returns null (reward nothing - no retroactive mint).
      expect(await deps.resolveFirstTxFloor!(imported, 50)).toBeNull();
      expect(fake.store.get('genesis_firsttx_baseline/human_imp')).toMatchObject({ baseline_nonce: 50 });
      // Later rounds: floor is the pinned baseline, so only nonce growth past 50 earns.
      expect(await deps.resolveFirstTxFloor!(imported, 51)).toBe(50);
    });

    it('scanFirstTransactions fences a human via the floor: nothing the establishing round, then earns', async () => {
      const fake = createFakeFirestore();
      const paid: string[] = [];
      const human: MilestoneWallet = { walletId: 'h1', agentId: 'u1', address: '0xh1', createdAtMs: 1, ownerType: 'human' };
      // Lazy floor: null on first sighting, then the pinned baseline (1) after.
      let established = false;
      const baseDeps: FirstTxScanDeps = {
        db: db(fake),
        listFundedWalletIds: async () => ['h1'],
        resolveWallet: async () => human,
        getTransactionCount: async () => 2, // imported wallet already has 2 prior txs
        resolveFirstTxFloor: async () => {
          if (!established) { established = true; return null; }
          return 2; // baseline pinned at its prior nonce
        },
        payMilestone: async (w) => { paid.push(w.walletId); return { bountyPvt: 2500 }; },
        now: () => 5000,
      };
      const first = await scanFirstTransactions(baseDeps);
      expect(first.emitted).toBe(0); // establishing round pays nothing (no retro)
      expect(paid).toEqual([]);
      const second = await scanFirstTransactions(baseDeps);
      expect(second.not_yet).toBe(1); // nonce 2 is NOT > floor 2 - prior history never earns
      expect(paid).toEqual([]);
    });
  });

  describe('getGenesisWalletStatus (cutover reconciliation v3 legacy-record projection)', () => {
    // The legacy campaign config cache must never leak between cases (other
    // suites in this file arm it); the v3 projection itself reads no config.
    beforeEach(() => invalidateGenesisConfigCache());

    it('reports ONLY the legacy issuance record + PVT9 posture — no ladder, pool, or next-step fields exist', async () => {
      const fake = createFakeFirestore();
      fake.store.set('genesis_wallet_funding/w1', { count: 1, first_at: 1, last_at: 1 });
      fake.store.set('genesis_wallet_ledger/w1', { issued_pvt: 1500, updated_at: 1 });

      const status = await getGenesisWalletStatus(db(fake), 'w1');
      // The posture is sourced from the campaign manifest (armed,) + the activation
      // doc, NOT the runtime boundary generated config. Old code read PVT9_BASE_CONFIG.genesis (always
      // false), so genesis_armed:true here is RED against the pre-fix source. Window dates
      // bind to the manifest source, never a redeclared literal. grants_live is
      // false because the fake store carries no signed pvt_policy_activations/genesis doc.
      expect(status).toEqual({
        wallet_id: 'w1',
        schema: 'genesis-wallet-status/v3-legacy-record',
        legacy_record_only: true,
        genesis_pvt_earned_record: 1500,
        pvt9: {
          genesis_armed: true,
          genesis_window_approved: true,
          genesis_grants_live: false,
          genesis_window: {
            start_ms: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms,
            end_ms: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms,
          },
        },
      });
      // The retirement is DELETION, not zeroing: none of the legacy fields can
      // be re-presented as PVT9 state (plan cutover reconciliation item 5).
      const raw = status as unknown as Record<string, unknown>;
      for (const retired of [
        'funded', 'first_transaction', 'sustained_activity', 'next_milestone', 'campaign',
        'genesis_pvt_earned',
      ]) {
        expect(retired in raw).toBe(false);
      }
    });

    it('an armed LEGACY campaign config changes nothing — the projection never advertises window/pool/bounty state', async () => {
      const fake = createFakeFirestore();
      fake.store.set('pvt_config/genesis_campaign', {
        enabled: true,
        window_start_ms: 0,
        window_end_ms: 0,
        pool_cap_pvt: 1_000_000,
        per_epoch_mint_cap_pvt: 250_000,
        per_wallet_cap_pvt: 500,
        per_source_cap_pvt: 10_000,
        bounties: { genesis_signup: 75, genesis_human_signup: 75 },
      });
      fake.store.set('genesis_campaign_state/global', { pool_minted_pvt: 0 });

      const status = await getGenesisWalletStatus(db(fake), 'wAgent');
      expect(status.legacy_record_only).toBe(true);
      expect(status.genesis_pvt_earned_record).toBe(0);
      // genesis_armed reflects the campaign MANIFEST (armed), not this legacy campaign
      // config — which is the point: the legacy config still advertises no window/pool/
      // bounty state through the projection.
      expect(status.pvt9.genesis_armed).toBe(true);
      expect('campaign' in (status as unknown as Record<string, unknown>)).toBe(false);
      expect('next_milestone' in (status as unknown as Record<string, unknown>)).toBe(false);
    });

    // Q3/C6 (2026-07-26): the release is refused — the pool counter is
    // monotonic — so the record keeps showing the reserved amount. This
    // replaces the previous "reflects accrued (0) after release" case.
    it('keeps showing the RESERVED amount, because the release is refused (#27, Q3/C6)', async () => {
      const fake = createFakeFirestore();
      // A funded wallet whose 300-PVT genesis reservation LANDED in the ledger
      // (issued_pvt is exactly the surface getGenesisWalletStatus reads for
      // genesis_pvt_earned_record).
      fake.store.set('genesis_wallet_funding/w1', { count: 1, first_at: 1, last_at: 1 });
      fake.store.set('genesis_wallet_ledger/w1', { issued_pvt: 300, updated_at: 1 });
      fake.store.set('genesis_campaign_state/global', { pool_minted_pvt: 300, updated_at: 1 });

      const before = await getGenesisWalletStatus(db(fake), 'w1');
      expect(before.genesis_pvt_earned_record).toBe(300);

      // The PE's accrual was suppressed (rate-limit / Redis-down). The release
      // that used to follow is now refused.
      const released = await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true,
        isGenesisGrant: true,
        reservedPvt: 300,
        walletId: 'w1',
        now: 5000,
      });
      expect(released).toBe(false);

      // The ledger is untouched, so the record is unchanged. The wallet's cap
      // stays consumed: the campaign under-grants rather than reopening a cap.
      const after = await getGenesisWalletStatus(db(fake), 'w1');
      expect(after.genesis_pvt_earned_record).toBe(300);
      expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 300 });
    });
  });
});
