/**
 * Tests for the ai_conversation_metadata validator (the phone's metered chat acts,
 * core/meter/mobile-act.ts; formerly /v1/pe/submit/mobile).
 *
 * Covers: canonical accept, every required-field-missing case, every enum
 * rejection, non-integer/negative cases for all numeric fields, hash pattern
 * rejection (uppercase, wrong length, non-hex), and the merge helper's shape.
 * Each failure-path case asserts the returned `field` identifies the offending
 * sub-field.
 */

import {
  validateAIConversationMetadata,
  mergeAIConversationMetadata,
  AIConversationMetadata,
} from './pe-submit-mobile-metadata';

function canonical(): Record<string, unknown> {
  return {
    provider: 'claude',
    surface: 'mobile_wrapper',
    duration_ms: 180_000,
    active_duration_ms: 150_000,
    turn_count: 12,
    char_count: 3_400,
    image_count: 2,
    video_seconds: 0,
    session_fingerprint_hash: 'a'.repeat(64),
    input_fidelity: 'full',
  };
}

describe('validateAIConversationMetadata - accept', () => {
  it('accepts a canonical valid metadata object', () => {
    const result = validateAIConversationMetadata(canonical());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe('claude');
      expect(result.value.surface).toBe('mobile_wrapper');
      expect(result.value.session_fingerprint_hash).toBe('a'.repeat(64));
    }
  });

  it('accepts every provider enum value', () => {
    for (const provider of ['claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice']) {
      const result = validateAIConversationMetadata({ ...canonical(), provider });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts every surface enum value', () => {
    for (const surface of ['desktop_foreground', 'mobile_wrapper']) {
      const result = validateAIConversationMetadata({ ...canonical(), surface });
      expect(result.ok).toBe(true);
    }
  });

  it('RED CONTROL : refuses the Android UsageStats surface, case variants included', () => {
    for (const surface of ['mobile_usage_stats', 'Mobile_Usage_Stats', ' mobile_usage_stats ']) {
      const result = validateAIConversationMetadata({
        ...canonical(),
        surface,
        input_fidelity: 'presence_only',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe('ai_conversation_metadata.surface');
        expect(result.error).toMatch(/not accepted/);
      }
    }
  });

  it('accepts both input_fidelity values', () => {
    for (const input_fidelity of ['full', 'presence_only']) {
      const result = validateAIConversationMetadata({ ...canonical(), input_fidelity });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts zero for all numeric fields', () => {
    const result = validateAIConversationMetadata({
      ...canonical(),
      duration_ms: 0,
      active_duration_ms: 0,
      turn_count: 0,
      char_count: 0,
      image_count: 0,
      video_seconds: 0,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateAIConversationMetadata - shape rejection', () => {
  it('rejects null', () => {
    const result = validateAIConversationMetadata(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata');
  });

  it('rejects arrays', () => {
    const result = validateAIConversationMetadata([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata');
  });

  it('rejects primitive types', () => {
    const result = validateAIConversationMetadata('not-an-object');
    expect(result.ok).toBe(false);
  });
});

describe('validateAIConversationMetadata - missing required fields', () => {
  const fields: (keyof AIConversationMetadata)[] = [
    'provider',
    'surface',
    'duration_ms',
    'active_duration_ms',
    'turn_count',
    'char_count',
    'image_count',
    'video_seconds',
    'session_fingerprint_hash',
    'input_fidelity',
  ];

  for (const field of fields) {
    it(`rejects when ${field} is missing`, () => {
      const obj = canonical();
      delete obj[field];
      const result = validateAIConversationMetadata(obj);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe(`ai_conversation_metadata.${field}`);
        expect(result.error.toLowerCase()).toContain('required');
      }
    });
  }
});

describe('validateAIConversationMetadata - enum rejection', () => {
  it('rejects unknown provider', () => {
    const result = validateAIConversationMetadata({ ...canonical(), provider: 'llama' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata.provider');
  });

  it('rejects non-string provider', () => {
    const result = validateAIConversationMetadata({ ...canonical(), provider: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata.provider');
  });

  it('rejects unknown surface', () => {
    const result = validateAIConversationMetadata({ ...canonical(), surface: 'web_extension' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata.surface');
  });

  it('rejects unknown input_fidelity', () => {
    const result = validateAIConversationMetadata({ ...canonical(), input_fidelity: 'partial' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('ai_conversation_metadata.input_fidelity');
  });
});

describe('validateAIConversationMetadata - numeric rejection', () => {
  const numericFields: (keyof AIConversationMetadata)[] = [
    'duration_ms',
    'active_duration_ms',
    'turn_count',
    'char_count',
    'image_count',
    'video_seconds',
  ];

  for (const field of numericFields) {
    it(`rejects non-integer ${field}`, () => {
      const result = validateAIConversationMetadata({ ...canonical(), [field]: 1.5 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.field).toBe(`ai_conversation_metadata.${field}`);
    });

    it(`rejects negative ${field}`, () => {
      const result = validateAIConversationMetadata({ ...canonical(), [field]: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.field).toBe(`ai_conversation_metadata.${field}`);
    });

    it(`rejects non-number ${field}`, () => {
      const result = validateAIConversationMetadata({ ...canonical(), [field]: '12' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.field).toBe(`ai_conversation_metadata.${field}`);
    });

    it(`rejects NaN ${field}`, () => {
      const result = validateAIConversationMetadata({ ...canonical(), [field]: NaN });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.field).toBe(`ai_conversation_metadata.${field}`);
    });
  }
});

describe('validateAIConversationMetadata - session_fingerprint_hash', () => {
  it('rejects uppercase hex', () => {
    const result = validateAIConversationMetadata({
      ...canonical(),
      session_fingerprint_hash: 'A'.repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('ai_conversation_metadata.session_fingerprint_hash');
    }
  });

  it('rejects wrong-length hash', () => {
    const result = validateAIConversationMetadata({
      ...canonical(),
      session_fingerprint_hash: 'a'.repeat(63),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('ai_conversation_metadata.session_fingerprint_hash');
    }
  });

  it('rejects non-hex characters', () => {
    const result = validateAIConversationMetadata({
      ...canonical(),
      session_fingerprint_hash: 'z'.repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('ai_conversation_metadata.session_fingerprint_hash');
    }
  });

  it('rejects non-string hash', () => {
    const result = validateAIConversationMetadata({
      ...canonical(),
      session_fingerprint_hash: 12345,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('ai_conversation_metadata.session_fingerprint_hash');
    }
  });
});

describe('mergeAIConversationMetadata', () => {
  it('returns bare source sentinel when validated is null', () => {
    const merged = mergeAIConversationMetadata(null);
    expect(merged).toEqual({ source: 'mobile_app' });
    expect(merged).not.toHaveProperty('ai_conversation');
  });

  it('merges validated metadata under ai_conversation key', () => {
    const result = validateAIConversationMetadata(canonical());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const merged = mergeAIConversationMetadata(result.value);
      expect(merged.source).toBe('mobile_app');
      expect(merged.ai_conversation).toEqual(result.value);
    }
  });
});
