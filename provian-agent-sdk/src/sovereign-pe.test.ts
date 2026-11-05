import {privacyTestFetch,openPrivacyTestRequest} from './relay-private-request.test-support';
/**
 * The sovereign lane after a hardware-witnessed work occurrence only.
 *
 * Proves the SDK's canonical work message + EIP-191 signature are recovered by
 * `ethers.verifyMessage` the exact primitive the relay's /v1/pe/submit-sovereign
 * handler uses — and that the one-call helper REQUIRES a hardware-witness producer
 * (a non-actor key's report over the body): without one, or when it produces
 * nothing, it refuses locally before any network call (the agent's own
 * signature is its own claim, never a PE).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import {
  SOVEREIGN_SUBMIT_FAMILIES,
  buildSovereignWorkCanonicalMessage,
  newSovereignNonce,
  submitHardwareWitnessedWork,
  SOVEREIGN_WORK_CANONICAL_TAG,
  type SovereignWorkFields,
} from './sovereign-pe';
import { signEip191Message } from './link-signing';
import type { HardwareWitnessProvider } from './hardware-witness';

const WALLET = {
  privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
};
const WITNESS: HardwareWitnessProvider = async () => ({ scheme: 'tpm2_quote', nonce_binding: 'body_sha256', quote: 'AA', signature: 'BB' });

function workFields(over: Partial<SovereignWorkFields> = {}): SovereignWorkFields {
  return {
    action_type: 'agent_work_product_code',
    agent_address: WALLET.address,
    occurrence_id: 'sha256:deadbeefdeadbeef',
    nonce: `0x${'cd'.repeat(32)}`,
    iat: 1782700000000,
    ...over,
  };
}

function okFetch(captured: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return privacyTestFetch((async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), body: openPrivacyTestRequest(JSON.parse(String(init?.body ?? '{}')))  });
    return new Response(JSON.stringify({ pe_id: 'pe_work_1', recorded: true, family: 'compute_or_work' }), { status: 201 });
  }) as typeof fetch);
}

describe('sovereign-work canonical message', () => {
  it('is deterministic, tagged, carries occurrence_id, lowercases the address', () => {
    const msg = buildSovereignWorkCanonicalMessage(workFields());
    expect(msg.startsWith(`${SOVEREIGN_WORK_CANONICAL_TAG}\n`)).toBe(true);
    expect(msg).toContain('occurrence_id=sha256:deadbeefdeadbeef');
    expect(msg).toContain(`agent_address=${WALLET.address.toLowerCase()}`);
    expect(msg).not.toContain(WALLET.address);
    expect(buildSovereignWorkCanonicalMessage(workFields())).toBe(msg);
  });

  it('[ control] a signature over one occurrence does NOT verify for another', () => {
    const sig = signEip191Message(WALLET.privateKeyHex, buildSovereignWorkCanonicalMessage(workFields()));
    const tampered = buildSovereignWorkCanonicalMessage(workFields({ occurrence_id: 'sha256:0000000000000000' }));
    expect(ethers.verifyMessage(tampered, sig).toLowerCase()).not.toBe(WALLET.address.toLowerCase());
  });

  it('newSovereignNonce returns 0x + 64 hex and is unique per call', () => {
    const a = newSovereignNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newSovereignNonce()).not.toBe(a);
  });
});

describe('submitHardwareWitnessedWork ', () => {
  it('RED guard: refuses locally without a hardware-witness producer — no network call', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    await expect(submitHardwareWitnessedWork('https://relay.example', WALLET, {
      actionType: 'agent_work_product_code', occurrenceId: 'sha256:feedfacefeedface',
    } as never, okFetch(captured))).rejects.toMatchObject({ code: 'HARDWARE_WITNESS_REQUIRED' });
    expect(captured).toEqual([]);
  });

  it('RED guard: refuses locally when the producer returns no report', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    await expect(submitHardwareWitnessedWork('https://relay.example', WALLET, {
      actionType: 'agent_work_product_code', occurrenceId: 'sha256:feedfacefeedface', hardwareWitness: async () => null,
    }, okFetch(captured))).rejects.toMatchObject({ code: 'HARDWARE_WITNESS_REQUIRED' });
    expect(captured).toEqual([]);
  });

  it('POSTs the signed binding + the witness slot, no prose; the signature recovers to the wallet', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await submitHardwareWitnessedWork('https://relay.example', WALLET, {
      actionType: 'agent_work_product_code', occurrenceId: 'sha256:feedfacefeedface', hardwareWitness: WITNESS,
    }, okFetch(captured));
    expect(result).toEqual({ pe_id: 'pe_work_1', recorded: true, family: 'compute_or_work' });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://relay.example/v1/pe/submit-sovereign');
    const body = captured[0].body;
    expect(body.hardware_witness).toMatchObject({ scheme: 'tpm2_quote' });
    expect(body.description).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    const reconstructed = buildSovereignWorkCanonicalMessage({
      action_type: String(body.action_type), agent_address: String(body.agent_address),
      occurrence_id: String(body.occurrence_id), nonce: String(body.nonce), iat: Number(body.iat),
    });
    expect(ethers.verifyMessage(reconstructed, String(body.signature)).toLowerCase()).toBe(WALLET.address.toLowerCase());
  });

  it('[ control] surfaces the relay refusal instead of fabricating success', async () => {
    const fetchFn = privacyTestFetch((async () => new Response(
      JSON.stringify({ error: 'x', code: 'actor_declared_work_is_not_a_pe' }), { status: 403 },
    )) as typeof fetch);
    await expect(submitHardwareWitnessedWork('https://relay.example', WALLET, {
      actionType: 'agent_work_product_code', occurrenceId: 'sha256:feedfacefeedface', hardwareWitness: WITNESS,
    }, fetchFn)).rejects.toThrow('actor_declared_work_is_not_a_pe');
  });
});

describe('the family the relay recorded the occurrence under', () => {
  const answering = (family: unknown): typeof fetch => privacyTestFetch((async () => new Response(
    JSON.stringify({ pe_id: 'pe_work_2', recorded: true, ...(family === undefined ? {} : { family }) }), { status: 201 },
  )) as typeof fetch);
  const submit = (fetchFn: typeof fetch) => submitHardwareWitnessedWork('https://relay.example', WALLET, {
    actionType: ['kiln', 'cycle', 'completed'].join('_'), occurrenceId: 'sha256:feedfacefeedface', hardwareWitness: WITNESS,
  }, fetchFn);

  it('the known families equal the two the relay answers (read from routes/sovereign-pe.ts)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../provian-backend/src/routes/sovereign-pe.ts'), 'utf8');
    const answer = /family: workFamily \? '([a-z_]+)' : '([a-z_]+)'/.exec(src);
    expect(answer).not.toBeNull();
    expect([...SOVEREIGN_SUBMIT_FAMILIES].sort()).toEqual([answer![1], answer![2]].sort());
  });

  it.each(SOVEREIGN_SUBMIT_FAMILIES)('reports %s exactly as the relay answered it', async (family) => {
    expect(await submit(answering(family))).toEqual({ pe_id: 'pe_work_2', recorded: true, family });
  });

  it('RED — an unknown or missing family is an error naming the recorded PE, never a guessed compute_or_work', async () => {
    for (const family of ['governance_vote', 'COMPUTE_OR_WORK', '', 42, null, undefined]) {
      await expect(submit(answering(family))).rejects.toMatchObject({ code: 'SOVEREIGN_FAMILY_UNKNOWN', message: expect.stringContaining('pe_work_2') });
    }
  });
});
