/**
 * Review fix 5 — the public schema's `class_admission.unknown_action` text names EVERY lane that can
 * record a never-seen type, bound to the intake's own constants (never a copy). RED control: the
 * previous wording ("recorded only on a witness lane", two lanes) is refused by the same checks —
 * it omitted the forge lane, which records `service:github_<event>` types, and the phone batch,
 * which records unnamed types at actor_declared without queueing them.
 */
import { buildPeSchema } from './pe-schema';
import {
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  OBSERVER_PLUGIN_SOURCE,
  RELAY_OWNED_ACTION_TYPE_PREFIXES,
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
} from '../pvt/policy/new-type-intake';

function problems(text: string): string[] {
  const required = [
    SOVEREIGN_HARDWARE_WITNESS_SOURCE, DEVICE_GATEWAY_OBSERVER_SOURCE, OBSERVER_PLUGIN_SOURCE,
    ...RELAY_OWNED_ACTION_TYPE_PREFIXES, 'service:github_', 'actor_declared', 'does NOT queue', 'earning-proposals',
    // , A: rule (ii) is a positive grant, named where a reader can find it.
    'INTAKE_SIGNED_ACTION_TYPES',
  ];
  const out = required.filter((needle) => !text.includes(needle)).map((needle) => `missing:${needle}`);
  if (/recorded only on a witness lane/.test(text)) out.push('claims_only_two_lanes');
  return out;
}

describe('pe-schema class_admission.unknown_action lists every lane accurately', () => {
  it('the served text passes', () => {
    expect(problems(buildPeSchema().class_admission.unknown_action)).toEqual([]);
  });

  it('RED — the previous two-lane wording is refused', () => {
    const previous = 'A never-seen action_type is recorded only on a witness lane — the sovereign route with an admitted '
      + 'hardware_witness, or the device batch from a registered observer’s gateway plugin (metadata.source `observer_plugin` '
      + '+ metadata.observer_plugin, stamped by the observer) — sealed record_only (0 PVT), queued for review in the pending-policy '
      + 'queue under its lane, and shown on the public proposals dashboard (GET /v1/pe/earning-proposals).';
    expect(problems(previous)).toContain('claims_only_two_lanes');
    expect(problems(previous)).toContain('missing:service:github_');
    expect(problems(previous)).toContain('missing:INTAKE_SIGNED_ACTION_TYPES');
  });
});
