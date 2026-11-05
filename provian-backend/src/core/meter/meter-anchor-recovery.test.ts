import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { anchorMeterSegment, anchorMeterDay, meterAnchorBatchId, runDailyMeterAnchor } from './meter-anchor';
import { METER_BATCHES_COLLECTION, METER_ANCHOR_DAYS_COLLECTION } from './meter-store';
import { PE_ANCHOR_ABI } from '../agent-bank/types';

// Port of Codex's anchor-recovery.cjs: real tree/ID code and query-aware Firestore double.
async function fixture(mode: 'clean' | 'partial' | 'new_batch' | 'broadcast' | 'wait' | 'selection' | 'latest_lag' | 'unseen') {
  const db = createFakeFirestore();
  const day = '2026-10-10';
  let now = Date.parse(day + 'T12:00:00Z');
  const roots = new Map<string, string>();
  const ids = ['a', 'b', 'c'].map(c => c.repeat(64));
  const add = async (i: number) => db.collection(METER_BATCHES_COLLECTION).doc(ids[i]).set({ day, batch_hash: ids[i], batch_leaf: String(i + 1).repeat(64), accepted_at_ms: now + i, anchored: false });
  await add(0); await add(1);
  let fail = mode !== 'clean';
  Object.assign(db, { bulkWriter: () => {
    const pending: { ref: ReturnType<ReturnType<typeof db.collection>['doc']>; data: Record<string, unknown> }[] = [];
    return {
      update(ref: ReturnType<ReturnType<typeof db.collection>['doc']>, data: Record<string, unknown>) { pending.push({ ref, data }); return Promise.resolve(); },
      async close() {
        if (fail && (mode === 'partial' || mode === 'new_batch')) {
          if (mode === 'partial') await pending[0].ref.update(pending[0].data);
          throw new Error('simulated process death during proof writeback');
        }
        for (const row of pending) await row.ref.update(row.data);
      },
    };
  } });
  const contract = {
    getBatch: jest.fn(async (id: string, overrides?: {blockTag?: number}) => {
      if (fail && roots.has(id) && (mode === 'broadcast' || mode === 'wait')) throw new Error('simulated process death');
      const visible = roots.has(id) && !(fail && (mode === 'unseen' || mode === 'latest_lag' && overrides?.blockTag === undefined));
      const iface = new ethers.Interface(PE_ANCHOR_ABI);
      return iface.decodeFunctionResult('getBatch', iface.encodeFunctionResult('getBatch', [visible ? roots.get(id) : ethers.ZeroHash, visible ? 2 : 0, 1, 1, visible]));
    }),
    anchorBatch: jest.fn(async (id: string, root: string) => {
      if (fail && mode === 'selection') throw new Error('simulated process death before broadcast');
      if (roots.has(id)) throw new Error('BatchAlreadyAnchored');
      roots.set(id, root);
      if (fail && mode === 'broadcast') throw new Error('simulated process death after broadcast');
      return { hash: '0x' + 'd'.repeat(64), wait: async () => {
        if (fail && mode === 'wait') throw new Error('simulated process death waiting');
        return { hash: '0x' + 'd'.repeat(64), blockNumber: 123 };
      } };
    }),
  };
  const deps = { db: db as unknown as Firestore, peAnchorContract: contract as unknown as ethers.Contract, now: () => now };
  return { db, roots, ids, contract, deps, day, add, recover() { fail = false; now += 31 * 60_000; }, tomorrow() { now += 24 * 3_600_000; } };
}

