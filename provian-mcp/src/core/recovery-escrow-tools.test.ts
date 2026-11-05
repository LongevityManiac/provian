/**
 * at birth over MCP (OPEN_ITEMS L381): a hosted agent learns its birth anchor at
 * wallet_challenge (when it has a link code), seals its OWN key in its own runtime, and wallet_create
 * creates the wallet AND escrows the ciphertext in one call, with the credential the create just
 * issued. escrow_target / recovery_escrow cover the agent that could not escrow at birth.
 *
 * RED controls in-suite: no anchor → nothing posted; a blob sealed to a different anchor → never
 * posted; remote recovery_escrow without a blob → refused before any call (the hosted endpoint
 * never seals, never takes a key); a refused escrow is reported, and the credential still returned.
 */
import { describe, expect, it } from 'vitest';
import { callProvianTool, findTool } from './tools';
import { findPrivateKeyFields } from './key-custody';
import { keccak256 } from './keccak256';
import { sealToRecoveryAnchor } from './recovery-seal';
import type { ToolContext } from './types';

type Call = { url: string; method: string; headers: Headers; body: string };
const ANCHOR = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw';
const OTHER = 'A'.repeat(42) + 'E';
const PUB = 'ab'.repeat(64);
const ADDRESS = '0x' + keccak256(Buffer.from(PUB, 'hex')).subarray(12).toString('hex');
const API_KEY = `pvn_live_${'a'.repeat(32)}`;
const API_SECRET = `pvns_${'b'.repeat(64)}`;
const BLOB = sealToRecoveryAnchor(ANCHOR, '11'.repeat(32));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function parse(r: { content: Array<{ text: string }> }) { return JSON.parse(r.content[0].text) as Record<string, any>; }

function ctxWith(respond: (c: Call) => Response, extra: Partial<ToolContext> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const ctx: ToolContext = { baseUrl: 'https://relay.test', fetchImpl, auth: null, mode: 'remote', ...extra };
  return { ctx, calls };
}

const createdBody = (anchor: string | null) => ({
  wallet_id: 'wallet_aw_birth0001', address: ADDRESS, public_key: PUB, api_key: API_KEY, api_secret: API_SECRET,
  ...(anchor ? { recovery_anchor_pubkey: anchor } : {}),
});
const createArgs = (extra: Record<string, unknown> = {}) => ({
  public_key: PUB, challenge_id: 'ch_1', signature: '3045' + 'ab'.repeat(20), agent_name: 'Hosted Agent',
  constitution_accepted_at: '2026-09-27T00:00:00.000Z', connection_token: 'PROV-FLTC-6789', ...extra,
});

describe('wallet_challenge names the birth anchor when given the link code', () => {
  it('forwards the code (read-only) and returns the anchor + the sealing recipe', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { challenge_id: 'ch', challenge: 'c'.repeat(64), recovery_anchor_pubkey: ANCHOR }));
    const out = parse(await callProvianTool('wallet_challenge', { public_key: PUB, connection_token: 'PROV-FLTC-6789' }, ctx));
    expect(new URL(calls[0].url).searchParams.get('connection_token')).toBe('PROV-FLTC-6789');
    expect(out.recovery_anchor_pubkey).toBe(ANCHOR);
    expect(out.recovery_seal.steps.join(' ')).toMatch(/provian-agent-recovery-v1/);
    expect(String(out.next)).toMatch(/sealed_key_blob/);
  });

  it('RED CONTROL: no anchor on the relay answer → null, no recipe', async () => {
    const { ctx } = ctxWith(() => json(200, { challenge_id: 'ch', challenge: 'c'.repeat(64) }));
    const out = parse(await callProvianTool('wallet_challenge', { public_key: PUB }, ctx));
    expect(out.recovery_anchor_pubkey).toBeNull();
    expect(out).not.toHaveProperty('recovery_seal');
  });
});

