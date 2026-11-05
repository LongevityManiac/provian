/**
 * The reputation vocabulary's FIELD NAMES — the pure, dependency-light half of `vocabulary.ts`
 * the Standing prefix, the fixed windows, the predicate-only fields, and the ONE table of
 * dynamic field patterns. The served PE schema (`core/schema/pe-schema.ts`) generates its pattern
 * text from this table, and the disclosure resolves never-seen keys through it, so the schema and
 * the relay can never disagree about which names are addressable.
 */
import { WITNESS_CLASSES } from '../pvt/policy/evidence-class';

export const STANDING_FIELD_PREFIX = 'standing.';

/** True for the always-present, non-redactable Standing facts. */
export function isStandingField(field: string): boolean {
  return field.startsWith(STANDING_FIELD_PREFIX);
}

/** The fixed windows (UTC days, today included) the windowed facts answer. */
export const VOCABULARY_WINDOWS = [30, 90, 365] as const;
export type VocabularyWindow = (typeof VOCABULARY_WINDOWS)[number];
export const windowSuffix = (w: VocabularyWindow): string => `_${w}d`;

/**
 * The Standing facts EVERY reputation presentation carries, whatever the presenter chose to share
 * or redact (: adverse facts are always present and never redactable). The
 * vocabulary writes each of them for every actor (an observed zero included), so a co-signed
 * reputation payload missing any of them was withheld, and every verifier refuses it
 * `standing_withheld`. The per-type adverse keys (`standing.<adverse_type>`) are
 * written for every actor too, but they are served as a pattern, not a fixed list; their SUM is
 * `standing.adverse_events` (required here, with its windows), so no adverse event can be hidden by
 * withholding a per-type key.
 */
export const STANDING_ALWAYS_PRESENT_FIELDS: readonly string[] = [
  'standing.adverse_events',
  'standing.bond_active',
  'standing.open_bond_claims_against',
  'standing.invalidation_active',
  ...VOCABULARY_WINDOWS.map((w) => `standing.adverse_events${windowSuffix(w)}`),
];

/** The always-present Standing fields a disclosed facts block lacks (empty = none withheld). */
export function missingStandingFields(facts: Readonly<Record<string, unknown>> | undefined): string[] {
  return STANDING_ALWAYS_PRESENT_FIELDS.filter((f) => !facts || typeof facts[f] !== 'number');
}

/** Longest field name the predicate grammar accepts (`normalizePredicateRequests`). */
export const VOCABULARY_FIELD_MAX_LENGTH = 128;

// =============================================================================
// Predicate-only fields — the witnessed payment volume
// =============================================================================

export const PAYMENT_VOLUME_FIELD = 'money.witnessed_payment_volume_usd';

/**
 * Fields that are NEVER disclosed as a raw fact — not in the default facts, not in `disclosed` —
 * and are answerable only through ONE order predicate (`gte|gt|lte|lt`) per field per presentation:
 * an exact-match (`eq` / `in`) probe or a ladder of thresholds would reconstruct the amount.
 */
export const PREDICATE_ONLY_FIELDS: ReadonlySet<string> = new Set([
  PAYMENT_VOLUME_FIELD,
  ...VOCABULARY_WINDOWS.map((w) => `${PAYMENT_VOLUME_FIELD}${windowSuffix(w)}`),
]);
export const PREDICATE_ONLY_OPS: readonly string[] = ['gte', 'gt', 'lte', 'lt'];

export function isPredicateOnlyField(field: string): boolean {
  return PREDICATE_ONLY_FIELDS.has(field);
}

// =============================================================================
// Dynamic field patterns (ONE table — the schema text is generated from it)
// =============================================================================

const KEY = '[a-z0-9_:-]{1,64}';
const MEASUREMENT = '[a-z0-9:]{1,110}';
const FINGERPRINT = '[0-9a-f]{64}';
const CLASS = `(?:${WITNESS_CLASSES.join('|')})`;
const WINDOW = `(?:_(?:${VOCABULARY_WINDOWS.map((w) => `${w}d`).join('|')}))?`;

export interface DynamicFieldPattern {
  /** The human-readable pattern the served schema lists. */
  readonly pattern: string;
  readonly regex: RegExp;
  readonly note: string;
}

