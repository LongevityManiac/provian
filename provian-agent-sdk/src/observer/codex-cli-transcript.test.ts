/**
 * A Codex CLI session store, described by the agent itself (, live 2026-10-24).
 *
 * Two fresh Codex CLI agents on Linux each described their store and `witness configure` accepted it
 * ("263 records, 31 tool calls validated"). The transcript lane then refused every record
 * (`session_format_broken`), because configure counted parsable tool calls while the lane requires
 * every record to be placed by a rule. The agents re-described in a loop and never minted.
 *
 * Pinned here:
 * - configure applies the lane's own placement check to every real record. It refuses the
 * description the fresh agent actually wrote and names the first record it cannot place, by type
 * only, never content. RED: that description does parse tool calls, so a count-only check accepts it.
 * - a complete description (calls accumulate until the response's token_usage_record; everything
 * else ignored) is accepted, mints one PE per tool-calling model response (two parallel calls are
 * ONE PE), never mints twice across a re-read, and leaves no repair flag.
 * - a record kind Codex adds later holds the lane at its cursor; a re-description is checked over
 * exactly the records the lane will read from there, and the held work then mints once.
 * - accept ⇔ read: for each description, configure accepts it exactly when the lane reads the same
 * records without flagging.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureProgram, describedEvents, ProgramWitnessRegistry, recordPlacementProblem, type SessionDescription } from './program-witness';
import { TranscriptPlugin } from './plugins/transcript/TranscriptPlugin';
import type { ProvianObserver } from './ProvianObserver';
import fresh2Description from './fixtures/d600-fresh2-session.json';

const stamp = 1792800000000;
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const observer = { log: () => {}, observerDeviceWitness: () => ({ type: 'observer_device', identity: 'device', attestation_tier: 'software' }) } as unknown as ProvianObserver;
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: unknown): string => JSON.stringify(r) + '\n';

/** The record kinds a Codex CLI 0.164 rollout writes, in its order, with synthetic content. */
function codexTurn(at: number, responses: { calls: string[] }[]): string {
    let out = line({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } })
        + line({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', id: 'u', content: [{ type: 'input_text', text: 'do the thing' }] } })
        + line({ timestamp: iso(at), type: 'turn_context', payload: { model: 'm', cwd: '/x' } })
        + line({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage' } } });
    responses.forEach((r, i) => {
        out += line({ timestamp: iso(at + i), type: 'response_item', payload: { type: 'reasoning', id: `rs${i}`, summary: [] } });
        for (const c of r.calls) out += line({ timestamp: iso(at + i), type: 'response_item', payload: { type: 'custom_tool_call', id: `ctc_${c}`, call_id: c, name: 'exec', input: 'ls', status: 'completed' } });
        if (r.calls.length === 0) out += line({ timestamp: iso(at + i), type: 'response_item', payload: { type: 'message', role: 'assistant', id: `m${i}`, content: [{ type: 'output_text', text: 'done' }] } });
        out += line({ timestamp: iso(at + i), type: 'token_usage_record', payload: { response_id: `resp_${at}_${i}`, usage: { total_tokens: 10 } } });
        for (const c of r.calls) {
            out += line({ timestamp: iso(at + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } })
                + line({ timestamp: iso(at + i), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: c, output: [{ type: 'input_text', text: 'ok' }] } })
                + line({ timestamp: iso(at + i), type: 'event_msg', payload: { type: 'token_count', info: {} } });
        }
    });
    return out + line({ timestamp: iso(at + 9), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } });
}

function store(): { h: string; root: string; file: string; registryFile: string } {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-'));
    homes.push(h);
    const root = path.join(h, 'sessions', '2026', '10', '24');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'rollout-2026-10-24T01-08-00-x.jsonl');
    fs.writeFileSync(file, line({ timestamp: iso(stamp - 10), type: 'session_meta', payload: { id: 's', cli_version: '0.164.0' } })
        + line({ timestamp: iso(stamp - 10), type: 'world_state', payload: { full: true } })
        + codexTurn(stamp - 5, [{ calls: ['a1'] }, { calls: [] }]));
    return { h, root: path.join(h, 'sessions'), file, registryFile: path.join(h, '.provian', 'program-witnesses.json') };
}

