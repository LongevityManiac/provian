/**
 * PE METER (app) — the phone's HTTP surface on the relay, under wallet auth.
 *
 *   POST /v1/meter/batch/mobile          the daily batch (the v2 token binds method, path and the
 *                                        body hash, so the batch is body-bound)
 *   GET  /v1/meter/mobile/tip            the relay's last accepted seq / batch hash / PE for this device
 *   GET  /v1/meter/mobile/proofs         anchored batch proofs after a sequence number
 *   GET  /v1/meter/mobile/mailbox        sealed PEs addressed to this person
 *   POST /v1/meter/mobile/mailbox/ack    drop filed mailbox items
 *   POST /v1/meter/mobile/batch-proofs   batch records + anchor proofs of PEs sealed to this person
 *
 * The transport never interprets an answer: it returns the status and parsed body, or a null
 * status when no HTTP answer arrived at all. The batcher decides what each answer means.
 */

export interface MeterAnswer {
    /** null = no HTTP answer at all (offline, DNS, reset, timeout, not signed in yet). */
    readonly status: number | null;
    /** Parsed JSON body, or null when the body was not JSON. */
    readonly body: unknown;
    /** Transport error or a short body excerpt, for logs. */
    readonly error: string | null;
}

export interface MeterTransport {
    /** Send the batch's exact wire text (re-sent byte for byte until a definite answer). */
    postBatch(body: string, openings?:Record<string,string>): Promise<MeterAnswer>;
    getTip(): Promise<MeterAnswer>;
    getProofs(afterSeq: number, hashes?: readonly string[]): Promise<MeterAnswer>;
    getMailbox(after: string | null, limit: number): Promise<MeterAnswer>;
    ackMailbox(ids: readonly string[]): Promise<MeterAnswer>;
    /**
     * Batch records and anchor proofs by batch hash, for PEs other parties sealed to this person —
     * and by one-act `acts_root` for a relay-authored PE handed over directly (no batch hash known).
     * At most 200 values in all.
     */
    getBatchProofs?(batchHashes: readonly string[], actsRoots?: readonly string[]): Promise<MeterAnswer>;
}

/** The one relay call the transport needs (RelayAPIService.meterRequest). */
export interface MeterRelayClient {
    meterRequest(method: 'GET' | 'POST', path: string, body?: string): Promise<MeterAnswer>;
    privateBatch?(body:string,openings:Record<string,string>):Promise<MeterAnswer>;
    /** RelayAPIService.meterBatchProofs; absent = the same call through `meterRequest`. */
    meterBatchProofs?(batchHashes: readonly string[], actsRoots?: readonly string[]): Promise<MeterAnswer>;
}

export const METER_BATCH_PROOFS_PATH = '/v1/meter/mobile/batch-proofs';

/** The batch-proofs request body: only the non-empty lists. */
export function batchProofsBody(batchHashes: readonly string[], actsRoots: readonly string[] = []): string {
    return JSON.stringify({
        ...(batchHashes.length > 0 ? { batch_hashes: [...batchHashes] } : {}),
        ...(actsRoots.length > 0 ? { acts_roots: [...actsRoots] } : {}),
    });
}

export const METER_BATCH_PATH = '/v1/meter/batch/mobile';

export function createRelayMeterTransport(relay: MeterRelayClient): MeterTransport {
    return {
        postBatch: (body,openings={}) => relay.privateBatch?relay.privateBatch(body,openings):relay.meterRequest('POST', METER_BATCH_PATH, body),
        getTip: () => relay.meterRequest('GET', '/v1/meter/mobile/tip'),
        getProofs: (afterSeq, hashes) => relay.meterRequest('GET', `/v1/meter/mobile/proofs?after_seq=${encodeURIComponent(String(afterSeq))}${hashes ? `&batch_hashes=${hashes.join(',')}` : ''}`),
        getMailbox: (after, limit) => relay.meterRequest(
            'GET',
            `/v1/meter/mobile/mailbox?limit=${encodeURIComponent(String(limit))}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        ),
        ackMailbox: (ids) => relay.meterRequest('POST', '/v1/meter/mobile/mailbox/ack', JSON.stringify({ ids })),
        getBatchProofs: (hashes, roots = []) => (relay.meterBatchProofs
            ? relay.meterBatchProofs(hashes, roots)
            : relay.meterRequest('POST', METER_BATCH_PROOFS_PATH, batchProofsBody(hashes, roots))),
    };
}
