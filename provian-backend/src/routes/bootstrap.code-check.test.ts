import { describe, it, expect, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createBootstrapRouter } from './bootstrap';
import {
  AGENT_BOOTSTRAP_CODE_CHECK_ROUTE,
  AGENT_WALLET_STATE_FILES,
  CODE_CHECK_UNAVAILABLE_LINE,
  DEAD_CODE_LINES,
  TOO_MANY_REQUESTS_LINE,
  agentCodeCheckPs,
  agentCodeCheckSh,
  buildAgentBootstrapPowershell,
  buildAgentBootstrapScript,
} from '../core/agent-bootstrap-script';
import { BOOTSTRAP_NODE_VERSION } from '../core/bootstrap-node-ensure';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';

const LIVE = 'PROV-ABCD-2345';
const PLACEHOLDER = 'PROV-XXXX-XXXX';
const EXPIRED = 'PROV-ABCD-2346';
const LIVE_FLEET = 'PROV-ABCD-2347';
const USED_FLEET = 'PROV-ABCD-2348';
const ORPHAN_FLEET = 'PROV-ABCD-2349';
const USED_EXPIRED_FLEET = 'PROV-ABCD-2352';
const HUMAN = 'user-1';

const later = Date.now() + 3_600_000;
const earlier = Date.now() - 1000;
const fleet = { kind: 'fleet', user_id: HUMAN, issued_by_agent_wallet_id: 'issuer' };
const CODES: Record<string, Record<string, unknown>> = {
  [LIVE]: { user_id: HUMAN, expires_at: later },
  [EXPIRED]: { user_id: HUMAN, expires_at: earlier },
  [LIVE_FLEET]: { ...fleet, expires_at: later, used: false },
  [USED_FLEET]: { ...fleet, expires_at: later, used: true, used_by_wallet_id: 'someone' },
  [USED_EXPIRED_FLEET]: { ...fleet, expires_at: earlier, used: true, used_by_wallet_id: 'someone' },
  [ORPHAN_FLEET]: { kind: 'fleet', user_id: HUMAN, issued_by_agent_wallet_id: 'gone', expires_at: later, used: false },
};
const WALLETS: Record<string, Record<string, unknown>> = {
  issuer: { status: 'active', linked_human_user_id: HUMAN },
  gone: { status: 'active', linked_human_user_id: 'someone-else' },
};

function fakeDb(onRead: () => void = () => {}): Firestore {
  const rows: Record<string, Record<string, Record<string, unknown>>> = { connection_tokens: CODES, agent_wallets: WALLETS };
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          onRead();
          const row = rows[name]?.[id];
          return { exists: row !== undefined, data: () => row };
        },
      }),
    }),
  } as unknown as Firestore;
}

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-code-check-'));
const BUNDLE = path.join(BUNDLE_DIR, 'agent.js');
fs.writeFileSync(BUNDLE, 'console.log("agent bundle");\n');
afterAll(() => fs.rmSync(BUNDLE_DIR, { recursive: true, force: true }));

function buildApp(db: Firestore = fakeDb(), checkRateLimit: (key: string) => { allowed: boolean } = () => ({ allowed: true })) {
  const app = express();
  app.use('/v1/bootstrap', createBootstrapRouter({
    db,
    cache: {
      async checkRateLimit(key: string) { return checkRateLimit(key); },
      async getConnectionToken() { return null; },
    },
    bundlePath: BUNDLE,
  }));
  return app;
}

async function servedScript(code: string): Promise<string> {
  const res = await request(buildApp()).get('/v1/bootstrap/agent').set('x-provian-token', code);
  expect(res.status).toBe(200);
  return res.text;
}

