/**
 * The real `onboard` entry, as a real process, in a HOME holding nothing. The other onboard
 * suites inject their steps, so they cannot see what main() writes before runOnboard starts.
 *
 * A preload answers for the relay, so nothing here touches the network. A proxy is set on every
 * run because the runtime.env write only happens on a box with something to record, and because
 * it makes the entry re-execute, which is the path a proxy-only box takes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { CONNECTION_CODE_CHECK_ROUTE } from '../connection-code-check';
import { DEAD_CODE_LINE, FRESH_CODE_LINE } from '../bootstrap-flow';
import { RUNTIME_ENV_REEXEC_GUARD } from '../runtime-env';
import type { OnboardJsonReport } from './onboard';

const CODE = 'PROV-ABCD-2345';
const RELAY = 'https://93.184.216.34';
const HOME_RUNTIME_ENV = join('.provian', 'runtime.env');
const EGRESS_ALLOW_REQUEST = 'ask your human once for ONE standing';
const LIVE_PROXY = 'http://127.0.0.1:9';
const STALE_RUNTIME_ENV = 'HTTPS_PROXY=http://stale.example:3128\nhttp_proxy=http://stale.example:3128\n';

const rig = mkdtempSync(join(tmpdir(), 'provian-onboard-home-'));
afterAll(() => rmSync(rig, { recursive: true, force: true }));

const ENTRY = join(rig, 'onboard.cjs');
buildSync({
  entryPoints: [resolve(__dirname, 'onboard.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: ENTRY,
  external: ['@solana/web3.js'],
  logLevel: 'silent',
});

const CHECK_CALL = '.checkCode(';
/** The built entry with its check cut out, for the control below. Refuses a cut that removed nothing. */
function entryWithoutCheck(): string {
  const built = readFileSync(ENTRY, 'utf8');
  const cut = built.replace(/await io\.checkCode\(/, 'await (async () => ({ verdict: "proceed" }))(');
  expect(cut).not.toBe(built);
  expect(cut).not.toContain(CHECK_CALL);
  const file = join(rig, 'onboard-unchecked.cjs');
  writeFileSync(file, cut);
  return file;
}

const PRELOAD = join(rig, 'relay.cjs');
writeFileSync(PRELOAD, `
const fs = require('fs');
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  const headers = (init && init.headers) || {};
  fs.appendFileSync(process.env.RIG_LOG, JSON.stringify({ url, method: (init && init.method) || 'GET', token: headers['x-provian-token'] || null }) + '\\n');
  if (url.endsWith(${JSON.stringify(CONNECTION_CODE_CHECK_ROUTE)})) {
    return new Response('{}', { status: Number(process.env.RIG_CODE_STATUS) });
  }
  return new Response('{"error":"rig"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
};
`);

interface RelayCall { url: string; method: string; token: string | null; }
interface Run { status: number | null; stdout: string; stderr: string; home: string[]; calls: RelayCall[]; }

function walk(dir: string, root: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return [relative(root, full), ...(entry.isDirectory() ? walk(full, root) : [])];
  });
}

let runs = 0;
function runOnboard(
  codeStatus: number,
  opts: { args?: string[]; relay?: string; stateFile?: string; entry?: string; runtimeEnv?: string; noProxy?: boolean; inheritedGuard?: boolean } = {},
): Run {
  runs += 1;
  const dir = join(rig, `run-${runs}`);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.provian'), { recursive: true });
  if (opts.stateFile) writeFileSync(join(home, '.provian', opts.stateFile), '{}');
  if (opts.runtimeEnv) writeFileSync(join(home, HOME_RUNTIME_ENV), opts.runtimeEnv);
  if (!opts.stateFile && !opts.runtimeEnv) rmSync(join(home, '.provian'), { recursive: true });
  const log = join(dir, 'relay.log');
  const r = spawnSync(process.execPath, ['--require', PRELOAD, opts.entry ?? ENTRY, ...(opts.args ?? ['--token', CODE, '--yes']), '--relay', opts.relay ?? RELAY], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      ...(opts.noProxy ? {} : { HTTPS_PROXY: LIVE_PROXY }),
      ...(opts.inheritedGuard ? { [RUNTIME_ENV_REEXEC_GUARD]: '1' } : {}),
      RIG_LOG: log,
      RIG_CODE_STATUS: String(codeStatus),
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    home: walk(home),
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RelayCall) : [],
  };
}

const checks = (run: Run): RelayCall[] => run.calls.filter((c) => c.url.endsWith(CONNECTION_CODE_CHECK_ROUTE));

