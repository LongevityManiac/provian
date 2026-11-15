/**
 * the `doctor_synthetic_trace` detector proves the producer bug (an observer before
 * release 38 submitted `provian doctor`'s fabricated turn as work) from the sealed envelope.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  DOCTOR_PROBE_ORCHESTRATION_NAME,
  DOCTOR_PROBE_TOOL_NAMES,
  PRODUCTION_BUG_DETECTORS,
  demoteBugProducedPe,
  doctorSyntheticTraceDetector,
} from './bug-demotion';

const PE = 'pe_578ec3f1-fixture';
const HASH = 'sha256:fixture';

async function seed(db: Firestore, env: Record<string, unknown>, actionType = 'agent_tool_orchestration'): Promise<void> {
  await db.collection('pe_history').doc(PE).set({
    peId: PE, actionType, mint_status: 'eligible', mint_disposition: 'eligible',
    economic_snapshot_hash: HASH, economic_snapshot: { immutable: true }, record_points_atomic: '1600000000000000000',
  });
  await db.collection('provenance_envelopes').doc(PE).set(env);
}

// The exact shape sealed on prod for pe_578ec3f1 (d495-bot, 2026-09-29), identifiers trimmed.
const DOCTOR_ENV = {
  action_type: 'agent_tool_orchestration',
  description: 'provian doctor synthetic turn — 2 tool calls',
  metadata: {
    tool: 'provian-observer-otel', trace_id: '441ec891e7911a7900719db21c71feb9', turn_id: '441ec891e7911a7900719db21c71feb9',
    tool_count: 2, tool_names: ['provian_doctor_probe_1', 'provian_doctor_probe_2'], otel_convention: 'genai',
  },
};

describe('doctor_synthetic_trace detector ', () => {
  it('is shipped, and proves the sealed doctor turn', async () => {
    expect(PRODUCTION_BUG_DETECTORS.doctor_synthetic_trace).toBe(doctorSyntheticTraceDetector);
    const db = createFakeFirestore() as unknown as Firestore;
    await seed(db, DOCTOR_ENV);
    const r = await demoteBugProducedPe({ db, peId: PE, detectorId: 'doctor_synthetic_trace', expectedSnapshotHash: HASH, execute: false });
    expect(r.kind).toBe('dry_run_proved');
  });

  // RED CONTROLS: real work — another description, other tool names, an extra tool, another
  // lane's tool, another action type, or no envelope — is never proved.
  it('never proves a real turn or a near-miss', async () => {
    const variants: Array<[string, Record<string, unknown>, string?]> = [
      ['real description', { ...DOCTOR_ENV, description: 'agent turn — 2 tool calls' }],
      ['real tools', { ...DOCTOR_ENV, metadata: { ...DOCTOR_ENV.metadata, tool_names: ['web_search', 'shell'] } }],
      ['extra tool', { ...DOCTOR_ENV, metadata: { ...DOCTOR_ENV.metadata, tool_count: 3, tool_names: [...DOCTOR_PROBE_TOOL_NAMES, 'shell'] } }],
      ['one probe name', { ...DOCTOR_ENV, metadata: { ...DOCTOR_ENV.metadata, tool_names: ['provian_doctor_probe_1', 'shell'] } }],
      ['transcript lane', { ...DOCTOR_ENV, metadata: { ...DOCTOR_ENV.metadata, tool: 'provian-observer-transcript' } }],
      ['api orchestration', { ...DOCTOR_ENV, action_type: 'agent_api_orchestration' }, 'agent_api_orchestration'],
    ];
    for (const [name, env, at] of variants) {
      const db = createFakeFirestore() as unknown as Firestore;
      await seed(db, env, at);
      const r = await demoteBugProducedPe({ db, peId: PE, detectorId: 'doctor_synthetic_trace', expectedSnapshotHash: HASH, execute: false });
      expect({ name, kind: r.kind }).toEqual({ name, kind: 'refused' });
    }
    const db = createFakeFirestore() as unknown as Firestore;
    await db.collection('pe_history').doc(PE).set({ peId: PE, actionType: 'agent_tool_orchestration', mint_status: 'eligible', mint_disposition: 'eligible', economic_snapshot_hash: HASH });
    expect((await demoteBugProducedPe({ db, peId: PE, detectorId: 'doctor_synthetic_trace', expectedSnapshotHash: HASH, execute: false })).kind).toBe('refused');
  });

  it('mirrors the SDK probe definition exactly (one source per package, pinned)', () => {
    const sdk = fs.readFileSync(path.resolve(__dirname, '../../../../../provian-agent-sdk/src/observer/doctor-probe.ts'), 'utf8');
    expect(sdk).toContain(`export const DOCTOR_PROBE_ORCHESTRATION_NAME = '${DOCTOR_PROBE_ORCHESTRATION_NAME}';`);
    expect(sdk).toContain(`export const DOCTOR_PROBE_TOOL_NAMES: readonly string[] = [${DOCTOR_PROBE_TOOL_NAMES.map((n) => `'${n}'`).join(', ')}];`);
  });
});