const relayVerdict = async (code: string): Promise<number> =>
  (await request(buildApp()).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', code)).status;

// -- the rig: run the script as `curl … | sh` does, in a HOME holding nothing ------------

const SHIM_CURL = `#!/bin/sh
printf '%s\\n' "$*" >> "$RIG_LOG"
case "$*" in
  *${AGENT_BOOTSTRAP_CODE_CHECK_ROUTE}*)
    if [ "$RIG_CODE_STATUS" = unreachable ]; then printf '000'; exit 7; fi
    printf '%s' "$RIG_CODE_STATUS"
    exit 0
    ;;
  *agent.js*)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; cp "$RIG_BUNDLE" "$1"; fi
      shift
    done
    exit 0
    ;;
esac
exit 22
`;
const SHIM_NODE = `#!/bin/sh
case "$1" in
  -e) exit 0 ;;
  --version) echo ${BOOTSTRAP_NODE_VERSION}; exit 0 ;;
esac
printf '%s %s %s\\n' "$PROVIAN_CONNECTION_TOKEN" "$PROVIAN_RELAY_URL" "$1" > "$RIG_NODE_RAN"
`;

interface RigResult {
  status: number | null;
  stderr: string;
  /** Every path the run left under HOME. */
  home: string[];
  curlCalls: string[];
  /** What the bundle was started with, or null when it never started. */
  nodeRan: string | null;
}

function walk(dir: string, root: string = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return [path.relative(root, full), ...(entry.isDirectory() ? walk(full, root) : [])];
  });
}

/**
 * `runtimeOnMachine` seeds the pinned Node where the prelude reuses it, as after any earlier
 * run: on a bare machine the prelude downloads Node, which this rig cannot serve. The refusal
 * cases never set it, so their HOME holds nothing at all.
 */
function runInRig(
  script: string,
  codeStatus: string,
  opts: { shell?: string; stateFile?: string; runtimeOnMachine?: boolean } = {},
): RigResult {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-code-check-rig-'));
  try {
    const home = path.join(rig, 'home');
    const bin = path.join(rig, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), SHIM_CURL, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'node'), SHIM_NODE, { mode: 0o755 });
    if (opts.runtimeOnMachine) {
      fs.mkdirSync(path.join(home, '.provian', 'node', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(home, '.provian', 'node', 'bin', 'node'), SHIM_NODE, { mode: 0o755 });
    }
    if (opts.stateFile) {
      fs.mkdirSync(path.join(home, '.provian'), { recursive: true });
      fs.writeFileSync(path.join(home, '.provian', opts.stateFile), '{}');
    }
    const log = path.join(rig, 'curl.log');
    const nodeRan = path.join(rig, 'node-ran');
    const r = spawnSync(opts.shell ?? 'sh', [], {
      input: script,
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        RIG_LOG: log,
        RIG_NODE_RAN: nodeRan,
        RIG_BUNDLE: BUNDLE,
        RIG_CODE_STATUS: codeStatus,
      },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      home: walk(home),
      curlCalls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(rig).join('<rig>').trim().split('\n') : [],
      nodeRan: fs.existsSync(nodeRan) ? fs.readFileSync(nodeRan, 'utf8').split(rig).join('<rig>').trim() : null,
    };
  } finally {
    fs.rmSync(rig, { recursive: true, force: true });
  }
}

/** The served script with its code check cut out, for the controls below. Refuses a cut that removed nothing. */
function withoutCheck(script: string): string {
  const relayHost = new URL(/^RELAY_URL='([^']+)'$/m.exec(script)?.[1] ?? '').host;
  const cut = script.replace(agentCodeCheckSh(relayHost), '');
  expect(cut).not.toBe(script);
  expect(cut).not.toContain(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
  return cut;
}

