/**
 * POST /v1/pe/submit-sovereign — PEs prove provenance.
 *
 * "An agent declaring its own work has no path to a PE, minting or record-only."
 * The agent's own EIP-191 signature proves WHO is speaking, never that the work
 * happened, so the only submission this route still records is one carrying an
 * ADMITTED `hardware_witness` a report a non-actor key (TPM / enclave / CVM /
 * GPU root) signed over this exact body. Everything else is refused with
 * `actor_declared_work_is_not_a_pe` and NOTHING is written: no PE, no
 * record_only row, no nonce claim.
 *
 * - x402_payment: refused outright (its settlementTxHash was never re-checked;
 * the chain watcher witnesses x402 settlements independently).
 * - link_spend: refused outright (the observer's transcript lane witnesses the
 * Link CLI result).
 * - a compute_or_work type with no hardware witness, or an unadmitted one:
 * refused.
 * - a body labelled `mcp_self_report` refused.
 *
 * The adversarial binding checks (signer, replay, freshness, wallet, rate limit)
 * still hold on the one admitted path. generatePE is mocked (the chain mechanics
 * are covered by pe-utils' own suites); `admitHardwareWitness` is mocked so a
 * test can present an admitted / unadmitted verdict without a real TPM quote —
 * the verifiers themselves are covered by core/hardware's suites.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

jest.mock('../core/agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_sov_1', peHash: 'h', prevHash: 'p' })),
}));

jest.mock('../core/hardware/admit', () => {
  const actual = jest.requireActual('../core/hardware/admit') as Record<string, unknown>;
  return { ...actual, admitHardwareWitness: jest.fn() };
});

import { createSovereignPERouter } from './sovereign-pe';
import { generatePE } from '../core/agent-bank/pe-utils';
import { admitHardwareWitness, type HardwareAdmission } from '../core/hardware/admit';

const generatePEMock = generatePE as jest.MockedFunction<typeof generatePE>;
const admitMock = admitHardwareWitness as jest.MockedFunction<typeof admitHardwareWitness>;

const ADMITTED: HardwareAdmission = {
  present: true,
  admitted: true,
  verdict: { admitted: true, scheme: 'tpm2_quote', reason: 'verified', fields: null },
};
const UNADMITTED: HardwareAdmission = {
  present: true,
  admitted: false,
  verdict: { admitted: false, scheme: 'tpm2_quote', reason: 'nonce_mismatch', fields: null },
};

beforeEach(() => {
  generatePEMock.mockReset();
  generatePEMock.mockImplementation(async () => ({ peId: 'pe_sov_1', peHash: 'h', prevHash: 'p' }));
  admitMock.mockReset();
  admitMock.mockImplementation(async (raw: unknown) => (raw === undefined || raw === null
    ? { present: false, admitted: false, verdict: null }
    : ADMITTED));
});

// Deterministic agent wallet key (NOT real).
const AGENT = new ethers.Wallet('0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d');
const ATTACKER = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** A syntactically-present slot; the (mocked) verifier decides admission. */
const HW_SLOT = { scheme: 'tpm2_quote', quote: 'AAAA', signature: 'BBBB', ak_cert_chain: [] };

function freshNonce(seed = 'ab'): string {
  return `0x${seed.repeat(32).slice(0, 64)}`;
}

function makeCache(opts: { setNx?: boolean; rateAllowed?: boolean } = {}) {
  return {
    setNx: jest.fn(async () => opts.setNx ?? true),
    del: jest.fn(async () => undefined),
    checkRateLimit: jest.fn(async () => ({ allowed: opts.rateAllowed ?? true, current: 1, limit: 30 })),
  };
}

// Honors the address filter (byte-exact, like Firestore) so a checksummed-vs-
// lowercase query mismatch is actually caught.
function makeDb(walletDoc?: Record<string, unknown>) {
  let queriedAddress: unknown;
  const query: Record<string, unknown> = {
    where: jest.fn((field: string, _op: string, value: unknown) => {
      if (field === 'address') queriedAddress = value;
      return query;
    }),
    limit: jest.fn(() => query),
    // New-type intake: the pending-policy queue row of a named type (none here).
    doc: jest.fn(() => ({ get: jest.fn(async () => ({ exists: false, data: () => undefined })) })),
    get: jest.fn(async () => {
      const match = !!walletDoc && walletDoc.address === queriedAddress;
      const docs = match ? [{ data: () => walletDoc }] : [];
      return { empty: docs.length === 0, docs };
    }),
  };
  return { collection: jest.fn((_name?: string) => query) };
}

