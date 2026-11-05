import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { MemoryCloudFiles } from '../cloudFiles';
import { MemoryMeterFiles } from '../meterFiles';
import { PeCloudBackup, deriveArchiveKey, PE_BACKUP_MANIFEST_PREFIX } from '../peCloudBackup';
import { openStore, recordPes, FakeRelay } from './meterTestkit';
import { PhoneBatcher } from '../phoneBatcher';
import { phonePeFact } from '../phoneProve';

const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const salt = 'ab'.repeat(16);
async function keeper(store: import('../phonePeStore').PhonePeStore, cloud: MemoryCloudFiles) {
  const key = await deriveArchiveKey(mnemonic, salt);
  return new PeCloudBackup({store, cloud, randomBytes, keys: {
    current: async () => ({key, saltHex: salt}),
    forSalt: async s => deriveArchiveKey(mnemonic, s),
    adopt: async () => {},
  }});
}

describe('backup recovery regressions from the 2026-10-10 Codex check', () => {
  it('preserves the last committed backup if the next index write fails', async () => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    await recordPes(a.store, 2);
    const cloud = new MemoryCloudFiles();
    const backup = await keeper(a.store, cloud);
    expect((await backup.backup()).ok).toBe(true);
    await recordPes(a.store, 1);
    cloud.failWritesMatching = new RegExp(`^(?:pe_index$|${PE_BACKUP_MANIFEST_PREFIX})`);
    expect((await backup.backup()).ok).toBe(false);
    const recovered = await openStore(new MemoryMeterFiles(), 'replacement_phone');
    const report = await (await keeper(recovered.store, cloud)).restore();
    expect(report.refusedFiles).toEqual([]);
    expect(report.devices.find(d => d.deviceId === 'phone_a')?.pes).toBe(2);
  });

  it('keeps both successful simultaneous device backups reachable from the index', async () => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    const b = await openStore(new MemoryMeterFiles(), 'phone_b');
    await recordPes(a.store, 2);
    await recordPes(b.store, 3);
    const cloud = new MemoryCloudFiles();
    const ka = await keeper(a.store, cloud);
    const kb = await keeper(b.store, cloud);
    const results = await Promise.all([ka.backup(), kb.backup()]);
    expect(results.every(r => r.ok)).toBe(true);
    const recovered = await openStore(new MemoryMeterFiles(), 'replacement_phone');
    const report = await (await keeper(recovered.store, cloud)).restore();
    expect(report.devices.map(d => d.deviceId).sort()).toEqual(['phone_a', 'phone_b']);
  });

  it('restores a good snapshot despite a later manifest or object download failure', async () => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    await recordPes(a.store, 2);
    const cloud = new MemoryCloudFiles();
    expect((await (await keeper(a.store, cloud)).backup()).ok).toBe(true);
    await recordPes(a.store, 1);
    const previous = new Set(cloud.files.keys());
    expect((await (await keeper(a.store, cloud)).backup()).ok).toBe(true);
    const newer = new Set([...cloud.files.keys()].filter(name => !previous.has(name)));
    const read = cloud.read.bind(cloud);
    // A native iCloud placeholder download may throw, rather than return null.
    cloud.read = async name => { if (newer.has(name)) throw new Error('ICLOUD_DOWNLOAD_TIMEOUT'); return read(name); };
    const recovered = await openStore(new MemoryMeterFiles(), 'replacement_phone');
    const report = await (await keeper(recovered.store, cloud)).restore();
    expect(report.devices.find(d => d.deviceId === 'phone_a')?.pes).toBe(2);
    expect(report.refusedFiles.length).toBeGreaterThan(0);
  });

  it('does not replace another device newer backup with an older restored chain', async () => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    await recordPes(a.store, 1);
    const cloud = new MemoryCloudFiles();
    const ka = await keeper(a.store, cloud);
    expect((await ka.backup()).ok).toBe(true);
    const b = await openStore(new MemoryMeterFiles(), 'phone_b');
    const kb = await keeper(b.store, cloud);
    await kb.restore();
    await recordPes(a.store, 1);
    expect((await ka.backup()).ok).toBe(true);
    expect((await kb.backup()).ok).toBe(true);
    const recovered = await openStore(new MemoryMeterFiles(), 'replacement_phone');
    const report = await (await keeper(recovered.store, cloud)).restore();
    expect(report.devices.find(d => d.deviceId === 'phone_a')?.pes).toBe(2);
  });

  it.each([false, true])('keeps complete batch/proof records over reconstructed metadata (reverse listing=%s)', async reverse => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    const [pe] = await recordPes(a.store, 1);
    await new PhoneBatcher({ store: a.store, transport: new FakeRelay(), resendDelayMs: 0 }).flush();
    const [batch] = await a.store.own().listBatches();
    const [receipt] = await a.store.own().listReceipts();
    const proof: import('../phonePeStore').StoredBatchProof = { seq: batch.seq, batch_hash: batch.batch_hash, batch_leaf: receipt.batch_leaf, acts_root: batch.acts_root!, actor_id: batch.actor_id!, chain_id: 8453, anchor_contract: '0x'+'1'.repeat(40), anchor: { day:'2026-10-10',anchor_batch_id:'0x'+'a'.repeat(64),leaf_index:0,leaf_count:1,leaf_hash:receipt.batch_leaf,proof:[],merkle_root:receipt.batch_leaf,anchor_tx_hash:'0x'+'b'.repeat(64) }, fetched_at_ms: 1, verified: true };
    await a.store.own().recordProof(proof);
    expect((await phonePeFact(a.store, pe.pe_id, null)).ok).toBe(true);
    const cloud = new MemoryCloudFiles();
    expect((await (await keeper(a.store, cloud)).backup()).ok).toBe(true);
    const b = await openStore(new MemoryMeterFiles(), 'phone_b');
    const foreign = await b.store.chain('phone_a');
    await foreign.importPes(await a.store.own().allPes());
    await foreign.recordBatch({ ...batch, adopted: true, acts_root: null, actor_id: null, totals: null, created_at_ms: null, accepted_at_ms: null }, null);
    await foreign.recordProof({ ...proof, fetched_at_ms: 2, verified: false });
    expect((await phonePeFact(b.store, pe.pe_id, null)).ok).toBe(false); // incomplete control
    expect((await (await keeper(b.store, cloud)).backup()).ok).toBe(true);
    cloud.list = async () => reverse ? [...cloud.files.keys()].reverse() : [...cloud.files.keys()];
    for (const target of [b.store, (await openStore(new MemoryMeterFiles(), 'replacement')).store]) {
      expect((await (await keeper(target, cloud)).restore()).refusedFiles).toEqual([]);
      expect((await phonePeFact(target, pe.pe_id, null)).ok).toBe(true);
      const repaired = await target.chain('phone_a');
      expect((await repaired.listProofs())[0].verified).toBe(true);
      expect(await repaired.readReceipt(batch.seq)).toEqual(receipt);
    }
    const repaired = await b.store.chain('phone_a');
    await expect(repaired.importBatches([{batch:{...batch,batch_hash:'e'.repeat(64)},receipt:null}])).rejects.toThrow('conflicting batch');
  });

  it('keeps the highest batch tip after importing older recovered batches and reopening', async () => {
    const a = await openStore(new MemoryMeterFiles(), 'phone_a');
    const batcher = new PhoneBatcher({store: a.store, transport: new FakeRelay(), resendDelayMs: 0});
    for (let n = 0; n < 3; n++) { await recordPes(a.store, 1); await batcher.flush(); }
    const batches = await a.store.own().listBatches();
    const files = new MemoryMeterFiles();
    const b = await openStore(files, 'phone_b');
    const recovered = await b.store.chain('phone_a');
    await recovered.recordBatch({...batches[2], adopted: true, acts_root: null, actor_id: null}, null);
    await recovered.importBatches(batches.map(batch => ({batch, receipt: null})));
    expect((await recovered.lastBatch())?.seq).toBe(3);
    expect((await recovered.listBatches()).map(batch => batch.seq)).toEqual([1,2,3]);
    const reopened = await openStore(files, 'phone_b');
    expect((await (await reopened.store.chain('phone_a')).lastBatch())?.seq).toBe(3);
  });

  it.each(['batches', 'proofs'] as const)('serializes a background %s write with restore metadata replacement', async kind => {
    const files = new MemoryMeterFiles();
    const {store} = await openStore(files, 'phone_a');
    const chain = store.own();
    const batch = {seq:1, batch_hash:'a'.repeat(64), prev_batch_hash:'genesis', acts_root:'c'.repeat(64), first_index:0, count:1, last_pe_hash:'d'.repeat(64), created_at_ms:1, accepted_at_ms:2, actor_id:'human:test', totals:null};
    const proof: import('../phonePeStore').StoredBatchProof = {seq:1, batch_hash:batch.batch_hash, batch_leaf:'0x'+'b'.repeat(64), acts_root:batch.acts_root, actor_id:batch.actor_id, chain_id:8453, anchor_contract:'0x'+'1'.repeat(40), anchor:{day:'2026-10-10',anchor_batch_id:'0x'+'a'.repeat(64),leaf_index:0,leaf_count:1,leaf_hash:'0x'+'b'.repeat(64),proof:[],merkle_root:'0x'+'b'.repeat(64),anchor_tx_hash:null}, fetched_at_ms:1, verified:true};
    if (kind === 'batches') await chain.recordBatch({...batch,adopted:true,acts_root:null,actor_id:null},null);
    else await chain.recordProof({...proof,verified:false});
    let reached!: () => void, resume!: () => void;
    const atWrite = new Promise<void>(resolve => {reached=resolve;});
    const gate = new Promise<void>(resolve => {resume=resolve;});
    const write = files.writeAtomic.bind(files);
    let blocked = false;
    files.writeAtomic = async (path,text) => {
      if (!blocked && path.includes(`/${kind}/`)) {blocked=true;reached();await gate;}
      await write(path,text);
    };
    const restoring = kind === 'batches' ? chain.importBatches([{batch,receipt:null}]) : chain.importProofs([proof]);
    await atWrite;
    let accepted = false;
    const append = (kind === 'batches'
      ? chain.recordBatch({...batch,seq:2,batch_hash:'e'.repeat(64)},null)
      : chain.recordProof({...proof,seq:2,batch_hash:'e'.repeat(64)})).then(() => {accepted=true;});
    await Promise.resolve(); await Promise.resolve();
    expect(accepted).toBe(false); // the violating concurrent replacement must remain blocked
    resume();
    await Promise.all([restoring,append]);
    const reopened = await openStore(files,'phone_a');
    const rows = kind === 'batches' ? await reopened.store.own().listBatches() : await reopened.store.own().listProofs();
    expect(rows.map(row => row.seq)).toEqual([1,2]);
    expect(accepted).toBe(true);
  });
});
