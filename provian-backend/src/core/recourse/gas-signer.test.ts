import { Interface, Wallet } from 'ethers';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ readAgreedBaseHead: jest.fn(), readAgreedBaseBlockHash: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseHead, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { createRecourseGasSigner } from './gas-signer';

test('gas sponsorship refuses to sign when execution is funded but L1 and operator costs are not', async () => {
  const blockHash = `0x${'11'.repeat(32)}`, manifestHash = `0x${'22'.repeat(32)}`;
  const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
    'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
  const execution = 120000n * 1000020n;
  let balance = execution;
  const send = jest.fn(async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getBlockByHash') return { hash: blockHash, baseFeePerGas: '0xa', gasLimit: '0x1c9c380' };
    if (method === 'eth_estimateGas') return '0x186a0';
    if (method === 'eth_getBalance') return `0x${balance.toString(16)}`;
    if (method === 'eth_call') {
      const data = (params[0] as { data: string }).data, parsed = oracle.parseTransaction({ data })!;
      return oracle.encodeFunctionResult(parsed.name, [parsed.name === 'getOperatorFee' ? 100n : 700n]);
    }
    throw Error('unexpected method');
  });
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([
    { operatorId: 'one', provider: { send } }, { operatorId: 'two', provider: { send } },
  ]);
  (readAgreedBaseHead as jest.Mock).mockResolvedValue(100);
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(blockHash);
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({ manifestHash });
  const wallet = new Wallet(`0x${'33'.repeat(32)}`), signTransaction = jest.fn(wallet.signTransaction.bind(wallet));
  const assertPlan = jest.fn(), signer = createRecourseGasSigner({ address: wallet.address, signTransaction }, assertPlan);
  const plan = { executor: `0x${'44'.repeat(20)}`, calldata: '0x1234', manifestHash };
  await expect(signer.sign(plan)).rejects.toThrow('gas_unavailable');
  expect(signTransaction).not.toHaveBeenCalled();
  balance = execution + 800n;
  await expect(signer.sign(plan)).resolves.toMatch(/^0x/);
  expect(signTransaction).toHaveBeenCalledTimes(1);
  expect(assertPlan).toHaveBeenCalledTimes(2);
});
