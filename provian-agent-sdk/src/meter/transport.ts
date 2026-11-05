import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * PE METER — the device's HTTP surface on the relay (`/v1/meter/*`).
 *
 * Every call is device-authenticated (the retired single-PE `POST /v1/pe/submit` used the same
 * credentials). The batch POST is
 * body-bound (a DeviceSignature envelope on a Secure Enclave device, otherwise the DeviceKey
 * bearer plus `X-Provian-Body-HMAC`) — a batch that is not body-bound has every act refused. The
 * reads, the mailbox ack and the batch-proofs read carry the DeviceKey bearer.
 *
 * The transport never interprets an answer: it returns the status and parsed body, or a null
 * status when no HTTP answer arrived at all. The batcher decides what each answer means.
 */

import {type PeBatch, type SealedCopy} from '../meter-wire';
import {sealPrivatePricing} from './private-pricing';

export interface MeterAnswer {
  /** null = no HTTP answer at all (DNS, connect, reset, timeout, a proxy that vanished). */
  readonly status: number | null;
  /** Parsed JSON body, or null when the body was not JSON. */
  readonly body: unknown;
  /** Transport error or a short body excerpt, for logs. */
  readonly error: string | null;
}

export interface MeterTransport {
  postBatch(batch: PeBatch, openings?:Record<string,string>): Promise<MeterAnswer>;
  getTip(): Promise<MeterAnswer>;
  getSealTargets(): Promise<MeterAnswer>;
  getProofs(afterSeq: number, hashes?: readonly string[]): Promise<MeterAnswer>;
  peekMailbox?(): Promise<MeterAnswer>;
  getMailbox(after: string | null, limit: number): Promise<MeterAnswer>;
  ackMailbox(ids: readonly string[]): Promise<MeterAnswer>;
  resendTransit?(batchHash: string, sealed: readonly SealedCopy[], receipt?: string, recipients?: Readonly<Record<string, string>>): Promise<MeterAnswer>;
  /**
   * `POST /v1/meter/batch-proofs` — the anchoring record (identity, act leaves, anchor proof) of
   * batches whose PEs were sealed to this agent (1..200 batch hashes). Optional: a transport
   * without it never fetches proofs for received PEs.
   */
  getBatchProofs?(batchHashes: readonly string[]): Promise<MeterAnswer>;
}

/** The most batch hashes one `POST /v1/meter/batch-proofs` may name. */
export const METER_BATCH_PROOFS_MAX = 200;

export interface HttpMeterTransportOptions {
  readonly relayUrl: string;
  /** Headers + exact wire body for a body-bound POST (DeviceSignature or DeviceKey + body HMAC). */
  readonly boundEnvelope: (body: Record<string, unknown>, path: string) => Promise<{ headers: Record<string, string>; body: string }>;
  /** The DeviceKey bearer for reads. */
  readonly authHeaders: () => Record<string, string>;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly privacySecret?:()=>string;
}

export function createHttpMeterTransport(options: HttpMeterTransportOptions): MeterTransport {
  const doFetch = guardedFetcher(options.fetchImpl);
  const call = async (path: string, init: RequestInit): Promise<MeterAnswer> => {
    try {
      const response = await doFetch(`${options.relayUrl}${path}`, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
      const text = await response.text().catch(() => '');
      let body: unknown = null;
      try { body = text.length > 0 ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, body, error: response.ok ? null : text.slice(0, 500) };
    } catch (err) {
      return { status: null, body: null, error: (err as Error).message };
    }
  };
  const get = (path: string): Promise<MeterAnswer> => call(path, {
    method: 'GET',
    headers: { accept: 'application/json', ...options.authHeaders() },
  });
  const privateBody=(body:Record<string,unknown>,path:string)=>{
    const secret=options.privacySecret?.();return JSON.stringify(secret?{private_request:sealPrivatePricing({request:body},secret,'provian-private-request:v1:'+path)}:body);
  };
  const privateQuery=(body:Record<string,unknown>,path:string)=>{
    const secret=options.privacySecret?.();return secret?'?private_query='+encodeURIComponent(JSON.stringify(sealPrivatePricing({request:body},secret,'provian-private-request:v1:'+path))):'?limit='+body.limit+(body.after?'&after='+encodeURIComponent(String(body.after)):'');
  };
  return {
    async resendTransit(batchHash, sealed, receipt, recipients) {
      try {
        const request = { batch_hash: batchHash, sealed, ...(receipt ? { transit_receipt: receipt } : {}), ...(recipients ? { transit_recipients: recipients } : {}) };
        const secret = options.privacySecret?.();
        const body = secret ? { private_request: sealPrivatePricing({ request }, secret, 'provian-private-request:v1:/v1/meter/transit') } : request;
        const envelope = await options.boundEnvelope(body, '/v1/meter/transit');
        return call('/v1/meter/transit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...envelope.headers }, body: envelope.body });
      } catch (error) { return { status: null, body: null, error: String(error) }; }
    },
    async postBatch(batch: PeBatch, openings:Record<string,string>={}): Promise<MeterAnswer> {
      let envelope: { headers: Record<string, string>; body: string };
      try {
        const secret=options.privacySecret?.();
        const body=secret?{private_batch:sealPrivatePricing({batch,openings},secret,'provian-private-batch:v1')}:batch;
        if(Object.keys(openings).length&&!options.privacySecret?.())throw new Error('existing device credential unavailable');
        envelope = await options.boundEnvelope(body as unknown as Record<string, unknown>, '/v1/meter/batch');
      } catch (err) {
        return { status: null, body: null, error: `signing failed: ${(err as Error).message}` };
      }
      return call('/v1/meter/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...envelope.headers },
        body: envelope.body,
      });
    },
    getTip: () => get('/v1/meter/tip'),
    getSealTargets: () => get('/v1/meter/seal-targets'),
    getProofs: (afterSeq: number, hashes?: readonly string[]) => get(`/v1/meter/proofs?after_seq=${encodeURIComponent(String(afterSeq))}${hashes ? `&batch_hashes=${hashes.join(',')}` : ''}`),
    peekMailbox: () => get('/v1/meter/mailbox/peek'),
    getMailbox: (after: string | null, limit: number) => get(
      '/v1/meter/mailbox'+privateQuery({limit,...(after?{after}:{})},'/v1/meter/mailbox'),
    ),
    ackMailbox: (ids: readonly string[]) => call('/v1/meter/mailbox/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.authHeaders() },
      body: privateBody({ids},'/v1/meter/mailbox/ack'),
    }),
    getBatchProofs: (batchHashes: readonly string[]) => call('/v1/meter/batch-proofs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json', ...options.authHeaders() },
      body: privateBody({batch_hashes:batchHashes},'/v1/meter/batch-proofs'),
    }),
  };
}
