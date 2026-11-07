/**
 * SCHEMA-VS-CODE DRIFT (Trust Layer pass 2, §2.12).
 *
 * The published PE schema snapshot (shipped in the SDK, served on /developers) must
 * never lag the relay types. This test regenerates the schema from the live relay
 * constants and refuses any difference from the committed snapshot — so a change to
 * the evidence-class bases, the hardware schemes/roots, the predicate grammar, the
 * origin classes, the field registry, or the signed pricing template that is not
 * accompanied by `npx tsx scripts/generate-pe-schema.ts` goes RED here and in the
 * pre-push gate + nightly.
 *
 * NON-VACUOUS: the drift comparison is paired with a RED control that mutates the
 * live document and asserts the comparison WOULD fail — proving the equality check
 * is real, not a tautology over one object.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { buildPeSchema, PE_FIELD_REGISTRY, type PeFieldSpec } from './pe-schema';
import {
  actLeafOf, actRecordOf, batchLeafOf, canonicalJson, NON_PRICING_PE_FIELDS, sha256HexOfText, type PeV2,
} from '../meter/meter-wire';
import { meterAnchorBatchId } from '../meter/meter-anchor';
import { DYNAMIC_FIELD_PATTERNS, PREDICATE_ONLY_FIELDS } from '../presentation/vocabulary-fields';
import { serializePeSchema, SDK_SCHEMA_PATH } from '../../../scripts/generate-pe-schema';

describe('§2.12 PE schema drift', () => {
  it('the committed SDK snapshot equals the live relay types (regenerate on drift)', () => {
    const committed = readFileSync(SDK_SCHEMA_PATH, 'utf8');
    expect(committed).toBe(serializePeSchema());
  });

  it('carries the SIGNED pricing template digest (every Commons speech act mints)', () => {
    // The schema REFLECTS the digest, it never sets it. moved the signed template
    // 281cb699… → 70f1453b… (Commons speech rows → eligible at the class base), so the schema reads
    // 70f1453b….
    const doc = buildPeSchema();
    // Fact-base fixes item 3 (2026-09-23): one record_only row deleted — 70f1453b… → 31534d73….
    // three job-settlement record_only rows added — 31534d73… → 610a1f08….
    // token-volume pricing removed — 610a1f08… → 7d539bce….
    // Measured observer (2026-10-10): hardwarePricingMeasuredSchemes joins the template — 7d539bce… → 33948538….
    // unknownActionAdmission joins the template — 33948538… → cbe39337….
    expect(doc.pricing_template_sha256).toBe('sha256:8a6390074ac8d6d1530105f473fe0df142e7f1494cb7b23b67ad20720022ac39');
    // vocabulary extension (windows, share, measurement, predicate-only volume, patterns) — 1.3.0.
    // PE meter (2026-10-03): PE v2 kept by its owner, act records in signed batches — 2.0.0.
    // Signed outputs (2026-10-04): input_origins entries may carry the producer's signature — 2.1.0.
    // Reference gate (2026-10-09): money.witnessed_inbound joins the vocabulary — 2.2.0.
    // Trust layer extension (2026-10-10): measured observer, requester-named disclosure, issuer +
    // independent-payer facets with windows — 2.3.0.
    expect(doc.schema_version).toBe('2.3.2');
    expect(doc.commons_communication.speech_action_types).toContain('commons_thread_message');
  });

  it('RED control: a mutated document would NOT equal the snapshot (the check is real)', () => {
    // Prove the equality above is non-vacuous: perturb one value and confirm the
    // serialized form diverges from the committed snapshot.
    const committed = readFileSync(SDK_SCHEMA_PATH, 'utf8');
    const mutated = { ...buildPeSchema(), schema_version: '0.0.0-mutated' };
    expect(JSON.stringify(mutated, null, 2) + '\n').not.toBe(committed);
  });

  it('every witness class and hardware scheme is represented (population is non-empty)', () => {
    const doc = buildPeSchema();
    expect(doc.witness_classes.length).toBe(6);
    expect(doc.witness_classes.find((c) => c.class === 'hardware_rooted')?.base_bps).toBe(40000);
    expect(doc.witness_classes.find((c) => c.class === 'actor_declared')?.base_bps).toBe(0);
    expect(doc.hardware.schemes.map((s) => s.scheme).sort()).toEqual(
      ['apple_app_attest', 'aws_nitro', 'azure_attestation', 'gcp_confidential_space', 'nvidia_cc', 'tpm2_quote'],
    );
    // predicate grammar reflects the real ops
    expect(doc.presentation.predicate_grammar.ops).toEqual(['gte', 'gt', 'lte', 'lt', 'eq']);
    expect(doc.presentation.predicate_grammar.set_op).toBe('in');
  });

  it('the vocabulary lists every dynamic pattern FROM the relay table, the windows, the predicate-only volume, and the verify contract', () => {
    const v = buildPeSchema().presentation.vocabulary;
    // Bound to the ONE table the relay resolves never-seen keys with (not a copy): every entry, same regex.
    expect(v.dynamic_patterns.map((p) => p.pattern)).toEqual(DYNAMIC_FIELD_PATTERNS.map((p) => p.pattern));
    expect(v.dynamic_patterns.map((p) => p.regex)).toEqual(DYNAMIC_FIELD_PATTERNS.map((p) => p.regex.source));
    expect(v.dynamic_patterns.length).toBeGreaterThanOrEqual(10);
    expect(v.never_seen_key_rule).toMatch(/reads 0/);
    expect(v.predicate_only.fields).toEqual([...PREDICATE_ONLY_FIELDS].sort());
    expect(v.predicate_only.ops).toEqual(['gte', 'gt', 'lte', 'lt']);
    expect(v.windows.fields).toContain('standing.adverse_events_30d');
    expect(v.windows.fields).toContain('money.witnessed_payment_volume_usd_365d');
    const work = v.groups.find((g) => g.group === 'work')!;
    expect(work.fields).toContain('work.hardware_rooted');
    expect(v.groups.find((g) => g.group === 'composition')!.fields).toContain('composition.measurement.<digest>');
    const vr = buildPeSchema().presentation.verify_result;
    expect(vr.reputation).toContain('presentation_id (= burn_id; dedupe key)');
    expect(vr.pe_fact).toContain('payload (the claimed PE ids + envelope hashes)');
    expect(vr.never).not.toMatch(/JWKS-checkable offline/);
    expect(vr.never).toMatch(/accept a presentation once/);
  });
});

/** The pinned wire vectors the relay, SDK and app reproduce. */
const VECTORS = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../docs/audit/meter-wire-vectors.json'), 'utf8')) as {
  pes: PeV2[];
  batch: { device_id: string; seq: number; acts_root: string };
  batch_hash: string;
  batch_leaf: string;
};

