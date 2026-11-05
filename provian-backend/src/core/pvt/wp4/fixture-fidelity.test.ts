/**
 * THE FIXTURE AUDIT. Its own pass, because this defect class has cost more than any other.
 *
 * ── THE CLASS ────────────────────────────────────────────────────────────────
 * Twice a green result was a fact about a test rather than about the system:
 *
 *   M6  The inlet read `actor_address`, `wallet_address` and
 *       `economic_snapshot.workProductHash` — none of which exist. Every read returned
 *       `undefined` forever. The tests passed because they built their own untyped candidate
 *       objects and never touched a real document shape.
 *   M7  The fork harness seeded `attestation_verified: true` on a Genesis `pe_history` fixture.
 *       Production never writes it there. The harness "proved" a 74.25 PVT settlement that
 *       could not happen, and the proof stood until an independent reviewer traced the writer.
 *
 * Both are the same mistake: a fixture DECLARING the data the code wants instead of BINDING to
 * what the emitter produces. The second is the nastier one, because the field existed — it was
 * declared, typed, and spelled correctly. Type-checking cannot catch "declared but never written
 * by THIS writer". Only reading the writer can.
 *
 * ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────
 * Three mechanical sweeps over SOURCE, so each finding fails a test rather than waiting for a
 * reviewer:
 *   1. Every field a settlement fixture sets on `pe_history` is declared in `PEHistoryDocument`.
 *   2. Every field a fixture sets on the Genesis outbox is declared in
 *      `GenesisQualificationDocument`.
 *   3. The values the fixtures rely on are the values the EMITTER actually produces — checked
 *      against the emitter's own literals and its own assertions, not against belief.
 *
 * Sweeps 1 and 2 are cheap and would not have caught M7. Sweep 3 is the one that would.
 */

import { readFileSync } from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
  return readFileSync(path.join(BACKEND_ROOT, relative), 'utf8');
}

/** Field names declared on an interface, read from the source of truth itself. */
function declaredFields(source: string, interfaceName: string, endMarker: string): Set<string> {
  const start = source.indexOf(`export interface ${interfaceName}`);
  if (start < 0) throw new Error(`${interfaceName} not found — this audit is reading the wrong file`);
  const end = source.indexOf(endMarker, start);
  const body = source.slice(start, end < 0 ? undefined : end);
  return new Set([...body.matchAll(/^\s{2}(?:readonly\s+)?(\w+)\??:/gm)].map((m) => m[1]));
}

const PE_HISTORY = read('src/pe-history.ts');
const GENESIS_MACHINE = read('src/core/pvt/genesis-award-state-machine.ts');
const PE_UTILS = read('src/core/agent-bank/pe-utils.ts');

const PE_HISTORY_FIELDS = declaredFields(PE_HISTORY, 'PEHistoryDocument', 'export interface WritePEHistoryParams');
const GENESIS_FIELDS = declaredFields(GENESIS_MACHINE, 'GenesisQualificationDocument', '\n}\n');

describe('sweep 1 — every pe_history field a fixture sets is declared', () => {
  it('reads a non-trivial interface, so the sweep is not vacuous', () => {
    // Empty-population guard. A `declaredFields` that returned nothing would make every
    // membership assertion below pass by accident.
    expect(PE_HISTORY_FIELDS.size).toBeGreaterThan(40);
    expect(PE_HISTORY_FIELDS.has('attestation_verified')).toBe(true);
    expect(PE_HISTORY_FIELDS.has('record_points_atomic')).toBe(true);

    // RED CONTROL: the three fields M6 invented are NOT declared. If any of them ever appears,
    // it is because someone added it — not because the projection was right all along.
    for (const invented of ['actor_address', 'wallet_address', 'workProductHash']) {
      expect(PE_HISTORY_FIELDS.has(invented)).toBe(false);
    }
  });

  it('every field the settlement fixtures set on pe_history exists', () => {
    // The union of what the fork harness and the wp4 suites write. Kept as an explicit list
    // rather than scraped, so adding a fixture field is a deliberate edit to this audit too.
    const fixtureFields = [
      'peId', 'userId', 'timestamp', 'attestationDepth', 'attestation_verified',
      'submission_provenance', 'mint_status', 'record_points_atomic', 'corroboration_status',
      'is_genesis_grant', 'replication_pack', 'beneficiary_routing_snapshot', 'tx_hash',
      'economic_snapshot',
    ];
    expect(fixtureFields.length).toBeGreaterThan(0);
    for (const field of fixtureFields) {
      expect(PE_HISTORY_FIELDS.has(field)).toBe(true);
    }
  });
});

describe('sweep 2 — every Genesis outbox field a fixture sets is declared', () => {
  it('every field the Genesis fixtures set exists on GenesisQualificationDocument', () => {
    expect(GENESIS_FIELDS.size).toBeGreaterThan(15);
    const fixtureFields = [
      'schema_version', 'qualification_id', 'pe_id', 'action_type', 'wallet_id',
      'economic_actor_id', 'actor_address', 'immutable_anchor', 'qualifying_act_evidence',
      'status', 'reserved_atomic', 'created_at_ms', 'updated_at_ms', 'completed_at_ms',
    ];
    for (const field of fixtureFields) {
      expect(GENESIS_FIELDS.has(field)).toBe(true);
    }
  });

  it('`complete` is a real status of the state machine, not one the fixtures invented', () => {
    expect(GENESIS_MACHINE).toContain("| 'complete'");
    // RED CONTROL: a status nobody defines is absent, so the assertion above is testing
    // membership rather than the presence of the word anywhere in a large file.
    expect(GENESIS_MACHINE.includes("| 'settled_and_paid'")).toBe(false);
  });
});

