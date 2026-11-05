/** Shape tool observations for the setup-fixed program proxy witness.
 * Pure model calls contribute no PE. The durable network-turn journal owns
 * identity and completion; tool arguments contribute privacy-safe origins.
 */

import { createHash } from 'crypto';
import type { PluginPE } from '../../types';
import type { InputOrigin, OriginWitness } from '../../../input-origins';
import type { OriginArgRule } from '../../origin-rules';
import { computeTurnId, TURN_ID_MAX_CHARS } from '../turn-identity';
import { toolInputOriginDrafts, schemaOriginDrafts, stampWitness } from '../../origin-capture';
import type { ModelTurnObservation, RequestToolSchemas } from './parse';

/** The identity this lane stamps as the reporting "tool". */
export const MODEL_PROXY_TOOL = 'provian:model_proxy';

/** Intake floor, bound to the relay's `metadata.tool_count >= 1` and the OTel
 * lane's `MIN_ORCHESTRATION_TOOL_CALLS`. One tool call is a turn. */
export const MODEL_PROXY_MIN_TOOL_CALLS = 1;

export interface TurnToPEContext {
  /** The observer_device witness for origins this device captured (or null). */
  witness: OriginWitness | null;
  /** Trust Layer §2.3: sha256 of the forwarded response bytes (`sha256:<hex>`), when observed. */
  responseDigest?: string | null;
  /** Machine-local origin-arg rules (additive to the built-in allowlist). */
  catalogRules?: readonly OriginArgRule[];
  /** Tool DEFINITIONS from the request, for generic schema-driven origin capture
   * — a fetch tool of any name with a url-typed/url-named param
   * yields a counted origin with no catalog entry. */
  toolSchemas?: RequestToolSchemas;
  windowStart: number;
  windowEnd: number;
  durationMs: number;
}

/** What one observed model turn resolves to. */
export type TurnClassification =
  | { kind: 'tool_pe'; pe: PluginPE; turnId: string }
  /** Zero-tool witnessed inference: fold into the session as an inference contribution. */
  | { kind: 'inference'; requests: number; tokens: number | null; model: string | null; provider: string | null }
  /** Nothing to witness (unrecognized shape handled upstream as a fingerprint). */
  | { kind: 'none' };

/**
 * The per-turn fallback key for a turn with no usable tool-call id (Gemini
 * function calls carry none; a zero-tool turn never uses this path). Distinct per
 * turn (provider+responseId+model+window) so distinct work is never merged, and
 * content-free — `responseId` is `msg_…`/`chatcmpl-…`, never a prompt.
 */
export function modelProxyFallbackKey(obs: ModelTurnObservation, windowStart: number): string {
  return 'mp:' + createHash('sha256')
    .update([obs.provider ?? '', obs.responseId ?? '', obs.model ?? '', String(windowStart)].join('\x1f'), 'utf8')
    .digest('hex');
}

function uniquePreserveOrder(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) { if (x && !seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

/**
 * Classify one observed model turn. Never throws. An unrecognized observation
 * (parse failed) returns `none` — the caller fingerprints it upstream and never
 * fabricates a witness.
 */
export function classifyModelTurn(obs: ModelTurnObservation, ctx: TurnToPEContext): TurnClassification {
  if (!obs.recognized) return { kind: 'none' };
  const toolCount = obs.toolCalls.length;

  if (toolCount < MODEL_PROXY_MIN_TOOL_CALLS) return { kind: 'none' };

  const callIds = obs.toolCalls.map((c) => c.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const turnId = computeTurnId(callIds, modelProxyFallbackKey(obs, ctx.windowStart)).slice(0, TURN_ID_MAX_CHARS);

  // Origins from the tool-call ARGUMENTS, through the SAME privacy allowlist the
  // transcript watcher uses. Private classes (file/host) are hashed on device;
  // no plaintext argument ever leaves. Deduped by (identifier, hash).
  //
  // TWO additive sources, both harness-agnostic: (1) the built-in exact-name
  // allowlist + any machine-local rules, and (2) generic SCHEMA-DRIVEN
  // classification from the request's tool DEFINITIONS — a fetch
  // tool of ANY name with a url-typed/url-named parameter yields a counted origin
  // with no catalog entry; a catalog rule only adds precision. Deduped together.
  const origins: InputOrigin[] = [];
  const seen = new Set<string>();
  for (const call of obs.toolCalls) {
    const drafts = [
      ...toolInputOriginDrafts(call.name, call.input, ctx.catalogRules),
      ...schemaOriginDrafts(call.input, ctx.toolSchemas?.get(call.name)),
    ];
    for (const d of drafts) {
      const key = `${d.origin_identifier}|${d.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      origins.push(stampWitness(d, ctx.witness));
    }
  }

  const toolNames = uniquePreserveOrder(obs.toolCalls.map((c) => c.name)).slice(0, 50);
  const pe: PluginPE = {
    actionType: 'agent_tool_orchestration',
    description: `${obs.provider ?? 'model'}${obs.model ? ` ${obs.model}` : ''} turn — ${toolCount} tool call(s)`,
    ...(origins.length > 0 ? { input_origins: origins } : {}),
    // Trust Layer §2.3: the model response the tee observed IS this turn's output.
    ...(ctx.responseDigest ? { output_digests: [{ hash: ctx.responseDigest, kind: 'response' as const }] } : {}),
    metadata: {
      tool: MODEL_PROXY_TOOL,
      source: 'model_proxy',
      provider: obs.provider,
      model: obs.model,
      // The cross-source mint-once anchor the relay folds into the canonical event.
      turn_id: turnId,
      // Relay intake requires metadata.tool_count >= 1 for this type.
      tool_count: toolCount,
      tool_names: toolNames,
      streamed: obs.streamed,
      // Content-free response id, for correlation/debugging only.
      response_id: obs.responseId,
    },
    compute: {
      duration_ms: Math.max(ctx.durationMs, 1),
      // tokens ARE recorded on the model-turn PE (unlike the OTel tool
      // lane, which nulls them). Pure provenance — inert to today's pricing, priced
      // in Prompt 3 — never null when the response exposed a count.
      tokens_processed: obs.tokens?.total ?? null,
      records_processed: null,
      output_cardinality: null,
      cpu_seconds: null,
      memory_peak_mb: null,
      energy_joules: null,
      gpu_seconds: null,
      model_parameters: null,
      framework: obs.provider,
      hardware_class: null,
    },
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    // Same signal dimension as the OTel/transcript tool lanes — participate in the
    // window registry so an overlap with them collapses to one mint.
  };
  return { kind: 'tool_pe', pe, turnId };
}
