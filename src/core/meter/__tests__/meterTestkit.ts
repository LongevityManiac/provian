/**
 * Shared fixtures for the phone PE meter tests: envelopes, a store over in-memory files, a PE
 * builder bound to a device, and a FAKE RELAY that applies the relay's own rules from meter-wire
 * (shape, batch chain, act chain, replay → the stored receipt).
 */

import type { ProvenanceEnvelope } from '../../provenance/types';
import {
    batchHashOf,
    batchLeafOf,
    METER_GENESIS_PREV_HASH,
    validateBatchShape,
    verifyActChain,
} from '../meter-wire';
import { MemoryMeterFiles } from '../meterFiles';
import type { MeterAnswer, MeterTransport } from '../meterTransport';
import { buildPhonePeV2 } from '../phonePeBuilder';
import { PhonePeStore, type MeterBatchReceiptWire, type StoredPeV2 } from '../phonePeStore';

export const DEVICE = 'device_aaaa1111';
export const ACTOR = 'human:user_1';
export const T0 = 1_791_000_000_000;

let seq = 0;
export function envelope(over: Partial<ProvenanceEnvelope> = {}): ProvenanceEnvelope {
    seq += 1;
    return {
        envelope_id: `env_${seq}_${Math.random().toString(16).slice(2, 10)}`,
        prev_envelope_hash: 'GENESIS',
        timestamp: T0 + seq * 1000,
        action_type: 'ai_conversation',
        intent_text: 'private words that never leave the phone',
        risk_score: 12,
        amount: '42',
        device_attestation_id: 'local_anchor',
        device_attestation_depth: 'software',
        ...over,
    } as ProvenanceEnvelope;
}

export async function openStore(files = new MemoryMeterFiles(), device = DEVICE): Promise<{ files: MemoryMeterFiles; store: PhonePeStore }> {
    const store = new PhonePeStore(files);
    await store.open(device);
    return { files, store };
}

/** Build and append `n` PEs to the store's own chain. */
export async function recordPes(store: PhonePeStore, n: number, over: Partial<ProvenanceEnvelope> = {}): Promise<StoredPeV2[]> {
    const out: StoredPeV2[] = [];
    const chain = store.own();
    for (let i = 0; i < n; i++) {
        const env = envelope(over);
        const head = await chain.head();
        const pe = await buildPhonePeV2({ envelope: env, detailHash: 'd'.repeat(64), deviceId: chain.deviceId, prevHash: head.last_pe_hash });
        const res = await chain.append(pe, { detail: env });
        if (!res.ok) throw new Error(`append failed: ${res.reason}`);
        out.push(pe);
    }
    return out;
}

function receiptFor(batchBody: Record<string, unknown>, acceptedAtMs: number): MeterBatchReceiptWire {
    const shape = validateBatchShape(batchBody);
    if (!shape.ok) throw new Error('fake relay: invalid batch');
    const batch = shape.batch;
    const batchHash = batchHashOf(batch);
    return {
        schema: 'provian.pe-batch-receipt.v1',
        device_id: batch.device_id,
        actor_id: ACTOR,
        seq: batch.seq,
        batch_hash: batchHash,
        acts_root: batch.acts_root,
        batch_leaf: batchLeafOf({ device_id: batch.device_id, actor_id: ACTOR, seq: batch.seq, batch_hash: batchHash, acts_root: batch.acts_root }),
        accepted_at_ms: acceptedAtMs,
        acts: batch.acts.map((a, i) => ({
            pe_id: a.pe_id,
            pe_hash: a.pe_hash,
            relay_pe_id: `rpe_${a.pe_id}`,
            leaf_index: i,
            disposition: 'eligible',
            reason: 'ok',
            record_points_atomic: '1000000000000000000',
            mint_status: 'eligible',
        })),
        totals: { eligible_points_atomic: String(BigInt(batch.acts.length) * 10n ** 18n), acts: batch.acts.length, eligible: batch.acts.length },
    };
}

