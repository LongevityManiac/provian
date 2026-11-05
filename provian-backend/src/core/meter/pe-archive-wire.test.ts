/**
 * — the PE Archive wire (byte-identical in relay / SDK / app). The pinned vector
 * (`docs/audit/pe-archive-wire-vectors.json`) is reproduced byte for byte by the SDK's and the app's
 * copies of this test, so a part sealed on one opens on the others. Every RED starts from the GREEN
 * part changed in exactly one thing.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  ARCHIVE_BYTES_PER_GB,
  archiveDayDroppable,
  archiveDayOf,
  archiveObjectPath,
  b64uToBytes,
  buildArchiveEntries,
  bytesToB64u,
  openArchivePart,
  parseArchivePart,
  sealArchivePart,
  splitArchiveObject,
  utf8Decode,
} from './pe-archive-wire';
import { canonicalJson, utf8Bytes } from './meter-wire';
import { HUMAN_SECRET, OWNER_SECRET, pubOf, STRANGER_SECRET, vectorBatch, vectorPart } from './pe-archive-vector.test-support';

const VECTORS_PATH = path.resolve(__dirname, '../../../../docs/audit/pe-archive-wire-vectors.json');
const VECTORS = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as { sha256: string; line: string };

/** The cross-package vector: the SDK's and the app's copies of this test reproduce these exact bytes. */
const PE_ARCHIVE_VECTOR_SHA256 = '78e123f0e02fa673cd02e9d86fba7f98d89d968b71825712ae761e2e590f91f0';

describe('PE Archive wire', () => {
  it('GREEN: the pinned vector (identical in relay, SDK and app)', () => {
    const part = vectorPart();
    expect(part.sha256).toBe(PE_ARCHIVE_VECTOR_SHA256);
    expect(VECTORS.sha256).toBe(PE_ARCHIVE_VECTOR_SHA256);
    expect(part.line).toBe(VECTORS.line);
    expect(part.header.pe_count).toBe(3);
  });

  it('GREEN: the relay parses the part without any secret; the owner AND the linked human open it', () => {
    const part = vectorPart();
    const parsed = parseArchivePart(part.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sha256).toBe(part.sha256);
    for (const [secret, party] of [[OWNER_SECRET, 'aw_vector'], [HUMAN_SECRET, 'hw_vector']] as const) {
      const opened = openArchivePart(parsed.header, secret, party);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.payload.entries.map((e) => e.pe.pe_id)).toEqual(['pe_vector_0', 'pe_vector_1', 'pe_vector_2']);
      expect(opened.payload.entries[2].pe.description).toBe('vector 2 — ünïcødé ✓');
    }
  });

  it('RED: a stranger cannot open the part (the relay holds ciphertext only)', () => {
    const parsed = parseArchivePart(vectorPart().bytes);
    if (!parsed.ok) throw new Error('vector did not parse');
    expect(openArchivePart(parsed.header, STRANGER_SECRET)).toEqual({ ok: false, error: 'key_box_unopenable' });
    expect(openArchivePart(parsed.header, OWNER_SECRET, 'someone_else')).toEqual({ ok: false, error: 'not_a_recipient' });
  });

  it('RED: a header that is not exactly canonical, or names a batch leaf it cannot recompute, is refused', () => {
    const part = vectorPart();
    const raw = JSON.parse(part.line) as Record<string, unknown>;
    expect(parseArchivePart(utf8Bytes(`${JSON.stringify(raw, null, 1)}\n`))).toEqual({ ok: false, error: 'not_canonical' });
    const forged = { ...raw, batches: (raw.batches as Record<string, unknown>[]).map((b) => ({ ...b, actor_id: 'someone_else' })) };
    expect(parseArchivePart(utf8Bytes(`${canonicalJson(forged)}\n`))).toEqual({ ok: false, error: 'batch_leaf_mismatch' });
    expect(parseArchivePart(utf8Bytes(`${canonicalJson({ ...raw, pe_count: 4 })}\n`))).toEqual({ ok: false, error: 'batch_count_mismatch' });
    expect(parseArchivePart(utf8Bytes(`${canonicalJson({ ...raw, day: '2026-10-04' })}\n`))).toEqual({ ok: false, error: 'batch_wrong_day' });
  });

  it('RED: a payload swapped in from another part fails the header binding', () => {
    const a = vectorPart();
    const { entries, refs } = buildArchiveEntries('2026-10-03', [vectorBatch()]);
    const b = sealArchivePart({
      wallet: 'aw_vector', day: '2026-10-03', device_id: 'dev_vector', part: 1, entries, refs,
      recipients: [{ party_id: 'aw_vector', pubkey_b64u: pubOf(OWNER_SECRET) }],
    });
    const swapped = { ...a.header, payload_box: b.header.payload_box, recipients: b.header.recipients };
    expect(openArchivePart(swapped, OWNER_SECRET, 'aw_vector')).toEqual({ ok: false, error: 'payload_header_mismatch' });
  });

  it('RED: building refuses a day it cannot prove (a PE altered after batching, or the wrong day)', () => {
    const batch = vectorBatch();
    const tampered = { ...batch, pes: batch.pes.map((pe, i) => (i === 1 ? { ...pe, description: 'changed' } : pe)) };
    expect(() => buildArchiveEntries('2026-10-03', [tampered])).toThrow(/archive_pe_hash_mismatch/);
    expect(() => buildArchiveEntries('2026-10-04', [batch])).toThrow(/archive_batch_wrong_day/);
  });

  it('objects split back into their parts; base64url and UTF-8 round-trip', () => {
    const a = vectorPart();
    const joined = new Uint8Array([...a.bytes, ...a.bytes]);
    expect(splitArchiveObject(joined).map((p) => utf8Decode(p))).toEqual([a.line, a.line]);
    expect(() => splitArchiveObject(joined.subarray(0, joined.length - 1))).toThrow('archive_object_torn');
    for (let n = 0; n < 8; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 97 + 3) & 0xff);
      expect(Array.from(b64uToBytes(bytesToB64u(bytes)))).toEqual(Array.from(bytes));
      expect(bytesToB64u(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('days: 1 GB = 10^9 bytes; a day drops only once it is 30+ days old', () => {
    expect(ARCHIVE_BYTES_PER_GB).toBe(1_000_000_000);
    const now = Date.UTC(2026, 10, 2, 12);
    expect(archiveDayOf(Date.UTC(2026, 9, 3, 23, 59))).toBe('2026-10-03');
    expect(archiveDayDroppable('2026-10-03', now)).toBe(true); // 30 days old
    expect(archiveDayDroppable('2026-10-04', now)).toBe(false); // 29 days old: kept
    expect(archiveObjectPath('aw_x', '2026-10-03')).toBe('v1/aw_x/2026-10-03.pea');
  });
});