describe('wallet_create creates AND escrows in one call', () => {
  it('posts the sealed blob to /recovery-escrow with the credential the create just issued', async () => {
    const { ctx, calls } = ctxWith((c) => (c.url.endsWith('/create') ? json(201, createdBody(ANCHOR)) : json(200, { stored: true })));
    const out = parse(await callProvianTool('wallet_create', createArgs({ sealed_key_blob: BLOB, recovery_anchor_pubkey: ANCHOR }), ctx));
    expect(out.recovery).toEqual({ escrowed: true, recovery_anchor_pubkey: ANCHOR });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/agent/wallet/create', '/v1/agent/wallet/wallet_aw_birth0001/recovery-escrow',
    ]);
    expect(calls[1].headers.get('authorization')).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
    expect(JSON.parse(calls[1].body)).toEqual({ sealed_key_blob: BLOB, recovery_anchor_pubkey: ANCHOR });
    // The create body never carries the blob (escrow is its own, authenticated call).
    expect(JSON.parse(calls[0].body)).not.toHaveProperty('sealed_key_blob');
    expect(out.connector_credential).toBe(`${API_KEY}:${API_SECRET}`);
  });

  it('RED CONTROL: sealed to a DIFFERENT anchor than the create named → never posted, told to re-seal', async () => {
    const { ctx, calls } = ctxWith(() => json(201, createdBody(ANCHOR)));
    const out = parse(await callProvianTool('wallet_create', createArgs({ sealed_key_blob: BLOB, recovery_anchor_pubkey: OTHER }), ctx));
    expect(calls).toHaveLength(1);
    expect(out.recovery).toMatchObject({ escrowed: false, reason: 'sealed_to_a_different_anchor', recovery_anchor_pubkey: ANCHOR });
  });

  it('RED CONTROL: no anchor at birth → nothing posted; the next step names escrow_target', async () => {
    const { ctx, calls } = ctxWith(() => json(201, createdBody(null)));
    const out = parse(await callProvianTool('wallet_create', createArgs({ sealed_key_blob: BLOB, recovery_anchor_pubkey: ANCHOR }), ctx));
    expect(calls).toHaveLength(1);
    expect(out.recovery).toMatchObject({ escrowed: false, reason: 'no_recovery_anchor_at_birth' });
  });

  it('an anchor but no blob → not posted; the response names the anchor and the recipe to escrow now', async () => {
    const { ctx, calls } = ctxWith(() => json(201, createdBody(ANCHOR)));
    const out = parse(await callProvianTool('wallet_create', createArgs(), ctx));
    expect(calls).toHaveLength(1);
    expect(out.recovery).toMatchObject({ escrowed: false, reason: 'not_sealed_yet', recovery_anchor_pubkey: ANCHOR });
    expect(out.recovery_seal).toBeDefined();
  });

  it('a refused escrow is reported, and the wallet credential is still returned (shown once)', async () => {
    const { ctx } = ctxWith((c) => (c.url.endsWith('/create') ? json(201, createdBody(ANCHOR)) : json(403, { error: 'recovery_anchor_not_recognized' })));
    const out = parse(await callProvianTool('wallet_create', createArgs({ sealed_key_blob: BLOB, recovery_anchor_pubkey: ANCHOR }), ctx));
    expect(out.recovery).toMatchObject({ escrowed: false, reason: 'relay_refused_escrow', relay_status: 403 });
    expect(out.connector_credential).toBe(`${API_KEY}:${API_SECRET}`);
  });

  it('a blob without the anchor it was sealed to is refused before any call', async () => {
    const { ctx, calls } = ctxWith(() => json(201, createdBody(ANCHOR)));
    const r = await callProvianTool('wallet_create', createArgs({ sealed_key_blob: BLOB }), ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('escrow_target / recovery_escrow', () => {
  const auth = { apiKey: API_KEY, apiSecret: API_SECRET };

  it('recovery_escrow (remote) posts only the ciphertext with the connection credential', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { stored: true }), { auth });
    const out = parse(await callProvianTool('recovery_escrow', { wallet_id: 'wallet_aw_birth0001', sealed_key_blob: BLOB, recovery_anchor_pubkey: ANCHOR }, ctx));
    expect(out).toEqual({ escrowed: true, recovery_anchor_pubkey: ANCHOR });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
  });

  it('RED CONTROL: remote recovery_escrow without a blob is refused before any call (the hosted endpoint never seals)', async () => {
    const { ctx, calls } = ctxWith(() => json(200, {}), { auth });
    const r = await callProvianTool('recovery_escrow', { wallet_id: 'wallet_aw_birth0001', recovery_anchor_pubkey: ANCHOR }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(r.content[0].text).toMatch(/holds no key/);
  });

  it('a relay refusal (recovery_anchor_not_recognized) surfaces as an error', async () => {
    const { ctx } = ctxWith(() => json(403, { error: 'recovery_anchor_not_recognized' }), { auth });
    const r = await callProvianTool('recovery_escrow', { wallet_id: 'wallet_aw_birth0001', sealed_key_blob: BLOB, recovery_anchor_pubkey: OTHER }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/recovery_anchor_not_recognized/);
  });

  it('local mode: no blob → reads escrow_target and seals IN-PROCESS with the local identity', async () => {
    let sealedWith: string | null = null;
    const { ctx, calls } = ctxWith(
      (c) => (c.method === 'GET' ? json(200, { wallet_id: 'wallet_aw_birth0001', escrowed: false, recovery_anchor_pubkey: ANCHOR }) : json(200, { stored: true })),
      {
        auth,
        mode: 'local',
        withLocalSovereignIdentity: (fn) => fn({
          address: ADDRESS, walletId: 'wallet_aw_birth0001', pubkey: PUB,
          signEip191: () => '', signPop: () => '',
          sealRecoveryKey: (anchor: string) => { sealedWith = anchor; return BLOB; },
        }),
      },
    );
    const out = parse(await callProvianTool('recovery_escrow', { wallet_id: 'wallet_aw_birth0001' }, ctx));
    expect(out.escrowed).toBe(true);
    expect(sealedWith).toBe(ANCHOR);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/agent/wallet/wallet_aw_birth0001/escrow-target',
      'POST /v1/agent/wallet/wallet_aw_birth0001/recovery-escrow',
    ]);
  });

  it('escrow_target forwards with the credential and adds the recipe when an anchor is named', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { wallet_id: 'w', escrowed: false, recovery_anchor_pubkey: ANCHOR }), { auth });
    const out = parse(await callProvianTool('escrow_target', { wallet_id: 'wallet_aw_birth0001' }, ctx));
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
    expect(out.recovery_seal).toBeDefined();
  });

  it('key custody: none of the new inputs names private key material', () => {
    for (const name of ['wallet_create', 'wallet_challenge', 'recovery_escrow', 'escrow_target']) {
      expect(findPrivateKeyFields(findTool(name)!.inputSchema)).toEqual([]);
    }
  });
});

