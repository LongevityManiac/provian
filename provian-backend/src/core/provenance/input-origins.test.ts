/**
 * input_origins (Prompt 1 + Prompt 1b) — normalizer, entry witnessed/witness,
 * three-state, and forward-only reader integrity. Every assertion ships with an
 * OBSERVED-RED negative control (D-062): a guard only ever seen green proves nothing.
 */
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  normalizeInputOrigins,
  normalizeOriginWitness,
  inputOriginsState,
  isValidStoredInputOrigins,
  readInputOrigin,
  INPUT_ORIGINS_MAX_ENTRIES,
} from './input-origins';
import {
  canonicalAgentPeHash,
  validateCanonicalAgentStoredPe,
  validateDeviceSubmitStoredPe,
  CanonicalAgentPeChainIntegrityError,
} from '../agent-wallet/canonical-agent-pe-chain';
import {
  deviceSubmitPeHash,
  deviceSubmitPeContentFromStored,
} from '../agent-wallet/device-submit-pe-hash';

const AGENT_ID = 'prov-test-agent';
const WALLET_ID = 'aw_11111111-2222-3333-4444-555555555555';
const ACTOR = '0x1234567890abcdef1234567890abcdef12345678';
const PE_ID = 'pe_input_origins_test_1';

const WITNESS = { type: 'observer_device', identity: 'dev_abc123', attestation_tier: 'hardware_full' };
/** Prompt-1 (legacy) shape entries — no witnessed field. */
const LEGACY = [
  { hash: 'sha256:aaa', origin_identifier: 'https://example.com/a' },
  { hash: 'sha256:bbb', origin_identifier: 'npm:left-pad@1.3.0' },
];
/** Prompt-1b canonical stored entries. */
const POPULATED_1B = [
  { hash: 'sha256:aaa', origin_identifier: 'https://example.com/a', witnessed: false },
  { hash: 'sha256:bbb', origin_identifier: 'npm:left-pad@1.3.0', witnessed: true, witness: WITNESS },
];

// ---------------------------------------------------------------------------
// 1. Normalizer — three states + witnessed/witness, with an evaluated-count guard.
// ---------------------------------------------------------------------------
describe('normalizeInputOrigins', () => {
  it('maps every non-array to ABSENT (null)', () => {
    const absentInputs: unknown[] = [undefined, null, 'x', 42, true, {}, { hash: 'a', origin_identifier: 'b' }];
    expect(absentInputs.length).toBeGreaterThan(0);
    for (const v of absentInputs) expect(normalizeInputOrigins(v)).toBeNull();
  });

  it('[] → PRESENT_EMPTY; array → PRESENT_POPULATED', () => {
    expect(normalizeInputOrigins([])).toEqual([]);
    expect(inputOriginsState(normalizeInputOrigins([]))).toBe('present_empty');
  });

  it('every new entry carries witnessed:false by default; extra keys dropped; order kept', () => {
    const out = normalizeInputOrigins([
      { hash: 'h1', origin_identifier: 'o1', extra: 'DROP ME' },
      { hash: 'h2', origin_identifier: 'o2' },
    ]);
    expect(out).toEqual([
      { hash: 'h1', origin_identifier: 'o1', witnessed: false },
      { hash: 'h2', origin_identifier: 'o2', witnessed: false },
    ]);
  });

  it('witnessed:true + a usable witness is KEPT (witness extras dropped, tier optional)', () => {
    const out = normalizeInputOrigins([
      { hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 'forge_webhook', identity: 'gh:123', extra: 'x' } },
    ]);
    expect(out).toEqual([
      { hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 'forge_webhook', identity: 'gh:123' } },
    ]);
  });

  it('NEGATIVE CONTROL: witnessed:true with NO usable witness fails closed to witnessed:false', () => {
    const noWitness = normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true }]);
    expect(noWitness).toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
    const badWitness = normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 'x' } }]);
    expect(badWitness).toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
  });

  it('NEGATIVE CONTROL: a non-boolean/absent witnessed is NOT honored (only ===true)', () => {
    const truthy = normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: 'yes', witness: WITNESS }]);
    expect(truthy).toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
  });

  it('caps entry count', () => {
    const many = Array.from({ length: INPUT_ORIGINS_MAX_ENTRIES + 25 }, (_, i) => ({ hash: `h${i}`, origin_identifier: `o${i}` }));
    expect(normalizeInputOrigins(many)!.length).toBe(INPUT_ORIGINS_MAX_ENTRIES);
  });
});