/** The description the fresh agent wrote on 2026-10-24 (program-witnesses.json, verbatim rules). */
const freshAgentSession = (root: string): SessionDescription => ({
    root, maxDepth: 5, suffix: '.jsonl', timestamp: 'timestamp', responseId: 'payload.id', atomicResponses: true, responseParts: 'payload',
    rules: [
        { kind: 'model_response', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call' }] },
        { kind: 'tool_call', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call' }], name: 'payload.name', id: 'payload.call_id', input: 'payload.input' },
        { kind: 'tool_result', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call_output' }], id: 'payload.call_id', text: 'payload.output.*.text' },
    ],
});

/** A complete description: one model response = its tool calls up to its token_usage_record. */
const completeSession = (root: string): SessionDescription => ({
    root, maxDepth: 5, suffix: '.jsonl', timestamp: 'timestamp', atomicResponses: false,
    rules: [
        { kind: 'tool_call', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call' }], name: 'payload.name', id: 'payload.call_id', input: 'payload.input' },
        { kind: 'tool_result', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call_output' }], id: 'payload.call_id', text: 'payload.output.*.text' },
        { kind: 'user_prompt', where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'message' }, { path: 'payload.role', equals: 'user' }] },
        { kind: 'turn_end', where: [{ path: 'type', equals: 'token_usage_record' }] },
        { kind: 'ignore', where: [{ path: 'type', equals: 'response_item' }], unless: [{ path: 'payload.type', equals: 'custom_tool_call' }, { path: 'payload.type', equals: 'custom_tool_call_output' }] },
        { kind: 'ignore', where: [{ path: 'type', equals: 'event_msg' }] },
        { kind: 'ignore', where: [{ path: 'type', equals: 'session_meta' }] },
        { kind: 'ignore', where: [{ path: 'type', equals: 'turn_context' }] },
        { kind: 'ignore', where: [{ path: 'type', equals: 'world_state' }] },
    ],
});

const program = (session: SessionDescription) => ({ program: 'codex_cli', processNames: ['codex'], scriptPaths: ['/usr/local/bin/codex'], lane: 'transcript' as const, session });

async function read(f: ReturnType<typeof store>, now = stamp + 60_000): Promise<TranscriptPlugin> {
    const p = new TranscriptPlugin({ home: f.h, registry: new ProgramWitnessRegistry(f.registryFile), now: () => now });
    await p.init(observer);
    await p.start();
    return p;
}

describe('a Codex CLI session store described by the agent', () => {
    it(' refuses the actual 11-rule per-call description by name; its response-boundary repair mints parallel calls once', async () => {
        const f = store();
        fs.appendFileSync(f.file, codexTurn(stamp - 1, [{ calls: ['parallel1', 'parallel2'] }]));
        const spec = { ...fresh2Description, root: f.root } as SessionDescription;
        expect(spec.rules).toHaveLength(11);
        for (const candidate of [spec, { ...spec, responseParts: undefined, rules: spec.rules.map(r => r.kind === 'model_response' ? { kind: 'model_response' as const, where: [{ path: 'type', equals: 'response_item' }, { path: 'payload.type', equals: 'custom_tool_call' }] } : r) }]) {
            expect(() => configureProgram(program(candidate), f.registryFile, stamp)).toThrow(/response_is_tool_call.*parallel calls separately.*turn_end/);
        }
        // An already configured description must hold the new work, never split or reprice old rows.
        fs.mkdirSync(path.dirname(f.registryFile), { recursive: true });
        fs.writeFileSync(f.registryFile, JSON.stringify([{ ...program(spec), setupAtMs: stamp, baseline: {} }]));
        fs.appendFileSync(f.file, codexTurn(stamp + 1000, [{ calls: ['p1', 'p2'] }, { calls: ['p3'] }]));
        let p = await read(f);
        expect(p.drainPEs()).toEqual([]);
        expect(p.captureHealth().formatBrokenPrograms).toEqual(['codex_cli']);
        await p.stop();
        const repaired: SessionDescription = { ...spec, atomicResponses: false, responseId: undefined, rules: spec.rules.map(r => r.recordWhere?.some(t => t.equals === 'token_usage_record') ? { ...r, kind: 'turn_end' } : r) };
        configureProgram(program(repaired), f.registryFile, stamp + 2000);
        p = await read(f);
        const pes = p.drainPEs();
        expect(pes.map(pe => pe.metadata?.tool_count)).toEqual([2, 1]);
        for (const pe of pes) p.onCommitted(pe, 'submitted');
        await p.stop();
        expect((await read(f)).drainPEs()).toEqual([]);
    });

    it(' refuses per-call fragment ids missing from the response-ending record (RED)', async () => {
        const f = store();
        const spec = { ...completeSession(f.root), responseId: 'payload.id' };
        expect(() => configureProgram(program(spec), f.registryFile, stamp)).toThrow(/response_id_missing.*per-call id/);
    });
    it('configure refuses the description the fresh agent wrote and names the first record it cannot place (RED: it does parse tool calls)', () => {
        const f = store();
        const spec = freshAgentSession(f.root);
        // The control: a count-only check passes it, since its tool_call rule reads real calls.
        const records = fs.readFileSync(f.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
        expect(records.flatMap((r) => describedEvents(r, spec)).filter((e) => e.rule.kind === 'tool_call')).toHaveLength(1);
        expect(() => configureProgram(program(spec), f.registryFile, stamp)).toThrow(/cannot place record 1 of rollout-.*\(matches_no_rule: type="session_meta"; keys: timestamp, type, payload\).*kind "ignore"/);
        // Content is never echoed, only type-like fields.
        try { configureProgram(program(spec), f.registryFile, stamp); } catch (e) { expect((e as Error).message).not.toMatch(/0\.164\.0|do the thing/); }
        // Even with every other kind ignored, responseParts "payload" leaves the call record's payload unplaced.
        const withIgnores: SessionDescription = { ...spec, rules: [...spec.rules, ...completeSession(f.root).rules.filter((r) => r.kind === 'ignore' || r.kind === 'turn_end' || r.kind === 'user_prompt')] };
        expect(() => configureProgram(program(withIgnores), f.registryFile, stamp)).toThrow(/response_part_matches_no_rule/);
        expect(fs.existsSync(f.registryFile)).toBe(false);
    });

    it('a complete description is accepted and mints one PE per tool-calling model response, once (two parallel calls are one PE)', async () => {
        const f = store();
        const r = configureProgram(program(completeSession(f.root)), f.registryFile, stamp);
        expect(r).toMatchObject({ calls: 1, turns: 1 });
        // New work after setup: one response with two parallel calls, one with one call, one with none.
        fs.appendFileSync(f.file, codexTurn(stamp + 1000, [{ calls: ['b1', 'b2'] }, { calls: ['b3'] }, { calls: [] }]));
        let p = await read(f);
        const pes = p.drainPEs();
        expect(pes.map((pe) => pe.metadata?.tool_count)).toEqual([2, 1]);
        expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
        expect(fs.existsSync(path.join(f.h, '.provian', 'witness-action-required.json'))
            ? JSON.parse(fs.readFileSync(path.join(f.h, '.provian', 'witness-action-required.json'), 'utf8')).programs : []).toEqual([]);
        for (const pe of pes) p.onCommitted(pe, 'submitted');
        await p.stop();
        // A re-read (restart) mints nothing again.
        p = await read(f, stamp + 120_000);
        expect(p.drainPEs()).toEqual([]);
        await p.stop();
    });

    it('a new record kind after the lane cursor holds the lane; re-describing must place it, then the held work mints once', async () => {
        const f = store();
        configureProgram(program(completeSession(f.root)), f.registryFile, stamp);
        // Codex adds a record kind the description never named, then real work follows it.
        fs.appendFileSync(f.file, line({ timestamp: iso(stamp + 500), type: 'compacted', payload: { summary: 'x' } }) + codexTurn(stamp + 1000, [{ calls: ['n1'] }]));
        let p = await read(f);
        expect(p.drainPEs()).toEqual([]);
        expect(p.captureHealth().formatBrokenPrograms).toEqual(['codex_cli']);
        await p.stop();
        // The old description is refused at the first record the lane will read, naming its type only.
        expect(() => configureProgram(program(completeSession(f.root)), f.registryFile, stamp + 2000)).toThrow(/matches_no_rule: type="compacted"/);
        // Placing it is enough. (That records before the held cursor are not re-checked is pinned by the re-description tests in program-witness.test.ts and response-unit.test.ts.)
        const repaired = completeSession(f.root);
        repaired.rules.push({ kind: 'ignore', where: [{ path: 'type', equals: 'compacted' }] });
        configureProgram(program(repaired), f.registryFile, stamp + 2000);
        p = await read(f);
        const pes = p.drainPEs();
        expect(pes.map((pe) => pe.metadata?.tool_count)).toEqual([1]);
        expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
        for (const pe of pes) p.onCommitted(pe, 'submitted');
        await p.stop();
        p = await read(f, stamp + 120_000);
        expect(p.drainPEs()).toEqual([]);
        await p.stop();
    });

    it('accept ⇔ read: configure accepts a description exactly when the lane reads the same records without a repair flag', async () => {
        const variants: [string, (root: string) => SessionDescription][] = [
            ['fresh agent', freshAgentSession],
            ['complete', completeSession],
            ['no ignore for event_msg', (root) => ({ ...completeSession(root), rules: completeSession(root).rules.filter((r) => !(r.kind === 'ignore' && r.where?.[0]?.equals === 'event_msg')) })],
        ];
        let accepted = 0;
        for (const [, make] of variants) {
            const f = store();
            const spec = make(f.root);
            let ok = true;
            try { configureProgram(program(spec), f.registryFile, stamp); } catch { ok = false; }
            const records = fs.readFileSync(f.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
            expect(records.every((rec) => recordPlacementProblem(rec, spec, null) === null)).toBe(ok);
            if (!ok) continue;
            accepted += 1;
            fs.appendFileSync(f.file, codexTurn(stamp + 1000, [{ calls: ['c1'] }]));
            const p = await read(f);
            expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
            await p.stop();
        }
        expect(accepted).toBe(1);
    });
});