describe('local create_wallet seals in-process and escrows at birth', () => {
  async function run(anchor: string | null) {
    const { generateAgentKeyPair } = await import('./crypto');
    const kp = generateAgentKeyPair();
    const calls: Call[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') };
      calls.push(call);
      if (call.url.includes('/challenge')) return json(200, { challenge_id: 'ch', challenge: 'sign-me' });
      if (call.url.endsWith('/create')) {
        return json(201, {
          wallet_id: 'wallet_aw_local0001', address: kp.address, public_key: kp.publicKey, api_key: API_KEY, api_secret: API_SECRET,
          ...(anchor ? { recovery_anchor_pubkey: anchor } : {}),
        });
      }
      return json(200, { stored: true });
    }) as typeof fetch;
    const ctx = {
      baseUrl: 'https://relay.test', fetchImpl, auth: null, mode: 'local',
      persistCredentials: () => '/tmp/creds.json',
      loadCompletedAgentWalletRegistration: () => null,
      loadOrCreatePendingAgentWalletRegistration: () => ({
        registrationId: 'mcp-agent-registration-birth-escrow-01', agentId: 'local-birth', agentName: 'Local',
        platform: 'mcp', constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
        privateKey: kp.privateKey, publicKey: kp.publicKey, address: kp.address,
      }),
      reloadPendingAgentWalletRegistration: (_c: unknown, e: unknown) => ({ ...(e as object) }),
      completePendingAgentWalletRegistration: () => '/tmp/id.json',
    } as unknown as ToolContext;
    const out = parse(await callProvianTool('create_wallet', { agent_name: 'Local', connection_token: 'PROV-FLTC-6789' }, ctx));
    return { out, calls, kp };
  }

  it('the create named an anchor → the key is sealed here and only ciphertext is posted, with the new credential', async () => {
    const { out, calls, kp } = await run(ANCHOR);
    expect(out.recovery).toEqual({ escrowed: true, recovery_anchor_pubkey: ANCHOR });
    const escrow = calls.find((c) => c.url.endsWith('/recovery-escrow'))!;
    expect(escrow.headers.get('authorization')).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
    const body = JSON.parse(escrow.body) as { sealed_key_blob: string; recovery_anchor_pubkey: string };
    expect(body.recovery_anchor_pubkey).toBe(ANCHOR);
    expect(Buffer.from(body.sealed_key_blob, 'base64url')).toHaveLength(81);
    for (const c of calls) expect(c.body).not.toContain(kp.privateKey.replace(/^0x/, ''));
    expect(JSON.stringify(out)).not.toContain(kp.privateKey.replace(/^0x/, ''));
  });

  it('RED CONTROL: no anchor at birth → no escrow call, recovery says why', async () => {
    const { out, calls } = await run(null);
    expect(calls.some((c) => c.url.endsWith('/recovery-escrow'))).toBe(false);
    expect(out.recovery).toMatchObject({ escrowed: false, reason: 'no_recovery_anchor_at_birth' });
  });
});
