import { Firestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { randomUUID, createHash } from 'crypto';
import { privateFirestore, rawPrivateFirestore, decodePrivateRecord, privateStorageId, readPackedMeterKeyPages } from '../provenance/private-store';
import { buildMeterKeyPages, meterKeyPointer, METER_KEY_PAGES } from './meter-key-pages';
import type { MeterActKeyDoc } from './meter-act-key';
jest.setTimeout(60_000);
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('packed key pages preserve exact logical keys with atomic independent mutations', () => {
  let raw: Firestore, db: Firestore;
  const secret = process.env.RELAY_SIGNING_KEY, actor = 'public-page-actor';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-page-emulator-key';
    raw = new Firestore({ projectId: 'demo-packed-keys', databaseId: 'keys-' + randomUUID().slice(0, 8), ignoreUndefinedProperties: true });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true });
    db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  function key(tag: string, batch: string): MeterActKeyDoc {
    const id = 'pe_m_' + hash(tag).slice(0, 48);
    return { schema: 'provian.meter-act-key.v1', relay_pe_id: id, client_pe_id: 'client_' + tag, pe_hash: hash(tag), prev_hash: 'genesis', device_id: 'device',
      batch_hash: batch, actor_id: actor, timestamp: 1_800_000_000_000, action_type: 'coding_session', row: { peId: id, mint_status: 'eligible', record_points_atomic: '123456789', economic_snapshot: { immutable: hash(tag) } },
      legs: null, unit: 'window', held_reason: null, created_at_ms: 1_800_000_000_000, side: { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null }, beneficiary_id: null, expire_at: null };
  }
  async function seed(tag: string) {
    const batch = hash(tag), keys = [key(tag + 'a', batch), key(tag + 'b', batch), key(tag + 'c', batch)], pages = buildMeterKeyPages(batch, actor, keys), writer = db.batch();
    for (const { id, page } of pages) {
      writer.create(db.collection(METER_KEY_PAGES).doc(id), page);
      for (const value of Object.values(page.keys)) writer.create(db.collection('meter_act_keys_v1').doc(value.relay_pe_id), meterKeyPointer(value, id));
    }
    await writer.commit(); return { keys, pages };
  }
  it('returns byte-identical full logical keys through point and query reads while physical rows are only locators', async () => {
    const { keys } = await seed('read');
    for (const value of keys) {
      expect((await db.collection('meter_act_keys_v1').doc(value.relay_pe_id).get()).data()).toEqual(value);
      const physical = await raw.collection('meter_act_keys_v1').doc(privateStorageId('meter_act_keys_v1', value.relay_pe_id)).get();
      const pointer = decodePrivateRecord('meter_act_keys_v1', physical.id, physical.data()!, db).data;
      expect(pointer.row).toBeUndefined(); expect(pointer.side).toBeUndefined(); expect(typeof pointer._meter_key_page).toBe('string');
    }
    const queried = await db.collection('meter_act_keys_v1').where('batch_hash', '==', keys[0].batch_hash).get();
    expect(queried.docs.map(d => d.data()).sort((a, b) => a.relay_pe_id.localeCompare(b.relay_pe_id))).toEqual([...keys].sort((a, b) => a.relay_pe_id.localeCompare(b.relay_pe_id)));
  });
  it('reads one page and no per-key locator at settlement; coalesces independent key patches without losing siblings', async () => {
    const { keys, pages } = await seed('mutate');
    const reads: string[] = [], original = raw.runTransaction.bind(raw);
    const spy = jest.spyOn(raw, 'runTransaction').mockImplementation(((work: any, options: any) => original(async tx => work(new Proxy(tx, { get(target, prop) {
      if (prop === 'get') return (ref: any) => { if (typeof ref.path === 'string') reads.push(ref.path); return tx.get(ref); };
      const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
    } })), options)) as typeof raw.runTransaction);
    try {
      await db.runTransaction(async txn => {
        const values = await readPackedMeterKeyPages(db, txn, pages.map(p => p.id));
        for (const [id, value] of values) txn.update(value.ref, { 'row.mint_status': 'minted', 'row.settled_at': 99, expire_at: Timestamp.fromMillis(2_000_000_000_000) });
      });
    } finally { spy.mockRestore(); }
    expect(reads.filter(path => path.startsWith('meter_act_keys_v1/'))).toHaveLength(0);
    expect(reads.filter(path => path.startsWith(METER_KEY_PAGES + '/'))).toHaveLength(1);
    for (const value of keys) {
      const actual = (await db.collection('meter_act_keys_v1').doc(value.relay_pe_id).get()).data()!;
      expect(actual.row).toEqual({ ...value.row, mint_status: 'minted', settled_at: 99 });
      expect(actual.expire_at.toMillis()).toBe(2_000_000_000_000);
    }
    expect((await db.collection(METER_KEY_PAGES).doc(pages[0].id).get()).get('expire_at').toMillis()).toBe(2_000_000_000_000);
  });
  it('RED stale logical snapshot cannot overwrite a sibling mutation or commit its other writes', async () => {
    const { keys } = await seed('cas');
    const stale = await db.collection('meter_act_keys_v1').doc(keys[0].relay_pe_id).get();
    await db.collection('meter_act_keys_v1').doc(keys[1].relay_pe_id).update({ 'row.corroboration_status': 'corroborated' });
    const batch = db.batch(); batch.update(stale.ref, { 'row.mint_status': 'minted' }, { lastUpdateTime: stale.updateTime! }); batch.set(db.collection('test_marker').doc('must-not-commit'), { bad: true });
    await expect(batch.commit()).rejects.toMatchObject({ code: 9 });
    expect((await db.collection('test_marker').doc('must-not-commit').get()).exists).toBe(false);
    expect((await db.collection('meter_act_keys_v1').doc(keys[1].relay_pe_id).get()).get('row.corroboration_status')).toBe('corroborated');
    expect((await stale.ref.get()).get('row.mint_status')).toBe('eligible');
  });
  it('full replacement through a plain ref still updates its packed page and preserves its siblings', async () => {
    const { keys, pages } = await seed('replace'); const ref = db.collection('meter_act_keys_v1').doc(keys[0].relay_pe_id);
    await db.runTransaction(async tx => { const snap = await tx.get(ref); tx.set(ref, { ...snap.data(), held_reason: null, row: { ...snap.get('row'), promoted: true } }); });
    const page = (await db.collection(METER_KEY_PAGES).doc(pages[0].id).get()).data()!;
    expect(page.keys[keys[0].relay_pe_id].row.promoted).toBe(true); expect(page.keys[keys[1].relay_pe_id]).toEqual(keys[1]);
    const physical = await raw.collection('meter_act_keys_v1').doc(privateStorageId('meter_act_keys_v1', keys[0].relay_pe_id)).get();
    expect(decodePrivateRecord('meter_act_keys_v1', physical.id, physical.data()!, db).data.row).toBeUndefined();
  });
  it('RED mixed-version sibling snapshots cannot overwrite a newer corroboration in either mutation order', async () => {
    for (const reverse of [false, true]) {
      const { keys } = await seed('mixed-' + reverse), refs = keys.map(k => db.collection('meter_act_keys_v1').doc(k.relay_pe_id));
      const capture = async (index: number) => db.runTransaction(async tx => (await readPackedMeterKeyPages(db, tx, [keys[0].batch_hash + '~0'])).get(keys[index].relay_pe_id)!);
      const stale = await capture(1), staleAt = (await refs[1].get()).updateTime!; await refs[1].update({ 'row.corroboration_status': 'corroborated' }); const fresh = await capture(0), freshAt = (await refs[0].get()).updateTime!;
      const batch = db.batch(); for (const snap of reverse ? [stale, fresh] : [fresh, stale]) batch.update(snap.ref, { 'row.mint_status': 'minted' }, { lastUpdateTime: snap === stale ? staleAt : freshAt });
      batch.set(db.collection('test_marker').doc('mixed-' + reverse), { bad: true }); await expect(batch.commit()).rejects.toMatchObject({ code: 9 });
      expect((await refs[1].get()).get('row.corroboration_status')).toBe('corroborated'); expect((await db.collection('test_marker').doc('mixed-' + reverse).get()).exists).toBe(false);
    }
  });
  it('all-finite nonpaying pages receive the maximum member TTL immediately', async () => {
    const batch = hash('finite'), a = { ...key('finite-a', batch), expire_at: Timestamp.fromMillis(10) }, b = { ...key('finite-b', batch), expire_at: Timestamp.fromMillis(20) };
    const pages = buildMeterKeyPages(batch, actor, [a, b]); expect(pages[0].page.expire_at!.toMillis()).toBe(20);
    const indefinitelyHeld = buildMeterKeyPages(batch, actor, [a, key('finite-held', batch)]); expect(indefinitelyHeld[0].page.expire_at).toBeNull();
    const ref = db.collection(METER_KEY_PAGES).doc(pages[0].id); await ref.create(pages[0].page);
    const physical = await raw.collection(METER_KEY_PAGES).doc(privateStorageId(METER_KEY_PAGES, pages[0].id)).get();
    expect(physical.get('expire_at').toMillis()).toBe(20); await physical.ref.delete(); expect((await ref.get()).exists).toBe(false);
  });
  it('RED missing page refuses the logical key instead of fabricating an empty or record-only result', async () => {
    const { keys, pages } = await seed('missing');
    await raw.collection(METER_KEY_PAGES).doc(privateStorageId(METER_KEY_PAGES, pages[0].id)).delete();
    await expect(db.collection('meter_act_keys_v1').doc(keys[0].relay_pe_id).get()).rejects.toThrow('meter_key_page_missing');
  });
  it('converter-generated transforms and native references retain their original Firestore semantics', async () => {
    const ref = db.collection('meter_act_keys_v1').doc('plain-transform'); await ref.set({ count: 10 });
    await ref.withConverter({ toFirestore: () => ({ count: FieldValue.increment(1) }), fromFirestore: snap => snap.data() }).set({});
    expect((await ref.get()).get('count')).toBe(11); // RED against the earlier pre-converter fast-set defect
    const pointer = rawPrivateFirestore(db).collection('test_marker').doc('native-ref');
    await ref.set({ pointer });
    expect((await ref.get()).get('pointer').path).toBe(pointer.path); // RED against recursive native-object traversal
  });
});
