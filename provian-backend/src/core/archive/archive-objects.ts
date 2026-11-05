/**
 * — where archived PEs live: the Archive bucket (`gs://provian-ai-pe-archive`, Archive
 * storage class as the bucket default; the operator creates the bucket — this code creates nothing
 * in GCP).
 *
 * ONE OBJECT PER PART, WRITTEN ONCE (PE Archive human-path run, 2026-10-07). Archive class bills
 * 365 days for any object deleted or replaced before it is a year old, and a read of it pays a
 * retrieval fee. So an object here is created exactly once (`ifGenerationMatch: 0`) and never
 * rewritten, composed into, moved or deleted: a day that gains another part (another device of the
 * same wallet, or the rest of a large day) gains another object. A day is served as its parts'
 * objects streamed in index order — the same NDJSON a reader always received.
 *
 * Days stored before 2026-10-07 live in one object per wallet per day (`v1/<wallet>/<day>.pea`);
 * those objects are read as they are and never written again.
 *
 * NOTHING IN THIS MODULE DELETES, REPLACES OR COMPOSES AN OBJECT. The store has no such method
 * (`archive-objects.test.ts` pins it).
 */
import { createHash,createHmac } from 'crypto';
import { getStorage } from 'firebase-admin/storage';
import { Readable } from 'stream';

export interface ArchiveObjectStat {
  readonly size: number;
  readonly generation: string;
  /** Base64 MD5 of the object's bytes as Cloud Storage computed it (null if not reported). */
  readonly md5: string | null;
}

export interface ArchiveObjectStore {
  readonly bucket: string;
  /** Metadata only (no data read, so no retrieval of the object's bytes). */
  stat(path: string): Promise<ArchiveObjectStat | null>;
  /**
   * Create an object once. Throws `archive_object_exists` if anything is already at `path` (it is
   * never replaced). Cloud Storage checks the bytes against their MD5 and refuses a corrupted upload
   * before the object exists.
   */
  create(path: string, bytes: Uint8Array): Promise<ArchiveObjectStat>;
  /** Read a byte range [start, end) (only a pre-2026-10-07 day object's crash-recovery check). */
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Stream a whole object (an owner's pull, and a pre-2026-10-07 day object's confirmation). */
  openRead(path: string): Readable;
}

export function md5Base64(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('base64');
}

type GcsBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

/** Existing relay credential only. Its historical versions must remain available for permanent objects. */
export function archivePrivacyKey(secret=process.env.RELAY_SIGNING_KEY):Buffer {
  if(!secret)throw new Error('archive_privacy_key_unavailable');
  return createHmac('sha256',secret).update('provian-private-archive-at-rest:v1').digest();
}
export function archivePrivacyKeyHash(key:Buffer):string{return createHash('sha256').update(key).digest('base64');}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 404 || code === '404';
}

function statOf(meta: Record<string, unknown>, md5Fallback: string | null, sizeFallback = 0): ArchiveObjectStat {
  return {
    size: meta.size !== undefined ? Number(meta.size) : sizeFallback,
    generation: String(meta.generation ?? ''),
    md5: typeof meta.md5Hash === 'string' ? meta.md5Hash : md5Fallback,
  };
}

function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 412 || code === '412';
}

