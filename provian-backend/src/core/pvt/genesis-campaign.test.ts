/**
 * Genesis campaign safety-rails tests (Phase 0).
 *
 * Covers the kill switch, window, real-deposit gate, hybrid throttle
 * (externalMultiplier), decay, global pool cap, per-wallet cap, per-source
 * cap, transactional metering, rollback, and the fail-closed config loader
 * (including the deploy-level force-off).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  reserveGenesisIssuance,
  rollbackGenesisIssuance,
  releaseSuppressedGenesisReservation,
  confirmGenesisPendingCacheReReserve,
  reserveGenesisEpochMintBudget,
  rollbackGenesisEpochMintBudget,
  getGenesisEpochMintState,
  getGenesisCampaignState,
  isGenesisScanActive,
  isGenesisBountyPayable,
  resolveGenesisBaseBounty,
  loadGenesisCampaignConfig,
  invalidateGenesisConfigCache,
  canonicalBountyKey,
  isRetiredGenesisBounty,
  isFundedEvent,
  DEFAULT_GENESIS_CONFIG,
  type GenesisCampaignConfig,
} from './genesis-campaign';

function cfg(overrides: Partial<GenesisCampaignConfig> = {}): GenesisCampaignConfig {
  return {
    enabled: true,
    window_start_ms: 0,
    window_end_ms: 0,
    pool_cap_pvt: 100,
    per_epoch_mint_cap_pvt: 10,
    per_wallet_cap_pvt: 100,
    per_source_cap_pvt: 100,
    funding_min_usd: 5,
    bounties: {
      agent_wallet_created: 0.1,
      genesis_signup: 3,
      genesis_human_signup: 3,
      genesis_device_link: 2,
      agent_wallet_funded: 1,
      agent_first_transaction: 1,
      agent_sustained_activity: 5,
    },
    decay: { mode: 'none' },
    sustained: { min_pe_count: 20, min_streak_days: 7 },
    ...overrides,
  };
}

const NOW = 1_000_000;

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

describe('genesis-campaign safety rails', () => {
  beforeEach(() => {
    delete process.env.GENESIS_CAMPAIGN_FORCE_OFF;
    invalidateGenesisConfigCache();
  });

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  describe('decay is REMOVED (time-based, pool depletion)', () => {
    it('the multiplier function itself is gone — no export prices by pool fill or age', () => {
      // deleted `computeGenesisDecayMultiplier` outright. A stored
      // config cannot resurrect any taper: the only selectable mode is 'none'.
      const campaignModule = jest.requireActual<Record<string, unknown>>('./genesis-campaign');
      expect(campaignModule.computeGenesisDecayMultiplier).toBeUndefined();
    });

    it('a stale stored decay mode is ignored — mergeConfig coerces to none', async () => {
      // Legacy Firestore docs may still carry 'pool_depletion' / 'wallet_age' /
      // 'both'. None of them may select a taper; the merged config is 'none'.
      const fake = createFakeFirestore();
      fake.store.set('pvt_config/genesis_campaign', {
        enabled: true,
        decay: { mode: 'pool_depletion', floor: 0.1 },
      });
      invalidateGenesisConfigCache();
      const merged = await loadGenesisCampaignConfig(db(fake));
      expect(merged.decay).toEqual({ mode: 'none' });
    });
  });

  it('resolveGenesisBaseBounty reads the ladder and floors at 0', () => {
    const c = cfg();
    expect(resolveGenesisBaseBounty(c, 'agent_wallet_created')).toBe(0.1);
    expect(resolveGenesisBaseBounty(c, 'genesis_signup')).toBe(3);
  });

  // -------------------------------------------------------------------------
  // The retired sustained-activity slot — the path that granted 200 PVT on
  // 2026-06-24. Closed in code, not by config.
  // -------------------------------------------------------------------------

  describe('retired bounty slots', () => {
    it('resolves to 0 even when the ladder carries a NON-ZERO value', () => {
      // The fixture ladder really does arm it — so 0 below is the code
      // refusing, not an empty config.
      const c = cfg();
      expect(c.bounties.agent_sustained_activity).toBe(5);
      expect(resolveGenesisBaseBounty(c, 'agent_sustained_activity')).toBe(0);
    });

    it('resolves to 0 through the identity-neutral HUMAN alias too', () => {
      // `wallet_sustained_activity` is the exact event the 200-PVT grant was
      // booked under; canonicalizing before the lookup is what closes it.
      expect(resolveGenesisBaseBounty(cfg(), 'wallet_sustained_activity')).toBe(0);
    });

    it('PAIRED CONTROL: a LIVE slot still reads its ladder value', () => {
      // Same call, same config — so "0" above is attributable to retirement.
      expect(resolveGenesisBaseBounty(cfg(), 'genesis_signup')).toBe(3);
      expect(resolveGenesisBaseBounty(cfg({ bounties: { ...cfg().bounties, genesis_signup: 42 } }), 'genesis_signup')).toBe(42);
    });

    it('isRetiredGenesisBounty is true for the slot and its alias, false for live slots', () => {
      expect(isRetiredGenesisBounty('agent_sustained_activity')).toBe(true);
      expect(isRetiredGenesisBounty('wallet_sustained_activity')).toBe(true);
      expect(isRetiredGenesisBounty('genesis_signup')).toBe(false);
      expect(isRetiredGenesisBounty('genesis_human_signup')).toBe(false);
      expect(isRetiredGenesisBounty('genesis_device_link')).toBe(false);
      expect(isRetiredGenesisBounty('agent_wallet_created')).toBe(false);
    });

    it('reserveGenesisIssuance REFUSES with a FULLY ENABLED campaign and writes nothing', async () => {
      // Every other gate is deliberately open: enabled, in window, ladder armed,
      // caps wide. A refusal here is attributable to retirement ALONE — not to
      // whichever kill switch happens to be engaged.
      const fake = createFakeFirestore();
      const c = cfg({ enabled: true, window_start_ms: 0, window_end_ms: 0, pool_cap_pvt: 1000 });
      const r = await reserveGenesisIssuance(db(fake), c, {
        walletId: 'w1', eventType: 'wallet_sustained_activity', walletCreatedAtMs: NOW, now: NOW,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('retired_bounty');
      expect(r.granted_pvt).toBe(0);
      expect(fake.store.size).toBe(0);
    });

    it('PAIRED CONTROL: the identical call on a LIVE slot is ALLOWED and does write', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ enabled: true, window_start_ms: 0, window_end_ms: 0, pool_cap_pvt: 1000 });
      const r = await reserveGenesisIssuance(db(fake), c, {
        walletId: 'w1', eventType: 'genesis_signup', walletCreatedAtMs: NOW, now: NOW,
      });
      expect(r.allowed).toBe(true);
      expect(r.granted_pvt).toBeGreaterThan(0);
      expect(fake.store.size).toBeGreaterThan(0);
    });

    it('isGenesisBountyPayable is false for the retired slot and true for a live one', () => {
      const c = cfg({ enabled: true, window_start_ms: 0, window_end_ms: 0 });
      expect(isGenesisBountyPayable(c, 'wallet_sustained_activity', NOW)).toBe(false);
      expect(isGenesisBountyPayable(c, 'genesis_signup', NOW)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Kill switch / window / gates
  // ---------------------------------------------------------------------------

  it('denies when the kill switch is off and writes nothing', async () => {
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg({ enabled: false }), {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 100, walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('genesis_disabled');
    expect(fake.store.size).toBe(0);
  });

  it('deploy-level force-off overrides an enabled config', async () => {
    process.env.GENESIS_CAMPAIGN_FORCE_OFF = 'true';
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg({ enabled: true }), {
      walletId: 'w1', eventType: 'agent_first_transaction', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('force_off');
    expect(fake.store.size).toBe(0);
  });

  it('denies before window open and after window close', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ window_start_ms: 500, window_end_ms: 2000 });
    const before = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_first_transaction', walletCreatedAtMs: 0, now: 100,
    });
    expect(before.reason).toBe('window_not_open');
    const after = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_first_transaction', walletCreatedAtMs: 0, now: 9000,
    });
    expect(after.reason).toBe('window_closed');
    expect(fake.store.size).toBe(0);
  });

  it('real-deposit gate rejects funded events below funding_min_usd', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ funding_min_usd: 5 });
    const low = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 3, fundingSourceAddress: '0xABC', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(low.reason).toBe('below_funding_min');
    const ok = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xABC', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(ok.allowed).toBe(true);
  });

  it('hybrid throttle: externalMultiplier 0 (tier-0/attestation-0) collapses the grant', async () => {
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_first_transaction', externalMultiplier: 0, walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('throttled_to_zero');
    expect(fake.store.size).toBe(0);
  });

  it('externalMultiplier scales the grant', async () => {
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_first_transaction', externalMultiplier: 0.5, walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.granted_pvt).toBeCloseTo(0.5); // base 1 * decay 1 * 0.5
  });

  it('clamps externalMultiplier to 1 - it can throttle/kill but never amplify (H-1)', async () => {
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_first_transaction', externalMultiplier: 5, walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.granted_pvt).toBeCloseTo(1); // base 1, NOT 5 - clamped to <= base
  });

  // ---------------------------------------------------------------------------
  // Metering + caps
  // ---------------------------------------------------------------------------

  it('happy path grants base*decay and increments global/wallet/source ledgers', async () => {
    const fake = createFakeFirestore();
    const r = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xSource', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.granted_pvt).toBeCloseTo(1);
    expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
    expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });
    expect(fake.store.get('genesis_source_ledger/0xsource')).toMatchObject({ issued_pvt: 1 });
  });

  it('meters sequential grants against the global pool cap and closes when exhausted', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ pool_cap_pvt: 2.5 });
    const p = { walletId: 'w1', eventType: 'agent_wallet_funded' as const, fundingUsd: 10, fundingSourceAddress: '0xS', walletCreatedAtMs: NOW, now: NOW };

    const a = await reserveGenesisIssuance(db(fake), c, p);
    const b = await reserveGenesisIssuance(db(fake), c, p);
    const third = await reserveGenesisIssuance(db(fake), c, p);
    const fourth = await reserveGenesisIssuance(db(fake), c, p);

    expect(a.granted_pvt).toBeCloseTo(1);
    expect(b.granted_pvt).toBeCloseTo(1);
    expect(third.granted_pvt).toBeCloseTo(0.5); // clamped to remaining pool
    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('pool_exhausted');
    expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 2.5 });
  });

  it('enforces the per-wallet cap', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ per_wallet_cap_pvt: 1 });
    const p = { walletId: 'w1', eventType: 'agent_first_transaction' as const, walletCreatedAtMs: NOW, now: NOW };
    const a = await reserveGenesisIssuance(db(fake), c, p);
    const b = await reserveGenesisIssuance(db(fake), c, p);
    expect(a.granted_pvt).toBeCloseTo(1);
    expect(b.allowed).toBe(false);
    expect(b.reason).toBe('wallet_cap_reached');
  });

  it('enforces the per-source cap independent of wallet', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ per_source_cap_pvt: 1 });
    const a = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xFARM', walletCreatedAtMs: NOW, now: NOW,
    });
    // Different wallet, SAME funding source => source cap should bind.
    const b = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w2', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xFARM', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(a.granted_pvt).toBeCloseTo(1);
    expect(b.allowed).toBe(false);
    expect(b.reason).toBe('source_cap_reached');
  });

  // ---------------------------------------------------------------------------
  // Identity-agnostic: human (neutral) events earn the same way
  // ---------------------------------------------------------------------------

  it('resolves identity-neutral human events to the shared canonical bounty slot', () => {
    expect(canonicalBountyKey('wallet_funded')).toBe('agent_wallet_funded');
    expect(canonicalBountyKey('wallet_first_transaction')).toBe('agent_first_transaction');
    expect(canonicalBountyKey('wallet_sustained_activity')).toBe('agent_sustained_activity');
    // Agent events map to themselves (idempotent).
    expect(canonicalBountyKey('agent_wallet_funded')).toBe('agent_wallet_funded');
    // The neutral funded event draws the SAME configured bounty value.
    expect(resolveGenesisBaseBounty(cfg(), 'wallet_funded')).toBe(resolveGenesisBaseBounty(cfg(), 'agent_wallet_funded'));
  });

  it('treats both the agent and human funded events as deposit-gated', () => {
    expect(isFundedEvent('agent_wallet_funded')).toBe(true);
    expect(isFundedEvent('wallet_funded')).toBe(true);
    expect(isFundedEvent('agent_first_transaction')).toBe(false);
    expect(isFundedEvent('wallet_first_transaction')).toBe(false);
  });

  it('meters a HUMAN funded event identically: same grant, same deposit gate, same caps', async () => {
    const fake = createFakeFirestore();
    // Below the deposit gate => denied for the human event, same as the agent event.
    const tooSmall = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'human_w1', eventType: 'wallet_funded', fundingUsd: 1, fundingSourceAddress: '0xHsrc', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(tooSmall.allowed).toBe(false);
    expect(tooSmall.reason).toBe('below_funding_min');

    // Real deposit => granted, and metered against the same global/per-wallet/per-source ledgers.
    const ok = await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'human_w1', eventType: 'wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xHsrc', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.granted_pvt).toBeCloseTo(1);
    expect(fake.store.get('genesis_wallet_ledger/human_w1')).toMatchObject({ issued_pvt: 1 });
    expect(fake.store.get('genesis_source_ledger/0xhsrc')).toMatchObject({ issued_pvt: 1 });
  });

  it('binds the per-source cap across a human and an agent sharing one funder (anti-farm is identity-blind)', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ per_source_cap_pvt: 1 });
    const agent = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'agent_w', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xFARM', walletCreatedAtMs: NOW, now: NOW,
    });
    // A human wallet funded from the SAME source hits the shared per-source cap.
    const human = await reserveGenesisIssuance(db(fake), c, {
      walletId: 'human_w', eventType: 'wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xFARM', walletCreatedAtMs: NOW, now: NOW,
    });
    expect(agent.granted_pvt).toBeCloseTo(1);
    expect(human.allowed).toBe(false);
    expect(human.reason).toBe('source_cap_reached');
  });

  // ---------------------------------------------------------------------------
  // Rollback + state
  // ---------------------------------------------------------------------------

  // Q3/C6 (2026-07-26): the pool counter is MONOTONIC, so rollback is refused.
  // These assertions replace the previous "rollback decrements and clamps at 0"
  // case, which documented the reducer that made C6 fail.
  it('rollback is REFUSED and writes nothing — the counter never moves down', async () => {
    const fake = createFakeFirestore();
    await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xS', walletCreatedAtMs: NOW, now: NOW,
    });
    // The reservation itself DID move the counter up — so a later "unchanged"
    // is a refusal, not an empty population.
    expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
    expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });

    const outcome = await rollbackGenesisIssuance(db(fake), {
      walletId: 'w1', fundingSourceAddress: '0xS', amountPvt: 1, now: NOW,
    });

    expect(outcome.reversed).toBe(false);
    expect(outcome.reason).toContain('monotonic');
    // All three counters are exactly where the reservation left them.
    expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
    expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });
    expect(fake.store.get('genesis_source_ledger/0xs')).toMatchObject({ issued_pvt: 1 });
  });

  it('an over-sized rollback is refused the same way — no clamp, no negative, no write', async () => {
    const fake = createFakeFirestore();
    await reserveGenesisIssuance(db(fake), cfg(), {
      walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xS', walletCreatedAtMs: NOW, now: NOW,
    });
    const outcome = await rollbackGenesisIssuance(db(fake), {
      walletId: 'w1', fundingSourceAddress: '0xS', amountPvt: 5, now: NOW,
    });
    expect(outcome.reversed).toBe(false);
    expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
  });

  it('getGenesisCampaignState reports minted + remaining', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ pool_cap_pvt: 10 });
    await reserveGenesisIssuance(db(fake), c, {
      walletId: 'w1', eventType: 'agent_first_transaction', walletCreatedAtMs: NOW, now: NOW,
    });
    const state = await getGenesisCampaignState(db(fake), c);
    expect(state.pool_minted_pvt).toBeCloseTo(1);
    expect(state.pool_remaining_pvt).toBeCloseTo(9);
  });

  // ---------------------------------------------------------------------------
  // #27 (Pass-2): release a suppressed reservation — the caps must not be
  // over-consumed by a grant that never accrued.
  // ---------------------------------------------------------------------------

  describe('releaseSuppressedGenesisReservation', () => {
    // Q3/C6 (2026-07-26): the release no longer takes — the pool counter is
    // monotonic, so the reservation stays consumed. This replaces the previous
    // "reverses exactly the reserved amount" case.
    it('REFUSES the release: the reservation stays consumed across all three ledgers', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 10, per_wallet_cap_pvt: 10, per_source_cap_pvt: 10 });
      const r = await reserveGenesisIssuance(db(fake), c, {
        walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xS', walletCreatedAtMs: NOW, now: NOW,
      });
      expect(r.granted_pvt).toBeCloseTo(1);
      // Caps debited by the reservation — so "unchanged" below is a refusal,
      // not a test running against an empty store.
      expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
      expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });
      expect(fake.store.get('genesis_source_ledger/0xs')).toMatchObject({ issued_pvt: 1 });

      const released = await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true,
        isGenesisGrant: true,
        reservedPvt: r.granted_pvt,
        walletId: 'w1',
        fundingSourceAddress: '0xS',
        now: NOW,
      });

      expect(released).toBe(false);
      // Every cap stays consumed. Under-granting is the deliberate direction.
      expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 1 });
      expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });
      expect(fake.store.get('genesis_source_ledger/0xs')).toMatchObject({ issued_pvt: 1 });
      const state = await getGenesisCampaignState(db(fake), c);
      expect(state.pool_remaining_pvt).toBeCloseTo(9); // NOT freed back to 10
    });

    it('no-ops (no ledger change) when accrual was NOT suppressed', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 10 });
      await reserveGenesisIssuance(db(fake), c, {
        walletId: 'w1', eventType: 'agent_first_transaction', walletCreatedAtMs: NOW, now: NOW,
      });
      const released = await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: false,
        isGenesisGrant: true,
        reservedPvt: 1,
        walletId: 'w1',
        now: NOW,
      });
      expect(released).toBe(false);
      // Healthy accrual keeps its reservation — the grant really accrued.
      expect(fake.store.get('genesis_wallet_ledger/w1')).toMatchObject({ issued_pvt: 1 });
    });

    it('no-ops for a non-genesis grant, a missing wallet, or a non-positive amount', async () => {
      const fake = createFakeFirestore();
      expect(await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true, isGenesisGrant: false, reservedPvt: 5, walletId: 'w1', now: NOW,
      })).toBe(false);
      expect(await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true, isGenesisGrant: true, reservedPvt: 5, walletId: null, now: NOW,
      })).toBe(false);
      expect(await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true, isGenesisGrant: true, reservedPvt: 0, walletId: 'w1', now: NOW,
      })).toBe(false);
      expect(await releaseSuppressedGenesisReservation(db(fake), {
        suppressed: true, isGenesisGrant: true, reservedPvt: null, walletId: 'w1', now: NOW,
      })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // #27 backfill follow-up: re-confirm a released reservation for a genesis
  // grant that landed during a Redis outage (pending_cache).
  // ---------------------------------------------------------------------------

  describe('confirmGenesisPendingCacheReReserve', () => {
    function seedPendingCachePE(fake: ReturnType<typeof createFakeFirestore>, id = 'pe_g') {
      fake.store.set(`pe_history/${id}`, { peId: id, mint_status: 'pending_cache', estimatedPVT: 0, is_genesis_grant: true });
      return db(fake).collection('pe_history').doc(id);
    }

    // Q3/C6 (2026-07-26): the re-debit is refused. Its premise was that the
    // suppression rollback had RELEASED these caps; with the counter monotonic
    // the release never happens, so re-debiting would count the grant twice.
    // These three cases replace the previous confirmed/clamped/exhausted set.
    it('REFUSES the re-debit and resolves the PE terminally, writing no ledger', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 100, per_wallet_cap_pvt: 100, per_source_cap_pvt: 100 });
      const peRef = seedPendingCachePE(fake);

      const r = await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', fundingSourceAddress: '0xS', amountPvt: 50, now: NOW,
      });

      expect(r).toEqual({ outcome: 'ineligible', granted_pvt: 0 });
      expect(fake.store.get('genesis_campaign_state/global')).toBeUndefined();
      expect(fake.store.get('genesis_wallet_ledger/w1')).toBeUndefined();
      expect(fake.store.get('genesis_source_ledger/0xs')).toBeUndefined();
      expect(fake.store.get('pe_history/pe_g')).toMatchObject({
        mint_status: 'ineligible',
        estimatedPVT: 0,
        pending_cache_outcome: 'genesis_reservation_never_released',
      });
    });

    it('NO DOUBLE-DEBIT: a standing reservation is left exactly as the reservation left it', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 100, per_wallet_cap_pvt: 100, per_source_cap_pvt: 100 });
      // A real prior reservation, still standing because releases are refused.
      await reserveGenesisIssuance(db(fake), c, {
        walletId: 'w1', eventType: 'agent_wallet_funded', fundingUsd: 10, fundingSourceAddress: '0xS', walletCreatedAtMs: NOW, now: NOW,
      });
      const poolBefore = (fake.store.get('genesis_campaign_state/global') as { pool_minted_pvt: number }).pool_minted_pvt;
      expect(poolBefore).toBeGreaterThan(0); // the population is not empty
      const peRef = seedPendingCachePE(fake);

      await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', fundingSourceAddress: '0xS', amountPvt: 50, now: NOW,
      });

      // Had the re-debit run, the pool would now be poolBefore + 50.
      expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: poolBefore });
    });

    it('an exhausted pool is refused for the same reason, and still writes no ledger', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 100 });
      fake.store.set('genesis_campaign_state/global', { pool_minted_pvt: 100 }); // pool full
      const peRef = seedPendingCachePE(fake);

      const r = await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', amountPvt: 50, now: NOW,
      });

      expect(r).toEqual({ outcome: 'ineligible', granted_pvt: 0 });
      expect(fake.store.get('genesis_campaign_state/global')).toMatchObject({ pool_minted_pvt: 100 }); // unchanged
      expect(fake.store.get('pe_history/pe_g')).toMatchObject({
        mint_status: 'ineligible',
        estimatedPVT: 0,
        pending_cache_outcome: 'genesis_reservation_never_released',
      });
    });

    it('emergency stop (campaign disabled) → terminal ineligible, no debit', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ enabled: false, pool_cap_pvt: 100 });
      const peRef = seedPendingCachePE(fake);

      const r = await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', amountPvt: 50, now: NOW,
      });

      expect(r.outcome).toBe('ineligible');
      expect(fake.store.get('genesis_campaign_state/global')).toBeUndefined(); // never debited
      expect(fake.store.get('pe_history/pe_g')).toMatchObject({ mint_status: 'ineligible', pending_cache_outcome: 'genesis_campaign_off' });
    });

    it('idempotent: a PE already reclassified out of pending_cache is a no-op (no double-debit)', async () => {
      const fake = createFakeFirestore();
      const c = cfg({ pool_cap_pvt: 100 });
      // Already handled by a prior run → mint_status is no longer pending_cache.
      fake.store.set('pe_history/pe_g', { peId: 'pe_g', mint_status: 'eligible', estimatedPVT: 50, is_genesis_grant: true });
      const peRef = db(fake).collection('pe_history').doc('pe_g');

      const r = await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', amountPvt: 50, now: NOW,
      });

      expect(r.outcome).toBe('already_handled');
      expect(fake.store.get('genesis_campaign_state/global')).toBeUndefined(); // NOT re-debited
      expect(fake.store.get('pe_history/pe_g')).toMatchObject({ estimatedPVT: 50 }); // untouched
    });

    it('invalid inputs (no wallet / non-positive amount) → invalid, no change', async () => {
      const fake = createFakeFirestore();
      const c = cfg();
      const peRef = seedPendingCachePE(fake);
      expect((await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: '', amountPvt: 50, now: NOW,
      })).outcome).toBe('invalid');
      expect((await confirmGenesisPendingCacheReReserve(db(fake), c, {
        peHistoryRef: peRef, walletId: 'w1', amountPvt: 0, now: NOW,
      })).outcome).toBe('invalid');
      expect(fake.store.get('pe_history/pe_g')).toMatchObject({ mint_status: 'pending_cache' }); // untouched
    });
  });

  it('reserves Genesis mint throughput against the per-epoch cap and rolls it back', async () => {
    const fake = createFakeFirestore();
    const c = cfg({ per_epoch_mint_cap_pvt: 3 });

    const a = await reserveGenesisEpochMintBudget(db(fake), c, {
      epoch: 12,
      requestedPvt: 2,
      now: NOW,
    });
    const b = await reserveGenesisEpochMintBudget(db(fake), c, {
      epoch: 12,
      requestedPvt: 2,
      now: NOW,
    });

    expect(a).toMatchObject({ reserved_pvt: 2, remaining_pvt: 1, reason: 'ok' });
    expect(b).toMatchObject({ reserved_pvt: 1, remaining_pvt: 0, reason: 'ok' });
    expect(fake.store.get('genesis_epoch_mint_ledger/12')).toMatchObject({ minted_pvt: 3 });

    await rollbackGenesisEpochMintBudget(db(fake), { epoch: 12, amountPvt: 1.5, now: NOW });
    const state = await getGenesisEpochMintState(db(fake), c, 12);
    expect(state.minted_pvt).toBeCloseTo(1.5);
    expect(state.remaining_pvt).toBeCloseTo(1.5);
  });

  // ---------------------------------------------------------------------------
  // Config loader (fail-closed)
  // ---------------------------------------------------------------------------

  describe('loadGenesisCampaignConfig', () => {
    it('returns the fail-closed default when no doc exists', async () => {
      const fake = createFakeFirestore();
      const loaded = await loadGenesisCampaignConfig(db(fake));
      expect(loaded.enabled).toBe(false);
      expect(loaded.pool_cap_pvt).toBe(0);
      expect(loaded.bounties).toEqual(DEFAULT_GENESIS_CONFIG.bounties);
    });

    it('merges a partial stored doc over defaults', async () => {
      const fake = createFakeFirestore();
      fake.store.set('pvt_config/genesis_campaign', { enabled: true, pool_cap_pvt: 50 });
      const loaded = await loadGenesisCampaignConfig(db(fake));
      expect(loaded.enabled).toBe(true);
      expect(loaded.pool_cap_pvt).toBe(50);
      expect(loaded.funding_min_usd).toBe(DEFAULT_GENESIS_CONFIG.funding_min_usd);
    });

    it('force-off env forces enabled:false even when the doc says true', async () => {
      const fake = createFakeFirestore();
      fake.store.set('pvt_config/genesis_campaign', { enabled: true, pool_cap_pvt: 50 });
      process.env.GENESIS_CAMPAIGN_FORCE_OFF = '1';
      const loaded = await loadGenesisCampaignConfig(db(fake));
      expect(loaded.enabled).toBe(false);
    });
  });
});

describe('isGenesisScanActive (cron cost gate - scans no-op once genesis ends)', () => {
  const state = (poolRemaining: number) => ({ pool_minted_pvt: 0, pool_remaining_pvt: poolRemaining, updated_at: 0 });
  const NOW = 1_000_000;

  it('true when enabled, in-window, and pool has budget', () => {
    expect(isGenesisScanActive(cfg({ window_start_ms: 0, window_end_ms: NOW + 1000 }), state(100), NOW)).toBe(true);
  });
  it('false when killed / force-off (enabled=false)', () => {
    expect(isGenesisScanActive(cfg({ enabled: false, window_end_ms: NOW + 1000 }), state(100), NOW)).toBe(false);
  });
  it('false before the window opens', () => {
    expect(isGenesisScanActive(cfg({ window_start_ms: NOW + 1, window_end_ms: NOW + 1000 }), state(100), NOW)).toBe(false);
  });
  it('false after the window closes (genesis ended)', () => {
    expect(isGenesisScanActive(cfg({ window_start_ms: 0, window_end_ms: NOW - 1 }), state(100), NOW)).toBe(false);
  });
  it('false when the pool is exhausted (genesis ended)', () => {
    expect(isGenesisScanActive(cfg({ window_start_ms: 0, window_end_ms: NOW + 1000 }), state(0), NOW)).toBe(false);
  });
  it('window_end_ms=0 means no scheduled end (still active)', () => {
    expect(isGenesisScanActive(cfg({ window_start_ms: 0, window_end_ms: 0 }), state(100), NOW)).toBe(true);
  });
});

describe('isGenesisBountyPayable (trigger-path inert-until-armed gate)', () => {
  const NOW = 1_000_000;
  // An armed campaign whose human/device welcome bounties are set.
  const armed = (overrides = {}) =>
    cfg({
      window_start_ms: 0,
      window_end_ms: NOW + 1000,
      bounties: {
        agent_wallet_created: 0,
        genesis_signup: 75,
        genesis_human_signup: 75,
        genesis_device_link: 25,
        agent_wallet_funded: 0,
        agent_first_transaction: 0,
        agent_sustained_activity: 0,
      },
      ...overrides,
    });

  it('true when enabled, in-window, and the event bounty is armed (>0)', () => {
    expect(isGenesisBountyPayable(armed(), 'genesis_human_signup', NOW)).toBe(true);
    expect(isGenesisBountyPayable(armed(), 'genesis_device_link', NOW)).toBe(true);
    expect(isGenesisBountyPayable(armed(), 'genesis_signup', NOW)).toBe(true);
  });
  it('false when the campaign is disabled (kill switch / force-off)', () => {
    expect(isGenesisBountyPayable(armed({ enabled: false }), 'genesis_human_signup', NOW)).toBe(false);
  });
  it('false before the window opens and after it closes', () => {
    expect(isGenesisBountyPayable(armed({ window_start_ms: NOW + 1 }), 'genesis_human_signup', NOW)).toBe(false);
    expect(isGenesisBountyPayable(armed({ window_end_ms: NOW - 1 }), 'genesis_human_signup', NOW)).toBe(false);
  });
  it('false when the event bounty is unarmed (0) - the 0-default keeps the trigger inert', () => {
    const zeroed = armed({
      bounties: {
        agent_wallet_created: 0, genesis_signup: 75, genesis_human_signup: 0,
        genesis_device_link: 0, agent_wallet_funded: 0, agent_first_transaction: 0,
        agent_sustained_activity: 0,
      },
    });
    expect(isGenesisBountyPayable(zeroed, 'genesis_human_signup', NOW)).toBe(false);
    expect(isGenesisBountyPayable(zeroed, 'genesis_device_link', NOW)).toBe(false);
    // A sibling event that IS armed stays payable - the gate is per-event.
    expect(isGenesisBountyPayable(zeroed, 'genesis_signup', NOW)).toBe(true);
  });
});
