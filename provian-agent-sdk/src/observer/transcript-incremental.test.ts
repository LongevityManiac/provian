/**
 * The transcript lane reads a session file only when it changed, and reads only what is new —
 * without ever dropping or repeating a tool-calling model response.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureProgram, ProgramWitnessRegistry, sourceCheckpoint, recordSources, FileCheckpoint, type SessionDescription } from './program-witness';
import { TranscriptPlugin, TRANSCRIPT_STAMP_SETTLE_MS } from './plugins/transcript/TranscriptPlugin';
import type { ProvianObserver } from './ProvianObserver';
import type { PluginPE } from './types';

const stamp = 1791480000000;
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const observer = { log: () => {}, observerDeviceWitness: () => ({ type: 'observer_device', identity: 'existing-device', attestation_tier: 'software' }) } as unknown as ProvianObserver;
const row = (r: unknown): string => JSON.stringify(r) + '\n';
const response = (id: string, extra: Record<string, unknown> = {}): string =>
  row({ kind: 'response', id, timestamp: stamp + 1000, calls: [{ id: 'call-' + id, name: 'Read' }], done: true, ...extra });

function setup(files = 1) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-incremental-')); homes.push(h);
  const root = path.join(h, 'sessions'); fs.mkdirSync(root);
  const spec: SessionDescription = {
    root, maxDepth: 0, suffix: '.jsonl', timestamp: 'timestamp', responseId: 'id', atomicResponses: true, responseParts: 'calls.*',
    rules: [{ kind: 'model_response', where: [{ path: 'kind', equals: 'response' }] }, { kind: 'tool_call', at: 'calls.*', name: 'name', id: 'id', input: 'arguments' }, { kind: 'turn_end', where: [{ path: 'done', equals: true }] }],
  };
  const paths = Array.from({ length: files }, (_, n) => path.join(root, `s${n}.jsonl`));
  for (const [n, file] of paths.entries()) fs.writeFileSync(file, response('baseline-' + n, { timestamp: stamp - 1 }));
  const registryFile = path.join(h, '.provian', 'program-witnesses.json');
  configureProgram({ program: 'demo', processNames: ['demo'], lane: 'transcript', session: spec }, registryFile, stamp);
  return { h, root, spec, file: paths[0], paths, registry: new ProgramWitnessRegistry(registryFile) };
}
async function lane(f: ReturnType<typeof setup>, stampSettleMs = 0): Promise<TranscriptPlugin> {
  const p = new TranscriptPlugin({ home: f.h, registry: f.registry, now: () => stamp + 5000, stampSettleMs });
  await p.init(observer); await p.start(); return p;
}
/** Drain and acknowledge, as the observer does after a successful submission. */
function take(p: TranscriptPlugin): PluginPE[] { const pes = p.drainPEs(); for (const pe of pes) p.onCommitted(pe, 'submitted'); return pes; }

