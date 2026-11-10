import type { Firestore } from 'firebase-admin/firestore';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { recoursePoolConfig, RECOURSE_POOL_ABI } from './pool-state';

export const RECOURSE_RATIO_COLLECTION = 'recourse_public_resources_v1';
const births = new Map<string, number>();
const historyAbi = new Interface(['event PoolStateImported(uint8 indexed kind,bytes32 indexed slot,bytes32 leaf,bytes data)']);
const TOKEN = new Interface(['function balanceOf(address) view returns (uint256)']);

/** Public aggregate only. Every member/address and balance comes from the pool's
 * complete binding-event history and the same canonical block. The ratio is a
 * resource measure, separate from the accepted-determination payout divisor. */
export async function refreshRecoursePoolRatio(db: Firestore): Promise<void> {
  const config = await recoursePoolConfig();
  const block = await readAgreedBaseHead();
  const blockHash = await readAgreedBaseBlockHash(block);
  if (!blockHash) throw new Error('recourse_pool_block_unavailable');
  const tag = { blockHash, requireCanonical: true };
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const call = async (address: string, abi: Interface, method: string, args: readonly unknown[] = []) => {
    const data = abi.encodeFunctionData(method, args);
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: address, data }, tag])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw new Error('recourse_pool_rpc_disagreement');
    return abi.decodeFunctionResult(method, values[0]);
  };
  const codeAt = async (height: number): Promise<string> => {
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_getCode', [config.address, `0x${height.toString(16)}`])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw new Error('recourse_pool_rpc_disagreement');
    return values[0];
  };
  for (const leg of legs) {
    const code: unknown = await leg.provider.send('eth_getCode', [config.address, tag]);
    if (typeof code !== 'string' || keccak256(code) !== config.runtimeHash) throw new Error('recourse_pool_runtime_mismatch');
  }
  const birthKey = `${config.address}:${config.runtimeHash}`;
  let from = births.get(birthKey);
  if (from === undefined) {
    let left = 0, right = block;
    while (left < right) {
      const middle = left + Math.floor((right - left) / 2);
      if (await codeAt(middle) === '0x') left = middle + 1; else right = middle;
    }
    from = left;
  }
  // Derive the boundary from the current contract, never a stale deployment
  // environment variable. Recheck even a cached boundary before each aggregate.
  if (from < 1 || from > block || await codeAt(from - 1) !== '0x'
    || keccak256(await codeAt(from)) !== config.runtimeHash) throw new Error('recourse_pool_deployment_block_invalid');
  births.set(birthKey, from);
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  if (String((await call(config.address, RECOURSE_POOL_ABI, 'token'))[0]).toLowerCase() !== kernel) throw new Error('recourse_pool_token_mismatch');
  const identities = new Map<string, Set<string>>();
  for (let start = from; start <= block; start += 500) {
    const logs = await getAgreedBaseLogs({ address: config.address,
      topics: [[RECOURSE_POOL_ABI.getEvent('AddressBound')!.topicHash, historyAbi.getEvent('PoolStateImported')!.topicHash]], fromBlock: start, toBlock: Math.min(start + 499, block) });
    for (const log of logs) {
      if (log.removed || await readAgreedBaseBlockHash(log.blockNumber) !== log.blockHash) throw new Error('recourse_pool_reorg');
      let identity: string, address: string;
      if (log.topics[0] === historyAbi.getEvent('PoolStateImported')!.topicHash) {
        const decoded = historyAbi.parseLog({ topics: [...log.topics], data: log.data });
        if (!decoded) throw new Error('recourse_pool_event_invalid');
        if (decoded.args.kind !== 7n) continue;
        const binding = AbiCoder.defaultAbiCoder().decode(['address', 'bytes32'], decoded.args.data);
        address = String(binding[0]).toLowerCase(); identity = String(binding[1]).toLowerCase();
      } else {
        const decoded = RECOURSE_POOL_ABI.parseLog({ topics: [...log.topics], data: log.data });
        if (!decoded || decoded.name !== 'AddressBound') throw new Error('recourse_pool_event_invalid');
        identity = String(decoded.args[0]).toLowerCase(); address = String(decoded.args[1]).toLowerCase();
      }
      const addresses = identities.get(identity) ?? new Set<string>();
      addresses.add(address); identities.set(identity, addresses);
    }
  }
  let total = 0n, members = 0, addressCount = 0;
  const counted = new Set<string>();
  for (const [identity, addresses] of identities) {
    const member = await call(config.address, RECOURSE_POOL_ABI, 'membershipState', [identity]);
    if (!member[0]) continue;
    members++;
    for (const address of addresses) {
      if (counted.has(address) || String((await call(config.address, RECOURSE_POOL_ABI, 'ownerOf', [address]))[0]).toLowerCase() !== identity) throw new Error('recourse_pool_owner_conflict');
      counted.add(address); addressCount++;
      total += BigInt((await call(kernel, TOKEN, 'balanceOf', [address]))[0]);
    }
  }
  const reserve = BigInt((await call(config.address, RECOURSE_POOL_ABI, 'availableReserve'))[0]);
  if (await readAgreedBaseBlockHash(block) !== blockHash) throw new Error('recourse_pool_reorg');
  const row = { pool: config.address, kernel, block, blockHash, memberCount: members, addressCount,
    reserveAtomic: reserve.toString(), memberBalanceAtomic: total.toString(),
    ratio: total === 0n ? null : { numerator: reserve.toString(), denominator: total.toString() },
    observedAtMs: Date.now() };
  await db.runTransaction(async tx => {
    const ref = db.collection(RECOURSE_RATIO_COLLECTION).doc(config.address);
    const prior = await tx.get(ref);
    if (prior.exists && Number(prior.get('block')) > block) return;
    if (prior.exists && prior.get('block') === block && prior.get('blockHash') !== blockHash) throw new Error('recourse_pool_reorg');
    tx.set(ref, row);
  });
}
