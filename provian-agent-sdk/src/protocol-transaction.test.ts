import { HASH_ACCOUNT_ABI } from './hash-account-data';
import { expect, it } from 'vitest';
import { Interface } from 'ethers';
import { assertCurrentProtocolTransaction, assertCurrentProtocolAddresses, typedDataProtocolAddresses } from './protocol-transaction';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
const address = (byte: string) => `0x${byte.repeat(20)}`;
const retired = address('11'), token = address('22'), recipient = address('33');
const pointerAbi = new Interface(['function retired(address) view returns(bool)']);
const tokenAbi = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)',
  'function transferFrom(address,address,uint256)']);
function network(options: { disagree?: boolean; changed?: boolean } = {}): OwnerChainNetwork {
  let calls = 0;
  const rpc = (index: number) => ({ async request(_method: string, params: readonly unknown[]) {
    const call = params[0] as { data: string };
    const queried = String(pointerAbi.decodeFunctionData('retired', call.data)[0]).toLowerCase();
    return pointerAbi.encodeFunctionResult('retired', [queried === retired || options.disagree === true && index === 1]);
  } });
  return { rpcs: [rpc(0), rpc(1)], deployment: async () => ({ pointer: address('44'), blockHash: `0x${'55'.repeat(32)}`,
    manifestHash: options.changed && calls++ > 0 ? 'changed' : 'current' } as ProtocolDeployment) };
}
it('refuses a retired target and retired token recipients or approval spenders', async () => {
  await expect(assertCurrentProtocolTransaction(network(), retired)).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), token, tokenAbi.encodeFunctionData('transfer', [retired, 1]))).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), token, tokenAbi.encodeFunctionData('approve', [retired, 1]))).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), token, tokenAbi.encodeFunctionData('transferFrom', [recipient, retired, 1]))).rejects.toThrow('retired');
});
it('ordinary recipients remain unrestricted, while disagreeing readers and pointer changes fail closed', async () => {
  const data = tokenAbi.encodeFunctionData('transfer', [recipient, 1]);
  await expect(assertCurrentProtocolTransaction(network(), token, data)).resolves.toHaveProperty('manifestHash', 'current');
  await expect(assertCurrentProtocolTransaction(network({ disagree: true }), token, data)).rejects.toThrow('disagreement');
  await expect(assertCurrentProtocolTransaction(network({ changed: true }), token, data)).rejects.toThrow('changed');
});
it('nested typed-data permits cannot grant a retired spender authority over current tokens', async () => {
  const addresses = typedDataProtocolAddresses(token, { Permit: [{ name: 'details', type: 'Detail' }, { name: 'spender', type: 'address' }],
    Detail: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
    { details: { token, amount: 1 }, spender: retired });
  expect(addresses).toContain(retired);
  await expect(assertCurrentProtocolAddresses(network(), addresses)).rejects.toThrow('retired');
});

it('hash account wrappers cannot hide retired inner targets or token approval spenders', async () => {
  const wrap = (target: string, data: string) => HASH_ACCOUNT_ABI.encodeFunctionData('execute', [target, 0, 100000, data,
    `0x${'66'.repeat(32)}`, '0x1234', '0xabcd']);
  await expect(assertCurrentProtocolTransaction(network(), recipient, wrap(retired, '0x'))).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), recipient,
    wrap(token, tokenAbi.encodeFunctionData('approve', [retired, 1])))).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), recipient,
    wrap(recipient, wrap(token, tokenAbi.encodeFunctionData('transfer', [retired, 1]))))).rejects.toThrow('retired');
  await expect(assertCurrentProtocolTransaction(network(), recipient,
    wrap(token, tokenAbi.encodeFunctionData('approve', [recipient, 1])))).resolves.toHaveProperty('manifestHash', 'current');
});

it('mixed-case hex cannot hide hash wrappers or token approval selectors', async () => {
  const upperSelector = (data: string) => '0x' + data.slice(2, 10).toUpperCase() + data.slice(10);
  const wrap = (target: string, data: string) => HASH_ACCOUNT_ABI.encodeFunctionData('execute', [target, 0, 100000, data,
    `0x${'66'.repeat(32)}`, '0x1234', '0xabcd']);
  for (const data of [upperSelector(wrap(retired, '0x')),
    wrap(recipient, upperSelector(wrap(retired, '0x'))),
    wrap(token, upperSelector(tokenAbi.encodeFunctionData('approve', [retired, 1])))]) {
    await expect(assertCurrentProtocolTransaction(network(), recipient, data)).rejects.toThrow('retired');
  }
  await expect(assertCurrentProtocolTransaction(network(), token,
    upperSelector(tokenAbi.encodeFunctionData('approve', [retired, 1])))).rejects.toThrow('retired');
});
