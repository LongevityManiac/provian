/**
 * the action types an OBSERVATION lane emits on the device route
 * (`POST /v1/pe/submit`). Nothing else is admitted there.
 *
 * "an agent declaring its own work has no path to a PE,
 * minting or record-only." The device route is where the machine's own
 * instrumentation reports what it observed executing; an API whose input is the
 * actor's own description of its work (a caller-chosen action_type) is a
 * declaration, not an observation. So the route admits exactly the types the
 * instrumentation lanes emit, derived from every emitter in the tree:
 *
 * compute_session / inference_session — observer session PE
 * (provian-agent-sdk/src/observer/ProvianObserver.ts: process + LLM +
 * model-proxy inference witness)
 * coding_session — observer git lane
 * (observer/plugins/GitPlugin.ts) and the git post-commit hook
 * (hooks/post-commit.template → scripts/report-pe.ts --hook), which reads
 * the commit from git itself
 * agent_tool_orchestration — observer transcript, OTel and
 * model-proxy lanes (TranscriptPlugin.ts, OTelPlugin.ts,
 * model-proxy/turn-pe.ts), and only those: see
 * DAEMON_TOOL_ORCHESTRATION_LANES below
 * agent_api_orchestration — observer OTel lane (OTelPlugin.ts)
 * ai_conversation — observer LLM-session lane
 * (llm-session/LLMSessionPlugin.ts)
 * link_spend — observer transcript lane's Link CLI
 * recognizer (transcript/extractor.ts → TranscriptPlugin.queueLinkSpend)
 *
 * Every entry is a NAMED row of the action-policy matrix, so the evidence-class
 * admission of never-seen types (`unknown_action_admission`,
 * class-admission-earning.ts) is unreachable from this route: a caller-typed
 * identifier is refused before accrual. This is an intake refusal only — no
 * matrix row, weight, disposition, or signed template moves.
 *
 * Setup PEs (`device_register`, `wallet_created`, `credential_*`) never arrive
 * here: `device_register` is sealed server-side by the registration handler and
 * the mobile app records on `/v1/pe/submit/mobile`.
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

/**
 * every agent program is witnessed by exactly one lane of the observer
 * daemon — its described session files (transcript), else the local model proxy, else OTel — and
 * one model response that calls a tool is one PE. Provian keeps no per-harness or per-framework
 * integration. Each daemon lane stamps its own `metadata.source` and `metadata.tool` on the
 * `agent_tool_orchestration` PE it seals (TranscriptPlugin.ts, OTelPlugin.queueToolPE,
 * model-proxy/turn-pe.ts) and, since, the process lane (ProcessLanePlugin, `provian:process`),
 * so the device route admits that type only under one of these named lane
 * pairs. A tool-call PE from anything else on the machine that holds the device credential — the
 * retired Hermes plugin's per-call hook, the retired Python LangChain / CrewAI callbacks, an old
 * copy of either still installed — names no daemon lane and is refused at intake, so it never
 * mints beside the lane assigned to its program.
 */
export const DAEMON_TOOL_ORCHESTRATION_LANES: Readonly<Record<string, string>> = Object.freeze({
  transcript: 'provian:transcript',
  otel: 'provian-observer-otel',
  model_proxy: 'provian:model_proxy',
  // the process lane: an agent VM's own commands, read from the OS, for work no described
  // lane sees. It prices at parity with the other tool lanes (one PE per command, tool_count 1).
  process: 'provian:process',
});

/** True only when the metadata names one daemon lane by its own `source` + `tool` pair. */
export function isDaemonToolOrchestrationLane(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const { source, tool } = metadata as { source?: unknown; tool?: unknown };
  return typeof source === 'string'
    && Object.prototype.hasOwnProperty.call(DAEMON_TOOL_ORCHESTRATION_LANES, source)
    && DAEMON_TOOL_ORCHESTRATION_LANES[source] === tool;
}

/**
 * The observation types ONLY a built-in daemon lane witnesses, each bound at intake to its lane's own
 * marker: `link_spend` to the transcript lane (`metadata.source === 'transcript'`), and
 * `agent_tool_orchestration` to one of DAEMON_TOOL_ORCHESTRATION_LANES (`source` + `tool`). A
 * third-party plugin the observer runs (`registerPlugin`) is not one of those lanes: the observer
 * stamps every PE such a plugin hands it with its own gateway-plugin marker
 * (`new-type-intake.ts` `OBSERVER_PLUGIN_SOURCE`), and the device batch refuses either type under
 * that marker (`device-act.ts`). The SDK mirrors this set (`observation-types.ts`, bound by test).
 */
export const BUILT_IN_LANE_ONLY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'agent_tool_orchestration',
  'link_spend',
]);

/**
 * True when the metadata names a built-in daemon lane by either of the markers the device route
 * reads as lane identity: a `source` that is one of the daemon lanes (`transcript`, `otel`,
 * `model_proxy`, `process` — the transcript lane's `link_spend` source among them), or a `tool` that
 * is a daemon lane's tool (`provian:transcript`, `provian-observer-otel`, `provian:model_proxy`,
 * `provian:process`; the capture-lane hint reads it too). Only the observer's own lanes set these.
 */
export function carriesBuiltInLaneMarker(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const { source, tool } = metadata as { source?: unknown; tool?: unknown };
  if (typeof source === 'string' && Object.prototype.hasOwnProperty.call(DAEMON_TOOL_ORCHESTRATION_LANES, source)) return true;
  return typeof tool === 'string' && Object.values(DAEMON_TOOL_ORCHESTRATION_LANES).includes(tool);
}

/** Self-report labels (the retired MCP report tools; the daemon's loopback witness endpoint). */
export const SELF_REPORT_SOURCES: ReadonlySet<string> = new Set(['local_witness', 'mcp_self_report']);

export function isSelfReportLabelled(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const source = (metadata as { source?: unknown }).source;
  return typeof source === 'string' && SELF_REPORT_SOURCES.has(source);
}
