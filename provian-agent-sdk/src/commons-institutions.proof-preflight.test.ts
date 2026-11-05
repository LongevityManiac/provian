import { describe, expect, it, vi } from 'vitest';
import { CommonsInstitutions } from './commons-institutions';

describe('presentation proof validation before any burn', () => {
  it('rejects a client-side missing inclusion proof without broadcasting', async () => {
    const bank = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: 'wallet_test', apiKey: 'pvn_test', apiSecret: 'pvns_test',
      fetch: async () => new Response(JSON.stringify({}), { status: 200 }) });
    vi.spyOn(bank, 'presentationFloorAtomic').mockResolvedValue(5n * 10n ** 18n);
    const burn = vi.spyOn(bank, 'sendBurn').mockResolvedValue({ txHash: '0x' + 'a'.repeat(64), burnId: 'b'.repeat(64), amountAtomic: '5000000000000000000', chain: 'base' });
    vi.spyOn(bank, 'present').mockResolvedValue({ tier: 'pe_fact', token: 'token', presentation: {} });
    await expect(bank.respondToChallenge({ audience: 'requester', challenge: 'a'.repeat(32) }, {
      privateKeyHex: 'a'.repeat(64), rpcUrl: 'https://rpc.test', peFacts: [{ peId: 'pe_bad', envelopeHash: 'c'.repeat(64) }],
    })).rejects.toThrow('presentation_proof_invalid');
    expect(burn).not.toHaveBeenCalled();
  });
});

import { batchLeafOf } from './meter-wire';
import { anchoredStore } from './meter/anchored-store.test-support';
import { peFactFromStore } from './meter/prove';
import { anchoredLeafOf, meterAnchorBatchIdOf, getBatchCalldata } from './pe-export-wire';

it('checks a real segmented proof on Base before burning, and refuses the same proof with a wrong segment', async () => {
  const {store,pes} = await anchoredStore({anchored:false});
  const [batch] = await store.listBatches();
  const p = {seq:batch.seq,batch_hash:batch.batch_hash,acts_root:batch.acts_root!,actor_id:batch.actor_id!,batch_leaf:batchLeafOf({device_id:store.deviceId,actor_id:batch.actor_id!,seq:batch.seq,batch_hash:batch.batch_hash,acts_root:batch.acts_root!}),anchor:{day:'2026-10-02',leaf_index:0,leaf_count:1,anchor_tx_hash:null,anchored_at_ms:1},fetched_at_ms:1,verified:true};
  const root = anchoredLeafOf(p.batch_leaf);
  const id = meterAnchorBatchIdOf(p.anchor.day, 2);
  await store.recordProof({...p,anchor:{...p.anchor,segment:2,anchor_batch_id:id,merkle_root:root,leaf_hash:root,proof:[]}});
  const result=await peFactFromStore(store,pes[0].pe_id);
  if(!result.ok) throw new Error(result.reason);
  const events:string[]=[];
  const bank = new CommonsInstitutions({relayUrl:'https://relay.test',walletId:'wallet_test',apiKey:'pvn_test',apiSecret:'pvns_test',fetch:async (_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(_url).endsWith('/present/preflight')) {expect(body.private_request).toBeDefined();expect(body.pe_facts).toBeUndefined();events.push('preflight');return new Response(JSON.stringify({ok:true}));}
    expect(body.method).toBe('eth_call');
    expect(body.params[0].data).toBe(getBatchCalldata(id));
    events.push('anchor');
    return new Response(JSON.stringify({result:root+[1,1,0,1].map(n=>n.toString(16).padStart(64,'0')).join('')}));
  }});
  vi.spyOn(bank,'presentationFloorAtomic').mockResolvedValue(5n*10n**18n);
  const burn=vi.spyOn(bank,'sendBurn').mockImplementation(async()=>{events.push('burn');return {txHash:'0x'+'a'.repeat(64),burnId:'b'.repeat(64),amountAtomic:'5000000000000000000',chain:'base'};});
  vi.spyOn(bank,'present').mockImplementation(async params=>{
    expect(params.peFacts?.[0].inclusion).toMatchObject({anchor:{segment:2}});
    return {tier:'pe_fact',token:'token',presentation:{}};
  });
  const opts={privateKeyHex:'a'.repeat(64),rpcUrl:'https://mainnet.base.org',peFacts:[result.fact]};
  await bank.respondToChallenge({audience:'requester',challenge:'a'.repeat(32)},opts);
  expect(events).toEqual(['anchor','preflight','burn']);
  const bad={...result.fact,inclusion:{...result.fact.inclusion,anchor:{...result.fact.inclusion.anchor!,segment:99}}};
  await expect(bank.respondToChallenge({audience:'requester',challenge:'a'.repeat(32)},{...opts,peFacts:[bad]})).rejects.toThrow('presentation_proof_invalid');
  expect(burn).toHaveBeenCalledTimes(1);
});

it.each(['pe_not_owned','at least one pe_fact is required','disclosure_record_mismatch'])('never burns when issuance preflight refuses %s', async reason=>{
  const bank=new CommonsInstitutions({relayUrl:'https://relay.test',walletId:'wallet_test',apiKey:'pvn_test',apiSecret:'pvns_test',fetch:async()=>new Response(JSON.stringify({error:reason,reason}),{status:400})});
  vi.spyOn(bank,'presentationFloorAtomic').mockResolvedValue(5n*10n**18n);
  const burn=vi.spyOn(bank,'sendBurn');
  await expect(bank.respondToChallenge({audience:'requester',challenge:'a'.repeat(32)},{privateKeyHex:'a'.repeat(64),rpcUrl:'https://mainnet.base.org'})).rejects.toThrow(reason);
  expect(burn).not.toHaveBeenCalled();
});