describe('transcript lane — a pass costs what changed, and mints each response once', () => {
  it('an unchanged file is not opened again: nothing verified, nothing parsed, nothing minted', async () => {
    const f = setup(3);
    for (const file of f.paths) fs.appendFileSync(file, response('first-' + path.basename(file)));
    const p = await lane(f);
    expect(take(p)).toHaveLength(3);
    expect(p.lastScan()).toMatchObject({ sources: 3, unchanged: 0 });
    for (let n = 0; n < 3; n++) {
      await p.rescan();
      expect(p.lastScan()).toEqual({ sources: 3, unchanged: 3, bytesVerified: 0, bytesParsed: 0 });
      expect(p.drainPEs()).toEqual([]);
    }
    await p.stop();
  });

  it('an append reads only the appended bytes and mints only the new response; the other files stay unread', async () => {
    const f = setup(2);
    const p = await lane(f);
    expect(take(p)).toEqual([]);
    await p.rescan();
    const before = fs.statSync(f.file).size;
    const added = response('appended');
    fs.appendFileSync(f.file, added);
    await p.rescan();
    const pes = take(p);
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata).toMatchObject({ tool_count: 1, source: 'transcript' });
    expect(p.lastScan()).toEqual({ sources: 2, unchanged: 1, bytesVerified: before, bytesParsed: Buffer.byteLength(added) });
    await p.rescan();
    expect(p.drainPEs()).toEqual([]);
    expect(p.lastScan().unchanged).toBe(2);
    // A restart reads the same store and finds nothing it has not already witnessed.
    await p.stop();
    expect((await lane(f)).drainPEs()).toEqual([]);
  });

  it('several appends across passes mint exactly one PE per response, none dropped', async () => {
    const f = setup();
    const p = await lane(f);
    const keys: string[] = [];
    for (let n = 0; n < 6; n++) {
      fs.appendFileSync(f.file, response('r' + n) + (n % 2 ? response('s' + n) : ''));
      await p.rescan();
      keys.push(...take(p).map(pe => pe.idempotencyKey!));
      await p.rescan();
      expect(p.drainPEs()).toEqual([]);
    }
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    await p.stop();
  });

  it('a truncated file is read again from its start and repeats nothing', async () => {
    const f = setup();
    const a = response('a'), b = response('b');
    fs.appendFileSync(f.file, a + b);
    const p = await lane(f);
    expect(take(p)).toHaveLength(2);
    await p.rescan();
    expect(p.lastScan().unchanged).toBe(1);
    fs.writeFileSync(f.file, a);
    await p.rescan();
    expect(p.lastScan().unchanged).toBe(0);
    expect(p.lastScan().bytesParsed).toBe(Buffer.byteLength(a));
    expect(p.drainPEs()).toEqual([]);
    fs.appendFileSync(f.file, response('c'));
    await p.rescan();
    expect(take(p)).toHaveLength(1);
    await p.stop();
  });

  it('a file rewritten in place to a longer length is read whole: old responses do not repeat, the new one mints once', async () => {
    const f = setup();
    const a = response('a'), b = response('b'), c = response('c');
    fs.appendFileSync(f.file, a + b);
    const p = await lane(f);
    expect(take(p)).toHaveLength(2);
    await p.rescan();
    // Same inode, new leading bytes, larger size: only the prefix hash can tell this from an append.
    const rewritten = b + a + c;
    fs.writeFileSync(f.file, rewritten);
    await p.rescan();
    expect(p.lastScan().bytesParsed).toBe(Buffer.byteLength(rewritten));
    const pes = take(p);
    expect(pes).toHaveLength(1);
    await p.rescan();
    expect(p.drainPEs()).toEqual([]);
    await p.stop();
    expect((await lane(f)).drainPEs()).toEqual([]);
  });

  it('a file replaced by a new one of the same content (rotation) is read whole and repeats nothing', async () => {
    const f = setup();
    fs.appendFileSync(f.file, response('a'));
    const p = await lane(f);
    expect(take(p)).toHaveLength(1);
    await p.rescan();
    const next = f.file + '.next';
    fs.writeFileSync(next, fs.readFileSync(f.file));
    fs.renameSync(next, f.file);
    await p.rescan();
    expect(p.lastScan()).toMatchObject({ unchanged: 0, bytesParsed: fs.statSync(f.file).size });
    expect(p.drainPEs()).toEqual([]);
    fs.appendFileSync(f.file, response('after-rotation'));
    await p.rescan();
    expect(take(p)).toHaveLength(1);
    await p.stop();
  });

  it('a record larger than one read slice is still read whole', async () => {
    const f = setup();
    const p = await lane(f);
    fs.appendFileSync(f.file, response('big', { padding: 'x'.repeat(3 * 1024 * 1024) }) + response('after-big'));
    await p.rescan();
    expect(take(p)).toHaveLength(2);
    await p.stop();
  });

  it('a just-written file is not trusted by its stamp: it is verified again on the next pass', async () => {
    expect(TRANSCRIPT_STAMP_SETTLE_MS).toBeGreaterThan(0);
    const f = setup();
    const p = await lane(f, TRANSCRIPT_STAMP_SETTLE_MS);
    await p.rescan();
    expect(p.lastScan()).toMatchObject({ sources: 1, unchanged: 0, bytesVerified: fs.statSync(f.file).size });
    await p.stop();
  });

  it('a store the description cannot place stays flagged on every pass instead of being skipped as unchanged', async () => {
    const f = setup();
    fs.appendFileSync(f.file, row({ kind: 'never-described', timestamp: stamp + 1000 }));
    const p = await lane(f);
    for (let n = 0; n < 3; n++) {
      expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);
      expect(p.lastScan().unchanged).toBe(0);
      await p.rescan();
    }
    await p.stop();
  });

  it('the running digest equals the whole-file checkpoint, before and after it is extended', async () => {
    const f = setup();
    fs.appendFileSync(f.file, response('a') + response('b'));
    const src = recordSources(f.spec)[0];
    const half = Math.floor(src.tip / 2);
    const running = await FileCheckpoint.open(f.file, half);
    expect(running.value()).toBe(sourceCheckpoint(f.spec, src, half));
    await running.extend(f.file, src.tip);
    expect(running.value()).toBe(sourceCheckpoint(f.spec, src, src.tip));
    expect(running.value()).not.toBe(sourceCheckpoint(f.spec, src, half));
  });

  it('tick starts a pass without blocking, never overlaps one, and the event loop turns while it runs', async () => {
    const f = setup(8);
    let clock = stamp + 5000;
    const p = new TranscriptPlugin({ home: f.h, registry: f.registry, now: () => clock, stampSettleMs: 0 });
    await p.init(observer); await p.start(); take(p);
    for (const file of f.paths) fs.appendFileSync(file, response('tick-' + path.basename(file)));
    clock += 5000;
    expect(p.tick(null)).toBeNull();
    // Nothing has been read synchronously inside tick.
    expect(p.drainPEs()).toEqual([]);
    const running = p.rescan();
    expect(p.tick(null)).toBeNull();
    expect(p.rescan()).toBe(running);
    let turns = 0, done = false;
    void running.then(() => { done = true; });
    while (!done) { await new Promise<void>(resolve => setImmediate(resolve)); turns++; }
    expect(turns).toBeGreaterThan(8);
    expect(take(p)).toHaveLength(8);
    await p.stop();
  });
});
