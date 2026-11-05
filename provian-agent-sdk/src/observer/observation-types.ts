/**
 * The SDK mirror of the relay's device OBSERVATION-lane types
 * (`provian-backend/src/core/provenance/device-observation-types.ts`,) and of the gateway
 * plugin witness marker (`provian-backend/src/core/pvt/policy/new-type-intake.ts`, new-type intake,
 *). `observation-types.test.ts` reads both relay files and fails if this drifts.
 *
 * The observer daemon's own lanes emit only observation types. Any OTHER type a registered plugin
 * hands the observer (a gateway plugin reporting what it observed — a sensor reading, a kiln cycle)
 * is a never-seen type to the relay: it records with no mint, is queued for the operator’s review, and
 * earns only once a matrix row for it is signed. The relay admits such an act only when the
 * OBSERVER — never the plugin — names the plugin that observed it (see `withObserverPluginWitness`).
 *
 * A third-party plugin is never one of the daemon's lanes (follow-up, 2026-10-23): the observer
 * stamps EVERY PE it hands over with that marker and drops any built-in lane marker it set
 * (`withThirdPartyPluginWitness`), and refuses locally a type only a built-in lane witnesses
 * (`BUILT_IN_LANE_ONLY_ACTION_TYPES`); the relay refuses both under the marker (`device-act.ts`).
 */

export const DEVICE_OBSERVATION_ACTION_TYPES: ReadonlySet<string> = new Set([
  'compute_session',
  'inference_session',
  'coding_session',
  'agent_tool_orchestration',
  'agent_api_orchestration',
  'ai_conversation',
  'link_spend',
]);

export function isDeviceObservationActionType(actionType: unknown): actionType is string {
  return typeof actionType === 'string' && DEVICE_OBSERVATION_ACTION_TYPES.has(actionType);
}

/** `metadata.source` the observer stamps on a plugin PE of a non-observation type. */
export const OBSERVER_PLUGIN_SOURCE = 'observer_plugin';
/** The relay's bound on `metadata.observer_plugin` (a plugin name, never free text). */
export const OBSERVER_PLUGIN_NAME_MAX_LENGTH = 128;
/** The relay's grammar for `metadata.observer_plugin` (mirrors `new-type-intake.ts`; bound by test). */
export const OBSERVER_PLUGIN_NAME_RE = /^[A-Za-z0-9][\x21-\x7E]*$/;

/**
 * True when `pluginName` can carry the observer's witness marker: the relay refuses every act whose
 * `observer_plugin` is longer than 128 characters or is not one printable token starting with a
 * letter or digit (`@acme/kiln` and `Kiln Gateway` cannot). The observer refuses such a plugin's
 * non-observation PEs locally instead of sending acts the relay would refuse.
 */
export function observerPluginNameCarriesMarker(pluginName: unknown): pluginName is string {
  return typeof pluginName === 'string'
    && pluginName.length > 0
    && pluginName.length <= OBSERVER_PLUGIN_NAME_MAX_LENGTH
    && OBSERVER_PLUGIN_NAME_RE.test(pluginName);
}

/**
 * The relay's ONE action_type grammar (`provian-backend/src/core/pvt/policy/action-type-syntax.ts`:
 * `MAX_POLICY_ACTION_TYPE_LENGTH`, `POLICY_ACTION_TYPE_PATTERN`) — a flat identifier, or a lowercase
 * `namespace:action_name`, at most 200 characters. Bound to the relay source by test.
 */
export const MAX_ACTION_TYPE_LENGTH = 200;
export const ACTION_TYPE_PATTERN = /^(?:[A-Za-z][A-Za-z0-9_]*|[a-z][a-z0-9]*:[a-z][a-z0-9_]*)$/;

/**
 * Namespaces the RELAY owns and builds at runtime for its own witness lanes (the forge webhooks'
 * `service:`, the commit family's `git_`; `RELAY_OWNED_ACTION_TYPE_PREFIXES` in
 * `new-type-intake.ts`). A plugin can never report a type in one. Bound to the relay source by test.
 */
export const RELAY_OWNED_ACTION_TYPE_PREFIXES: readonly string[] = Object.freeze(['service:', 'git_']);

export type PluginActionTypeRefusal = 'invalid_action_type' | 'relay_owned_namespace';

