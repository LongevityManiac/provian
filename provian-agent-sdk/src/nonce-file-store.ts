import { mkdir, readFile, writeFile, rename, unlink, link, access, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseNonceJournal, type NonceJournalStore } from './canonical-nonce';

/**
 * A version's hard-link creation is the filesystem compare-and-swap. Version
 * names are never removed: old data becomes a small tombstone, so a paused
 * process cannot recreate an old revision after compaction. No PID/time lock
 * can be stolen from a live process, and a crashed process needs no cleanup.
 */
export function fileNonceStore(directory = process.env.PROVIAN_NONCE_STORE_DIR ?? join(homedir(), '.provian', 'evm-nonces')): NonceJournalStore {
  return {
    async transact(key, change) {
      if (!/^[0-9]+_0x[0-9a-f]{40}(?:_[A-Za-z0-9_-]{1,128})?$/.test(key)) throw new Error('nonce_store_key_invalid');
      const dir = join(directory, key);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const versionFile = (n: number) => join(dir, `v${n}.json`);
      for (;;) {
        let revision = 0;
        try { revision = Number(await readFile(join(dir, 'head'), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('nonce_store_head_invalid');
        for (;;) {
          try { await access(versionFile(revision + 1)); revision++; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
        }
        let current = null;
        if (revision > 0) {
          const json = await readFile(versionFile(revision), 'utf8');
          if (json === '') continue; // A newer revision compacted this snapshot; read it again.
          current = parseNonceJournal(JSON.parse(json));
        }
        const next = parseNonceJournal(change(current));
        if (!next) throw new Error('nonce_store_empty_write');
        const temporary = join(dir, `tmp-${randomUUID()}`);
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
        finally { await file.close(); }
        let committed = false;
        try { await link(temporary, versionFile(revision + 1)); committed = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        finally { await unlink(temporary); }
        if (!committed) continue;
        const parent = await open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        // The head is an acceleration hint only; readers walk immutable successor names.
        const head = join(dir, `head-${randomUUID()}`);
        await writeFile(head, String(revision + 1), { mode: 0o600 });
        await rename(head, join(dir, 'head'));
        if (revision > 1) {
          const empty = join(dir, `compact-${randomUUID()}`);
          await writeFile(empty, '', { mode: 0o600 });
          await rename(empty, versionFile(revision - 1));
        }
        return next;
      }
    },
  };
}
