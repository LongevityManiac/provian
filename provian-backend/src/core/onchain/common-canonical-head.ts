import { ethers } from 'ethers';

interface HeadRpcLeg {
  readonly operatorId: string;
  readonly send: (method: string, params: readonly unknown[]) => Promise<unknown>;
}

/** Equal tip quantities retain the inexpensive existing path. Different tips
 * are comparable only after BOTH operators bind the lower numeric height to
 * the same canonical hash. No chain fact is cached or taken from one operator. */
export async function readCommonCanonicalHead(
  legs: readonly [HeadRpcLeg, HeadRpcLeg],
  disagreement = 'canonical_head_rpc_disagreement',
): Promise<bigint> {
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('canonical_head_operators_not_independent');
  const parse = (raw: unknown): bigint => {
    if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(disagreement);
    const value = BigInt(raw);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(disagreement);
    return value;
  };
  const tips = await Promise.all(legs.map(leg => leg.send('eth_blockNumber', [])));
  const left = parse(tips[0]), right = parse(tips[1]);
  if (left === right) return left;
  const height = left < right ? left : right;
  const tag = ethers.toQuantity(height);
  const headers = await Promise.all(legs.map(leg => leg.send('eth_getBlockByNumber', [tag, false])));
  const project = (raw: unknown): string => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(disagreement);
    const header = raw as Record<string, unknown>;
    if (parse(header.number) !== height || typeof header.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(header.hash)) throw new Error(disagreement);
    return header.hash.toLowerCase();
  };
  if (project(headers[0]) !== project(headers[1])) throw new Error(disagreement);
  return height;
}
