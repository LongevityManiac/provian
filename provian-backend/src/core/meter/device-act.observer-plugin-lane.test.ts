/**
 * A third-party observer plugin is never a built-in lane (follow-up, 2026-10-23).
 *
 * The observer stamps its gateway-plugin marker (`metadata.source: 'observer_plugin'` +
 * `metadata.observer_plugin: <name>`) on EVERY PE a plugin registered through `registerPlugin` hands
 * it; only the daemon's own lanes carry a lane marker (`source` transcript/otel/model_proxy/process,
 * `tool` provian:transcript/…). The device batch refuses, as actor_declared:
 * - a plugin-marked act that also names a built-in lane (any type, the never-seen intake types too);
 * - a plugin-marked `link_spend` or `agent_tool_orchestration` the types only a built-in lane
 * witnesses.
 * Built-in lane acts (no plugin marker) are unchanged.
 *
 * Each refusal carries its RED control: the same act WITHOUT the plugin marker clears intake.
 */
import { describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { deviceActToAccrualParams, type DeviceBatchLane } from './device-act';
import type { ActRecord } from './meter-wire';
import type { DeviceDocument } from '../../routes/middleware/device-auth';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { OBSERVER_PLUGIN_SOURCE, newTypeIntakeCache } from '../pvt/policy/new-type-intake';
import {
  BUILT_IN_LANE_ONLY_ACTION_TYPES,
  DAEMON_TOOL_ORCHESTRATION_LANES,
  DEVICE_OBSERVATION_ACTION_TYPES,
  carriesBuiltInLaneMarker,
} from '../provenance/device-observation-types';

const NOW = Date.now();
const PLUGIN = { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway' };
const NEVER_SEEN = ['kiln', 'cycle', 'completed'].join('_');
const SPEND = {
  link_spend_id: 'lsrq_1AbCdEfGhIjKlMnOpQrStUv', amount: 3500, currency: 'usd', status: 'succeeded',
};

function lane(db: Firestore): DeviceBatchLane {
  return {
    db,
    device: { owner_type: 'agent', device_id: 'dev_pl_1', owner_user_id: 'user_pl', owner_wallet_id: 'w_pl' } as DeviceDocument,
    ownerId: 'user_pl', signatureAuthenticated: true, bodyBound: true, attestationTier: 'software',
    receivedAtMs: NOW, lineage: null, lineageTouched: false, intakeCache: newTypeIntakeCache(),
  };
}

let seq = 0;
function act(actionType: string, metadata: Record<string, unknown>): ActRecord {
  seq += 1;
  return {
    action_type: actionType, pe_id: `pe_pl_${seq}`, timestamp: NOW, prev_hash: 'genesis',
    pe_hash: `sha256:${'a'.repeat(64)}`, pricing: { metadata },
  } as ActRecord;
}

/** The mapping's verdict; reaching a read this suite's fake does not serve means intake cleared. */
async function intake(actionType: string, metadata: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const db = createFakeFirestore() as unknown as Firestore;
  try {
    const r = await deviceActToAccrualParams(lane(db), act(actionType, metadata), 'relay_fixture');
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (err) {
    return { ok: true, reason: `cleared_intake:${(err as Error).message}` };
  }
}

const LANE_MARKERS: Record<string, unknown>[] = [
  ...Object.keys(DAEMON_TOOL_ORCHESTRATION_LANES).map((source) => ({ source })),
  ...Object.values(DAEMON_TOOL_ORCHESTRATION_LANES).map((tool) => ({ tool })),
];

describe('carriesBuiltInLaneMarker', () => {
  it('names every daemon lane source and tool, and nothing else (never a pass over an empty population)', () => {
    expect(LANE_MARKERS.length).toBe(8);
    for (const md of LANE_MARKERS) expect([md, carriesBuiltInLaneMarker(md)]).toEqual([md, true]);
    for (const md of [undefined, null, [], {}, { source: OBSERVER_PLUGIN_SOURCE }, { tool: 'kiln' }, { source: 'git_hook' }, { source: 'toString' }, { tool: 'provian-observer' }]) {
      expect([md, carriesBuiltInLaneMarker(md)]).toEqual([md, false]);
    }
  });

  it('the built-in-lane-only types are observation types (link_spend, agent_tool_orchestration)', () => {
    expect([...BUILT_IN_LANE_ONLY_ACTION_TYPES].sort()).toEqual(['agent_tool_orchestration', 'link_spend']);
    for (const t of BUILT_IN_LANE_ONLY_ACTION_TYPES) expect(DEVICE_OBSERVATION_ACTION_TYPES.has(t)).toBe(true);
  });
});

describe('a plugin-marked act cannot claim a built-in lane', () => {
  it('link_spend carrying the transcript source AND a plugin name is refused; RED: without the plugin name it clears intake', async () => {
    expect(await intake('link_spend', { ...SPEND, source: 'transcript', observer_plugin: 'kiln-gateway' }))
      .toEqual({ ok: false, reason: 'actor_declared:observer_plugin_names_built_in_lane' });
    expect((await intake('link_spend', { ...SPEND, source: 'transcript' })).ok).toBe(true);
  });

  it('link_spend under the observer-plugin marker is refused as a built-in-lane type (not merely "not transcript")', async () => {
    expect(await intake('link_spend', { ...SPEND, ...PLUGIN }))
      .toEqual({ ok: false, reason: 'actor_declared:observer_plugin_built_in_lane_type' });
  });

  it('agent_tool_orchestration naming a daemon lane tool under the plugin marker is refused; RED: the lane itself clears intake', async () => {
    for (const [source, tool] of Object.entries(DAEMON_TOOL_ORCHESTRATION_LANES)) {
      expect([tool, await intake('agent_tool_orchestration', { ...PLUGIN, tool, tool_count: 1, turn_id: 't1' })])
        .toEqual([tool, { ok: false, reason: 'actor_declared:observer_plugin_names_built_in_lane' }]);
      expect([tool, (await intake('agent_tool_orchestration', { source, tool, tool_count: 1, turn_id: 't1' })).ok]).toEqual([tool, true]);
    }
    expect(await intake('agent_tool_orchestration', { ...PLUGIN, tool: 'kiln', tool_count: 1 }))
      .toEqual({ ok: false, reason: 'actor_declared:observer_plugin_built_in_lane_type' });
  });

  it('every other observation type and a never-seen type are refused when the plugin marker names a lane; RED: the plugin marker alone is not refused here', async () => {
    const others = [...DEVICE_OBSERVATION_ACTION_TYPES].filter((t) => !BUILT_IN_LANE_ONLY_ACTION_TYPES.has(t));
    expect(others.length).toBe(5);
    for (const t of [...others, NEVER_SEEN]) {
      for (const marker of LANE_MARKERS) {
        const r = await intake(t, { ...PLUGIN, ...marker });
        // A plugin name beside a lane source, or the plugin source beside a lane tool. (A never-seen
        // type whose source is not the plugin marker is refused one gate earlier, by the intake rule.)
        const reason = t === NEVER_SEEN && 'source' in marker
          ? 'actor_declared:action_type_not_observed'
          : 'actor_declared:observer_plugin_names_built_in_lane';
        expect([t, marker, r]).toEqual([t, marker, { ok: false, reason }]);
      }
      const plain = await intake(t, { ...PLUGIN, api_count: 1 });
      expect([t, plain.reason ?? '']).not.toEqual([t, expect.stringMatching(/^actor_declared:observer_plugin/)]);
    }
  });
});
