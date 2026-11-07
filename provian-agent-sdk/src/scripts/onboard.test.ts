import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseOnboardArgs,
  resolveConnectionToken,
  resolveRelayUrl,
  isCommonsOptOut,
  buildOnboardJsonReport,
  runOnboard,
  usageText,
  DEFAULT_RELAY_URL,
  type OnboardIO,
  type OnboardJsonReport,
} from './onboard';
import {
  runAgentBootstrap,
  renderBootstrapOutcome,
  DEAD_CODE_LINE,
  FRESH_CODE_LINE,
  type BootstrapDeps,
  type BootstrapInput,
  type BootstrapResult,
  type CreatedWallet,
} from '../bootstrap-flow';
import type { ConnectionCodeCheck } from '../connection-code-check';

const TOKEN = 'PROV-ABCD-2345';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe('parseOnboardArgs', () => {
  it('defaults: nothing set, interactive', () => {
    expect(parseOnboardArgs([])).toEqual({ commonsOptOut: false, json: false, yes: false, help: false });
  });

  it('--token and --code both carry the connection code; = form accepted', () => {
    expect(parseOnboardArgs(['--token', TOKEN]).token).toBe(TOKEN);
    expect(parseOnboardArgs(['--code', TOKEN]).token).toBe(TOKEN);
    expect(parseOnboardArgs([`--token=${TOKEN}`]).token).toBe(TOKEN);
    expect(parseOnboardArgs([`--code=${TOKEN}`]).token).toBe(TOKEN);
  });

  it('--relay, --commons-opt-out, --json, --yes/-y, --help/-h', () => {
    const a = parseOnboardArgs(['--relay', 'https://relay.test', '--commons-opt-out', '--json', '--yes']);
    expect(a.relay).toBe('https://relay.test');
    expect(a.commonsOptOut).toBe(true);
    expect(a.json).toBe(true);
    expect(a.yes).toBe(true);
    expect(parseOnboardArgs(['-y']).yes).toBe(true);
    expect(parseOnboardArgs(['--relay=https://r.test']).relay).toBe('https://r.test');
    expect(parseOnboardArgs(['--help']).help).toBe(true);
    expect(parseOnboardArgs(['-h']).help).toBe(true);
  });

  it('records the first unrecognised argument (a typo must not silently become interactive)', () => {
    expect(parseOnboardArgs(['--tokn', TOKEN]).unknown).toBe('--tokn');
    expect(parseOnboardArgs(['--json', 'stray']).unknown).toBe('stray');
  });

  it('a value flag at the end of argv with no value leaves the field unset', () => {
    expect(parseOnboardArgs(['--token']).token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token sourcing precedence: flag > env > prompt
// ---------------------------------------------------------------------------

describe('resolveConnectionToken — flag > env > prompt', () => {
  const prompt = () => vi.fn(async (_question: string) => 'PROV-PROM-PTED');

  it('flag wins over env, and the prompt is never shown', async () => {
    const p = prompt();
    const r = await resolveConnectionToken({ flagToken: 'PROV-FLAG-0000', env: { PROVIAN_CONNECTION_TOKEN: 'PROV-ENVV-0000' }, interactive: true, prompt: p });
    expect(r).toEqual({ token: 'PROV-FLAG-0000', source: 'flag' });
    expect(p).not.toHaveBeenCalled();
  });

  it('env wins over the prompt when no flag is given', async () => {
    const p = prompt();
    const r = await resolveConnectionToken({ env: { PROVIAN_CONNECTION_TOKEN: 'PROV-ENVV-0000' }, interactive: true, prompt: p });
    expect(r).toEqual({ token: 'PROV-ENVV-0000', source: 'env' });
    expect(p).not.toHaveBeenCalled();
  });

  it('prompts only when interactive and neither flag nor env carries a code', async () => {
    const p = prompt();
    const r = await resolveConnectionToken({ env: {}, interactive: true, prompt: p });
    expect(r).toEqual({ token: 'PROV-PROM-PTED', source: 'prompt' });
    expect(p).toHaveBeenCalledTimes(1);
    // The prompt says the input is hidden, so the person knows not to expect an echo.
    expect(String(p.mock.calls[0][0])).toMatch(/hidden/i);
  });

  it('non-interactive with no code → null, and the prompt is NEVER called', async () => {
    const p = prompt();
    const r = await resolveConnectionToken({ env: {}, interactive: false, prompt: p });
    expect(r).toBeNull();
    expect(p).not.toHaveBeenCalled();
  });

  it('whitespace-only flag / env values fall through (trimmed), never become the code', async () => {
    const p = prompt();
    const r = await resolveConnectionToken({ flagToken: '   ', env: { PROVIAN_CONNECTION_TOKEN: '\t' }, interactive: true, prompt: p });
    expect(r).toEqual({ token: 'PROV-PROM-PTED', source: 'prompt' });
    const trimmed = await resolveConnectionToken({ flagToken: `  ${TOKEN}\n`, env: {}, interactive: false, prompt: p });
    expect(trimmed).toEqual({ token: TOKEN, source: 'flag' });
  });

  // RED: an empty prompt answer is not a code.
  it('RED — an empty prompt answer resolves to null', async () => {
    const r = await resolveConnectionToken({ env: {}, interactive: true, prompt: async () => '   ' });
    expect(r).toBeNull();
  });
});

describe('resolveRelayUrl / isCommonsOptOut', () => {
  it('relay: flag > env > default', () => {
    const base = parseOnboardArgs([]);
    expect(resolveRelayUrl(parseOnboardArgs(['--relay', 'https://a']), { PROVIAN_RELAY_URL: 'https://b' })).toBe('https://a');
    expect(resolveRelayUrl(base, { PROVIAN_RELAY_URL: 'https://b' })).toBe('https://b');
    expect(resolveRelayUrl(base, {})).toBe(DEFAULT_RELAY_URL);
    expect(DEFAULT_RELAY_URL).toBe('https://api.provian.ai');
  });

  it('commons opt-out: flag or env (1/true/yes), default is to JOIN', () => {
    expect(isCommonsOptOut(parseOnboardArgs([]), {})).toBe(false);
    expect(isCommonsOptOut(parseOnboardArgs(['--commons-opt-out']), {})).toBe(true);
    expect(isCommonsOptOut(parseOnboardArgs([]), { PROVIAN_COMMONS_OPT_OUT: '1' })).toBe(true);
    expect(isCommonsOptOut(parseOnboardArgs([]), { PROVIAN_COMMONS_OPT_OUT: 'yes' })).toBe(true);
    expect(isCommonsOptOut(parseOnboardArgs([]), { PROVIAN_COMMONS_OPT_OUT: '0' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The run against fake deps
// ---------------------------------------------------------------------------

const EXPECTED_ORDER = ['agentIdentity', 'createWallet', 'escrow', 'registerDevice', 'startObserver', 'joinCommons', 'linkRequest'];

function fakeWallet(): CreatedWallet {
  return { walletId: 'wallet_aw_onb', address: '0xonb', privateKey: 'ab'.repeat(32), publicKey: 'pub', apiKey: 'pvn_live_onb', apiSecret: 'pvns_onb', recoveryAnchorPubkey: 'anchor' };
}

/**
 * Fake steps that ENFORCE their preconditions: createWallet needs the locally
 * derived identity handed out first, every step after createWallet needs the
 * created wallet's own credentials. A driver that calls them out of order does
 * not merely record a different sequence — it throws. That is what makes the
 * ordering assertion below a control that can actually fail.
 */
function strictDeps(): { deps: BootstrapDeps; calls: string[]; createWalletInputs: Array<{ connectionToken: string; agentId: string }> } {
  const calls: string[] = [];
  const createWalletInputs: Array<{ connectionToken: string; agentId: string }> = [];
  const wallet = fakeWallet();
  let identified = false;
  let created = false;
  const needWallet = (step: string, apiKey: string, apiSecret: string): void => {
    if (!created || apiKey !== wallet.apiKey || apiSecret !== wallet.apiSecret) {
      throw new Error(`${step} called before the wallet existed`);
    }
  };
  const deps: BootstrapDeps = {
    agentIdentity() { calls.push('agentIdentity'); identified = true; return { agentId: 'a1', agentName: 'Atlas' }; },
    async createWallet(input) {
      if (!identified || input.agentId !== 'a1') throw new Error('createWallet called before agentIdentity');
      calls.push('createWallet'); created = true;
      createWalletInputs.push({
        connectionToken: input.connectionToken, agentId: input.agentId,
      });
      return wallet;
    },
    async escrowRecoveryKey(input) { needWallet('escrow', input.apiKey, input.apiSecret); calls.push('escrow'); },
    async registerDevice(input) { needWallet('registerDevice', input.apiKey, input.apiSecret); calls.push('registerDevice'); },
    async startObserver() { if (!created) throw new Error('startObserver before wallet'); calls.push('startObserver'); },
    async joinCommons(input) { needWallet('joinCommons', input.apiKey, input.apiSecret); calls.push('joinCommons'); return { ok: true, joinStatus: 'joined' }; },
    async fileLinkRequest(input) { needWallet('linkRequest', input.apiKey, input.apiSecret); calls.push('linkRequest'); return { ok: true, linkStatus: 'pending' }; },
    log() { /* silent */ },
  };
  return { deps, calls, createWalletInputs };
}

function makeIO(over: Partial<OnboardIO> = {}): { io: OnboardIO; out: string[]; err: string[]; prompt: ReturnType<typeof vi.fn> } {
  const out: string[] = [];
  const err: string[] = [];
  const prompt = vi.fn(async () => 'PROV-PROM-PTED');
  const strict = strictDeps();
  const io: OnboardIO = {
    env: {},
    isTTY: false,
    prompt,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    runBootstrap: runAgentBootstrap,
    deps: () => strict.deps,
    checkCode: async () => ({ verdict: 'proceed' }),
    recordRuntimeEnv: () => undefined,
    // Default to a clock AFTER the Genesis window so the suites below assert the run's
    // own output unchanged; the Genesis offer line has its own open/closed suite.
    now: () => 1_798_761_600_000,
    ...over,
  };
  // Return the prompt actually wired (an override replaces the default spy).
  return { io, out, err, prompt: io.prompt as ReturnType<typeof vi.fn> };
}

function parseReport(out: string[]): OnboardJsonReport {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]) as OnboardJsonReport;
}

describe('runOnboard — the six steps run through the REAL orchestrator, in order', () => {
  it('drives agentIdentity → createWallet → escrow → registerDevice → startObserver → joinCommons → linkRequest and exits 0', async () => {
    const strict = strictDeps();
    const { io, out, err } = makeIO({ deps: () => strict.deps });
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(code).toBe(0);
    expect(strict.calls).toEqual(EXPECTED_ORDER);
    expect(out.join('\n')).toMatch(/Your agent wallet is set up/);
    expect(out.join('\n')).toMatch(/tap Accept to finish the link/);
    expect(err).toEqual([]);
  });

  // RED (ordering): the precondition-enforcing fakes reject a violating driver.
  // A driver shaped like a naive "register the device first" script throws on
  // its first out-of-order call, so the sequence assertion above is backed by
  // fakes that can tell order apart, not by a list that any driver would fill.
  it('RED — a misordered driver is rejected by the same fakes (registerDevice before createWallet throws)', async () => {
    const strict = strictDeps();
    const misordered = async (input: BootstrapInput, deps: BootstrapDeps): Promise<BootstrapResult> => {
      deps.agentIdentity();
      await deps.registerDevice({ relayUrl: input.relayUrl, walletId: 'none', apiKey: 'none', apiSecret: 'none' });
      throw new Error('unreachable');
    };
    await expect(misordered({ connectionToken: TOKEN, relayUrl: DEFAULT_RELAY_URL }, strict.deps))
      .rejects.toThrow(/registerDevice called before the wallet existed/);
    expect(strict.calls).not.toEqual(EXPECTED_ORDER);
    expect(strict.calls).toEqual(['agentIdentity']);
  });

  it('RED — a driver that skips a step is visible in the recorded sequence', async () => {
    const strict = strictDeps();
    const skipping = async (input: BootstrapInput, deps: BootstrapDeps): Promise<BootstrapResult> => {
      const id = deps.agentIdentity();
      const w = await deps.createWallet({ relayUrl: input.relayUrl, agentId: id.agentId, agentName: id.agentName, connectionToken: input.connectionToken, registrationChannel: 'npm_sdk' });
      // no escrow, no device, no observer, no Commons
      const link = await deps.fileLinkRequest({ relayUrl: input.relayUrl, walletId: w.walletId, apiKey: w.apiKey, apiSecret: w.apiSecret, connectionToken: input.connectionToken });
      return { walletId: w.walletId, address: w.address, recoveryEscrowed: false, deviceRegistered: false, observerStarted: false, commonsJoined: false, linkRequested: link.ok, linkStatus: link.linkStatus, notes: [] };
    };
    const { io } = makeIO({ deps: () => strict.deps, runBootstrap: skipping });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--yes']), io);
    expect(strict.calls).not.toEqual(EXPECTED_ORDER);
    expect(strict.calls).toEqual(['agentIdentity', 'createWallet', 'linkRequest']);
  });

  it('--commons-opt-out skips the join (six of seven calls) and still links', async () => {
    const strict = strictDeps();
    const { io, out } = makeIO({ deps: () => strict.deps });
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN, '--commons-opt-out']), io);
    expect(code).toBe(0);
    expect(strict.calls).toEqual(EXPECTED_ORDER.filter((s) => s !== 'joinCommons'));
    expect(out.join('\n')).not.toMatch(/in the Commons/);
    expect(out.join('\n')).toMatch(/opted out of the Commons/);
  });
});


describe('the code check runs ahead of every write', () => {
  /** A run whose every seam records itself, in order, in `order`. */
  function recording(check: ConnectionCodeCheck): ReturnType<typeof makeIO> & { order: string[]; strict: ReturnType<typeof strictDeps> } {
    const order: string[] = [];
    const strict = strictDeps();
    const deps: BootstrapDeps = {
      ...strict.deps,
      agentIdentity() { order.push('agentIdentity'); return strict.deps.agentIdentity(); },
    };
    const made = makeIO({
      deps: () => deps,
      checkCode: async (input) => { order.push(`check:${input.connectionToken}@${input.relayUrl}`); return check; },
      recordRuntimeEnv: () => { order.push('recordRuntimeEnv'); },
    });
    return { ...made, order, strict };
  }

  it('a code that may proceed is checked, then recorded, then run', async () => {
    const { io, order } = recording({ verdict: 'proceed' });
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(code).toBe(0);
    expect(order).toEqual([`check:${TOKEN}@${DEFAULT_RELAY_URL}`, 'recordRuntimeEnv', 'agentIdentity']);
  });

  it.each([
    ['a dead code', { verdict: 'dead' } as ConnectionCodeCheck],
    ['a rate limit', { verdict: 'rate_limited' } as ConnectionCodeCheck],
    ['no ruling', { verdict: 'unruled', error: new Error('fetch failed') } as ConnectionCodeCheck],
  ])('%s stops the run with exit 1: nothing recorded, no step run', async (_label, check) => {
    const { io, order, strict } = recording(check);
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(code).toBe(1);
    expect(order).toEqual([`check:${TOKEN}@${DEFAULT_RELAY_URL}`]);
    expect(strict.calls).toEqual([]);
  });

  it('no code at all never reaches the check', async () => {
    const { io, order } = recording({ verdict: 'proceed' });
    expect(await runOnboard(parseOnboardArgs(['--yes']), io)).toBe(1);
    expect(order).toEqual([]);
  });

  it('a dead code prints the same two sentences a failed link prints', async () => {
    const { io, err } = recording({ verdict: 'dead' });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    const failedLink = renderBootstrapOutcome({
      walletId: 'w', address: '0x', recoveryEscrowed: true, deviceRegistered: true, observerStarted: true,
      commonsJoined: false, linkRequested: false, notes: [],
    }).stderr;
    expect(failedLink).toEqual(expect.arrayContaining(err.filter((l) => l.length > 0)));
    expect(err.filter((l) => l.length > 0)).toEqual([`  ${DEAD_CODE_LINE}`, `  ${FRESH_CODE_LINE}`]);
  });

  it('a rate limit tells a person to wait, and --json does not ask for a fresh code', async () => {
    const human = recording({ verdict: 'rate_limited' });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), human.io);
    expect(human.err).toContain('  Too many requests. Please try again later.');
    expect(human.err.join('\n')).not.toContain(DEAD_CODE_LINE);
    const machine = recording({ verdict: 'rate_limited' });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), machine.io);
    expect(parseReport(machine.out).next_step).toBe('Run onboard again later.');
  });

  it('no ruling names the actual reason, with the egress request when the network path failed', async () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.provian.ai'), { code: 'ENOTFOUND' });
    const { io, err } = recording({ verdict: 'unruled', error: Object.assign(new TypeError('fetch failed'), { cause: dns }) });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    const printed = err.join('\n');
    expect(err).toContain('  Provian could not check your invite code just now, so nothing was set up.');
    expect(printed).toContain('could not look up api.provian.ai');
    expect(printed).toContain('ask your human once for ONE standing');
    expect(printed).not.toContain(DEAD_CODE_LINE);
    expect(printed).not.toContain(TOKEN);
  });

  // The route never sends a 403 or a redirect, so these came from something on the way to it.
  it.each([
    ['a 503', Object.assign(new Error('the invite code check did not finish'), { code: 'HTTP_503' })],
    ['a proxy\'s 403', Object.assign(new Error('the invite code check did not finish'), { code: 'HTTP_403' })],
    ['a redirect', new Error('egress redirect refused')],
  ])('%s gets no blame on the relay, no fresh-code advice, and the allow request sh prints', async (_label, error) => {
    const { io, err } = recording({ verdict: 'unruled', answered: true, error });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    const printed = err.join('\n');
    expect(err).toContain(`  The check got no usable answer from ${new URL(DEFAULT_RELAY_URL).host}. Wait a few minutes, then run onboard again.`);
    expect(printed).toContain('ask your human once for ONE standing');
    expect(printed).not.toMatch(/fresh code|answered HTTP|not a connection problem/);
  });

  it('the --json messages and next step agree when the answer was a proxy\'s 403', async () => {
    const { io, out } = recording({ verdict: 'unruled', answered: true, error: Object.assign(new Error('x'), { code: 'HTTP_403' }) });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io);
    const report = parseReport(out);
    expect(report.next_step).toBe('Run onboard again.');
    expect(report.messages.join('\n')).not.toContain('fresh code');
  });

  // These stop on this machine, so nothing was asked, no wait helps, and nothing needs allowing.
  it.each([
    ['a relay that is not https', 'http://relay.example:3000', 'EGRESS_HTTPS_REQUIRED', 'egress refused: HTTPS_REQUIRED: Egress must be HTTPS, got http:', 'Reason: EGRESS_HTTPS_REQUIRED'],
    ['a relay that is no URL', 'api.provian.ai:443', 'EGRESS_INVALID_URL', 'egress refused: INVALID_URL: Invalid destination URL', 'Reason: EGRESS_INVALID_URL'],
    ['a proxy that cannot be used', DEFAULT_RELAY_URL, undefined, 'egress proxy protocol refused', 'is not an http:// or https:// proxy'],
  ])('%s keeps its actual reason and asks for no allow', async (_label, relay, code, message, reason) => {
    const { io, err } = recording({ verdict: 'unruled', error: Object.assign(new Error(message), code ? { code } : {}) });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--relay', relay]), io);
    const printed = err.join('\n');
    expect(printed).toContain(reason);
    expect(printed).not.toContain('no usable answer');
    expect(printed).not.toContain('Wait a few minutes');
    expect(printed).not.toContain('ask your human once for ONE standing');
  });

  it('a relay URL with no host is still named in the output', async () => {
    const { io, err } = recording({ verdict: 'unruled', answered: true, error: new Error('x') });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--relay', 'api.provian.ai:443']), io);
    expect(err.join('\n')).toContain('no usable answer from api.provian.ai:443.');
  });

  it('--json: one object, and a code left unruled is not called dead', async () => {
    const { io, out } = recording({ verdict: 'unruled', error: new Error('fetch failed') });
    expect(await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io)).toBe(1);
    const report = parseReport(out);
    expect(report).toMatchObject({ status: 'failed', exit_code: 1, wallet_id: null, next_step: 'Run onboard again.' });
  });

  it('--json: a dead code asks for a fresh one', async () => {
    const { io, out } = recording({ verdict: 'dead' });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io);
    const report = parseReport(out);
    expect(report.messages).toEqual([DEAD_CODE_LINE, FRESH_CODE_LINE]);
    expect(report.next_step).toMatch(/fresh code/);
  });

  it('main() writes nothing ahead of runOnboard, and hands it the check and the record', () => {
    const src = readFileSync(resolve(__dirname, 'onboard.ts'), 'utf8');
    const main = src.slice(src.indexOf('async function main('));
    expect(main.indexOf('persistRuntimeEnv(')).toBeGreaterThan(main.indexOf('recordRuntimeEnv:'));
    expect(main).toContain('checkCode: (input) => checkConnectionCode(input),');
    expect(main).toContain('applyRuntimeEnvAtEntry(args.help ? {} : { recorded: computeRuntimeEnv(process.env) });');
  });

  // RED: a driver that writes first is visible to the same recorder.
  it('RED — a run with the record ahead of the check is visible in the recorded order', async () => {
    const { io, order } = recording({ verdict: 'dead' });
    io.recordRuntimeEnv();
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(order).toEqual(['recordRuntimeEnv', `check:${TOKEN}@${DEFAULT_RELAY_URL}`]);
  });
});

