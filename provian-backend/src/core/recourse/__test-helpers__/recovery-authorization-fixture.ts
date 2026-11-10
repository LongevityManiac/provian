import { AbiCoder, sha256 } from 'ethers';
import { RECOVERY_AUTH_ABI as auth, RECOVERY_KERNEL_ABI as kernel, type RecoveryAuthorizationInput } from '../recovery-authorization';
import type { EconomicStateRpcLeg } from '../../onchain/economic-state';
const h = (byte: string): string => `0x${byte.repeat(32)}`;
const address = (byte: string): string => `0x${byte.repeat(20)}`;
const authorization = address('18'), receiptHash = h('19'), headHash = h('20');
export function recoveryAuthorizationFixture(input: RecoveryAuthorizationInput, change?: (method: string, result: unknown, leg: number) => unknown): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const coder = AbiCoder.defaultAbiCoder();
  const operation = input.breakDestinationRoot === undefined
    ? sha256(coder.encode(['string', 'bytes32', 'address'], ['Provian ownership recovery', input.identity, input.destination]))
    : sha256(coder.encode(['string', 'bytes32', 'uint256', 'address', 'bytes32', 'address', 'uint256'],
      ['Provian cryptographic break', input.identity, 100, input.destination, input.breakDestinationRoot, address('90'), 50]));
  const intent = sha256(coder.encode(['string', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    ['Provian restoration owner authorization', 8453, input.kernel, input.identity, input.consumedCommitment, input.nonce,
      operation, input.nextCommitment, input.nextSigningRoot]));
  const event = auth.encodeEventLog(auth.getEvent('OwnerAuthorizationConsumed')!,
    [input.identity, input.nonce, intent, input.nextCommitment, input.nextSigningRoot]);
  const log = { address: authorization, transactionHash: input.transactionHash, blockHash: receiptHash, removed: false, ...event };
  const restored = auth.encodeEventLog(auth.getEvent('IdentityRestored')!, [input.identity, input.destination, 100]);
  const logs = input.breakDestinationRoot === undefined ? [log] : [log, { ...log, ...restored }];
  const leg = (index: number): EconomicStateRpcLeg => ({ operatorId: `operator-${index}`, send: async (method, params) => {
    let result: unknown;
    if (method === 'eth_chainId') result = '0x2105';
    else if (method === 'eth_blockNumber') result = '0x65';
    else if (method === 'eth_getBlockByNumber') result = params[0] === '0x64' ? { number: '0x64', hash: receiptHash } : { number: '0x65', hash: headHash };
    else if (method === 'eth_getTransactionReceipt') result = { transactionHash: input.transactionHash, status: '0x1',
      blockNumber: '0x64', blockHash: receiptHash, logs };
    else if (method === 'eth_call') {
      const request = params[0] as { to: string; data: string };
      const abi = request.to === input.kernel ? kernel : auth;
      const parsed = abi.parseTransaction({ data: request.data })!;
      const values: Record<string, unknown> = { ownerAuthorization: authorization, ownerAuthorizationNonce: BigInt(input.nonce + 1),
        ownerRecoveryCommitment: input.nextCommitment, ownerSigningRoot: input.nextSigningRoot, recoveredDestination: input.destination,
        breakOrigin: address('91'), predecessor: address('90'), lastGoodBlock: 50 };
      if (!(parsed.name in values)) throw new Error('Unexpected contract method');
      result = abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    } else throw new Error(`Unexpected RPC ${method}`);
    return change ? change(method, result, index) : result;
  } });
  return [leg(0), leg(1)];
}
