/**
 * NEW-TYPE INTAKE on the sovereign lane .
 *
 * "The type of work is never the gate." Beside the compute_or_work family, `POST
 * /v1/pe/submit-sovereign` now records a type the one intake rule admits on this lane — a
 * NEVER-SEEN type, or a type the operator signed for intake on this lane (`INTAKE_SIGNED_ACTION_TYPES`,
 * mocked here) whose pending-policy queue row lists `sovereign_hardware_witness` carrying an ADMITTED hardware witness. A NAMED type outside
 * the family stays refused (its witness is someone else's), and every refusal still applies
 * first. generatePE and the hardware verifier are mocked exactly as in `sovereign-pe.test.ts`; the
 * accrual's record_only seal + queue row are proven in `pvt-accrual.newTypeIntake.acceptance.test.ts`.
 *
 * Every acceptance ships with its RED control: the same body minus the witness, a named type, a
 * queue row from another lane or in a rejected state, and an unreadable queue are each refused with
 * nothing written.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

jest.mock('../core/agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_sov_intake', peHash: 'h', prevHash: 'p' })),
}));
// Rule (ii)'s positive grant: the stand-in named type is "signed for intake" on both lanes (the
// queue row still decides which lane it entered on). The real list is empty today.
jest.mock('../core/pvt/policy/intake-signed-action-types', () => ({
  INTAKE_SIGNED_ACTION_TYPES: { agent_sub_spawned: ['sovereign_hardware_witness', 'device_gateway_observer'] },
}));
jest.mock('../core/hardware/admit', () => {
  const actual = jest.requireActual('../core/hardware/admit') as Record<string, unknown>;
  return { ...actual, admitHardwareWitness: jest.fn() };
});

import { createSovereignPERouter } from './sovereign-pe';
import { generatePE } from '../core/agent-bank/pe-utils';
import { admitHardwareWitness, type HardwareAdmission } from '../core/hardware/admit';
import {
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  isNeverSeenActionType,
} from '../core/pvt/policy/new-type-intake';
import { PENDING_POLICY_COLLECTION, actionPolicyDocumentId } from '../core/pvt/policy/pending-policy-queue';

const generatePEMock = generatePE as jest.MockedFunction<typeof generatePE>;
const admitMock = admitHardwareWitness as jest.MockedFunction<typeof admitHardwareWitness>;

const ADMITTED: HardwareAdmission = {
  present: true, admitted: true,
  verdict: { admitted: true, scheme: 'tpm2_quote', reason: 'verified', fields: null },
};
const UNADMITTED: HardwareAdmission = {
  present: true, admitted: false,
  verdict: { admitted: false, scheme: 'tpm2_quote', reason: 'nonce_mismatch', fields: null },
};

const AGENT = new ethers.Wallet('0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d');
const HW_SLOT = { scheme: 'tpm2_quote', quote: 'AAAA', signature: 'BBBB', ak_cert_chain: [] };
const REFUSAL = 'actor_declared_work_is_not_a_pe';
/** A never-seen type: built at runtime (test files are outside the matrix generator's scan anyway). */
const NEVER_SEEN = ['soil', 'moisture', 'reading', 'intake'].join('_');

beforeEach(() => {
  generatePEMock.mockReset();
  generatePEMock.mockImplementation(async () => ({ peId: 'pe_sov_intake', peHash: 'h', prevHash: 'p' }));
  admitMock.mockReset();
  admitMock.mockImplementation(async (raw: unknown) => (raw === undefined || raw === null
    ? { present: false, admitted: false, verdict: null }
    : ADMITTED));
});

function makeCache() {
  return {
    setNx: jest.fn(async () => true),
    del: jest.fn(async () => undefined),
    checkRateLimit: jest.fn(async () => ({ allowed: true, current: 1, limit: 30 })),
  };
}

/** The wallet query (by address) plus the pending-policy queue doc for the submitted type. */
function makeDb(opts: { queue?: Record<string, Record<string, unknown>>; queueThrows?: boolean } = {}) {
  const wallet = { id: 'wallet_aw_1', agent_id: 'agent_1', address: AGENT.address.toLowerCase(), status: 'active' };
  const queueReads: string[] = [];
  const walletQuery: Record<string, unknown> = {
    where: jest.fn(() => walletQuery),
    limit: jest.fn(() => walletQuery),
    get: jest.fn(async () => ({ empty: false, docs: [{ data: () => wallet }] })),
  };
  const queueCollection = {
    doc: (id: string) => ({
      get: async () => {
        queueReads.push(id);
        if (opts.queueThrows) throw new Error('firestore unavailable');
        const row = opts.queue?.[id];
        return { exists: row !== undefined, data: () => row };
      },
    }),
  };
  return {
    queueReads,
    collection: jest.fn((name: string) => (name === PENDING_POLICY_COLLECTION ? queueCollection : walletQuery)),
  };
}