describe('onboard on a clean HOME', () => {
  it.each([[404], [409], [410]])('a dead code (%i) exits 1 with the two fresh-code sentences and writes nothing', (status) => {
    const run = runOnboard(status);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    const lines = run.stderr.split('\n').map((l) => l.trim());
    expect(lines).toContain(DEAD_CODE_LINE);
    expect(lines).toContain(FRESH_CODE_LINE);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ url: `${RELAY}${CONNECTION_CODE_CHECK_ROUTE}`, method: 'GET', token: CODE });
  }, 60_000);

  it('a malformed code writes nothing and asks nobody', () => {
    const run = runOnboard(200, { args: ['--token', 'nonsense', '--yes'] });
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain(DEAD_CODE_LINE);
  }, 60_000);

  it('no code at all writes nothing', () => {
    const run = runOnboard(200, { args: ['--yes'] });
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
  }, 60_000);

  it('--json reports the same refusal as one object on stdout', () => {
    const run = runOnboard(410, { args: ['--token', CODE, '--json'] });
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    const report = JSON.parse(run.stdout) as OnboardJsonReport;
    expect(report).toMatchObject({ status: 'failed', exit_code: 1, wallet_id: null });
    expect(report.messages).toEqual([DEAD_CODE_LINE, FRESH_CODE_LINE]);
  }, 60_000);

  it('a rate limit says to try later, and writes nothing', () => {
    const run = runOnboard(429);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.stderr).toContain('Too many requests. Please try again later.');
    expect(run.stderr).not.toContain(DEAD_CODE_LINE);
  }, 60_000);

  it('a relay that cannot rule stops it with no fresh-code message, and writes nothing', () => {
    const run = runOnboard(503);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.stderr).toContain('Provian could not check your invite code just now, so nothing was set up.');
    expect(run.stderr).toContain('Wait a few minutes, then run onboard again.');
    expect(run.stderr).toContain(EGRESS_ALLOW_REQUEST);
    expect(run.stderr).not.toContain(DEAD_CODE_LINE);
  }, 60_000);

  it('a relay that is not https is refused on this machine, says so, and writes nothing', () => {
    const run = runOnboard(200, { relay: 'http://relay.example:3000' });
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('EGRESS_HTTPS_REQUIRED');
    expect(run.stderr).not.toContain('no usable answer');
    expect(run.stderr).not.toContain(EGRESS_ALLOW_REQUEST);
  }, 60_000);

  it('a live code runs the flow: the check comes first, then the install writes', () => {
    const run = runOnboard(200);
    expect(checks(run)).toHaveLength(1);
    expect(run.calls[0].url).toBe(`${RELAY}${CONNECTION_CODE_CHECK_ROUTE}`);
    expect(run.calls.length).toBeGreaterThan(1);
    expect(run.home).toContain(HOME_RUNTIME_ENV);
    expect(readFileSync(join(rig, `run-${runs}`, 'home', HOME_RUNTIME_ENV), 'utf8')).toContain('HTTPS_PROXY=');
    expect(run.home.length).toBeGreaterThan(2);
    expect(run.stderr).not.toContain(DEAD_CODE_LINE);
  }, 60_000);

  it('RED control: with the check cut out, the same dead code writes to the machine', () => {
    const run = runOnboard(410, { entry: entryWithoutCheck() });
    expect(run.home).toContain(HOME_RUNTIME_ENV);
    expect(run.home.length).toBeGreaterThan(2);
  }, 60_000);
});

describe('onboard on a machine that already holds a wallet', () => {
  it.each(['agent-keystore.json', 'pending-agent-wallet-registration.json'])('holding %s, a dead code runs as it always has: no check, and the record of this shell is written', (stateFile) => {
    const run = runOnboard(410, { stateFile });
    expect(checks(run)).toEqual([]);
    expect(run.home).toContain(HOME_RUNTIME_ENV);
    expect(run.stderr.split('\n').map((l) => l.trim())).not.toContain(FRESH_CODE_LINE);
  }, 60_000);
});

// The install shell is authoritative: what the file already says is never copied back into it.
describe('what onboard records comes from this shell, never from the file it replaces', () => {
  const recorded = (): string => readFileSync(join(rig, `run-${runs}`, 'home', HOME_RUNTIME_ENV), 'utf8');

  it('a live proxy replaces a stale one, stale lines included', () => {
    runOnboard(200, { stateFile: 'agent-keystore.json', runtimeEnv: STALE_RUNTIME_ENV });
    expect(recorded()).toContain(`HTTPS_PROXY=${LIVE_PROXY}`);
    expect(recorded()).not.toContain('stale.example');
  }, 60_000);

  it('a box that dropped its proxy re-installs clean: the stale file goes', () => {
    const run = runOnboard(200, { stateFile: 'agent-keystore.json', runtimeEnv: STALE_RUNTIME_ENV, noProxy: true });
    if (run.home.includes(HOME_RUNTIME_ENV)) expect(recorded()).not.toContain('stale.example');
    expect(run.calls.length).toBeGreaterThan(0);
  }, 60_000);

  it('a refused code leaves a file already there exactly as it was', () => {
    const run = runOnboard(410, { runtimeEnv: STALE_RUNTIME_ENV });
    expect(run.status).toBe(1);
    expect(recorded()).toBe(STALE_RUNTIME_ENV);
    expect(run.home).toEqual(['.provian', HOME_RUNTIME_ENV]);
  }, 60_000);

  it('a re-exec guard inherited from another Provian process changes nothing: this shell still wins', () => {
    runOnboard(200, { stateFile: 'agent-keystore.json', runtimeEnv: STALE_RUNTIME_ENV, inheritedGuard: true });
    expect(recorded()).toContain(`HTTPS_PROXY=${LIVE_PROXY}`);
    expect(recorded()).not.toContain('stale.example');
  }, 60_000);
});

