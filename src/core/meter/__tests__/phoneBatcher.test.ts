/**
 * The phone's batcher against every relay answer (: every act mints once,
 * from one signed batch per hour). The fake relay applies the relay's own rules (meter-wire), so a
 * batch the phone builds is checked exactly as the relay checks it. RED controls per.
 */
import { describe, it, expect } from 'vitest';
import { buildBatch, batchHashOf, batchLeafOf, MAX_ACTS_PER_BATCH, type PeBatch } from '../meter-wire';
import { MemoryMeterFiles } from '../meterFiles';
import { METER_RELAY_MIN_INTERVAL_MS, PhoneBatcher } from '../phoneBatcher';
import { PhonePeStore } from '../phonePeStore';
import { ACTOR, DEVICE, FakeRelay, openStore, recordPes, T0 } from './meterTestkit';

function setup(relay = new FakeRelay()) {
    let clock = T0 + 1_000_000;
    const accepted: number[] = [];
    const make = (store: PhonePeStore) => new PhoneBatcher({
        store, transport: relay, now: () => clock, resendDelayMs: 0,
        onAccepted: (r) => accepted.push(r.seq),
    });
    return { relay, make, accepted, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

async function hashes(store: PhonePeStore): Promise<string[]> {
    return (await store.own().allPes()).map((e) => e.pe.pe_hash);
}

describe('201 / 200 — accepted', () => {
    it('sends every unsent PE in one batch, files the receipt, clears the in-flight copy, then has nothing to send', async () => {
        const { store } = await openStore();
        const { relay, make, accepted } = setup();
        await recordPes(store, 3);
        const batcher = make(store);
        const report = await batcher.flush();
        expect(report).toMatchObject({ outcome: 'sent', batchesAccepted: 1, actsAccepted: 3, halt: null });
        expect(relay.tip.seq).toBe(1);
        expect(accepted).toEqual([1]);
        expect(await store.own().inFlight()).toBeNull();
        const [receipt] = await store.own().listReceipts();
        expect(receipt.acts.map((a) => a.pe_hash)).toEqual(await hashes(store));
        expect((await batcher.flush()).outcome).toBe('nothing_to_send');
        // The act records the relay saw carry no free text.
        expect(relay.posted[0]).not.toContain('private words');
    });

    it('RED: a 201 whose receipt names another batch halts (receipt_mismatch) instead of filing it', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 2);
        relay.script.push((body) => {
            const answer = relay.apply(body);
            return { ...answer, body: { ...(answer.body as object), batch_hash: 'f'.repeat(64) } };
        });
        const report = await make(store).flush();
        expect(report.outcome).toBe('halted');
        expect(report.halt?.reason).toBe('receipt_mismatch');
        expect(await store.own().listBatches()).toEqual([]);
    });
});

describe('the in-flight batch is persisted before it is sent and re-sent byte for byte', () => {
    it('an accepted batch whose answer was lost is re-sent with the SAME bytes after a restart; the relay answers 200 with the stored receipt — never a second batch', async () => {
        const files = new MemoryMeterFiles();
        const { store } = await openStore(files);
        const { relay, make, advance } = setup();
        await recordPes(store, 4);
        // The relay accepts, but the answer never arrives.
        relay.script.push((body) => { relay.apply(body); return { status: null, body: null, error: 'socket hang up' }; });
        const first = await make(store).flush();
        expect(first.outcome).toBe('deferred');
        const inflight = await store.own().inFlight();
        expect(inflight?.body).toBe(relay.posted[0]);

        // "Restart" a minute later (a rebuilt batch would carry a new created_at_ms, so different bytes).
        advance(60_000);
        const reopened = new PhonePeStore(files);
        await reopened.open(DEVICE);
        const second = await make(reopened).flush();
        expect(second.outcome).toBe('sent');
        expect(relay.posted).toHaveLength(2);
        expect(relay.posted[1]).toBe(relay.posted[0]); // identical bytes
        expect(relay.tip.seq).toBe(1);                 // one batch, not two
        expect((await reopened.own().lastBatch())?.seq).toBe(1);
        expect(await reopened.own().inFlight()).toBeNull();
    });

    it('no answer / 5xx / 401 keep the same batch queued (deferred, no halt); the next send posts identical bytes', async () => {
        for (const status of [null, 500, 503, 401]) {
            const { store } = await openStore();
            const { relay, make, advance } = setup();
            await recordPes(store, 2);
            relay.script.push({ status, body: status === null ? null : { error: 'x' }, error: 'e' });
            const batcher = make(store);
            const r = await batcher.flush();
            expect(r.outcome).toBe('deferred');
            expect(r.retryAtMs).not.toBeNull();
            expect(await store.own().halt()).toBeNull();
            advance(60_000);
            await batcher.flush();
            expect(relay.posted[1]).toBe(relay.posted[0]);
            expect(relay.tip.seq).toBe(1);
        }
    });

    it('409 batch_concurrent / batch_retry: the same batch is re-sent unchanged (up to 3 times), then deferred', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 1);
        for (let i = 0; i < 4; i++) relay.script.push({ status: 409, body: { error: i % 2 ? 'batch_retry' : 'batch_concurrent' }, error: null });
        const r = await make(store).flush();
        expect(r.outcome).toBe('deferred');
        expect(relay.posted).toHaveLength(4);
        expect(new Set(relay.posted).size).toBe(1);
        expect(await store.own().halt()).toBeNull();
    });

    it('a crash after the receipt was filed but before the in-flight copy was cleared is recognised, not re-sent', async () => {
        const files = new MemoryMeterFiles();
        const { store } = await openStore(files);
        const { relay, make } = setup();
        await recordPes(store, 2);
        await make(store).flush();
        // Put the accepted batch back "in flight" as a crash would have left it.
        const posted = JSON.parse(relay.posted[0]) as PeBatch;
        await store.own().setInFlight({ batch: posted, body: relay.posted[0], batch_hash: batchHashOf(posted), first_index: 0, count: 2, last_pe_hash: (await hashes(store))[1], persisted_at_ms: 1 });
        const r = await make(store).flush();
        expect(r.outcome).toBe('nothing_to_send');
        expect(relay.posted).toHaveLength(1);
        expect(await store.own().inFlight()).toBeNull();
    });
});

