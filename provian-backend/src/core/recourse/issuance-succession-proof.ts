import { AbiCoder, Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { createRecourseChainPort } from './chain-ledger';
import { findMembershipSuccessionCheckpoint, type MembershipDomainCheckpoint } from './membership-succession-checkpoint';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { beforeMembershipPosition } from './private-membership-journal';

const abi = new Interface(['function retired(address) view returns(bool)', 'function ownerAuthorization() view returns(address)',
  'function kernel() view returns(address)', 'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function cryptographicBreak() view returns(bool)',
  'function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
const publicationAbi = new Interface(['event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
const verified = new WeakSet<object>();
const fail = (reason: string): never => { throw Error(`recourse_issuance_succession_${reason}`); };
export interface VerifiedIssuanceSuccession {
  readonly pointer: string; readonly batchId: string; readonly cutoff: MembershipDomainCheckpoint;
  readonly successor: MembershipDomainCheckpoint; readonly afterBreak: boolean;
  readonly manifestHash: string; readonly previousManifestHash: string;
  readonly settled: boolean; readonly cancelled: boolean;
}
export function assertIssuanceSuccession(proof: VerifiedIssuanceSuccession): void {
  if (!verified.has(proof)) return fail('unverified');
}

/** Independent of membership existence: even an entirely unregistered batch
 * needs authenticated retirement and exact cutoff state before its locks end. */
export async function readIssuanceSuccession(source: { readonly kernel: string; readonly pool: string }, batchId: string): Promise<VerifiedIssuanceSuccession | null> {
  if (!/^0x[0-9a-f]{64}$/.test(batchId)) return fail('batch');
  const boundary = await findMembershipSuccessionCheckpoint(source);
  if (!boundary) return null;
  const { cutoff, successor } = boundary;
  const pointer = PROTOCOL_POINTER_PIN.address, pin = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !pin) return fail('pointer');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) return fail('operators');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m,p) => legs[0].provider.send(m,[...p]) }, { request: (m,p) => legs[1].provider.send(m,[...p]) }];
  const agree = async (method: string, params: readonly unknown[]) => {
    const [a,b] = await Promise.all(rpcs.map(r => r.request(method,params)));
    if (!rpcChainFactsEqual(a,b)) return fail('disagreement'); return a;
  };
  const chain = createRecourseChainPort();
  if (successor.block > await chain.finalizedBlock() || cutoff.block >= successor.block
    || await chain.blockHash(cutoff.block) !== cutoff.blockHash || await chain.blockHash(successor.block) !== successor.blockHash) return fail('checkpoint');
  const before = await resolveHistoricalProtocolDeployment(rpcs,pointer,pin,cutoff.block,cutoff.blockHash);
  const next = await resolveHistoricalProtocolDeployment(rpcs,pointer,pin,successor.block,successor.blockHash);
  if (before.addresses.kernel.toLowerCase() !== source.kernel || before.addresses.recoursePool.toLowerCase() !== source.pool
    || next.addresses.kernel.toLowerCase() !== successor.kernel || next.addresses.recoursePool.toLowerCase() !== successor.pool) return fail('domain');
  const call = async (to: string, contract: Interface, method: string, args: readonly unknown[] = [], blockHash = successor.blockHash) => {
    const raw = await agree('eth_call',[{ to, data: contract.encodeFunctionData(method,args) },{ blockHash,requireCanonical:true }]);
    if (typeof raw !== 'string') return fail('reply'); return contract.decodeFunctionResult(method,raw);
  };
  for (const address of [source.kernel,source.pool]) if ((await call(pointer,abi,'retired',[address]))[0] !== true) return fail('not_retired');
  const snapshot = await call(successor.pool,RECOURSE_POOL_ABI,'poolSnapshot');
  const executor = String((await call(successor.kernel,abi,'ownerAuthorization'))[0]).toLowerCase();
  if (String(snapshot[0]).toLowerCase() !== source.pool || snapshot[1] !== BigInt(cutoff.block) || snapshot[3] === 0n
    || (await call(successor.pool,RECOURSE_POOL_ABI,'poolHistoryReady'))[0] !== true
    || String((await call(successor.pool,RECOURSE_POOL_ABI,'token'))[0]).toLowerCase() !== successor.kernel
    || String((await call(executor,abi,'kernel'))[0]).toLowerCase() !== successor.kernel
    || String((await call(executor,abi,'predecessor'))[0]).toLowerCase() !== source.kernel
    || (await call(executor,abi,'lastGoodBlock'))[0] !== snapshot[1]
    || (await call(executor,abi,'cryptographicBreak'))[0] !== snapshot[4]) return fail('ancestry');
  let activation: { block:number;logIndex:number } | null = null, publication: { block:number;logIndex:number } | null = null;
  let revision = before.revision, manifest = before.manifestHash;
  for (const target of [successor.pool,pointer.toLowerCase()]) {
    let lastBlock = cutoff.block, lastIndex = -1;
    const contract = target === successor.pool ? RECOURSE_POOL_ABI : publicationAbi;
    const topic = contract.getEvent(target === successor.pool ? 'PoolHistoryActivated' : 'DeploymentChanged')!.topicHash;
    for (let start = cutoff.block + 1; start <= successor.block; start += 500) {
      const end = Math.min(start+499,successor.block);
      for (const log of await getAgreedBaseLogs({ address:target, topics:[topic], fromBlock:start, toBlock:end })) {
        if (log.removed || log.address !== target || log.blockNumber < start || log.blockNumber > end
          || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.blockNumber < lastBlock
          || (log.blockNumber === lastBlock && log.logIndex <= lastIndex) || await chain.blockHash(log.blockNumber) !== log.blockHash) return fail('log');
        lastBlock = log.blockNumber; lastIndex = log.logIndex;
        const event = contract.parseLog({ topics:[...log.topics],data:log.data });
        if (!event) return fail('log');
        if (target === successor.pool) {
          if (activation || event.args.root !== snapshot[2] || event.args[1] !== snapshot[3]) return fail('activation');
          activation = { block:log.blockNumber,logIndex:log.logIndex };
        } else {
          if (event.args.revision !== ++revision || keccak256(AbiCoder.defaultAbiCoder().encode(
            ['uint256','address','uint256','address[10]','bytes32[10]'],[8453,pointer,revision,event.args.components,event.args.runtimeHashes])) !== event.args.manifestHash) return fail('publication');
          manifest = String(event.args.manifestHash);
          if (String(event.args.components[0]).toLowerCase() === successor.kernel && String(event.args.components[8]).toLowerCase() === successor.pool) {
            publication ??= { block:log.blockNumber,logIndex:log.logIndex };
          }
        }
      }
    }
  }
  if (!activation || !publication || !beforeMembershipPosition(activation,publication)
    || revision !== next.revision || manifest !== next.manifestHash) return fail('activation');
  // Endpoint state is necessary even if providers omit every matching log.
  const settled = (await call(source.kernel,abi,'getBatchRecord',[batchId],cutoff.blockHash))[0][0];
  const cancelled = (await call(source.pool,RECOURSE_POOL_ABI,'cancelledIssuanceBatch',[batchId],cutoff.blockHash))[0];
  if (typeof settled !== 'boolean' || typeof cancelled !== 'boolean' || (settled && cancelled)) return fail('batch_state');
  if (snapshot[4] !== true) {
    const laterSettled = (await call(source.kernel,abi,'getBatchRecord',[batchId]))[0][0];
    const laterCancelled = (await call(source.pool,RECOURSE_POOL_ABI,'cancelledIssuanceBatch',[batchId]))[0];
    if (laterSettled !== settled || laterCancelled !== cancelled) return fail('ordinary_rollback');
  }
  if (await chain.blockHash(cutoff.block) !== cutoff.blockHash || await chain.blockHash(successor.block) !== successor.blockHash) return fail('reorg');
  const result: VerifiedIssuanceSuccession = Object.freeze({ pointer:pointer.toLowerCase(),batchId,cutoff:Object.freeze({ ...cutoff }),
    successor:Object.freeze({ ...successor }),afterBreak:snapshot[4] === true,manifestHash:manifest,previousManifestHash:before.manifestHash,settled,cancelled });
  verified.add(result); return result;
}