export const DYNAMIC_FIELD_PATTERNS: readonly DynamicFieldPattern[] = [
  { pattern: 'work.<family>.<witness_class>', regex: new RegExp(`^work\\.${KEY}\\.${CLASS}$`), note: `PE count for one action family under one witness class; <family> is ${KEY}, <witness_class> one of ${WITNESS_CLASSES.join('|')}.` },
  { pattern: 'composition.model.<family>', regex: new RegExp(`^composition\\.model\\.${KEY}$`), note: 'PEs that used a model family (lifetime).' },
  { pattern: 'composition.env.<class>', regex: new RegExp(`^composition\\.env\\.${KEY}$`), note: 'PEs from an execution-environment class (lifetime).' },
  { pattern: 'composition.region.<coarse>', regex: new RegExp(`^composition\\.region\\.${KEY}$`), note: 'Witnessed PEs whose SEALED admitted hardware report attests this coarse region (lifetime).' },
  { pattern: 'composition.measurement.<digest>', regex: new RegExp(`^composition\\.measurement\\.${MEASUREMENT}$`), note: `Witnessed PEs whose SEALED admitted hardware report attests this launch measurement (lifetime); <digest> is ${MEASUREMENT}, e.g. sha384:<hex>.` },
  { pattern: 'composition.issuer.<fingerprint>', regex: new RegExp(`^composition\\.issuer\\.${FINGERPRINT}$`), note: 'Witnessed PEs whose SEALED admitted hardware report chained to this pinned issuer root (lifetime); <fingerprint> is the root’s sha256 (64 hex), as listed under hardware.schemes.' },
  { pattern: 'share.witness[_<window>].<witness_class>', regex: new RegExp(`^share\\.witness${WINDOW}\\.${CLASS}$`), note: 'Share of work (bps, floor of count×10000/work.total over the same window) under a witness class.' },
  { pattern: 'share.model[_<window>].<family>', regex: new RegExp(`^share\\.model${WINDOW}\\.${KEY}$`), note: 'Share of work (bps) that used a model family. A PE may use several families, so shares need not sum to 10000.' },
  { pattern: 'share.env[_<window>].<class>', regex: new RegExp(`^share\\.env${WINDOW}\\.${KEY}$`), note: 'Share of work (bps) from an execution-environment class.' },
  { pattern: 'share.region[_<window>].<coarse>', regex: new RegExp(`^share\\.region${WINDOW}\\.${KEY}$`), note: 'Share of work (bps) hardware-attested to a coarse region.' },
  { pattern: 'share.measurement[_<window>].<digest>', regex: new RegExp(`^share\\.measurement${WINDOW}\\.${MEASUREMENT}$`), note: 'Share of work (bps) hardware-attested to a launch measurement.' },
  { pattern: 'share.issuer[_<window>].<fingerprint>', regex: new RegExp(`^share\\.issuer${WINDOW}\\.${FINGERPRINT}$`), note: 'Share of work (bps) hardware-attested under a pinned issuer root.' },
];

/** The rule the schema states beside the patterns. */
export const NEVER_SEEN_KEY_RULE = 'A field that matches a dynamic pattern but never occurred for this actor reads 0 and evaluates normally (e.g. work.git.hardware_rooted eq 0 → true). A field matching no fixed name and no pattern is refused.';

export function matchesDynamicFieldPattern(field: string): boolean {
  if (field.length === 0 || field.length > VOCABULARY_FIELD_MAX_LENGTH) return false;
  return DYNAMIC_FIELD_PATTERNS.some((p) => p.regex.test(field));
}

/** True when `field` is a live fact OR a pattern-valid never-seen key (which reads 0). */
export function isKnownVocabularyField(field: string, facts: Readonly<Record<string, number>>): boolean {
  return Object.prototype.hasOwnProperty.call(facts, field) || matchesDynamicFieldPattern(field);
}

/** The fixed (non-pattern) window-suffixed fields, in the order the schema lists them. */
export const WINDOWED_FACT_BASES: readonly string[] = [
  'work.total', 'work.witnessed', 'work.hardware_rooted', 'work.witnessed_compute_tokens',
  'continuity.active_days',
  'money.witnessed_financial', 'money.witnessed_inbound', 'money.independent_payers', 'money.promises_fulfilled', 'money.promises_defaulted', 'money.promise_fulfillment_rate_bps',
  PAYMENT_VOLUME_FIELD,
  'standing.adverse_events',
  'presentations.produced',
];
