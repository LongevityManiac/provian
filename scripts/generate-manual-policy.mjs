#!/usr/bin/env node
// Derive the current-feature action index without changing the signed matrix.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const matrix = JSON.parse(readFileSync(resolve(root, 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json'), 'utf8'));
if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) throw new Error('empty action matrix');
const path = resolve(root, 'docs/PROVIAN_MANUAL.md');
const start = '<!-- BEGIN GENERATED ACTION POLICY -->';
const end = '<!-- END GENERATED ACTION POLICY -->';
const cell = (value) => String(value ?? 'none').replaceAll('|', '\\|').replaceAll('\n', ' ');
// These wire names remain in byte-bound compatibility data, not the current
// product. Refuse to omit any economically active row.
const compatibilityOnly = new Set(['agent_insurance_payout_executed', 'agent_insurance_pool_created',
  'agent_insurance_premium_paid', 'insurance_claim_filed', 'insurance_claim_resolved']);
for (const row of matrix.rows) if (compatibilityOnly.has(row.action_type)
  && (row.mint_disposition !== 'record_only' || row.base_action_weight_bps !== 0)) throw new Error('compatibility row creates issuance');
const currentRows = matrix.rows.filter(row => !compatibilityOnly.has(row.action_type));
const lines = [start, '', '### Current action index', '',
  `Source commitment: \`${matrix.content_sha256}\`. ${currentRows.length} current-feature rows. The signed source also retains non-minting compatibility records. Weights are basis points; 10,000 bps is 1.0×. These are row bases before witness-class overrides and the factors in §5.`, '',
  '| Action type | Category | Base bps | Disposition | Evidence | Attestation pricing |',
  '|---|---|---:|---|---|---|',
  ...[...currentRows].sort((a, b) => a.action_type.localeCompare(b.action_type)).map((row) =>
    `| \`${cell(row.action_type)}\` | ${cell(row.category)} | ${cell(row.base_action_weight_bps)} | \`${cell(row.mint_disposition)}\` | \`${cell(row.evidence_requirement)}\` | \`${cell(row.attestation_pricing)}\` |`),
  '', end];
const current = readFileSync(path, 'utf8');
const block = lines.join('\n');
let next;
if (current.includes(start)) {
  const a = current.indexOf(start), b = current.indexOf(end, a);
  if (b < 0) throw new Error('unterminated generated action policy');
  next = current.slice(0, a) + block + current.slice(b + end.length);
} else {
  const anchor = '\n## Appendix B — implementation notes';
  if (!current.includes(anchor)) throw new Error('Manual appendix not found');
  next = current.replace(anchor, `\n${block}\n${anchor}`);
}
if (process.argv.includes('--check')) {
  if (next !== current) throw new Error('Manual action policy is stale; run node scripts/generate-manual-policy.mjs');
} else if (next !== current) writeFileSync(path, next);
console.log(`manual-policy: ${currentRows.length} current-feature rows match the signed matrix`);
