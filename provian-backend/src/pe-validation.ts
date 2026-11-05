/**
 * PE Description Validation
 *
 * Per the updated Article I of the Network Constitution:
 * PE descriptions are OPTIONAL. Provian-generated PEs use structural
 * metadata only. Third-party implementations may include descriptions.
 *
 * When a description IS provided, it is stored privately (TIER_3 field)
 * and may optionally be validated for quality. This validator is retained
 * for third-party integrations that choose to include descriptions.
 */

const BLOCKLIST = new Set([
  'test', 'testing', 'asdf', 'todo', 'n/a', 'na', 'none', 'null',
  'undefined', 'foo', 'bar', 'baz', 'hello world', 'test pe',
  'test description', 'describe action here', 'placeholder',
  'description', 'action', 'did stuff', 'stuff', 'things', 'work',
  'update', 'fix', 'changed something', 'misc', 'temp', 'tmp', 'wip',
  'tbd', 'lorem ipsum', 'example', 'sample',
]);

const MIN_LENGTH = 20;
const MIN_WORDS = 3;
const MAX_LENGTH = 2000;
const HAS_LETTER = /[a-zA-Z]/;

export interface PEDescriptionValidation {
  valid: boolean;
  error?: string;
  hint?: string;
}

/**
 * Validate a PE description when one is provided.
 * Description is optional - pass undefined/null/empty to skip validation entirely.
 * Only called by third-party submission paths that include descriptions.
 */
export function validatePEDescription(
  description: unknown,
  fieldName: string = 'description',
): PEDescriptionValidation {
  // Absent description is always valid - structural metadata is sufficient
  if (description === undefined || description === null || description === '') {
    return { valid: true };
  }

  if (typeof description !== 'string') {
    return { valid: false, error: `${fieldName} must be a string`, hint: 'Omit the field or provide a string.' };
  }

  const trimmed = description.trim();

  // Empty string after trim - treat as absent
  if (trimmed.length === 0) {
    return { valid: true };
  }

  if (trimmed.length > MAX_LENGTH) {
    return { valid: false, error: `${fieldName} exceeds ${MAX_LENGTH} characters`, hint: 'Keep descriptions concise.' };
  }

  if (trimmed.length < MIN_LENGTH) {
    return {
      valid: false,
      error: `${fieldName} is too short (${trimmed.length} chars, minimum ${MIN_LENGTH})`,
      hint: 'Example: "Refactored authentication module to use JWT tokens"',
    };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) {
    return {
      valid: false,
      error: `${fieldName} must contain at least ${MIN_WORDS} words`,
      hint: 'Example: "Built REST API endpoint with input validation"',
    };
  }

  if (!HAS_LETTER.test(trimmed)) {
    return { valid: false, error: `${fieldName} must contain at least one letter`, hint: 'PE descriptions are human-readable records.' };
  }

  if (BLOCKLIST.has(trimmed.toLowerCase())) {
    return {
      valid: false,
      error: `${fieldName} "${trimmed}" is not a valid PE description (placeholder/test data)`,
      hint: 'Use a specific description of the actual work performed.',
    };
  }

  return { valid: true };
}

// Firestore document-id constraints (see
// https://firebase.google.com/docs/firestore/quotas#collections_documents_and_fields):
// non-empty UTF-8, ≤ 1500 bytes, may not be "." or "..", may not contain "/"
// (a "/" splits into a nested subcollection path), and may not match the
// reserved /__.*__/ pattern.
const ENVELOPE_ID_MAX_BYTES = 1500;
const RESERVED_ENVELOPE_ID = /^__.*__$/;

export interface EnvelopeIdValidation {
  valid: boolean;
  error?: string;
}

/**
 * PE event times are integer Unix milliseconds. Keeping this wire check shared
 * with the policy resolver prevents a PE from being durably written and then
 * becoming unrecoverable because its record-time policy boundary is invalid.
 */
export function isSafePETimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a caller-supplied `envelope_id` BEFORE it is used verbatim as a
 * Firestore document id (`provenance_envelopes/{envelope_id}`).
 *
 * Without this, an invalid id is only discovered at commit time and misreported:
 * a reserved/oversized id surfaces Firestore's INVALID_ARGUMENT as a transient
 * "chain_contention, please retry" 409 (permanently un-retryable), and an
 * odd-segment id like `a/b/c` is silently written into a nested subcollection
 * the flat chain reader never returns (a self-orphaned PE). This gate turns both
 * into an honest, terminal 400 at the wire boundary. It is a GATE, not a
 * normalizer — a passing id flows through unchanged (so it still hashes and
 * stores identically).
 */
export function validateEnvelopeId(id: unknown): EnvelopeIdValidation {
  if (typeof id !== 'string') {
    return { valid: false, error: 'envelope_id must be a string' };
  }
  if (id.length === 0) {
    return { valid: false, error: 'envelope_id must not be empty' };
  }
  if (id === '.' || id === '..') {
    return { valid: false, error: 'envelope_id must not be "." or ".."' };
  }
  if (id.includes('/')) {
    return { valid: false, error: 'envelope_id must not contain "/"' };
  }
  if (RESERVED_ENVELOPE_ID.test(id)) {
    return { valid: false, error: 'envelope_id must not match the reserved __*__ pattern' };
  }
  // Byte length (Firestore's limit is bytes, not code units).
  const byteLength = Buffer.byteLength(id, 'utf8');
  if (byteLength > ENVELOPE_ID_MAX_BYTES) {
    return { valid: false, error: `envelope_id exceeds ${ENVELOPE_ID_MAX_BYTES} bytes (${byteLength})` };
  }
  return { valid: true };
}
