#!/usr/bin/env tsx
/**
 * completion-earning re-issue — print the digests the re-pins and the
 * signing handoff need, and write the exact signing bytes. PRINTS AND WRITES
 * ONE HANDOFF FILE; it signs nothing, holds no key, touches no Firestore.
 *
 * Why not `monetary-activation-sign.ts --print-payload` that flag prints the
 * FROZEN Gate 1 manifest bytes — the original rail (route (a) in
 * `isValidMonetaryPolicyActivation`), which is closed by design. The rail the
 * live activation document verifies against is 's scoped route (b),
 * whose signed message is `monetaryApprovalSigningBytes()` a domain-separated
 * serialization of the approved scope INCLUDING the template digest. Every
 * re-issue since signed exactly those bytes (`docs/handoffs/monetary-
 * activation-*.signing-bytes.txt`), and the approval suite asserts the handoff
 * file is byte-identical to them.
 *
 * Usage (from the repo root):
 * npx tsx provian-backend/scripts/print-completion-earning-digests.ts [--write <path>]
 */

import crypto from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { hashProposedMonetaryPolicyTemplate } from '../src/core/pvt/policy/proposed-monetary-policy';
import {
  monetaryApprovalSigningBytes,
  monetaryApprovalSigningDigest,
} from '../src/core/pvt/policy/approved-monetary-activation-approval';

const repoRoot = path.resolve(__dirname, '../..');
const matrixPath = path.join(repoRoot, 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as {
  content_sha256: string;
  rows: Array<{ action_type: string; session_lineage_policy: string; mint_disposition: string; evidence_requirement: string }>;
};

const bytes = monetaryApprovalSigningBytes();
console.log(`matrix content_sha256      : ${matrix.content_sha256}`);
console.log(`monetary template digest   : ${hashProposedMonetaryPolicyTemplate()}`);
console.log(`signing bytes sha256       : ${monetaryApprovalSigningDigest()}`);
console.log(`signing bytes (raw sha256) : sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
console.log(`signing bytes length       : ${bytes.length}`);
for (const t of ['promise_fulfilled', 'job_delivered', 'human_job_delivered', 'goal_envelope_completed', 'human_job_completed', 'agreement_settled']) {
  const row = matrix.rows.find((r) => r.action_type === t);
  console.log(`row ${t.padEnd(24)}: ${row?.mint_disposition} / ${row?.evidence_requirement} / lineage=${row?.session_lineage_policy}`);
}

const writeIndex = process.argv.indexOf('--write');
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  const out = path.resolve(process.argv[writeIndex + 1]);
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.length} bytes)`);
}
console.log('--- signing bytes ---');
process.stdout.write(bytes);
