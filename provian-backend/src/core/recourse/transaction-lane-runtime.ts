import { randomUUID } from 'crypto';
import { Interface, Transaction, keccak256, type TransactionLike, type TransactionRequest } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { estimateBaseTransactionFees } from './base-transaction-fees';
import { finalizedOwnerTransaction } from './transaction-finality';
import { configuredIdentityAttestor } from './identity-attestor';
import { breakDeploymentChain } from './break-deployment-queue';
import { assertLaneKeyPinned, recourseLaneWallet } from './transaction-lane-key';
import { recourseLaneKinds } from './transaction-lane-kinds';
import { anyQueued, runRecourseLane, type LaneChain, type LaneReport } from './transaction-lane';
import type { OwnerOperationChain } from './owner-operation-queue';

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw Error('recourse_lane_rpc_invalid');
  return BigInt(value);
}
/** Replies that mean the exact bytes are already known to, or already mined on, the network. */
const KNOWN = /already known|known transaction|nonce too low|already imported|transaction already exists/i;

/** Base reads through both independent operators; any disagreement refuses. */
export function createLaneChain(): LaneChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const both = (method: string, params: readonly unknown[]) => Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
  let quoteBlock: { hash: string; atMs: number } | null = null;
  const agreedBlockHash = async (): Promise<string> => {
    if (quoteBlock && Date.now() - quoteBlock.atMs < 10_000) return quoteBlock.hash;
    const hash = await readAgreedBaseBlockHash(await readAgreedBaseHead());
    if (!hash) throw Error('recourse_lane_block_unavailable');
    quoteBlock = { hash, atMs: Date.now() };
    return hash;
  };
  return {
    async nonces(address) {
      const [latest, pending] = await Promise.all([both('eth_getTransactionCount', [address, 'latest']),
        both('eth_getTransactionCount', [address, 'pending'])]);
      const l = latest.map(quantity), p = pending.map(quantity);
      const low = l[0] < l[1] ? l[0] : l[1], high = [...l, ...p].reduce((a, b) => a > b ? a : b);
      if (high > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('recourse_lane_rpc_invalid');
      return { latest: Number(low), pending: Number(high) };
    },
    async baseFee() {
      const hash = await agreedBlockHash();
      const blocks = await both('eth_getBlockByHash', [hash, false]) as Array<Record<string, unknown> | null>;
      const fees = blocks.map(block => quantity(block?.baseFeePerGas));
      if (blocks.some(block => block?.hash !== hash) || fees[0] !== fees[1]) throw Error('recourse_lane_rpc_disagreement');
      return fees[0];
    },
    async estimateGas(from, to, data) {
      const values = (await both('eth_estimateGas', [{ from, to, data, value: '0x0' }, 'latest'])).map(quantity);
      return values[0] > values[1] ? values[0] : values[1];
    },
    async cost(unsigned: TransactionRequest) {
      const hash = await agreedBlockHash();
      return (await estimateBaseTransactionFees(legs.map(leg => ({ operatorId: leg.operatorId,
        request: (method, params) => leg.provider.send(method, [...params]) })), Transaction.from(unsigned as TransactionLike<string>), hash)).totalEstimateWei;
    },
    async balance(address) {
      const values = (await both('eth_getBalance', [address, 'latest'])).map(quantity);
      return values[0] < values[1] ? values[0] : values[1];
    },
    async broadcast(raw) {
      const hash = keccak256(raw);
      const results = await Promise.allSettled(legs.map(leg => leg.provider.send('eth_sendRawTransaction', [raw])));
      const accepted = results.some(result => result.status === 'fulfilled' && result.value === hash
        || result.status === 'rejected' && KNOWN.test(String((result.reason as Error)?.message ?? result.reason)));
      if (!accepted) throw Error('recourse_lane_broadcast_failed');
    },
    confirmed: raw => finalizedOwnerTransaction(raw),
  };
}

const ROLES = new Interface(['function submitter() view returns(address)', 'function restorationAuthority() view returns(address)',
  'function operationalMinter() view returns(address)', 'function registryOperator() view returns(address)',
  'function identityAttestor() view returns(address)']);
/** One writer per key: the lane key may hold no protocol role and may not be the settlement submitter. */
export async function assertLaneKeyHasNoRole(address: string, chain: OwnerOperationChain = breakDeploymentChain()): Promise<void> {
  const deployment = await chain.deployment(), pin = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, name: string): Promise<string> => {
    const raw = await chain.agree('eth_call', [{ to, data: ROLES.encodeFunctionData(name) }, pin]);
    if (typeof raw !== 'string') throw Error('recourse_lane_rpc_invalid');
    return String(ROLES.decodeFunctionResult(name, raw)[0]).toLowerCase();
  };
  const kernel = deployment.addresses.kernel.toLowerCase(), settlement = deployment.addresses.settlement.toLowerCase();
  const registry = await call(kernel, 'registryOperator');
  const roles = await Promise.all([call(settlement, 'submitter'), call(kernel, 'restorationAuthority'),
    call(kernel, 'operationalMinter'), call(registry, 'identityAttestor')]);
  if (roles.includes(address.toLowerCase())) throw Error('recourse_lane_key_shared');
}

export interface LaneRunOptions { readonly budgetMs: number; readonly env?: NodeJS.ProcessEnv; }
/** Run the lane until the budget ends. After each run the queue is checked
 * again, so a request queued while another worker held the lane is sent by
 * whichever worker releases it last. A busy lane returns at once. */
export async function runRecourseLaneFor(db: Firestore, options: LaneRunOptions): Promise<LaneReport[]> {
  const env = options.env ?? process.env, deadline = Date.now() + options.budgetMs;
  const wallet = recourseLaneWallet(env), address = wallet.address.toLowerCase();
  assertLaneKeyPinned(address, env);
  const kinds = recourseLaneKinds(db, configuredIdentityAttestor(env));
  let chain: LaneChain | null = null, fenced = false;
  const reports: LaneReport[] = [];
  while (Date.now() < deadline) {
    chain ??= createLaneChain();
    const report = await runRecourseLane({ db, signer: wallet, chain, kinds, workerId: `recourse-lane-${randomUUID()}`,
      fence: async () => { if (!fenced) { await assertLaneKeyHasNoRole(address); fenced = true; } } }, deadline);
    reports.push(report);
    // Run again only after progress, so a request that keeps failing transiently cannot spin the budget.
    const progressed = report.signed + report.closedUnsigned > 0;
    if (report.skipped || report.stopReason !== null || !progressed || !(await anyQueued(db, kinds))) break;
  }
  return reports;
}
/** A request handler's inline attempt. Never throws; the scheduler resumes it. */
export async function kickRecourseLane(db: Firestore, budgetMs = 6_000): Promise<void> {
  try { await runRecourseLaneFor(db, { budgetMs }); }
  catch (error) { console.warn('[recourse-lane] inline run deferred:', error instanceof Error ? error.message : 'error'); }
}
