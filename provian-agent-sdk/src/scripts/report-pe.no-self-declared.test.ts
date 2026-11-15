/**
 * `report-pe` has no manual mode.
 *
 * "An agent declaring its own work has no path to a PE." `report-pe --type <x> --description <y>`
 * was exactly that: a caller-chosen type and prose, submitted as the device. What stays is the
 * git post-commit hook, which reads the commit (sha, branch, numstat) from git itself. Any
 * other invocation exits non-zero with the removal message and submits nothing.
 *
 * RED control: against the pre- report-pe, the manual invocations below submit a PE (the
 * fetch spy sees a POST to /v1/pe/submit) and exit 0.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEVICE_ID = `dev_${'c'.repeat(64)}`;
/** PE meter: the hook records the commit's PE in this machine's PE store (no network). */
const PE_STORE_URL = 'pe-store:recorded';

vi.mock('./credentials', async (orig) => ({
  ...(await orig<typeof import('./credentials')>()),
  loadCredentials: () => ({
    deviceKey: `pdk_${'a'.repeat(32)}`, deviceSecret: `pds_${'b'.repeat(64)}`, relayUrl: 'https://relay.test', deviceId: DEVICE_ID,
  }),
}));
vi.mock('../runtime-env', () => ({ applyRuntimeEnvAtEntry: () => undefined }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.exitCode = 0; });

// : the hook records only a commit made moments ago on this box, so every
// case runs inside its own fixture repository (never this checkout, whose HEAD is not fresh).
const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pe-d494-repos-'));
beforeAll(() => { process.chdir(fixtureRoot); });
afterAll(() => { process.chdir(originalCwd); fs.rmSync(fixtureRoot, { recursive: true, force: true }); });

function gitEnv(committerDate?: string): NodeJS.ProcessEnv {
  return {
    ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
    ...(committerDate ? { GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate } : {}),
  };
}
function git(repo: string, args: string[], committerDate?: string): string {
  return execFileSync('git', args, { cwd: repo, env: gitEnv(committerDate), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase();
}
function commit(repo: string, msg: string, committerDate?: string): void {
  fs.appendFileSync(path.join(repo, 'a.txt'), `${msg}\n`);
  git(repo, ['add', '-A'], committerDate);
  git(repo, ['commit', '-q', '-m', msg], committerDate);
}
function freshRepo(opts: { committerDate?: string } = {}): string {
  const repo = fs.mkdtempSync(path.join(fixtureRoot, 'r-'));
  git(repo, ['init', '-q', '-b', 'main', '.']);
  commit(repo, 'a', opts.committerDate);
  return repo;
}
function inRepo(repo: string): void { process.chdir(repo); }

/**
 * Run the hook. `posts` = every PE it recorded in this device's PE store (url PE_STORE_URL) plus
 * any network POST it made (there should be none: the act record leaves in the daily batch).
 */
async function run(argv: string[]): Promise<{ exitCode: number | undefined; posts: Array<{ url: string; body: Record<string, unknown> }>; errors: string }> {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const { FsPeStore, defaultPeStoreRoot } = await import('../meter/pe-store.js');
  const store = new FsPeStore(DEVICE_ID, defaultPeStoreRoot());
  const before = (await store.head()).count;
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url: String(u), body: JSON.parse(String(init.body ?? '{}')) });
    return new Response(JSON.stringify({ pe_id: 'pe_x', recorded: true }), { status: 201 });
  }));
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let exitCode: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; throw new Error(`exit:${code}`); }) as never);
  const prev = process.argv;
  process.argv = ['node', 'report-pe', ...argv];
  try {
    const { runReportPeCli } = await import('./report-pe.js');
    await runReportPeCli();
  } catch (e) {
    if (!String((e as Error).message).startsWith('exit:')) throw e;
  } finally {
    process.argv = prev;
  }
  if (exitCode === undefined && process.exitCode) exitCode = Number(process.exitCode);
  const after = (await store.head()).count;
  for (const p of await store.readPes(before, after - before)) {
    posts.push({ url: PE_STORE_URL, body: p.pe as unknown as Record<string, unknown> });
  }
  return { exitCode, posts, errors: err.mock.calls.map((c) => String(c[0])).join('\n') };
}

