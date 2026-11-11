import { Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';

import { RECOURSE_POOL_ABI } from './pool-abi';
export { RECOURSE_POOL_ABI } from './pool-abi';
const TOKEN = new Interface(['function balanceOf(address) view returns (uint256)', 'function restorationAuthority() view returns(address)']);

export interface RecoursePoolConfig { readonly address: string; readonly runtimeHash: string }
export async function recoursePoolConfig(): Promise<RecoursePoolConfig> {
  const deployment = await currentProtocolDeployment();
  return { address: deployment.addresses.recoursePool.toLowerCase(), runtimeHash: deployment.runtimeHashes[8].toLowerCase() };
}

export interface RecoursePoolState {
  readonly pool: string; readonly kernel: string; readonly block: number; readonly blockHash: string;
  readonly enrolled: boolean; readonly contributionAddress: string; readonly month: string;
  readonly issuedInMonth: boolean; readonly unpaidAtomic: string; readonly reserveAtomic: string;
  readonly outstandingAtomic: string; readonly authority: string;
  readonly grace: boolean; readonly membershipGeneration: string; readonly endMonthExclusive: string;
  readonly participationBurnAtomic: string; readonly noEarningsContributionAtomic: string; readonly earningsBps: number;
  readonly signedRuleHash: string;
  readonly invoices: readonly { month: string; burnDueAtomic: string; contributionDueAtomic: string; burnPaidAtomic: string; contributionPaidAtomic: string }[];
  readonly outcomeRevision: string;
}

/** All amounts come from the same agreed block. A configured address alone never
 * authorizes a client approval: runtime bytes and the canonical token are checked. */
export async function readRecoursePoolState(identity: string): Promise<RecoursePoolState> {
  if (!/^0x[0-9a-f]{64}$/.test(identity)) throw new Error('recourse_identity_invalid');
  const deployment = await currentProtocolDeployment();
  const config = { address: deployment.addresses.recoursePool.toLowerCase(), runtimeHash: deployment.runtimeHashes[8].toLowerCase() };
  const kernel = deployment.addresses.kernel.toLowerCase();
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const block = await readAgreedBaseHead();
  const blockHash = await readAgreedBaseBlockHash(block);
  if (!blockHash) throw new Error('recourse_pool_block_unavailable');
  const tag = { blockHash, requireCanonical: true };
  const values = await Promise.all(legs.map(async leg => {
    const code: unknown = await leg.provider.send('eth_getCode', [config.address, tag]);
    if (typeof code !== 'string' || keccak256(code) !== config.runtimeHash) throw new Error('recourse_pool_runtime_mismatch');
    const call = async (method: string, args: readonly unknown[] = []) => {
      const raw: unknown = await leg.provider.send('eth_call', [{ to: config.address,
        data: RECOURSE_POOL_ABI.encodeFunctionData(method, args) }, tag]);
      if (typeof raw !== 'string') throw new Error('recourse_pool_reply_invalid');
      return RECOURSE_POOL_ABI.decodeFunctionResult(method, raw);
    };
    const rawBlock: unknown = await leg.provider.send('eth_getBlockByHash', [blockHash, false]);
    if (!rawBlock || typeof rawBlock !== 'object' || !('hash' in rawBlock) || rawBlock.hash !== blockHash
      || !('timestamp' in rawBlock) || typeof rawBlock.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(rawBlock.timestamp)) throw new Error('recourse_pool_block_unavailable');
    const month = BigInt((await call('calendarMonth', [BigInt(rawBlock.timestamp)]))[0]);
    const [token, member, episode, primary, outstanding, revision, ruleResult, available] = await Promise.all([
      call('token'), call('membershipState', [identity]), call('enrollment', [identity]), call('primaryAddress', [identity]),
      call('allocatedRestorations'), call('outcomeRevision', [identity]), call('monthlyRule', [month]),
      call('availableReserve'),
    ]);
    if (String(token[0]).toLowerCase() !== kernel) throw new Error('recourse_pool_token_mismatch');
    const rule = ruleResult[0];
    const authorityRaw: unknown = await leg.provider.send('eth_call', [{ to: kernel,
      data: TOKEN.encodeFunctionData('restorationAuthority') }, tag]);
    if (typeof authorityRaw !== 'string') throw new Error('recourse_pool_reply_invalid');
    const authority = String(TOKEN.decodeFunctionResult('restorationAuthority', authorityRaw)[0]).toLowerCase();
    const generation = BigInt(episode[5]);
    const invoices: Array<{ month: string; burnDueAtomic: string; contributionDueAtomic: string; burnPaidAtomic: string; contributionPaidAtomic: string }> = [];
    let unpaid = 0n, issuedInMonth = false;
    if (generation !== 0n) {
      const end = episode[0] ? month : BigInt(episode[2]);
      const expiry = BigInt(member[3]);
      for (let m = BigInt(episode[3]); m <= end && (expiry === 0n || m < expiry); ++m) {
        const invoice = await call('obligations', [identity, generation, m]);
        const monthly = invoice[0] ? null : (await call('monthlyRule', [m]))[0];
        const burnDue = BigInt(invoice[0] ? invoice[2] : monthly[1]);
        const reserveDue = invoice[1] || m === month ? BigInt(invoice[3]) : BigInt(invoice[0] ? invoice[6] : monthly[2]);
        const burnPaid = BigInt(invoice[4]), reservePaid = BigInt(invoice[5]);
        if (burnPaid > burnDue || reservePaid > reserveDue) throw new Error('recourse_pool_invoice_invalid');
        unpaid += burnDue - burnPaid + reserveDue - reservePaid;
        if (m === month) issuedInMonth = Boolean(invoice[1]);
        invoices.push({ month: String(m), burnDueAtomic: String(burnDue), contributionDueAtomic: String(reserveDue),
          burnPaidAtomic: String(burnPaid), contributionPaidAtomic: String(reservePaid) });
      }
    }
    return { pool: config.address, kernel, block, blockHash, enrolled: Boolean(member[0]), grace: Boolean(member[1]),
      membershipGeneration: String(member[2]), endMonthExclusive: String(member[3]),
      contributionAddress: String(primary[0]).toLowerCase(), month: String(month), issuedInMonth,
      unpaidAtomic: String(unpaid), reserveAtomic: String(available[0]), outstandingAtomic: String(outstanding[0]), authority,
      outcomeRevision: String(revision[0]), participationBurnAtomic: String(rule[1]), noEarningsContributionAtomic: String(rule[2]),
      earningsBps: Number(rule[3]), signedRuleHash: String(rule[4]), invoices };

  }));
  if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) throw new Error('recourse_pool_rpc_disagreement');
  if (await readAgreedBaseBlockHash(block) !== blockHash) throw new Error('recourse_pool_reorg');
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_pool_deployment_changed');
  return values[0];
}
