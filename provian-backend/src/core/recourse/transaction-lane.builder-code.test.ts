import { Wallet } from 'ethers';
import { assertLaneTransaction } from './transaction-lane';
import { withBuilderCode } from '../onchain/builder-code';

// The lane signs the planned call with Provian's Base Builder Code; its record check accepts exactly
// that (or bytes signed before attribution) and nothing else.
describe('Recourse lane Builder Code', () => {
  const wallet = new Wallet('0x' + '42'.repeat(32));
  const executor = '0x' + '77'.repeat(20);
  const calldata = '0x12345678' + 'cd'.repeat(32);
  const sign = (data: string) => wallet.signTransaction({ type: 2, chainId: 8453, nonce: 4, to: executor, data, value: 0,
    gasLimit: 90_000, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n });
  const signer = wallet.address.toLowerCase();

  it('accepts the attributed call and a legacy unattributed record', async () => {
    expect(assertLaneTransaction(await sign(withBuilderCode(calldata)), signer, 4, { executor, calldata }).data).toBe(withBuilderCode(calldata));
    expect(assertLaneTransaction(await sign(calldata), signer, 4, { executor, calldata }).data).toBe(calldata);
  });
  it('RED control: refuses another call carrying the code, and a foreign suffix', async () => {
    const other = '0x12345678' + 'ce'.repeat(32);
    await expect((async () => assertLaneTransaction(await sign(withBuilderCode(other)), signer, 4, { executor, calldata }))()).rejects.toThrow('recourse_lane_signed_mismatch');
    await expect((async () => assertLaneTransaction(await sign(withBuilderCode(calldata, 'bc_other')), signer, 4, { executor, calldata }))()).rejects.toThrow('recourse_lane_signed_mismatch');
  });
});
