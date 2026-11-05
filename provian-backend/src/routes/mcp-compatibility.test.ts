/**
 * Mounted-route fixtures: REST owns response size and execution duration.
 * control: this exact suite copied onto 8dd9fe3 fails all 26 cases;
 * the original 200/800-element admission controls remain in mcp-budget.test.ts.
 * Timed fixtures advance a virtual clock, except the real 11-second HTTP leg.
 */
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { mountMCPRoutes } from './mcp';
import { THREAD_LIMITS } from '../core/commons/threads';
import { COMMONS_SAFETY_LIMITS } from '../core/commons/types';
import { BURN_RECORD_MAX_WAIT_MS } from '../core/presentation/burn-record';
import { MAX_PE_FACT_CLAIMS, PREDICATE_SET_MAX } from '../core/presentation/types';
import { DISCLOSURE_REQUESTS_MAX, DISCLOSURE_RECORDS_MAX_TOTAL, DISCLOSURE_RECORD_MAX_BYTES } from '../core/presentation/disclosure-request';
import { PAYOUT_CHARGE_CONFIRM_WAIT_MS } from '../core/payout/on-demand-payout';
import { USDC_CHARGE_CONFIRM_WAIT_MS } from '../core/payments/usdc-charge';
import { normalizePredicateRequests } from '../core/presentation/disclosure';

const limiter = jest.fn(async (..._args: unknown[]) => ({ allowed: true }));
jest.mock('../cache', () => ({ cache: { checkRateLimit: (...args: unknown[]) => limiter(...args) } }));
const WALLET = 'wallet_aw_fixture';
const TX = '0x' + 'a'.repeat(64);
const AUTH = 'Bearer pvn_live_fixture:pvns_fixture';
type Body = Record<string, unknown>;
type RpcReply = { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };
const rpc = (name: string, args: Body = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function mounted(fetchImpl: typeof fetch) {
  const app = express(); app.use(express.json({ limit: '220kb' }));
  mountMCPRoutes(app, { fetchImpl }); return app;
}
function post(app: express.Express, body: object) {
  return request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
    .set('Authorization', AUTH).send(body);
}
function result(res: request.Response): RpcReply {
  return res.type === 'text/event-stream'
    ? JSON.parse(res.text.split('\n').find(line => line.startsWith('data:'))!.slice(5)) : res.body;
}
function success(res: request.Response): Body {
  expect(res.status).toBe(200);
  const reply = result(res); expect(reply.result.isError).not.toBe(true);
  return JSON.parse(reply.result.content[0].text);
}
beforeEach(() => { process.env.MCP_AGENT_ONBOARDING = 'true'; limiter.mockClear(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); delete process.env.MCP_AGENT_ONBOARDING; });

it.each([3, 16])('runs all %i tiny tool calls in order and charges every element', async count => {
  const seen: number[] = [];
  let active = 0;
  const app = mounted(async input => {
    expect(active++).toBe(0);
    const n = Number(String(input).split('/').pop()); seen.push(n);
    await new Promise<void>(resolve => setImmediate(resolve)); active--;
    return json({ n });
  });
  const res = await post(app, Array.from({ length: count }, (_, i) => rpc('genesis_status', { wallet_id: String(i) }, i)));
  expect(res.status).toBe(200); expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
  expect(res.body.map((r: RpcReply) => [r.id, JSON.parse(r.result.content[0].text).n])).toEqual(seen.map(n => [n, n]));
  expect(limiter.mock.calls.every(args => args[3] === count)).toBe(true);
  expect(limiter).toHaveBeenCalled();
});

it('streams a full batch whose aggregate results exceed the old 1 MiB reservation', async () => {
  const payload = 'x'.repeat(70_000);
  const res = await post(mounted(async () => json({ payload })), Array.from({ length: 16 }, (_, id) => rpc('genesis_status', { wallet_id: WALLET }, id)));
  expect(res.status).toBe(200); expect(res.body).toHaveLength(16);
  for (const reply of res.body as RpcReply[]) {
    expect(reply.result.isError).not.toBe(true); expect(JSON.parse(reply.result.content[0].text).payload).toBe(payload);
  }
});

const message = (i: number) => ({ created_at: i, ciphertexts: { [WALLET]: 'a'.repeat(THREAD_LIMITS.ciphertextMaxLen), other: 'b'.repeat(THREAD_LIMITS.ciphertextMaxLen) } });
it('returns one permitted ciphertext even with JSON framing beyond 64 KiB', async () => {
  const m = { ciphertexts: { fixture: 'a'.repeat(THREAD_LIMITS.ciphertextMaxLen) } };
  const body = { messages: [m] };
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024);
  expect(success(await post(mounted(async () => json(body)), rpc('read_threads', { thread_id: 'fixture', limit: 1 }))).messages).toEqual([m]);
});
it('returns every byte of a 200-message page with maximum ciphertexts for both parties', async () => {
  const messages = Array.from({ length: THREAD_LIMITS.pageMax }, (_, i) => message(i + 1));
  const app = mounted(async () => json({ messages, count: messages.length }));
  const out = success(await post(app, rpc('read_threads', { thread_id: 'fixture', limit: THREAD_LIMITS.pageMax })));
  expect(out.messages).toEqual(messages);
});