function buildApp(db: unknown, cache: unknown): Express {
  const app = express();
  app.use(express.json());
  app.use('/v1/pe/submit-sovereign', createSovereignPERouter({
    db: db as never, cache: cache as never, peBuffer: { enqueue: jest.fn() }, recordPEAccrual: jest.fn(async () => undefined),
  } as never));
  return app;
}

async function body(actionType: string, extra: Record<string, unknown> = { hardware_witness: HW_SLOT }) {
  const fields = {
    action_type: actionType, agent_address: AGENT.address, occurrence_id: 'reading:2026-10-22T12:00:00Z:probe-7',
    nonce: `0x${'ef'.repeat(32)}`, iat: Date.now(),
  };
  const message = [
    'provian_sovereign_work_v1',
    `action_type=${fields.action_type}`,
    `agent_address=${fields.agent_address.toLowerCase()}`,
    `iat=${fields.iat}`,
    `nonce=${fields.nonce.toLowerCase()}`,
    `occurrence_id=${fields.occurrence_id}`,
  ].join('\n');
  return { ...fields, signature: await AGENT.signMessage(message), ...extra };
}

describe('A1 — a never-seen type with an admitted hardware witness is RECORDED for review', () => {
  it('201, family new_type_intake; the PE rides the durable sovereign binding (record_only is the accrual\'s job)', async () => {
    expect(isNeverSeenActionType(NEVER_SEEN)).toBe(true);
    const db = makeDb();
    const app = buildApp(db, makeCache());
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await body(NEVER_SEEN));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ pe_id: 'pe_sov_intake', recorded: true, family: 'new_type_intake' });
    expect(generatePEMock).toHaveBeenCalledTimes(1);
    const params = generatePEMock.mock.calls[0][1] as unknown as Record<string, unknown> & { metadata: Record<string, unknown> };
    expect(params.actionType).toBe(NEVER_SEEN);
    expect(params.witnessClass).toBe('device_tier');
    expect(params.durableViaOrdinaryIntake).toBe(true);
    expect(params.metadata).toMatchObject({ sovereign_work: true, verified: true, binding_signer: AGENT.address });
    // Rule (i) is static: no queue read for a never-seen type.
    expect(db.queueReads).toEqual([]);
  });

  it('RED — the same never-seen type with NO witness is refused first (unchanged); nothing written', async () => {
    const cache = makeCache();
    const res = await request(buildApp(makeDb(), cache)).post('/v1/pe/submit-sovereign').send(await body(NEVER_SEEN, {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: REFUSAL, reason: 'no_non_actor_witness' });
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
  });

  it('RED — an UNADMITTED witness on a never-seen type is refused; nothing written', async () => {
    admitMock.mockImplementation(async () => UNADMITTED);
    const cache = makeCache();
    const res = await request(buildApp(makeDb(), cache)).post('/v1/pe/submit-sovereign').send(await body(NEVER_SEEN));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: REFUSAL, reason: 'hardware_witness_not_admitted' });
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
  });

  it('RED — a self-report label on a never-seen type is refused', async () => {
    const res = await request(buildApp(makeDb(), makeCache())).post('/v1/pe/submit-sovereign')
      .send(await body(NEVER_SEEN, { hardware_witness: HW_SLOT, metadata: { source: 'mcp_self_report' } }));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('self_report_source');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('invalid action_type syntax → 400 (the shared policy grammar), nothing written', async () => {
    for (const bad of ['9starts_with_digit', 'has space', 'UPPER:case', 'x'.repeat(201)]) {
      const res = await request(buildApp(makeDb(), makeCache())).post('/v1/pe/submit-sovereign').send(await body(bad));
      expect([bad.slice(0, 20), res.status, res.body.code]).toEqual([bad.slice(0, 20), 400, 'SOVEREIGN_PE_TYPE_NOT_ALLOWED']);
    }
    expect(generatePEMock).not.toHaveBeenCalled();
  });
});

describe('A1 — a relay-owned namespace is refused (review fix 1a)', () => {
  it.each(['service:github_issues', 'service:gitlab_note', 'git_tag_pushed'])('%s → 403 relay_owned_namespace, nothing written', async (owned) => {
    const cache = makeCache();
    const db = makeDb();
    const res = await request(buildApp(db, cache)).post('/v1/pe/submit-sovereign').send(await body(owned));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: REFUSAL, reason: 'relay_owned_namespace' });
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
    expect(db.queueReads).toEqual([]);
  });
});

