import type { Firestore } from 'firebase-admin/firestore';
import { Interface, toQuantity } from 'ethers';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { createRecourseChainPort } from './chain-ledger';
import { advanceOwnershipLedger } from './ledger-store';
import { ERC20_TRANSFER_TOPIC } from '../onchain/economic-discovery';
import { RECOURSE_COLLECTIONS } from './ownership';
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: `0x${'22'.repeat(20)}` } }) }));
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const address = `0x${'11'.repeat(20)}`, kernel = `0x${'22'.repeat(20)}`;
const token = new Interface(['function balanceOf(address) view returns(uint256)']);

/** Counts actual requests at each independent transport. Deployment resolution
 * is measured separately; no high-level log reader is mocked. */
test('a payout after an idle interval uses shared history and credits the exact amount', async () => {
  const results: { idleDays: number; perProvider: number[]; logsPerProvider: number[] }[] = [];
  for (const idleDays of [1 / 1440, 30]) {
    const from = 100, through = from + Math.round(idleDays * 86400 * 5);
    const requests: Record<string, number>[] = [{}, {}];
    const leg = (index: number) => ({ operatorId: `provider-${index}`, send: async (method: string, params: readonly unknown[]): Promise<unknown> => {
      requests[index][method] = (requests[index][method] ?? 0) + 1;
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getBlockByNumber') { const n = params[0] === 'finalized' ? through : Number(BigInt(String(params[0])));
        return { number: toQuantity(n), hash: hash(n), timestamp: '0x1' }; }
      if (method === 'eth_call') return token.encodeFunctionResult('balanceOf', [120n]);
      if (method === 'eth_getLogs') {
        const filter = params[0] as { topics: readonly unknown[]; fromBlock: string; toBlock: string };
        return filter.topics[1] === null && Number(BigInt(filter.fromBlock)) <= through && Number(BigInt(filter.toBlock)) >= through
          ? [{ address: kernel, topics: [ERC20_TRANSFER_TOPIC, hash(0), `0x${'0'.repeat(24)}${address.slice(2)}`],
            data: hash(20), blockNumber: toQuantity(through), blockHash: hash(through), transactionHash: hash(999),
            transactionIndex: '0x0', logIndex: '0x0', removed: false }] : [];
      }
      throw Error(`unexpected_rpc:${method}`);
    } });
    const fake = createFakeFirestore({ strictTransactionOrder: true });
    fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${address}`, { identity: hash(1), address, kernel,
      boundBlock: from, boundBlockHash: hash(from), openingBalanceAtomic: '100', bindingDigest: hash(2), recoveryGeneration: 0, chainBindingStatus: 'confirmed' });
    // A quiet shared scan has already proved the entire interval complete.
    fake.store.set(`recourse_shared_ledger_cursors_v1/${kernel}`, { fromBlock: from + 1, block: through, blockHash: hash(through) });
    fake.store.set('recourse_shared_transfers_v1/payout', { kernel, address, block: through, blockHash: hash(through),
      transactionHash: hash(999), logIndex: 0, from: `0x${'0'.repeat(40)}`, to: address, amountAtomic: '20' });
    const result = await advanceOwnershipLedger(fake as unknown as Firestore, address, through, createRecourseChainPort([leg(0), leg(1)]));
    expect(result).toMatchObject({ balanceAtomic: '120', mintedAtomic: '20', receivedAtomic: '0' });
    results.push({ idleDays, perProvider: requests.map(r => Object.values(r).reduce((a,b)=>a+b,0)), logsPerProvider: requests.map(r=>r.eth_getLogs ?? 0) });
  }
  console.info('RECOURSE_LEDGER_RPC_COUNTS', JSON.stringify(results));
  expect(results[1].perProvider).toEqual(results[0].perProvider);
  expect(results[1].logsPerProvider).toEqual([0, 0]);
});