it.each([701, 2501])('mark_read retrieves the entire %i-message backlog before writing the cursor', async count => {
  const calls: string[] = [];
  const app = mounted(async (input, init) => {
    const url = new URL(String(input)); calls.push(init?.method + url.pathname + url.search);
    if (init?.method === 'POST') { expect(calls.length).toBeGreaterThan(8); return json({ read: true }); }
    const before = Number(url.searchParams.get('before') ?? count + 1);
    const messages = Array.from({ length: count }, (_, i) => ({ created_at: i + 1 })).filter(m => m.created_at < before).slice(-100);
    return json({ thread: { last_message_at: count }, read_cursor: 0, messages });
  });
  const out = success(await post(app, rpc('read_threads', { thread_id: 'fixture', mark_read: true })));
  expect((out.messages as unknown[]).length).toBe(count); expect(calls.at(-1)).toContain('POST/v1/threads/fixture/read');
});

const jobs = Array.from({ length: 100 }, (_, i) => ({ job_id: String(i), description: 'x'.repeat(COMMONS_SAFETY_LIMITS.MAX_HUMAN_JOB_DESCRIPTION_LENGTH) }));
it('returns all 100 full job descriptions', async () => {
  const out = success(await post(mounted(async () => json({ jobs })), rpc('browse_jobs', { page_size: 100 })));
  expect(out.jobs).toEqual(jobs);
});

it.each(['deliver_job', 'release_job'])('%s preserves a committed party-facing 20,000-character deliverable', async name => {
  const body = { job_id: 'fixture', description: '語'.repeat(5000), deliverable: { body: '語'.repeat(20_000), sha256: 'a'.repeat(64) } };
  let committed = false;
  const app = mounted(async (_input, init) => { expect(init?.method).toBe('POST'); committed = true; return json(body); });
  const out = success(await post(app, rpc(name, { job_id: 'fixture', step: 'record', deliverable_body: body.deliverable.body })));
  expect(committed).toBe(true); expect(out).toEqual(body);
});

it.each(['send_thread_message', 'open_thread'])('%s returns the committed message at both ciphertext limits', async name => {
  let committed = false; const m = message(1);
  const app = mounted(async (_input, init) => { expect(init?.method).toBe('POST'); committed = true; return json({ message: m }); });
  const out = success(await post(app, rpc(name, { thread_id: 'fixture', anchor_kind: 'job', anchor_id: 'fixture', counterparty: 'other', ciphertexts: m.ciphertexts, content_sha256: 'a'.repeat(64) })));
  expect(committed).toBe(true); expect(out.message).toEqual(m);
});

const predicates = Array.from({ length: PREDICATE_SET_MAX }, (_, i) => ({ field: `work.field_${i}`, op: 'in', set: Array.from({ length: PREDICATE_SET_MAX }, (_, n) => 1.23456789012345e100 + n * 1e90) }));
const disclosures = Array.from({ length: DISCLOSURE_REQUESTS_MAX }, (_, i) => ({ kind: 'pe', output_digest: i.toString(16).padStart(64, '0') }));
it.each(['present_challenge', 'request_presentation_in_thread'])('%s retains maximum predicate/disclosure sets after the write', async name => {
  expect(normalizePredicateRequests(predicates)).not.toBeNull();
  const envelope = { v: 1, audience: WALLET, challenge: 'a'.repeat(64), predicates, disclosures, issuedAt: 1790000000, expiresAt: 1790000900, requester: { type: 'wallet', id: WALLET, kid: 'fixture' }, sig: 'x'.repeat(86) };
  let committed = false;
  const body = name === 'present_challenge' ? { challenge: envelope } : { request: { predicates, challenge_envelope: envelope }, message: { attachment: { predicates, challenge_envelope: envelope } } };
  const app = mounted(async () => { committed = true; return json(body); });
  const out = success(await post(app, rpc(name, { wallet_id: WALLET, thread_id: 'fixture', predicates, ...(name === 'present_challenge' ? { disclosures } : {}) })));
  expect(committed).toBe(true);
  if (name === 'present_challenge') expect(out.challenge_envelope).toEqual(envelope); else expect(out).toEqual(body);
});