describe('pass-through — the connection code reaches runAgentBootstrap and, through it, createWallet', () => {
  it('hands runAgentBootstrap the EXACT resolved code and the deps object io.deps() returned', async () => {
    const spy = vi.fn<OnboardIO['runBootstrap']>(async (): Promise<BootstrapResult> => ({
      walletId: 'w', address: '0x', recoveryEscrowed: true, deviceRegistered: true, observerStarted: true,
      commonsJoined: true, commonsJoinStatus: 'joined', linkRequested: true, linkStatus: 'pending', notes: [],
    }));
    const strict = strictDeps();
    const { io } = makeIO({ runBootstrap: spy, deps: () => strict.deps, env: { PROVIAN_CONNECTION_TOKEN: TOKEN, PROVIAN_RELAY_URL: 'https://relay.test' } });
    const code = await runOnboard(parseOnboardArgs(['--yes']), io);
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ connectionToken: TOKEN, relayUrl: 'https://relay.test', commonsOptOut: false });
    // Identity, not shape: the very deps object, so no local copy of a step can slip in.
    expect(spy.mock.calls[0][1]).toBe(strict.deps);
  });

  it('through the real orchestrator, createWallet receives that same code (flag, env, and prompt sources)', async () => {
    for (const [argv, env, isTTY] of [
      [['--token', TOKEN], {}, false],
      [['--yes'], { PROVIAN_CONNECTION_TOKEN: TOKEN }, false],
      [[], {}, true],
    ] as Array<[string[], NodeJS.ProcessEnv, boolean]>) {
      const strict = strictDeps();
      const { io, prompt } = makeIO({ deps: () => strict.deps, env, isTTY, prompt: vi.fn(async () => TOKEN) });
      const code = await runOnboard(parseOnboardArgs(argv), io);
      expect(code).toBe(0);
      expect(strict.createWalletInputs).toEqual([{ connectionToken: TOKEN, agentId: 'a1' }]);
      expect(prompt).toHaveBeenCalledTimes(isTTY ? 1 : 0);
    }
  });

  // RED: the createWallet-input capture distinguishes present from absent — a
  // dep shaped like the pre- orchestrator (token dropped) is observed dropping it.
  it('RED — a createWallet that drops the token is observed dropping it', async () => {
    let seen: unknown = 'unset';
    const strict = strictDeps();
    const dropping: BootstrapDeps = {
      ...strict.deps,
      async createWallet(input) {
        const { connectionToken: _dropped, ...rest } = input;
        seen = (rest as Record<string, unknown>).connectionToken;
        return strict.deps.createWallet(input);
      },
    };
    const { io } = makeIO({ deps: () => dropping });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(seen).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Source-bound control: the bin is a client of bootstrap-flow, never a fork of it.
// ---------------------------------------------------------------------------

describe('onboard.ts is wired to the ONE implementation (source-bound, with RED)', () => {
  const source = (): string => readFileSync(resolve(__dirname, 'onboard.ts'), 'utf8');

  /** The production wiring block inside main() — scoped, not file-wide. */
  const mainWiring = (): string => {
    const src = source();
    const start = src.indexOf('async function main(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('process.exit(code)', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('imports runAgentBootstrap + defaultBootstrapDeps from ../bootstrap-flow and wires exactly those', () => {
    const src = source();
    expect(src).toMatch(/import \{[\s\S]*?runAgentBootstrap,[\s\S]*?defaultBootstrapDeps,[\s\S]*?\} from '\.\.\/bootstrap-flow';/);
    expect(mainWiring()).toContain('runBootstrap: runAgentBootstrap,');
    expect(mainWiring()).toContain('deps: () => defaultBootstrapDeps(),');
  });

  it('defines no step of its own (no connect/createWallet/escrow/register/link implementation here)', () => {
    const src = source();
    for (const forbidden of ['async connect(', 'async createWallet(', 'async escrowRecoveryKey(', 'async registerDevice(', 'async fileLinkRequest(', '/v1/relay/agent/connect', '/v1/agent/wallet/create', 'recovery-escrow', '/v1/devices/register']) {
      expect(src, `onboard.ts must not carry its own "${forbidden}" — that is a forked flow`).not.toContain(forbidden);
    }
  });

  it('RED — the wiring scan reports ABSENT when the orchestrator is swapped for a local copy', () => {
    const mutated = mainWiring().replace('runBootstrap: runAgentBootstrap,', 'runBootstrap: localCopyOfBootstrap,');
    expect(mutated).not.toContain('runBootstrap: runAgentBootstrap,');
    const mutatedDeps = mainWiring().replace('deps: () => defaultBootstrapDeps(),', 'deps: () => myOwnDeps(),');
    expect(mutatedDeps).not.toContain('deps: () => defaultBootstrapDeps(),');
  });

  it('RED — the scanned region is main(), non-empty, and not the whole file', () => {
    expect(mainWiring().length).toBeGreaterThan(100);
    expect(mainWiring().length).toBeLessThan(source().length);
    expect(mainWiring()).not.toContain('export async function runOnboard');
  });

  it('never prints the connection code (no template or concatenation of the token into output)', () => {
    const src = source();
    // The token is only ever passed as a value — never interpolated into a printed string.
    expect(src).not.toMatch(/\$\{(resolved\.token|args\.token|input\.connectionToken|token)\}/);
  });
});

// ---------------------------------------------------------------------------
// --json, --yes, and the no-raw-errors rule
// ---------------------------------------------------------------------------

describe('runOnboard — --json / --yes / plain-sentence failures', () => {
  it('--json: one JSON object on stdout, status ok, next_step = Accept, and nothing else on stdout', async () => {
    const strict = strictDeps();
    const { io, out, err } = makeIO({ deps: () => strict.deps });
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io);
    const report = parseReport(out);
    expect(code).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.exit_code).toBe(0);
    expect(report.wallet_id).toBe('wallet_aw_onb');
    expect(report.address).toBe('0xonb');
    expect(report).toMatchObject({ recovery_escrowed: true, device_registered: true, observer_started: true, commons_joined: true, commons_join_status: 'joined', link_requested: true, link_status: 'pending' });
    expect(report.next_step).toMatch(/tap Accept/);
    expect(report.messages.join('\n')).toMatch(/Your agent wallet is set up/);
    expect(err).toEqual([]);
  });

  it('--json never prompts, even on a TTY: missing code → failed report, exit 1, prompt not called', async () => {
    const { io, out, prompt } = makeIO({ isTTY: true });
    const code = await runOnboard(parseOnboardArgs(['--json']), io);
    expect(code).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    const report = parseReport(out);
    expect(report.status).toBe('failed');
    expect(report.wallet_id).toBeNull();
    expect(report.messages.join('   ')).toMatch(/No connection code was provided/);
  });

  it('--yes never prompts on a TTY: missing code → plain sentences on stderr, exit 1', async () => {
    const { io, out, err, prompt } = makeIO({ isTTY: true });
    const code = await runOnboard(parseOnboardArgs(['--yes']), io);
    expect(code).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/No connection code was provided/);
    expect(err.join('\n')).toMatch(/Connect an agent/);
  });

  it('RED CONTROL: a link that did not file is a FAILURE (exit 1) in both the human and JSON forms', async () => {
    const strict = strictDeps();
    const deps: BootstrapDeps = { ...strict.deps, async fileLinkRequest() { return { ok: false, error: 'http_404' }; } };
    const human = makeIO({ deps: () => deps });
    expect(await runOnboard(parseOnboardArgs(['--token', TOKEN]), human.io)).toBe(1);
    expect(human.out).toEqual([]);
    expect(human.err.join('\n')).toMatch(/nothing is linked yet/);
    expect(human.err.join('\n')).not.toMatch(/http_404|link_request_error/);

    const machine = makeIO({ deps: () => deps });
    expect(await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), machine.io)).toBe(1);
    const report = parseReport(machine.out);
    expect(report.status).toBe('failed');
    expect(report.exit_code).toBe(1);
    expect(report.link_requested).toBe(false);
    expect(report.wallet_id).toBe('wallet_aw_onb'); // the wallet DOES exist; the report says so
    expect(JSON.stringify(report)).not.toMatch(/http_404|link_request_error/);
    expect(report.next_step).toMatch(/fresh code/);
  });

  it('a network failure names its actual reason, never a stack ', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 34.1.2.3:443'), { code: 'ECONNREFUSED' });
    const thrown = Object.assign(new Error('Failed to reach relay: fetch failed'), { code: 'CONNECTION_ERROR', cause });
    const { io, out, err } = makeIO({ runBootstrap: async () => { throw thrown; } });
    const code = await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    const text = err.join('\n');
    expect(text).toMatch(/could not connect to/);
    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).not.toMatch(/    at /); // no stack frames
  });

  it('a local failure is never reported as a connection problem', async () => {
    const { io, err } = makeIO({ runBootstrap: async () => { throw new Error('Pending agent wallet registration key binding is invalid'); } });
    expect(await runOnboard(parseOnboardArgs(['--token', TOKEN]), io)).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/stopped on this machine/);
    expect(text).toMatch(/key binding is invalid/);
    expect(text).not.toMatch(/internet connection|could not (reach|connect)/);
  });

  // The steady state a --json caller acts on, so it has to match what the messages say.
  it.each([
    ['a dropped connection', Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }), 'Run onboard again.'],
    ['a failed lookup', Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('no address'), { code: 'ENOTFOUND' }) }), 'Run onboard again.'],
    ['a fault on this machine', new Error('Pending agent wallet registration key binding is invalid'), 'Run onboard again.'],
    ['a relay 503', Object.assign(new Error('down'), { code: 'HTTP_503' }), 'Run onboard again later.'],
    ['a rate limit', Object.assign(new Error('slow down'), { code: 'HTTP_429' }), 'Run onboard again later.'],
  ])('--json after %s does not ask for a fresh code', async (_label, thrown, nextStep) => {
    const { io, out } = makeIO({ runBootstrap: async () => { throw thrown; } });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io);
    expect(parseReport(out).next_step).toBe(nextStep);
  });

  it.each([[403], [409], [410]])('RED control: --json after a relay %i still asks for a fresh code', async (status) => {
    const thrown = Object.assign(new Error('refused'), { code: `HTTP_${status}` });
    const { io, out } = makeIO({ runBootstrap: async () => { throw thrown; } });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io);
    expect(parseReport(out).next_step).toMatch(/fresh code/);
  });

  it('a relay error names the status and the relay\'s message; secrets are masked', async () => {
    const thrown = Object.assign(new Error(`connection code ${TOKEN} has expired`), { code: 'HTTP_410' });
    const { io, out, err } = makeIO({ runBootstrap: async () => { throw thrown; } });
    expect(await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), io)).toBe(1);
    const report = parseReport(out);
    expect(report.status).toBe('failed');
    expect(report.wallet_id).toBeNull();
    const text = JSON.stringify(report);
    expect(text).toMatch(/HTTP 410/);
    expect(text).toMatch(/has expired/);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/internet connection/);
    expect(err).toEqual([]);
  });

  it('an unrecognised option is refused plainly (exit 1) rather than starting a run', async () => {
    const spy = vi.fn<OnboardIO['runBootstrap']>();
    const { io, err } = makeIO({ runBootstrap: spy });
    const code = await runOnboard(parseOnboardArgs(['--tokn', TOKEN]), io);
    expect(code).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/Unrecognised option: --tokn/);
    expect(err.join('\n')).toMatch(/Usage:/);
  });

  it('--help prints usage (stdout, exit 0) and documents the process-list caveat for --token', async () => {
    const spy = vi.fn<OnboardIO['runBootstrap']>();
    const { io, out } = makeIO({ runBootstrap: spy });
    expect(await runOnboard(parseOnboardArgs(['--help']), io)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(out.join('\n')).toBe(usageText());
    expect(usageText()).toMatch(/process list/);
    expect(usageText()).toMatch(/PROVIAN_CONNECTION_TOKEN/);
    expect(usageText()).toMatch(/--commons-opt-out/);
  });
});