describe('sweep 3 — the values the fixtures rely on are the values the EMITTER produces', () => {
  it('THE M7 DEFECT: the Genesis emitter sets no attestation_verified, so it defaults false', () => {
    // This is the sweep that would have caught it. The field is declared and correctly spelled;
    // what was wrong was believing THIS writer sets it.
    expect(PE_UTILS.includes('attestation_verified')).toBe(false);
    expect(PE_HISTORY).toContain('attestation_verified: params.attestation_verified ?? false');
    // The Genesis path routes through that emitter.
    expect(GENESIS_MACHINE).toContain("from '../agent-bank/pe-utils'");
    expect(GENESIS_MACHINE).toContain('deps.emitGenesisPE ?? generatePE');
  });

  it('the attestation tier the fixtures use is the tier the emitters actually pass', () => {
    // Both writers hard-code `software`; a fixture claiming `hardware_full` would be modelling
    // an act the Genesis path cannot produce, and would price it 3x differently.
    expect(GENESIS_MACHINE).toContain("attestationDepth: 'software' as const");
    expect(PE_UTILS).toContain("attestationDepth: 'software'");
    expect(PE_UTILS).toContain("attestation_type: 'software'");
  });

  it('the state machine ITSELF requires the mint_status and tier the fixtures use', () => {
    // The strongest available binding: the emitter asserts these on its own output, so a
    // fixture using them is agreeing with the writer rather than guessing.
    // Before completion only `eligible` acknowledges; `minted` is accepted only on the replay of
    // an already-complete qualification (follow-up).
    expect(GENESIS_MACHINE).toContain(": history?.mint_status === 'eligible';");
    expect(GENESIS_MACHINE).toContain("current.status === 'complete'\n    ? history?.mint_status === 'eligible' || history?.mint_status === 'minted'");
    expect(GENESIS_MACHINE).toContain("pe.attestation_type !== 'software'");
  });

  it('the envelope marker the provenance classifier keys on is what a metered relay act carries', () => {
    // `server_authored` is decided by `integration_source`. PE METER: a relay-authored act keeps
    // no envelope; the settlement inlet supplies the marker for a metered relay act (its act key
    // names a `relay:` device). If that literal changed, every metered Genesis grant would
    // silently reclassify to `unverified` and stop settling.
    expect(read('src/core/pvt/wp4/claim-inlet-source.ts'))
      .toContain("envelope: { integration_source: 'agent_bank_generate_pe'");
    expect(PE_UTILS).toContain('relayPeOf(');

    const provenance = read('src/core/pvt/wp-ev/submission-provenance.ts');
    expect(provenance).toContain("'agent_bank_generate_pe'");
  });

  it('the fork harness seeds Genesis WITHOUT attestation_verified', () => {
    // The harness is the artefact that produced the false proof, so it is audited by name.
    const harness = read('scripts/wp4-fork-e2e.ts');
    const genesisSeed = harness.slice(harness.indexOf('async function seedGenesisAct'));
    const genesisBody = genesisSeed.slice(0, genesisSeed.indexOf('\nasync function ') + 1 || undefined);
    // Matched as an ASSIGNMENT, not a mention: the seed's own comment explains why the field is
    // absent, and a substring check would find that comment and fail on the explanation.
    expect(/attestation_verified\s*:/.test(genesisBody)).toBe(false);

    // RED CONTROL: the STANDARD seed does set it, and legitimately — `server.ts` and
    // `routes/devices.ts` pass it on real submissions. So the absence above is specific to the
    // Genesis path rather than the harness simply never using the field.
    const standardSeed = harness.slice(
      harness.indexOf('async function seedQualifyingAct'),
      harness.indexOf('async function seedGenesisAct'),
    );
    expect(/attestation_verified\s*:\s*true/.test(standardSeed)).toBe(true);
    expect(read('src/server.ts').includes('attestation_verified: true')).toBe(true);
  });

  it('the fork harness stamps the Genesis envelope with the AUTHOR generatePE writes', () => {
    // Found by running it: after the provenance change the harness registered ZERO Genesis
    // claims, because its envelope omitted `integration_source` and the act therefore
    // classified as `unverified` instead of `server_authored`. Same defect class as M7 —
    // a fixture that is missing something production always writes — caught one layer up.
    const harness = read('scripts/wp4-fork-e2e.ts');
    const genesisSeed = harness.slice(harness.indexOf('async function seedGenesisAct'));
    expect(/integration_source\s*:\s*'agent_bank_generate_pe'/.test(genesisSeed)).toBe(true);

    // RED CONTROL: the value is the one the settlement inlet supplies for a metered relay act,
    // not one the harness chose.
    expect(read('src/core/pvt/wp4/claim-inlet-source.ts'))
      .toContain("envelope: { integration_source: 'agent_bank_generate_pe'");
  });
});
