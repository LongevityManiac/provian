import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { MemoryCloudFiles } from '../cloudFiles';
import { MemoryArchiveObjectCache } from '../archiveObjectCache';
import { PeCloudBackup, deriveArchiveKey, decryptFile } from '../peCloudBackup';
import { openStore, recordPes, FakeRelay } from './meterTestkit';
import { PhoneBatcher } from '../phoneBatcher';
import { phonePeFact } from '../phoneProve';
import { PhoneArchiveKeeper, type PhoneArchiveTransport } from '../phoneArchive';
import { buildArchiveEntries, sealArchivePart, bytesToB64u } from '../pe-archive-wire';
import { anchoredLeafOf, meterAnchorBatchIdOf, PE_EXPORT_PE_ANCHOR, verifyExportOffline, preflightPresentationProofs } from '../pe-export-wire';
import type { ActInclusionProof, PeV2 } from '../meter-wire';
import type { StoredBatchProof } from '../phonePeStore';

const noArchive: PhoneArchiveTransport = {
    getStatus: async () => ({ status: 503, body: null, error: 'offline' }),
    uploadPart: async () => ({ status: 503, body: null, error: 'offline' }),
    listDays: async () => ({ status: 200, body: { days: [] }, error: null }),
    listLinkedDays: async () => ({ status: 200, body: { days: [] }, error: null }),
    getDayObject: async () => ({ status: 404, text: null }),
};

function verify(pe: PeV2 & { pe_hash: string }, inclusion: ActInclusionProof) {
    return verifyExportOffline([{ type: 'received', source: 'archive', mailbox_id: null,
        from_actor: inclusion.batch.actor_id, from_device: pe.device_id,
        batch_hash: inclusion.batch.batch_hash, received_at_ms: null, pe, status: 'anchored', inclusion }]);
}

async function fixture(segment?: number) {
    const { store } = await openStore();
    const [pe] = await recordPes(store, 1);
    await new PhoneBatcher({ store, transport: new FakeRelay(), resendDelayMs: 0 }).flush();
    const [batch] = await store.own().listBatches();
    const [receipt] = await store.own().listReceipts();
    const day = new Date(receipt.accepted_at_ms).toISOString().slice(0, 10);
    const root = anchoredLeafOf(receipt.batch_leaf);
    const proof: StoredBatchProof = { seq: batch.seq, batch_hash: batch.batch_hash,
        batch_leaf: receipt.batch_leaf, acts_root: batch.acts_root!, actor_id: batch.actor_id!,
        chain_id: 8453, anchor_contract: PE_EXPORT_PE_ANCHOR,
        anchor: { day, ...(segment !== undefined ? { segment } : {}),
            anchor_batch_id: meterAnchorBatchIdOf(day, segment), leaf_index: 0, leaf_count: 1,
            leaf_hash: root, proof: [], merkle_root: root, anchor_tx_hash: '0x' + 'a'.repeat(64) },
        fetched_at_ms: 1, verified: true };
    await store.own().recordProof(proof);
    return { store, pe, batch, receipt, proof, day };
}

