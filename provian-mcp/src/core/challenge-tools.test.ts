/**
 * on the MCP surface — signed challenges, verify-before-burn, v2 binding, accept-once.
 *
 * Each behavioral assertion is paired with the input that must flip it : an invalid /
 * expired / wrongly addressed signed challenge must refuse `present` WITHOUT a relay call, and a
 * second verify of one presentation must say `replayed` while a different presentation does not.
 */

import { createHash, createPrivateKey, sign as edSign } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callProvianTool, findTool } from './tools';
import type { ToolContext } from './types';
import { challengeSigningString, type ChallengeEnvelope, type RequesterJwk } from './challenge';
import { presentationBindingString, claimsDigest, canonicalReputationDirective } from './presentation';

const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const X = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const ME = '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5';
const OTHER = '0x' + '1'.repeat(40);
const NOW = 1790000100;
const DOMAIN_KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: X, kid: 'k1' }];
const AUTH = { apiKey: 'pvn_live_' + 'a'.repeat(32), apiSecret: 'pvns_' + 'b'.repeat(64) };

const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});

/** Sign a domain envelope with the pinned test key (the gate's own key, as the SDK would). */
function signedDomainEnvelope(over: Partial<ChallengeEnvelope> = {}): ChallengeEnvelope {
  const base = {
    v: 1,
    audience: 'gate.example.com',
    challenge: 'a'.repeat(64),
    predicates: [{ field: 'work.total', op: 'gte' as const, threshold: 10 }],
    issuedAt: 1790000000,
    expiresAt: 1790000900,
    presenter: ME,
    requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'k1' },
    ...over,
  };
  const sig = edSign(null, Buffer.from(challengeSigningString({
    audience: base.audience, challenge: base.challenge, issuedAt: base.issuedAt, expiresAt: base.expiresAt,
    requester: base.requester, presenter: base.presenter, predicates: base.predicates,
  }), 'utf8'), priv).toString('base64url');
  return { ...base, sig };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call { url: string; method: string; body: Record<string, unknown> | null }

function ctxWith(routes: (url: string, init?: RequestInit) => Response | null, over: Partial<ToolContext> = {}) {
  const calls: Call[] = [];
  const signed: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return routes(url, init) ?? json(500, { error: 'unexpected call ' + url });
  }) as unknown as typeof fetch;
  const ctx: ToolContext = {
    baseUrl: 'https://relay.test',
    fetchImpl,
    auth: AUTH,
    mode: 'local',
    fetchRequesterKeys: async () => DOMAIN_KEYS,
    withLocalSovereignIdentity: (<T>(fn: (id: {
      address: string; walletId: string; pubkey: string;
      signEip191: (m: string) => string; signPop: (b: string) => string;
    }) => T): T => fn({
      address: ME,
      walletId: 'wallet_aw_me',
      pubkey: 'ab'.repeat(64),
      signEip191: () => { throw new Error('unused'); },
      signPop: (b) => { signed.push(b); return 'deadbeef'; },
    })) as ToolContext['withLocalSovereignIdentity'],
    ...over,
  };
  return { ctx, calls, signed };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => { vi.useRealTimers(); });

describe('present_challenge — signs via the relay when credentials exist, says UNSIGNED otherwise', () => {
  it('with credentials: calls the relay challenge endpoint and returns its signed wire envelope', async () => {
    const relayEnvelope = { v: 1, audience: 'wallet_aw_me', challenge: 'c'.repeat(64), issuedAt: NOW, expiresAt: NOW + 900,
      requester: { type: 'wallet', id: 'wallet_aw_me', address: ME, kid: 'kid1' }, sig: 'x'.repeat(86) };
    const { ctx, calls } = ctxWith((url) => url.endsWith('/v1/agent/wallet/wallet_aw_me/present/challenge')
      ? json(200, { challenge: relayEnvelope }) : null);
    const r = await callProvianTool('present_challenge', {
      wallet_id: 'wallet_aw_me', predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }], ttl_seconds: 600, presenter: OTHER,
    }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }], ttl_seconds: 600, presenter: OTHER });
    const out = parse(r);
    expect(out.signed).toBe(true);
    expect(out.challenge_envelope).toEqual(relayEnvelope);
  });

  it('without credentials: a local challenge in the wire shape, plainly UNSIGNED, no network', async () => {
    const { ctx, calls } = ctxWith(() => null, { auth: null });
    const r = await callProvianTool('present_challenge', { audience: 'my-gate', ttl_seconds: 120 }, ctx);
    expect(r.isError).not.toBe(true);
    const out = parse(r);
    const env = out.challenge_envelope as Record<string, unknown>;
    expect(out.signed).toBe(false);
    expect(String(out.warning)).toMatch(/UNSIGNED/);
    expect(env).toMatchObject({ audience: 'my-gate', issuedAt: NOW, expiresAt: NOW + 120 });
    expect(env.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(env.sig).toBeUndefined();
    expect(env.requester).toBeUndefined();
    expect(env).not.toHaveProperty('issued_at');
    expect(calls).toHaveLength(0);
  });
});

