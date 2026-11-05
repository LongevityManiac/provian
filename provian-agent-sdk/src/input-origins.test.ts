import {privacyTestFetch,openPrivacyTestRequest} from './relay-private-request.test-support';
/**
 * Prompt 1 + 1b (SDK) — input_origins normalizer (incl. witnessed/witness),
 * observed-PE device-mode wire forwarding, and submitHardwareWitnessedWork body
 * forwarding. Each guard ships an observed-red negative control (D-062).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openPrivatePricing } from '../../provian-backend/src/core/meter/private-pricing';
import {
  normalizeInputOrigins,
  inputOriginsState,
  INPUT_ORIGINS_MAX_ENTRIES,
} from './input-origins';
import type { InputOrigin } from './types';
import { ProvianClient } from './ProvianClient';
import { SUBMIT_OBSERVED_PE } from './observed-submit';
import { submitHardwareWitnessedWork } from './sovereign-pe';
import { CapturingPeStore, FakeMeterRelay } from './meter/capturing-store.test-support';

// Canonical Prompt-1b entries: one unwitnessed, one witnessed with a reference.
const POPULATED: InputOrigin[] = [
  { hash: 'sha256:aaa', origin_identifier: 'https://example.com/a', witnessed: false },
  { hash: 'sha256:bbb', origin_identifier: 'npm:left-pad@1.3.0', witnessed: true, witness: { type: 'forge_webhook', identity: 'gh:1' } },
];

describe('normalizeInputOrigins (sdk copy)', () => {
  it('non-array → absent; [] → present-empty; array → witnessed:false default, extras dropped', () => {
    const absentInputs: unknown[] = [undefined, null, 'x', 7, {}, { hash: 'a', origin_identifier: 'b' }];
    expect(absentInputs.length).toBeGreaterThan(0);
    for (const v of absentInputs) expect(normalizeInputOrigins(v)).toBeNull();
    expect(inputOriginsState(normalizeInputOrigins([]))).toBe('present_empty');
    expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', junk: 1 }]))
      .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
  });
  it('witnessed:true+witness kept; NEGATIVE CONTROL: witnessed:true w/o witness → false', () => {
    expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 't', identity: 'i' } }]))
      .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 't', identity: 'i' } }]);
    expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true }]))
      .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
  });
  it('caps entries', () => {
    const many = Array.from({ length: INPUT_ORIGINS_MAX_ENTRIES + 3 }, (_, i) => ({ hash: `h${i}`, origin_identifier: `o${i}` }));
    expect(normalizeInputOrigins(many)!.length).toBe(INPUT_ORIGINS_MAX_ENTRIES);
  });
});

describe('observed-PE device-mode recorder carries input_origins in the PE and its act record', () => {
  afterEach(() => vi.unstubAllGlobals());

  // PE meter: the PE is recorded on the device (no network); `input_origins` is a pricing input,
  // so it must be in the PE AND in the act record the daily batch sends.
  it('includes input_origins when observed; OMITS it when absent', async () => {
    const store = new CapturingPeStore();
    const relay = new FakeMeterRelay();
    vi.stubGlobal('fetch', relay.fetch);
    const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', peStore: store });
    await client[SUBMIT_OBSERVED_PE]({
      actionType: 'agent_work_product_code', description: 'work with observed origins',
      success: true, input_origins: POPULATED,
    });
    await client[SUBMIT_OBSERVED_PE]({
      actionType: 'agent_work_product_code', description: 'work with no observed origins',
      success: true, // input_origins omitted → absent
    });
    expect(store.bodies.length).toBe(2);
    expect(store.bodies[0].input_origins).toEqual(POPULATED);
    // Negative control: the absent record must NOT carry the key at all.
    expect('input_origins' in store.bodies[1]).toBe(false);
    expect(relay.requests).toHaveLength(0); // recording needed no network

    await (await client.createMeterBatcher()).flush();
    const acts = relay.accepted[0].acts;
    expect(relay.batchPosts()[0].body!).not.toContain('left-pad');
    expect(openPrivatePricing(acts[0], String(store.bodies[0].private_commitment)).input_origins).toEqual(POPULATED);
    expect('input_origins' in openPrivatePricing(acts[1], String(store.bodies[1].private_commitment))).toBe(false);
  });

  it('an empty array is forwarded (present-empty is distinct from absent)', async () => {
    const store = new CapturingPeStore();
    const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', peStore: store });
    await client[SUBMIT_OBSERVED_PE]({
      actionType: 'agent_work_product_code', description: 'observed, but no external inputs',
      success: true, input_origins: [],
    });
    expect(store.bodies[0].input_origins).toEqual([]);
  });
});


describe('submitHardwareWitnessedWork forwards input_origins in the body', () => {
  const hardwareWitness = async () => ({ scheme: 'tpm2_quote' as const, nonce_binding: 'body_sha256' as const, quote: 'AA', signature: 'BB' });
  const wallet = { privateKeyHex: 'a'.repeat(64), address: '0x' + 'b'.repeat(40) };
  function fakeFetch(bodies: string[]): typeof fetch {
    return privacyTestFetch((async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.stringify(openPrivacyTestRequest(JSON.parse(String(init?.body??'{}')))));
      return new Response(JSON.stringify({ pe_id: 'pe_sov', recorded: true, family: 'compute_or_work' }), { status: 201 }) as unknown as Response;
    }) as unknown as typeof fetch);
  }

  it('includes input_origins when provided; omits when not', async () => {
    const withBodies: string[] = [];
    await submitHardwareWitnessedWork('https://relay.test', wallet,
      { actionType: 'agent_work_product_code', occurrenceId: 'occ-1', inputOrigins: POPULATED, hardwareWitness }, fakeFetch(withBodies));
    expect(JSON.parse(withBodies[0]).input_origins).toEqual(POPULATED);

    const withoutBodies: string[] = [];
    await submitHardwareWitnessedWork('https://relay.test', wallet,
      { actionType: 'agent_work_product_code', occurrenceId: 'occ-2', hardwareWitness }, fakeFetch(withoutBodies));
    // Negative control: no inputOrigins param → key absent from the body.
    expect('input_origins' in JSON.parse(withoutBodies[0])).toBe(false);
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