describe('buildOnboardJsonReport — derived from renderBootstrapOutcome, not a second decision', () => {
  const base: BootstrapResult = {
    walletId: 'w', address: '0x', recoveryEscrowed: false, deviceRegistered: true, observerStarted: false,
    commonsJoined: false, commonsJoinStatus: 'skipped', linkRequested: true, linkStatus: 'already_linked',
    notes: ['You opted out of the Commons; this agent stays out of the public town square.'],
  };

  it('already linked → ok, no next step; visible notes carried; internal link code filtered', () => {
    const r = buildOnboardJsonReport({ ...base, notes: [...base.notes, 'link_request_error:http_401'] });
    expect(r.status).toBe('ok');
    expect(r.next_step).toBeNull();
    expect(r.notes).toEqual(base.notes);
    expect(r.commons_join_status).toBe('skipped');
    expect(r.link_status).toBe('already_linked');
  });

  it('device not registered with the link filed → run again on the same code, as the messages say', () => {
    const r = buildOnboardJsonReport({ ...base, deviceRegistered: false, notes: ['device_registration_failed'] });
    expect(r.next_step).toBe('Run onboard again.');
    expect(r.messages.join('\n')).toContain('picks up the same wallet');
    expect(r.messages.join('\n')).not.toContain('fresh code');
  });

  it('RED control: a link that did not file still asks for a fresh code, with or without the device', () => {
    const unfiled = { ...base, linkRequested: false, linkStatus: undefined };
    expect(buildOnboardJsonReport(unfiled).next_step).toMatch(/fresh code/);
    expect(buildOnboardJsonReport({ ...unfiled, deviceRegistered: false }).next_step).toMatch(/fresh code/);
  });

  it('RED — (A): device not registered → failed with exit_code 1, internal note not surfaced', () => {
    const r = buildOnboardJsonReport({ ...base, deviceRegistered: false, notes: ['device_registration_failed'] });
    expect(r.status).toBe('failed');
    expect(r.exit_code).toBe(1);
    expect(r.notes).toEqual([]);
  });

  it('RED — link not filed → failed with exit_code 1', () => {
    const r = buildOnboardJsonReport({ ...base, linkRequested: false, linkStatus: undefined, notes: ['link_request_error:http_404'] });
    expect(r.status).toBe('failed');
    expect(r.exit_code).toBe(1);
    expect(r.link_status).toBeNull();
    expect(r.notes).toEqual([]);
  });
});

describe('onboard leads with the Genesis offer line while the window is open', () => {
  const LINE = 'Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.';

  it('OPEN (1 ms before the end): the FIRST stderr line is exactly the offer; --json stdout stays one object', async () => {
    const human = makeIO({ now: () => 1_798_761_599_999 });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), human.io);
    expect(human.err[0]).toBe(LINE);

    const machine = makeIO({ now: () => 1_798_761_599_999 });
    await runOnboard(parseOnboardArgs(['--token', TOKEN, '--json']), machine.io);
    expect(machine.err[0]).toBe(LINE);
    parseReport(machine.out); // exactly one JSON object on stdout
  });

  it('RED CONTROL: CLOSED at exactly 1798761600000 — the line is absent everywhere', async () => {
    const { io, out, err } = makeIO({ now: () => 1_798_761_600_000 });
    await runOnboard(parseOnboardArgs(['--token', TOKEN]), io);
    expect([...out, ...err].join('\n')).not.toContain('Genesis is open');
  });
});
