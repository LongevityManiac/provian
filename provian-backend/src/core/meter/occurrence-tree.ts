import { createHash } from 'crypto';

export const BATCH_OCCURRENCES_COLLECTION = 'meter_occurrence_sets_v1';
/** Packed binary leaves leave room for encryption metadata beneath Firestore's 1 MiB limit. */
export const OCCURRENCE_LEAF_LIMIT = 28_000;
export interface OccurrenceNode {
  actor_id: string;
  prefix: string;
  revision: number;
  split: boolean;
  fingerprints?: Buffer;
  /** Read compatibility only; new writes carry binary fingerprints. */
  members?: string[];
}
export function occurrenceNodeId(actor: string, prefix: string): string {
  return `${createHash('sha256').update(actor).digest('hex')}_${prefix || 'root'}`;
}
export function unpackFingerprints(bytes: Buffer): string[] {
  if (bytes.length % 32 !== 0) throw new Error('meter_fingerprint_bytes_invalid');
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) out.push(bytes.subarray(i, i + 32).toString('hex'));
  for (let i = 1; i < out.length; i++) if (out[i - 1] >= out[i]) throw new Error('meter_fingerprints_not_unique_sorted');
  return out;
}
export function packFingerprints(members: Iterable<string>): Buffer {
  return Buffer.concat([...members].sort().map(member => {
    if (!/^[a-f0-9]{64}$/.test(member)) throw new Error('meter_fingerprint_invalid');
    return Buffer.from(member, 'hex');
  }));
}
export function nodeMembers(node: OccurrenceNode, actor: string, prefix: string): string[] {
  if (node.actor_id !== actor || node.prefix !== prefix || !Number.isSafeInteger(node.revision)
    || node.revision < 0 || typeof node.split !== 'boolean') throw new Error('meter_occurrence_set_invalid');
  const members = node.fingerprints !== undefined ? unpackFingerprints(Buffer.from(node.fingerprints)) : node.members;
  if (!Array.isArray(members) || members.some(m => typeof m !== 'string' || !/^[a-f0-9]{64}$/.test(m) || !m.startsWith(prefix))
    || node.split && members.length > 0) throw new Error('meter_occurrence_set_invalid');
  return members;
}
export function buildOccurrenceTree(actor: string, members: readonly string[], prefix = ''): OccurrenceNode[] {
  const split = members.length > OCCURRENCE_LEAF_LIMIT;
  const node = { actor_id: actor, prefix, revision: 1, split, fingerprints: packFingerprints(split ? [] : members) };
  return split ? [node, ...[...'0123456789abcdef'].flatMap(digit => buildOccurrenceTree(actor, members.filter(m => m.startsWith(prefix + digit)), prefix + digit))] : [node];
}
