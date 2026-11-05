/**
 * Generate the pinned PE-meter wire vectors (docs/audit/meter-wire-vectors.json).
 * Run ONCE when the wire format is defined; afterwards the relay, SDK and app tests read the
 * file and must reproduce every output. `--check` exits 1 when the file disagrees.
 */
import fs from 'fs';
import path from 'path';
import {
  actLeafOf, actRecordOf, batchHashOf, batchLeafOf, buildBatch, canonicalJson, hardwareNonceOfAct,
  merkleProofOf, peHashOf, type PeV2,
} from '../src/core/meter/meter-wire';

const OUT = path.resolve(__dirname, '../../docs/audit/meter-wire-vectors.json');
const DEVICE = 'dev_vector_0001';

const peA: PeV2 = {
  schema: 'provian.pe.v2', pe_id: 'pe_vector_a', device_id: DEVICE, prev_hash: 'genesis',
  timestamp: 1790000000000, action_type: 'agent_tool_orchestration',
  description: 'free text that never leaves the device',
  metadata: { tool_call_count: 3, capture_lane: 'transcript', nested: { b: 2, a: 1 }, unicode: 'é✓' },
  compute: { tokens_processed: 1200, duration_ms: 4000 },
  output_digests: [{ hash: 'a'.repeat(64), kind: 'file' }],
};
const peB: PeV2 = {
  schema: 'provian.pe.v2', pe_id: 'pe_vector_b', device_id: DEVICE, prev_hash: peHashOf(peA),
  timestamp: 1790000060000, action_type: 'coding_session',
  metadata: { commit_sha: 'b'.repeat(40), lines_added: 10 },
  signature: 'sig-is-excluded-from-the-hash',
};
const peC: PeV2 = {
  schema: 'provian.pe.v2', pe_id: 'pe_vector_c', device_id: DEVICE, prev_hash: peHashOf(peB),
  timestamp: 1790000120000, action_type: 'ai_conversation',
  metadata: { session_fingerprint: 'c'.repeat(64) },
  hardware_witness: { scheme: 'apple_app_attest', report: 'opaque' },
};
const pes = [peA, peB, peC];
const batch = buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: 1790003600000, pes });
const leaves = batch.acts.map(actLeafOf);
const batchHash = batchHashOf(batch);

const vectors = {
  schema: 'provian.meter-wire-vectors.v1',
  canonical_json: { input: { b: [1, 'x', null, { d: true, c: 0.5 }], a: 'é' }, output: canonicalJson({ b: [1, 'x', null, { d: true, c: 0.5 }], a: 'é' }) },
  pes,
  pe_hashes: pes.map(peHashOf),
  acts: pes.map(actRecordOf),
  act_leaves: leaves,
  hardware_nonce_c: hardwareNonceOfAct(actRecordOf(peC)),
  batch,
  batch_hash: batchHash,
  act_proofs: leaves.map((_, i) => merkleProofOf(leaves, i)),
  batch_leaf: batchLeafOf({ device_id: DEVICE, actor_id: 'agent_vector', seq: 1, batch_hash: batchHash, acts_root: batch.acts_root }),
};

const text = JSON.stringify(vectors, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.readFileSync(OUT, 'utf8');
  if (current !== text) { console.error('meter-wire vectors DRIFT'); process.exit(1); }
  console.log('meter-wire vectors ok');
} else {
  fs.writeFileSync(OUT, text);
  console.log('wrote', OUT);
}
