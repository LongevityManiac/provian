import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyRuntimeEnvAtEntry,
  computeRuntimeEnv,
  decideRuntimeEnv,
  nodeSupportsEnvProxy,
  parseRuntimeEnv,
  persistRuntimeEnv,
  readRuntimeEnvFile,
  resolveExtraCaFile,
  serializeRuntimeEnv,
  withLoopbackNoProxy,
  RUNTIME_ENV_REEXEC_GUARD,
} from './runtime-env';

const noFiles = { exists: () => false };

describe('runtime-env: what the installer captures', () => {
  it('a proxied box → proxy vars, loopback NO_PROXY (both cases), NODE_USE_ENV_PROXY', () => {
    const out = computeRuntimeEnv(
      { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'internal.corp' },
      { platform: 'linux', ...noFiles },
    );
    expect(out.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(out.NODE_USE_ENV_PROXY).toBe('1');
    expect(out.NO_PROXY).toBe('127.0.0.1,localhost,::1,internal.corp');
    expect(out.no_proxy).toBe(out.NO_PROXY);
  });

  it('a plain box with no proxy, no CA file, no opt-in → nothing (RED control for an empty capture)', () => {
    expect(computeRuntimeEnv({}, { platform: 'linux', ...noFiles })).toEqual({});
  });

  it('Linux trusts the OS CA bundle; macOS does not point at a PEM (anchors live in the keychain)', () => {
    const exists = (p: string) => p === '/etc/ssl/certs/ca-certificates.crt';
    expect(resolveExtraCaFile({}, { platform: 'linux', exists })).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(resolveExtraCaFile({}, { platform: 'darwin', exists })).toBeNull();
  });

  it('an explicit operator CA wins over the OS bundle', () => {
    const exists = () => true;
    expect(resolveExtraCaFile({ SSL_CERT_FILE: '/opt/inspector-ca.pem' }, { platform: 'linux', exists }))
      .toBe('/opt/inspector-ca.pem');
  });

  it('the retired witness opt-ins are never persisted (the endpoint is gone)', () => {
    const out = computeRuntimeEnv({ PROVIAN_WITNESS_ENABLED: '1', PROVIAN_WITNESS_PORT: '4319', PROVIAN_WITNESS_TOKEN: 't' }, { platform: 'darwin', ...noFiles });
    expect(out).toEqual({});
  });

  it('loopback merge keeps the caller entries and never duplicates', () => {
    expect(withLoopbackNoProxy('localhost,foo')).toBe('127.0.0.1,::1,localhost,foo');
    expect(withLoopbackNoProxy(undefined)).toBe('127.0.0.1,localhost,::1');
  });
});

describe('runtime-env: the file is an allowlist', () => {
  it('ignores any key outside the allowlist on read (no NODE_OPTIONS / preload injection)', () => {
    const parsed = parseRuntimeEnv('NODE_OPTIONS=--require /tmp/evil.js\nHTTPS_PROXY=http://p:1\nLD_PRELOAD=/x.so\n');
    expect(parsed).toEqual({ HTTPS_PROXY: 'http://p:1' });
  });

  it('never writes a value carrying a newline', () => {
    const text = serializeRuntimeEnv({ HTTPS_PROXY: 'http://p:1\nNODE_OPTIONS=--require x', NODE_USE_ENV_PROXY: '1' });
    expect(text).not.toContain('NODE_OPTIONS');
    expect(text).toContain('NODE_USE_ENV_PROXY=1');
  });

  it('round-trips through disk at 0600 and is removed when there is nothing to carry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtenv-'));
    const file = path.join(dir, 'runtime.env');
    const keys = persistRuntimeEnv({ https_proxy: 'http://p:3128' }, { file, probe: { platform: 'linux', ...noFiles } });
    expect(keys).toContain('NODE_USE_ENV_PROXY');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(readRuntimeEnvFile(file).https_proxy).toBe('http://p:3128');
    persistRuntimeEnv({}, { file, probe: { platform: 'linux', ...noFiles } });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('runtime-env: the entry decision', () => {
  const fromFile = {
    HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
  };

  it('a daemon started by cron/systemd with a bare env re-execs with the recorded egress env', () => {
    const d = decideRuntimeEnv({ PATH: '/usr/bin' }, fromFile, '22.23.2');
    expect(d.reexec).toBe(true);
    expect(d.env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(d.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt');
  });

  it('a process already started with that env does not re-exec (no loop)', () => {
    const d = decideRuntimeEnv({ PATH: '/usr/bin', ...fromFile }, fromFile, '22.23.2');
    expect(d.reexec).toBe(false);
  });

  it('the guard stops a second re-exec even if something still differs', () => {
    const d = decideRuntimeEnv({ [RUNTIME_ENV_REEXEC_GUARD]: '1' }, fromFile, '22.23.2');
    expect(d.reexec).toBe(false);
  });

  it('the live environment wins over the file', () => {
    const d = decideRuntimeEnv({ HTTPS_PROXY: 'http://other:1' }, fromFile, '22.23.2');
    expect(d.env.HTTPS_PROXY).toBe('http://other:1');
  });

  it('a live proxy without NO_PROXY gets loopback added (a harness→witness call must not go to the proxy)', () => {
    const d = decideRuntimeEnv({ http_proxy: 'http://p:1' }, {}, '22.23.2');
    expect(d.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(d.env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('a Node too old for env-proxy says so instead of pretending', () => {
    const d = decideRuntimeEnv({ http_proxy: 'http://p:1' }, {}, '22.13.0');
    expect(d.env.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(d.notes.join(' ')).toMatch(/22\.21\+/);
  });

  it('node version gate', () => {
    expect(nodeSupportsEnvProxy('22.23.2')).toBe(true);
    expect(nodeSupportsEnvProxy('22.20.0')).toBe(false);
    expect(nodeSupportsEnvProxy('24.4.0')).toBe(false);
    expect(nodeSupportsEnvProxy('24.5.0')).toBe(true);
    expect(nodeSupportsEnvProxy('26.0.0')).toBe(true);
    expect(nodeSupportsEnvProxy('20.19.0')).toBe(false);
  });

  it('applyRuntimeEnvAtEntry re-execs through execve with the guard set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtenv-'));
    const file = path.join(dir, 'runtime.env');
    fs.writeFileSync(file, serializeRuntimeEnv(fromFile));
    let captured: { file: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
    expect(() => applyRuntimeEnvAtEntry({
      env: { PATH: '/usr/bin' }, file, nodeVersion: '22.23.2',
      execPath: '/node', execArgv: [], argv: ['/node', '/home/a/.provian/agent.js', 'observe'],
      execve: ((f: string, a: string[], e: NodeJS.ProcessEnv) => { captured = { file: f, args: a, env: e }; throw new Error('replaced'); }) as never,
      spawnSync: (() => ({ status: 0 })) as never,
      exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      log: () => undefined,
    })).toThrow('exit 0');
    expect(captured).not.toBeNull();
    expect(captured!.args).toEqual(['/node', '/home/a/.provian/agent.js', 'observe']);
    expect(captured!.env[RUNTIME_ENV_REEXEC_GUARD]).toBe('1');
    expect(captured!.env.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  it('`recorded` replaces the file: an install re-execs on its own shell, and a stale line stays out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtenv-'));
    const file = path.join(dir, 'runtime.env');
    fs.writeFileSync(file, serializeRuntimeEnv({ ...fromFile, NODE_EXTRA_CA_CERTS: '/stale/ca.pem' }));
    const before = fs.readFileSync(file, 'utf8');
    const live: NodeJS.ProcessEnv = { PATH: '/usr/bin', HTTPS_PROXY: 'http://live:3128' };
    let captured: NodeJS.ProcessEnv | null = null;
    expect(() => applyRuntimeEnvAtEntry({
      env: live, file, recorded: computeRuntimeEnv(live, { platform: 'linux', exists: () => false }), nodeVersion: '22.23.2',
      execPath: '/node', execArgv: [], argv: ['/node', '/pkg/onboard.js'],
      execve: ((_f: string, _a: string[], e: NodeJS.ProcessEnv) => { captured = e; throw new Error('replaced'); }) as never,
      spawnSync: (() => ({ status: 0 })) as never,
      exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      log: () => undefined,
    })).toThrow('exit 0');
    expect(captured!.HTTPS_PROXY).toBe('http://live:3128');
    expect(captured!.NODE_USE_ENV_PROXY).toBe('1');
    expect(captured!.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('RED control: without `recorded` the same stale line reaches the process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtenv-'));
    const file = path.join(dir, 'runtime.env');
    fs.writeFileSync(file, serializeRuntimeEnv({ NODE_EXTRA_CA_CERTS: '/stale/ca.pem' }));
    let captured: NodeJS.ProcessEnv | null = null;
    expect(() => applyRuntimeEnvAtEntry({
      env: { PATH: '/usr/bin' }, file, nodeVersion: '22.23.2',
      execPath: '/node', execArgv: [], argv: ['/node', '/pkg/onboard.js'],
      execve: ((_f: string, _a: string[], e: NodeJS.ProcessEnv) => { captured = e; throw new Error('replaced'); }) as never,
      spawnSync: (() => ({ status: 0 })) as never,
      exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      log: () => undefined,
    })).toThrow('exit 0');
    expect(captured!.NODE_EXTRA_CA_CERTS).toBe('/stale/ca.pem');
  });

  it('a retired witness line an earlier installer wrote is ignored (never applied, never a re-exec)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtenv-'));
    const file = path.join(dir, 'runtime.env');
    fs.writeFileSync(file, 'PROVIAN_WITNESS_ENABLED=1\n');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyRuntimeEnvAtEntry({ env, file, log: () => undefined, execve: () => { throw new Error('must not re-exec'); } });
    expect(env.PROVIAN_WITNESS_ENABLED).toBeUndefined();
  });
});
