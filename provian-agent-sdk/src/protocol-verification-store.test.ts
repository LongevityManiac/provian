import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, chmod, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocolVerificationStore } from './protocol-verification-store';

const directories: string[] = [];
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'protocol-proof-'));
  directories.push(parent);
  const directory = join(parent, 'evidence');
  return { parent, directory, store: protocolVerificationStore('pin/operators/verifier', directory) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('private durable protocol evidence', () => {
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