/**
 * A relay that answers like the real one: it keeps this device's tip, refuses a batch that does not
 * extend it (batch_chain_broken / act_chain_broken), answers a replay of an accepted batch with its
 * stored receipt (200), and accepts the next batch (201). `script` answers ahead of the rules.
 */
export class FakeRelay implements MeterTransport {
    tip = { seq: 0, batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH };
    readonly receipts = new Map<string, MeterBatchReceiptWire>();
    readonly posted: string[] = [];
    readonly script: (MeterAnswer | ((body: string) => MeterAnswer))[] = [];
    mailbox: Record<string, unknown>[] = [];
    readonly acked: string[][] = [];
    readonly mailboxCalls: { after: string | null; limit: number }[] = [];
    /** False = an older relay that gives no count. */
    countWaiting = true;
    proofsCalls = 0;
    proofs: Record<string, unknown>[] = [];
    tipAnswer: MeterAnswer | null = null;
    now = T0 + 10_000_000;

    async postBatch(body: string): Promise<MeterAnswer> {
        this.posted.push(body);
        const scripted = this.script.shift();
        if (scripted) {
            const answer = typeof scripted === 'function' ? scripted(body) : scripted;
            return answer;
        }
        return this.apply(body);
    }

    /** The relay's own rules. */
    apply(body: string): MeterAnswer {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const shape = validateBatchShape(parsed);
        if (!shape.ok) return { status: 400, body: { error: 'batch_invalid', code: shape.error }, error: null };
        const batch = shape.batch;
        const hash = batchHashOf(batch);
        const held = this.receipts.get(hash);
        if (held) return { status: 200, body: held, error: null };
        if (batch.seq <= this.tip.seq) {
            return { status: 409, body: { error: 'batch_replay', expected_seq: this.tip.seq + 1, expected_prev_batch_hash: this.tip.batch_hash, last_pe_hash: this.tip.last_pe_hash }, error: null };
        }
        if (batch.seq !== this.tip.seq + 1 || batch.prev_batch_hash !== this.tip.batch_hash) {
            return { status: 409, body: { error: 'batch_chain_broken', expected_seq: this.tip.seq + 1, expected_prev_batch_hash: this.tip.batch_hash, last_pe_hash: this.tip.last_pe_hash }, error: null };
        }
        if (!verifyActChain(this.tip.last_pe_hash, batch.acts).ok) {
            return { status: 409, body: { error: 'act_chain_broken', last_pe_hash: this.tip.last_pe_hash }, error: null };
        }
        const receipt = receiptFor(parsed, this.now);
        this.receipts.set(hash, receipt);
        this.tip = { seq: batch.seq, batch_hash: hash, last_pe_hash: batch.acts[batch.acts.length - 1].pe_hash };
        return { status: 201, body: receipt, error: null };
    }

    async getTip(): Promise<MeterAnswer> {
        if (this.tipAnswer) return this.tipAnswer;
        return { status: 200, body: { ...this.tip }, error: null };
    }

    async getProofs(afterSeq: number): Promise<MeterAnswer> {
        this.proofsCalls += 1;
        const page = this.proofs.filter((p) => (p.seq as number) > afterSeq);
        return { status: 200, body: { proofs: page, next_after_seq: page.length > 0 ? null : null }, error: null };
    }

    async getMailbox(after: string | null, limit: number): Promise<MeterAnswer> {
        this.mailboxCalls.push({ after, limit });
        const start = after === null ? 0 : this.mailbox.findIndex((m) => m.id === after) + 1;
        const page = this.mailbox.slice(start, start + limit);
        const more = start + limit < this.mailbox.length;
        // As the relay: the first page also says how many items wait in all.
        const body: Record<string, unknown> = { items: page, next: more && page.length > 0 ? page[page.length - 1].id : null };
        if (after === null && this.countWaiting) body.waiting = this.mailbox.length;
        return { status: 200, body, error: null };
    }

    async ackMailbox(ids: readonly string[]): Promise<MeterAnswer> {
        this.acked.push([...ids]);
        return { status: 200, body: { acked: ids.length }, error: null };
    }
}
