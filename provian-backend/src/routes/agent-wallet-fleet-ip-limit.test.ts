/**
 * FLEET-LINKED WALLETS COUNT AGAINST THE PER-IP WALLET LIMIT.
 *
 * A wallet created to link through a fleet code counts against the same per-IP
 * wallet-creation limit as every other wallet creation, at the same value. A fleet
 * agent has two ways to create its wallet, and both funnel into the ONE limiter in
 * `POST /v1/agent/wallet/create` (`rl:aw-create:min:<ip>` / `rl:aw-create:hr:<ip>`,
 * checked before PoP and before any write, whatever the body carries):
 * - the REST route itself — the hosted install line, the SDK, the CLI;
 * - the hosted MCP `wallet_create` tool, whose self-call re-enters that route
 * carrying the caller's IP in X-Forwarded-For (routes/mcp.ts), so the bucket
 * is the agent's, not the relay's.
 * The link (`POST /:wallet_id/request-link`) creates no wallet.
 *
 * The limiter here is a REAL counting limiter keyed exactly as the route keys it,
 * and the bucket is used up by ORDINARY creations (no code) — so a pass proves a
 * fleet creation shares the bucket every other creation fills, not a fleet-only one.
 *
 * RED CONTROLS (permanent, in-suite):
 * - the same fleet creation from a fresh IP succeeds, so the refusal is the
 * IP's bucket and nothing about the code;
 * - with a limiter that never refuses, the same post-exhaustion request succeeds,
 * so the refusal exists only because the route consults the per-IP limit.
 * One-shot source mutation, recorded in the commit: with the rate-limit block in
 * routes/agent-wallet.ts deleted, the refusal tests go RED.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';

jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: async (
    _cache: unknown,
    _challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => ({ ok: true as const, registration_context: { ...expected, credential_recovery_generation: null } }),
}));

import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from '../core/pvt/watcher-address-admission';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import { keccak256 } from '../mcp/core/keccak256';
import type { RouterDeps } from '../core/agent-wallet/types';
import { createAgentWalletRouter } from './agent-wallet';
import { mountMCPRoutes } from './mcp';

const FLEET_CODE = 'PROV-FLTX-2468';
const EXHAUSTED_IP = '198.51.100.10';
const FRESH_IP = '198.51.100.20';
const MCP_ACCEPT = 'application/json, text/event-stream';

/** A counting fixed-window limiter with the production `checkRateLimit(key, limit, windowSec)` shape. */
function makeCountingLimiter() {
  let nowMs = 0;
  const windows = new Map<string, { startMs: number; count: number }>();
  const keysSeen: string[] = [];
  return {
    keysSeen,
    advance(ms: number) { nowMs += ms; },
    checkRateLimit: async (key: string, limit: number, windowSec: number) => {
      keysSeen.push(key);
      const w = windows.get(key);
      if (!w || nowMs - w.startMs >= windowSec * 1000) {
        windows.set(key, { startMs: nowMs, count: 1 });
        return { allowed: true, retryAfter: 0 };
      }
      w.count += 1;
      if (w.count > limit) return { allowed: false, retryAfter: Math.ceil((w.startMs + windowSec * 1000 - nowMs) / 1000) };
      return { allowed: true, retryAfter: 0 };
    },
  };
}

type Limiter = { checkRateLimit: (key: string, limit: number, windowSec: number) => Promise<{ allowed: boolean; retryAfter: number }> };

function addressOf(publicKey: string): string {
  return '0x' + keccak256(Buffer.from(publicKey, 'hex')).subarray(12).toString('hex');
}

