/**
 * F47/F64 (S2 2026-09-10) — party/panel scoping of the by-id reads
 * GET /v1/escrow/:escrow_id and GET /v1/court/dispute/:escrow_id.
 *
 * Both by-id reads returned the full document to ANY authenticated agent that
 * learned the id (escrow ids leak through job events / court filings / published
 * PE details). The escrow read exposes counterparty addresses, deliverables and
 * amounts; the dispute read exposes the arbitrator panel and the live vote tally
 * while voting is open. The reads are now scoped to a party (escrow) / a party
 * or seated arbitrator (dispute), 404 on mismatch (don't confirm existence).
 *
 * RED controls: a non-party agent gets 404 on both routes (revert the guard and
 * these go 200 with the document). Positive controls: a party (and, for the
 * dispute, a panel member) still gets 200.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentEscrowRouter } from './agent-escrow';
import { createAgentCourtRouter } from './agent-court';
import type { AgentBankDeps } from '../core/agent-bank/types';

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() {
        const d = col(name).get(id);
        return { exists: d !== undefined, id, data: () => d };
      },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore): AgentBankDeps {
  return {
    db,
    cache: {
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      checkRateLimitStrict: async () => ({ allowed: true, current: 0, limit: 10 }),
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
  } as unknown as AgentBankDeps;
}

function seedWallet(col: (n: string) => Map<string, Doc>, id: string): string {
  const creds = generateApiCredentials();
  col('agent_wallets').set(id, {
    id, agent_id: `agent_${id}`, address: `0x${id}`,
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
    status: 'active',
  });
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: id });
  return `Bearer ${creds.api_key}:${creds.api_secret}`;
}

function seedEscrow(col: (n: string) => Map<string, Doc>) {
  col('escrows').set('esc_1', {
    escrow_id: 'esc_1',
    depositor_wallet_id: 'wallet_A',
    depositor_address: '0xA',
    recipient_wallet_id: 'wallet_D',
    recipient_address: '0xD',
    currency: 'usdc',
    amount_usdc: 100,
    fee_usdc: 1,
    net_to_recipient_usdc: 99,
    description: 'secret commercial terms',
    deliverables: 'the goods',
    chain: 'base',
    deadline: Date.now() + 86_400_000,
    auto_release_at: Date.now() + 172_800_000,
    status: 'created',
  });
}

function seedDispute(col: (n: string) => Map<string, Doc>) {
  col('court_disputes').set('esc_1', {
    escrow_id: 'esc_1',
    panel: ['wallet_E'],
    panel_addresses: ['0xE'],
    votes: {},
    voting_deadline: Date.now() + 86_400_000,
    status: 'voting',
    created_at: Date.now(),
    updated_at: Date.now(),
    pe_ids: [],
  });
}

function escrowApp() {
  const { db, col } = makeFirestore();
  const app = express();
  app.use(express.json());
  app.use('/v1/escrow', createAgentEscrowRouter(makeDeps(db)));
  return { app, col };
}

function courtApp() {
  const { db, col } = makeFirestore();
  const app = express();
  app.use(express.json());
  app.use('/v1/court', createAgentCourtRouter(makeDeps(db)));
  return { app, col };
}

describe('GET /v1/escrow/:escrow_id — F47/F64 party scope', () => {
  it('a party (depositor) reads the escrow (200)', async () => {
    const { app, col } = escrowApp();
    const bearerA = seedWallet(col, 'wallet_A');
    seedWallet(col, 'wallet_B');
    seedEscrow(col);
    const res = await request(app).get('/v1/escrow/esc_1').set('Authorization', bearerA);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ escrow_id: 'esc_1', deliverables: 'the goods' });
  });

  it('RED: a non-party agent gets 404 (never the document)', async () => {
    const { app, col } = escrowApp();
    seedWallet(col, 'wallet_A');
    const bearerB = seedWallet(col, 'wallet_B');
    seedEscrow(col);
    const res = await request(app).get('/v1/escrow/esc_1').set('Authorization', bearerB);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('the goods');
    expect(JSON.stringify(res.body)).not.toContain('secret commercial terms');
  });
});

describe('GET /v1/court/dispute/:escrow_id — F47/F64 party/panel scope', () => {
  it('a seated arbitrator (panel) reads the dispute (200)', async () => {
    const { app, col } = courtApp();
    const bearerE = seedWallet(col, 'wallet_E');
    seedWallet(col, 'wallet_B');
    seedDispute(col);
    const res = await request(app).get('/v1/court/dispute/esc_1').set('Authorization', bearerE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ escrow_id: 'esc_1', panel: ['wallet_E'] });
  });

  it('an escrow party (not on the panel) reads the dispute (200 via escrow lookup)', async () => {
    const { app, col } = courtApp();
    const bearerA = seedWallet(col, 'wallet_A');
    seedWallet(col, 'wallet_E');
    seedEscrow(col);
    seedDispute(col);
    const res = await request(app).get('/v1/court/dispute/esc_1').set('Authorization', bearerA);
    expect(res.status).toBe(200);
  });

  it('RED: a non-party, non-panel agent gets 404 (never the panel/votes)', async () => {
    const { app, col } = courtApp();
    const bearerB = seedWallet(col, 'wallet_B');
    seedWallet(col, 'wallet_E');
    seedEscrow(col);
    seedDispute(col);
    const res = await request(app).get('/v1/court/dispute/esc_1').set('Authorization', bearerB);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('wallet_E');
  });
});