function activeWallet(over: Record<string, unknown> = {}) {
  return {
    id: 'wallet_aw_1',
    agent_id: 'agent_1',
    address: AGENT.address.toLowerCase(),
    status: 'active',
    platform: 'sdk',
    ...over,
  };
}

function buildApp(deps: { db: unknown; cache: unknown }): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/v1/pe/submit-sovereign',
    createSovereignPERouter({
      db: deps.db as never,
      cache: deps.cache as never,
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(async () => undefined),
    } as never),
  );
  return app;
}

// ---- x402 (the retired family) ---------------------------------------------
const X402_TAG = 'provian_sovereign_pe_v1';
async function signedX402Body(wallet: ethers.Wallet, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const f = { action_type: 'x402_payment', agent_address: AGENT.address, payer: AGENT.address, nonce: freshNonce(), iat: Date.now() };
  const message = [
    X402_TAG,
    `action_type=${f.action_type}`,
    `agent_address=${f.agent_address.toLowerCase()}`,
    `iat=${f.iat}`,
    `nonce=${f.nonce.toLowerCase()}`,
    `payer=${f.payer.toLowerCase()}`,
  ].join('\n');
  return { ...f, signature: await wallet.signMessage(message), ...extra };
}

// ---- the sovereign WORK binding --------------------------------------------
const WORK_TAG = 'provian_sovereign_work_v1';
interface WorkFields { action_type: string; agent_address: string; occurrence_id: string; nonce: string; iat: number }

function canonicalWork(f: WorkFields): string {
  return [
    WORK_TAG,
    `action_type=${f.action_type}`,
    `agent_address=${f.agent_address.toLowerCase()}`,
    `iat=${f.iat}`,
    `nonce=${f.nonce.toLowerCase()}`,
    `occurrence_id=${f.occurrence_id}`,
  ].join('\n');
}

async function signedWorkBody(
  wallet: ethers.Wallet,
  over: Partial<WorkFields> = {},
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const fields: WorkFields = {
    action_type: 'agent_work_product_code',
    agent_address: AGENT.address,
    occurrence_id: 'sha256:deadbeefdeadbeef',
    nonce: freshNonce('cd'),
    iat: Date.now(),
    ...over,
  };
  const signature = await wallet.signMessage(canonicalWork(fields));
  return { ...fields, signature, ...extra };
}

/** A binding-valid work body that ALSO carries a hardware-witness slot. */
async function witnessedWorkBody(over: Partial<WorkFields> = {}, extra: Record<string, unknown> = {}) {
  return signedWorkBody(AGENT, over, { hardware_witness: HW_SLOT, ...extra });
}

const REFUSAL = 'actor_declared_work_is_not_a_pe';

