import { Interface, keccak256 } from 'ethers';
import type { ProtocolDeployment, PointerRpc } from './protocol-pointer';
export interface RecoursePoolNetwork { readonly rpcs: readonly [PointerRpc, PointerRpc]; deployment(): Promise<ProtocolDeployment> }
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
const TOKEN = new Interface(['function restorationAuthority() view returns(address)']);
export interface RecoursePoolState {
  readonly pool: string; readonly kernel: string; readonly block: number; readonly blockHash: string; readonly timestamp: number;
  readonly addressConsent: boolean; readonly currentAddress: string; readonly month: string; readonly reserveAtomic: string;
  readonly consentNonce: string; readonly consentGeneration: string; readonly debitNonce: string;
  readonly outstandingAtomic: string; readonly authority: string;
  readonly participationBurnAtomic: string; readonly noEarningsContributionAtomic: string; readonly earningsBps: number;
  readonly signedRuleHash: string;
  readonly outcomeRevision: string;
}


/** Independent address consent and reserve view, usable during a relay outage.
 * Owner-wide membership, grace and invoices are private relay records; this
 * public view never infers them from one address's consent or balance. */
export async function readRecoursePoolChain(identity: string, network: RecoursePoolNetwork): Promise<RecoursePoolState> {
  if (!/^0x[0-9a-f]{64}$/.test(identity)) throw new Error('recourse_identity_invalid');
  const deployment = await network.deployment();
  const config = { address: deployment.addresses.recoursePool.toLowerCase(), runtimeHash: deployment.runtimeHashes[8].toLowerCase() };
  const kernel = deployment.addresses.kernel.toLowerCase();
  const blockHash = deployment.blockHash, tag = { blockHash, requireCanonical: true };
  const values = await Promise.all(network.rpcs.map(async rpc => {
    const code: unknown = await rpc.request('eth_getCode', [config.address, tag]);
    if (typeof code !== 'string' || keccak256(code) !== config.runtimeHash) throw new Error('recourse_pool_runtime_mismatch');
    const call = async (method: string, args: readonly unknown[] = []) => {
      const raw: unknown = await rpc.request('eth_call', [{ to: config.address,
        data: RECOURSE_POOL_ABI.encodeFunctionData(method, args) }, tag]);
      if (typeof raw !== 'string') throw new Error('recourse_pool_reply_invalid');
      return RECOURSE_POOL_ABI.decodeFunctionResult(method, raw);
    };
    const rawBlock: unknown = await rpc.request('eth_getBlockByHash', [blockHash, false]);
    if (!rawBlock || typeof rawBlock !== 'object' || !('hash' in rawBlock) || rawBlock.hash !== blockHash
      || !('number' in rawBlock) || typeof rawBlock.number !== 'string' || !/^0x[0-9a-f]+$/i.test(rawBlock.number)
      || !('timestamp' in rawBlock) || typeof rawBlock.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(rawBlock.timestamp)) throw new Error('recourse_pool_block_unavailable');
    const block = Number(BigInt(rawBlock.number)), timestamp = Number(BigInt(rawBlock.timestamp));
    if (!Number.isSafeInteger(block) || !Number.isSafeInteger(timestamp)) throw new Error('recourse_pool_block_unavailable');
    const month = BigInt((await call('calendarMonth', [BigInt(rawBlock.timestamp)]))[0]);
    const [token, consent, debitNonce, primary, outstanding, revision, ruleResult, available, ready] = await Promise.all([
      call('token'), call('addressConsent', [identity]), call('debitNonce', [identity]), call('consentAccount', [identity]),
      call('allocatedRestorations'), call('outcomeRevision', [identity]), call('monthlyRule', [month]),
      call('availableReserve'), call('poolHistoryReady'),
    ]);
    if (String(token[0]).toLowerCase() !== kernel) throw new Error('recourse_pool_token_mismatch');
    if (ready[0] !== true) throw Error('recourse_pool_history_pending');
    const rule = ruleResult[0];
    const authorityRaw: unknown = await rpc.request('eth_call', [{ to: kernel,
      data: TOKEN.encodeFunctionData('restorationAuthority') }, tag]);
    if (typeof authorityRaw !== 'string') throw new Error('recourse_pool_reply_invalid');
    const authority = String(TOKEN.decodeFunctionResult('restorationAuthority', authorityRaw)[0]).toLowerCase();
    return { pool: config.address, kernel, block, blockHash, timestamp, addressConsent: Boolean(consent[2]),
      consentNonce: String(consent[0]), consentGeneration: String(consent[1]), debitNonce: String(debitNonce[0]),
      currentAddress: String(primary[0]).toLowerCase(), month: String(month),
      reserveAtomic: String(available[0]), outstandingAtomic: String(outstanding[0]), authority,
      outcomeRevision: String(revision[0]), participationBurnAtomic: String(rule[1]), noEarningsContributionAtomic: String(rule[2]),
      earningsBps: Number(rule[3]), signedRuleHash: String(rule[4]) };

  }));

  if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) throw new Error('recourse_pool_rpc_disagreement');
  for (const rpc of network.rpcs) {
    const canonical = await rpc.request('eth_getBlockByNumber', [`0x${values[0].block.toString(16)}`, false]);
    if (!canonical || typeof canonical !== 'object' || !('hash' in canonical) || canonical.hash !== blockHash) throw new Error('recourse_pool_reorg');
  }
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_pool_deployment_changed');
  return values[0];
}
