import { Interface, keccak256 } from 'ethers';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
const TOKEN = new Interface(['function restorationAuthority() view returns(address)']);
export interface RecoursePoolState {
  readonly pool: string; readonly kernel: string; readonly block: number; readonly blockHash: string;
  readonly enrolled: boolean; readonly contributionAddress: string; readonly month: string;
  readonly issuedInMonth: boolean; readonly unpaidAtomic: string; readonly reserveAtomic: string;
  readonly outstandingAtomic: string; readonly authority: string;
  readonly grace: boolean; readonly membershipGeneration: string; readonly endMonthExclusive: string;
  readonly participationBurnAtomic: string; readonly noEarningsContributionAtomic: string; readonly earningsBps: number;
  readonly signedRuleHash: string; readonly reserveShares: string; readonly redeemableAtomic: string;
  readonly invoices: readonly { month: string; burnDueAtomic: string; contributionDueAtomic: string; burnPaidAtomic: string; contributionPaidAtomic: string }[];
  readonly outcomeRevision: string;
}


/** Independent chain view, usable during a relay outage, including the exact
 * remaining reserve interest for permissionless redemption. */
export async function readRecoursePoolChain(identity: string, network: OwnerChainNetwork): Promise<RecoursePoolState> {
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
    const block = Number(BigInt(rawBlock.number));
    if (!Number.isSafeInteger(block)) throw new Error('recourse_pool_block_unavailable');
    const month = BigInt((await call('calendarMonth', [BigInt(rawBlock.timestamp)]))[0]);
    const [token, member, episode, primary, outstanding, revision, ruleResult, reserveGeneration, totalShares, backing, available] = await Promise.all([
      call('token'), call('membershipState', [identity]), call('enrollment', [identity]), call('primaryAddress', [identity]),
      call('allocatedRestorations'), call('outcomeRevision', [identity]), call('monthlyRule', [month]),
      call('reserveGeneration'), call('totalReserveShares'), call('accountedBacking'), call('availableReserve'),
    ]);
    if (String(token[0]).toLowerCase() !== kernel) throw new Error('recourse_pool_token_mismatch');
    const rule = ruleResult[0];
    const shares = BigInt((await call('reserveShares', [reserveGeneration[0], identity]))[0]);
    const authorityRaw: unknown = await rpc.request('eth_call', [{ to: kernel,
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
      earningsBps: Number(rule[3]), signedRuleHash: String(rule[4]), reserveShares: String(shares),
      redeemableAtomic: totalShares[0] === 0n ? '0' : String(shares * BigInt(backing[0]) / BigInt(totalShares[0])), invoices };

  }));

  if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) throw new Error('recourse_pool_rpc_disagreement');
  for (const rpc of network.rpcs) {
    const canonical = await rpc.request('eth_getBlockByNumber', [`0x${values[0].block.toString(16)}`, false]);
    if (!canonical || typeof canonical !== 'object' || !('hash' in canonical) || canonical.hash !== blockHash) throw new Error('recourse_pool_reorg');
  }
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_pool_deployment_changed');
  return values[0];
}