describe('409 chain answers — read the tip; catch up or stop, never re-chain', () => {
    it('batch_replay with the relay ahead on THIS device\'s own PEs: adopts the relay\'s tip (no PE changes) and continues', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 6);
        const before = await hashes(store);
        // The relay already accepted PEs 0..2 as seq 1 (this phone lost its record of it).
        const pes = (await store.own().readPes(0, 3)).map((e) => e.pe);
        relay.apply(JSON.stringify(buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: T0, pes })));
        const r = await make(store).flush();
        expect(r.outcome).toBe('sent');
        expect(relay.tip.seq).toBe(2);
        expect(relay.tip.last_pe_hash).toBe(before[5]);
        const batches = await store.own().listBatches();
        expect(batches.map((b) => [b.seq, b.first_index, b.count, b.adopted === true])).toEqual([[1, 0, 3, true], [2, 3, 3, false]]);
        expect(await hashes(store)).toEqual(before); // no PE touched
    });

    it('batch_chain_broken with the relay BEHIND this phone halts (relay_behind_local); RED: the PEs are unchanged and no batch is sent afterwards', async () => {
        const { store } = await openStore();
        const first = setup();
        await recordPes(store, 2);
        await first.make(store).flush();
        // A relay that has lost this device's history.
        const amnesiac = setup(new FakeRelay());
        await recordPes(store, 2);
        const before = await hashes(store);
        const batcher = amnesiac.make(store);
        const r = await batcher.flush();
        expect(r.outcome).toBe('halted');
        expect(r.halt?.reason).toBe('relay_behind_local');
        expect(await hashes(store)).toEqual(before);
        const posts = amnesiac.relay.posted.length;
        expect((await batcher.flush()).outcome).toBe('halted');
        expect(amnesiac.relay.posted.length).toBe(posts);
        // PEs keep being recorded on the phone while halted.
        await recordPes(store, 1);
        expect((await store.own().head()).count).toBe(5);
    });

    it('RED: the relay AHEAD on PEs this device never made halts (relay_chain_diverged) — never adopted, never re-chained', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        const foreign = await openStore(new MemoryMeterFiles(), DEVICE);
        const foreignPes = await recordPes(foreign.store, 2);
        relay.apply(JSON.stringify(buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: T0, pes: foreignPes })));
        await recordPes(store, 3);
        const before = await hashes(store);
        const r = await make(store).flush();
        expect(r.outcome).toBe('halted');
        expect(r.halt?.reason).toBe('relay_chain_diverged');
        expect(await store.own().listBatches()).toEqual([]);
        expect(await hashes(store)).toEqual(before);
    });

    it('act_chain_broken whose tip is not one of this device\'s PEs halts with that reason (stop, never re-chain)', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        relay.tip = { seq: 0, batch_hash: 'genesis', last_pe_hash: 'f'.repeat(64) };
        await recordPes(store, 2);
        const before = await hashes(store);
        const r = await make(store).flush();
        expect(r.halt?.reason).toBe('act_chain_broken');
        expect(await hashes(store)).toEqual(before);
    });

    it('act_chain_broken whose tip IS one of this device\'s unbatched PEs adopts and continues', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 3);
        const pes = (await store.own().readPes(0, 1)).map((e) => e.pe);
        relay.apply(JSON.stringify(buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: T0, pes })));
        // Answer the phone's seq-1 batch as an act-chain refusal first (the relay's view of the race).
        relay.script.push({ status: 409, body: { error: 'act_chain_broken', last_pe_hash: relay.tip.last_pe_hash }, error: null });
        const r = await make(store).flush();
        expect(r.outcome).toBe('sent');
        expect(relay.tip.seq).toBe(2);
    });

    it('RED: an unreadable tip halts (relay_tip_unreadable) instead of guessing', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        relay.tipAnswer = { status: 503, body: null, error: 'down' };
        await recordPes(store, 1);
        relay.script.push({ status: 409, body: { error: 'batch_chain_broken' }, error: null });
        const r = await make(store).flush();
        expect(r.halt?.reason).toBe('relay_tip_unreadable');
    });
});

