import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, readdir, chmod, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocolVerificationStore } from './protocol-verification-store';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const directories: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'protocol-proof-'));
  directories.push(parent);
  const directory = join(parent, 'evidence');
  return { parent, directory, store: protocolVerificationStore('pin/operators/verifier', directory) };
}
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
describe('private durable protocol evidence', () => {
  it('supports Windows synthetic modes without attempting unsupported directory flushes, but flushes the file', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalOpen = fs.open;
    let fileFlushes = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if ((await fs.lstat(path).catch(() => null))?.isDirectory()) throw Error('Windows directory flush unsupported');
      const handle = await originalOpen(path, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { fileFlushes++; await sync(); };
      return handle;
    });
    const f = await fixture(); await f.store.save(1n, '{"revision":"1"}');
    const root = join(f.directory, (await readdir(f.directory))[0]);
    await chmod(f.directory, 0o777); await chmod(root, 0o777); await chmod(join(root, '1.json'), 0o666);
    expect(await f.store.load()).toBe('{"revision":"1"}');
    expect(fileFlushes).toBe(1);
    await symlink(join(root, '1.json'), join(root, '2.json'));
    await expect(f.store.load()).rejects.toThrow('permissions');
  });
  it('survives restarts and out-of-order concurrent writers without lowering the high-water mark', async () => {
    const f = await fixture();
    expect(await f.store.load()).toBeNull();
    const other = protocolVerificationStore('pin/operators/verifier', f.directory);
    await Promise.all([f.store.save(2n, '{"revision":"2"}'), other.save(3n, '{"revision":"3"}')]);
    await f.store.save(1n, '{"revision":"1"}');
    expect(await other.load()).toBe('{"revision":"3"}');
    await f.store.save(3n, '{"revision":"3","altered":true}');
    expect(await protocolVerificationStore('pin/operators/verifier', f.directory).load()).toBe('{"revision":"3"}');
    expect(await protocolVerificationStore('different-pin', f.directory).load()).toBeNull();
  });
  it('refuses writable/shared directories and symlinked evidence', async () => {
    const f = await fixture(); await f.store.save(1n, '{"revision":"1"}');
    await chmod(f.directory, 0o777);
    await expect(f.store.load()).rejects.toThrow('permissions');
    await chmod(f.directory, 0o700);
    const root = join(f.directory, (await readdir(f.directory))[0]);
    await symlink(join(root, '1.json'), join(root, '2.json'));
    await expect(f.store.load()).rejects.toThrow();
  });
  it('refuses a symlinked parent and a record whose revision differs from its filename', async () => {
    const f = await fixture(); await f.store.save(1n, '{"revision":"9"}');
    await expect(f.store.load()).rejects.toThrow('invalid');
    const target = join(f.parent, 'target'); await mkdir(target);
    const alias = join(f.parent, 'alias'); await symlink(target, alias);
    await expect(protocolVerificationStore('pin', join(alias, 'evidence')).load()).rejects.toThrow('permissions');
  });
  it('ignores incomplete temporary writes', async () => {
    const f = await fixture(); await f.store.load();
    const root = join(f.directory, (await readdir(f.directory))[0]);
    await writeFile(join(root, 'interrupted.tmp'), '{', { mode: 0o600 });
    expect(await f.store.load()).toBeNull();
  });
});
