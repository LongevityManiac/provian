import {unwrapPrivateBatch,openPrivateAuthenticatedRequest} from '../../../provian-backend/src/core/meter/private-pricing';
/**
 * TEST SUPPORT (excluded from the build).
 *
 *   CapturingPeStore — an in-memory PE store that also records, in append order, every PE newly
 *     recorded: what the observer suites used to read off the wire of `POST /v1/pe/submit`.
 *     Under the PE meter a lane's PE is recorded locally; its act record leaves the machine
 *     only inside the daily batch.
 *   FakeMeterRelay — the relay's `/v1/meter/*` surface with the relay's own ingest rules for
 *     the parts a device can observe (shape, same-batch idempotency, seq / prev_batch_hash /
 *     act-chain continuity, a receipt per act), plus scripted one-off answers.
 */

import {
  batchHashOf,
  batchLeafOf,
  METER_GENESIS_PREV_HASH,
  validateBatchShape,
  verifyActChain,
  type PeBatch,
} from '../meter-wire';
import { MemoryPeStore, type AppendResult, type MeterBatchReceiptWire, type StoredPeV2 } from './pe-store';

export const TEST_DEVICE_ID = 'dev_' + 'ab'.repeat(32);
export const TEST_ACTOR_ID = 'agent_wallet_test';

export class CapturingPeStore extends MemoryPeStore {
  /** Every newly recorded PE, as a plain record (replays are not repeated). */
  readonly bodies: Record<string, unknown>[] = [];
  /** The same, with the idempotency key each was recorded under. */
  readonly entries: { body: Record<string, unknown>; key: string | null }[] = [];
  /** Answers that were replays of an already-recorded key. */
  replays = 0;

  constructor(deviceId: string = TEST_DEVICE_ID) {
    super(deviceId);
  }

  override async append(pe: StoredPeV2, options: { idempotencyKey?: string; recordedAtMs?: number } = {}): Promise<AppendResult> {
    const result = await super.append(pe, options);
    if (result.ok && result.replay) this.replays += 1;
    if (result.ok && !result.replay) {
      const body = result.stored.pe as unknown as Record<string, unknown>;
      this.bodies.push(body);
      this.entries.push({ body, key: result.stored.idempotency_key ?? null });
    }
    return result;
  }