it('returns 50 maximum-size disclosed records without a tool-result reservation cap', async () => {
  const records = Array.from({ length: DISCLOSURE_RECORDS_MAX_TOTAL }, (_, i) => ({ pe_id: String(i), content: 'x'.repeat(DISCLOSURE_RECORD_MAX_BYTES - 100) }));
  const body = { valid: true, disclosures: records };
  const out = success(await post(mounted(async () => json(body)), rpc('verify_presentation', { token: 'fixture', audience: WALLET, challenge: 'a'.repeat(64), accept_once: false })));
  expect(out.disclosures).toEqual(records);
});

it.each(['vouch', 'list_approval_requests', 'my_challenges', 'feature_item'])('%s preserves an unpaginated result larger than the former aggregate cap', async name => {
  const rows = Array.from({ length: 5000 }, (_, id) => ({ id, detail: 'fixture'.repeat(40) }));
  const keys: Record<string, string> = { vouch: 'vouches', list_approval_requests: 'requests', my_challenges: 'challenges', feature_item: 'featured' };
  const key = keys[name];
  let committed = false;
  const app = mounted(async (_input, init) => { if (init?.method === 'POST') committed = true; return json({ [key]: rows }); });
  const args = name === 'vouch' ? { action: 'list_mine', wallet_id: WALLET } : name === 'feature_item' ? { board: 'jobs', item_id: 'fixture', burn_id: 'a'.repeat(64) } : { wallet_id: WALLET };
  expect(success(await post(app, rpc(name, args)))[key]).toEqual(rows);
  if (name === 'feature_item') expect(committed).toBe(true);
});

const preSignedPresent = { wallet_id: WALLET, tier: 'reputation', audience: 'fixture', challenge: 'a'.repeat(64), agent_address: '0x' + '1'.repeat(40), pop_signature: 'a'.repeat(128), pop_pubkey: '02' + '1'.repeat(64), jti: 'fixture', iat: 1790000000, exp: 1790000900, burn_tx_hash: TX, burn_amount_atomic: '1' };
it.each([
  ['record_burn', { wallet_id: WALLET, tx_hash: TX, amount_atomic: '1' }, [BURN_RECORD_MAX_WAIT_MS]],
  ['present', preSignedPresent, [BURN_RECORD_MAX_WAIT_MS]],
  ['verify_presentation', { token: 'fixture', audience: WALLET, challenge: 'a'.repeat(64), accept_once: false }, Array(MAX_PE_FACT_CLAIMS).fill(30_000)],
  ['pe_archive', { action: 'pay', wallet_id: WALLET, payment: 'fixture-payment' }, [30_000, USDC_CHARGE_CONFIRM_WAIT_MS]],
  ['request_payout', { wallet_id: WALLET, payment: 'fixture-payment' }, [PAYOUT_CHARGE_CONFIRM_WAIT_MS]],
  ['genesis_status', { wallet_id: WALLET }, [11_000]],
] as Array<[string, Body, number[]]>)('%s permits the REST wait and returns the committed outcome', async (name, args, waits) => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance'] });
  // Make any accidental AbortSignal.timeout deterministic under this virtual clock too.
  jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new Error('fixture deadline')), ms); return c.signal; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let completed = 0; let committed = false;
  const app = mounted(async (_input, init) => {
    committed = init?.method === 'POST';
    entered();
    for (const ms of waits) { await new Promise<void>(resolve => setTimeout(resolve, ms)); completed++; }
    if (init?.signal?.aborted) throw init.signal.reason;
    return json({ ok: true, completed });
  });
  const pending = post(app, rpc(name, args)).then(res => res);
  await started; await jest.advanceTimersByTimeAsync(waits.reduce((a, b) => a + b, 0) + 1);
  expect(success(await pending)).toMatchObject({ ok: true, completed: waits.length });
  expect(completed).toBe(waits.length);
  if (name !== 'genesis_status') expect(committed).toBe(true);
});

it('modern protocol returns a delayed, oversized committed write through the production HTTP client', async () => {
  const payload = 'x'.repeat(300_000);
  let committed = false;
  const rest = createServer((req, res) => {
    expect(req.method).toBe('POST'); expect(req.headers.authorization).toBe(AUTH);
    req.resume(); committed = true;
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ payload })); }, 11_000);
  });
  await new Promise<void>(resolve => rest.listen(0, '127.0.0.1', resolve));
  try {
    const address = rest.address(); if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    const app = express(); app.use(express.json());
    mountMCPRoutes(app, { getSelfBaseUrl: () => `http://127.0.0.1:${address.port}` });
    const body = rpc('deliver_job', { job_id: 'fixture', deliverable_body: 'fixture' });
    const modern = { ...body, params: { ...body.params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } };
    const res = await post(app, modern).set('Mcp-Protocol-Version', '2026-07-28').set('Mcp-Method', 'tools/call').set('Mcp-Name', 'deliver_job');
    expect(committed).toBe(true); expect(success(res).payload).toBe(payload);
  } finally { await new Promise<void>((resolve, reject) => rest.close(err => err ? reject(err) : resolve())); }
}, 20_000);