const SHELLS = ['sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])];

function expectRefusedClean(run: RigResult): void {
  expect(run.status).toBe(1);
  expect(run.home).toEqual([]);
  expect(run.nodeRan).toBeNull();
  expect(run.curlCalls).toHaveLength(1); // the check alone: no bundle, no Node download
}

function expectFreshCodeMessage(run: RigResult): void {
  const lines = run.stderr.split('\n');
  for (const line of DEAD_CODE_LINES) expect(lines).toContain(line);
}

// ----------------------------------------------------------------------------------------

describe('GET /v1/bootstrap/agent/code', () => {
  it('the placeholder is a well-formed code, so only the relay can turn it away', () => {
    expect(isValidConnectionTokenFormat(PLACEHOLDER)).toBe(true);
  });

  it.each([
    ['a live human code', LIVE, 200],
    ['a live fleet code', LIVE_FLEET, 200],
    ['the placeholder', PLACEHOLDER, 404],
    ['an expired code', EXPIRED, 410],
    ['a fleet code whose issuer is no longer linked', ORPHAN_FLEET, 410],
    ['a used fleet code', USED_FLEET, 409],
    ['a used fleet code past its expiry', USED_EXPIRED_FLEET, 409],
  ])('%s answers its status', async (_label, code, status) => {
    expect(await relayVerdict(code as string)).toBe(status);
  });

  it('answers no-store, and a malformed or missing code is 400', async () => {
    const app = buildApp();
    expect((await request(app).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', LIVE)).headers['cache-control']).toContain('no-store');
    expect((await request(app).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', 'nope')).status).toBe(400);
    expect((await request(app).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE)).status).toBe(400);
  });

  it('a relay that cannot read the code answers 503, never a verdict', async () => {
    const db = fakeDb(() => { throw new Error('firestore down'); });
    const res = await request(buildApp(db)).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', LIVE);
    expect(res.status).toBe(503);
  });

  it('limits by the minute and by the hour, in buckets of its own so an install is not counted twice', async () => {
    const keysOf = async (url: string): Promise<string[]> => {
      const keys: string[] = [];
      await request(buildApp(fakeDb(), (key) => { keys.push(key); return { allowed: true }; }))
        .get(url).set('x-provian-token', LIVE);
      return keys;
    };
    const checkKeys = await keysOf(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
    const scriptKeys = await keysOf('/v1/bootstrap/agent');
    expect(checkKeys).toHaveLength(2);
    expect(scriptKeys).toHaveLength(2);
    for (const key of checkKeys) expect(scriptKeys).not.toContain(key);
  });

  it.each([['minute', 1], ['hour', 2]])('the %s limit answers 429 before any read', async (_label, refusedCall) => {
    let reads = 0;
    let calls = 0;
    const app = buildApp(fakeDb(() => { reads += 1; }), () => { calls += 1; return { allowed: calls !== refusedCall }; });
    const res = await request(app).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', LIVE);
    expect(res.status).toBe(429);
    expect(calls).toBe(refusedCall);
    expect(reads).toBe(0);
  });

  it('a live fleet code stays live after a check: looking spends nothing', async () => {
    const app = buildApp();
    for (let i = 0; i < 2; i += 1) {
      expect((await request(app).get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE).set('x-provian-token', LIVE_FLEET)).status).toBe(200);
    }
    expect(CODES[LIVE_FLEET].used).toBe(false);
  });

  it('serving the script still reads no record: a look only checks the format', async () => {
    let reads = 0;
    const app = buildApp(fakeDb(() => { reads += 1; }));
    const res = await request(app).get('/v1/bootstrap/agent').set('x-provian-token', PLACEHOLDER);
    expect(res.status).toBe(200);
    expect(reads).toBe(0);
  });
});

describe.each(SHELLS)('the served install script under %s', (shell) => {
  it.each([
    ['the placeholder', PLACEHOLDER],
    ['an expired code', EXPIRED],
    ['a fleet code whose issuer is no longer linked', ORPHAN_FLEET],
    ['a used fleet code', USED_FLEET],
    ['a used fleet code past its expiry', USED_EXPIRED_FLEET],
  ])('%s prints the fresh-code message, exits 1 and leaves nothing', async (_label, code) => {
    const run = runInRig(await servedScript(code), String(await relayVerdict(code)), { shell });
    expectRefusedClean(run);
    expectFreshCodeMessage(run);
  });

  it.each([
    ['a live human code', LIVE],
    ['a live fleet code', LIVE_FLEET],
  ])('%s runs the flow: bundle fetched and started with the same environment', async (_label, code) => {
    const run = runInRig(await servedScript(code), String(await relayVerdict(code)), { shell, runtimeOnMachine: true });
    expect(run.status).toBe(0);
    expect(run.home).toContain(path.join('.provian', 'agent.js'));
    expect(run.nodeRan).toMatch(new RegExp(`^${code} https?://\\S+ .*/\\.provian/agent\\.js$`));
    for (const line of DEAD_CODE_LINES) expect(run.stderr).not.toContain(line);
  });

  it('a live code changes nothing but the one check: the same flow runs with and without it', async () => {
    const script = await servedScript(LIVE);
    const checked = runInRig(script, '200', { shell, runtimeOnMachine: true });
    const unchecked = runInRig(withoutCheck(script), '200', { shell, runtimeOnMachine: true });
    expect(checked.status).toBe(unchecked.status);
    expect(checked.home).toEqual(unchecked.home);
    expect(checked.stderr).toBe(unchecked.stderr);
    expect(checked.curlCalls.slice(1)).toEqual(unchecked.curlCalls);
    expect(checked.nodeRan).not.toBeNull();
  });

  describe.each(AGENT_WALLET_STATE_FILES.map((f) => [f]))('on a machine holding %s', (stateFile) => {
    it.each([
      ['an expired line', EXPIRED],
      ['a used fleet code', USED_FLEET],
      ['a code the relay no longer knows', PLACEHOLDER],
    ])('%s runs as it always has: no check, and request-link rules on the resume', async (_label, code) => {
      const run = runInRig(await servedScript(code), 'must-not-be-read', { shell, stateFile, runtimeOnMachine: true });
      expect(run.status).toBe(0);
      expect(run.nodeRan).not.toBeNull();
      expect(run.curlCalls.join('\n')).not.toContain(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
      for (const line of DEAD_CODE_LINES) expect(run.stderr).not.toContain(line);
    });
  });

  it('the rate limit says to try later, not to check the connection or get a new code', async () => {
    const run = runInRig(await servedScript(LIVE), '429', { shell });
    expectRefusedClean(run);
    expect(run.stderr.split('\n')).toContain(TOO_MANY_REQUESTS_LINE);
    expect(run.stderr).not.toContain(CODE_CHECK_UNAVAILABLE_LINE);
    for (const line of DEAD_CODE_LINES) expect(run.stderr).not.toContain(line);
  });

  it.each([
    ['the relay cannot be reached', 'unreachable'],
    ['the relay cannot read the code', '503'],
    ['the relay answers something unexpected', '500'],
  ])('when %s, it stops with a retry message, not a fresh-code one, and leaves nothing', async (_label, status) => {
    const run = runInRig(await servedScript(LIVE), status, { shell });
    expectRefusedClean(run);
    expect(run.stderr.split('\n')).toContain(CODE_CHECK_UNAVAILABLE_LINE);
    for (const line of DEAD_CODE_LINES) expect(run.stderr).not.toContain(line);
  });

  it('RED control: with the check cut out, the same dead code writes to the machine and starts the bundle', async () => {
    const run = runInRig(withoutCheck(await servedScript(PLACEHOLDER)), '404', { shell, runtimeOnMachine: true });
    expect(run.home).toContain(path.join('.provian', 'agent.js'));
    expect(run.nodeRan).not.toBeNull();
  });
});

describe('the check comes first, and the code stays out of the URL', () => {
  const params = { token: LIVE, relayUrl: 'https://api.provian.ai', bundleSha256: 'a'.repeat(64) };

  it('sh: the check never sends curl to /dev/null, which cannot retry on Linux', () => {
    const check = agentCodeCheckSh('api.provian.ai');
    expect(check).toContain('--retry');
    expect(check).not.toContain('/dev/null -w');
  });

  it('sh: nothing that writes runs before the check', () => {
    const sh = buildAgentBootstrapScript(params);
    const check = sh.indexOf(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
    expect(check).toBeGreaterThan(0);
    for (const writer of ['mkdir', 'mktemp', 'tar ', 'BUNDLE_URL"', 'exec node']) {
      const at = sh.indexOf(writer);
      expect(at).toBeGreaterThan(check);
    }
  });

  it('PowerShell: nothing that writes runs before the check', () => {
    const ps = buildAgentBootstrapPowershell(params);
    const check = ps.indexOf(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
    expect(check).toBeGreaterThan(0);
    for (const writer of ['New-Item', '-OutFile', '& node']) {
      const at = ps.indexOf(writer);
      expect(at).toBeGreaterThan(check);
    }
  });

  it('PowerShell carries the same refusal lines and the same keystore file', () => {
    const ps = buildAgentBootstrapPowershell(params);
    for (const line of DEAD_CODE_LINES) expect(ps).toContain(`Say '${line}'`);
    expect(ps).toContain(`Say '${CODE_CHECK_UNAVAILABLE_LINE}'`);
    for (const file of AGENT_WALLET_STATE_FILES) expect(ps).toContain(`'${file}'`);
  });

  it('the code rides the header, never the check URL', async () => {
    const run = runInRig(await servedScript(LIVE), '200', { runtimeOnMachine: true });
    const call = run.curlCalls[0];
    expect(call).toContain(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
    expect(call).toContain(`x-provian-token: ${LIVE}`);
    expect(call.slice(call.lastIndexOf(' '))).toContain(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE);
    expect(call.slice(call.lastIndexOf(' '))).not.toContain(LIVE);
  });
});

describe('the script names what the bundle names', () => {
  const sdkFile = (name: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../../../provian-agent-sdk/src', name), 'utf8');

  it('the refusal lines are the sentences the bundle prints for a failed link', () => {
    const flow = sdkFile('bootstrap-flow.ts');
    expect(DEAD_CODE_LINES.length).toBeGreaterThan(0);
    for (const line of DEAD_CODE_LINES) expect(flow).toContain(line);
  });

  it('the wallet files the script looks for are the ones the bundle writes', () => {
    const [keystore, pending] = AGENT_WALLET_STATE_FILES;
    expect(sdkFile('keystore.ts')).toContain(`path.join(PROVIAN_DIR, '${keystore}')`);
    expect(sdkFile('pending-wallet-registration.ts')).toContain(`'${pending}'`);
  });

  it('RED control: a reworded line is not found in the bundle source', () => {
    expect(sdkFile('bootstrap-flow.ts')).not.toContain(`${DEAD_CODE_LINES[0]} Reworded.`);
  });

  it('npx onboard asks the same route and refuses in the same words', () => {
    expect(sdkFile('connection-code-check.ts')).toContain(`CONNECTION_CODE_CHECK_ROUTE = '${AGENT_BOOTSTRAP_CODE_CHECK_ROUTE}'`);
    const onboard = sdkFile('scripts/onboard.ts');
    expect(onboard).toContain(TOO_MANY_REQUESTS_LINE);
    expect(onboard).toContain(CODE_CHECK_UNAVAILABLE_LINE.slice(0, CODE_CHECK_UNAVAILABLE_LINE.indexOf('.') + 1));
  });
});

// The shim above answers whatever it is asked, so it cannot see the curl flags. This runs the
// served check through the real curl, against the real route over HTTP.
async function onRealPort<T>(app: express.Express, run: (origin: string) => Promise<T>, host?: string): Promise<T> {
  const server = host ? app.listen(0, host) : app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    return await run(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function spawnCollect(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string[] }> {
  const child = spawn(cmd, args, { env });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, output: output.split('\n') })));
}

const PAST_THE_CHECK = 'PAST THE CHECK';
const SCRIPT_PARAMS = { relayUrl: 'https://api.provian.ai', bundleSha256: 'a'.repeat(64) };

/** Run the served sh through its check and stop there, in a HOME holding nothing. */
async function runCheckWithCurl(code: string, app: express.Express): Promise<{ status: number | null; output: string[]; home: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-code-check-sh-'));
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const full = buildAgentBootstrapScript({ token: code, ...SCRIPT_PARAMS });
    const check = agentCodeCheckSh('api.provian.ai');
    expect(full).toContain(check);
    return await onRealPort(app, async (origin) => {
      const script = path.join(dir, 'check.sh');
      fs.writeFileSync(script, `${full.slice(0, full.indexOf(check) + check.length)}\nsay '${PAST_THE_CHECK}'\n`
        .replace(`RELAY_URL='${SCRIPT_PARAMS.relayUrl}'`, `RELAY_URL='${origin}'`));
      const run = await spawnCollect('sh', [script], { PATH: process.env.PATH, HOME: home });
      return { ...run, home: walk(home) };
    }, '127.0.0.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the sh check, run for real with curl', () => {
  it.each([
    ['the placeholder', PLACEHOLDER],
    ['an expired code', EXPIRED],
    ['a used fleet code', USED_FLEET],
    ['a fleet code whose issuer is no longer linked', ORPHAN_FLEET],
  ])('%s prints the fresh-code message, exits 1 and leaves nothing', async (_label, code) => {
    const run = await runCheckWithCurl(code, buildApp());
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    for (const line of DEAD_CODE_LINES) expect(run.output).toContain(line);
    expect(run.output).not.toContain(PAST_THE_CHECK);
  }, 30_000);

  it('a live code gets past the check', async () => {
    const run = await runCheckWithCurl(LIVE, buildApp());
    expect(run.status).toBe(0);
    expect(run.output).toContain(PAST_THE_CHECK);
    for (const line of DEAD_CODE_LINES) expect(run.output).not.toContain(line);
  }, 30_000);

  it('a relay that cannot read the code stops it with the retry message', async () => {
    const run = await runCheckWithCurl(LIVE, buildApp(fakeDb(() => { throw new Error('firestore down'); })));
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.output).toContain(CODE_CHECK_UNAVAILABLE_LINE);
  }, 30_000);

  // curl prints the 200 it read before the drop and exits non-zero, so only its exit status
  // tells this apart from a live code. The drop must reach curl after the headers.
  it('a connection dropped mid-body after a 200 is no ruling: it stops with the retry message', async () => {
    const dropped = express();
    dropped.get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"status":"li', () => res.destroy());
    });
    const run = await runCheckWithCurl(LIVE, dropped);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.output).toContain(CODE_CHECK_UNAVAILABLE_LINE);
    expect(run.output).not.toContain(PAST_THE_CHECK);
  }, 30_000);

  it('RED control: the same 200 with its whole body gets past the check', async () => {
    const whole = express();
    whole.get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '17' });
      res.end('{"status":"live"}');
    });
    const run = await runCheckWithCurl(LIVE, whole);
    expect(run.status).toBe(0);
    expect(run.output).toContain(PAST_THE_CHECK);
  }, 30_000);

  it('a passing blip is retried', async () => {
    let calls = 0;
    const blip = buildApp(fakeDb(() => {
      calls += 1;
      if (calls === 1) throw new Error('firestore blip');
    }));
    const run = await runCheckWithCurl(LIVE, blip);
    expect(calls).toBeGreaterThan(1);
    expect(run.output).toContain(PAST_THE_CHECK);
  }, 30_000);

  it('a redirect is followed, as the install line follows it', async () => {
    const moved = express();
    moved.get(AGENT_BOOTSTRAP_CODE_CHECK_ROUTE, (_req, res) => { res.redirect(307, '/moved'); });
    moved.get('/moved', (_req, res) => { res.status(200).json({ status: 'live' }); });
    const run = await runCheckWithCurl(LIVE, moved);
    expect(run.output).toContain(PAST_THE_CHECK);
  }, 30_000);

  it('the rate limit says to try later', async () => {
    const run = await runCheckWithCurl(LIVE, buildApp(fakeDb(), () => ({ allowed: false })));
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.output).toContain(TOO_MANY_REQUESTS_LINE);
    expect(run.output).not.toContain(CODE_CHECK_UNAVAILABLE_LINE);
  }, 30_000);
});

