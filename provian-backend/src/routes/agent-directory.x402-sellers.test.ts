/**
 * — "Sellers ... are listed in the Provian agent directory."
 *
 * `GET /v1/agents/directory` keeps its `agents` / `count` exactly as before and adds the active
 * x402 sellers in their own section, each marked `kind: 'x402_seller'`. Real router, fake Firestore.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createAgentDirectoryRouter } from './agent-directory';

const BASE_SELLER = '0x1000000000000000000000000000000000000001';
const SUSPENDED = '0x2000000000000000000000000000000000000002';
const SOL_SELLER = 'D'.repeat(44);

let db: FakeFirestore;
let app: Express;

function seller(chain: 'base' | 'solana', address: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seller_id: `${chain}:${address}`, chain, address,
    network: chain === 'base' ? 'eip155:8453' : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    display_name: `Seller ${chain}`, description: 'weather data', resource_urls: ['https://api.example.com/w'],
    require_presentation: null, pvt_prices: [], status: 'active', registered_at_ms: 1, updated_at_ms: 2,
    strike_count: 4,
    ...over,
  };
}

beforeEach(() => {
  db = createFakeFirestore();
  db.store.set('agent_directory/w1', {
    wallet_id: 'w1', agent_id: 'agent1', display_name: 'Atlas', address: '0xaaaa00000000000000000000000000000000000a',
    capabilities: ['code'], description: 'founding agent', availability: 'available', pe_count: 0,
    created_at: 1, updated_at: 1,
  });
  db.store.set('agent_wallets/w1', { id: 'w1', agent_id: 'agent1', platform: 'claude' });
  db.store.set(`x402_sellers_v1/base:${BASE_SELLER}`, seller('base', BASE_SELLER, {
    pvt_prices: [{ resource: '/w', amount_atomic: '5000000000000000000' }],
    require_presentation: { tier: 'pe_fact' },
    settlement_count: 12,
  }));
  db.store.set(`x402_sellers_v1/base:${SUSPENDED}`, seller('base', SUSPENDED, { status: 'suspended' }));
  db.store.set(`x402_sellers_v1/solana:${SOL_SELLER}`, seller('solana', SOL_SELLER));
  app = express();
  app.use('/v1/agents', createAgentDirectoryRouter({
    db: db as unknown as Firestore,
    cache: { checkRateLimit: async () => ({ allowed: true }) },
  } as unknown as AgentBankDeps));
});

describe('GET /v1/agents/directory — x402 sellers', () => {
  it('keeps the agents section exactly as before (additive change)', async () => {
    const res = await request(app).get('/v1/agents/directory').expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({ wallet_id: 'w1', display_name: 'Atlas' });
    expect(res.body.agents[0]).not.toHaveProperty('kind');
  });

  it('lists active sellers, clearly marked, with what they accept and whether they need a presentation', async () => {
    const res = await request(app).get('/v1/agents/directory').expect(200);
    expect(res.body.x402_sellers).toEqual([
      {
        kind: 'x402_seller', seller_id: `base:${BASE_SELLER}`, chain: 'base', network: 'eip155:8453',
        address: BASE_SELLER, display_name: 'Seller base', description: 'weather data',
        resource_urls: ['https://api.example.com/w'], accepts: ['USDC', 'PVT'],
        pvt_prices: [{ resource: '/w', amount_atomic: '5000000000000000000' }],
        requires_presentation: true, presentation_tier: 'pe_fact', settlement_count: 12,
      },
      {
        kind: 'x402_seller', seller_id: `solana:${SOL_SELLER}`, chain: 'solana',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: SOL_SELLER,
        display_name: 'Seller solana', description: 'weather data', resource_urls: ['https://api.example.com/w'],
        accepts: ['USDC'], pvt_prices: [], requires_presentation: false, presentation_tier: null, settlement_count: 0,
      },
    ]);
  });

  it('RED: a suspended seller is not listed, and no internal counter leaks', async () => {
    const res = await request(app).get('/v1/agents/directory').expect(200);
    const ids = res.body.x402_sellers.map((s: { seller_id: string }) => s.seller_id);
    expect(ids).not.toContain(`base:${SUSPENDED}`);
    expect(JSON.stringify(res.body)).not.toContain('strike_count');
  });
});