describe('anchor segment and recovery verification', () => {
    it.each([undefined, 1, 2])('presents an anchored PE with segment %s', async segment => {
        const f = await fixture(segment);
        const result = await phonePeFact(f.store, f.pe.pe_id, f.pe.pe_hash);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(result.fact.inclusion.anchor?.segment).toBe(segment);
        expect(verify(f.pe, result.fact.inclusion).failures).toEqual([]);
        // A wrong segment is constructible and must fail even though the Merkle path is valid.
        const bad = { ...result.fact.inclusion, anchor: { ...result.fact.inclusion.anchor!, segment: 99 } };
        expect(verify(f.pe, bad).failures[0]?.reason).toBe('anchor_batch_id_mismatch');
    });

    it('keeps the segment in Archive headers and encrypted-payload inclusion proofs', async () => {
        const f = await fixture(1);
        const keeper = new PhoneArchiveKeeper({ store: f.store, transport: noArchive, messageSecretKey: async () => null });
        const days = await keeper.readyDays(f.store.own());
        expect(days).toHaveLength(1);
        const built = buildArchiveEntries(f.day, days[0].batches, PE_EXPORT_PE_ANCHOR);
        expect(built.refs[0].anchor.segment).toBe(1);
        expect(verify(f.pe, built.entries[0].inclusion).failures).toEqual([]);
    });

    it('revalidates a retained proof after complete batch metadata is restored', async () => {
        const f = await fixture();
        const target = await openStore(undefined, f.store.own().deviceId);
        const chain = target.store.own();
        await chain.importPes(await f.store.own().allPes());
        await chain.recordBatch({ ...f.batch, adopted: true, acts_root: null, actor_id: null }, null);
        const relay = new FakeRelay();
        relay.proofs = [{ ...f.proof }];
        const batcher = new PhoneBatcher({ store: target.store, transport: relay });
        expect((await batcher.fetchProofs()).unverified).toBe(1);
        expect((await phonePeFact(target.store, f.pe.pe_id, null)).ok).toBe(false);
        await chain.importBatches([{ batch: f.batch, receipt: f.receipt }]);
        await batcher.fetchProofs();
        const result = await phonePeFact(target.store, f.pe.pe_id, null);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(verify(f.pe, result.fact.inclusion).failures).toEqual([]);
    });

    it('restores a foreign chain whose proof was unverified when the cloud snapshot was written', async () => {
        const f = await fixture(1);
        const source = await openStore(undefined, f.store.own().deviceId);
        await source.store.own().importPes(await f.store.own().allPes());
        await source.store.own().recordBatch(f.batch, f.receipt);
        await source.store.own().recordProof({ ...f.proof, verified: false });
        const cloud = new MemoryCloudFiles();
        const key = await deriveArchiveKey('synthetic recovery test mnemonic', 'ab'.repeat(16));
        const keys = { current: async () => ({key,saltHex:'ab'.repeat(16)}), forSalt: async () => key, adopt: async () => {} };
        expect((await new PeCloudBackup({store:source.store,cloud,keys,randomBytes}).backup()).ok).toBe(true);
        // Backup encrypts record files verbatim, so inspect the actual committed ciphertext.
        const backedProofs=[...cloud.files].filter(([name])=>name.startsWith('pe_object_'))
            .flatMap(([name,wire])=>{const rows=JSON.parse(decryptFile(key,name,wire));return Array.isArray(rows)?rows:[rows];})
            .filter(row=>row.batch_hash===f.proof.batch_hash && 'verified' in row);
        expect(backedProofs).toHaveLength(1);
        expect(backedProofs[0].verified).toBe(false);
        const recovered = await openStore(undefined, 'replacement_phone');
        await new PeCloudBackup({store:recovered.store,cloud,keys,randomBytes}).restore();
        const fact = await phonePeFact(recovered.store, f.pe.pe_id, null);
        expect(fact.ok).toBe(true);
        if (!fact.ok) throw new Error(fact.reason);
        expect(verify(f.pe, fact.fact.inclusion).failures).toEqual([]);
        // Exact metadata mismatches stay unverified.
        const foreign = await recovered.store.chain(f.store.own().deviceId);
        await foreign.recordProof({...f.proof,seq:999,verified:false});
        expect((await foreign.listProofs()).find(p=>p.seq===999)?.verified).toBe(false);
    });

    it('repairs a legacy Archive segment from authenticated metadata for both downloads and cache', async () => {
        const f = await fixture(2);
        const keeper = new PhoneArchiveKeeper({store:f.store,transport:noArchive,messageSecretKey:async()=>null});
        const [plan] = await keeper.readyDays(f.store.own());
        const good = buildArchiveEntries(f.day, plan.batches, PE_EXPORT_PE_ANCHOR);
        const damaged = buildArchiveEntries(f.day,plan.batches.map(b=>({...b,anchor:{...b.anchor,segment:undefined}})),PE_EXPORT_PE_ANCHOR);
        const secret = new Uint8Array(32).fill(7);
        const sealed = sealArchivePart({wallet:'owner',day:f.day,device_id:f.store.own().deviceId,part:0,entries:damaged.entries,refs:damaged.refs,recipients:[{party_id:'owner',pubkey_b64u:bytesToB64u(x25519.getPublicKey(secret))}]});
        let downloads = 0;
        const transport: PhoneArchiveTransport = {...noArchive,
            getDayObject:async()=>{downloads++;return {status:200,text:sealed.line};},
            getDayProofs:async()=>({status:200,error:null,body:{days:[{wallet:'owner',day:f.day,proof_repairs:good.refs}]}}),
        };
        const archive = new PhoneArchiveKeeper({store:f.store,transport,messageSecretKey:async()=>secret.slice(),objectCache:new MemoryArchiveObjectCache()});
        for(let i=0;i<2;i++) {
            const result = await archive.pullDay('owner',f.day,'owner');
            expect(result.ok).toBe(true);
            if(!result.ok) throw new Error(result.reason);
            expect(verify(f.pe,result.payloads[0].entries[0].inclusion).failures).toEqual([]);
        }
        expect(downloads).toBe(1);
    });

    it('preflights the complete proof before funds move, with wrong-segment and chain-root controls', async () => {
        const f = await fixture(1);
        const result = await phonePeFact(f.store,f.pe.pe_id,null);
        if(!result.ok) throw new Error(result.reason);
        const fact = { ...result.fact };
        const root = f.proof.anchor.merkle_root.replace(/^0x/,'');
        const call = async () => '0x'+root+[1,1,0,1].map(n=>n.toString(16).padStart(64,'0')).join('');
        await expect(preflightPresentationProofs([fact],call)).resolves.toBeUndefined();
        await expect(preflightPresentationProofs([{...fact,inclusion:{...fact.inclusion,anchor:{...fact.inclusion.anchor!,segment:99}}}],call)).rejects.toThrow('anchor_batch_id_mismatch');
        await expect(preflightPresentationProofs([fact],async()=> '0x'+'0'.repeat(320))).rejects.toThrow('day_not_anchored_on_chain');
    });
});
