import { createRecourseChainPort } from './chain-ledger';
import type { Firestore } from 'firebase-admin/firestore';
import { Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { recoursePoolConfig, RECOURSE_POOL_ABI } from './pool-state';

export const RECOURSE_RATIO_COLLECTION = 'recourse_public_resources_v1';
const births = new Map<string, number>();
const RATIO = new Interface(['event RestorationRatio(uint256 availableReserve,uint256 acceptedShortfall,uint256 distributable)']);
export interface RecourseResources {
  readonly schema: 'provian-recourse-resources/v2'; readonly pool: string; readonly kernel: string;
  readonly block: number; readonly blockHash: string; readonly reserveAtomic: string; readonly allocatedAtomic: string;
  readonly ratio: null | { readonly numerator: string; readonly denominator: string; readonly availableAtAllocationAtomic: string;
    readonly block: number; readonly blockHash: string; readonly transactionHash: string; readonly logIndex: number };
  readonly observedAtMs: number;
}
/** Explicit allowlist also refuses pre-privacy snapshots already in storage. */
export function publicRecourseResources(value: unknown, pool: string): RecourseResources {
  const fail = (): never => { throw Error('recourse_resources_invalid'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>, hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-f]{40}$/;
  const uint = (v: unknown): string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) ? v : fail();
  const n = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail();
  const h = (v: unknown): string => typeof v === 'string' && hash.test(v) ? v : fail();
  if (r.schema !== 'provian-recourse-resources/v2' || r.pool !== pool || typeof r.kernel !== 'string' || !address.test(r.kernel)) return fail();
  let ratio: RecourseResources['ratio'] = null;
  if (r.ratio !== null) {
    if (!r.ratio || typeof r.ratio !== 'object' || Array.isArray(r.ratio)) return fail();
    const v = r.ratio as Record<string, unknown>;
    ratio = { numerator: uint(v.numerator), denominator: uint(v.denominator), availableAtAllocationAtomic: uint(v.availableAtAllocationAtomic),
      block: n(v.block), blockHash: h(v.blockHash), transactionHash: h(v.transactionHash), logIndex: n(v.logIndex) };
    if (BigInt(ratio.denominator) === 0n || BigInt(ratio.numerator) !== (BigInt(ratio.availableAtAllocationAtomic) < BigInt(ratio.denominator)
      ? BigInt(ratio.availableAtAllocationAtomic) : BigInt(ratio.denominator)) || ratio.block > n(r.block)) return fail();
  }
  return { schema: 'provian-recourse-resources/v2', pool, kernel: r.kernel, block: n(r.block), blockHash: h(r.blockHash),
    reserveAtomic: uint(r.reserveAtomic), allocatedAtomic: uint(r.allocatedAtomic), ratio, observedAtMs: n(r.observedAtMs) };
}

/** Publishes the executed batch ratio, never members' portfolio balances. */
export async function refreshRecoursePoolRatio(db: Firestore): Promise<void> {
  const config = await recoursePoolConfig();
  const ref = db.collection(RECOURSE_RATIO_COLLECTION).doc(config.address);
  const saved = await ref.get();
  const previous = saved.exists ? publicRecourseResources(saved.data(), config.address) : undefined;
  const block = await createRecourseChainPort().finalizedBlock();
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
  let from: number;
  if (previous) {
    if (previous.block > block || await readAgreedBaseBlockHash(previous.block) !== previous.blockHash)
      throw Error('recourse_pool_reorg');
    from = previous.block + 1;
  } else {
    const birthKey = `${config.address}:${config.runtimeHash}`;
    let birth = births.get(birthKey);
    if (birth === undefined) {
      let left = 0, right = block;
      while (left < right) {
        const middle = left + Math.floor((right - left) / 2);
        if (await codeAt(middle) === '0x') left = middle + 1; else right = middle;
      }
      birth = left;
    }
    // Derive the boundary from the current contract, never a stale deployment
    // environment variable. Recheck even a cached boundary before each aggregate.
    if (birth < 1 || birth > block || await codeAt(birth - 1) !== '0x'
      || keccak256(await codeAt(birth)) !== config.runtimeHash) throw new Error('recourse_pool_deployment_block_invalid');
    births.set(birthKey, birth);
    from = birth;
  }
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  if (String((await call(config.address, RECOURSE_POOL_ABI, 'token'))[0]).toLowerCase() !== kernel) throw new Error('recourse_pool_token_mismatch');
  if (previous && previous.kernel !== kernel) throw Error('recourse_pool_token_mismatch');
  let ratio: RecourseResources['ratio'] = previous?.ratio ?? null;
  if (from <= block) {
    const start = from, end = block;
    const logs = await getAgreedBaseLogs({ address: config.address,
      topics: [RATIO.getEvent('RestorationRatio')!.topicHash], fromBlock: start, toBlock: end });
    for (const log of logs) {
      if (log.removed || log.address !== config.address || log.blockNumber < start || log.blockNumber > end
        || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
        || (ratio && (log.blockNumber < ratio.block || (log.blockNumber === ratio.block && log.logIndex <= ratio.logIndex)))
        || await readAgreedBaseBlockHash(log.blockNumber) !== log.blockHash) throw Error('recourse_pool_ratio_event_invalid');
      const event = RATIO.parseLog({ topics: [...log.topics], data: log.data });
      if (!event) throw Error('recourse_pool_ratio_event_invalid');
      ratio = { numerator: String(event.args.distributable), denominator: String(event.args.acceptedShortfall),
        availableAtAllocationAtomic: String(event.args.availableReserve), block: log.blockNumber, blockHash: log.blockHash,
        transactionHash: log.transactionHash, logIndex: log.logIndex };
      publicRecourseResources({ schema: 'provian-recourse-resources/v2', pool: config.address, kernel, block, blockHash,
        reserveAtomic: '0', allocatedAtomic: '0', ratio, observedAtMs: Date.now() }, config.address);
    }
  }
  const reserve = BigInt((await call(config.address, RECOURSE_POOL_ABI, 'availableReserve'))[0]);
  const allocated = BigInt((await call(config.address, RECOURSE_POOL_ABI, 'allocatedRestorations'))[0]);
  if (await readAgreedBaseBlockHash(block) !== blockHash || (await currentProtocolDeployment()).addresses.recoursePool.toLowerCase() !== config.address)
    throw new Error('recourse_pool_reorg');
  const row = publicRecourseResources({ schema: 'provian-recourse-resources/v2', pool: config.address, kernel, block, blockHash,
    reserveAtomic: reserve.toString(), allocatedAtomic: allocated.toString(), ratio, observedAtMs: Date.now() }, config.address);
  await db.runTransaction(async tx => {
    const prior = await tx.get(ref);
    if (prior.exists && Number(prior.get('block')) > block) return;
    if (prior.exists && prior.get('block') === block && prior.get('blockHash') !== blockHash) throw new Error('recourse_pool_reorg');
    if (saved.exists ? prior.get('block') !== previous!.block || prior.get('blockHash') !== previous!.blockHash : prior.exists)
      throw Error('recourse_pool_cursor_changed');
    tx.set(ref, row);
  });
}
