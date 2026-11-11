import { beforeEach, expect, test, vi } from 'vitest';
import { BreakRecoverySpendingKeyChanged } from './break-recovery-receipt';
import { recoverHashRecourseAgent } from './agent-hash-recovery';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`, a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const state = vi.hoisted(() => ({ nonce: 0, interrupted: false, finished: false, cuts: 0, stolen: false, requests: vi.fn() }));
vi.mock('./keystore', () => ({ loadKeystore: () => ({ version: 2, address: a(1), wallet_id: 'wallet_agent' }) }));
vi.mock('./recourse-binding-chain', () => ({ readAddressRecoveryBinding: async () => h(1) }));
vi.mock('./break-recovery', () => ({ readBreakRecoveryContext: async () => a(2) }));
vi.mock('./recourse-owner-chain', () => ({ readOwnerChainState: async () => ({ nonce: state.nonce, commitment: h(2), destination: a(3) }) }));
vi.mock('./break-recovery-store', () => ({
  agentInitialBreakNeedsInstall: async () => !state.finished,
  readAgentBreakEntitlement: async () => ({ identity: h(1), commitment: h(2) }),
  recoverAgentBreak: async () => { state.nonce = 1; state.cuts++; if(state.stolen) throw new BreakRecoverySpendingKeyChanged(); if (state.interrupted) { state.interrupted = false; throw Error('cut interrupted'); }
    state.finished = true; return { identity: h(1), commitment: h(2), context: a(2), address: a(3), transactionHash: h(3) }; },
  withAgentHashRecoveryRecord: async (_input: unknown, use: (record: unknown, persist: () => void) => Promise<unknown>) => use({
    credentials: { generation: 1, apiKey: 'new-key', apiSecret: 'new-secret' }, destination: a(3), restoredTransaction: h(3),
    replacement: { sourceAddress: a(3) },
  }, () => {}),
  listAgentHashReplacements: async () => [], retainedAgentRestorations: async () => [],
}));
vi.mock('./agent-hash-replacement', () => ({ prepareAgentHashReplacement: async () => ({ identity: h(1), commitment: h(2), context: a(2), nonce: 1, account: a(4), initialRoot: h(4) }) }));
vi.mock('./guarded-fetch', () => ({ guardedFetcher: () => state.requests }));
beforeEach(() => { state.stolen = false; state.nonce = 0; state.interrupted = false; state.finished = false; state.cuts = 0; state.requests.mockReset(); });
const input = () => ({ directory: '/tmp/test-no-disk-access', passphrase: 'not used', relayUrl: 'https://relay.example', network: {} as OwnerChainNetwork,
  restoration: { transactionHash: h(5), block: 10, apiKey: 'old-key', apiSecret: 'old-secret' } });
test('initial free recovery uses the newly installed credentials for restoration preparation', async () => {
  state.requests.mockImplementation(async (_url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Authorization: 'Bearer new-key:new-secret' }); throw Error('preparation reached');
  });
  await expect(recoverHashRecourseAgent(input())).rejects.toThrow('preparation reached'); expect(state.cuts).toBe(1);
});
test('a lost initial cut resumes at nonce one before preparing the restoration', async () => {
  state.interrupted = true;
  await expect(recoverHashRecourseAgent(input())).rejects.toThrow('cut interrupted'); expect(state.requests).not.toHaveBeenCalled();
  state.requests.mockImplementation(async (_url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Authorization: 'Bearer new-key:new-secret' }); throw Error('preparation reached');
  });
  await expect(recoverHashRecourseAgent(input())).rejects.toThrow('preparation reached'); expect(state.cuts).toBe(2);
});

test('a stolen initial replacement proceeds with independent recovery and tries the still-active old credential after a refused staged cut',async()=>{
 state.nonce=1;state.stolen=true;let calls=0;
 state.requests.mockImplementation(async(_url:string,options:RequestInit)=>{calls++;if(calls===1){expect(options.headers).toMatchObject({Authorization:'Bearer new-key:new-secret'});return{ok:false,status:401};}
  expect(options.headers).toMatchObject({Authorization:'Bearer old-key:old-secret'});throw Error('old credential preparation reached');});
 await expect(recoverHashRecourseAgent(input())).rejects.toThrow('old credential preparation reached');expect(state.cuts).toBe(1);expect(calls).toBe(2);
});