describe('A1 — a NAMED type outside compute_or_work is refused: its witness is someone else\'s', () => {
  it.each(['escrow_completed', 'genesis_signup', 'send', 'receive', 'wallet_created', 'commons_post_created'])(
    '%s → 403 named_type_witnessed_elsewhere, no write, no rate-limit, no nonce',
    async (named) => {
      expect(isNeverSeenActionType(named)).toBe(false);
      const cache = makeCache();
      const db = makeDb();
      const res = await request(buildApp(db, cache)).post('/v1/pe/submit-sovereign').send(await body(named));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: REFUSAL, reason: 'named_type_witnessed_elsewhere' });
      expect(generatePEMock).not.toHaveBeenCalled();
      expect(cache.checkRateLimit).not.toHaveBeenCalled();
      expect(cache.setNx).not.toHaveBeenCalled();
      // Statically emitted / launch types are refused without a queue read (rule ii never admits them).
      expect(db.queueReads).toEqual([]);
    },
  );

  it('the compute_or_work family is unchanged (family compute_or_work, no queue read)', async () => {
    const db = makeDb();
    const res = await request(buildApp(db, makeCache())).post('/v1/pe/submit-sovereign').send(await body('agent_work_product_code'));
    expect(res.status).toBe(201);
    expect(res.body.family).toBe('compute_or_work');
    expect(db.queueReads).toEqual([]);
  });
});

describe('A1 (ii) — a type that ENTERED on this lane keeps being admitted after the operator names it', () => {
  // A named type stands in for "an intake type the operator has since signed" (its queue row is the proof).
  const SIGNED = 'agent_sub_spawned';
  const id = actionPolicyDocumentId(SIGNED);
  const row = (over: Record<string, unknown>) => ({
    [id]: { action_type: SIGNED, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'pending_policy', ...over },
  });

  it.each(['pending_policy', 'resolved_signed_matrix'])('queue row from this lane, %s → 201 new_type_intake', async (state) => {
    const res = await request(buildApp(makeDb({ queue: row({ policy_review_state: state }) }), makeCache()))
      .post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(201);
    expect(res.body.family).toBe('new_type_intake');
  });

  it('RED (review fix 1b) — the row also lists a forge/relay source → refused, even resolved_signed_matrix', async () => {
    const res = await request(buildApp(makeDb({ queue: row({
      integration_sources: ['agent_bank_generate_pe', SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'resolved_signed_matrix',
    }) }), makeCache())).post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('named_type_witnessed_elsewhere');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('RED (review fix 1c) — a launch emitter with an intake-only row → refused, no read', async () => {
    const launch = 'escrow_completed';
    const db = makeDb({ queue: { [actionPolicyDocumentId(launch)]: {
      action_type: launch, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'resolved_signed_matrix',
    } } });
    const res = await request(buildApp(db, makeCache())).post('/v1/pe/submit-sovereign').send(await body(launch));
    expect(res.status).toBe(403);
    expect(db.queueReads).toEqual([]);
  });

  it('RED — the row lists only ANOTHER lane (the gateway observer) → refused', async () => {
    const res = await request(buildApp(makeDb({ queue: row({ integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE] }) }), makeCache()))
      .post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('named_type_witnessed_elsewhere');
  });

  it.each(['rejected', 'classified_prospective'])('RED — the row is %s → refused', async (state) => {
    const res = await request(buildApp(makeDb({ queue: row({ policy_review_state: state }) }), makeCache()))
      .post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(403);
  });

  it('RED — a queue row whose action_type does not match the doc id → refused', async () => {
    const res = await request(buildApp(makeDb({ queue: row({ action_type: 'something_else' }) }), makeCache()))
      .post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(403);
  });

  it('RED ( , A) — a named type with NO intake grant and an intake-only resolved row → 403, no read, nothing written', async () => {
    const relayType = 'commons_post_replied';
    const db = makeDb({ queue: { [actionPolicyDocumentId(relayType)]: {
      action_type: relayType, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'resolved_signed_matrix',
    } } });
    const res = await request(buildApp(db, makeCache())).post('/v1/pe/submit-sovereign').send(await body(relayType));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('named_type_witnessed_elsewhere');
    expect(db.queueReads).toEqual([]);
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('RED — an unreadable queue refuses (Unknown = Block): 503, nothing written', async () => {
    const cache = makeCache();
    const res = await request(buildApp(makeDb({ queueThrows: true }), cache)).post('/v1/pe/submit-sovereign').send(await body(SIGNED));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SOVEREIGN_PE_INTAKE_UNAVAILABLE');
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
  });
});