describe('the other answers', () => {
    it('429 batch_too_soon: deferred until retry_after_ms, the batch kept in flight', async () => {
        const { store } = await openStore();
        const { relay, make, now } = setup();
        await recordPes(store, 1);
        relay.script.push({ status: 429, body: { error: 'batch_too_soon', retry_after_ms: 120_000 }, error: null });
        const r = await make(store).flush();
        expect(r.outcome).toBe('deferred');
        expect(r.retryAtMs).toBe(now() + 120_000);
        expect((await store.own().inFlight())?.body).toBe(relay.posted[0]);
    });

    it('413: rebuilds a smaller batch (never changes a PE) and sends it', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 8);
        relay.script.push({ status: 413, body: { error: 'payload_too_large' }, error: null });
        const r = await make(store).flush();
        expect(r.batchesAccepted).toBe(1);
        const firstActs = (JSON.parse(relay.posted[0]) as PeBatch).acts.length;
        const secondActs = (JSON.parse(relay.posted[1]) as PeBatch).acts.length;
        expect(firstActs).toBe(8);
        expect(secondActs).toBeLessThan(8);
        expect(r.retryAtMs).not.toBeNull(); // the rest goes next
    });

    it('400 batch_invalid and 403 batch_device_mismatch halt', async () => {
        for (const [status, error, reason] of [[400, 'batch_invalid', 'batch_invalid'], [403, 'batch_device_mismatch', 'batch_device_mismatch']] as const) {
            const { store } = await openStore();
            const { relay, make } = setup();
            await recordPes(store, 1);
            relay.script.push({ status, body: { error, code: 'bad_act' }, error: null });
            const r = await make(store).flush();
            expect(r.halt?.reason).toBe(reason);
        }
    });

    it('a full batch (500 acts) is followed at once by the next one', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, MAX_ACTS_PER_BATCH + 3);
        const r = await make(store).flush();
        expect(r.batchesAccepted).toBe(2);
        expect(relay.tip.seq).toBe(2);
    });
});