describe('report-pe : manual reporting is removed; only the git hook remains', () => {
  it('RED: a manual `--type research --description …` exits non-zero and submits nothing', async () => {
    const r = await run(['--type', 'research', '--description', 'Surveyed three oracle designs for the relay']);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
    expect(r.errors).toMatch(/manual reporting was removed\. /);
    // Reader-facing copy carries no decision IDs.
    expect(r.errors).not.toMatch(/\bD-\d{2,3}\b/);
  });

  it('RED: a bare invocation (the old default coding_session) exits non-zero and submits nothing', async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
  });

  it('RED: the legacy hook shape with a commit sha that is NOT git\'s HEAD is refused', async () => {
    const r = await run(['--type', 'coding_session', '--commit-sha', 'f'.repeat(40), '--description', 'fabricated commit record here']);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
  });

  it('RED: the legacy hook shape with a sha that is not a commit in this repository is refused', async () => {
    inRepo(freshRepo());
    const r = await run(['--type', 'coding_session', '--commit-sha', 'f'.repeat(40), '--description', 'fabricated commit record here']);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
  });

  it('GREEN: hook mode records the named, just-made commit as a body-bound coding_session', async () => {
    const repo = freshRepo();
    inRepo(repo);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const r = await run(['--hook', 'post-commit', '--commit-sha', head]);
    expect(r.exitCode ?? 0).toBe(0);
    const submits = r.posts.filter((p) => p.url === PE_STORE_URL);
    expect(submits).toHaveLength(1);
    expect(submits[0].body.action_type).toBe('coding_session');
    expect((submits[0].body.metadata as Record<string, unknown>).commit_sha).toBe(head);
  });

  it('GREEN: an already-installed legacy hook (flags + its captured sha) is served in hook mode, flags ignored', async () => {
    const repo = freshRepo();
    inRepo(repo);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const r = await run(['--type', 'coding_session', '--description', 'this prose is ignored entirely', '--files-changed', '999', '--commit-sha', head.toUpperCase()]);
    expect(r.exitCode ?? 0).toBe(0);
    const submits = r.posts.filter((p) => p.url === PE_STORE_URL);
    expect(submits).toHaveLength(1);
    const md = submits[0].body.metadata as Record<string, unknown>;
    expect(md.commit_sha).toBe(head);
    expect(md.files_changed).not.toBe(999);
    expect(String(submits[0].body.description)).not.toContain('prose is ignored');
  });

  it('RED ( , defect 1): `git commit -m a && git commit -m b` — the hook for A records A, not HEAD (B)', async () => {
    const repo = freshRepo();
    const a = git(repo, ['rev-parse', 'HEAD']);
    commit(repo, 'b');
    const b = git(repo, ['rev-parse', 'HEAD']);
    expect(a).not.toBe(b);
    inRepo(repo);
    // The two backgrounded hook processes, each with the sha its hook captured synchronously.
    const ra = await run(['--hook', 'post-commit', '--commit-sha', a]);
    const rb = await run(['--hook', 'post-commit', '--commit-sha', b]);
    const shas = [...ra.posts, ...rb.posts]
      .filter((p) => p.url === PE_STORE_URL)
      .map((p) => (p.body.metadata as Record<string, unknown>).commit_sha);
    expect(shas).toEqual([a, b]);
  });

  it('GREEN: a legacy `--commit-sha` naming a fresh ancestor that is no longer HEAD is accepted', async () => {
    const repo = freshRepo();
    const a = git(repo, ['rev-parse', 'HEAD']);
    commit(repo, 'b');
    inRepo(repo);
    const r = await run(['--type', 'coding_session', '--commit-sha', a]);
    expect(r.exitCode ?? 0).toBe(0);
    const submits = r.posts.filter((p) => p.url === PE_STORE_URL);
    expect(submits).toHaveLength(1);
    expect((submits[0].body.metadata as Record<string, unknown>).commit_sha).toBe(a);
  });

  it('RED ( , defect 3): checking out an OLD commit and invoking the hook records nothing', async () => {
    const repo = freshRepo({ committerDate: '2026-01-01T00:00:00Z' });
    const old = git(repo, ['rev-parse', 'HEAD']);
    commit(repo, 'later');
    git(repo, ['checkout', '-q', old]);
    inRepo(repo);
    for (const argv of [['--hook', 'post-commit'], ['--hook', 'post-commit', '--commit-sha', old], ['--commit-sha', old]]) {
      const r = await run(argv);
      expect(r.exitCode).toBe(2);
      expect(r.posts).toEqual([]);
      expect(r.errors).toMatch(/committed \d+s ago/);
    }
  });

  it('GREEN ( ): commit then switch branch before the hook runs — the commit is still witnessed', async () => {
    const repo = freshRepo();
    git(repo, ['checkout', '-q', '-b', 'side']);
    commit(repo, 'side');
    const side = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', '-']);
    inRepo(repo);
    const r = await run(['--hook', 'post-commit', '--commit-sha', side]);
    expect(r.exitCode ?? 0).toBe(0);
    const submits = r.posts.filter((p) => p.url === PE_STORE_URL);
    expect(submits).toHaveLength(1);
    expect((submits[0].body.metadata as Record<string, unknown>).commit_sha).toBe(side);
  });

  it('RED ( ): a fresh commit that only ARRIVED here (fetched + merged from another repo) is refused', async () => {
    const upstream = freshRepo();
    commit(upstream, 'theirs');
    const theirs = git(upstream, ['rev-parse', 'HEAD']);
    const repo = freshRepo();
    git(repo, ['fetch', '-q', upstream, 'HEAD']);
    git(repo, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    inRepo(repo);
    const r = await run(['--hook', 'post-commit', '--commit-sha', theirs]);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
    expect(r.errors).toMatch(/not made in this repository on this box/);
  });

  it('RED: a commit whose committer time is in the future is refused', async () => {
    const repo = freshRepo({ committerDate: new Date(Date.now() + 60 * 60_000).toISOString() });
    inRepo(repo);
    const r = await run(['--hook', 'post-commit', '--commit-sha', git(repo, ['rev-parse', 'HEAD'])]);
    expect(r.exitCode).toBe(2);
    expect(r.posts).toEqual([]);
    expect(r.errors).toMatch(/in the future/);
  });
});