describe('durable meter anchor recovery (Codex 2026-10-10)', () => {
  it('daily run refuses unfinished confirmation, then publishes the frozen proofs within a minute without rebroadcast',async()=>{
    const f=await fixture('unseen'); f.tomorrow();
    const log=jest.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const first=await runDailyMeterAnchor(f.deps);
      expect(first).toMatchObject({complete:false,watermark:null,processed:[{status:'in_flight',detail:'post_broadcast_root_not_readable',batch_count:2,proofs_written:0}]});
      expect(log).toHaveBeenCalledWith('[meter-anchor] in_flight',expect.stringContaining('post_broadcast_root_not_readable'));
      const frozen=(await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).get()).data()?.selection as {root:string};
      expect(frozen).toMatchObject({count:2,tx_hash:'0x'+'d'.repeat(64)});
      // The cleared lease permits retry immediately, without waiting for the daily cron.
      f.contract.getBatch.mockImplementation(async id=>{const iface=new ethers.Interface(PE_ANCHOR_ABI);return iface.decodeFunctionResult('getBatch',iface.encodeFunctionResult('getBatch',[f.roots.get(id)??ethers.ZeroHash,2,1,1,f.roots.has(id)]));});
      const retry=await runDailyMeterAnchor(f.deps);
      expect(retry).toMatchObject({complete:true,watermark:f.day});
      expect(retry.processed[0]).toMatchObject({status:'already_anchored',proofs_written:2,merkle_root:frozen.root});
      expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
      for(const id of f.ids.slice(0,2))expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(id).get()).data()?.anchor).toMatchObject({merkle_root:frozen.root,leaf_count:2});
    } finally { log.mockRestore(); }
  });

  it('retains anchored batch economics while settlement or a sealed copy remains outstanding', async () => {
    const f = await fixture('clean');
    await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[0]).update({ per_batch_pricing: true, economic_settled: false, settlement_complete: false });
    await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[1]).update({ per_batch_pricing: true, economic_settled: true, settlement_complete: true });
    await f.db.collection('pe_mailbox_v1').doc('waiting').set({ batch_hash: f.ids[1], items: [{ box: 'ciphertext' }] });
    expect((await anchorMeterSegment(f.deps)).status).toBe('anchored');
    for (const id of f.ids.slice(0, 2)) {
      const batch = (await f.db.collection(METER_BATCHES_COLLECTION).doc(id).get()).data();
      expect(batch?.anchored).toBe(true); expect(batch?.expire_at).toBeNull();
    }
    expect(f.roots.size).toBe(1); expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
  });
  it('proves a landed transaction at its receipt block when latest RPC reads still lag', async () => {
    const f = await fixture('latest_lag');
    expect(await anchorMeterSegment(f.deps)).toMatchObject({status:'anchored',batch_count:2,proofs_written:2});
    expect(f.contract.getBatch).toHaveBeenCalledWith(meterAnchorBatchId(f.day,1),{blockTag:123});
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
  });

  it('retains an unseen confirmation for immediate exact-set retry without rebroadcast', async () => {
    const f = await fixture('unseen');
    expect(await anchorMeterSegment(f.deps)).toMatchObject({status:'in_flight',batch_count:2});
    const data=(await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).get()).data();
    expect(data?.lease_token).toBeNull();
    expect(data?.selection).toMatchObject({count:2,tx_hash:'0x'+'d'.repeat(64)});
    await f.add(2);f.recover();
    expect(await anchorMeterSegment(f.deps)).toMatchObject({status:'anchored',batch_count:2,proofs_written:2});
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[2]).get()).data()?.anchored).toBe(false);
  });

  it('does not rebroadcast a known transaction whose receipt is not visible yet', async () => {
    const f = await fixture('unseen');
    await anchorMeterSegment(f.deps);
    Object.assign(f.contract,{runner:{provider:{getTransactionReceipt:jest.fn(async()=>null)}}});
    await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).update({lease_at_ms:null,lease_token:null});
    expect((await anchorMeterSegment(f.deps)).status).toBe('in_flight');
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
  });

  it('does not rebroadcast a known transaction when its provider is unavailable', async () => {
    const f = await fixture('unseen');
    await anchorMeterSegment(f.deps);
    await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).update({lease_at_ms:null,lease_token:null});
    expect((await anchorMeterSegment(f.deps)).status).toBe('in_flight');
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
  });

  it('recovers a known confirmed transaction at its receipt block after an unavailable latest read', async () => {
    const f = await fixture('unseen');
    await anchorMeterSegment(f.deps);
    Object.assign(f.contract,{runner:{provider:{getTransactionReceipt:jest.fn(async()=>({status:1,blockNumber:123}))}}});
    f.contract.getBatch.mockImplementation(async (id, overrides) => {
      if (overrides?.blockTag === undefined) throw new Error('latest RPC unavailable');
      const iface = new ethers.Interface(PE_ANCHOR_ABI);
      return iface.decodeFunctionResult('getBatch', iface.encodeFunctionResult('getBatch', [f.roots.get(id),2,1,1,true]));
    });
    await f.add(2);
    expect(await anchorMeterSegment(f.deps)).toMatchObject({status:'anchored',batch_count:2,proofs_written:2});
    expect(f.contract.getBatch).toHaveBeenCalledWith(meterAnchorBatchId(f.day,1),{blockTag:123});
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[2]).get()).data()?.anchored).toBe(false);
  });

  it('blocks a broadcast when the initial chain read is unavailable', async () => {
    const f=await fixture('clean');f.contract.getBatch.mockRejectedValue(new Error('RPC unavailable'));
    expect((await anchorMeterSegment(f.deps)).status).toBe('in_flight');
    expect(f.contract.anchorBatch).not.toHaveBeenCalled();
    expect((await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).get()).data()?.selection).toMatchObject({count:2});
  });
  it.each(['partial', 'new_batch', 'broadcast', 'wait', 'selection'] as const)('recovers the exact selection after %s process death and later arrivals', async mode => {
    const f = await fixture(mode);
    await anchorMeterSegment(f.deps).catch(e => expect(e.message).toMatch(/simulated process death/));
    await f.add(2);
    f.recover();
    const r = await anchorMeterSegment(f.deps);
    expect(r).toMatchObject({ status: 'anchored', segment: 1, batch_count: 2 });
    expect(f.roots.size).toBe(1);
    for (const id of f.ids.slice(0, 2)) {
      expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(id).get()).data()?.anchor).toMatchObject({ anchor_batch_id: meterAnchorBatchId(f.day, 1), leaf_count: 2 });
    }
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[2]).get()).data()?.anchored).toBe(false);
    const next = await anchorMeterSegment(f.deps);
    expect(next).toMatchObject({ status: 'anchored', segment: 2, batch_count: 1 });
    expect(f.roots.size).toBe(2);
    expect((await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).get()).data()?.segments).toBe(2);
  });

  it('clean control: later batches get a distinct segment, and close never anchors them again', async () => {
    const f = await fixture('clean');
    expect((await anchorMeterSegment(f.deps)).batch_count).toBe(2);
    await f.add(2);
    expect((await anchorMeterSegment(f.deps)).segment).toBe(2);
    f.tomorrow();
    expect((await anchorMeterDay(f.deps, f.day)).status).toBe('empty');
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(2);
  });

  it('daily close repairs a stranded segment before selecting the remainder', async () => {
    const f = await fixture('partial');
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('simulated process death');
    await f.add(2); f.recover(); f.tomorrow();
    expect((await anchorMeterDay(f.deps, f.day)).batch_count).toBe(1);
    expect(f.roots.size).toBe(2);
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[0]).get()).data()?.anchor).toMatchObject({ segment: 1 });
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[2]).get()).data()?.anchor).not.toHaveProperty('segment');
    expect((await anchorMeterDay(f.deps, f.day)).status).toBe('already_anchored');
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(2);
  });

  it('partial proof writeback survives an outage longer than the proof TTL', async () => {
    const f = await fixture('partial');
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('simulated process death');
    const first = f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[0]);
    // Synthetic Firestore TTL sweep: the violating pre-fix expiry would delete this record.
    expect((await first.get()).data()?.expire_at).toBeNull();
    for (let day = 0; day < 32; day++) f.tomorrow();
    f.recover();
    const repaired = await anchorMeterDay(f.deps, f.day);
    expect(repaired.status).toBe('empty');
    expect((await first.get()).data()?.anchor).toMatchObject({ segment: 1, leaf_count: 2 });
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
    expect((await first.get()).data()?.expire_at).not.toBeNull();
  });

  it('RED control: a genuinely different on-chain root refuses proof publication', async () => {
    const f = await fixture('clean');
    f.roots.set(meterAnchorBatchId(f.day, 1), '0x' + 'f'.repeat(64));
    expect((await anchorMeterSegment(f.deps)).status).toBe('root_mismatch');
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[0]).get()).data()?.anchored).toBe(false);
  });
});