/** One relay app: the agent-wallet router and the hosted MCP route, behind the same trust-proxy setting as server.ts. */
function buildRelay(limiter: Limiter) {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453, last_processed_block: 130, membership_generation: 7, updated_at: 1,
  });
  const now = Date.now();
  expect(isValidConnectionTokenFormat(FLEET_CODE)).toBe(true);
  // A live, unconsumed fleet code issued by the human's linked agent (fleet-code.ts shape).
  fake.store.set(`connection_tokens/${FLEET_CODE}`, {
    token: FLEET_CODE, user_id: 'human-issuer', kind: 'fleet',
    issued_by_agent_wallet_id: 'wallet_aw_issuer', created_at: now - 60_000,
    expires_at: now + 3_600_000, used: false,
  });
  fake.store.set('wallets/wallet_human_issuer_1', {
    id: 'wallet_human_issuer_1', user_id: 'human-issuer', type: 'human',
    address: '0x8888888888888888888888888888888888888888', created_at: now - 20_000,
  });
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: limiter.checkRateLimit,
      getConnectionToken: async () => null,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: addressOf,
    readBaseRegistrationHead: async () => 140,
    processGenesisQualification: jest.fn(async () => ({ status: 'queued' })),
    genesisActivationApprovalVerifier: () => true,
  } as unknown as RouterDeps;

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  // The MCP tool's self-call lands back on this same app, in process, exactly as the
  // production loopback does: routes/mcp.ts sets X-Forwarded-For to the caller's IP.
  const selfFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    let req = request(app).post(url.pathname);
    headers.forEach((value, name) => { req = req.set(name, value); });
    const res = await req.send(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  mountMCPRoutes(app, { fetchImpl: selfFetch, getSelfBaseUrl: () => 'http://relay.test' });
  return { app, fake };
}

let seq = 0;
function freshIdentity() {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    publicKey: n.repeat(128 / 6 + 1).slice(0, 128).replace(/^./, 'a'),
    registrationId: `agent-registration-fleet-ip-${n}`,
    agentId: `fleet-ip-agent-${n}`,
  };
}

function createBody(id: ReturnType<typeof freshIdentity>, extra: Record<string, unknown> = {}) {
  return {
    registration_id: id.registrationId,
    agent_name: 'Fleet IP Agent',
    agent_id: id.agentId,
    platform: 'sdk',
    constitution_accepted_at: new Date(0).toISOString(),
    public_key: id.publicKey,
    challenge_id: `challenge-${id.agentId}`,
    signature: 'ab'.repeat(64),
    ...extra,
  };
}

/** Ordinary creations (no code) from `ip` — the "every other wallet creation" that fills the bucket. */
async function createOrdinary(app: express.Express, ip: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const res = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', ip).send(createBody(freshIdentity()));
    expect(res.status).toBe(201);
  }
}

function walletForAgent(fake: ReturnType<typeof createFakeFirestore>, agentId: string) {
  return [...fake.store.entries()].find(([k, d]) => k.startsWith('agent_wallets/') && d.agent_id === agentId);
}

function readRpc(res: request.Response) {
  if (res.type === 'text/event-stream') {
    const line = (res.text ?? '').split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice('data:'.length).trim()) : {};
  }
  return res.body;
}

async function mcpWalletCreate(app: express.Express, ip: string, id: ReturnType<typeof freshIdentity>) {
  const res = await request(app).post('/mcp').set('Accept', MCP_ACCEPT).set('X-Forwarded-For', ip)
    .send({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'wallet_create',
        arguments: {
          public_key: id.publicKey,
          challenge_id: `challenge-${id.agentId}`,
          signature: 'ab'.repeat(64),
          registration_id: id.registrationId,
          agent_id: id.agentId,
          agent_name: 'Fleet IP Agent',
          constitution_accepted_at: new Date(0).toISOString(),
          connection_token: FLEET_CODE,
        },
      },
    });
  expect(res.status).toBe(200);
  const result = readRpc(res).result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
}

// The route's own values (routes/agent-wallet.ts). If they move, the refusal tests fail loudly — never pass vacuously.
const MINUTE_LIMIT = 10;
const HOUR_LIMIT = 100;

