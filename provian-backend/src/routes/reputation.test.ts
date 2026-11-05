/**
 * bond lifecycle (agent-first launch): GET /v1/reputation/address/:address.
 *
 * The consumer-side trust surface: chain-verified financial history for a
 * Base address KNOWN to Provian. Pins the honesty contract (unknown →
 * {known:false}, never a score), the lowercase-normalization rule, the
 * address-scoped event filter, the human-wallet privacy boundary, and the
 * no-PII/Tier-3 guarantee.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { createReputationRouter } from './reputation';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { TIER_3_FIELDS } from '../core/commons/publication';
import { ACTOR_METER_TOTALS_COLLECTION } from '../core/meter/actor-meter-totals';
import { foldActorTotals } from '../core/meter/__test-helpers__/fold-actor-totals';

const NATIVE_ADDRESS = '0x' + 'aa'.repeat(20);
const EXTERNAL_ADDRESS = '0x' + 'ee'.repeat(20);
const HUMAN_ADDRESS = '0x' + 'ff'.repeat(20);
const UNKNOWN_ADDRESS = '0x' + '99'.repeat(20);
const WALLET_ID = 'wallet_aw_atlas';
const AGENT_ID = 'atlas';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const SENTINELS = [
  'user_frank_SECRET',
  'frank@example.com',
  'TIER3_SIGHASH',
  'TIER3_API_KEY_HASH',
  '0xdeadbeefdeadbeef',
  'TIER3_POLICY',
];

function seed(fake: FakeFirestore): void {
  fake.store.set(`agent_wallets/${WALLET_ID}`, {
    id: WALLET_ID,
    agent_id: AGENT_ID,
    display_name: 'Atlas',
    address: NATIVE_ADDRESS,
    status: 'active',
    created_at: NOW - 90 * DAY,
    linked_human_user_id: 'user_frank_SECRET',
    api_key_hash: 'TIER3_API_KEY_HASH',
    policy_config: { autonomy: 'TIER3_POLICY' },
  });

  fake.store.set(`proven_addresses/${EXTERNAL_ADDRESS}`, {
    address: EXTERNAL_ADDRESS,
    agent_id: AGENT_ID,
    wallet_id: WALLET_ID,
    proven_at_ms: NOW - 60 * DAY,
    proven_at_block: 1_000_000,
    chain: 'base',
    signature_hash: 'TIER3_SIGHASH',
    baseline_nonce: 7,
    initial_reputation_tier: 'L1',
  });

  // PE METER: the summary reads the agent's running totals (`actor_meter_totals_v1`), folded
  // through the production seal path. Watchers stamp actor_address = the watched address.
  fake.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/${AGENT_ID}`, foldActorTotals(AGENT_ID, [
    {
      actionType: 'receive', timestamp: NOW - 40 * DAY, actorAddress: EXTERNAL_ADDRESS,
      dispositionReasonCode: 'policy_eligible', metadata: { activity_mapped: true, amount_usd: 250 },
    },
    {
      actionType: 'x402_payment', timestamp: NOW - 2 * DAY, actorAddress: EXTERNAL_ADDRESS,
      metadata: { chain_verified: true, amount_usd: 3 },
    },
    // Native-address event: relay-verified transfer (must NOT count for the external address,
    // and vice versa).
    {
      actionType: 'agent_token_transfer', timestamp: NOW - 10 * DAY, actorAddress: NATIVE_ADDRESS,
      metadata: { verified: true, currency: 'usdc', amount_atomic: '5000000' },
    },
    // A device-authored send claiming 8,888,888 USD — never counts anywhere.
    {
      actionType: 'send', timestamp: NOW - DAY, actorAddress: EXTERNAL_ADDRESS, relayAuthored: false,
      metadata: { chain_verified: true, amount_usd: 8888888 },
    },
  ]) as unknown as Record<string, unknown>);
  // RED CONTROL: a planted pre-meter envelope (with a tx hash) is never read.
  fake.store.set('provenance_envelopes/env_planted', {
    user_id: AGENT_ID, action_type: 'receive', actor_address: EXTERNAL_ADDRESS, timestamp: NOW - DAY,
    metadata: { activity_mapped: true, amount_usd: 50000, tx_hash: '0xdeadbeefdeadbeef' },
  });
  fake.store.set('pe_history/env_planted', { disposition_reason_code: 'policy_eligible' });

  fake.store.set('bonds/bond_1', {
    bond_id: 'bond_1',
    agent_wallet_id: WALLET_ID,
    status: 'active',
    amount_pvt: '750',
    autonomy_level: 2,
    renewal_deadline: NOW + 30 * DAY,
  });
  fake.store.set('bond_claims/claim_open', {
    respondent_wallet_id: WALLET_ID,
    status: 'filed',
    description: 'claim description stays private',
  });
  fake.store.set('bond_claims/claim_upheld', {
    respondent_wallet_id: WALLET_ID,
    status: 'upheld',
  });

  // Human wallet — must stay unknown on this surface.
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
  app.use('/v1/reputation', createReputationRouter({
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

describe('GET /v1/reputation/address/:address', () => {
  let priorLaunch: string | undefined;
  let fake: FakeFirestore;

  beforeEach(() => {
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true';
    fake = createFakeFirestore();
    seed(fake);
  });

  afterEach(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  it('404s before the launch flip (PUBLIC_LAUNCH gate)', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${EXTERNAL_ADDRESS}`);
    expect(res.status).toBe(404);
  });

  it('returns an honest {known:false} for an unknown address — never an invented score', async () => {
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${UNKNOWN_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.known).toBe(false);
    expect(res.body.address).toBe(UNKNOWN_ADDRESS);
    expect(res.body.pricing).toBe('free_beta');
    expect(res.body.identity).toBeUndefined();
    expect(res.body.financial).toBeUndefined();
    expect(res.body.flags).toBeUndefined();
    // No invented score FIELD of any kind (the disclaimer text saying
    // "not a score" is the one legitimate mention).
    const keys = new Set<string>();
    collectKeys(res.body, keys);
    for (const key of keys) {
      expect(key).not.toMatch(/score|rating|grade/i);
    }
  });

  it('summarizes a proven external address, scoped to that address’s events', async () => {
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${EXTERNAL_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.known).toBe(true);
    expect(res.body.pricing).toBe('free_beta');
    expect(res.body.identity).toMatchObject({
      address_type: 'proven_external',
      agent_wallet_id: WALLET_ID,
      display_name: 'Atlas',
      linked_to_human: true,
    });
    expect(typeof res.body.identity.proven_at).toBe('number');
    expect(res.body.identity.record_url).toContain(`/v1/agents/${EXTERNAL_ADDRESS}/record`);

    // Address-scoped: the native-address transfer is NOT here, and the
    // unverified 8,888,888 self-report never counts.
    expect(res.body.financial.usdc.inbound_count).toBe(1);
    expect(res.body.financial.usdc.inbound_volume_bucket).toBe('100_1k');
    expect(res.body.financial.x402.settlements_observed).toBe(1);
    expect(res.body.financial.usdc.outbound_count).toBe(1);
    expect(res.body.financial.usdc.outbound_volume_bucket).toBe('under_10');
    expect(res.body.financial.verified_transfers.count).toBe(0);
    expect(res.body.financial.first_activity_at).toBeLessThan(res.body.financial.last_activity_at);

    expect(res.body.flags).toEqual({
      bonded: true,
      bond_healthy: true,
      open_bond_claims: 1,
      court_claims_upheld_against: 1,
    });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('summarizes a native agent-wallet address with its own events only', async () => {
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${NATIVE_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.address_type).toBe('native_agent_wallet');
    expect(res.body.identity.proven_at).toBeNull();
    expect(res.body.financial.usdc.inbound_count).toBe(0);
    expect(res.body.financial.x402.settlements_observed).toBe(0);
    expect(res.body.financial.verified_transfers.count).toBe(1);
    expect(res.body.financial.verified_transfers.by_currency).toEqual({ usdc: 1 });
  });

  it('lowercases mixed-case input before every equality lookup', async () => {
    const mixed = '0x' + 'eE'.repeat(20);
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${mixed}`);
    expect(res.status).toBe(200);
    expect(res.body.known).toBe(true);
    expect(res.body.address).toBe(EXTERNAL_ADDRESS);
  });

  it('keeps human wallet addresses unknown (privacy boundary)', async () => {
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${HUMAN_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.known).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('user_frank_SECRET');
    expect(JSON.stringify(res.body)).not.toContain('frank@example.com');
  });

  it('400s a malformed address', async () => {
    const res = await request(buildApp(fake)).get('/v1/reputation/address/not-an-address');
    expect(res.status).toBe(400);
  });

  it('ADVERSARIAL: leaks no PII, no Tier-3 key, no sentinel value', async () => {
    const res = await request(buildApp(fake)).get(`/v1/reputation/address/${EXTERNAL_ADDRESS}`);
    expect(res.status).toBe(200);

    const text = JSON.stringify(res.body);
    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
    }
    const keys = new Set<string>();
    collectKeys(res.body, keys);
    for (const forbidden of TIER_3_FIELDS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    // Exact amounts stay private — buckets only.
    expect(text).not.toContain('8888888');
    expect(text).not.toContain('"250"');
  });

  it('429s when the per-IP rate limit trips', async () => {
    const cache = createCache();
    (cache.checkRateLimit as jest.Mock).mockImplementation(async () =>
      ({ allowed: false, current: 61, limit: 60, retryAfter: 9 }));
    const res = await request(buildApp(fake, cache)).get(`/v1/reputation/address/${EXTERNAL_ADDRESS}`);
    expect(res.status).toBe(429);
  });
});