describe('missing frozen members require exact deletion receipts', () => {
  it('refuses an unexplained missing batch after a partial on-chain completion', async () => {
    const f = await fixture('partial');
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('simulated process death');
    await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[1]).delete();
    f.recover();
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('missing_batch_without_purge_receipt');
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
    expect((await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day).get()).data()?.selection).toMatchObject({count:2});
  });
  it('accounts for a verified purge without recreating a batch, changing the root, or rebroadcasting', async () => {
    const f = await fixture('partial');
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('simulated process death');
    const dayRef = f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(f.day);
    const frozen = (await dayRef.get()).data()?.selection as {root:string;id:string};
    await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[1]).delete();
    const {METER_PURGED_BATCHES_COLLECTION} = await import('./meter-anchor');
    const receipt = {batch_hash:f.ids[1],batch_leaf:'2'.repeat(64),day:f.day,anchor_batch_id:meterAnchorBatchId(f.day,1),evidence_sha256:'e'.repeat(64),purged_at_ms:1,reason:'verified_operator_purge'};
    await f.db.collection(METER_PURGED_BATCHES_COLLECTION).doc(f.ids[1]).set({...receipt,batch_leaf:'f'.repeat(64)});
    f.recover();
    await expect(anchorMeterSegment(f.deps)).rejects.toThrow('missing_batch_without_purge_receipt');
    await f.db.collection(METER_PURGED_BATCHES_COLLECTION).doc(f.ids[1]).set(receipt);
    f.recover();
    expect(await anchorMeterSegment(f.deps)).toMatchObject({status:'anchored',batch_count:2,proofs_written:1,purged_members:1,merkle_root:frozen.root});
    expect((await f.db.collection(METER_BATCHES_COLLECTION).doc(f.ids[1]).get()).exists).toBe(false);
    expect((await dayRef.collection('purged_members').doc(f.ids[1]).get()).data()).toMatchObject({leaf_index:1,leaf_count:2,merkle_root:frozen.root,evidence_sha256:'e'.repeat(64)});
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
    f.recover();
    expect((await anchorMeterSegment(f.deps)).status).toBe('empty');
    expect((await dayRef.collection('selections').doc(frozen.id+'_0').get()).exists).toBe(true);
    f.tomorrow();
    expect((await anchorMeterDay(f.deps,f.day)).status).toBe('empty');
    expect((await dayRef.collection('selections').doc(frozen.id+'_0').get()).exists).toBe(true);
    expect(f.contract.anchorBatch).toHaveBeenCalledTimes(1);
  });
});