/** Names whose documented role disagrees with the wire's own non-pricing list. */
function roleSplitOffenders(registry: readonly PeFieldSpec[], nonPricing: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const f of registry) {
    const documentedNonPricing = f.role !== 'pricing';
    if (documentedNonPricing !== nonPricing.includes(f.name)) offenders.push(f.name);
  }
  for (const name of nonPricing) {
    if (!registry.some((f) => f.name === name)) offenders.push(name);
  }
  return offenders;
}

/** PE fields the vectors carry that the schema does not describe. */
function undocumentedFields(pes: readonly PeV2[], registry: readonly PeFieldSpec[]): string[] {
  const known = new Set(registry.map((f) => f.name));
  return [...new Set(pes.flatMap((pe) => Object.keys(pe)))].filter((k) => !known.has(k));
}

describe('PE meter schema (2.0.0) — every recipe reproduces the wire, never a copy of it', () => {
  const meter = buildPeSchema().meter;

  it('the role split equals the wire’s NON_PRICING_PE_FIELDS', () => {
    expect(PE_FIELD_REGISTRY.length).toBeGreaterThan(NON_PRICING_PE_FIELDS.length);
    expect(roleSplitOffenders(PE_FIELD_REGISTRY, NON_PRICING_PE_FIELDS)).toEqual([]);
    expect([...meter.pe.non_pricing_fields]).toEqual([...NON_PRICING_PE_FIELDS]);
  });

  it('RED control: a free-text field documented as pricing is caught', () => {
    const mutated = PE_FIELD_REGISTRY.map((f) => (f.name === 'description' ? { ...f, role: 'pricing' as const } : f));
    expect(roleSplitOffenders(mutated, NON_PRICING_PE_FIELDS)).toEqual(['description']);
  });

  it('every field the vector PEs carry is documented', () => {
    expect(VECTORS.pes.length).toBe(3);
    expect(undocumentedFields(VECTORS.pes, PE_FIELD_REGISTRY)).toEqual([]);
    // RED control: an undocumented field is reported.
    expect(undocumentedFields([{ ...VECTORS.pes[0], zz_new_field: 1 }], PE_FIELD_REGISTRY)).toEqual(['zz_new_field']);
  });

  it('the documented act-record keys are the act record’s keys', () => {
    expect([...meter.act_record.keys]).toEqual(Object.keys(actRecordOf(VECTORS.pes[0])).sort());
  });

  it('the documented act leaf (domain + canonical act) reproduces actLeafOf on every vector act', () => {
    const acts = VECTORS.pes.map(actRecordOf);
    expect(acts.length).toBe(3);
    for (const act of acts) {
      expect(sha256HexOfText(meter.act_record.leaf_domain + canonicalJson(act))).toBe(actLeafOf(act));
    }
    // RED control: a wrong domain does not reproduce it.
    expect(sha256HexOfText('provian.meter.act.v0\n' + canonicalJson(acts[0]))).not.toBe(actLeafOf(acts[0]));
  });

  it('the documented batch leaf reproduces batchLeafOf on the vector batch', () => {
    const identity = {
      actor_id: 'agent_vector', acts_root: VECTORS.batch.acts_root, batch_hash: VECTORS.batch_hash,
      device_id: VECTORS.batch.device_id, seq: VECTORS.batch.seq,
    };
    const documented = sha256HexOfText(meter.inclusion_proof.batch_leaf_domain + canonicalJson(identity));
    expect(documented).toBe(batchLeafOf(identity));
    expect(documented).toBe(VECTORS.batch_leaf);
    // RED control: a different actor gives a different leaf.
    expect(sha256HexOfText(meter.inclusion_proof.batch_leaf_domain + canonicalJson({ ...identity, actor_id: 'x' }))).not.toBe(VECTORS.batch_leaf);
  });

  it('the documented anchor batch id preimage reproduces meterAnchorBatchId', () => {
    const preimage = /utf8\("([^"]+)"\)/.exec(meter.inclusion_proof.anchor_batch_id)?.[1];
    expect(preimage).toBeDefined();
    const day = '2026-10-02';
    const encode = (tag: string): string => ethers.keccak256(ethers.concat([tag, ethers.toUtf8Bytes(preimage!.replace('<YYYY-MM-DD>', day))]));
    expect(encode('0xff')).toBe(meterAnchorBatchId(day));
    // RED control: another domain byte does not reproduce it.
    expect(encode('0xfe')).not.toBe(meterAnchorBatchId(day));
  });

  it('every receipt field is relay-assigned, and the PE carries none of them', () => {
    expect(meter.receipt.act_fields.length).toBeGreaterThan(0);
    expect(meter.receipt.act_fields.every((f) => f.assignment === 'relay_assigned')).toBe(true);
    expect(PE_FIELD_REGISTRY.every((f) => f.assignment === 'submitter')).toBe(true);
    const pricingNames = new Set(PE_FIELD_REGISTRY.filter((f) => f.role === 'pricing').map((f) => f.name));
    expect(meter.receipt.act_fields.filter((f) => pricingNames.has(f.name))).toEqual([]);
  });
});