  override async findByIdempotencyKey(key: string): Promise<import('./pe-store').StoredPe | null> {
    const hit = await super.findByIdempotencyKey(key);
    if (hit !== null) this.replays += 1;
    return hit;
  }
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export interface FakeTip {
  seq: number;
  batch_hash: string;
  last_pe_hash: string;
  accepted_at_ms: number | null;
  receipt: MeterBatchReceiptWire | null;
}

type Scripted = (req: FakeRequest) => { status: number; body: unknown } | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export class FakeMeterRelay {
  readonly requests: FakeRequest[] = [];
  readonly accepted: PeBatch[] = [];
  tip: FakeTip = { seq: 0, batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH, accepted_at_ms: null, receipt: null };
  sealTargets: unknown[] = [];
  proofs: unknown[] = [];
  mailbox: Record<string, unknown>[] = [];
  /** `POST /v1/meter/batch-proofs` answers by batch hash (absent → listed as missing). */
  batchRecords: Record<string, unknown> = {};
  /** One-off answers, consulted in order before the relay's own rules (a returned null passes). */
  readonly script: Scripted[] = [];
  /** Per-act receipt notes by act index for the NEXT accepted batch only (e.g. `lineage_rejected:…`). */
  notes: Record<number, string> = {};
  /** When false, every request fails as a transport error (offline). */
  online = true;
  now = 1_790_000_000_000;

  constructor(readonly deviceId: string = TEST_DEVICE_ID, readonly actorId: string = TEST_ACTOR_ID) {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k] = v;
    }
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    this.requests.push(req);
    if (!this.online) throw new TypeError('fetch failed');
    // The first scripted entry that answers this request is consumed; entries that pass stay.
    for (let i = 0; i < this.script.length; i++) {
      const answer = this.script[i](req);
      if (answer !== null) {
        this.script.splice(i, 1);
        return json(answer.status, answer.body);
      }
    }
    const response = this.answer(req);
    if (this.loseNextBatchAnswer && req.path === '/v1/meter/batch') {
      // The relay committed the batch; the answer never reached the device (a crash, a reset).
      this.loseNextBatchAnswer = false;
      throw new TypeError('socket hang up');
    }
    return response;
  };

  /** The next batch is processed by the relay but its answer is lost on the way back. */
  loseNextBatchAnswer = false;

  batchPosts(): FakeRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/meter/batch');
  }

  private answer(req: FakeRequest): Response {
    const auth=req.headers.Authorization??req.headers.authorization??"";
    const credential=auth.startsWith("DeviceKey ")?auth.slice(10):(req.headers["X-Provian-Privacy-Credential"]??"");
    const secret=credential.includes(":")?credential.slice(credential.indexOf(":")+1):undefined;
    const originalUrl=req.path;const opened={body:req.body?JSON.parse(req.body):undefined,query:Object.fromEntries(new URL("http://x"+req.path).searchParams),originalUrl};
    openPrivateAuthenticatedRequest(opened,secret);
    req={...req,body:opened.body?JSON.stringify(opened.body):null,path:originalUrl.split("?")[0]+(Object.keys(opened.query).length?"?"+new URLSearchParams(opened.query).toString():"")};
    if (req.method === 'GET' && req.path === '/v1/meter/tip') {
      return json(200, { device_id: this.deviceId, seq: this.tip.seq, batch_hash: this.tip.batch_hash, last_pe_hash: this.tip.last_pe_hash, accepted_at_ms: this.tip.accepted_at_ms });
    }
    if (req.method === 'GET' && req.path === '/v1/meter/seal-targets') return json(200, { targets: this.sealTargets });
    if (req.method === 'GET' && req.path.startsWith('/v1/meter/proofs')) {
      const after = Number(new URL(`http://x${req.path}`).searchParams.get('after_seq') ?? 0);
      const proofs = (this.proofs as { seq: number }[]).filter((p) => p.seq > after);
      return json(200, { proofs, next_after_seq: proofs.length > 0 ? proofs[proofs.length - 1].seq : null });
    }
    if (req.method === 'GET' && req.path.startsWith('/v1/meter/mailbox')) return json(200, { items: this.mailbox, next: null });
    if (req.method === 'POST' && req.path === '/v1/meter/mailbox/ack') {
      const ids = (JSON.parse(req.body ?? '{}') as { ids?: string[] }).ids ?? [];
      const before = this.mailbox.length;
      this.mailbox = this.mailbox.filter((m) => !ids.includes(String(m.id)));
      return json(200, { dropped: before - this.mailbox.length });
    }
    if (req.method === 'POST' && req.path === '/v1/meter/batch-proofs') {
      const hashes = (JSON.parse(req.body ?? '{}') as { batch_hashes?: string[] }).batch_hashes ?? [];
      return json(200, { batches: hashes.filter((h) => this.batchRecords[h] !== undefined).map((h) => this.batchRecords[h]), missing: hashes.filter((h) => this.batchRecords[h] === undefined) });
    }
    if (req.method === 'POST' && req.path === '/v1/meter/batch') return this.ingest(req);
    return json(404, { error: 'not_found' });
  }

  private ingest(req: FakeRequest): Response {
    const auth=req.headers.Authorization??req.headers.authorization??'';
    const credential=auth.startsWith('DeviceKey ')?auth.slice(10):(req.headers['X-Provian-Privacy-Credential']??'');
    const secret=credential.includes(':')?credential.slice(credential.indexOf(':')+1):undefined;
    const shape = validateBatchShape(unwrapPrivateBatch(JSON.parse(req.body ?? 'null'),secret).batch);
    if (!shape.ok) return json(400, { error: 'batch_invalid', code: shape.error });
    const batch = shape.batch;
    if (batch.device_id !== this.deviceId) return json(403, { error: 'batch_device_mismatch' });
    const hash = batchHashOf(batch);
    if (this.tip.receipt !== null && this.tip.batch_hash === hash) return json(200, this.tip.receipt);
    if (batch.seq !== this.tip.seq + 1 || batch.prev_batch_hash !== this.tip.batch_hash) {
      return json(409, {
        error: batch.seq <= this.tip.seq ? 'batch_replay' : 'batch_chain_broken',
        expected_seq: this.tip.seq + 1, expected_prev_batch_hash: this.tip.batch_hash, last_pe_hash: this.tip.last_pe_hash,
      });
    }
    const chain = verifyActChain(this.tip.last_pe_hash, batch.acts);
    if (!chain.ok) return json(409, { error: 'act_chain_broken', act_index: chain.index, last_pe_hash: this.tip.last_pe_hash });
    const receipt: MeterBatchReceiptWire = {
      schema: 'provian.pe-batch-receipt.v1',
      device_id: batch.device_id,
      actor_id: this.actorId,
      seq: batch.seq,
      batch_hash: hash,
      acts_root: batch.acts_root,
      batch_leaf: batchLeafOf({ device_id: batch.device_id, actor_id: this.actorId, seq: batch.seq, batch_hash: hash, acts_root: batch.acts_root }),
      accepted_at_ms: this.now,
      acts: batch.acts.map((a, i) => ({
        pe_id: a.pe_id, pe_hash: a.pe_hash, relay_pe_id: `pe_m_${a.pe_hash.slice(0, 48)}`, leaf_index: i,
        disposition: 'eligible', reason: 'eligible', ...(this.notes[i] ? { note: this.notes[i] } : {}),
        record_points_atomic: '1000', mint_status: 'eligible',
      })),
      totals: { eligible_points_atomic: String(1000 * batch.acts.length), acts: batch.acts.length, eligible: batch.acts.length },
    };
    this.notes = {};
    this.tip = { seq: batch.seq, batch_hash: hash, last_pe_hash: batch.acts[batch.acts.length - 1].pe_hash, accepted_at_ms: this.now, receipt };
    this.accepted.push(batch);
    return json(201, receipt);
  }
}
