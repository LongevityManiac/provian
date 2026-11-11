import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { readStoredBreakArtifact } from './break-artifact-store';
import type { BreakPartitionPort } from './restoration-break-partition';

const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function registryOperator() view returns(address)',
  'function protocolPointer() view returns(address)', 'function pointer() view returns(address)', 'function component(uint256) view returns(address)',
  'function kernel() view returns(address)', 'function breakOrigin() view returns(address)', 'function restoredIdentity(bytes32) view returns(bool)',
  'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function previousRegistry() view returns(address)',
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
  'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)']);
const zero = `0x${'0'.repeat(40)}`, hash = /^0x[0-9a-f]{64}$/;
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw Error('recourse_partition_registry_invalid');
  return value.toLowerCase();
}
/** Independent RPC evidence for one public recovery binding. This never asks
 * for, reconstructs or publishes the relay's private owner portfolio. */
export function breakPartitionChainPort(db: Firestore): BreakPartitionPort {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const agree = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const values = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(values[0], values[1])) throw Error('recourse_partition_rpc_disagreement');
    return values[0];
  };
  const blockHash = async (height: number): Promise<string> => {
    const value = await readAgreedBaseBlockHash(height);
    if (!value || !hash.test(value)) throw Error('recourse_partition_checkpoint_missing');
    return value;
  };
  const call = async (target: string, method: string, args: readonly unknown[], blockHash: string): Promise<unknown> => {
    const raw = await agree('eth_call', [{ to: target, data: abi.encodeFunctionData(method, args) }, { blockHash, requireCanonical: true }]);
    if (typeof raw !== 'string') throw Error('recourse_partition_rpc_invalid');
    return abi.decodeFunctionResult(method, raw)[0];
  };
  const code = async (target: string, pin: string): Promise<string> => {
    const raw = await agree('eth_getCode', [target, { blockHash: pin, requireCanonical: true }]);
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) throw Error('recourse_partition_rpc_invalid');
    return raw.toLowerCase();
  };
  return { manifest: async () => (await currentProtocolDeployment()).manifestHash,
    artifact: origin => readStoredBreakArtifact(db, origin), blockHash, call,
    async registryAccounts(registry, identity, through, throughHash, pointer) {
      if (!Number.isSafeInteger(through) || through < 1 || !hash.test(throughHash) || !hash.test(identity)
        || /^0x0+$/.test(identity) || registry === zero || pointer === zero) throw Error('recourse_partition_registry_invalid');
      const original = address(registry), seen = new Set<string>(), accounts = new Map<string, number>();
      const blockPins = new Map<number, string>([[through, throughHash]]);
      let current = original;
      while (current !== zero) {
        if (seen.has(current) || address(await call(current, 'pointer', [], throughHash)) !== pointer) throw Error('recourse_partition_registry_invalid');
        seen.add(current);
        const runtime = await code(current, throughHash);
        if (runtime === '0x' || await code(current, await blockHash(0)) !== '0x') throw Error('recourse_partition_deployment_invalid');
        // Registry code is immutable. Binary discovery avoids scanning the
        // chain from genesis, while proving both sides of its deployment block.
        let low = 0, high = through;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2), observed = await code(current, await blockHash(middle));
          if (observed === '0x') low = middle;
          else { if (observed !== runtime) throw Error('recourse_partition_runtime_changed'); high = middle; }
        }
        const beforeHash = await blockHash(high - 1), birthHash = await blockHash(high);
        if (await code(current, beforeHash) !== '0x' || await code(current, birthHash) !== runtime) throw Error('recourse_partition_deployment_invalid');
        for (const [height, pin] of [[high - 1, beforeHash], [high, birthHash]] as const) {
          if (blockPins.has(height) && blockPins.get(height) !== pin) throw Error('recourse_partition_reorg');
          blockPins.set(height, pin);
        }
        const logs = await getAgreedBaseLogs({ address: current, topics: [[abi.getEvent('OwnershipBound')!.topicHash,
          abi.getEvent('RecoveredAddressBound')!.topicHash], identity], fromBlock: high, toBlock: through });
        let position = -1n;
        for (const log of logs) {
          if (!Number.isSafeInteger(log.blockNumber) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw Error('recourse_partition_binding_log_invalid');
          const next = BigInt(log.blockNumber) * (1n << 64n) + BigInt(log.logIndex);
          const event = abi.parseLog({ topics: [...log.topics], data: log.data });
          if (log.removed || log.address !== current || log.blockNumber < high || log.blockNumber > through
            || next <= position || !event || !['OwnershipBound', 'RecoveredAddressBound'].includes(event.name)
            || event.args.identity !== identity || !hash.test(log.blockHash)) throw Error('recourse_partition_binding_log_invalid');
          position = next;
          if (blockPins.has(log.blockNumber) && blockPins.get(log.blockNumber) !== log.blockHash) throw Error('recourse_partition_reorg');
          blockPins.set(log.blockNumber, log.blockHash);
          const account = address(event.args.account);
          if (account === zero) throw Error('recourse_partition_binding_log_invalid');
          accounts.set(account, Math.min(accounts.get(account) ?? log.blockNumber, log.blockNumber));
        }
        current = address(await call(current, 'previousRegistry', [], throughHash));
      }
      for (const [account, first] of accounts) {
        if (await call(original, 'ownerOf', [account], throughHash) !== identity
          || await call(original, 'boundBlock', [account], throughHash) !== BigInt(first)) throw Error('recourse_partition_binding_invalid');
      }
      for (const [height, pin] of blockPins) if (await blockHash(height) !== pin) throw Error('recourse_partition_reorg');
      if (await blockHash(through) !== throughHash) throw Error('recourse_partition_reorg');
      return [...accounts.keys()].sort();
    } };
}
