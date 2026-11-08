import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { createAgentProfileRouter } from './agent-profile';
import { ACTOR_STATS_COLLECTION, emptyActorStats } from '../core/pvt/actor-stats';
import { ACTOR_METER_TOTALS_COLLECTION } from '../core/meter/actor-meter-totals';

type DocData = Record<string, unknown>;

class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    private readonly value: DocData | undefined,
  ) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): DocData | undefined {
    return this.value;
  }
}

class FakeQuerySnapshot {
  constructor(public readonly docs: FakeDocSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }
}

class FakeQuery {
  private filters: Array<{ field: string; value: unknown }> = [];
  private limitValue: number | null = null;

  constructor(
    private readonly collectionName: string,
    private readonly store: Map<string, DocData>,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') throw new Error(`Unsupported fake query op: ${op}`);
    const next = new FakeQuery(this.collectionName, this.store);
    next.filters = [...this.filters, { field, value }];
    next.limitValue = this.limitValue;
    return next;
  }

  limit(n: number): FakeQuery {
    const next = new FakeQuery(this.collectionName, this.store);
    next.filters = [...this.filters];
    next.limitValue = n;
    return next;
  }

  async get(): Promise<FakeQuerySnapshot> {
    const docs: FakeDocSnapshot[] = [];
    for (const [path, data] of this.store.entries()) {
      const prefix = `${this.collectionName}/`;
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      const matches = this.filters.every(filter => data[filter.field] === filter.value);
      if (matches) docs.push(new FakeDocSnapshot(id, data));
      if (this.limitValue !== null && docs.length >= this.limitValue) break;
    }
    return new FakeQuerySnapshot(docs);
  }
}

class FakeCollection {
  constructor(
    private readonly name: string,
    private readonly store: Map<string, DocData>,
  ) {}

  doc(id: string): { get: () => Promise<FakeDocSnapshot> } {
    return {
      get: async () => new FakeDocSnapshot(id, this.store.get(`${this.name}/${id}`)),
    };
  }

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.name, this.store).where(field, op, value);
  }
}

class FakeFirestore {
  public readonly store = new Map<string, DocData>();

  collection(name: string): FakeCollection {
    return new FakeCollection(name, this.store);
  }

  seed(collection: string, id: string, data: DocData): void {
    this.store.set(`${collection}/${id}`, data);
  }
}

function createCache(): RedisCache {
  const cacheStore = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    }),
  } as unknown as RedisCache;
}

function buildApp(fake: FakeFirestore, cache = createCache()): express.Express {
  const app = express();
  app.use('/v1/agents', createAgentProfileRouter({
    db: fake as unknown as Firestore,
    cache,
  }));
  return app;
}

