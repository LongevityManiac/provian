/**
 * `provian pes` — the local PE store (the relay keeps no PE).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPeExport } from '@provian/agent-sdk';
import { parseArgs } from './parse-args';
import { cmdPes } from './pes-commands';
import { anchoredMemoryStore, STORE_ACTOR_ID } from './anchored-store.test-support';

const argv = (...a: string[]): string[] => ['node', 'provian', ...a];

describe('provian pes', () => {
  it('reports the store: PEs kept, unsent, the last batch, proofs, and where PEs live', async () => {
    const { store } = await anchoredMemoryStore();
    const r = await cmdPes([], {}, { openPeStore: () => ({ ok: true, store }) });
    expect(r).toMatchObject({ status: 'ok', pes_stored: 2, unsent: 0, proofs_fetched: 1, last_batch: { seq: 1, acts: 2 } });
    expect(String(r?.notice)).toMatch(/Your PEs live on this machine/);
  });

  it('pes prove <pe_id> prints the pe_fact entry with the PE and its anchored inclusion', async () => {
    const { store, pes } = await anchoredMemoryStore();
    const { positionals } = parseArgs(argv('pes', 'prove', pes[1].pe_id));
    expect(positionals).toEqual(['prove', pes[1].pe_id]);
    const r = await cmdPes(positionals, {}, { openPeStore: () => ({ ok: true, store }) });
    expect(r).toMatchObject({
      status: 'ok',
      pe_fact: { pe_id: pes[1].pe_id, envelope_hash: pes[1].pe_hash, pe: pes[1], inclusion: { act_index: 1, batch: { actor_id: STORE_ACTOR_ID, seq: 1 }, anchor: { day: '2026-10-02' } } },
    });
  });

  it('pes prove pulls a PE dropped after its day was archived from the PE Archive, and only then (RED: no archive → refused)', async () => {
    const { store, pes } = await anchoredMemoryStore();
    const proven = await cmdPes(['prove', pes[0].pe_id], {}, { openPeStore: () => ({ ok: true, store }) });
    const fact = (proven as { pe_fact: { pe: typeof pes[0]; inclusion: Record<string, unknown> } }).pe_fact;
    await store.dropArchivedDay({ day: '2026-10-02', wallet: 'aw_x', part_sha256s: [], pes: [{ index: 0, pe_id: pes[0].pe_id, pe_hash: pes[0].pe_hash }] });
    let opened = 0;
    const archive = {
      findArchivedPe: async (id: string) => (id === pes[0].pe_id
        ? { ok: true as const, entry: { index: 0, pe: pes[0], inclusion: fact.inclusion as never } }
        : { ok: false as const, reason: 'not_archived' }),
    };
    const r = await cmdPes(['prove', pes[0].pe_id], {}, { openPeStore: () => ({ ok: true, store }), openArchive: async () => { opened += 1; return archive; } });
    expect(r).toMatchObject({ status: 'ok', pe_fact: { pe_id: pes[0].pe_id, envelope_hash: pes[0].pe_hash, pe: pes[0] } });
    expect(opened).toBe(1);
    // A PE still held here never opens the Archive.
    await cmdPes(['prove', pes[1].pe_id], {}, { openPeStore: () => ({ ok: true, store }), openArchive: async () => { opened += 1; return archive; } });
    expect(opened).toBe(1);
    expect(await cmdPes(['prove', pes[0].pe_id], {}, { openPeStore: () => ({ ok: true, store }), openArchive: async () => null }))
      .toMatchObject({ status: 'error', reason: 'archived_unavailable' });
  });

  it('RED: a PE not held here, or not yet anchored, is refused with its reason; no store is an error', async () => {
    const { store, pes } = await anchoredMemoryStore({ anchored: false });
    const deps = { openPeStore: () => ({ ok: true as const, store }) };
    expect(await cmdPes(['prove', pes[0].pe_id], {}, deps)).toMatchObject({ status: 'error', reason: 'not_anchored_yet' });
    expect(await cmdPes(['prove', 'pe_elsewhere'], {}, deps)).toMatchObject({ status: 'error', reason: 'pe_not_found' });
    expect(await cmdPes(['prove'], {}, deps)).toMatchObject({ status: 'error' });
    expect(await cmdPes([], {}, { openPeStore: () => ({ ok: false, reason: 'no_store', detail: 'no PE store under /x' }) }))
      .toMatchObject({ status: 'error', error: 'no PE store under /x' });
  });
});

describe('provian pes export / pes verify (PE export, the same SDK functions as `provian export-pes` / `verify-export`)', () => {
  it('pes export passes --out to the SDK export and never opens a single store first', async () => {
    const exportPes = vi.fn(async (o: { out: string | null }) => ({ status: 'ok', path: o.out }) as never);
    const openPeStore = vi.fn(() => ({ ok: false as const, reason: 'no_store' as const, detail: 'unused' }));
    const r = await cmdPes(['export'], { out: '/tmp/e.jsonl' }, { exportPes, openPeStore });
    expect(r).toMatchObject({ status: 'ok', path: '/tmp/e.jsonl' });
    expect(exportPes).toHaveBeenCalledWith({ out: '/tmp/e.jsonl' });
    expect(openPeStore).not.toHaveBeenCalled();
    expect(await cmdPes(['export'], {}, { exportPes: async () => { throw new Error('no PE store under /x'); } }))
      .toMatchObject({ status: 'error', error: 'no PE store under /x' });
  });

  it('pes verify runs the SDK verifier on a real export: offline_ok; RED: an incomplete export is `incomplete`, a tampered file fails', async () => {
    const { store: anchored } = await anchoredMemoryStore({ anchored: false });
    // Complete: the Archive was read (on, no days), the mailbox drained with nothing left.
    const archive = {
      readStatus: async () => ({ ok: true as const, wallet: 'wallet_aw_cli', on: true }),
      listDays: async () => ({ ok: true as const, days: [] }),
      pullDay: async () => ({ ok: false as const, reason: 'none' }),
    };
    const built = await buildPeExport({ stores: [anchored], owner: { wallet_id: 'wallet_aw_cli', address: null }, archive, mailbox: { waiting: 0, truncated: false, reason: null }, now: () => 1 });
    // Incomplete: no Archive reachable and no mailbox check (both named in the end line).
    const partial = await buildPeExport({ stores: [anchored], owner: { wallet_id: 'wallet_aw_cli', address: null }, archive: null, now: () => 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-export-'));
    try {
      const file = path.join(dir, 'e.jsonl');
      fs.writeFileSync(file, partial.text);
      const incomplete = await cmdPes(['verify', file], { offline: true }, { openPeStore: () => { throw new Error('verify needs no store'); } });
      expect(incomplete).toMatchObject({ status: 'incomplete', verdict: 'offline_incomplete' });
      expect((incomplete as { missing: string[] }).missing.length).toBe(partial.incomplete.length);
      fs.writeFileSync(file, built.text);
      const ok = await cmdPes(['verify', file], { offline: true }, { openPeStore: () => { throw new Error('verify needs no store'); } });
      expect(ok).toMatchObject({ status: 'ok', verdict: 'offline_ok', incomplete: [], counts: { pe: { total: 2 }, batch: { total: 1 } } });
      fs.writeFileSync(file, built.text.replace('pe_cli_1', 'pe_cli_X'));
      expect(await cmdPes(['verify', file], { offline: true })).toMatchObject({ status: 'error', verdict: 'failed' });
      expect(await cmdPes(['verify'], {})).toMatchObject({ status: 'error' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pes verify reads the RPC from --rpc-url, else PROVIAN_BASE_RPC_URL', async () => {
    const verifyExport = vi.fn(async () => ({ verdict: 'ok' }) as never);
    await cmdPes(['verify', 'e.jsonl'], { 'rpc-url': 'https://a.example' }, { verifyExport, env: {} });
    expect(verifyExport).toHaveBeenLastCalledWith('e.jsonl', { offline: false, rpcUrl: 'https://a.example' });
    await cmdPes(['verify', 'e.jsonl'], {}, { verifyExport, env: { PROVIAN_BASE_RPC_URL: 'https://b.example' } });
    expect(verifyExport).toHaveBeenLastCalledWith('e.jsonl', { offline: false, rpcUrl: 'https://b.example' });
  });
});