describe('a fleet-code wallet creation counts against the per-IP wallet-creation limit', () => {
  beforeEach(() => { process.env.PUBLIC_LAUNCH = 'true'; });
  afterEach(() => { delete process.env.PUBLIC_LAUNCH; });

  test('the fleet creation is keyed on the same per-IP buckets as every creation', async () => {
    const limiter = makeCountingLimiter();
    const { app } = buildRelay(limiter);
    const res = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', EXHAUSTED_IP)
      .send(createBody(freshIdentity(), { connection_token: FLEET_CODE }));
    expect(res.status).toBe(201);
    expect(limiter.keysSeen).toEqual([`rl:aw-create:min:${EXHAUSTED_IP}`, `rl:aw-create:hr:${EXHAUSTED_IP}`]);
  });

  test('REST: once the IP has used its per-minute creations, a fleet-code creation is refused 429 and writes nothing', async () => {
    const limiter = makeCountingLimiter();
    const { app, fake } = buildRelay(limiter);
    await createOrdinary(app, EXHAUSTED_IP, MINUTE_LIMIT);

    const fleet = freshIdentity();
    const refused = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', EXHAUSTED_IP)
      .send(createBody(fleet, { connection_token: FLEET_CODE }));
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/per minute/);
    expect(walletForAgent(fake, fleet.agentId)).toBeUndefined();
    expect(fake.store.get(`connection_tokens/${FLEET_CODE}`)).toMatchObject({ used: false });

    // RED CONTROL: the identical fleet creation from a fresh IP goes through.
    const control = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', FRESH_IP)
      .send(createBody(fleet, { connection_token: FLEET_CODE }));
    expect(control.status).toBe(201);
    expect(walletForAgent(fake, fleet.agentId)).toBeDefined();
  });

  test('REST: once the IP has used its hourly creations, a fleet-code creation is refused 429', async () => {
    const limiter = makeCountingLimiter();
    const { app, fake } = buildRelay(limiter);
    // Fill the hour at the per-minute pace, so the per-minute bucket is fresh when the fleet agent arrives.
    for (let minute = 0; minute < HOUR_LIMIT / MINUTE_LIMIT; minute += 1) {
      await createOrdinary(app, EXHAUSTED_IP, MINUTE_LIMIT);
      limiter.advance(61_000);
    }
    const fleet = freshIdentity();
    const refused = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', EXHAUSTED_IP)
      .send(createBody(fleet, { connection_token: FLEET_CODE }));
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/per hour/);
    expect(walletForAgent(fake, fleet.agentId)).toBeUndefined();
  }, 60_000);

  test('MCP wallet_create: the self-call carries the caller IP, so an exhausted IP is refused there too', async () => {
    const limiter = makeCountingLimiter();
    const { app, fake } = buildRelay(limiter);
    await createOrdinary(app, EXHAUSTED_IP, MINUTE_LIMIT);

    const fleet = freshIdentity();
    const refused = await mcpWalletCreate(app, EXHAUSTED_IP, fleet);
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe('Wallet create failed with HTTP 429');
    expect(walletForAgent(fake, fleet.agentId)).toBeUndefined();

    // RED CONTROL: the same tool call from a fresh IP creates the wallet.
    const control = await mcpWalletCreate(app, FRESH_IP, fleet);
    expect(control.isError).toBe(false);
    expect(control.payload.wallet_id).toMatch(/^wallet_aw_/);
    expect(walletForAgent(fake, fleet.agentId)).toBeDefined();
  });

  test('RED CONTROL: with a limiter that never refuses, the same post-exhaustion fleet creation succeeds', async () => {
    const counting = makeCountingLimiter();
    const permissive: Limiter = {
      checkRateLimit: async (key, limit, windowSec) => {
        await counting.checkRateLimit(key, limit, windowSec);
        return { allowed: true, retryAfter: 0 };
      },
    };
    const { app, fake } = buildRelay(permissive);
    await createOrdinary(app, EXHAUSTED_IP, MINUTE_LIMIT);
    const fleet = freshIdentity();
    const res = await request(app).post('/v1/agent/wallet/create')
      .set('X-Forwarded-For', EXHAUSTED_IP)
      .send(createBody(fleet, { connection_token: FLEET_CODE }));
    expect(res.status).toBe(201);
    expect(walletForAgent(fake, fleet.agentId)).toBeDefined();
  });
});
