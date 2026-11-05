/**
 * beneficiary routing (agent-first launch): the Agent Passport / public Provenance Record.
 *
 * GET /v1/agents/:identifier/record + /:identifier/badge.svg.
 *
 * The adversarial core of this suite: the seeded agent carries every Tier-3
 * category CLAUDE.md forbids on public surfaces — balances, policy configs,
 * telemetry, credentials, API-key material, linked-human identifiers, raw PE
 * content, tx hashes — and the tests assert none of it survives into the
 * response, by TIER_3_FIELDS key walk AND by sentinel-value scan.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { createAgentRecordRouter } from './agent-record';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { TIER_3_FIELDS } from '../core/commons/publication';
import { ACTOR_STATS_COLLECTION, emptyActorStats } from '../core/pvt/actor-stats';
import { ACTOR_METER_TOTALS_COLLECTION } from '../core/meter/actor-meter-totals';
import { foldActorTotals, type FoldedAct } from '../core/meter/__test-helpers__/fold-actor-totals';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NATIVE_ADDRESS = '0x' + 'aa'.repeat(20);
const EXTERNAL_ADDRESS = '0x' + 'ee'.repeat(20);
const HUMAN_ADDRESS = '0x' + 'ff'.repeat(20);
const WALLET_ID = 'wallet_aw_atlas';
const AGENT_ID = 'atlas';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

/** Sentinel strings planted in Tier-3 / PII positions; none may leak. */
const SENTINELS = [
  'TIER3_API_KEY_HASH',
  'TIER3_SALT',
  'TIER3_CALLBACK',
  'user_frank_SECRET',
  'wallet_human_SECRET',
  '0xhumanlinkaddr',
  'TIER3_POLICY',
  'TIER3_AUTONOMY',
  'TIER3_BASELINE',
  'TIER3_TELEMETRY',
  'TIER3_CREDENTIAL',
  'TIER3_RECOVERY',
  'TIER3_INPUT_SUMMARY',
  'TIER3_SIGHASH',
  '0xdeadbeefdeadbeef',
  '0xbondtxhash',
  'TIER3_CLAIM_DESC',
  'TIER3_DISPUTE_DESC',
  'frank@example.com',
];

