/**
 * PE meter, the local outbox for the git hook: the
 * hook records the commit's PE in this machine's PE store — built, hashed and chained here —
 * and needs no network at all; the observer's daily batch carries its act record to the relay.
 * A relay outage therefore costs nothing, and the hook says truthfully where the PE is.
 * RED control: a store that cannot be written is reported as NOT recorded, with a non-zero exit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FsPeStore, PE_STORE_DIR_ENV } from '../meter/pe-store';

const DEVICE_ID = `dev_${'d'.repeat(64)}`;
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pe-store-'));

vi.mock('./credentials', async (orig) => ({
  ...(await orig<typeof import('./credentials')>()),
  loadCredentials: () => ({
    deviceKey: `pdk_${'a'.repeat(32)}`, deviceSecret: `pds_${'b'.repeat(64)}`, relayUrl: 'https://relay.test', deviceId: DEVICE_ID,
  }),
}));
vi.mock('../runtime-env', () => ({ applyRuntimeEnvAtEntry: () => undefined }));

const previousStoreDir = process.env[PE_STORE_DIR_ENV];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.env[PE_STORE_DIR_ENV] = storeRoot; });

// : the hook records only a commit made moments ago, so these
// run inside a fresh fixture repo whose HEAD was just committed.
const originalCwd = process.cwd();
beforeAll(() => {
  process.env[PE_STORE_DIR_ENV] = storeRoot;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pe-store-repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
  execFileSync('git', ['init', '-q', '.'], { cwd: repo, env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'fresh'], { cwd: repo, env });
  process.chdir(repo);
});
afterAll(() => {
  process.chdir(originalCwd);
  if (previousStoreDir === undefined) delete process.env[PE_STORE_DIR_ENV];
  else process.env[PE_STORE_DIR_ENV] = previousStoreDir;
});

async function runHook(): Promise<void> {
  const argv = process.argv;
  process.argv = ['node', 'report-pe', '--hook', 'post-commit'];
  try {
    const { runReportPeCli } = await import('./report-pe.js');
    await runReportPeCli();
  } finally {
    process.argv = argv;
  }
}

describe('report-pe (git hook) records on this machine — the relay is not needed', () => {
  it('with the relay unreachable, the commit PE is recorded in the PE store and the hook says where (exit 0, no network)', async () => {
    const fetchSpy = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
    const prevExit = process.exitCode;
    try {
      await runHook();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = prevExit;
    }
    expect(exit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/PE created: pe_[0-9a-f]{24} \(kept on this machine; sent in the next daily batch\)/);
    const store = new FsPeStore(DEVICE_ID, storeRoot);
    const head = await store.head();
    expect(head.count).toBe(1);
    const [pe] = await store.readPes(0, 1);
    expect(pe.pe.action_type).toBe('coding_session');
    expect(pe.pe.device_id).toBe(DEVICE_ID);
    expect(pe.pe.prev_hash).toBe('genesis');
  });

  it('RED: a PE store that cannot be written — says NOT recorded and exits non-zero', async () => {
    // The store root is a regular FILE: no device directory can be created under it.
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pe-store-blocked-')), 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    process.env[PE_STORE_DIR_ENV] = blocked;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err = vi.spyOn(console, 'error');
    const prevExit = process.exitCode;
    try {
      await runHook();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
    }
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toContain('PE was not recorded');
  });
});
