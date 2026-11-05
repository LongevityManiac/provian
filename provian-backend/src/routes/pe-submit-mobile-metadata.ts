/**
 * ai_conversation_metadata validator + merge helper for the phone's metered chat acts
 * (core/meter/mobile-act.ts; formerly the retired /v1/pe/submit/mobile)
 *
 * Canonical schema lives in openapi.ts (AIConversationMetadata). This module
 * enforces that schema at the handler boundary. The handler admits a metadata
 * blob only when action_type === 'ai_conversation'; for every other action
 * type a client-supplied ai_conversation_metadata is silently ignored to keep
 * mixed clients forward-compatible.
 *
 * Strict validation: missing field, wrong type, non-integer, negative integer,
 * wrong enum, or hash-pattern mismatch all fail. Errors carry a `field` that
 * points at the sub-key (e.g. `ai_conversation_metadata.provider`) so the
 * client can surface a useful message.
 */

export type AIConversationProvider =
  | 'claude'
  | 'chatgpt'
  | 'gemini'
  | 'perplexity'
  | 'grok'
  | 'venice';

export type AIConversationSurface =
  | 'desktop_foreground'
  | 'mobile_wrapper';

export type AIConversationInputFidelity = 'full' | 'presence_only';

export interface AIConversationMetadata {
  provider: AIConversationProvider;
  surface: AIConversationSurface;
  duration_ms: number;
  active_duration_ms: number;
  turn_count: number;
  char_count: number;
  image_count: number;
  video_seconds: number;
  session_fingerprint_hash: string;
  input_fidelity: AIConversationInputFidelity;
}

export type ValidationResult =
  | { ok: true; value: AIConversationMetadata }
  | { ok: false; error: string; field?: string };

const PROVIDERS: readonly AIConversationProvider[] = [
  'claude',
  'chatgpt',
  'gemini',
  'perplexity',
  'grok',
  'venice',
];

const SURFACES: readonly AIConversationSurface[] = [
  'desktop_foreground',
  'mobile_wrapper',
];

/**
 * Android out-of-app AI capture (the Phase 2c M7 UsageStats
 * path) is NOT live. The relay refuses its surface, with a reason, rather than recording
 * it. The client code is retained for later; see OPEN_ITEMS.md for what must be fixed
 * before the path is lit. The earning overlay independently refuses to mint it
 * (`NON_MINTING_AI_CONVERSATION_SURFACES`, mobile-chat-earning.ts).
 */
export const REFUSED_SURFACES: readonly string[] = ['mobile_usage_stats'];

const INPUT_FIDELITIES: readonly AIConversationInputFidelity[] = [
  'full',
  'presence_only',
];

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const NUMERIC_FIELDS: readonly (keyof AIConversationMetadata)[] = [
  'duration_ms',
  'active_duration_ms',
  'turn_count',
  'char_count',
  'image_count',
  'video_seconds',
];

function fieldPath(sub: string): string {
  return `ai_conversation_metadata.${sub}`;
}

export function validateAIConversationMetadata(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'ai_conversation_metadata must be an object',
      field: 'ai_conversation_metadata',
    };
  }

  const obj = raw as Record<string, unknown>;

  const provider = obj.provider;
  if (provider === undefined) {
    return { ok: false, error: 'provider is required', field: fieldPath('provider') };
  }
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as AIConversationProvider)) {
    return {
      ok: false,
      error: `provider must be one of: ${PROVIDERS.join(', ')}`,
      field: fieldPath('provider'),
    };
  }

  const surface = obj.surface;
  if (surface === undefined) {
    return { ok: false, error: 'surface is required', field: fieldPath('surface') };
  }
  if (typeof surface === 'string' && REFUSED_SURFACES.includes(surface.trim().toLowerCase())) {
    return {
      ok: false,
      error: `surface ${surface} is not accepted: Android out-of-app AI capture is not live`,
      field: fieldPath('surface'),
    };
  }
  if (typeof surface !== 'string' || !SURFACES.includes(surface as AIConversationSurface)) {
    return {
      ok: false,
      error: `surface must be one of: ${SURFACES.join(', ')}`,
      field: fieldPath('surface'),
    };
  }

  for (const key of NUMERIC_FIELDS) {
    const value = obj[key];
    if (value === undefined) {
      return { ok: false, error: `${key} is required`, field: fieldPath(key) };
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ok: false,
        error: `${key} must be a number`,
        field: fieldPath(key),
      };
    }
    if (!Number.isInteger(value)) {
      return {
        ok: false,
        error: `${key} must be an integer`,
        field: fieldPath(key),
      };
    }
    if (value < 0) {
      return {
        ok: false,
        error: `${key} must be non-negative`,
        field: fieldPath(key),
      };
    }
  }

  const hash = obj.session_fingerprint_hash;
  if (hash === undefined) {
    return {
      ok: false,
      error: 'session_fingerprint_hash is required',
      field: fieldPath('session_fingerprint_hash'),
    };
  }
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    return {
      ok: false,
      error: 'session_fingerprint_hash must be 64 lowercase hex characters',
      field: fieldPath('session_fingerprint_hash'),
    };
  }

  const inputFidelity = obj.input_fidelity;
  if (inputFidelity === undefined) {
    return {
      ok: false,
      error: 'input_fidelity is required',
      field: fieldPath('input_fidelity'),
    };
  }
  if (
    typeof inputFidelity !== 'string' ||
    !INPUT_FIDELITIES.includes(inputFidelity as AIConversationInputFidelity)
  ) {
    return {
      ok: false,
      error: `input_fidelity must be one of: ${INPUT_FIDELITIES.join(', ')}`,
      field: fieldPath('input_fidelity'),
    };
  }

  const value: AIConversationMetadata = {
    provider: provider as AIConversationProvider,
    surface: surface as AIConversationSurface,
    duration_ms: obj.duration_ms as number,
    active_duration_ms: obj.active_duration_ms as number,
    turn_count: obj.turn_count as number,
    char_count: obj.char_count as number,
    image_count: obj.image_count as number,
    video_seconds: obj.video_seconds as number,
    session_fingerprint_hash: hash,
    input_fidelity: inputFidelity as AIConversationInputFidelity,
  };

  return { ok: true, value };
}

/**
 * Merge validated ai_conversation_metadata into the PE content's metadata
 * slot. Keeps the existing `source: 'mobile_app'` sentinel so consumers that
 * only read `metadata.source` are unaffected; adds `ai_conversation` as a
 * namespaced sibling so the metadata's provenance is explicit.
 */
export function mergeAIConversationMetadata(
  validated: AIConversationMetadata | null,
): { source: 'mobile_app'; ai_conversation?: AIConversationMetadata } {
  if (validated === null) {
    return { source: 'mobile_app' };
  }
  return { source: 'mobile_app', ai_conversation: validated };
}
