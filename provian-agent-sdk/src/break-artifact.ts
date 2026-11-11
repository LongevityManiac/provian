import { AbiCoder, concat, sha256 } from 'ethers';
import { verifyBreakEntitlement, type BreakEntitlement } from './break-entitlement.js';

export interface BreakArtifactDomain { readonly predecessor: string; readonly block: number; readonly root: string; }
export interface BreakInstitutionEntitlement {
  readonly source: string; readonly destination: string; readonly amount: string;
  readonly runtimeHash: string; readonly proof: readonly string[];
}
export interface VerifiedBreakArtifact {
  readonly domain: BreakArtifactDomain;
  /** Aggregate proofs only. accounts[] and signingRoot are not committed by an
   * owner leaf and are intentionally absent from this result. */
  readonly owners: readonly BreakEntitlement[];
  readonly institutions: readonly BreakInstitutionEntitlement[];
}
const coder = AbiCoder.defaultAbiCoder(), hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-fA-F]{40}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_artifact_invalid');
  return value as Record<string, unknown>;
}
function word(value: unknown): string {
  if (typeof value !== 'string' || !hash.test(value) || /^0x0+$/.test(value)) throw Error('break_artifact_word_invalid');
  return value;
}
function account(value: unknown): string {
  if (typeof value !== 'string' || !address.test(value) || /^0x0+$/.test(value)) throw Error('break_artifact_address_invalid');
  return value.toLowerCase();
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= (1n << 256n)) throw Error('break_artifact_amount_invalid');
  return BigInt(value);
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('break_artifact_count_invalid');
  return value;
}
/** Reconstruct the COMPLETE committed leaf set. A valid individual proof cannot
 * prove another binding absent; only the complete root reconstruction permits
 * that conclusion. Domain values must come from authenticated immutable chain
 * state. This does not authenticate the per-address balance partition. */
export function verifyBreakArtifact(value: unknown, domain: BreakArtifactDomain): VerifiedBreakArtifact {
  const row = record(value), predecessor = account(domain.predecessor), root = word(domain.root);
  if (!Number.isSafeInteger(domain.block) || domain.block < 1 || row.format !== 'provian-break-ownership-snapshot'
    || account(row.predecessor) !== predecessor || row.block !== domain.block || row.root !== root
    || !Array.isArray(row.entries) || row.entries.length === 0) throw Error('break_artifact_domain_invalid');
  const leaves: string[] = [], owners: BreakEntitlement[] = [], identities = new Set<string>(), requests = new Set<string>();
  const institutions = new Set<string>(), destinations = new Set<string>(), historyIdentities = new Set<string>();
  let institutionCount: number | null = null, institutionAmount: bigint | null = null, historyCount: number | null = null;
  let institutionalBalance = 0n;
  const institutionEntries: BreakInstitutionEntitlement[] = [];
  const encode = (label: string, types: readonly string[], values: readonly unknown[]): string => sha256(coder.encode(
    ['string', 'address', 'uint256', ...types], [label, predecessor, domain.block, ...values]));
  for (const item of row.entries) {
    const entry = record(item);
    let leaf: string;
    let institution: Omit<BreakInstitutionEntitlement, 'proof'> | null = null;
    if (entry.kind === 'owner') {
      const owner = verifyBreakEntitlement({ identity: entry.identity, amount: entry.amount, commitment: entry.commitment, proof: entry.proof },
        predecessor, BigInt(domain.block), root);
      if (identities.has(owner.identity)) throw Error('break_artifact_duplicate_owner');
      identities.add(owner.identity); owners.push(Object.freeze({ ...owner, proof: Object.freeze([...owner.proof]) }));
      leaf = encode('Provian restoration', ['bytes32', 'uint256', 'bytes32'], [owner.identity, owner.amount, owner.commitment]);
    } else if (entry.kind === 'institution') {
      const source = account(entry.source), destination = account(entry.destination), amount = quantity(entry.amount);
      if (source === destination || institutions.has(source) || destinations.has(destination) || amount === 0n) throw Error('break_artifact_institution_invalid');
      institutions.add(source); destinations.add(destination); institutionalBalance += amount;
      institution = { source, destination, amount: amount.toString(), runtimeHash: word(entry.runtimeHash) };
      leaf = encode('Provian institution restoration', ['address', 'address', 'uint256', 'bytes32'], [source, destination, amount, institution.runtimeHash]);
    } else if (entry.kind === 'institution-count') {
      if (institutionCount !== null) throw Error('break_artifact_duplicate_count');
      institutionCount = count(entry.count); institutionAmount = quantity(entry.amount);
      leaf = encode('Provian institution restoration count', ['uint256', 'uint256'], [institutionCount, institutionAmount]);
    } else if (entry.kind === 'reversal' || entry.kind === 'intent') {
      const request = word(entry.request), identity = word(entry.identity);
      if (requests.has(request)) throw Error('break_artifact_duplicate_request');
      requests.add(request); historyIdentities.add(identity);
      if (entry.kind === 'reversal') leaf = encode('Provian reversal history', ['bytes32', 'bytes32', 'uint256', 'bytes32'],
        [request, identity, quantity(entry.shortfall), word(entry.evidenceHash)]);
      else {
        const maximum = quantity(entry.maximumLoss);
        if (maximum === 0n) throw Error('break_artifact_intent_invalid');
        leaf = encode('Provian pending restoration intent', ['tuple(bytes32,bytes32,address,bytes32,uint256)'],
          [[request, identity, account(entry.destination), word(entry.lossHash), maximum]]);
      }
    } else if (entry.kind === 'reversal-count') {
      if (historyCount !== null) throw Error('break_artifact_duplicate_count');
      historyCount = count(entry.count); leaf = encode('Provian reversal history count', ['uint256'], [historyCount]);
    } else throw Error('break_artifact_kind_invalid');
    if (entry.leaf !== leaf || !Array.isArray(entry.proof) || entry.proof.length > 256
      || !entry.proof.every((sibling: unknown) => typeof sibling === 'string' && hash.test(sibling))) throw Error('break_artifact_proof_invalid');
    let proved = leaf;
    for (const sibling of entry.proof as string[]) proved = sha256(concat([proved, sibling].sort()));
    if (proved !== root) throw Error('break_artifact_proof_invalid');
    if (institution) institutionEntries.push(Object.freeze({ ...institution, proof: Object.freeze([...(entry.proof as string[])]) }));
    leaves.push(leaf);
  }
  if (identities.size === 0 || new Set(leaves).size !== leaves.length || institutionCount !== institutions.size
    || institutionAmount !== institutionalBalance || historyCount !== requests.size
    || [...historyIdentities].some(identity => !identities.has(identity))
    || [...destinations].some(destination => institutions.has(destination))) throw Error('break_artifact_incomplete');
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(index + 1 === level.length
      ? level[index] : sha256(concat([level[index], level[index + 1]].sort())));
    level = next;
  }
  if (level[0] !== root) throw Error('break_artifact_incomplete');
  return Object.freeze({ domain: Object.freeze({ predecessor, block: domain.block, root }), owners: Object.freeze(owners), institutions: Object.freeze(institutionEntries) });
}
