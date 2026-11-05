/**
 * — the PE Archive wire's cross-package test vector (relay side). The SDK's and the
 * app's tests rebuild the same part from the same inputs and must produce the bytes pinned in
 * `docs/audit/pe-archive-wire-vectors.json`.
 */
import { buildArchiveEntries, bytesToB64u, sealArchivePart, type ArchiveBatchInput } from './pe-archive-wire';
import { archiveContentKeyPair } from './pe-archive-crypto';
import { actRecordOf, actsRootOf, batchLeafOf, METER_GENESIS_PREV_HASH, peHashOf, PE_V2_SCHEMA, type PeV2 } from './meter-wire';

/** Deterministic "randomness" for the vector: byte j of call c = (c*7 + j*13 + 5) & 0xff. */
export function vectorRandom(): (n: number) => Uint8Array {
  let call = 0;
  return (n: number) => {
    call += 1;
    const out = new Uint8Array(n);
    for (let j = 0; j < n; j++) out[j] = (call * 7 + j * 13 + 5) & 0xff;
    return out;
  };
}

export const OWNER_SECRET = new Uint8Array(32).fill(0x11);
export const HUMAN_SECRET = new Uint8Array(32).fill(0x22);
export const STRANGER_SECRET = new Uint8Array(32).fill(0x33);
export const pubOf = (secret: Uint8Array): string => bytesToB64u(archiveContentKeyPair(() => secret).publicKey);

export function vectorBatch(): ArchiveBatchInput {
  const pes: (PeV2 & { pe_hash: string })[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < 3; i++) {
    const body: PeV2 = {
      schema: PE_V2_SCHEMA,
      pe_id: `pe_vector_${i}`,
      device_id: 'dev_vector',
      prev_hash: prev,
      timestamp: 1_790_000_000_000 + i,
      action_type: 'coding_session',
      attestation_depth: 'software',
      description: `vector ${i} — ünïcødé ✓`,
    };
    const pe = { ...body, pe_hash: peHashOf(body) };
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = 'ab'.repeat(32);
  return {
    device_id: 'dev_vector',
    actor_id: 'agent_vector',
    seq: 1,
    batch_hash: batchHash,
    acts_root: actsRoot,
    batch_leaf: batchLeafOf({ device_id: 'dev_vector', actor_id: 'agent_vector', seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
    first_index: 0,
    pes,
    anchor: {
      day: '2026-10-03',
      anchor_batch_id: `0x${'cd'.repeat(32)}`,
      leaf_index: 0,
      proof: [`0x${'ef'.repeat(32)}`],
      merkle_root: `0x${'12'.repeat(32)}`,
      tx_hash: `0x${'34'.repeat(32)}`,
    },
  };
}

export function vectorPart(): ReturnType<typeof sealArchivePart> {
  const { entries, refs } = buildArchiveEntries('2026-10-03', [vectorBatch()], '0x889a59a8');
  return sealArchivePart({
    wallet: 'aw_vector',
    day: '2026-10-03',
    device_id: 'dev_vector',
    part: 0,
    entries,
    refs,
    recipients: [{ party_id: 'aw_vector', pubkey_b64u: pubOf(OWNER_SECRET) }, { party_id: 'hw_vector', pubkey_b64u: pubOf(HUMAN_SECRET) }],
    randomBytes: vectorRandom(),
  });
}
