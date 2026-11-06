import { Firestore } from 'firebase-admin/firestore';
import { randomUUID, createHash } from 'crypto';
import { privateFirestore } from './private-store';
import { buildMeterKeyPages, meterKeyPointer, METER_KEY_PAGES } from '../meter/meter-key-pages';
import type { MeterActKeyDoc } from '../meter/meter-act-key';

jest.setTimeout(120_000);
const suite = /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ? describe : describe.skip;
type Stream = { emit: (event: string | symbol, ...args: unknown[]) => boolean };
type StreamFn = (method: string, bidi: unknown, request: unknown, ...rest: unknown[]) => Promise<Stream>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A commit lookup over act keys (`row.commit_sha`) cannot be pushed to Firestore, so it scans every
 * key and resolves each key's packed page. The page reads of one scan chunk must overlap: one
 * awaited round trip per page made the GitHub push worker spend ~20 s on two such lookups.
 */
suite('act-key scans resolve their packed pages concurrently, each exactly once', () => {
  let raw: Firestore, db: Firestore, restore: () => void;
  const secret = process.env.RELAY_SIGNING_KEY, actor = 'public-prefetch-actor';
  let counting = false, inFlight = 0, maxInFlight = 0;
  const pageReads = new Map<string, number>();

  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-prefetch-emulator-key';
    raw = new Firestore({ projectId: 'demo-prefetch', databaseId: 'prefetch-' + randomUUID().slice(0, 8), ignoreUndefinedProperties: true });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true });
    db = privateFirestore(raw);
    const proto = Object.getPrototypeOf(raw) as { requestStream: StreamFn }, original = proto.requestStream;
    proto.requestStream = async function (method, bidi, request, ...rest) {
      const docs = (request as { documents?: unknown }).documents;
      const pageRead = counting && method === 'batchGetDocuments' && Array.isArray(docs) && docs.some(n => String(n).includes('/' + METER_KEY_PAGES + '/'));
      if (pageRead) { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); for (const n of docs as string[]) pageReads.set(n, (pageReads.get(n) ?? 0) + 1); }
      const stream = await original.call(this, method, bidi, request, ...rest), emit = stream.emit.bind(stream);
      let open = pageRead;
      stream.emit = (event, ...args) => {
        if (open && (event === 'end' || event === 'error' || event === 'close')) { open = false; inFlight -= 1; }
        return emit(event, ...args);
      };
      return stream;
    };
    restore = () => { proto.requestStream = original; };
  });
  afterAll(async () => {
    restore(); await raw.terminate();
    if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret;
  });

  function key(tag: string, batch: string, commitSha: string): MeterActKeyDoc {
    const id = 'pe_m_' + hash(tag).slice(0, 48);
    return { schema: 'provian.meter-act-key.v1', relay_pe_id: id, client_pe_id: 'client_' + tag, pe_hash: hash(tag), prev_hash: 'genesis', device_id: 'device',
      batch_hash: batch, actor_id: actor, timestamp: 1_800_000_000_000, action_type: 'coding_session',
      row: { peId: id, mint_status: 'eligible', record_points_atomic: '1', economic_snapshot: { immutable: hash(tag) }, commit_sha: commitSha },
      legs: null, unit: 'window', held_reason: null, created_at_ms: 1_800_000_000_000,
      side: { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null }, beneficiary_id: null, expire_at: null } as MeterActKeyDoc;
  }

  it('returns exactly the matching keys, reads 60 pages once each, and overlaps the reads', async () => {
    const target = 'a'.repeat(40), expected: string[] = [];
    let pageCount = 0;
    for (let b = 0; b < 60; b += 1) {
      const batch = hash('batch-' + b), keys = [0, 1, 2].map(k => key(`k-${b}-${k}`, batch, b % 15 === 0 && k === 1 ? target : hash(`other-${b}-${k}`).slice(0, 40)));
      for (const value of keys) if (value.row.commit_sha === target) expected.push(value.relay_pe_id);
      const writer = db.batch();
      for (const { id, page } of buildMeterKeyPages(batch, actor, keys)) {
        pageCount += 1;
        writer.create(db.collection(METER_KEY_PAGES).doc(id), page);
        for (const value of Object.values(page.keys)) writer.create(db.collection('meter_act_keys_v1').doc(value.relay_pe_id), meterKeyPointer(value, id));
      }
      await writer.commit();
    }
    expect(pageCount).toBe(60);
    expect(expected).toHaveLength(4);

    pageReads.clear(); maxInFlight = 0; counting = true;
    let found: string[];
    try {
      found = (await db.collection('meter_act_keys_v1').where('row.commit_sha', '==', target).get()).docs.map(d => d.id).sort();
    } finally { counting = false; }

    expect(found).toEqual([...expected].sort());
    expect(pageReads.size).toBe(60);
    expect([...pageReads.values()].every(n => n === 1)).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(32);
    const lockFree = maxInFlight;

    // Inside a caller's transaction reads take locks, so the scan stays one page at a time.
    pageReads.clear(); maxInFlight = 0; counting = true;
    let inTransaction: string[];
    try {
      inTransaction = await db.runTransaction(async tx =>
        (await tx.get(db.collection('meter_act_keys_v1').where('row.commit_sha', '==', target))).docs.map(d => d.id).sort());
    } finally { counting = false; }
    expect(inTransaction).toEqual([...expected].sort());
    expect(pageReads.size).toBe(60);
    expect(maxInFlight).toBe(1);
    console.log('[prefetch proof]', JSON.stringify({ pages: 60, lock_free_max_in_flight: lockFree, transactional_max_in_flight: maxInFlight, matches: found.length }));
  });
});