// The rigs above stub fetch, so they cannot show that the check gets out of a box like this one.
// This is that box for real: a CONNECT proxy, and a relay whose certificate only a private CA
// vouches for, named the way curl reads it. Neither Node nor OpenSSL reads CURL_CA_BUNDLE, so it
// is trusted only once the re-exec ahead of the check has started Node with NODE_EXTRA_CA_CERTS.
// (SSL_CERT_FILE would prove nothing: a Node built on the default OpenSSL store, as Homebrew's is,
// reads it unaided.)
describe('onboard on a proxy-only box with a TLS-inspecting CA', () => {
  const pki = join(rig, 'pki');
  mkdirSync(pki);
  const CA = join(pki, 'ca.pem');
  const KEY = join(pki, 'key.pem');
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', KEY, '-out', CA,
    '-subj', '/CN=rig', '-addext', `subjectAltName=IP:${new URL(RELAY).hostname}`,
  ], { encoding: 'utf8' });

  async function throughProxy(status: number, entry: string = ENTRY): Promise<{ status: number | null; stderr: string; home: string[]; tunnels: string[]; tokens: unknown[] }> {
    expect(made.status).toBe(0);
    const tunnels: string[] = [];
    const tokens: unknown[] = [];
    const relay = createHttpsServer({ key: readFileSync(KEY), cert: readFileSync(CA) }, (req, res) => {
      tokens.push(req.headers['x-provian-token']);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
    const proxy = createServer();
    proxy.on('connect', (req, client: Socket, head) => {
      tunnels.push(req.url ?? '');
      const upstream = connect((relay.address() as AddressInfo).port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    runs += 1;
    const home = join(rig, `run-${runs}`, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [entry, '--token', CODE, '--yes', '--relay', RELAY], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
        HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        CURL_CA_BUNDLE: CA,
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((done) => child.on('close', done));
    proxy.closeAllConnections();
    relay.closeAllConnections();
    await Promise.all([new Promise((done) => proxy.close(done)), new Promise((done) => relay.close(done))]);
    return { status: code, stderr, home: walk(home), tunnels, tokens };
  }

  it('a dead code is refused through the tunnel, against the private CA, and writes nothing', async () => {
    const run = await throughProxy(410);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.tunnels).toEqual([`${new URL(RELAY).hostname}:443`]);
    expect(run.tokens).toEqual([CODE]);
    expect(run.stderr).toContain(DEAD_CODE_LINE);
    expect(run.stderr).toContain(FRESH_CODE_LINE);
  }, 60_000);

  it('a filtering proxy\'s 403 is no ruling: three tries, then the process exits with nothing written', async () => {
    const run = await throughProxy(403);
    expect(run.status).toBe(1);
    expect(run.home).toEqual([]);
    expect(run.tokens).toEqual([CODE, CODE, CODE]);
    expect(run.stderr).toContain('The check got no usable answer');
    expect(run.stderr).toContain(EGRESS_ALLOW_REQUEST);
    expect(run.stderr).not.toContain(DEAD_CODE_LINE);
  }, 60_000);

  it('RED control: with no re-exec ahead of the check, the same relay is not trusted and gives no ruling', async () => {
    const built = readFileSync(ENTRY, 'utf8');
    const cut = built.replace(/applyRuntimeEnvAtEntry\(args\.help \? \{\} : \{ recorded: computeRuntimeEnv\(process\.env\) \}\);/, 'void 0;');
    expect(cut).not.toBe(built);
    const entry = join(rig, 'onboard-no-reexec.cjs');
    writeFileSync(entry, cut);
    const run = await throughProxy(410, entry);
    expect(run.status).toBe(1);
    expect(run.tokens).toEqual([]);
    expect(run.stderr).not.toContain(DEAD_CODE_LINE);
    expect(run.stderr).toContain('did not trust the certificate');
  }, 60_000);
});
