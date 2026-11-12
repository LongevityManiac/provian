import { createHash } from 'crypto';
import { keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { createRecourseChainPort } from './chain-ledger';
import { standingMembershipDebitDigest, parseExactMembershipDebit, parseMembershipAuthorizationDomain,
  MEMBERSHIP_AUTHORIZATION_ABI, type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';
import { readMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';

export interface VerifiedDebitRevocation {
  readonly digest: string; readonly pool: string; readonly kernel: string; readonly pointer: string;
  readonly fromBlock: number; readonly fromBlockHash: string; readonly throughBlock: number; readonly throughBlockHash: string;
  readonly nonceBefore: string; readonly nonceAfter: string; readonly timestamp: number;
  readonly reason: 'nonce' | 'expired'; readonly evidenceHash: string;
}
const authentic = new WeakSet<object>();
export function assertDebitRevocation(proof: VerifiedDebitRevocation): void {
  if (!authentic.has(proof)) throw Error('recourse_debit_revocation_unverified');
}
const fail = (reason: string): never => { throw Error(`recourse_debit_revocation_${reason}`); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('reply');
  return value as Record<string, unknown>;
}
function height(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return fail('reply');
  const n = Number(BigInt(value)); return Number.isSafeInteger(n) ? n : fail('reply');
}
/** Leaving, key recovery, or an abandoned signature must not lock a private
 * owner forever. Reconcile the entire finalized nonce history first. A prior
 * execution returns its authentic receipt and must be credited; otherwise a
 * changed nonce or canonical timestamp past expiry proves permanent revocation.
 * Wall-clock elapsed time and a reverted transaction are never release proofs. */
export async function reconcileMembershipDebit(domainInput: MembershipAuthorizationDomain, debitInput: ExactMembershipDebit,
  checkpointInput: { readonly block: number; readonly blockHash: string }): Promise<
    { readonly kind: 'executed'; readonly receipt: VerifiedMembershipReceipt }
    | { readonly kind: 'revoked'; readonly proof: VerifiedDebitRevocation } | null> {
  const domain = parseMembershipAuthorizationDomain(domainInput), debit = parseExactMembershipDebit(debitInput);
  const checkpoint = { ...checkpointInput };
  const pointer = PROTOCOL_POINTER_PIN.address, pinHash = PROTOCOL_POINTER_PIN.runtimeHash;
  if (domain.chainId !== '8453' || !pointer || !pinHash || domain.pointer !== pointer.toLowerCase()
    || !Number.isSafeInteger(checkpoint.block) || checkpoint.block < 0 || !/^0x[0-9a-f]{64}$/.test(checkpoint.blockHash)) return fail('domain');
  const configured = getOperatorBoundRpcLegs('base');
  if (!configured[0].operatorId || !configured[1].operatorId || configured[0].operatorId === configured[1].operatorId) return fail('operators');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m, p) => configured[0].provider.send(m, [...p]) },
    { request: (m, p) => configured[1].provider.send(m, [...p]) }];
  const agreed = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const [a, b] = await Promise.all(rpcs.map(r => r.request(method, params)));
    if (!rpcChainFactsEqual(a, b)) return fail('disagreement'); return a;
  };
  const deployment = await resolveHistoricalProtocolDeployment(rpcs, pointer, pinHash, checkpoint.block, checkpoint.blockHash);
  if (deployment.addresses.recoursePool.toLowerCase() !== domain.pool || deployment.addresses.kernel.toLowerCase() !== domain.kernel
    || String(deployment.revision) !== debit.revision) return fail('domain');
  const chain = createRecourseChainPort(), throughBlock = await chain.finalizedBlock();
  if (throughBlock <= checkpoint.block) return null;
  const throughBlockHash = await chain.blockHash(throughBlock);
  if (!throughBlockHash) return fail('reorg');
  const pin = { blockHash: throughBlockHash, requireCanonical: true };
  const code = await agreed('eth_getCode', [domain.pool, pin]);
  if (typeof code !== 'string' || keccak256(code) !== deployment.runtimeHashes[8]) return fail('runtime');
  const header = object(await agreed('eth_getBlockByNumber', [`0x${throughBlock.toString(16)}`, false]));
  if (header.hash !== throughBlockHash || height(header.number) !== throughBlock) return fail('reorg');
  const timestamp = height(header.timestamp);
  const nonce = async (blockHash: string): Promise<bigint> => {
    const raw = await agreed('eth_call', [{ to: domain.pool, data: MEMBERSHIP_AUTHORIZATION_ABI.encodeFunctionData('debitNonce', [debit.binding]) },
      { blockHash, requireCanonical: true }]);
    if (typeof raw !== 'string') return fail('reply');
    return BigInt(MEMBERSHIP_AUTHORIZATION_ABI.decodeFunctionResult('debitNonce', raw)[0]);
  };
  const initial = await nonce(checkpoint.blockHash), final = await nonce(throughBlockHash);
  if (initial !== BigInt(debit.nonce) || final < initial) return fail('baseline');
  let cursor = initial, lastBlock = checkpoint.block, lastLog = -1, matched: string | null = null;
  const digest = standingMembershipDebitDigest(domain, debit), evidence: unknown[] = [];
  const topics = ['MembershipDebitExecuted', 'MembershipDebitCancelled', 'AddressConsentChanged']
    .map(name => MEMBERSHIP_AUTHORIZATION_ABI.getEvent(name)!.topicHash);
  for (let from = checkpoint.block + 1; from <= throughBlock; from += 500) {
    const logs = await getAgreedBaseLogs({ address: domain.pool, topics: [topics], fromBlock: from, toBlock: Math.min(from + 499, throughBlock) });
    for (const l of logs) {
      if (l.removed || l.address !== domain.pool || l.blockNumber < from || l.blockNumber > Math.min(from + 499, throughBlock)
        || l.blockNumber < lastBlock || (l.blockNumber === lastBlock && l.logIndex <= lastLog)) return fail('log_order');
      lastBlock = l.blockNumber; lastLog = l.logIndex;
      const event = MEMBERSHIP_AUTHORIZATION_ABI.parseLog({ topics: [...l.topics], data: l.data });
      if (!event || event.args.binding !== debit.binding) continue;
      if (event.name === 'AddressConsentChanged') continue;
      else if (BigInt(event.args.nonce) !== cursor) return fail('history_gap');
      ++cursor; evidence.push(l);
      if (event.name === 'MembershipDebitExecuted' && event.args.digest === digest) {
        if (matched !== null) return fail('execution_duplicate'); matched = l.transactionHash;
      }
    }
  }
  // Every successful debit, explicit cancellation, and leave increments this
  // monotonically. An omitted execution or revocation cannot pass this fence.
  if (cursor !== final) return fail('history_gap');
  if (await chain.blockHash(checkpoint.block) !== checkpoint.blockHash || await chain.blockHash(throughBlock) !== throughBlockHash) return fail('reorg');
  if (matched !== null) return { kind: 'executed', receipt: await readMembershipReceipt(matched, domain.pool) };
  if (final === initial && BigInt(timestamp) <= BigInt(debit.expiresAt)) return null;
  const result = Object.freeze({ digest, pool: domain.pool, kernel: domain.kernel, pointer: domain.pointer,
    fromBlock: checkpoint.block, fromBlockHash: checkpoint.blockHash, throughBlock, throughBlockHash,
    nonceBefore: String(initial), nonceAfter: String(final), timestamp, reason: final > initial ? 'nonce' as const : 'expired' as const,
    evidenceHash: `0x${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}` });
  authentic.add(result); return { kind: 'revoked', proof: result };
}
