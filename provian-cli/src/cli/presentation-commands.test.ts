/**
 * CLI — signed challenges, the pre-burn requester check, accept-once verify.
 *
 * Each refusal test is paired with a positive control through the SAME seam so it
 * cannot pass vacuously: `respond` refusals assert the burn spy was never called,
 * next to a valid challenge that DOES reach the burn; the replay refusal sits next
 * to a fresh-store run and an --accept-again run that are accepted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { keccak256, encodePacked } from 'viem';
import {
  CommonsInstitutions,
  buildAgentPresentationRequest,
  deriveAddressFromPrivateKey,
  generateRequesterKey,
  requesterWellKnownDocument,
  signDomainChallenge,
  verifyChallengeEnvelope,
  type CommonsInstitutionsConfig,
  type FetchRequesterKeys,
} from '@provian/agent-sdk';
import {
  parsePredicateExpression,
  collectPredicates,
  collectPeTokens,
  resolvePeFacts,
  parseChallengeArg,
  cmdPresentationChallenge,
  cmdCheckChallenge,
  cmdRespond,
  cmdPresent,
  cmdVerifyPresentation,
  cmdRequesterKey,
  type PresentationCliDeps,
} from './presentation-commands';
import { anchoredMemoryStore } from './anchored-store.test-support';

const AGENT_KEY = 'a'.repeat(64);
const MY_ADDR = deriveAddressFromPrivateKey(AGENT_KEY).toLowerCase();
const OTHER_ADDR = '0x' + '9'.repeat(40);
const DOMAIN = 'gate.example.com';
const ENV_KEYS = ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_RELAY_URL', 'PROVIAN_AGENT_PRIVATE_KEY', 'PROVIAN_BASE_RPC_URL'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

function setAgentCreds(): void {
  process.env.PROVIAN_API_KEY = 'pvn_live_test';
  process.env.PROVIAN_API_SECRET = 'pvns_test';
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_me';
  process.env.PROVIAN_RELAY_URL = 'https://relay.invalid';
  process.env.PROVIAN_AGENT_PRIVATE_KEY = AGENT_KEY;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'provian-cli-d477-'));
}

/** A domain requester key + the fetcher a presenter would reach it through. */
function domainRequester() {
  const key = generateRequesterKey({ kid: 'k1' });
  const doc = requesterWellKnownDocument([key.publicJwk]);
  const fetchRequesterKeys: FetchRequesterKeys = vi.fn(async (d: string) => {
    if (d !== DOMAIN) throw new Error('unknown domain');
    return doc.keys;
  });
  return { key, fetchRequesterKeys };
}