describe('normalizeOriginWitness', () => {
  it('requires type + identity strings; drops extras; tier optional', () => {
    expect(normalizeOriginWitness({ type: 't', identity: 'i', extra: 1 })).toEqual({ type: 't', identity: 'i' });
    expect(normalizeOriginWitness({ type: 't', identity: 'i', attestation_tier: 'software' }))
      .toEqual({ type: 't', identity: 'i', attestation_tier: 'software' });
  });
  it('NEGATIVE CONTROL: rejects a non-object / missing field', () => {
    expect(normalizeOriginWitness('x')).toBeNull();
    expect(normalizeOriginWitness({ type: 't' })).toBeNull();
    expect(normalizeOriginWitness({ type: '', identity: 'i' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. canonicalAgentPeHash — entry-shape three-state hashes DISTINGUISHABLY, and a
//    LEGACY (Prompt 1) entry re-derives its ORIGINAL hash byte-identically.
// ---------------------------------------------------------------------------
function canonicalContent(inputOrigins?: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: PE_ID, wallet_id: WALLET_ID, agent_id: AGENT_ID,
    action_type: 'agent_work_product_code', actor_address: ACTOR,
    timestamp: 1_800_000_000_000, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { foo: 'bar' }, compute: null, geo: null, execution_env: null,
    cited_pe_ids: null, parent_goal_pe_id: null,
  };
  if (arguments.length > 0) base.input_origins = inputOrigins;
  return base;
}

describe('canonicalAgentPeHash — Prompt 1b entry shape + forward-only', () => {
  it('a LEGACY (2-key) entry re-derives its Prompt-1 hash byte-identically (verbatim, no witnessed injected)', () => {
    const legacyDoc = canonicalContent(LEGACY);
    const expected = crypto.createHash('sha256').update(stableStringify(legacyDoc)!, 'utf8').digest('hex');
    // The reader hashes raw.input_origins verbatim — a 2-key entry stays 2-key.
    expect(canonicalAgentPeHash(legacyDoc)).toBe(expected);
  });

  it('legacy vs witnessed:false vs witnessed:true are all DISTINCT hashes', () => {
    const legacy = canonicalAgentPeHash(canonicalContent([{ hash: 'h', origin_identifier: 'o' }]));
    const wFalse = canonicalAgentPeHash(canonicalContent([{ hash: 'h', origin_identifier: 'o', witnessed: false }]));
    const wTrue = canonicalAgentPeHash(canonicalContent([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: WITNESS }]));
    expect(new Set([legacy, wFalse, wTrue]).size).toBe(3);
    // Negative control: if witnessed were not in the preimage, wFalse would equal legacy.
    expect(wFalse).not.toBe(legacy);
    expect(wTrue).not.toBe(wFalse);
  });
});

// ---------------------------------------------------------------------------
// 3. validateCanonicalAgentStoredPe — legacy + 1b entries validate; malformed fails.
// ---------------------------------------------------------------------------
function storedCanonicalDoc(inputOrigins?: unknown): Record<string, unknown> {
  const content = arguments.length > 0 ? canonicalContent(inputOrigins) : canonicalContent();
  return {
    ...content,
    hash: canonicalAgentPeHash(content),
    user_id: AGENT_ID, policy_action_type: 'agent_work_product_code',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null, counterparty_type: null, session_lineage: null,
    self_referencing: false, trust_level_at_creation: null,
    created_at: 1_800_000_000_000, durability: 'final',
  };
}
function validateCanonical(raw: Record<string, unknown>) {
  return validateCanonicalAgentStoredPe({ raw, documentId: PE_ID, agentId: AGENT_ID, walletId: WALLET_ID });
}

describe('validateCanonicalAgentStoredPe — Prompt 1b forward-only + malformed rejection', () => {
  it('LEGACY (Prompt 1), witnessed:false, and witnessed:true+witness docs all validate', () => {
    expect(() => validateCanonical(storedCanonicalDoc(LEGACY))).not.toThrow();
    expect(() => validateCanonical(storedCanonicalDoc(POPULATED_1B))).not.toThrow();
    expect(() => validateCanonical(storedCanonicalDoc([]))).not.toThrow();
  });
  it('NEGATIVE CONTROL: a non-boolean witnessed fails pe_fields', () => {
    const doc = storedCanonicalDoc([{ hash: 'h', origin_identifier: 'o', witnessed: 'nope' }]);
    expect(() => validateCanonical(doc)).toThrow(CanonicalAgentPeChainIntegrityError);
    expect(() => validateCanonical(doc)).toThrow(/pe_fields/);
  });
  it('NEGATIVE CONTROL: a non-object witness fails pe_fields', () => {
    const doc = storedCanonicalDoc([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: 'x' }]);
    expect(() => validateCanonical(doc)).toThrow(/pe_fields/);
  });
});

// ---------------------------------------------------------------------------
// 4. Device-submit hash + reader — same forward-only property on the device shape.
// ---------------------------------------------------------------------------
function deviceContent(inputOrigins?: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: PE_ID, wallet_id: WALLET_ID, action_type: 'coding_session', actor_address: ACTOR,
    timestamp: 1_800_000_000_000, prev_hash: '0x0000', attestation_type: 'software',
    description: 'a structural coding_session record for the test',
    intent_text: 'a structural coding_session record for the test',
    metadata: { foo: 'bar' }, compute: null, geo: null, execution_env: null,
    cited_pe_ids: null, parent_goal_pe_id: null,
  };
  if (arguments.length > 0) base.input_origins = inputOrigins;
  return base;
}
function storedDeviceDoc(inputOrigins?: unknown): Record<string, unknown> {
  const content = arguments.length > 0 ? deviceContent(inputOrigins) : deviceContent();
  return {
    ...content,
    hash: deviceSubmitPeHash(deviceSubmitPeContentFromStored(content)),
    user_id: AGENT_ID, policy_action_type: 'coding_session',
    integration_source: 'device_pe_submit',
    counterparty_address: null, counterparty_type: null, session_lineage: null,
    self_referencing: false, trust_level_at_creation: null,
    created_at: 1_800_000_000_000, durability: 'final',
  };
}
function validateDevice(raw: Record<string, unknown>) {
  return validateDeviceSubmitStoredPe({ raw, documentId: PE_ID, agentId: AGENT_ID, walletId: WALLET_ID });
}

describe('device-submit hash + validator — Prompt 1b forward-only', () => {
  it('a LEGACY device entry re-derives its stored hash and validates', () => {
    const readerHash = deviceSubmitPeHash(deviceSubmitPeContentFromStored(deviceContent(LEGACY)));
    const legacyPreimage = crypto.createHash('sha256').update(stableStringify(deviceContent(LEGACY))!, 'utf8').digest('hex');
    expect(readerHash).toBe(legacyPreimage);
    expect(() => validateDevice(storedDeviceDoc(LEGACY))).not.toThrow();
  });
  it('witnessed:false and witnessed:true+witness device docs validate; hashes differ', () => {
    expect(() => validateDevice(storedDeviceDoc(POPULATED_1B))).not.toThrow();
    const wFalse = deviceSubmitPeHash(deviceSubmitPeContentFromStored(deviceContent([{ hash: 'h', origin_identifier: 'o', witnessed: false }])));
    const wTrue = deviceSubmitPeHash(deviceSubmitPeContentFromStored(deviceContent([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: WITNESS }])));
    expect(wFalse).not.toBe(wTrue);
  });
  it('NEGATIVE CONTROL: a non-boolean witnessed fails device_pe_fields', () => {
    const doc = storedDeviceDoc([{ hash: 'h', origin_identifier: 'o', witnessed: 3 }]);
    expect(() => validateDevice(doc)).toThrow(/device_pe_fields/);
  });
});

// ---------------------------------------------------------------------------
// 5. isValidStoredInputOrigins + readInputOrigin — direct coverage with red controls.
// ---------------------------------------------------------------------------
describe('isValidStoredInputOrigins', () => {
  it('accepts absent, [], legacy (no witnessed), and 1b entries', () => {
    expect(isValidStoredInputOrigins(undefined)).toBe(true);
    expect(isValidStoredInputOrigins([])).toBe(true);
    expect(isValidStoredInputOrigins(LEGACY)).toBe(true);
    expect(isValidStoredInputOrigins(POPULATED_1B)).toBe(true);
  });
  it('NEGATIVE CONTROL: rejects non-boolean witnessed / non-object witness / bad base', () => {
    expect(isValidStoredInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: 1 }])).toBe(false);
    expect(isValidStoredInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: 5 }])).toBe(false);
    expect(isValidStoredInputOrigins([{ hash: 1, origin_identifier: 'o' }])).toBe(false);
  });
});

