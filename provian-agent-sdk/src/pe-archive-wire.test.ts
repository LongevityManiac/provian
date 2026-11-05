/**
 * — the PE Archive wire, SDK side. Rebuilds the relay's pinned vector byte for byte
 * (`docs/audit/pe-archive-wire-vectors.json`) with this package's own sealed box, and opens the
 * relay-pinned bytes with the owner's and the linked human's keys — a part sealed by any of the
 * three packages opens on the others.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { x25519 } from '@noble/curves/ed25519';
import {
  buildArchiveEntries,
  bytesToB64u,
  openArchivePart,
  parseArchivePart,
  sealArchivePart,
  type ArchiveBatchInput,
} from './pe-archive-wire';
import { actRecordOf, actsRootOf, batchLeafOf, METER_GENESIS_PREV_HASH, peHashOf, PE_V2_SCHEMA, utf8Bytes, type PeV2 } from './meter-wire';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/audit/pe-archive-wire-vectors.json'), 'utf8')) as { sha256: string; line: string };

function vectorRandom(): (n: number) => Uint8Array {
  let call = 0;
  return (n: number) => {
    call += 1;
    const out = new Uint8Array(n);
    for (let j = 0; j < n; j++) out[j] = (call * 7 + j * 13 + 5) & 0xff;
    return out;
  };
}
const OWNER_SECRET = new Uint8Array(32).fill(0x11);
const HUMAN_SECRET = new Uint8Array(32).fill(0x22);
const STRANGER_SECRET = new Uint8Array(32).fill(0x33);
const pubOf = (secret: Uint8Array): string => bytesToB64u(x25519.getPublicKey(secret));

function vectorBatch(): ArchiveBatchInput {
  const pes: (PeV2 & { pe_hash: string })[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < 3; i++) {
    const body: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_vector_${i}`, device_id: 'dev_vector', prev_hash: prev,
      timestamp: 1_790_000_000_000 + i, action_type: 'coding_session', attestation_depth: 'software',
      description: `vector ${i} — ünïcødé ✓`,
    };
    const pe = { ...body, pe_hash: peHashOf(body) };
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = 'ab'.repeat(32);
  return {
    device_id: 'dev_vector', actor_id: 'agent_vector', seq: 1, batch_hash: batchHash, acts_root: actsRoot,
    batch_leaf: batchLeafOf({ device_id: 'dev_vector', actor_id: 'agent_vector', seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
    first_index: 0, pes,
    anchor: {
      day: '2026-10-03', anchor_batch_id: `0x${'cd'.repeat(32)}`, leaf_index: 0, proof: [`0x${'ef'.repeat(32)}`],
      merkle_root: `0x${'12'.repeat(32)}`, tx_hash: `0x${'34'.repeat(32)}`,
    },
  };
}

describe('PE Archive wire (SDK)', () => {
  it('GREEN: rebuilds the relay-pinned vector byte for byte', () => {
    const { entries, refs } = buildArchiveEntries('2026-10-03', [vectorBatch()], '0x889a59a8');
    const part = sealArchivePart({
      wallet: 'aw_vector', day: '2026-10-03', device_id: 'dev_vector', part: 0, entries, refs,
      recipients: [{ party_id: 'aw_vector', pubkey_b64u: pubOf(OWNER_SECRET) }, { party_id: 'hw_vector', pubkey_b64u: pubOf(HUMAN_SECRET) }],
      randomBytes: vectorRandom(),
    });
    expect(part.line).toBe(V.line);
    expect(part.sha256).toBe(V.sha256);
  });

  it('GREEN: opens the relay-pinned bytes with the owner key and the linked human key', () => {
    const parsed = parseArchivePart(utf8Bytes(V.line));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const secret of [OWNER_SECRET, HUMAN_SECRET]) {
      const opened = openArchivePart(parsed.header, secret);
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.payload.entries).toHaveLength(3);
    }
  });

  it('RED: a stranger key opens nothing', () => {
    const parsed = parseArchivePart(utf8Bytes(V.line));
    if (!parsed.ok) throw new Error('vector did not parse');
    expect(openArchivePart(parsed.header, STRANGER_SECRET)).toEqual({ ok: false, error: 'key_box_unopenable' });
  });
});
