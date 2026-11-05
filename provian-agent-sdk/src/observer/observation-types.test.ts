/**
 * New-type intake , SDK side.
 *
 * - The SDK's observation-type set and gateway marker are bound to the RELAY's own source files
 * (read here), so a drift on either side turns this suite red.
 * - The OBSERVER (never the plugin) stamps `metadata.source = 'observer_plugin'` +
 * `metadata.observer_plugin = <plugin name>`, overriding whatever the plugin set: on EVERY PE a
 * third-party plugin hands it (observation types included, any built-in lane `tool` dropped), and
 * on a built-in lane's PE of a non-observation type; a built-in lane's observation-type PE passes
 * through untouched (follow-up, 2026-10-23).
 * - A third-party plugin registers through the public API (`registerPlugin`) and its PE is
 * recorded in this machine's PE store — no client-side refusal of an unknown type — but a type
 * only a built-in lane witnesses (`link_spend`, `agent_tool_orchestration`) is refused locally.
 *
 * RED controls: a plugin that tries to forge `source` / `observer_plugin` / a lane `tool` is
 * overridden; a third-party `link_spend` claiming the transcript source is refused while the same PE
 * from the built-in transcript lane class is recorded byte-identical.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  BUILT_IN_LANE_ONLY_ACTION_TYPES,
  DAEMON_TOOL_ORCHESTRATION_LANES,
  carriesBuiltInLaneMarker,
  withThirdPartyPluginWitness,
  DEVICE_OBSERVATION_ACTION_TYPES,
  OBSERVER_PLUGIN_NAME_MAX_LENGTH,
  OBSERVER_PLUGIN_NAME_RE,
  OBSERVER_PLUGIN_SOURCE,
  observerPluginNameCarriesMarker,
  withObserverPluginWitness,
  ACTION_TYPE_PATTERN,
  MAX_ACTION_TYPE_LENGTH,
  RELAY_OWNED_ACTION_TYPE_PREFIXES,
  pluginActionTypeRefusal,
} from './observation-types';
import { ProvianObserver } from './ProvianObserver';
import type { ObserverPlugin } from './plugins/PluginInterface';
import type { PluginPE } from './types';
import { CapturingPeStore } from '../meter/capturing-store.test-support';
import * as observerEntry from './index';
import { isBuiltInLane, registerBuiltInLane } from './built-in-lanes';
import { TranscriptPlugin } from './plugins/transcript/TranscriptPlugin';

const BACKEND = path.resolve(__dirname, '../../../provian-backend/src');
const KILN = ['kiln', 'cycle', 'completed'].join('_');

describe('the SDK mirror is bound to the relay', () => {
  it('DEVICE_OBSERVATION_ACTION_TYPES equals the relay set (read from the relay source)', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'core/provenance/device-observation-types.ts'), 'utf8');
    const block = /DEVICE_OBSERVATION_ACTION_TYPES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block).not.toBeNull();
    const relay = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(relay.length).toBeGreaterThanOrEqual(7); // never a pass over an empty population
    expect([...DEVICE_OBSERVATION_ACTION_TYPES].sort()).toEqual(relay);
  });

  it('the marker source, the name bound and the name grammar equal the relay constants (read from its source)', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'core/pvt/policy/new-type-intake.ts'), 'utf8');
    expect(/OBSERVER_PLUGIN_SOURCE = '([^']+)'/.exec(src)?.[1]).toBe(OBSERVER_PLUGIN_SOURCE);
    expect(Number(/OBSERVER_PLUGIN_NAME_MAX_LENGTH = (\d+)/.exec(src)?.[1])).toBe(OBSERVER_PLUGIN_NAME_MAX_LENGTH);
    const relayRe = /const OBSERVER_PLUGIN_NAME_RE = (\/.+\/);/.exec(src)?.[1];
    expect(relayRe).toBeDefined();
    expect(String(OBSERVER_PLUGIN_NAME_RE)).toBe(relayRe);
  });

  it('observerPluginNameCarriesMarker accepts exactly what the relay accepts (RED: @acme/kiln, spaces, 129 chars)', () => {
    for (const ok of ['kiln-gateway', 'acme/kiln@2', 'K1', 'x'.repeat(128)]) expect([ok, observerPluginNameCarriesMarker(ok)]).toEqual([ok, true]);
    for (const bad of ['@acme/kiln', 'Kiln Gateway', '', '-lead', 'x'.repeat(129), 'a\nb', 42]) {
      expect([bad, observerPluginNameCarriesMarker(bad)]).toEqual([bad, false]);
    }
  });

  it('the daemon lanes and the built-in-lane-only types equal the relay\'s (read from device-observation-types.ts)', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'core/provenance/device-observation-types.ts'), 'utf8');
    const lanes = /DAEMON_TOOL_ORCHESTRATION_LANES: Readonly<Record<string, string>> = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? '';
    const relayLanes = Object.fromEntries([...lanes.matchAll(/^\s*([a-z_]+): '([^']+)'/gm)].map((m) => [m[1], m[2]]));
    expect(Object.keys(relayLanes).length).toBeGreaterThanOrEqual(4); // never a pass over an empty population
    expect({ ...DAEMON_TOOL_ORCHESTRATION_LANES }).toEqual(relayLanes);
    const only = /BUILT_IN_LANE_ONLY_ACTION_TYPES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
    const relayOnly = [...only.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(relayOnly.length).toBeGreaterThanOrEqual(2);
    expect([...BUILT_IN_LANE_ONLY_ACTION_TYPES].sort()).toEqual(relayOnly);
    // The relay refuses a plugin-marked act under exactly these two names (device-act.ts).
    const act = fs.readFileSync(path.join(BACKEND, 'core/meter/device-act.ts'), 'utf8');
    expect(act).toContain("if (carriesBuiltInLaneMarker(metadata)) return { ok: false, reason: 'actor_declared:observer_plugin_names_built_in_lane' };");
    expect(act).toContain("if (BUILT_IN_LANE_ONLY_ACTION_TYPES.has(actionType)) return { ok: false, reason: 'actor_declared:observer_plugin_built_in_lane_type' };");
  });

  it('carriesBuiltInLaneMarker reads a lane source or a lane tool, nothing else', () => {
    const markers = [
      ...Object.keys(DAEMON_TOOL_ORCHESTRATION_LANES).map((source) => ({ source })),
      ...Object.values(DAEMON_TOOL_ORCHESTRATION_LANES).map((tool) => ({ tool })),
    ];
    expect(markers).toHaveLength(8);
    for (const md of markers) expect([md, carriesBuiltInLaneMarker(md)]).toEqual([md, true]);
    for (const md of [undefined, {}, { source: OBSERVER_PLUGIN_SOURCE }, { tool: 'kiln' }, { source: 'toString' }, []]) {
      expect([md, carriesBuiltInLaneMarker(md)]).toEqual([md, false]);
    }
  });

  it('the action_type grammar equals the relay\'s (read from action-type-syntax.ts)', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'core/pvt/policy/action-type-syntax.ts'), 'utf8');
    expect(Number(/MAX_POLICY_ACTION_TYPE_LENGTH = (\d+)/.exec(src)?.[1])).toBe(MAX_ACTION_TYPE_LENGTH);
    const relayRe = /POLICY_ACTION_TYPE_PATTERN =\s*(\/.+\/);/.exec(src)?.[1];
    expect(relayRe).toBeDefined();
    expect(String(ACTION_TYPE_PATTERN)).toBe(relayRe);
  });

  it('the relay-owned prefixes equal the relay\'s (read from new-type-intake.ts)', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'core/pvt/policy/new-type-intake.ts'), 'utf8');
    const block = /RELAY_OWNED_ACTION_TYPE_PREFIXES: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(src)?.[1];
    expect(block).toBeDefined();
    const relay = [...(block ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(relay.length).toBeGreaterThan(0); // never a pass over an empty population
    expect([...RELAY_OWNED_ACTION_TYPE_PREFIXES]).toEqual(relay);
  });

  it('pluginActionTypeRefusal: malformed and relay-owned types are refused; observation and well-formed types are not', () => {
    for (const t of ['kiln-cycle', '9kiln', 'Kiln:cycle', 'kiln cycle', '', 'k'.repeat(201), 42, undefined]) {
      expect([t, pluginActionTypeRefusal(t)]).toEqual([t, 'invalid_action_type']);
    }
    for (const t of ['service:github_x', 'git_x', 'git_tag_pushed']) {
      expect([t, pluginActionTypeRefusal(t)]).toEqual([t, 'relay_owned_namespace']);
    }
    for (const t of [KILN, 'acme:kiln_cycle', 'k'.repeat(200), ...DEVICE_OBSERVATION_ACTION_TYPES]) {
      expect([t, pluginActionTypeRefusal(t)]).toEqual([t, null]);
    }
  });

  it('the observer entry point exports the mirror for plugin authors', () => {
    expect(observerEntry.OBSERVER_PLUGIN_SOURCE).toBe('observer_plugin');
    expect(observerEntry.isDeviceObservationActionType('coding_session')).toBe(true);
    expect(observerEntry.isDeviceObservationActionType(KILN)).toBe(false);
  });
});

describe('withObserverPluginWitness', () => {
  it('stamps a non-observation type with the observer marker, overriding a forged one (RED: the plugin\'s values never survive)', () => {
    const forged = { reading_id: 'r1', source: 'transcript', observer_plugin: 'someone-else' };
    expect(withObserverPluginWitness('kiln-gateway', KILN, forged)).toEqual({
      reading_id: 'r1', source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway',
    });
    expect(withObserverPluginWitness('kiln-gateway', KILN, undefined)).toEqual({
      source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway',
    });
  });

  it('RED — an observation type is passed through as the SAME object (built-in lanes byte-identical)', () => {
    expect(DEVICE_OBSERVATION_ACTION_TYPES.size).toBe(7);
    for (const t of DEVICE_OBSERVATION_ACTION_TYPES) {
      const md = { tool: 'provian:transcript', source: 'transcript' };
      expect(withObserverPluginWitness('any', t, md)).toBe(md);
    }
  });
});

describe('withThirdPartyPluginWitness', () => {
  it('stamps EVERY type, observation types included, and drops a built-in lane tool (RED: the plugin\'s lane markers never survive)', () => {
    for (const t of [...DEVICE_OBSERVATION_ACTION_TYPES, KILN]) {
      for (const [source, tool] of Object.entries(DAEMON_TOOL_ORCHESTRATION_LANES)) {
        const md = { tool, source, observer_plugin: 'someone-else', turn_id: 't1' };
        const out = withThirdPartyPluginWitness('kiln-gateway', md);
        expect([t, out]).toEqual([t, { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway', turn_id: 't1' }]);
        expect(carriesBuiltInLaneMarker(out)).toBe(false);
        // The plugin's own object is untouched.
        expect(md.tool).toBe(tool);
      }
    }
  });

  it('keeps a tool that names no built-in lane, and stamps an absent metadata', () => {
    expect(withThirdPartyPluginWitness('kiln-gateway', { tool: 'kiln' })).toEqual({ tool: 'kiln', source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway' });
    expect(withThirdPartyPluginWitness('kiln-gateway', undefined)).toEqual({ source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway' });
  });
});

describe('built-in lanes', () => {
  it('the daemon registers every lane it constructs through registerBuiltInLane, never the public registerPlugin (read from run-daemon.ts)', () => {
    const daemon = fs.readFileSync(path.join(__dirname, 'run-daemon.ts'), 'utf8');
    const constructed = [...new Set([...daemon.matchAll(/new ([A-Za-z]+Plugin)\(/g)].map((m) => m[1]))].sort();
    expect(constructed.length).toBeGreaterThanOrEqual(9); // never a pass over an empty population
    expect(daemon).not.toMatch(/\.registerPlugin\(/);
    // Each lane class is registered either inline (`registerBuiltInLane(observer, new X(`) or through the
    // variable it was constructed into (`const v = … new X(…)` then `registerBuiltInLane(observer, v)`).
    const registeredClasses = new Set([...daemon.matchAll(/registerBuiltInLane\(observer, new ([A-Za-z]+Plugin)\(/g)].map((m) => m[1]));
    for (const m of daemon.matchAll(/const (\w+) = [^;\n]*\bnew ([A-Za-z]+Plugin)\(/g)) {
      if (daemon.includes(`registerBuiltInLane(observer, ${m[1]})`)) registeredClasses.add(m[2]);
    }
    expect([...registeredClasses].sort()).toEqual(constructed);
  });

  it('RED — status comes from the daemon\'s registration only: a prototype forge, a plain object, and a genuine lane instance registered through registerPlugin are all plugins', () => {
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: new CapturingPeStore(),
      credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' }, hardwareWitness: 'none',
    });
    const forged = Object.assign(Object.create(TranscriptPlugin.prototype) as ObserverPlugin, { name: 'my-plugin' });
    const genuine = new TranscriptPlugin({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lane-')) });
    for (const p of [forged, genuine, { name: 'transcript' } as ObserverPlugin]) {
      observer.registerPlugin(p);
      expect([p.name, isBuiltInLane(p)]).toEqual([p.name, false]);
    }
    // Positive control: the daemon's own registration path grants it, to that instance only.
    const daemonLane = new TranscriptPlugin({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lane-')) });
    registerBuiltInLane(observer, daemonLane);
    expect(isBuiltInLane(daemonLane)).toBe(true);
    expect(isBuiltInLane(genuine)).toBe(false);
  });
});

describe('a third-party plugin registered through the public API', () => {
  function plugin(pes: PluginPE[], name = 'kiln-gateway'): ObserverPlugin & { outcomes: string[] } {
    const outcomes: string[] = [];
    return {
      name,
      outcomes,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      tick: () => null,
      drainPEs: () => pes.splice(0),
      onCommitted: (_pe, outcome) => { outcomes.push(outcome); },
    };
  }

  it('its never-seen type AND its observation-type PE are recorded locally with the observer\'s marker', async () => {
    const store = new CapturingPeStore();
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store,
      credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' },
      hardwareWitness: 'none',
    });
    const now = Date.now();
    const p = plugin([
      {
        actionType: KILN, metadata: { cycle_id: 'c-17', source: 'forged', observer_plugin: 'not-me' },
        output_digests: [{ hash: `sha256:${'e'.repeat(64)}`, kind: 'sensor' }],
        windowStart: now - 2000, windowEnd: now - 1000, skipDedupClaim: true,
      },
      { actionType: 'ai_conversation', metadata: { surface: 'claude', source: 'transcript', tool: 'provian:transcript' }, windowStart: now - 900, windowEnd: now - 800, skipDedupClaim: true },
    ]);
    observer.registerPlugin(p);
    await observer.start();
    await observer.stop();

    expect(store.bodies).toHaveLength(2);
    const kiln = store.bodies.find((b) => b.action_type === KILN);
    const chat = store.bodies.find((b) => b.action_type === 'ai_conversation');
    expect((kiln?.metadata as Record<string, unknown>)).toMatchObject({
      cycle_id: 'c-17', source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway',
    });
    // RED: the lane source and tool the plugin set never reach the wire.
    // (`success` is the client's own field on every observed PE.)
    expect(chat?.metadata).toEqual({ surface: 'claude', source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'kiln-gateway', success: true });
    expect(p.outcomes).toEqual(['submitted', 'submitted']);
  });

  it('RED — a plugin whose name cannot carry the marker has EVERY PE refused LOCALLY (nothing recorded, outcome rejected)', async () => {
    for (const name of ['@acme/kiln', 'Kiln Gateway']) {
      const store = new CapturingPeStore();
      const observer = new ProvianObserver({
        idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
        relayUrl: 'https://relay.test', logLevel: 'error', peStore: store,
        credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' },
        hardwareWitness: 'none',
      });
      const now = Date.now();
      const p = plugin([
        { actionType: KILN, metadata: { cycle_id: 'c-18' }, windowStart: now - 2000, windowEnd: now - 1000, skipDedupClaim: true },
        { actionType: 'ai_conversation', metadata: { surface: 'claude' }, windowStart: now - 900, windowEnd: now - 800, skipDedupClaim: true },
      ], name);
      observer.registerPlugin(p);
      await observer.start();
      await observer.stop();
      // Every PE of a third-party plugin bears the marker, so both are refused.
      expect([name, store.bodies.map((b) => b.action_type)]).toEqual([name, []]);
      expect([name, p.outcomes]).toEqual([name, ['rejected', 'rejected']]);
    }
  });

  it('RED ( , B) — a malformed or relay-owned type is refused LOCALLY with a logged reason (nothing recorded, outcome rejected)', async () => {
    const store = new CapturingPeStore();
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store,
      credentials: { deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' },
      hardwareWitness: 'none',
    });
    const logSpy = vi.spyOn(observer, 'log');
    const now = Date.now();
    const bad = ['kiln-cycle', 'service:github_x', 'git_x'];
    const p = plugin([
      ...bad.map((actionType, i) => ({ actionType, metadata: {}, windowStart: now - 5000 + i, windowEnd: now - 4000 + i, skipDedupClaim: true })),
      { actionType: KILN, metadata: {}, windowStart: now - 900, windowEnd: now - 800, skipDedupClaim: true },
    ]);
    observer.registerPlugin(p);
    await observer.start();
    await observer.stop();
    expect(store.bodies.map((b) => b.action_type)).toEqual([KILN]);
    expect(p.outcomes).toEqual(['rejected', 'rejected', 'rejected', 'submitted']);
    const reasons = logSpy.mock.calls
      .filter(([level, msg]) => level === 'error' && msg.startsWith('plugin PE refused: the relay never accepts'))
      .map(([, , extra]) => extra?.reason);
    expect(reasons).toEqual(['invalid_action_type', 'relay_owned_namespace', 'relay_owned_namespace']);
  });

  const agentCredentials = { ownerType: 'agent' as const, deviceKey: 'pdk_test', deviceSecret: 'pds_test', relayUrl: 'https://relay.test' };
  const LINK_SPEND: PluginPE = {
    actionType: 'link_spend',
    metadata: { link_spend_id: 'lsrq_1AbCdEfGhIjKlMnOpQrStUv', amount: 3500, currency: 'usd', status: 'succeeded', source: 'transcript', harness: 'claude-code' },
    windowStart: 1_000, windowEnd: 1_001, identityDecided: true,
  };
  const TOOL_TURN: PluginPE = {
    actionType: 'agent_tool_orchestration',
    metadata: { tool: 'provian:transcript', source: 'transcript', program: 'claude-code', turn_id: 'tf:x:1', tool_count: 1 },
    windowStart: 2_000, windowEnd: 2_001, identityDecided: true,
  };

  it('its link_spend claiming the transcript source, and its tool-orchestration turn, are refused LOCALLY (logged, nothing recorded, outcome rejected)', async () => {
    const store = new CapturingPeStore();
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store, credentials: agentCredentials, hardwareWitness: 'none',
    });
    const logSpy = vi.spyOn(observer, 'log');
    const p = plugin([{ ...LINK_SPEND }, { ...TOOL_TURN }, { actionType: KILN, metadata: {}, windowStart: 3_000, windowEnd: 3_001, skipDedupClaim: true }]);
    observer.registerPlugin(p);
    await observer.start();
    await observer.stop();
    expect(store.bodies.map((b) => b.action_type)).toEqual([KILN]);
    expect(p.outcomes).toEqual(['rejected', 'rejected', 'submitted']);
    const refused = logSpy.mock.calls
      .filter(([level, msg]) => level === 'error' && msg === 'plugin PE refused: only a built-in observer lane witnesses this action_type')
      .map(([, , extra]) => extra?.action_type);
    expect(refused).toEqual(['link_spend', 'agent_tool_orchestration']);
  });

  it('RED (review) — a TranscriptPlugin prototype forge and a genuine TranscriptPlugin registered through registerPlugin are refused the transcript lane\'s PEs', async () => {
    const store = new CapturingPeStore();
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store, credentials: agentCredentials, hardwareWitness: 'none',
    });
    const forged = Object.assign(Object.create(TranscriptPlugin.prototype) as ObserverPlugin, { name: 'my-plugin' });
    const genuine = new TranscriptPlugin({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lane-')) });
    const submit = (observer as unknown as { submitPluginPE: (p: ObserverPlugin, pe: PluginPE, cs: null) => Promise<string> }).submitPluginPE.bind(observer);
    for (const p of [forged, genuine]) {
      observer.registerPlugin(p);
      expect(await submit(p, { ...LINK_SPEND }, null)).toBe('rejected');
      expect(await submit(p, { ...TOOL_TURN }, null)).toBe('rejected');
    }
    expect(store.bodies).toEqual([]);
  });

  it('RED — the SAME PEs from a lane the daemon registered are recorded with their metadata byte-identical', async () => {
    const store = new CapturingPeStore();
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 15 * 60_000, tickIntervalMs: 60_000, plugins: [],
      relayUrl: 'https://relay.test', logLevel: 'error', peStore: store, credentials: agentCredentials, hardwareWitness: 'none',
    });
    // The daemon's own lane (not started: its PEs are handed straight to the submitter).
    const lane = new TranscriptPlugin({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lane-')) });
    registerBuiltInLane(observer, lane);
    expect(isBuiltInLane(lane)).toBe(true);
    const submit = (observer as unknown as { submitPluginPE: (p: ObserverPlugin, pe: PluginPE, cs: null) => Promise<string> }).submitPluginPE.bind(observer);
    expect(await submit(lane, { ...LINK_SPEND }, null)).toBe('submitted');
    expect(await submit(lane, { ...TOOL_TURN }, null)).toBe('submitted');
    expect(store.bodies.map((b) => b.action_type)).toEqual(['link_spend', 'agent_tool_orchestration']);
    // (`success` is the client's own field on every observed PE.)
    expect(store.bodies[0].metadata).toEqual({ ...LINK_SPEND.metadata, success: true });
    expect(store.bodies[1].metadata).toEqual({ ...TOOL_TURN.metadata, success: true });
  });
});