describe('POST /v1/pe/submit-sovereign — an actor\'s own claim is never a PE', () => {
  it('RED: a valid self-signed x402_payment is REFUSED and nothing is written (no PE, no nonce)', async () => {
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await signedX402Body(AGENT, {
      metadata: { settlementTxHash: `0x${'ab'.repeat(32)}`, amountAtomic: '1000' },
    }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('x402_payment_is_chain_witnessed');
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
  });

  it('RED: x402_payment is refused even WITH an admitted hardware witness (the chain witnesses x402)', async () => {
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await signedX402Body(AGENT, { hardware_witness: HW_SLOT }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('RED: a binding-valid compute_or_work submission with NO hardware witness is REFUSED — nothing written', async () => {
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await signedWorkBody(AGENT, {}, { description: 'wrote a parser' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('no_non_actor_witness');
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
    expect(cache.checkRateLimit).not.toHaveBeenCalled();
  });

  it('RED: a present-but-UNADMITTED hardware witness is REFUSED — no record_only PE, no nonce claimed', async () => {
    admitMock.mockImplementation(async () => UNADMITTED);
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('hardware_witness_not_admitted');
    expect(res.body.hardware_witness_reason).toBe('nonce_mismatch');
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
  });

  it('RED: an agent-supplied link_spend is REFUSED on this route (the transcript lane witnesses Link spends)', async () => {
    const LSRQ = 'lsrq_1AbCdEfGhIjKlMnOpQrStUv';
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody(
      { action_type: 'link_spend', occurrence_id: LSRQ },
      { metadata: { link_spend_id: LSRQ, amount: 3500, currency: 'usd', status: 'succeeded' } },
    ));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('link_spend_is_transcript_witnessed');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('RED: a body labelled mcp_self_report is REFUSED (self-reporting is removed)', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody({}, {
      metadata: { source: 'mcp_self_report', tool: 'provian:mcp' },
    }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('self_report_source');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('still refuses a NAMED non-family type (system_access) — its witness is someone else\'s; nothing written', async () => {
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody({ action_type: 'system_access' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REFUSAL);
    expect(res.body.reason).toBe('named_type_witnessed_elsewhere');
    expect(generatePEMock).not.toHaveBeenCalled();
    expect(cache.setNx).not.toHaveBeenCalled();
    expect(cache.checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /v1/pe/submit-sovereign — the one admitted path: a non-actor hardware witness', () => {
  it('ACCEPT: a bare TPM-signed submission records device tier with verified hardware facts', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pe_id: 'pe_sov_1', recorded: true, family: 'compute_or_work' });
    expect(generatePEMock).toHaveBeenCalledTimes(1);
    const params = generatePEMock.mock.calls[0][1] as {
      actionType: string; metadata: Record<string, unknown>; witnessClass?: string;
      observedCanonicalEventId?: string; durableViaOrdinaryIntake?: boolean;
    };
    expect(params.actionType).toBe('agent_work_product_code');
    expect(params.witnessClass).toBe('device_tier');
    expect(params.metadata.verified).toBe(true);
    expect(params.metadata.binding_signer).toBe(AGENT.address);
    expect((params.metadata.hardware_witness as Record<string, unknown>).admitted).toBe(true);
    expect(params.observedCanonicalEventId).toBe(`sovereign_work:${AGENT.address.toLowerCase()}:sha256:deadbeefdeadbeef`);
    expect(params.durableViaOrdinaryIntake).toBe(true);
    // The agent's prose never rides on the one admitted path either.
    expect(params.metadata.description).toBeUndefined();
  });

  it('rejects a compute_or_work submission missing occurrence_id — BAD_OCCURRENCE', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const body = await witnessedWorkBody();
    delete (body as Record<string, unknown>).occurrence_id;
    const res = await request(app).post('/v1/pe/submit-sovereign').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOVEREIGN_PE_BAD_OCCURRENCE');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('a signature for one occurrence is rejected for a different occurrence — SIGNER_MISMATCH', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const signed = await witnessedWorkBody({ occurrence_id: 'sha256:aaaaaaaaaaaaaaaa' });
    const res = await request(app).post('/v1/pe/submit-sovereign').send({ ...signed, occurrence_id: 'sha256:bbbbbbbbbbbbbbbb' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SOVEREIGN_PE_SIGNER_MISMATCH');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong signer — SIGNER_MISMATCH', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await signedWorkBody(ATTACKER, {}, { hardware_witness: HW_SLOT }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SOVEREIGN_PE_SIGNER_MISMATCH');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('rejects a replayed nonce — NONCE_USED, no record', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache({ setNx: false }) });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOVEREIGN_PE_NONCE_USED');
    expect(generatePEMock).not.toHaveBeenCalled();
  });

  it('rejects a stale envelope — STALE', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody({ iat: Date.now() - 60 * 60 * 1000 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOVEREIGN_PE_STALE');
  });

  it('rejects a malformed nonce — BAD_NONCE', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody({ nonce: '0x1234' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOVEREIGN_PE_BAD_NONCE');
  });

  it('rejects a garbage signature — BAD_SIGNATURE', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache() });
    const body = await witnessedWorkBody();
    const res = await request(app).post('/v1/pe/submit-sovereign').send({ ...body, signature: '0xnotasignature' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SOVEREIGN_PE_BAD_SIGNATURE');
  });

  it('rejects an unknown signer wallet — WALLET_NOT_FOUND', async () => {
    const app = buildApp({ db: makeDb(undefined), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOVEREIGN_PE_WALLET_NOT_FOUND');
  });

  it('rejects an inactive wallet — WALLET_INACTIVE', async () => {
    const app = buildApp({ db: makeDb(activeWallet({ status: 'suspended' })), cache: makeCache() });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOVEREIGN_PE_WALLET_INACTIVE');
  });

  it('rejects when the per-signer rate limit is exceeded — RATE_LIMITED (before hardware verification)', async () => {
    const app = buildApp({ db: makeDb(activeWallet()), cache: makeCache({ rateAllowed: false }) });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('SOVEREIGN_PE_RATE_LIMITED');
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('#31: a generatePE failure maps to a retryable 409 and releases the nonce', async () => {
    generatePEMock.mockRejectedValueOnce(new Error('contention'));
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    const res = await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOVEREIGN_PE_CONTENTION');
    expect(cache.del).toHaveBeenCalledTimes(1);
  });

  it('#31: does NOT release the nonce after the PE is durably written', async () => {
    const cache = makeCache();
    const app = buildApp({ db: makeDb(activeWallet()), cache });
    expect((await request(app).post('/v1/pe/submit-sovereign').send(await witnessedWorkBody())).status).toBe(201);
    expect(cache.del).not.toHaveBeenCalled();
  });
});