// The PowerShell decision run for real, against the real route over HTTP. GitHub's runners carry
// pwsh, so the nightly always runs these; a CI without it fails below rather than skipping them.
function findPwsh(): string | null {
  const found = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : null;
}
const PWSH = findPwsh();

interface PwshResult { status: number | null; output: string[]; profile: string[]; }

/** Run the served PowerShell through its check and stop there: past it lies the Windows-only Node step. */
async function runCheckInPwsh(pwsh: string, code: string, app: express.Express, stateFile?: string): Promise<PwshResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-code-check-ps-'));
  try {
    const profile = path.join(dir, 'profile');
    fs.mkdirSync(profile);
    if (stateFile) {
      fs.mkdirSync(path.join(profile, '.provian'));
      fs.writeFileSync(path.join(profile, '.provian', stateFile), '{}');
    }
    const full = buildAgentBootstrapPowershell({ token: code, ...SCRIPT_PARAMS });
    const check = agentCodeCheckPs('api.provian.ai');
    expect(full).toContain(check);
    return await onRealPort(app, async (origin) => {
      const script = path.join(dir, 'check.ps1');
      fs.writeFileSync(script, `${full.slice(0, full.indexOf(check) + check.length)}\nSay '${PAST_THE_CHECK}'\nexit 0\n`
        .replace(`$RelayUrl = '${SCRIPT_PARAMS.relayUrl}'`, `$RelayUrl = '${origin}'`));
      const run = await spawnCollect(pwsh, ['-NoProfile', '-NonInteractive', '-File', script], {
        PATH: process.env.PATH, HOME: dir, USERPROFILE: profile,
      });
      return { ...run, profile: walk(profile) };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the PowerShell check, run for real', () => {
  it('CI carries pwsh, so these never skip there', () => {
    if (process.env.CI) expect(PWSH).not.toBeNull();
  });

  const whenPwsh = PWSH ? it : it.skip;
  const pwsh = PWSH ?? '';

  whenPwsh.each([
    ['the placeholder', PLACEHOLDER],
    ['an expired code', EXPIRED],
    ['a used fleet code', USED_FLEET],
    ['a fleet code whose issuer is no longer linked', ORPHAN_FLEET],
  ])('%s prints the fresh-code message, exits 1 and leaves nothing', async (_label, code) => {
    const run = await runCheckInPwsh(pwsh, code, buildApp());
    expect(run.status).toBe(1);
    expect(run.profile).toEqual([]);
    for (const line of DEAD_CODE_LINES) expect(run.output).toContain(line);
    expect(run.output).not.toContain(PAST_THE_CHECK);
  }, 60_000);

  whenPwsh('a live code gets past the check', async () => {
    const run = await runCheckInPwsh(pwsh, LIVE, buildApp());
    expect(run.status).toBe(0);
    expect(run.output).toContain(PAST_THE_CHECK);
    for (const line of DEAD_CODE_LINES) expect(run.output).not.toContain(line);
  }, 60_000);

  whenPwsh('a relay that cannot read the code stops it with the retry message', async () => {
    const down = buildApp(fakeDb(() => { throw new Error('firestore down'); }));
    const run = await runCheckInPwsh(pwsh, LIVE, down);
    expect(run.status).toBe(1);
    expect(run.output).toContain(CODE_CHECK_UNAVAILABLE_LINE);
    for (const line of DEAD_CODE_LINES) expect(run.output).not.toContain(line);
  }, 60_000);

  whenPwsh('a passing blip is retried, as curl retries it', async () => {
    let calls = 0;
    const blip = buildApp(fakeDb(() => {
      calls += 1;
      if (calls === 1) throw new Error('firestore blip');
    }));
    const run = await runCheckInPwsh(pwsh, LIVE, blip);
    expect(calls).toBeGreaterThan(1);
    expect(run.output).toContain(PAST_THE_CHECK);
  }, 60_000);

  whenPwsh('the rate limit says to try later', async () => {
    const run = await runCheckInPwsh(pwsh, LIVE, buildApp(fakeDb(), () => ({ allowed: false })));
    expect(run.status).toBe(1);
    expect(run.output).toContain(TOO_MANY_REQUESTS_LINE);
    expect(run.output).not.toContain(CODE_CHECK_UNAVAILABLE_LINE);
  }, 60_000);

  whenPwsh.each(AGENT_WALLET_STATE_FILES.map((f) => [f]))('a machine holding %s skips the check, whatever the code', async (stateFile) => {
    const run = await runCheckInPwsh(pwsh, EXPIRED, buildApp(fakeDb(() => { throw new Error('must not be asked'); })), stateFile);
    expect(run.status).toBe(0);
    expect(run.output).toContain(PAST_THE_CHECK);
  }, 60_000);
});
