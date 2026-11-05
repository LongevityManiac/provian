/**
 * `witness configure` checks exactly the records the transcript lane will read.
 *
 * The lane flags a description and holds its cursor at the first record it cannot place. Configure
 * must refuse such a description, or a fresh agent re-describes in a loop and never mints. These
 * cases are the ones review found configure could get wrong:
 * - a re-description while every source is caught up still checks the session holding the latest
 * record (RED: checking only lane-read records would accept a description with no record checked);
 * - a just-opened session with no records is never that evidence;
 * - a source rewritten to the same length replays from 0, as the lane replays it (RED: without the
 * checkpoint comparison only the records after the old cursor are checked);
 * - SQLite: the check reaches back past the 1,000-row sample to where the lane resumes, and on a
 * first description the session holding the latest record is the evidence, whatever order the
 * database lists sessions in. These run where `node:sqlite` exists (Node 22+).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureProgram, type SessionDescription } from './program-witness';
import { sqliteAvailability } from './plugins/transcript/record-store';
import { TranscriptPlugin } from './plugins/transcript/TranscriptPlugin';
import { ProgramWitnessRegistry } from './program-witness';
import type { ProvianObserver } from './ProvianObserver';

const stamp = 1792800000000;
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const observer = { log: () => {}, observerDeviceWitness: () => ({ type: 'observer_device', identity: 'device', attestation_tier: 'software' }) } as unknown as ProvianObserver;
const line = (r: unknown): string => JSON.stringify(r) + '\n';
const rules: SessionDescription['rules'] = [
    { kind: 'user_prompt', where: [{ path: 'kind', equals: 'prompt' }] },
    { kind: 'tool_call', where: [{ path: 'kind', equals: 'call' }], name: 'name', id: 'id' },
    { kind: 'turn_end', where: [{ path: 'kind', equals: 'final' }] },
];
const turn = (at: number, id: string): string => line({ kind: 'prompt', timestamp: at }) + line({ kind: 'call', id, name: 'Read', timestamp: at }) + line({ kind: 'final', timestamp: at });

function home(): { h: string; root: string; registryFile: string } {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-lane-'));
    homes.push(h);
    const root = path.join(h, 'sessions');
    fs.mkdirSync(root);
    return { h, root, registryFile: path.join(h, '.provian', 'program-witnesses.json') };
}
const program = (session: SessionDescription) => ({ program: 'demo', processNames: ['demo'], lane: 'transcript' as const, session: { ...session, atomicResponses: false } });
async function lane(h: string, registryFile: string, now: number): Promise<TranscriptPlugin> {
    const p = new TranscriptPlugin({ home: h, registry: new ProgramWitnessRegistry(registryFile), now: () => now });
    await p.init(observer);
    await p.start();
    return p;
}

describe('configure checks the records the lane will read', () => {
    it('a caught-up re-description still checks the latest session (RED: no record checked would accept an unparsable timestamp)', async () => {
        const f = home();
        const file = path.join(f.root, 's.jsonl');
        fs.writeFileSync(file, turn(stamp - 10, 'old'));
        const spec: SessionDescription = { root: f.root, maxDepth: 0, suffix: '.jsonl', timestamp: 'timestamp', rules };
        configureProgram(program(spec), f.registryFile, stamp);
        fs.appendFileSync(file, turn(stamp + 1000, 'new'));
        const p = await lane(f.h, f.registryFile, stamp + 5000);
        expect(p.drainPEs()).toHaveLength(1);
        expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
        await p.stop();
        // Every source is now caught up; a description whose timestamp path gives nothing is refused.
        expect(() => configureProgram(program({ ...spec, timestamp: 'nope' }), f.registryFile, stamp + 6000)).toThrow(/timestamp_unparsed/);
        // The correct description is still accepted.
        expect(configureProgram(program(spec), f.registryFile, stamp + 6000).calls).toBe(2);
    });

    it('a just-opened empty session is never the evidence (RED: the newest file with no record would leave nothing checked)', () => {
        const f = home();
        fs.writeFileSync(path.join(f.root, 'a.jsonl'), turn(stamp - 10, 'a'));
        fs.utimesSync(path.join(f.root, 'a.jsonl'), (stamp - 100_000) / 1000, (stamp - 100_000) / 1000);
        fs.writeFileSync(path.join(f.root, 'b.jsonl'), '');
        const spec: SessionDescription = { root: f.root, maxDepth: 0, suffix: '.jsonl', timestamp: 'nope', rules };
        expect(() => configureProgram(program(spec), f.registryFile, stamp)).toThrow(/cannot place record 1 of a\.jsonl \(timestamp_unparsed/);
    });

    it('a same-length rewrite replays from 0 for configure as for the lane (RED: only records after the old cursor would be checked)', async () => {
        const f = home();
        const file = path.join(f.root, 's.jsonl');
        fs.writeFileSync(file, turn(stamp - 10, 'old'));
        const spec: SessionDescription = { root: f.root, maxDepth: 0, suffix: '.jsonl', timestamp: 'timestamp', rules };
        configureProgram(program(spec), f.registryFile, stamp);
        fs.appendFileSync(file, turn(stamp + 1000, 'new'));
        let p = await lane(f.h, f.registryFile, stamp + 5000);
        expect(p.drainPEs()).toHaveLength(1);
        await p.stop();
        // Rewrite the first record to the same length as an unplaceable kind, then append real work.
        const text = fs.readFileSync(file, 'utf8');
        const rewritten = text.replace('"kind":"prompt"', '"kind":"promp7"');
        expect(rewritten.length).toBe(text.length);
        fs.writeFileSync(file, rewritten + turn(stamp + 2000, 'later'));
        expect(() => configureProgram(program(spec), f.registryFile, stamp + 6000)).toThrow(/cannot place record 1 of s\.jsonl \(matches_no_rule: kind="promp7"/);
        // The lane agrees: it replays from 0 and holds at that record.
        p = await lane(f.h, f.registryFile, stamp + 7000);
        expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);
        await p.stop();
    });
});

const sqlite = sqliteAvailability().available;
type Db = { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void };
function database(file: string): Db {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => Db };
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE records (seq INTEGER, session TEXT, json TEXT)');
    return db;
}
const insert = (db: Db, session: string, seq: number, record: unknown): void => { db.prepare('INSERT INTO records (seq, session, json) VALUES (?, ?, ?)').run(seq, session, JSON.stringify(record)); };
const sqliteSpec = (root: string): SessionDescription => ({ root, maxDepth: 0, suffix: '.sqlite', timestamp: 'timestamp', sqlite: { table: 'records', jsonColumn: 'json', seqColumn: 'seq', sessionColumn: 'session' }, rules });

describe.skipIf(!sqlite)('configure checks the records the lane will read: SQLite', () => {
    it('reaches back past the 1,000-row sample to where the lane resumes (RED: a sample from tip-1000 accepts it)', () => {
        const f = home();
        const db = database(path.join(f.root, 'store.sqlite'));
        insert(db, 's', 1, { kind: 'call', id: 'c1', name: 'Read', timestamp: stamp - 10 });
        insert(db, 's', 2, { kind: 'final', timestamp: stamp - 9 });
        configureProgram(program(sqliteSpec(f.root)), f.registryFile, stamp);
        insert(db, 's', 3, { kind: 'mystery', timestamp: stamp + 1 });
        db.exec('BEGIN');
        for (let seq = 4; seq < 1600; seq++) insert(db, 's', seq, { kind: 'call', id: `c${seq}`, name: 'Read', timestamp: stamp + seq });
        db.exec('COMMIT');
        db.close();
        expect(() => configureProgram(program(sqliteSpec(f.root)), f.registryFile, stamp + 5000)).toThrow(/cannot place record at seq 3 of store\.sqlite \(matches_no_rule: kind="mystery"/);
    });

    it('a first description checks the session holding the latest record, whatever order sessions are listed (RED: the first-listed session)', () => {
        const f = home();
        const db = database(path.join(f.root, 'store.sqlite'));
        insert(db, 'a', 1, { kind: 'call', id: 'a1', name: 'Read', timestamp: stamp - 100_000 });
        insert(db, 'z', 1, { kind: 'call', id: 'z1', name: 'Read', timestamp: stamp - 10 });
        insert(db, 'z', 2, { kind: 'mystery', timestamp: stamp - 5 });
        db.close();
        expect(() => configureProgram(program(sqliteSpec(f.root)), f.registryFile, stamp)).toThrow(/matches_no_rule: kind="mystery"/);
    });
});