describe('readInputOrigin — forward-only read view', () => {
  it('a legacy entry (no witnessed) reads as witnessed:false with no witness', () => {
    expect(readInputOrigin({ hash: 'h', origin_identifier: 'o' }))
      .toEqual({ hash: 'h', origin_identifier: 'o', witnessed: false });
  });
  it('a witnessed:true entry reads with its witness', () => {
    expect(readInputOrigin({ hash: 'h', origin_identifier: 'o', witnessed: true, witness: WITNESS }))
      .toEqual({ hash: 'h', origin_identifier: 'o', witnessed: true, witness: WITNESS });
  });
});

// ---------------------------------------------------------------------------
// D-487i — a credential embedded in an origin_identifier is never kept in the clear.
// ---------------------------------------------------------------------------
describe('D-487i — normalizeInputOrigins hashes credential-bearing identifiers', () => {
  const TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const W = { type: 'observer_device', identity: 'dev_1', attestation_tier: 'software' };

  it('RED: userinfo / ?token= / token-shaped identifiers → private tag, the value only in the hash', () => {
    const cases: Array<[string, string]> = [
      [`repo:https://x-access-token:${TOKEN}@github.com/o/r.git`, 'private_project'],
      ['pkg:git+https://u:t0k3nSecret@host.example/x.git', 'private_pkg'],
      ['pkg:https://registry.example/x.tgz?token=s3cr3tT0k', 'private_pkg'],
      [`domain:${TOKEN}.example.com`, 'private_host'],
      ['https://bot:hunter2@api.example.com/x', 'private_url_path'],
    ];
    const out = normalizeInputOrigins(cases.map(([id]) => ({ hash: 'sha256:client', origin_identifier: id, witnessed: true, witness: W })));
    expect(out).toHaveLength(cases.length);
    cases.forEach(([id, tag], i) => {
      expect(out![i].origin_identifier).toBe(tag);
      expect(out![i].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(out![i].witnessed).toBe(true);
      void id;
    });
    const json = JSON.stringify(out);
    for (const secret of [TOKEN, 't0k3nSecret', 's3cr3tT0k', 'hunter2', 'x-access-token']) {
      expect(json).not.toContain(secret);
    }
  });

  it('GREEN: clean identifiers pass byte-identical (hash and identifier untouched)', () => {
    const clean = [
      { hash: 'sha256:aa', origin_identifier: 'repo:https://github.com/o/r.git', witnessed: false },
      { hash: 'sha256:bb', origin_identifier: 'pkg:npm:@scope/lib@1.2.3', witnessed: false },
      { hash: 'sha256:cc', origin_identifier: 'domain:example.com', witnessed: false },
      { hash: 'sha256:dd', origin_identifier: 'repo:git@github.com:o/r.git', witnessed: false },
      { hash: 'sha256:ee', origin_identifier: 'pe:pe_123', witnessed: false },
    ];
    expect(normalizeInputOrigins(clean)).toEqual(clean);
  });
});

describe('D-487i review — the backstop digests the STRIPPED value, tags npm: as private_pkg, and keeps a bare git@ clean', () => {
  const TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const sha = (v: string) => `sha256:${crypto.createHash('sha256').update(v, 'utf8').digest('hex')}`;

  it('RED: npm:priv@git+https://x-access-token:<token>@… → private_pkg, hash over npm:priv@git+https://github.com/o/r.git', () => {
    const raw = `npm:priv@git+https://x-access-token:${TOKEN}@github.com/o/r.git`;
    const [o] = normalizeInputOrigins([{ hash: sha(raw), origin_identifier: raw, witnessed: false }])!;
    expect(o.origin_identifier).toBe('private_pkg');
    expect(o.hash).toBe(sha('npm:priv@git+https://github.com/o/r.git'));
    expect(o.hash).not.toBe(sha(raw));
  });

  it('RED: a token left in the path is redacted before the digest', () => {
    const raw = `repo:https://github.com/${TOKEN}/r.git`;
    const [o] = normalizeInputOrigins([{ hash: 'h', origin_identifier: raw, witnessed: false }])!;
    expect(o.origin_identifier).toBe('private_project');
    expect(o.hash).toBe(sha('repo:https://github.com/[redacted]/r.git'));
  });

  it('GREEN: a clean git+ssh://git@ coordinate passes byte-identical', () => {
    const clean = { hash: 'sha256:x', origin_identifier: 'npm:c@git+ssh://git@github.com/o/r.git', witnessed: false };
    expect(normalizeInputOrigins([clean])).toEqual([clean]);
    // …while a non-conventional user, or git WITH a password, is still a credential.
    expect(normalizeInputOrigins([{ ...clean, origin_identifier: 'npm:c@git+ssh://deploy@github.com/o/r.git' }])![0].origin_identifier).toBe('private_pkg');
    expect(normalizeInputOrigins([{ ...clean, origin_identifier: 'npm:c@git+https://git:pw@github.com/o/r.git' }])![0].origin_identifier).toBe('private_pkg');
  });
});
