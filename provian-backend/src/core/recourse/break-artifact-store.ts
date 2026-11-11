import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyBreakArtifact, type VerifiedBreakArtifact } from './break-artifact';
import { readRestorationSuccessionLineage, type RestorationSuccessionLineage } from './restoration-lineage';

export const BREAK_ARTIFACTS = 'recourse_break_artifacts_v1';
const chunkSize = 192_000; // Storage transport bound, not a member/portfolio limit.
const digest = (text: string): string => `0x${createHash('sha256').update(text).digest('hex')}`;
const hash = /^0x[0-9a-f]{64}$/;
function originId(origin: string): string {
  if (!/^0x[0-9a-f]{40}$/.test(origin) || /^0x0+$/.test(origin)) throw Error('break_artifact_origin_invalid');
  return origin.slice(2);
}
type LineageReader = (predecessor: string) => Promise<RestorationSuccessionLineage>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_artifact_record_invalid');
  return value as Record<string, unknown>;
}
/** The supplied predecessor is only a lookup candidate. The current pointer's
 * immutable ancestry must actually contain this exact break origin. */
export async function authenticateBreakArtifact(origin: string, value: unknown,
  lineage: LineageReader = readRestorationSuccessionLineage): Promise<VerifiedBreakArtifact> {
  originId(origin);
  const row = object(value);
  if (typeof row.predecessor !== 'string') throw Error('break_artifact_record_invalid');
  const chain = await lineage(row.predecessor.toLowerCase());
  const migration = chain.migrations.find(item => item.executor === origin);
  if (!migration || migration.kind !== 'cryptographic_break') throw Error('break_artifact_origin_unrelated');
  return verifyBreakArtifact(value, { predecessor: migration.predecessor, block: migration.cutoff, root: migration.root });
}
/** Retain committed fields only. Neither unpublished account lists nor any
 * arbitrary additional file metadata belongs in the artifact store. */
function canonicalArtifact(value: unknown, checked: VerifiedBreakArtifact): string {
  const row = object(value);
  if (!Array.isArray(row.entries)) throw Error('break_artifact_record_invalid');
  const fields: Readonly<Record<string, readonly string[]>> = {
    owner: ['identity', 'amount', 'commitment'], institution: ['source', 'destination', 'amount', 'runtimeHash'],
    'institution-count': ['count', 'amount'], reversal: ['request', 'identity', 'shortfall', 'evidenceHash'],
    intent: ['request', 'identity', 'destination', 'lossHash', 'maximumLoss'], 'reversal-count': ['count'],
  };
  const entries = row.entries.map(value => {
    const entry = object(value), kind = entry.kind;
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(fields, kind)) throw Error('break_artifact_kind_invalid');
    return Object.fromEntries(['kind', ...fields[kind], 'leaf', 'proof'].map(key => [key, entry[key]]));
  });
  return JSON.stringify({ format: 'provian-break-ownership-snapshot', ...checked.domain, entries });
}
/** Chunked immutable publication: readers see the manifest only after every
 * chunk exists. Retries compare exact bytes; incomplete writes confer nothing.
 * The private-store boundary encrypts both chunks and the origin identifier. */
export async function storeBreakArtifact(db: Firestore, origin: string, value: unknown,
  lineage: LineageReader = readRestorationSuccessionLineage): Promise<void> {
  const id = originId(origin), checked = await authenticateBreakArtifact(origin, value, lineage);
  const payload = canonicalArtifact(value, checked), payloadHash = digest(payload);
  const chunks = Math.ceil(payload.length / chunkSize), collection = db.collection(BREAK_ARTIFACTS);
  for (let index = 0; index < chunks; index++) {
    const text = payload.slice(index * chunkSize, (index + 1) * chunkSize);
    const ref = collection.doc(`${id}_${payloadHash.slice(2)}_${index}`);
    await db.runTransaction(async tx => {
      const prior = await tx.get(ref);
      if (prior.exists) {
        if (prior.get('origin') !== origin || prior.get('payloadHash') !== payloadHash || prior.get('index') !== index
          || prior.get('text') !== text) throw Error('break_artifact_chunk_conflict');
      } else tx.create(ref, { origin, payloadHash, index, text });
    });
  }
  await authenticateBreakArtifact(origin, JSON.parse(payload) as unknown, lineage);
  const manifest = collection.doc(id);
  await db.runTransaction(async tx => {
    const prior = await tx.get(manifest);
    if (prior.exists) {
      if (prior.get('origin') !== origin || prior.get('payloadHash') !== payloadHash || prior.get('chunks') !== chunks) throw Error('break_artifact_manifest_conflict');
    } else tx.create(manifest, { origin, payloadHash, chunks });
  });
}
/** Stored bytes are not authority. Reconstruct all chunks and authenticate the
 * complete root against current immutable ancestry on every read. */
export async function readStoredBreakArtifact(db: Firestore, origin: string,
  lineage: LineageReader = readRestorationSuccessionLineage): Promise<VerifiedBreakArtifact> {
  const id = originId(origin), collection = db.collection(BREAK_ARTIFACTS), manifest = await collection.doc(id).get();
  const chunks: unknown = manifest.get('chunks'), payloadHash: unknown = manifest.get('payloadHash');
  if (!manifest.exists || manifest.get('origin') !== origin || typeof chunks !== 'number' || !Number.isSafeInteger(chunks) || chunks < 1
    || typeof payloadHash !== 'string' || !hash.test(payloadHash)) throw Error('break_artifact_manifest_missing');
  const texts: string[] = [];
  for (let index = 0; index < chunks; index++) {
    const chunk = await collection.doc(`${id}_${payloadHash.slice(2)}_${index}`).get(), text: unknown = chunk.get('text');
    if (!chunk.exists || chunk.get('origin') !== origin || chunk.get('payloadHash') !== payloadHash || chunk.get('index') !== index
      || typeof text !== 'string' || text.length === 0 || text.length > chunkSize
      || (index + 1 < chunks && text.length !== chunkSize)) throw Error('break_artifact_chunk_missing');
    texts.push(text);
  }
  const payload = texts.join('');
  if (digest(payload) !== payloadHash) throw Error('break_artifact_digest_mismatch');
  return authenticateBreakArtifact(origin, JSON.parse(payload) as unknown, lineage);
}