/**
 * Why the relay would refuse a plugin PE of `actionType` on the gateway lane before reading
 * anything, or `null` when it would not. An observation-lane type is never refused here. A NAMED
 * type the relay witnesses on another lane (`send`, `escrow_completed` …) is NOT detected: that
 * needs the relay's matrix, which the SDK does not ship — the relay refuses it in the receipt.
 */
export function pluginActionTypeRefusal(actionType: unknown): PluginActionTypeRefusal | null {
  if (isDeviceObservationActionType(actionType)) return null;
  if (typeof actionType !== 'string'
    || actionType.length > MAX_ACTION_TYPE_LENGTH
    || !ACTION_TYPE_PATTERN.test(actionType)) return 'invalid_action_type';
  if (RELAY_OWNED_ACTION_TYPE_PREFIXES.some((prefix) => actionType.startsWith(prefix))) return 'relay_owned_namespace';
  return null;
}

/**
 * The daemon lanes' own `metadata.source` → `metadata.tool` pairs — the mirror of the relay's
 * `DAEMON_TOOL_ORCHESTRATION_LANES` (`provian-backend/src/core/provenance/device-observation-types.ts`,
 * /), bound by `observation-types.test.ts`. Only the observer's built-in lanes set them.
 */
export const DAEMON_TOOL_ORCHESTRATION_LANES: Readonly<Record<string, string>> = Object.freeze({
  transcript: 'provian:transcript',
  otel: 'provian-observer-otel',
  model_proxy: 'provian:model_proxy',
  process: 'provian:process',
});

/**
 * Observation types ONLY a built-in lane witnesses — the mirror of the relay's
 * `BUILT_IN_LANE_ONLY_ACTION_TYPES`: `link_spend` (the transcript lane's Link CLI recognizer) and
 * `agent_tool_orchestration` (a daemon lane's tool calls). A third-party plugin's PE of either type
 * is refused LOCALLY; the relay refuses it under the plugin marker too.
 */
export const BUILT_IN_LANE_ONLY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'agent_tool_orchestration',
  'link_spend',
]);

/**
 * True when the metadata names a built-in lane by either marker the relay reads as lane identity:
 * a `source` that is a daemon lane, or a `tool` that is a daemon lane's tool. Mirrors the relay's
 * `carriesBuiltInLaneMarker`.
 */
export function carriesBuiltInLaneMarker(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const { source, tool } = metadata as { source?: unknown; tool?: unknown };
  if (typeof source === 'string' && Object.prototype.hasOwnProperty.call(DAEMON_TOOL_ORCHESTRATION_LANES, source)) return true;
  return typeof tool === 'string' && Object.values(DAEMON_TOOL_ORCHESTRATION_LANES).includes(tool);
}

/**
 * The metadata a THIRD-PARTY plugin's PE is submitted with — whatever its type, observation types
 * included. The observer sets `source: 'observer_plugin'` and `observer_plugin: <the registered
 * plugin's name>`, OVERRIDING whatever the plugin put in those keys, and drops a `tool` that names a
 * built-in lane: a plugin can never carry a built-in lane's marker, another source, or another
 * plugin's name. Always a new object; the plugin's own object is never modified.
 */
export function withThirdPartyPluginWitness(
  pluginName: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}) };
  if (typeof out.tool === 'string' && Object.values(DAEMON_TOOL_ORCHESTRATION_LANES).includes(out.tool)) delete out.tool;
  out.source = OBSERVER_PLUGIN_SOURCE;
  out.observer_plugin = pluginName;
  return out;
}

/**
 * The metadata a BUILT-IN lane's drained PE is submitted with. An observation-lane type is returned
 * UNCHANGED (the same object), so every built-in lane's PE is byte-identical. Any other type gets
 * `source: 'observer_plugin'` and `observer_plugin: <the registered plugin's name>` set by the
 * observer, OVERRIDING whatever the plugin put in those two keys — a plugin cannot forge another
 * source or another plugin's name. The caller checks `observerPluginNameCarriesMarker` first.
 */
export function withObserverPluginWitness(
  pluginName: string,
  actionType: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (isDeviceObservationActionType(actionType)) return metadata;
  return { ...(metadata ?? {}), source: OBSERVER_PLUGIN_SOURCE, observer_plugin: pluginName };
}