/** The production store over Cloud Storage (through firebase-admin's storage client). */
export function createGcsArchiveObjectStore(bucketName: string, bucketOverride?: GcsBucket, protectNew:()=>Promise<boolean>=async()=>false): ArchiveObjectStore {
  const bucket: GcsBucket = bucketOverride ?? getStorage().bucket(bucketName);
  const readable=async(path:string)=>{
    const file=bucket.file(path),[meta]=await file.getMetadata();
    const encryption=meta.customerEncryption;
    if(encryption){
      const key=archivePrivacyKey();
      if(encryption.keySha256!==archivePrivacyKeyHash(key))throw new Error('archive_privacy_key_version_unavailable');
      file.setEncryptionKey(key);
      const [protectedMeta]=await file.getMetadata();
      // The general metadata request cannot disclose MD5. Never mistake that omission for verification.
      if(!protectedMeta.md5Hash&&!protectedMeta.componentCount)throw new Error('archive_protected_checksum_missing');
      return {file,meta:protectedMeta};
    }
    return {file,meta};
  };

  return {
    bucket: bucketName,
    async stat(path) {
      // One metadata GET (a 404 is "absent"): never an exists() + getMetadata() pair.
      try {
        const {meta} = await readable(path);
        return statOf(meta, null);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async create(path, bytes) {
      const file = bucket.file(path);
      const protectedObject=await protectNew();
      if(protectedObject)file.setEncryptionKey(archivePrivacyKey());
      const md5 = md5Base64(bytes);
      try {
        await file.save(Buffer.from(bytes), {
          resumable: false,
          contentType: 'application/x-ndjson',
          // Create-only: an object here is never replaced.
          preconditionOpts: { ifGenerationMatch: 0 },
          // The server checks the bytes against this MD5 and refuses a mismatch before the object
          // exists. (Client-side validation is off: on a mismatch it would DELETE the object.)
          validation: false,
          metadata: { md5Hash: md5, cacheControl: 'no-store' },
        });
      } catch (error) {
        if (isPreconditionFailure(error)) throw new Error('archive_object_exists');
        throw error;
      }
      // The upload's own response carries the object's metadata; read it again only if it did not.
      const uploaded = (file as unknown as { metadata?: Record<string, unknown> }).metadata;
      if (uploaded && uploaded.generation !== undefined && uploaded.generation !== null && typeof uploaded.md5Hash==='string') return statOf(uploaded, null, bytes.length);
      const [meta] = await file.getMetadata();
      if(typeof meta.md5Hash!=='string')throw new Error('archive_uploaded_checksum_missing');
      return statOf(meta, null, bytes.length);
    },
    async readRange(path, start, end) {
      if (end <= start) return new Uint8Array(0);
      const {file}=await readable(path);
      const [buf] = await file.download({ start, end: end - 1 });
      return new Uint8Array(buf);
    },
    openRead(path) {
      return Readable.from((async function*(){const {file}=await readable(path);for await(const chunk of file.createReadStream())yield chunk;})());
    },
  };
}

/** An in-memory store with the same semantics (tests). Counts data reads so a test can bound them. */
export function createMemoryArchiveObjectStore(bucketName = 'memory-archive'): ArchiveObjectStore & {
  readonly objects: Map<string, { bytes: Uint8Array; generation: number }>;
  readonly reads: { count: number };
} {
  const objects = new Map<string, { bytes: Uint8Array; generation: number }>();
  const reads = { count: 0 };
  let gen = 1000;
  return {
    bucket: bucketName,
    objects,
    reads,
    async stat(path) {
      const o = objects.get(path);
      return o === undefined ? null : { size: o.bytes.length, generation: String(o.generation), md5: md5Base64(o.bytes) };
    },
    async create(path, bytes) {
      if (objects.has(path)) throw new Error('archive_object_exists');
      gen += 1;
      objects.set(path, { bytes: new Uint8Array(bytes), generation: gen });
      return { size: bytes.length, generation: String(gen), md5: md5Base64(bytes) };
    },
    async readRange(path, start, end) {
      const o = objects.get(path);
      if (o === undefined) throw new Error('archive_object_missing');
      reads.count += 1;
      return o.bytes.slice(start, end);
    },
    openRead(path) {
      const o = objects.get(path);
      if (o === undefined) {
        const missing = new Readable({ read() { this.destroy(new Error('archive_object_missing')); } });
        return missing;
      }
      reads.count += 1;
      const bytes = o.bytes;
      return Readable.from((async function* chunks() {
        for (let i = 0; i < bytes.length; i += 7) yield Buffer.from(bytes.subarray(i, Math.min(bytes.length, i + 7)));
      })());
    },
  };
}
