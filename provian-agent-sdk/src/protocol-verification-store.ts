import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProtocolVerificationStore } from './protocol-verification';

/** Owner-only evidence, separate from wallet keys. Immutable per-revision files
 * keep the high-water mark monotonic even when several CLI processes finish out
 * of order. An interrupted write is never accepted as verification evidence. */
export function protocolVerificationStore(namespace: string, directory = join(homedir(), '.provian', 'protocol-verification')): ProtocolVerificationStore {
  const windows = process.platform === 'win32';
  const key = createHash('sha256').update(namespace).digest('hex');
  const root = join(directory, key);
  async function syncDirectory(path: string): Promise<void> {
    // Windows does not support flushing a read-only directory handle. File
    // contents are still flushed before publication under the user's profile ACL.
    if (windows) return;
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function prepare(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(directory));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (!windows && ((parent.mode & 0o022) !== 0
      || (process.getuid && parent.uid !== process.getuid())))) throw Error('protocol_cache_permissions');
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    for (const path of [directory, root]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (!windows && ((stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())))) throw Error('protocol_cache_permissions');
    }
    await syncDirectory(dirname(directory));
    await syncDirectory(directory);
  }
  return {
    async load() {
      await prepare();
      const revisions = (await readdir(root)).filter(name => /^[1-9][0-9]*\.json$/.test(name));
      if (revisions.length === 0) return null;
      const latest = revisions.reduce((a, b) => BigInt(a.slice(0, -5)) > BigInt(b.slice(0, -5)) ? a : b);
      const path = join(root, latest);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw Error('protocol_cache_permissions');
      const file = await open(path, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 8192
          || (!windows && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw Error('protocol_cache_permissions');
        const value = await file.readFile('utf8');
        const saved: unknown = JSON.parse(value);
        if (!saved || typeof saved !== 'object' || !('revision' in saved)
          || saved.revision !== latest.slice(0, -5)) throw Error('protocol_cache_invalid');
        return value;
      } finally { await file.close(); }
    },
    async save(revision, value) {
      await prepare();
      const temporary = join(root, `${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
      try {
        await link(temporary, join(root, `${revision}.json`)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await syncDirectory(root);
      } finally { await unlink(temporary); await syncDirectory(root); }
    },
  };
}