function seedAtlas(fake: FakeFirestore): void {
  // Agent wallet loaded with adversarial Tier-3 fields alongside the real ones.
  fake.store.set(`agent_wallets/${WALLET_ID}`, {
    id: WALLET_ID,
    agent_id: AGENT_ID,
    display_name: 'Atlas',
    platform: 'openclaw',
    address: NATIVE_ADDRESS,
    status: 'active',
    created_at: NOW - 90 * DAY,
    badges: ['first_pe'],
    estimated_pvt: 6.5,
    // Human link — booleans only may surface, never these identifiers:
    linked_human_user_id: 'user_frank_SECRET',
    linked_human_wallet_id: 'wallet_human_SECRET',
    linked_human_address: '0xhumanlinkaddr',
    // Tier-3 / secret material that must never appear in any response:
    api_key_hash: 'TIER3_API_KEY_HASH',
    api_key_salt: 'TIER3_SALT',
    callback_url: 'https://TIER3_CALLBACK.example',
    policy_config: { autonomy: 'TIER3_POLICY' },
    autonomy_settings: { level: 'TIER3_AUTONOMY' },
    wallet_balance: 12345.67,
    pvt_held_cached: 888.88,
    behavioral_baseline: { profile: 'TIER3_BASELINE' },
    telemetry: { events: ['TIER3_TELEMETRY'] },
    credential: 'TIER3_CREDENTIAL',
    recovery_config: { phrase: 'TIER3_RECOVERY' },
    kill_switch: false,
    contact_email: 'frank@example.com',
  });

  // PE METER: the record reads running totals, never stored PEs. The agent's metered acts,
  // folded through the production seal path. Only the relay-verified financial acts may count;
  // the device-authored `send` carrying a 9,999,999 USD figure must not.
  const acts: FoldedAct[] = [
    { actionType: 'agent_work_product_code', attestationDepth: 'software', timestamp: NOW - 80 * DAY },
    {
      actionType: 'receive', attestationDepth: 'software', timestamp: NOW - 40 * DAY,
      actorAddress: EXTERNAL_ADDRESS, dispositionReasonCode: 'policy_eligible',
      metadata: { activity_mapped: true, amount_usd: 50 },
    },
    {
      actionType: 'x402_payment', attestationDepth: 'hardware_full', timestamp: NOW - 2 * DAY,
      actorAddress: EXTERNAL_ADDRESS, metadata: { chain_verified: true, amount_usd: 2 },
    },
    {
      actionType: 'send', attestationDepth: 'software', timestamp: NOW - DAY,
      actorAddress: EXTERNAL_ADDRESS, relayAuthored: false, metadata: { chain_verified: true, amount_usd: 9999999 },
    },
    {
      actionType: 'agent_token_transfer', attestationDepth: 'software', timestamp: NOW - 10 * DAY,
      actorAddress: NATIVE_ADDRESS, metadata: { verified: true, currency: 'usdc', amount_atomic: '2500000' },
    },
  ];
  fake.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/${AGENT_ID}`, foldActorTotals(AGENT_ID, acts) as unknown as Record<string, unknown>);
  fake.store.set(`${ACTOR_STATS_COLLECTION}/${AGENT_ID}`, {
    ...emptyActorStats(AGENT_ID),
    pe_count: acts.length,
    by_type: { agent_work_product_code: 1, receive: 1, x402_payment: 1, send: 1, agent_token_transfer: 1 },
    first_pe_at_ms: NOW - 80 * DAY,
    last_pe_at_ms: NOW - DAY,
    active_days: acts.length,
  });

  // Aggregate accrual doc (preferred pe_count source).
  fake.store.set(`pvt_accrual/${AGENT_ID}`, {
    totalPEs: 4,
    totalEstimatedPVT: 6.5,
    pesByCategory: { compute: 2, x402: 1, wallet: 1 },
    estimatedPVTByCategory: { compute: 3.5, x402: 2, wallet: 1 },
    lastPETimestamp: NOW - 2 * DAY,
    attestationDepth: 'hardware_full',
  });

  // RED CONTROL: planted pre-meter rows carrying raw content and tx hashes are never read.
  fake.store.set('pe_history/pe_planted', {
    userId: AGENT_ID, estimatedPVT: 1, inputSummary: 'TIER3_INPUT_SUMMARY do not leak',
    actionType: 'planted_legacy', attestationDepth: 'hardware_partial', timestamp: NOW - DAY,
  });
  fake.store.set('provenance_envelopes/env_planted', {
    user_id: AGENT_ID, action_type: 'receive', actor_address: EXTERNAL_ADDRESS, timestamp: NOW - DAY,
    metadata: { activity_mapped: true, amount_usd: 777, tx_hash: '0xdeadbeefdeadbeef' },
  });

  // Active bond.
  fake.store.set('bonds/bond_1', {
    bond_id: 'bond_1',
    agent_wallet_id: WALLET_ID,
    status: 'active',
    amount_pvt: '750',
    autonomy_level: 2,
    renewal_deadline: NOW + 30 * DAY,
    post_tx_hash: '0xbondtxhash',
  });

  // Court history.
  fake.store.set('bond_claims/claim_open', {
    respondent_wallet_id: WALLET_ID,
    status: 'filed',
    description: 'TIER3_CLAIM_DESC',
  });
  fake.store.set('bond_claims/claim_dismissed', {
    respondent_wallet_id: WALLET_ID,
    status: 'dismissed',
    description: 'TIER3_CLAIM_DESC',
  });
  fake.store.set('general_disputes/gd_1', {
    respondent: WALLET_ID,
    filed_by: 'wallet_aw_other',
    resolution: 'upheld',
    description: 'TIER3_DISPUTE_DESC',
  });
  fake.store.set(`arbitrators/${WALLET_ID}`, { total_cases: 5 });

  // Promise performance.
  fake.store.set('promises/p1', { borrower_wallet_id: WALLET_ID, status: 'settled' });
  fake.store.set('promises/p2', { borrower_wallet_id: WALLET_ID, status: 'settled' });
  fake.store.set('promises/p3', { borrower_wallet_id: WALLET_ID, status: 'defaulted' });

  // Vouches + Commons. F27: the two FREE vouches must be IGNORED (retired path);
  // only the single burn-vouch (keyed by target_agent_id) is the vouch signal.
  fake.store.set('commons_vouches/v1', { vouchee_wallet_id: WALLET_ID, voucher_wallet_id: 'wallet_aw_a' });
  fake.store.set('commons_vouches/v2', { vouchee_wallet_id: WALLET_ID, voucher_wallet_id: 'wallet_aw_b' });
  fake.store.set('commons_burn_vouches/bv1', {
    vouch_id: 'vouch_00000000-0000-0000-0000-000000000001',
    target_agent_id: AGENT_ID,
    voucher_wallet_id: 'wallet_aw_c',
  });
  fake.store.set(`commons_profiles/${WALLET_ID}`, { status: 'active' });

  // Proven external address (doc id = lowercase address).
  fake.store.set(`proven_addresses/${EXTERNAL_ADDRESS}`, {
    address: EXTERNAL_ADDRESS,
    agent_id: AGENT_ID,
    wallet_id: WALLET_ID,
    proven_at_ms: NOW - 60 * DAY,
    proven_at_block: 1_000_000,
    chain: 'base',
    proof_method: 'eip191',
    signature_hash: 'TIER3_SIGHASH',
    baseline_nonce: 42,
    initial_reputation_tier: 'L1',
  });

  // A HUMAN wallet — must never resolve on this surface.
  fake.store.set('wallets/wallet_human_1', {
    type: 'human',
    user_id: 'user_frank_SECRET',
    address: HUMAN_ADDRESS,
    email: 'frank@example.com',
  });
}

function createCache(): RedisCache {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    checkRateLimit: jest.fn(async () => ({ allowed: true, current: 1, limit: 60 })),
  } as unknown as RedisCache;
}

function buildApp(fake: FakeFirestore, cache = createCache()): Express {
  const app = express();
  app.use('/v1/agents', createAgentRecordRouter({
    db: fake as unknown as Firestore,
    cache,
  }));
  return app;
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/agents/:identifier/record', () => {
  let priorLaunch: string | undefined;
  let fake: FakeFirestore;

  beforeEach(() => {
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true';
    fake = createFakeFirestore();
    seedAtlas(fake);
  });

  afterEach(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  it('404s before the launch flip (PUBLIC_LAUNCH gate)', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const res = await request(buildApp(fake)).get(`/v1/agents/${WALLET_ID}/record`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns the Provenance Record by wallet id', async () => {
    const res = await request(buildApp(fake)).get(`/v1/agents/${WALLET_ID}/record`);
    expect(res.status).toBe(200);
    expect(res.body.record_type).toBe('provenance_record');
    expect(res.body.found).toBe(true);
    expect(res.body.matched_by).toBe('wallet_id');

    // Identity + wallet age
    expect(res.body.agent).toMatchObject({
      wallet_id: WALLET_ID,
      agent_id: AGENT_ID,
      display_name: 'Atlas',
      platform: 'openclaw',
      status: 'active',
      address: NATIVE_ADDRESS,
      linked_to_human: true,
    });
    expect(res.body.agent.wallet_age_days).toBe(90);
    expect(res.body.agent.external_address).toMatchObject({
      address: EXTERNAL_ADDRESS,
      chain: 'base',
      initial_reputation_tier: 'L1',
    });

    // Provenance: accrual-preferred count, families, tier mix
    expect(res.body.provenance.pe_count).toBe(4);
    expect(res.body.provenance.source).toBe('pvt_accrual');
    expect(res.body.provenance.total_estimated_pvt).toBe(6.5);
    expect(res.body.provenance.families).toMatchObject({ compute: 1, financial: 3 });
    expect(JSON.stringify(res.body.provenance.families)).not.toContain('planted');
    expect(res.body.provenance.attestation_tiers.software).toBe(4);
    expect(res.body.provenance.attestation_tiers.hardware_partial ?? 0).toBe(0); // the planted row is never read
    expect(res.body.provenance.attestation_tiers.hardware_full).toBe(1);

    // Financial: chain-verified only (the 9999999 self-report is excluded)
    expect(res.body.financial.chain_verified_only).toBe(true);
    expect(res.body.financial.usdc.inbound_count).toBe(1);
    expect(res.body.financial.usdc.inbound_volume_bucket).toBe('10_100');
    expect(res.body.financial.usdc.outbound_count).toBe(1); // the x402 settlement
    expect(res.body.financial.usdc.outbound_volume_bucket).toBe('under_10'); // 2 + 2.5 usdc
    expect(res.body.financial.x402.settlements_observed).toBe(1);
    expect(res.body.financial.verified_transfers.count).toBe(1);
    expect(res.body.financial.verified_transfers.by_currency).toEqual({ usdc: 1 });

    // Bond / court / promises / vouches
    expect(res.body.bond).toMatchObject({ bonded: true, healthy: true, amount_pvt: '750', autonomy_level: 2 });
    expect(res.body.court.bond_claims_against).toEqual({ total: 2, upheld: 0, dismissed: 1, open: 1 });
    expect(res.body.court.general_disputes).toMatchObject({ against_agent: 1, resolved_against_agent: 1 });
    expect(res.body.court.arbitration_cases).toBe(5);
    expect(res.body.promises).toEqual({ issued: 3, settled: 2, defaulted: 1, fulfillment_rate: 0.667 });
    // F27: the vouch signal is burn-vouches ONLY — 1 (the burn-vouch), NOT 2
    // (the ignored free vouches). Both fields derive from commons_burn_vouches.
    expect(res.body.vouches).toEqual({ count: 1, burn_vouch_count: 1 });
    expect(res.body.commons).toEqual({ member: true });

    // Copy discipline: mint-once language present, no fiat inference
    const text = JSON.stringify(res.body);
    expect(text).toContain('every act of work mints PVT once at its best-supported value');
    expect(text).not.toMatch(/\$\d/);
  });

  it('resolves the same record by agent_id, native address, and proven external address', async () => {
    const app = buildApp(fake);

    const byAgentId = await request(app).get(`/v1/agents/${AGENT_ID}/record`);
    expect(byAgentId.status).toBe(200);
    expect(byAgentId.body.agent.wallet_id).toBe(WALLET_ID);
    expect(byAgentId.body.matched_by).toBe('identifier');

    const byNative = await request(app).get(`/v1/agents/${NATIVE_ADDRESS}/record`);
    expect(byNative.status).toBe(200);
    expect(byNative.body.agent.wallet_id).toBe(WALLET_ID);
    expect(byNative.body.matched_by).toBe('native_address');

    const byExternal = await request(app).get(`/v1/agents/${EXTERNAL_ADDRESS}/record`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.agent.wallet_id).toBe(WALLET_ID);
    expect(byExternal.body.matched_by).toBe('proven_external_address');
  });

  it('RED: platform:test identities and all their activity are absent from every public lookup key', async () => {
    const fake = createFakeFirestore();
    seedAtlas(fake);
    fake.store.set(`agent_wallets/${WALLET_ID}`, {
      ...fake.store.get(`agent_wallets/${WALLET_ID}`),
      platform: 'test',
    });
    const app = buildApp(fake);

    for (const identifier of [WALLET_ID, AGENT_ID, NATIVE_ADDRESS, EXTERNAL_ADDRESS]) {
      const res = await request(app).get(`/v1/agents/${encodeURIComponent(identifier)}/record`);
      expect(res.status).toBe(404);
      expect(res.body.found).toBe(false);
      expect(res.body.agent.wallet_id).toBeNull();
      expect(res.body.provenance.pe_count).toBe(0);
      expect(res.body.provenance.total_estimated_pvt).toBe(0);
    }
  });

  it('resolves a MIXED-CASE address (Firestore stores addresses lowercase)', async () => {
    const mixed = '0x' + 'Aa'.repeat(20);
    const res = await request(buildApp(fake)).get(`/v1/agents/${mixed}/record`);
    expect(res.status).toBe(200);
    expect(res.body.agent.wallet_id).toBe(WALLET_ID);
  });

  it('ADVERSARIAL: leaks no Tier-3 key and no sentinel value', async () => {
    const res = await request(buildApp(fake)).get(`/v1/agents/${WALLET_ID}/record`);
    expect(res.status).toBe(200);

    // 1. No sentinel value planted in Tier-3 positions survives serialization.
    const text = JSON.stringify(res.body);
    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
    }

    // 2. No TIER_3_FIELDS key appears anywhere in the response tree.
    const keys = new Set<string>();
    collectKeys(res.body, keys);
    for (const forbidden of TIER_3_FIELDS) {
      expect(keys.has(forbidden)).toBe(false);
    }

    // 3. The linked-human exposure is EXACTLY a boolean.
    expect(res.body.agent.linked_to_human).toBe(true);
    expect(keys.has('linked_human_user_id')).toBe(false);
    expect(keys.has('linked_human_wallet_id')).toBe(false);
    expect(keys.has('linked_human_address')).toBe(false);
    // 4. No raw numeric balance fields.
    expect(text).not.toContain('12345.67');
    expect(text).not.toContain('888.88');
  });

  it('does NOT resolve a human wallet address (privacy boundary)', async () => {
    const res = await request(buildApp(fake)).get(`/v1/agents/${HUMAN_ADDRESS}/record`);
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('user_frank_SECRET');
    expect(JSON.stringify(res.body)).not.toContain('frank@example.com');
  });

  it('404s an unknown identifier with an honest found:false record', async () => {
    const res = await request(buildApp(fake)).get('/v1/agents/wallet_aw_nonexistent/record');
    expect(res.status).toBe(404);
    expect(res.body.record_type).toBe('provenance_record');
    expect(res.body.found).toBe(false);
  });

  it('429s when the per-IP rate limit trips', async () => {
    const cache = createCache();
    (cache.checkRateLimit as jest.Mock).mockImplementation(async () =>
      ({ allowed: false, current: 61, limit: 60, retryAfter: 12 }));
    const res = await request(buildApp(fake, cache)).get(`/v1/agents/${WALLET_ID}/record`);
    expect(res.status).toBe(429);
  });
});

/** supertest buffers image/* responses as binary — recover the SVG text. */
function svgText(res: request.Response): string {
  if (typeof res.text === 'string' && res.text.length > 0) return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString('utf8');
  return String(res.body ?? '');
}

describe('GET /v1/agents/:identifier/badge.svg', () => {
  let priorLaunch: string | undefined;
  let fake: FakeFirestore;

  beforeEach(() => {
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true';
    fake = createFakeFirestore();
    seedAtlas(fake);
  });

  afterEach(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  it('renders a cache-friendly SVG with PE count, tier, and bond state', async () => {
    const res = await request(buildApp(fake)).get(`/v1/agents/${WALLET_ID}/badge.svg`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const svg = svgText(res);
    expect(svg).toContain('<svg');
    expect(svg).toContain('4 PEs');
    expect(svg).toContain('hardware'); // highest tier present (hardware_full)
    expect(svg).toContain('bonded');
    // No Tier-3 sentinel can ride an SVG either.
    for (const sentinel of SENTINELS) {
      expect(svg).not.toContain(sentinel);
    }
  });

  it('renders an honest unknown-agent badge (short cache)', async () => {
    const res = await request(buildApp(fake)).get('/v1/agents/wallet_aw_nonexistent/badge.svg');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(svgText(res)).toContain('unknown agent');
  });

  it('404s before the launch flip', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const res = await request(buildApp(fake)).get(`/v1/agents/${WALLET_ID}/badge.svg`);
    expect(res.status).toBe(404);
  });
});