function signed(key: { privateKeyPem: string }, over: { issuedAt?: number; expiresAt?: number; presenter?: string; predicates?: { field: string; op: 'gte'; threshold: number }[] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signDomainChallenge({
    domain: DOMAIN,
    kid: 'k1',
    privateKeyPem: key.privateKeyPem,
    challenge: crypto.randomBytes(32).toString('hex'),
    issuedAt: over.issuedAt ?? now,
    expiresAt: over.expiresAt ?? now + 900,
    ...(over.presenter ? { presenter: over.presenter } : {}),
    ...(over.predicates ? { predicates: over.predicates } : {}),
  });
}

function quietDeps(extra: Partial<PresentationCliDeps> = {}): Partial<PresentationCliDeps> & { lines: string[] } {
  const lines: string[] = [];
  return { log: (l: string) => { lines.push(l); }, isInteractive: () => false, lines, ...extra } as Partial<PresentationCliDeps> & { lines: string[] };
}

// ---------------------------------------------------------------------------
// Predicate flags (item 4)
// ---------------------------------------------------------------------------

describe('predicate flag parsing', () => {
  it('maps >= > <= < = == to gte/gt/lte/lt/eq', () => {
    expect(parsePredicateExpression('work.total>=10')).toEqual({ field: 'work.total', op: 'gte', threshold: 10 });
    expect(parsePredicateExpression('work.total > 10')).toEqual({ field: 'work.total', op: 'gt', threshold: 10 });
    expect(parsePredicateExpression('work.total<=2.5')).toEqual({ field: 'work.total', op: 'lte', threshold: 2.5 });
    expect(parsePredicateExpression('money.net<-1')).toEqual({ field: 'money.net', op: 'lt', threshold: -1 });
    expect(parsePredicateExpression('standing.flags=0')).toEqual({ field: 'standing.flags', op: 'eq', threshold: 0 });
    expect(parsePredicateExpression('standing.flags==0')).toEqual({ field: 'standing.flags', op: 'eq', threshold: 0 });
  });

  it('maps "<field> in:{a,b}" to op in with a numeric set', () => {
    expect(parsePredicateExpression('standing.adverse_events in:{0,1}')).toEqual({ field: 'standing.adverse_events', op: 'in', set: [0, 1] });
    expect(parsePredicateExpression('standing.adverse_events=in:{ 3 }')).toEqual({ field: 'standing.adverse_events', op: 'in', set: [3] });
  });

  it('RED: refuses non-numbers, empty sets, and unknown syntax (never guesses)', () => {
    expect(() => parsePredicateExpression('work.total>=ten')).toThrow(/not a number/);
    expect(() => parsePredicateExpression('work.total>=')).toThrow();
    expect(() => parsePredicateExpression('work.total>=0x10')).toThrow(/not a number/);
    expect(() => parsePredicateExpression('standing.adverse_events in:{}')).toThrow(/at least one/);
    expect(() => parsePredicateExpression('work.total ~ 3')).toThrow(/not understood/);
  });

  it('collects --predicates-json then each repeated --predicate, validated by the SDK', () => {
    const preds = collectPredicates(
      { 'predicates-json': '[{"field":"a.b","op":"lt","threshold":3}]' },
      { predicate: ['work.total>=10', 'standing.adverse_events in:{0,1}'] },
    );
    expect(preds).toEqual([
      { field: 'a.b', op: 'lt', threshold: 3 },
      { field: 'work.total', op: 'gte', threshold: 10 },
      { field: 'standing.adverse_events', op: 'in', set: [0, 1] },
    ]);
  });

  it('reads --predicates-json from @file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'p.json'), '[{"field":"work.total","op":"gte","threshold":1}]');
    expect(collectPredicates({ 'predicates-json': `@${join(dir, 'p.json')}` })).toEqual([{ field: 'work.total', op: 'gte', threshold: 1 }]);
  });

  it('RED: a malformed --predicates-json entry refuses the whole list', () => {
    expect(() => collectPredicates({ 'predicates-json': '[{"field":"a","op":"approx","threshold":3}]' })).toThrow(/malformed/);
    expect(() => collectPredicates({ 'predicates-json': '{"field":"a"}' })).toThrow(/JSON array/);
  });

  it('--pe <pe_id> and <pe_id>:<pe_hash> parse; a malformed hash is refused', () => {
    expect(collectPeTokens({}, { pe: ['pe_1:0x' + 'AB'.repeat(32), 'pe_2'] })).toEqual(['pe_1:' + 'ab'.repeat(32), 'pe_2']);
    expect(() => collectPeTokens({}, { pe: ['pe_1:0x1234'] })).toThrow(/pe_hash/);
  });

  it('PE meter: --pe resolves to the PE + its anchored inclusion from this machine\'s store', async () => {
    const { store, pes } = await anchoredMemoryStore();
    const [proof] = await store.listProofs();
    vi.spyOn(store, 'listProofs').mockResolvedValue([{ ...proof, anchor: { ...proof.anchor!, segment: 2 } }]);
    const facts = await resolvePeFacts([pes[0].pe_id, `${pes[1].pe_id}:${pes[1].pe_hash}`], { openPeStore: () => ({ ok: true, store }) });
    expect(facts.map((f) => [f.peId, f.envelopeHash])).toEqual([[pes[0].pe_id, pes[0].pe_hash], [pes[1].pe_id, pes[1].pe_hash]]);
    expect(facts[1].pe).toEqual(pes[1]);
    expect(facts[1].inclusion).toMatchObject({ act_index: 1, anchor: { day: '2026-10-02', segment: 2 } });
  });

  it('RED: a PE not anchored yet, not held here, under another hash, or with no store cannot be presented', async () => {
    const unanchored = await anchoredMemoryStore({ anchored: false });
    const deps = { openPeStore: () => ({ ok: true as const, store: unanchored.store }) };
    await expect(resolvePeFacts([unanchored.pes[0].pe_id], deps)).rejects.toThrow(/not anchored on Base yet/);
    await expect(resolvePeFacts(['pe_elsewhere'], deps)).rejects.toThrow(/not in this machine's PE store/);
    const anchored = await anchoredMemoryStore();
    await expect(resolvePeFacts([`${anchored.pes[0].pe_id}:${'0'.repeat(64)}`], { openPeStore: () => ({ ok: true, store: anchored.store }) })).rejects.toThrow(/different pe_hash/);
    await expect(resolvePeFacts(['pe_1'], { openPeStore: () => ({ ok: false, reason: 'no_store', detail: 'no PE store under /x' }) })).rejects.toThrow(/no PE store/);
  });
});

// ---------------------------------------------------------------------------
// provian challenge — carries predicates, and SIGNS (item 4 + item 7)
// ---------------------------------------------------------------------------

describe('provian challenge', () => {
  it('unsigned: carries every predicate (the pre- verb dropped them) and says UNSIGNED', async () => {
    const r = await cmdPresentationChallenge(
      { unsigned: true, audience: 'gate-1', presenter: MY_ADDR, ttl: '120' },
      { predicate: ['work.total>=10', 'standing.adverse_events in:{0,1}'] },
      quietDeps(),
    );
    expect(r.status).toBe('ok');
    expect(r.signed).toBe(false);
    expect(String(r.requester)).toMatch(/UNSIGNED/);
    const env = r.challenge as Record<string, unknown>;
    expect(env.predicates).toEqual([
      { field: 'work.total', op: 'gte', threshold: 10 },
      { field: 'standing.adverse_events', op: 'in', set: [0, 1] },
    ]);
    expect(env.presenter).toBe(MY_ADDR);
    expect((env.expiresAt as number) - (env.issuedAt as number)).toBe(120);
  });

  it('--domain/--key-file: domain-signed locally, predicates committed in the signature', async () => {
    const dir = tmp();
    const keyFile = join(dir, 'requester.pem');
    const made = await cmdRequesterKey({ domain: DOMAIN, out: keyFile }, {}, quietDeps());
    expect(made.status).toBe('ok');
    const r = await cmdPresentationChallenge({ domain: DOMAIN, 'key-file': keyFile }, { predicate: ['work.total>=10'] }, quietDeps());
    expect(r.status).toBe('ok');
    expect(r.signed).toBe(true);
    const env = r.challenge as Record<string, unknown>;
    expect(env.predicates).toEqual([{ field: 'work.total', op: 'gte', threshold: 10 }]);
    expect(env.requester).toEqual({ type: 'domain', id: DOMAIN, kid: 'k1' });
    // A presenter holding the published document verifies it.
    const doc = made.well_known_document as { keys: { kty: string; crv: string; x: string; kid: string }[] };
    const v = await verifyChallengeEnvelope(parseChallengeArg(JSON.stringify(r)), { fetchRequesterKeys: async () => doc.keys });
    expect(v.status).toBe('verified');
    // RED: tampering with the carried predicates breaks the signature.
    const tampered = { ...env, predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] };
    const v2 = await verifyChallengeEnvelope(parseChallengeArg(JSON.stringify(tampered)), { fetchRequesterKeys: async () => doc.keys });
    expect(v2).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });

  it('default: wallet-signed through CommonsInstitutions, passing predicates/presenter/ttl', async () => {
    setAgentCreds();
    const issued = { v: 1, audience: 'wallet_aw_me', challenge: 'c'.repeat(64), issuedAt: 1, expiresAt: 901, requester: { type: 'wallet', id: 'wallet_aw_me', address: MY_ADDR, kid: 'p1' }, sig: 'x' };
    const issue = vi.fn(async () => issued);
    const r = await cmdPresentationChallenge(
      { presenter: OTHER_ADDR, ttl: '600' },
      { predicate: ['work.total>=10'] },
      quietDeps({ makeInstitutions: () => ({ issuePresentationChallenge: issue }) as unknown as CommonsInstitutions }),
    );
    expect(issue).toHaveBeenCalledWith({ predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }], presenter: OTHER_ADDR, ttlSeconds: 600 });
    expect(r).toMatchObject({ status: 'ok', signed: true, challenge: issued });
    expect(String(r.requester)).toMatch(/wallet-signed by the Provian relay/);
  });

  it('no credentials and no --domain/--unsigned: refuses rather than silently issuing unsigned', async () => {
    const r = await cmdPresentationChallenge({}, {}, quietDeps());
    expect(r.status).toBe('error');
    expect(String(r.error)).toMatch(/--unsigned/);
  });

  it('RED: --ttl outside 60..604800 is refused (never silently clamped)', async () => {
    const r = await cmdPresentationChallenge({ unsigned: true, audience: 'g', ttl: '30' }, {}, quietDeps());
    expect(r.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// provian check-challenge — the verdict, no burn
// ---------------------------------------------------------------------------

describe('provian check-challenge', () => {
  it('signed + valid → "Requester: <domain> — VERIFIED"', async () => {
    const { key, fetchRequesterKeys } = domainRequester();
    const deps = quietDeps({ fetchRequesterKeys });
    const r = await cmdCheckChallenge({ 'challenge-json': JSON.stringify(signed(key)) }, {}, deps);
    expect(r).toMatchObject({ status: 'ok', verdict: 'verified', requester: `Requester: ${DOMAIN} — VERIFIED`, burned: false });
    expect(deps.lines).toContain(`Requester: ${DOMAIN} — VERIFIED`);
  });

  it('unsigned → "UNVERIFIED (unsigned challenge)", allowed', async () => {
    const r = await cmdCheckChallenge({ 'challenge-json': JSON.stringify({ audience: 'gate-1', challenge: 'c'.repeat(64) }) }, {}, quietDeps());
    expect(r).toMatchObject({ status: 'ok', verdict: 'unverified', requester: 'Requester: gate-1 — UNVERIFIED (unsigned challenge)' });
  });

  it('RED: expired signed challenge → exit non-zero (status error)', async () => {
    const { key, fetchRequesterKeys } = domainRequester();
    const now = Math.floor(Date.now() / 1000);
    const r = await cmdCheckChallenge({ 'challenge-json': JSON.stringify(signed(key, { issuedAt: now - 2000, expiresAt: now - 1000 })) }, {}, quietDeps({ fetchRequesterKeys }));
    expect(r).toMatchObject({ status: 'error', verdict: 'expired' });
  });
});

// ---------------------------------------------------------------------------
// provian respond — refusals never burn
// ---------------------------------------------------------------------------

describe('provian respond', () => {
  /** A REAL CommonsInstitutions (the SDK's own verify → burn → present sequence) with the burn and
   *  the relay calls spied, so a refusal is observed at the money boundary. */
  function bankHarness() {
    const relayFetch = vi.fn(async (url: unknown) => String(url).endsWith('/present/preflight')
      ? new Response(JSON.stringify({ok:true}),{status:200}) : new Response('{}', {status:500}));
    let bank: CommonsInstitutions | undefined;
    // respond broadcasts via sendBurn (the relay records the burn inside /present), so
    // sendBurn is the money boundary every "never burns" control watches.
    const burn = vi.fn(async (p: { amountAtomic: string | bigint }) => ({ burnId: 'burn_1', txHash: '0xtx', amountAtomic: String(p.amountAtomic), chain: 'base' as const }));
    const present = vi.fn(async () => ({ tier: 'reputation' as const, presentation: {}, token: 'tok_1' }));
    const makeInstitutions = (cfg: CommonsInstitutionsConfig): CommonsInstitutions => {
      bank = new CommonsInstitutions({ ...cfg, fetch: relayFetch as unknown as typeof fetch });
      vi.spyOn(bank, 'sendBurn').mockImplementation(burn as unknown as CommonsInstitutions['sendBurn']);
      vi.spyOn(bank, 'present').mockImplementation(present as unknown as CommonsInstitutions['present']);
      vi.spyOn(bank, 'presentationFloorAtomic').mockResolvedValue(15n * 10n ** 18n);
      return bank;
    };
    return { makeInstitutions, burn, present, relayFetch };
  }
  const base = { 'rpc-url': 'https://rpc.invalid', tier: 'reputation' } as Record<string, string | boolean>;

  it('control: a valid signed challenge with --yes prints VERIFIED, burns once, presents', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const deps = quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions });
    const env = signed(key, { presenter: MY_ADDR, predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }] });
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(env), yes: true }, {}, deps);
    expect(r).toMatchObject({ status: 'ok', verdict: 'verified', token: 'tok_1', presentation_id: 'burn_1', burn_tx: '0xtx', requester: `Requester: ${DOMAIN} — VERIFIED` });
    expect(h.burn).toHaveBeenCalledTimes(1);
    expect(h.present).toHaveBeenCalledTimes(1);
    // The signed envelope rides to /present (v2) and the predicates are the directive.
    expect(h.present.mock.calls[0]).toBeDefined();
    const call = (h.present.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.challengeEnvelope).toMatchObject({ sig: env.sig });
    expect(call.disclosure).toEqual({ redact: [], predicates: [{ field: 'work.total', op: 'gte', threshold: 10 }] });
    expect(deps.lines[0]).toBe(`Requester: ${DOMAIN} — VERIFIED`);
  });

  it('a new 50 PVT burn override reaches the money boundary without requiring a resume transaction', async () => {
    setAgentCreds(); const { key, fetchRequesterKeys } = domainRequester(); const h = bankHarness();
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(signed(key, { presenter: MY_ADDR })), yes: true,
      'burn-amount-atomic': '50000000000000000000' }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(r).toMatchObject({ status: 'ok', burn_amount_atomic: '50000000000000000000' });
    expect(h.burn).toHaveBeenCalledTimes(1);
    expect(h.burn.mock.calls[0][0].amountAtomic).toBe(50000000000000000000n);
  });

  it('refuses relay proof preflight before the CLI broadcasts a burn',async()=>{
    setAgentCreds();
    const {key,fetchRequesterKeys}=domainRequester();
    const h=bankHarness();
    h.relayFetch.mockResolvedValueOnce(new Response(JSON.stringify({error:'pe_not_owned',reason:'pe_not_owned'}),{status:403}));
    const r=await cmdRespond({...base,'challenge-json':JSON.stringify(signed(key,{presenter:MY_ADDR})),yes:true},{},quietDeps({fetchRequesterKeys,makeInstitutions:h.makeInstitutions}));
    expect(r).toMatchObject({status:'error'});
    expect(h.burn).not.toHaveBeenCalled();
    expect(h.present).not.toHaveBeenCalled();
  });

  it('RED : a present that fails AFTER the burn prints the burn handle and a resume line — never a bare error', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    h.present.mockRejectedValueOnce(new Error('relay unavailable'));
    const env = signed(key, { presenter: MY_ADDR });
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(env), yes: true }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(h.burn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'error', burned: true, burn_tx: '0xtx', burn_id: 'burn_1' });
    expect(String((r as { resume?: string }).resume)).toContain('--burn-tx 0xtx');
  });

  it('--burn-tx resumes an earlier broadcast burn — nothing is burned again', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const env = signed(key, { presenter: MY_ADDR });
    const tx = '0x' + 'ab'.repeat(32);
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(env), yes: true, 'burn-tx': tx, 'burn-amount-atomic': '15000000000000000000' }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(r).toMatchObject({ status: 'ok', burn_tx: tx });
    expect(h.burn).not.toHaveBeenCalled();
    const call = (h.present.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.burnTx).toMatchObject({ txHash: tx, amountAtomic: '15000000000000000000' });
  });

  it('RED: an EXPIRED signed challenge is refused, exits non-zero, and NEVER burns', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const now = Math.floor(Date.now() / 1000);
    const env = signed(key, { issuedAt: now - 5000, expiresAt: now - 4000 });
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(env), yes: true }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(r).toMatchObject({ status: 'error', refused: true, verdict: 'expired', burned: false });
    expect(h.burn).not.toHaveBeenCalled();
    expect(h.present).not.toHaveBeenCalled();
    expect(h.relayFetch).not.toHaveBeenCalled();
  });

  it('RED: an INVALID (tampered) signed challenge is refused and NEVER burns', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const env = { ...signed(key), challenge: 'f'.repeat(64) }; // signature no longer covers it
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(env), yes: true }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(r).toMatchObject({ status: 'error', refused: true, verdict: 'invalid', reason: 'bad_signature', burned: false });
    expect(h.burn).not.toHaveBeenCalled();
  });

  it('RED: a challenge addressed to ANOTHER presenter is refused and NEVER burns', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(signed(key, { presenter: OTHER_ADDR })), yes: true }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions }));
    expect(r).toMatchObject({ status: 'error', verdict: 'not_addressed', burned: false });
    expect(h.burn).not.toHaveBeenCalled();
  });

  it('RED: without --yes in a non-interactive shell it prints the requester and declines — no burn', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h = bankHarness();
    const deps = quietDeps({ fetchRequesterKeys, makeInstitutions: h.makeInstitutions });
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(signed(key)) }, {}, deps);
    expect(r).toMatchObject({ status: 'error', declined: true, burned: false });
    expect(String(r.error)).toMatch(/--yes/);
    expect(deps.lines).toContain(`Requester: ${DOMAIN} — VERIFIED`);
    expect(h.burn).not.toHaveBeenCalled();
  });

  it('interactive: a "no" at the prompt declines (no burn); "yes" burns', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const h1 = bankHarness();
    const no = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(signed(key)) }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h1.makeInstitutions, isInteractive: () => true, confirm: async () => false }));
    expect(no).toMatchObject({ status: 'error', declined: true });
    expect(h1.burn).not.toHaveBeenCalled();
    const h2 = bankHarness();
    const yes = await cmdRespond({ ...base, 'challenge-json': JSON.stringify(signed(key)) }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions: h2.makeInstitutions, isInteractive: () => true, confirm: async () => true }));
    expect(yes).toMatchObject({ status: 'ok' });
    expect(h2.burn).toHaveBeenCalledTimes(1);
  });

  it('unsigned legacy challenge: UNVERIFIED line, allowed with --yes', async () => {
    setAgentCreds();
    const h = bankHarness();
    const deps = quietDeps({ makeInstitutions: h.makeInstitutions });
    const r = await cmdRespond({ ...base, 'challenge-json': JSON.stringify({ audience: 'gate-1', challenge: 'c'.repeat(64) }), yes: true }, {}, deps);
    expect(r).toMatchObject({ status: 'ok', verdict: 'unverified', requester: 'Requester: gate-1 — UNVERIFIED (unsigned challenge)' });
    expect(h.burn).toHaveBeenCalledTimes(1);
  });

  it('RED: pe_fact with no --pe, or pe_fact against predicates, is refused before any burn', async () => {
    setAgentCreds();
    const h = bankHarness();
    const unsignedEnv = JSON.stringify({ audience: 'gate-1', challenge: 'c'.repeat(64) });
    const a = await cmdRespond({ 'rpc-url': 'x', 'challenge-json': unsignedEnv, yes: true }, {}, quietDeps({ makeInstitutions: h.makeInstitutions }));
    expect(a).toMatchObject({ status: 'error' });
    expect(String(a.error)).toMatch(/--pe/);
    const withPreds = JSON.stringify({ audience: 'gate-1', challenge: 'c'.repeat(64), predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] });
    const b = await cmdRespond({ 'rpc-url': 'x', tier: 'pe_fact', 'challenge-json': withPreds, yes: true }, { pe: ['pe_1:' + 'ab'.repeat(32)] }, quietDeps({ makeInstitutions: h.makeInstitutions }));
    expect(b).toMatchObject({ status: 'error' });
    expect(h.burn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// provian present --challenge-json — verifies before consuming the burn
// ---------------------------------------------------------------------------

describe('provian present --challenge-json', () => {
  it('RED: an expired signed challenge is refused and /present is never called; control: valid presents', async () => {
    setAgentCreds();
    const { key, fetchRequesterKeys } = domainRequester();
    const present = vi.fn(async () => ({ tier: 'reputation' as const, presentation: {}, token: 'tok' }));
    const makeInstitutions = (cfg: CommonsInstitutionsConfig): CommonsInstitutions => {
      const b = new CommonsInstitutions(cfg);
      vi.spyOn(b, 'present').mockImplementation(present as unknown as CommonsInstitutions['present']);
      return b;
    };
    const now = Math.floor(Date.now() / 1000);
    const expired = await cmdPresent({ 'burn-id': 'b1', tier: 'reputation', 'challenge-json': JSON.stringify(signed(key, { issuedAt: now - 5000, expiresAt: now - 4000 })) }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions }));
    expect(expired).toMatchObject({ status: 'error', verdict: 'expired' });
    expect(present).not.toHaveBeenCalled();
    const ok = await cmdPresent({ 'burn-id': 'b1', tier: 'reputation', 'challenge-json': JSON.stringify(signed(key)) }, {}, quietDeps({ fetchRequesterKeys, makeInstitutions }));
    expect(ok).toMatchObject({ status: 'ok', verdict: 'verified', token: 'tok', presentation_id: 'b1' });
    expect(present).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// provian verify — accept-once via the file store, on-chain by default, item 1
// ---------------------------------------------------------------------------

describe('provian verify', () => {
  const HASH = '0x' + 'ab'.repeat(32);
  const cosign = crypto.generateKeyPairSync('ed25519');
  const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: (cosign.publicKey.export({ format: 'jwk' }) as { x: string }).x, kid: 'k' }] };
  const jwksFetch = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

  /** A Provian-co-signed pe_fact presentation, built the way the relay produces one. */
  function peFactToken(audience: string, challenge: string, burnId = crypto.randomBytes(32).toString('hex')): string {
    const now = Math.floor(Date.now() / 1000);
    const { body } = buildAgentPresentationRequest({ privateKeyHex: AGENT_KEY, tier: 'pe_fact', burnId, audience, challenge, nowSeconds: now, peFacts: [{ peId: 'pe_1', envelopeHash: HASH }] });
    const cos = { v: 1, iss: 'https://provian.ai', ctx: 'pe_fact_cosign', presenter_address: MY_ADDR, burn_id: body.burn_id, pe_facts: [{ pe_id: 'pe_1', envelope_hash: HASH }], jti: body.jti, iat: body.iat, exp: body.exp, sub: 'wallet_aw_presenter' };
    const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'provian-presentation-pefact+jwt', kid: 'k' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(cos)).toString('base64url');
    const jws = `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), cosign.privateKey).toString('base64url')}`;
    const pres = {
      tier: 'pe_fact',
      payload: { v: 1, tier: 'pe_fact', iss: MY_ADDR, sub: 'wallet_aw_presenter', presenter_address: MY_ADDR, aud: audience, chal: challenge, iat: body.iat, exp: body.exp, jti: body.jti, burn_id: body.burn_id, presenter_pop: body.pop, pe_facts: [{ pe_id: 'pe_1', envelope_hash: HASH }] },
      provian_jws: jws,
      proofs: [{ pe_id: 'pe_1', envelope_hash: HASH, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', HASH as `0x${string}`])) }, merkle_proof: ['0x' + '22'.repeat(32)] }],
    };
    return Buffer.from(JSON.stringify(pres)).toString('base64url');
  }

  it('accepts ONCE: a second run against the same seen-store file is refused "replayed" (default path under ~/.provian)', async () => {
    const home = tmp();
    const envJson = JSON.stringify({ audience: 'gate-1', challenge: 'c'.repeat(64), presenter: MY_ADDR });
    const token = peFactToken('gate-1', 'c'.repeat(64));
    const deps = quietDeps({ homeDir: () => home, fetchFn: jwksFetch });
    const first = await cmdVerifyPresentation({ token, 'challenge-json': envJson, 'no-onchain': true }, {}, deps);
    expect(first).toMatchObject({ status: 'ok', valid: true, tier: 'pe_fact', presenter_address: MY_ADDR, sub: 'wallet_aw_presenter' });
    expect(typeof first.presentation_id).toBe('string');
    const storePath = join(home, '.provian', 'presentations-seen.json');
    expect(existsSync(storePath)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')))).toEqual([first.presentation_id]);

    const second = await cmdVerifyPresentation({ token, 'challenge-json': envJson, 'no-onchain': true }, {}, deps);
    expect(second).toMatchObject({ status: 'error', valid: false, reason: 'replayed' });

    // Controls: the FILE is the carrier (a fresh store accepts), and --accept-again disables it.
    const fresh = await cmdVerifyPresentation({ token, 'challenge-json': envJson, 'no-onchain': true, 'seen-store': join(tmp(), 's.json') }, {}, deps);
    expect(fresh).toMatchObject({ status: 'ok', valid: true });
    const again = await cmdVerifyPresentation({ token, 'challenge-json': envJson, 'no-onchain': true, 'accept-again': true }, {}, deps);
    expect(again).toMatchObject({ status: 'ok', valid: true, accepted_once: false });
  });

  it('item 1: expected predicates against a pe_fact presentation are refused (the CLI does not bypass the SDK)', async () => {
    const token = peFactToken('gate-1', 'd'.repeat(64));
    const r = await cmdVerifyPresentation(
      { token, audience: 'gate-1', challenge: 'd'.repeat(64), 'no-onchain': true, 'seen-store': join(tmp(), 's.json') },
      { predicate: ['work.total>=10'] },
      quietDeps({ fetchFn: jwksFetch }),
    );
    expect(r).toMatchObject({ status: 'error', valid: false, reason: 'predicates_require_reputation_tier' });
  });

  it('item 6: --expected-presenter mismatch is refused', async () => {
    const token = peFactToken('gate-1', 'e'.repeat(64));
    const r = await cmdVerifyPresentation(
      { token, audience: 'gate-1', challenge: 'e'.repeat(64), 'no-onchain': true, 'expected-presenter': OTHER_ADDR, 'seen-store': join(tmp(), 's.json') },
      {},
      quietDeps({ fetchFn: jwksFetch }),
    );
    expect(r).toMatchObject({ status: 'error', reason: 'presenter_mismatch' });
  });

  it('passes requireOnchain TRUE + acceptOnce TRUE to the SDK verifier by default; --no-onchain / --accept-again are the explicit opt-outs', async () => {
    const token = peFactToken('gate-1', 'a'.repeat(64));
    const seen: Record<string, unknown>[] = [];
    const verifyToken = vi.fn(async (_t: unknown, opts: Record<string, unknown>) => {
      seen.push(opts);
      return { valid: false as const, reason: 'malformed' as const };
    }) as unknown as PresentationCliDeps['verifyToken'];
    const deps = quietDeps({ verifyToken, homeDir: () => tmp() });
    await cmdVerifyPresentation({ token, audience: 'gate-1', challenge: 'a'.repeat(64) }, {}, deps);
    expect(seen[0]).toMatchObject({ requireOnchain: true, acceptOnce: true });
    expect(seen[0].rpcUrl).toBeUndefined(); // the SDK's https://mainnet.base.org default applies
    expect(seen[0].seenStore).toBeDefined();
    await cmdVerifyPresentation({ token, audience: 'gate-1', challenge: 'a'.repeat(64), 'no-onchain': true, 'accept-again': true }, {}, deps);
    expect(seen[1]).toMatchObject({ requireOnchain: false, acceptOnce: false });
    expect(seen[1].seenStore).toBeUndefined();
  });

  it('pe_fact requires the on-chain check by default (an unreachable RPC refuses; --no-onchain is the explicit opt-out)', async () => {
    const token = peFactToken('gate-1', 'f'.repeat(64));
    const r = await cmdVerifyPresentation(
      { token, audience: 'gate-1', challenge: 'f'.repeat(64), 'rpc-url': 'http://127.0.0.1:1', 'seen-store': join(tmp(), 's.json') },
      {},
      quietDeps({ fetchFn: jwksFetch }),
    );
    expect(r).toMatchObject({ status: 'error', valid: false });
    expect(String(r.reason)).toMatch(/^pe_fact_/);
  });
});

// ---------------------------------------------------------------------------
// provian requester-key
// ---------------------------------------------------------------------------

describe('provian requester-key', () => {
  it('writes the private PEM with mode 0600 and returns the well-known document for that key', async () => {
    const out = join(tmp(), 'nested', 'requester.pem');
    const r = await cmdRequesterKey({ domain: 'Gate.Example.com', out, kid: 'k7' }, {}, quietDeps());
    expect(r).toMatchObject({ status: 'ok', domain: DOMAIN, kid: 'k7', key_file_mode: '0600', publish_at: `https://${DOMAIN}/.well-known/provian-requester.json` });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const pub = crypto.createPublicKey(crypto.createPrivateKey(readFileSync(out, 'utf8'))).export({ format: 'jwk' }) as { x: string };
    expect(r.well_known_document).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid: 'k7' }] });
  });

  it('RED: refuses to overwrite an existing key; --force replaces it and re-pins 0600', async () => {
    const out = join(tmp(), 'requester.pem');
    writeFileSync(out, 'old');
    chmodSync(out, 0o644);
    const refused = await cmdRequesterKey({ domain: DOMAIN, out }, {}, quietDeps());
    expect(refused.status).toBe('error');
    expect(readFileSync(out, 'utf8')).toBe('old');
    const forced = await cmdRequesterKey({ domain: DOMAIN, out, force: true }, {}, quietDeps());
    expect(forced.status).toBe('ok');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('RED: a non-hostname domain is refused and nothing is written', async () => {
    const out = join(tmp(), 'requester.pem');
    const r = await cmdRequesterKey({ domain: 'localhost', out }, {}, quietDeps());
    expect(r.status).toBe('error');
    expect(existsSync(out)).toBe(false);
  });
});