describe('schedule (: one batch per day, plus right before a presentation or payout)', () => {
    it('a timer tick sends once a day; foreground and new PEs do not send in between', async () => {
        const { store } = await openStore();
        const { relay, make, advance } = setup();
        const batcher = make(store);
        await recordPes(store, 1);
        await batcher.tick('timer');
        expect(relay.tip.seq).toBe(1);
        await recordPes(store, 1);
        advance(METER_RELAY_MIN_INTERVAL_MS * 2);
        await batcher.tick('foreground');
        expect(relay.tip.seq).toBe(1); // not due: the next batch is a day away
        advance(24 * 60 * 60 * 1000);
        await batcher.tick('timer');
        expect(relay.tip.seq).toBe(2);
    });

    it('the mailbox is checked once a day, on the batch cadence; coming to the foreground does not check it early', async () => {
        const { store } = await openStore();
        const { relay, make, advance } = setup();
        const batcher = make(store);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(1);
        advance(60 * 60 * 1000);
        await batcher.tick('timer'); // an hour later: not due
        await batcher.tick('foreground'); // opening the app: not due either
        expect(relay.mailboxCalls).toHaveLength(1);
        advance(23 * 60 * 60 * 1000);
        await batcher.tick('timer'); // a day after the last check
        expect(relay.mailboxCalls).toHaveLength(2);
    });

    it('once a day holds across app restarts: a cold start an hour later neither sends, checks the mailbox nor fetches early', async () => {
        const files = new MemoryMeterFiles();
        const { store } = await openStore(files);
        const { relay, make, advance } = setup();
        await recordPes(store, 1);
        await make(store).tick('timer');
        expect(relay.tip.seq).toBe(1);
        expect(relay.mailboxCalls).toHaveLength(1);
        const proofsAfterFirst = relay.proofsCalls;

        // The app is killed and relaunched an hour later, with a new act waiting.
        advance(60 * 60 * 1000);
        const reopened = new PhonePeStore(files);
        await reopened.open(DEVICE);
        await recordPes(reopened, 1);
        const relaunched = make(reopened);
        await relaunched.tick('foreground');
        expect(relay.tip.seq).toBe(1);
        expect(relay.mailboxCalls).toHaveLength(1);
        expect(relay.proofsCalls).toBe(proofsAfterFirst);

        // A day after the first run, all three are due again.
        advance(23 * 60 * 60 * 1000);
        await relaunched.tick('timer');
        expect(relay.tip.seq).toBe(2);
        expect(relay.mailboxCalls).toHaveLength(2);
    });

    it('RED: with no schedule on the phone (first run, a recovered phone) or an unreadable one, everything is due at once', async () => {
        for (const saved of [null, 'not json', JSON.stringify({ send_at_ms: 'soon' })]) {
            const files = new MemoryMeterFiles();
            const { store } = await openStore(files);
            if (saved !== null) await files.writeAtomic('schedule.json', saved);
            const { relay, make } = setup();
            await recordPes(store, 1);
            await make(store).tick('timer');
            expect(relay.tip.seq).toBe(1);
            expect(relay.mailboxCalls).toHaveLength(1);
        }
    });

    it('a saved time more than a day ahead (the clock moved back) waits at most one day', async () => {
        const files = new MemoryMeterFiles();
        const { store } = await openStore(files);
        const { relay, make, advance } = setup();
        const far = T0 + 1_000_000 + 30 * 24 * 60 * 60 * 1000;
        await store.writeSchedule({ send_at_ms: far, mailbox_at_ms: far, proofs_at_ms: far });
        const batcher = make(store);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(0);
        advance(24 * 60 * 60 * 1000);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(1);
    });

    it('the schedule never reaches the cloud backup', async () => {
        const files = new MemoryMeterFiles();
        const { store } = await openStore(files);
        const { make } = setup();
        await make(store).tick('timer');
        expect(await files.read('schedule.json')).not.toBeNull();
        expect(store.dirtyPaths().map((d) => d.path)).not.toContain('schedule.json');
        expect(store.allRecordPaths()).not.toContain('schedule.json');
    });

    it('flushBeforeUse sends the latest acts at once; inside the 5-minute rule it waits it out once', async () => {
        const { store } = await openStore();
        const { relay, make, advance } = setup();
        const batcher = make(store);
        await recordPes(store, 1);
        await batcher.tick('timer');
        await recordPes(store, 2);
        relay.script.push({ status: 429, body: { error: 'batch_too_soon', retry_after_ms: 120_000 }, error: null });
        const slept: number[] = [];
        const r = await batcher.flushBeforeUse({ sleep: async (ms) => { slept.push(ms); advance(ms); } });
        expect(slept).toEqual([120_000]);
        expect(r.outcome).toBe('sent');
        expect(relay.tip.seq).toBe(2);
    });
});

describe('daily proofs', () => {
    it('keeps a proof verified only when its leaf recomputes from this phone\'s own batch record; a mismatch is kept unverified', async () => {
        const { store } = await openStore();
        const { relay, make } = setup();
        await recordPes(store, 2);
        const batcher = make(store);
        await batcher.flush();
        const b = (await store.own().lastBatch())!;
        const anchor = { day: '2026-10-03', anchor_batch_id: 'a1', leaf_index: 0, leaf_count: 1, leaf_hash: 'x', proof: [], merkle_root: 'r', anchor_tx_hash: null };
        relay.proofs = [
            { seq: 1, batch_hash: b.batch_hash, acts_root: b.acts_root, actor_id: ACTOR, batch_leaf: batchLeafOf({ device_id: DEVICE, actor_id: ACTOR, seq: 1, batch_hash: b.batch_hash, acts_root: b.acts_root! }), chain_id: 8453, anchor_contract: '0x889a', anchor },
            { seq: 2, batch_hash: 'a'.repeat(64), acts_root: 'b'.repeat(64), actor_id: ACTOR, batch_leaf: 'c'.repeat(64), anchor },
        ];
        const report = await batcher.fetchProofs();
        expect(report).toEqual({ ok: true, fetched: 2, unverified: 1 });
        const proofs = await store.own().listProofs();
        expect(proofs.map((p) => [p.seq, p.verified])).toEqual([[1, true], [2, false]]);
    });
});