describe('Agent Provenance Record route', () => {
  const originalBaseUrl = process.env.API_BASE_URL;
  const originalPublicLaunch = process.env.PUBLIC_LAUNCH;

  beforeEach(() => {
    process.env.API_BASE_URL = 'https://api.test';
    // M4: this router is public-discovery gated. These cases exercise the
    // CONTENT, so they run with the surface open; the paired closed case below
    // asserts it is the gate, not the data, that decides.
    process.env.PUBLIC_LAUNCH = 'true';
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalBaseUrl;
    if (originalPublicLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = originalPublicLaunch;
  });

  describe('public-discovery gate (M4)', () => {
    it('404s /profile and /provenance to an anonymous caller while PUBLIC_LAUNCH is closed', async () => {
      process.env.PUBLIC_LAUNCH = 'false';
      const fake = new FakeFirestore();
      const app = buildApp(fake);
      for (const path of ['/v1/agents/wallet_aw_atlas/profile', '/v1/agents/wallet_aw_atlas/provenance']) {
        const res = await request(app).get(path);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/genesis/i);
      }
    });

    it('404s when PUBLIC_LAUNCH is ABSENT — unknown is closed', async () => {
      delete process.env.PUBLIC_LAUNCH;
      const res = await request(buildApp(new FakeFirestore()))
        .get('/v1/agents/wallet_aw_atlas/profile');
      expect(res.status).toBe(404);
    });

    it('PAIRED CONTROL: the identical request is served with the flag flipped', async () => {
      process.env.PUBLIC_LAUNCH = 'true';
      const res = await request(buildApp(new FakeFirestore()))
        .get('/v1/agents/wallet_aw_atlas/profile');
      // Not a 404 — the gate opened. (Content is asserted by the cases below.)
      expect(res.status).not.toBe(404);
    });
  });

  it('RED: platform:test identities resolve as not found and contribute zero public activity', async () => {
    const fake = new FakeFirestore();
    fake.seed('agent_wallets', 'wallet_aw_smoke', {
      id: 'wallet_aw_smoke',
      agent_id: 'smoke-agent',
      display_name: 'Smoke Agent',
      platform: 'test',
      address: '0xsmoke',
    });
    fake.seed('pvt_accrual', 'smoke-agent', {
      totalPEs: 999,
      totalEstimatedPVT: 999,
    });

    for (const identifier of ['wallet_aw_smoke', 'smoke-agent', 'Smoke Agent']) {
      const res = await request(buildApp(fake)).get(`/v1/agents/${encodeURIComponent(identifier)}/profile`);
      expect(res.status).toBe(200);
      expect(res.body.wallet_type).toBe('not_found');
      expect(res.body.wallet_id).toBeNull();
      expect(res.body.pe_count).toBe(0);
      expect(res.body.estimated_pvt).toBe(0);
    }
  });

  it('uses canonical PE fields and O(1) pvt_accrual totals for /profile', async () => {
    const fake = new FakeFirestore();
    const now = Date.now();
    const day1 = Date.UTC(2026, 0, 1);
    const day2 = Date.UTC(2026, 0, 2);

    fake.seed('agent_wallets', 'wallet_aw_atlas', {
      id: 'wallet_aw_atlas',
      agent_id: 'atlas',
      display_name: 'Atlas',
      address: '0xatlas',
      governance_score: 88,
      linked_human_user_id: 'user_frank',
      badges: [{ id: 'genesis_agent', earned_at: day1 }],
    });
    fake.seed('pvt_accrual', 'atlas', {
      userId: 'atlas',
      totalPEs: 3,
      totalEstimatedPVT: 42.25,
      pesByCategory: { wallet: 1, agent: 2 },
      estimatedPVTByCategory: { wallet: 0.8, agent: 41.45 },
      lastPETimestamp: day2,
      attestationDepth: 'software_verified',
    });
    // PE METER: the profile reads running totals, never a scan of stored PEs. Three acts:
    // agent_wallet_created (software), service:github_commit (software_verified, corroborated),
    // legacy_action (hardware).
    fake.seed(ACTOR_STATS_COLLECTION, 'atlas', {
      ...emptyActorStats('atlas'),
      pe_count: 3,
      by_type: { agent_wallet_created: 1, 'service:github_commit': 1, legacy_action: 1 },
      first_pe_at_ms: day1,
      last_pe_at_ms: day2,
      active_days: 2,
    });
    fake.seed(ACTOR_METER_TOTALS_COLLECTION, 'atlas', {
      by_attestation_tier: { software: 1, software_verified: 1, hardware: 1 },
      corroborated: 1,
    });
    // RED CONTROL: a planted pre-meter PE row is never read.
    fake.seed('pe_history', 'pe_planted', {
      peId: 'pe_planted',
      userId: 'atlas',
      timestamp: day2 + 1,
      actionType: 'planted_legacy',
      attestationDepth: 'hardware_full',
      corroboration_status: 'on_chain_verified',
    });
    fake.seed('commons_profiles', 'wallet_aw_atlas', {
      status: 'active',
      identity_verification_level: 'peer_vouched',
      governance_score: 84,
      promise_fulfillment_rate: 0.75,
      court_record: { wins: 2, losses: 0 },
      published_pe_count: 9,
      commons_join_date: day1,
    });
    // F27: two FREE vouches must be IGNORED (the free vouch path is retired);
    // only the single burn-vouch (keyed by target_agent_id) counts.
    fake.seed('commons_vouches', 'vouch_1', { vouchee_wallet_id: 'wallet_aw_atlas' });
    fake.seed('commons_vouches', 'vouch_2', { vouchee_wallet_id: 'wallet_aw_atlas' });
    fake.seed('commons_burn_vouches', 'bv_1', {
      vouch_id: 'vouch_00000000-0000-0000-0000-000000000001',
      target_agent_id: 'atlas',
      voucher_wallet_id: 'wallet_aw_voucher',
    });
    fake.seed('commons_artifacts', 'artifact_1', {
      creator_wallet_id: 'wallet_aw_atlas',
      deprecated: false,
      human_attestation_count: 2,
      unique_invoker_count: 4,
    });
    fake.seed('bonds', 'bond_1', {
      bond_id: 'bond_1',
      agent_wallet_id: 'wallet_aw_atlas',
      status: 'active',
      autonomy_level: 3,
      amount_pvt: '3000000000000000000000',
      renewal_deadline: now + 60_000,
    });
    // The shape device registration writes for an agent-owned device: owner_user_id is the agent's
    // WALLET id (routes/devices.ts, `ownerId = agentWallet.id`), never its agent id.
    fake.seed('devices', 'dev_atlas', {
      owner_user_id: 'wallet_aw_atlas',
      owner_wallet_id: 'wallet_aw_atlas',
      owner_type: 'agent',
      status: 'active',
    });
    fake.seed('agent_author_mappings', 'github_atlas', {
      agent_wallet_id: 'wallet_aw_atlas',
      source_owner_wallet_id: 'wallet_human_frank',
      provider: 'github',
      author_key_type: 'email',
      author_key: 'atlas@example.com',
      status: 'active',
      verified_by: 'agent_wallet_signature',
    });

    const res = await request(buildApp(fake)).get('/v1/agents/wallet_aw_atlas/profile');

    expect(res.status).toBe(200);
    expect(res.body.wallet_type).toBe('agent_wallet');
    expect(res.body.wallet_id).toBe('wallet_aw_atlas');
    expect(res.body.agent_id).toBe('atlas');
    expect(res.body.pe_count).toBe(3);
    expect(res.body.estimated_pvt).toBe(42.25);
    expect(res.body.provenance.source).toBe('pvt_accrual');
    expect(res.body.provenance.category_breakdown).toEqual({ wallet: 1, agent: 2 });
    expect(res.body.provenance.scanned_window.pe_count).toBe(3);
    expect(res.body.provenance.scanned_window.includes_legacy_field_fallback).toBe(false);
    expect(res.body.action_type_breakdown['service:github_commit']).toBe(1);
    expect(res.body.action_type_breakdown.legacy_action).toBe(1);
    expect(res.body.action_type_breakdown.planted_legacy).toBeUndefined();
    expect(res.body.attestation_tiers.software_verified).toBe(1);
    expect(res.body.attestation_tiers.hardware).toBe(1);
    expect(res.body.attestation_tiers.hardware_full ?? 0).toBe(0);
    expect(res.body.activity_summary.last_pe_at).toBe(day2);
    // F27: 1 (the burn-vouch), NOT 2 (the ignored free vouches).
    expect(res.body.trust_signals.vouch_count).toBe(1);
    expect(res.body.trust_signals.burn_vouch_count).toBe(1);
    expect(res.body.trust_signals.performance_bond_posted).toBe(true);
    expect(res.body.trust_signals.bond_healthy).toBe(true);
    expect(res.body.trust_signals.commons_member).toBe(true);
    expect(res.body.trust_signals.identity_verification_level).toBe('peer_vouched');
    expect(res.body.trust_signals.agent_identity).toBe(true);
    expect(res.body.trust_signals.device_attested_agent_identity).toBe(true);
    expect(res.body.trust_signals.key_anchored_author_mappings).toBe(1);
    expect(res.body.trust_signals.unique_artifact_invokers).toBe(4);
    expect(res.body.trust_signals.human_attestations).toBe(3);
    expect(res.body.identity).toMatchObject({
      owner_type: 'agent',
      is_agent_identity: true,
      device_attested: true,
      active_agent_owned_devices: 1,
      key_anchored_author_mappings: 1,
      attribution_model: 'agent_key_or_owned_device',
    });
    expect(res.body.badges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent_identity', owner_type: 'agent' }),
    ]));
    expect(res.body.commons.promise_fulfillment_rate).toBe(0.75);
    expect(res.body.public_url).toBe('https://api.test/v1/agents/wallet_aw_atlas/profile');
    expect(res.body.provenance_url).toBe('https://api.test/v1/agents/wallet_aw_atlas/provenance');
  });

  it('merges the agent_id and wallet_id chains so device-path PEs are visible (live seam 2026-07-07)', async () => {
    // One agent, two PE chains: agent-API-path PEs accrue under the AGENT_ID,
    // device-path PEs (device_register, /v1/pe/submit with device creds) and
    // the genesis_device_link grant accrue under the WALLET_ID. The activation
    // stranger run showed the profile reporting pe_count=3 while 6 PEs
    // existed — the wallet_id chain was invisible.
    const fake = new FakeFirestore();
    const day1 = Date.UTC(2026, 6, 1);
    const day2 = Date.UTC(2026, 6, 2);

    fake.seed('agent_wallets', 'wallet_aw_stranger', {
      id: 'wallet_aw_stranger',
      agent_id: 'stranger',
      display_name: 'Stranger',
      address: '0xstranger',
      governance_score: 0,
      badges: [],
    });
    // Agent-id chain accrual (wallet_created + external_address_proven + genesis_signup).
    fake.seed('pvt_accrual', 'stranger', {
      userId: 'stranger',
      totalPEs: 3,
      totalEstimatedPVT: 74.9,
      pesByCategory: { wallet: 1, genesis: 2 },
      estimatedPVTByCategory: { wallet: 0, genesis: 74.9 },
      lastPETimestamp: day1,
      attestationDepth: 'software',
    });
    // Wallet-id (device) chain accrual (device_register + genesis_device_link + test_run).
    fake.seed('pvt_accrual', 'wallet_aw_stranger', {
      userId: 'wallet_aw_stranger',
      totalPEs: 3,
      totalEstimatedPVT: 26.56,
      pesByCategory: { wallet: 1, genesis: 1, uncategorized: 1 },
      estimatedPVTByCategory: { genesis: 24.96, uncategorized: 1.6 },
      lastPETimestamp: day2,
      attestationDepth: 'software_verified',
    });
    // Agent-id chain running totals (PE meter: no stored PEs to scan).
    fake.seed(ACTOR_STATS_COLLECTION, 'stranger', {
      ...emptyActorStats('stranger'),
      pe_count: 2,
      by_type: { agent_wallet_created: 1, genesis_signup: 1 },
      first_pe_at_ms: day1,
      last_pe_at_ms: day1 + 1,
      active_days: 1,
    });
    // Wallet-id (device) chain running totals — invisible before the merge.
    fake.seed(ACTOR_STATS_COLLECTION, 'wallet_aw_stranger', {
      ...emptyActorStats('wallet_aw_stranger'),
      pe_count: 3,
      by_type: { device_register: 1, genesis_device_link: 1, test_run: 1 },
      first_pe_at_ms: day2,
      last_pe_at_ms: day2 + 2,
      active_days: 1,
    });

    const res = await request(buildApp(fake)).get('/v1/agents/wallet_aw_stranger/profile');

    expect(res.status).toBe(200);
    // Accrual totals merged across both owner keys.
    expect(res.body.pe_count).toBe(6);
    expect(res.body.estimated_pvt).toBe(101.46);
    expect(res.body.provenance.source).toBe('pvt_accrual');
    expect(res.body.provenance.category_breakdown).toEqual({ wallet: 2, genesis: 3, uncategorized: 1 });
    expect(res.body.provenance.estimated_pvt_by_category).toEqual({ genesis: 99.86, uncategorized: 1.6 });
    // Most recently active chain's attestation depth wins.
    expect(res.body.provenance.latest_attestation_depth).toBe('software_verified');
    // Running totals of both chains: device-path action types are visible.
    expect(res.body.provenance.scanned_window.pe_count).toBe(5);
    expect(res.body.action_type_breakdown).toEqual({
      agent_wallet_created: 1,
      genesis_signup: 1,
      device_register: 1,
      genesis_device_link: 1,
      test_run: 1,
    });
    expect(res.body.activity_summary.last_pe_at).toBe(day2 + 2);
  });

  describe('the agent\'s attested devices (identity.device_attested / active_agent_owned_devices)', () => {
    const seedAgent = (fake: FakeFirestore): void => {
      fake.seed('agent_wallets', 'wallet_aw_grok', {
        id: 'wallet_aw_grok',
        agent_id: 'agent-grok',
        display_name: 'grok-bot-vm',
        address: '0xgrok',
        badges: [],
      });
      fake.seed('commons_profiles', 'wallet_aw_grok', { identity_verification_level: 'device_attested' });
    };
    // Registration's shape for an agent-owned device: keyed by the WALLET, owner_user_id = wallet id.
    const device = (wallet: string, status = 'active'): DocData => ({
      device_id: `dev_${wallet}_${status}`,
      owner_user_id: wallet,
      owner_wallet_id: wallet,
      owner_type: 'agent',
      status,
    });

    it('counts the agent\'s active agent-owned devices, looked up by agent id or wallet id', async () => {
      const fake = new FakeFirestore();
      seedAgent(fake);
      fake.seed('devices', 'pv1_grok_vm', device('wallet_aw_grok'));
      // RED controls in the same population: a revoked device of this agent, another agent's device
      // and a human device of the same wallet id are not counted.
      fake.seed('devices', 'pv1_grok_old', device('wallet_aw_grok', 'revoked'));
      fake.seed('devices', 'pv1_other', device('wallet_aw_other'));
      fake.seed('devices', 'pv1_human', { ...device('wallet_aw_grok'), owner_type: 'human' });
      for (const id of ['agent-grok', 'wallet_aw_grok']) {
        const res = await request(buildApp(fake)).get(`/v1/agents/${id}/profile`);
        expect(res.status).toBe(200);
        expect(res.body.identity).toMatchObject({
          device_attested: true,
          active_agent_owned_devices: 1,
          attribution_model: 'agent_owned_device',
        });
        expect(res.body.trust_signals.device_attested_agent_identity).toBe(true);
      }
    });

    it('RED control: an agent with no active device reports false and 0', async () => {
      const fake = new FakeFirestore();
      seedAgent(fake);
      fake.seed('devices', 'pv1_grok_old', device('wallet_aw_grok', 'revoked'));
      const res = await request(buildApp(fake)).get('/v1/agents/agent-grok/profile');
      expect(res.body.identity).toMatchObject({ device_attested: false, active_agent_owned_devices: 0, attribution_model: 'public_record_only' });
      expect(res.body.trust_signals.device_attested_agent_identity).toBe(false);
    });

    it('a failed device lookup reports unknown (null), never "no attested device"', async () => {
      const fake = new FakeFirestore();
      seedAgent(fake);
      fake.seed('devices', 'pv1_grok_vm', device('wallet_aw_grok'));
      const failing = {
        collection: (name: string) => {
          if (name === 'devices') {
            const query: Record<string, unknown> = { get: async () => { throw new Error('index unavailable'); } };
            query.where = () => query;
            return query;
          }
          return fake.collection(name);
        },
      } as unknown as FakeFirestore;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const res = await request(buildApp(failing)).get('/v1/agents/agent-grok/profile');
        expect(res.status).toBe(200);
        expect(res.body.identity.device_attested).toBeNull();
        expect(res.body.identity.active_agent_owned_devices).toBeNull();
        expect(res.body.trust_signals.device_attested_agent_identity).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('serves the same Provenance Record from the /provenance alias', async () => {
    const fake = new FakeFirestore();
    fake.seed('agent_wallets', 'wallet_aw_beautiful', {
      id: 'wallet_aw_beautiful',
      agent_id: 'beautiful_allen',
      display_name: 'Beautiful Allen',
      address: '0xbeau',
      governance_score: 12,
      badges: [],
    });
    fake.seed('pvt_accrual', 'beautiful_allen', {
      userId: 'beautiful_allen',
      totalPEs: 1,
      totalEstimatedPVT: 0.8,
      pesByCategory: { wallet: 1 },
      estimatedPVTByCategory: { wallet: 0.8 },
      lastPETimestamp: Date.UTC(2026, 0, 3),
      attestationDepth: 'software',
    });

    const res = await request(buildApp(fake)).get('/v1/agents/beautiful_allen/provenance');

    expect(res.status).toBe(200);
    expect(res.body.identifier).toBe('beautiful_allen');
    expect(res.body.wallet_id).toBe('wallet_aw_beautiful');
    expect(res.body.pe_count).toBe(1);
    expect(res.body.links.profile).toBe('https://api.test/v1/agents/beautiful_allen/profile');
    expect(res.body.links.provenance).toBe('https://api.test/v1/agents/beautiful_allen/provenance');
  });
});
