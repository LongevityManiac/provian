import { AbiCoder, ZeroHash, concat, sha256 } from 'ethers';

export interface BreakEntitlement {
  readonly identity: string; readonly amount: string; readonly commitment: string; readonly proof: readonly string[];
}
export function parseBreakEntitlement(value: unknown): BreakEntitlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_entitlement_invalid');
  const row = value as Record<string, unknown>, hash = /^0x[0-9a-f]{64}$/;
  if (Object.keys(row).sort().join(',') !== 'amount,commitment,identity,proof'
    || typeof row.identity !== 'string' || !hash.test(row.identity) || row.identity === ZeroHash
    || typeof row.commitment !== 'string' || !hash.test(row.commitment) || row.commitment === ZeroHash
    || typeof row.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.amount) || BigInt(row.amount) >= 2n ** 256n
    || !Array.isArray(row.proof) || row.proof.length > 256 || !row.proof.every(p => typeof p === 'string' && hash.test(p))) {
    throw Error('break_entitlement_invalid');
  }
  return { identity: row.identity, amount: row.amount, commitment: row.commitment, proof: [...row.proof] };
}
/** The downloaded document is only a Merkle witness. Its root and cutoff must
 * come from independently read immutable break-origin state. */
export function verifyBreakEntitlement(value: unknown, predecessor: string, cutoff: bigint, root: string): BreakEntitlement {
  const e = parseBreakEntitlement(value);
  if (!/^0x[0-9a-f]{40}$/.test(predecessor) || /^0x0+$/.test(predecessor) || cutoff <= 0n || cutoff >= 2n ** 256n
    || !/^0x[0-9a-f]{64}$/.test(root)) throw Error('break_entitlement_domain_invalid');
  let leaf = sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32','uint256','bytes32'],
    ['Provian restoration', predecessor, cutoff, e.identity, e.amount, e.commitment]));
  for (const sibling of e.proof) leaf = sha256(concat(leaf < sibling ? [leaf, sibling] : [sibling, leaf]));
  if (leaf !== root) throw Error('break_entitlement_proof_invalid');
  return e;
}