describe('check_challenge — the pure pre-burn verdict', () => {
  it('is registered as a no-auth tool', () => {
    expect(findTool('check_challenge')?.requiresAuth).toBe(false);
  });

  it('verified for a good signed domain challenge; no relay call for a domain requester', async () => {
    const { ctx, calls } = ctxWith(() => null);
    const out = parse(await callProvianTool('check_challenge', { challenge_envelope: JSON.stringify(signedDomainEnvelope()) }, ctx));
    expect(out.status).toBe('verified');
    expect(out.requester).toMatchObject({ status: 'verified', identity: { type: 'domain', id: 'gate.example.com' } });
    expect(out.may_present).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('unverified for a legacy pair; invalid for a tampered signature (RED control)', async () => {
    const { ctx } = ctxWith(() => null);
    const legacy = parse(await callProvianTool('check_challenge', { audience: 'gate.example.com', challenge: 'a'.repeat(64) }, ctx));
    expect(legacy.status).toBe('unverified');
    expect(legacy.may_present).toBe(true);
    const bad = parse(await callProvianTool('check_challenge', { challenge_envelope: { ...signedDomainEnvelope(), challenge: 'f'.repeat(64) } }, ctx));
    expect(bad.status).toBe('invalid');
    expect(bad.may_present).toBe(false);
  });

  it('next_step names the requester once (RED: the display already carries the "Requester:" label)', async () => {
    const { ctx } = ctxWith(() => null);
    const out = parse(await callProvianTool('check_challenge', { audience: 'gate.example.com', challenge: 'a'.repeat(64) }, ctx));
    expect(out.next_step).toMatch(/^Requester: gate\.example\.com/);
    expect(out.next_step).not.toMatch(/Requester: Requester:/);
  });

  it('a wallet requester is checked against the Provian JWKS (the only fetch)', async () => {
    const walletEnv = {
      v: 1, audience: 'wallet_aw_test1', challenge: 'b'.repeat(64), issuedAt: 1790000000, expiresAt: 1790003600,
      requester: { type: 'wallet', id: 'wallet_aw_test1', address: ME, kid: 'provian-commerce-2026-08a' },
      sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
    };
    const { ctx, calls } = ctxWith((url) => url === 'https://relay.test/v1/present/jwks'
      ? json(200, { keys: [{ kty: 'OKP', crv: 'Ed25519', x: X, kid: 'provian-commerce-2026-08a' }] }) : null);
    const out = parse(await callProvianTool('check_challenge', { challenge_envelope: walletEnv }, ctx));
    expect(out.status).toBe('verified');
    expect(out.requester).toMatchObject({ identity: { type: 'wallet', id: 'wallet_aw_test1', address: ME } });
    expect(calls.map((c) => c.url)).toEqual(['https://relay.test/v1/present/jwks']);
  });
});

describe('present — verdict BEFORE any relay present call', () => {
  const presentArgs = { wallet_id: 'wallet_aw_me', burn_id: 'burn_1', tier: 'reputation' };

  it.each([
    ['invalid (tampered)', () => ({ ...signedDomainEnvelope(), challenge: 'f'.repeat(64) }), 'invalid'],
    ['expired', () => signedDomainEnvelope({ issuedAt: NOW - 1000, expiresAt: NOW - 100 }), 'expired'],
    ['not addressed to me', () => signedDomainEnvelope({ presenter: OTHER }), 'not_addressed'],
  ])('refuses a %s signed challenge with no relay call and nothing signed', async (_label, env, status) => {
    const { ctx, calls, signed } = ctxWith(() => json(200, { token: 't' }));
    const r = await callProvianTool('present', { ...presentArgs, challenge_envelope: env() }, ctx);
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ requester: { status } });
    expect(calls).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it('a verified signed challenge: sends challenge_envelope, signs the v2 binding, reports the requester', async () => {
    const env = signedDomainEnvelope();
    const { ctx, calls, signed } = ctxWith((url) => url.endsWith('/present') ? json(200, { tier: 'reputation', token: 'tok' }) : null);
    const r = await callProvianTool('present', { ...presentArgs, challenge_envelope: env }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    const body = calls[0].body!;
    expect(body.challenge_envelope).toEqual(env);
    expect(body.audience).toBe('gate.example.com');
    expect(body.challenge).toBe('a'.repeat(64));
    // The envelope's predicate is folded into the disclosure so the relay can answer it.
    expect(body.disclosure).toEqual(canonicalReputationDirective({ redact: [], predicates: env.predicates }));
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(presentationBindingString({
      tier: 'reputation', presenterAddress: ME, aud: 'gate.example.com', chal: 'a'.repeat(64),
      iat: body.iat as number, exp: body.exp as number, jti: body.jti as string, burnId: 'burn_1',
      claimsDigest: claimsDigest({ tier: 'reputation', directive: { redact: [], predicates: env.predicates } }),
      requester: { type: 'domain', id: 'gate.example.com' }, chalExp: 1790000900,
    }));
    expect(signed[0].split('\n')[0]).toBe('provian-presentation-v2');
    expect(parse(r).requester).toMatchObject({ status: 'verified', identity: { type: 'domain', id: 'gate.example.com' } });
  });

  it('share-only disclosure is forwarded AND signed (close-out: withhold by default reachable over MCP)', async () => {
    const env = signedDomainEnvelope();
    const { ctx, calls, signed } = ctxWith((url) => url.endsWith('/present') ? json(200, { tier: 'reputation', token: 'tok' }) : null);
    const r = await callProvianTool('present', { ...presentArgs, challenge_envelope: env, disclosure: { share: ['work.total'] } }, ctx);
    expect(r.isError).not.toBe(true);
    const directive = { redact: [], predicates: env.predicates, share: ['work.total'] };
    expect(calls[0].body!.disclosure).toEqual(canonicalReputationDirective(directive));
    expect(signed[0]).toContain(`claims=${claimsDigest({ tier: 'reputation', directive })}`);
  });

  it('RED: share with redact, or a non-list share, is refused with no relay call', async () => {
    for (const disclosure of [{ share: ['work.total'], redact: ['continuity.chain_depth'] }, { share: 'work.total' }]) {
      const { ctx, calls, signed } = ctxWith(() => json(200, {}));
      const r = await callProvianTool('present', { ...presentArgs, challenge_envelope: signedDomainEnvelope(), disclosure }, ctx);
      expect(r.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(signed).toHaveLength(0);
    }
  });

  it('RED control: a legacy pair presents v1 (no challenge_envelope sent) and reports unverified', async () => {
    const { ctx, calls, signed } = ctxWith((url) => url.endsWith('/present') ? json(200, { tier: 'pe_fact', token: 'tok' }) : null);
    const r = await callProvianTool('present', { wallet_id: 'wallet_aw_me', burn_id: 'burn_1', audience: 'gate.example.com', challenge: 'a'.repeat(64) }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls[0].body).not.toHaveProperty('challenge_envelope');
    expect(signed[0].split('\n')[0]).toBe('provian-presentation-v1');
    expect(parse(r).requester).toMatchObject({ status: 'unverified' });
  });

  it('refuses a pe_fact present against a challenge that names predicates (no relay call)', async () => {
    const { ctx, calls } = ctxWith(() => json(200, {}));
    const r = await callProvianTool('present', { wallet_id: 'wallet_aw_me', burn_id: 'b', tier: 'pe_fact', challenge_envelope: signedDomainEnvelope() }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('verify_presentation — accept once by default', () => {
  const token = Buffer.from(JSON.stringify({ v: 1, payload: { exp: NOW + 300, burn_id: 'x' } })).toString('base64url');

  function verifier(presentationId: string) {
    return ctxWith((url) => url.endsWith('/v1/present/verify')
      ? json(200, { valid: true, tier: 'reputation', presentation_id: presentationId, requester: null, challenge_expires_at: NOW + 800, presenter_address: ME, sub: 'wallet_aw_p' })
      : null, { auth: null });
  }

  it('the second verify of one presentation is replayed; a different presentation is not (RED control)', async () => {
    const id = `burn_${Math.random().toString(16).slice(2)}`;
    const { ctx, calls } = verifier(id);
    const env = signedDomainEnvelope();
    const first = parse(await callProvianTool('verify_presentation', { token, challenge_envelope: env, expected_presenter: ME }, ctx));
    expect(first).toMatchObject({ valid: true, presentation_id: id, challenge_expires_at: NOW + 800, requester: null });
    expect(calls[0].body).toMatchObject({ token, challenge_envelope: env, expected_presenter: ME });
    const second = parse(await callProvianTool('verify_presentation', { token, challenge_envelope: env }, ctx));
    expect(second).toMatchObject({ valid: false, reason: 'replayed', presentation_id: id });
    const other = verifier(`${id}_other`);
    expect(parse(await callProvianTool('verify_presentation', { token, challenge_envelope: env }, other.ctx)).valid).toBe(true);
  });

  it('accept_once:false turns the one-shot off', async () => {
    const id = `burn_${Math.random().toString(16).slice(2)}`;
    const { ctx } = verifier(id);
    const args = { token, audience: 'gate.example.com', challenge: 'a'.repeat(64), accept_once: false };
    expect(parse(await callProvianTool('verify_presentation', args, ctx)).valid).toBe(true);
    expect(parse(await callProvianTool('verify_presentation', args, ctx)).valid).toBe(true);
  });

  it('a refused presentation is never claimed (a later valid verify of the same id still passes)', async () => {
    const id = `burn_${Math.random().toString(16).slice(2)}`;
    let valid = false;
    const { ctx } = ctxWith((url) => url.endsWith('/v1/present/verify')
      ? json(200, valid ? { valid: true, tier: 'reputation', presentation_id: id } : { valid: false, reason: 'challenge_mismatch' })
      : null, { auth: null });
    const args = { token, audience: 'gate.example.com', challenge: 'a'.repeat(64) };
    expect(parse(await callProvianTool('verify_presentation', args, ctx)).valid).toBe(false);
    valid = true;
    expect(parse(await callProvianTool('verify_presentation', args, ctx)).valid).toBe(true);
  });
});

describe('present_in_thread / answer_challenge — verdict when a challenge_envelope is carried', () => {
  it('present_in_thread refuses an invalid signed envelope without submitting', async () => {
    const { ctx, calls } = ctxWith(() => json(200, {}));
    const r = await callProvianTool('present_in_thread', {
      thread_id: 't1', request_id: 'r1', burn_id: 'b1', presentation_token: 'tok',
      challenge_envelope: { ...signedDomainEnvelope(), sig: 'A'.repeat(86) },
    }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('answer_challenge with a verified envelope submits and reports the requester', async () => {
    const { ctx, calls } = ctxWith((url) => url.includes('/answer') ? json(200, { status: 'answered' }) : null);
    const r = await callProvianTool('answer_challenge', {
      challenge_id: 'c1', burn_id: 'b1', presentation_token: 'tok', challenge_envelope: signedDomainEnvelope(),
    }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(parse(r).requester).toMatchObject({ status: 'verified' });
  });
});

describe('pipelined burn: present carries the broadcast tx, record_burn holds until the burn is mined', () => {
  const TX = '0x' + 'Be'.repeat(32);
  const BURN_ID = createHash('sha256').update(`base:${TX.toLowerCase()}`).digest('hex');

  it('present with burn_tx_hash binds the derived burn id and sends the tx for the relay to record once mined', async () => {
    const { ctx, calls, signed } = ctxWith((url) => url.endsWith('/present') ? json(200, { tier: 'pe_fact', token: 'tok' }) : null);
    const r = await callProvianTool('present', {
      wallet_id: 'wallet_aw_me', burn_tx_hash: TX, burn_amount_atomic: '5000000000000000000', audience: 'gate.example.com', challenge: 'a'.repeat(64),
    }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ burn_id: BURN_ID, burn: { tx_hash: TX, amount_atomic: '5000000000000000000', chain: 'base' } });
    expect(signed[0].split('\n')).toContain(`burn=${BURN_ID}`);
  });

  it('RED: a burn_id that does not match burn_tx_hash is refused with no relay call and nothing signed', async () => {
    const { ctx, calls, signed } = ctxWith(() => json(200, { token: 'tok' }));
    const r = await callProvianTool('present', {
      wallet_id: 'wallet_aw_me', burn_id: 'f'.repeat(64), burn_tx_hash: TX, burn_amount_atomic: '1', audience: 'gate.example.com', challenge: 'a'.repeat(64),
    }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it('RED: burn_tx_hash without a valid amount is refused (no relay call)', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { token: 'tok' }));
    const r = await callProvianTool('present', { wallet_id: 'wallet_aw_me', burn_tx_hash: TX, audience: 'gate.example.com', challenge: 'a'.repeat(64) }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('RED: neither burn_id nor burn_tx_hash → refused', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { token: 'tok' }));
    const r = await callProvianTool('present', { wallet_id: 'wallet_aw_me', audience: 'gate.example.com', challenge: 'a'.repeat(64) }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('record_burn asks the relay to hold the record by default; await_finality:false sends the one-shot record', async () => {
    const { ctx, calls } = ctxWith((url) => url.endsWith('/burn/record') ? json(200, { burn_id: BURN_ID, verified: true }) : null);
    await callProvianTool('record_burn', { wallet_id: 'wallet_aw_me', tx_hash: TX, amount_atomic: '5' }, ctx);
    await callProvianTool('record_burn', { wallet_id: 'wallet_aw_me', tx_hash: TX, amount_atomic: '5', await_finality: false }, ctx);
    expect(calls[0].body).toMatchObject({ await_finality: true });
    expect(calls[1].body).not.toHaveProperty('await_finality');
  });
});

describe('PE meter — a pe_fact carries the PE and its inclusion proof (the relay keeps no PE)', () => {
  const PE_HASH = 'ab'.repeat(32);
  const pe = { schema: 'provian.pe.v2', pe_id: 'pe_1', device_id: 'dev_x', prev_hash: 'genesis', timestamp: 1, action_type: 'coding_session', pe_hash: PE_HASH };
  const inclusion = { act_index: 0, act_proof: [], acts_root: 'cd'.repeat(32), batch: { device_id: 'dev_x', actor_id: 'wallet_aw_me', seq: 1, batch_hash: 'ef'.repeat(32) }, anchor: { day: '2026-10-02', segment: 2, proof: [] } };
  const base = { wallet_id: 'wallet_aw_me', burn_id: 'burn_1', tier: 'pe_fact', audience: 'gate.example.com', challenge: 'a'.repeat(64) };

  it('sends each pe_fact with its PE and inclusion; the signed claims bind only pe_id:pe_hash', async () => {
    const { ctx, calls, signed } = ctxWith((url) => url.endsWith('/present') ? json(200, { tier: 'pe_fact', token: 'tok' }) : null);
    const r = await callProvianTool('present', { ...base, pe_facts: [{ pe_id: 'pe_1', envelope_hash: PE_HASH, pe, inclusion }] }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.pe_facts).toEqual([{ pe_id: 'pe_1', envelope_hash: PE_HASH, pe, inclusion }]);
    expect(signed).toHaveLength(1);
  });

  it('RED: a pe_fact without its PE or inclusion, naming another PE, or under another hash is refused — nothing signed or sent', async () => {
    const bad = [
      [{ pe_id: 'pe_1', envelope_hash: PE_HASH }],
      [{ pe_id: 'pe_1', envelope_hash: PE_HASH, pe }],
      [{ pe_id: 'pe_2', envelope_hash: PE_HASH, pe, inclusion }],
      [{ pe_id: 'pe_1', envelope_hash: 'ef'.repeat(32), pe, inclusion }],
    ];
    for (const peFacts of bad) {
      const { ctx, calls, signed } = ctxWith(() => json(200, { token: 'tok' }));
      const r = await callProvianTool('present', { ...base, pe_facts: peFacts }, ctx);
      expect(r.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(signed).toHaveLength(0);
    }
    const { ctx } = ctxWith(() => null);
    const missing = await callProvianTool('present', { ...base, pe_facts: bad[0] }, ctx);
    expect(missing.content[0].text).toMatch(/provian pes prove pe_1/);
  });
});
