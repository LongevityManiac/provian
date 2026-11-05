/**
 * Adversarial tests for createRegisterDeviceHandler under AGENT auth, and the
 * Security Invariant #9 (M9) device-PE rate-limit shape.
 *
 * Covers BUILD SPEC items 1 (register yields owner_type=agent + owner_wallet_id =
 * agent wallet id when req.agentWallet is set) and 6 (the device_register accrual
 * passes NO device anchor -> records but mints 0 PVT; not a farming vector).
 *
 * The handler resolves owner context ONLY from req (req.agentWallet / req.user) -
 * the body never carries owner identity. We drive it directly with a faked
 * req/res, mocking the chain-validator + citation + attestation modules so the
 * test is hermetic (no Firestore transactions, no on-chain work).
 */

import { afterAll, describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';

// --- Module mocks: keep the handler hermetic --------------------------------
jest.mock('../pe-chain-validator', () => ({
  advanceChainTipAtomic: jest.fn(
    async (
      db: { runTransaction: (fn: (txn: unknown) => Promise<unknown>) => Promise<unknown> },
      _userId: string,
      computeHash: (prev: string) => string,
      _timestamp?: number,
      coWrites?: (txn: unknown, context: { prevHash: string; newHash: string }) => void,
      precondition?: (txn: unknown, context: { prevHash: string }) => Promise<void>,
    ) => db.runTransaction(async (txn) => {
      const prevHash = '0x0000';
      await precondition?.(txn, { prevHash });
      const newHash = computeHash(prevHash);
      coWrites?.(txn, { prevHash, newHash });
      return { prev_hash: prevHash, new_hash: newHash };
    }),
  ),
  validatePETimestamp: jest.fn(() => null),
  isDuplicatePEHash: jest.fn(async () => false),
  registerPEHash: jest.fn(async () => undefined),
}));
jest.mock('../core/attestation', () => ({
  verifyAndroidRegistrationChain: jest.fn(async () => ({ ok: false, code: 'not_presented', reason: 'n/a' })),
}));

import { createRegisterDeviceHandler } from './devices';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from '../core/pvt/__test-helpers__/armed-genesis-policy';
import { invalidateGenesisConfigCache } from '../core/pvt/genesis-campaign';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
} from '../core/pvt/genesis-award-state-machine';
import { hashGenesisCampaignPolicyManifest } from '../core/pvt/policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../core/pvt/policy/proposed-genesis-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from '../core/pvt/policy/pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from '../core/pvt/policy/runtime-monetary-policy';
import type { RecordPEAccrualParams } from '../pvt-accrual';
import type { AgentWalletDocument } from '../core/agent-wallet/types';

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

// ---------------------------------------------------------------------------
// Minimal in-memory Firestore for the register path:
//   - devices.where('owner_user_id','==',x).where('status','==','active').get()
//   - db.batch().set(...).commit()
//   - agent_wallets.doc(id) runTransaction (attestation_count; never hit for
//     verified software cap)
// ---------------------------------------------------------------------------

function makeDb(opts: { genesisActivation?: Record<string, unknown> } = {}) {
  const devices = new Map<string, Record<string, unknown>>();
  const genesisClaims = new Map<string, Record<string, unknown>>();
  const collections = new Map<string, Map<string, Record<string, unknown>>>([
    ['devices', devices],
    ['genesis_qualification_outbox_v2', genesisClaims],
  ]);
  if (opts.genesisActivation) {
    collections.set(
      GENESIS_ACTIVATION_COLLECTION,
      new Map([[GENESIS_ACTIVATION_DOCUMENT, opts.genesisActivation]]),
    );
  }
  const forCollection = (name: string): Map<string, Record<string, unknown>> => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    collections.set(name, created);
    return created;
  };
  const collection = (name: string) => {
    const filters: Array<{ field: string; value: unknown }> = [];
    const query = {
      where(field: string, _op: string, value: unknown) {
        filters.push({ field, value });
        return query;
      },
      limit() { return query; },
      async get() {
        const rows = [...forCollection(name).entries()]
          .filter(([, data]) => filters.every((filter) => data[filter.field] === filter.value));
        return {
          size: rows.length,
          empty: rows.length === 0,
          docs: rows.map(([id, data]) => ({ id, data: () => data })),
        };
      },
    };
    return {
      ...query,
      doc: (id: string) => ({
        _name: name,
        _id: id,
        get: async () => {
          const data = forCollection(name).get(id);
          return { exists: data !== undefined, data: () => data };
        },
        create: async (data: Record<string, unknown>) => {
          if (forCollection(name).has(id)) throw new Error('ALREADY_EXISTS');
          forCollection(name).set(id, data);
        },
        delete: async () => { forCollection(name).delete(id); },
        update: async (data: Record<string, unknown>) => {
          forCollection(name).set(id, { ...(forCollection(name).get(id) ?? {}), ...data });
        },
      }),
    };
  };
  const batch = () => ({
    set(ref: { _name: string; _id: string }, data: Record<string, unknown>) {
      forCollection(ref._name).set(ref._id, data);
    },
    async commit() { /* writes are applied eagerly in this hermetic fake */ },
  });
  const db = {
    collection,
    batch,
    runTransaction: async <T>(fn: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (ref: { _name: string; _id: string }, data: Record<string, unknown>) => void;
      create: (ref: { _name: string; _id: string }, data: Record<string, unknown>) => void;
      update: (ref: { _name: string; _id: string }, data: Record<string, unknown>) => void;
    }) => Promise<T>): Promise<T> => {
      const writes: Array<() => void> = [];
      const result = await fn({
        get: (ref) => ref.get(),
        set: (ref, data) => writes.push(() => forCollection(ref._name).set(ref._id, data)),
        create: (ref, data) => {
          if (forCollection(ref._name).has(ref._id)) throw new Error('ALREADY_EXISTS');
          writes.push(() => forCollection(ref._name).set(ref._id, data));
        },
        update: (ref, data) => writes.push(() => forCollection(ref._name).set(
          ref._id,
          { ...(forCollection(ref._name).get(ref._id) ?? {}), ...data },
        )),
      });
      for (const write of writes) write();
      return result;
    },
  };
  return { db: db as unknown as import('firebase-admin/firestore').Firestore, devices, genesisClaims, collections };
}

/** Structurally armed PVT9 activation; tests inject the approval verifier. */
const ARMED_GENESIS_DEVICE_LINK = {
  approval_status: 'approved_by_frank',
  approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  approval_signature: {
    scheme: 'sshsig-ed25519',
    signer_identity: 'frank',
    namespace: 'provian-pvt-policy',
    public_key_sha256: `sha256:${'a'.repeat(64)}`,
    armored_signature: 'test-only-structured-signature',
  },
  frank_approval_audit_id: 'device-route-test-approval',
  approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
  approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
    PROPOSED_GENESIS_CAMPAIGN_POLICY,
  ),
  approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
  effective_at_ms: TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
  admission_closed_at_ms: null,
  admission_close_audit_id: null,
  grants_enabled: true,
  genesis_kill_switch_active: false,
  canonical_pvt_manifest_id: 'pvt9-device-route-test',
  ledger_namespace: 'pvt9-device-route-test-ledger',
  prior_reservations_reconciled: true,
  operator_activation_audit_id: 'device-route-test-operator',
};

interface CapturedRes {
  statusCode: number;
  body: Record<string, unknown> | undefined;
}

function makeReqRes(reqOverrides: Partial<Request> & Record<string, unknown>) {
  const req = {
    body: {},
    headers: {},
    ...reqOverrides,
  } as unknown as Request;
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(payload: Record<string, unknown>) { captured.body = payload; return this; },
  } as unknown as Response;
  return { req, res, captured };
}

function makeDeps(
  db: import('firebase-admin/firestore').Firestore,
  options: { failAccrualOnce?: boolean; approveGenesis?: boolean } = {},
) {
  const enqueued: Array<{ docId: string; data: object }> = [];
  const accruals: RecordPEAccrualParams[] = [];
  let failAccrual = options.failAccrualOnce === true;
  const processGenesisQualification = jest.fn(async (_qualificationId: string) => ({
    status: 'pending_activation',
  }));
  const deps = {
    db,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true })),
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
    },
    peBuffer: { enqueue: (docId: string, data: object) => { enqueued.push({ docId, data }); } },
    recordPEAccrual: async (params: RecordPEAccrualParams) => {
      accruals.push(params);
      if (failAccrual) {
        failAccrual = false;
        throw new Error('injected accrual failure');
      }
    },
    processGenesisQualification,
    ...(options.approveGenesis
      ? { genesisActivationApprovalVerifier: () => true }
      : {}),
  };
  return {
    deps: deps as unknown as Parameters<typeof createRegisterDeviceHandler>[0],
    enqueued,
    accruals,
    processGenesisQualification,
  };
}

const AGENT_WALLET = {
  id: 'wallet_aw_agent1',
  agent_id: 'agent-1',
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  status: 'active',
  created_at: Date.now() - 1_000,
} as unknown as AgentWalletDocument;

const VALID_BODY = {
  registration_id: 'device-handler-test-0001',
  device_name: "Bob's build box",
  device_type: 'coding_workstation',
  platform: 'linux',
  attestation_capability: 'software',
};

describe('createRegisterDeviceHandler under agent auth (BUILD SPEC item 1)', () => {
  let consoleWarn: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { consoleWarn.mockRestore(); });

  it('fails a malformed owner address before credentials or registration artifacts', async () => {
    const { db, devices, genesisClaims } = makeDb({
      genesisActivation: ARMED_GENESIS_DEVICE_LINK,
    });
    const { deps, enqueued, accruals, processGenesisQualification } = makeDeps(db, {
      approveGenesis: true,
    });
    const handler = createRegisterDeviceHandler(deps);
    const malformedWallet = {
      ...AGENT_WALLET,
      address: 'not-an-address',
    } as AgentWalletDocument;
    const { req, res, captured } = makeReqRes({
      agentWallet: malformedWallet,
      body: { ...VALID_BODY },
    });

    await handler(req, res, () => {});
    expect(captured).toMatchObject({
      statusCode: 409,
      body: { error: 'owner_wallet_identity_invalid' },
    });
    expect(devices.size).toBe(0);
    expect(genesisClaims.size).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(accruals).toHaveLength(0);
    expect(processGenesisQualification).not.toHaveBeenCalled();
  });

  it('H3: a refused in-window device link reports retained_pending_activation', async () => {
    // makeDb() has no activation doc, so the persist gate refuses.
    const { db, genesisClaims } = makeDb();
    const { deps, processGenesisQualification } = makeDeps(db, { approveGenesis: true });
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY, registration_id: 'device-h3-retained-0001' },
    });

    await handler(req, res, () => {});
    expect(captured.statusCode).toBe(201);
    // Honest status: the grant is retained for backfill, not silently dropped.
    expect(captured.body?.genesis_qualification_status).toBe('retained_pending_activation');
    // Fail-closed: nothing in the mint-readable outbox; not processed.
    expect(genesisClaims.size).toBe(0);
    expect(processGenesisQualification).not.toHaveBeenCalled();
  });

  it('H3 control: a valid activation reports queued and persists to the outbox', async () => {
    const { db, genesisClaims } = makeDb({ genesisActivation: ARMED_GENESIS_DEVICE_LINK });
    const { deps } = makeDeps(db, { approveGenesis: true });
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY, registration_id: 'device-h3-persisted-0001' },
    });

    await handler(req, res, () => {});
    expect(captured.statusCode).toBe(201);
    expect(captured.body?.genesis_qualification_status).toBe('queued');
    expect(genesisClaims.size).toBe(1);
  });

  it('registers owner_type=agent with owner_wallet_id = agent wallet id', async () => {
    const { db, collections } = makeDb();
    const { deps, enqueued } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);

    const { req, res, captured } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY },
    });
    await handler(req, res, () => {});

    expect(captured.statusCode).toBe(201);
    expect(captured.body?.owner_type).toBe('agent');
    expect(captured.body?.owner_wallet_id).toBe('wallet_aw_agent1');
    // Credentials are returned so the SDK can persist them.
    expect(captured.body?.device_key).toEqual(expect.stringMatching(/^pdk_/));
    expect(captured.body?.device_secret).toEqual(expect.stringMatching(/^pds_/));
    expect(typeof captured.body?.registration_pe_id).toBe('string');

    // PE METER: the device_register PE is a relay act staged on the agent's chain; no readable
    // PE is written or buffered.
    expect(enqueued).toHaveLength(0);
    const intakes = [...(collections.get('meter_relay_acts_v1') ?? new Map()).values()];
    expect(intakes).toHaveLength(1);
    const intake = intakes[0] as { actor_id: string; act: { action_type: string; pe_id: string; pricing: { wallet_id: string; metadata: { owner_type: string; attribution_model: string } } } };
    expect(intake.act.action_type).toBe('device_register');
    expect(intake.act.pe_id).toBe(captured.body?.registration_pe_id);
    expect(intake.act.pricing.wallet_id).toBe('wallet_aw_agent1');
    expect(intake.act.pricing.metadata.owner_type).toBe('agent');
    expect(intake.act.pricing.metadata.attribution_model).toBe('device_owner');
    expect((collections.get('provenance_envelopes') ?? new Map()).size).toBe(0);
  });

  it('persists the device doc with agent ownership (owner context comes from auth, never the body)', async () => {
    const { db, devices } = makeDb();
    const { deps } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);

    // Adversarial: body tries to claim a different owner. It must be ignored -
    // owner identity is taken ONLY from req.agentWallet.
    const { req, res } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY, owner_type: 'human', owner_wallet_id: 'attacker', owner_user_id: 'attacker' },
    });
    await handler(req, res, () => {});

    const stored = [...devices.values()][0] as {
      owner_type: string; owner_wallet_id: string; owner_user_id: string; owner_address: string;
    };
    expect(stored.owner_type).toBe('agent');
    expect(stored.owner_wallet_id).toBe('wallet_aw_agent1');
    expect(stored.owner_user_id).toBe('wallet_aw_agent1');
    expect(stored.owner_address).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('an agent claiming hardware_tpm is downgraded to software on the device doc (no hardware for agents)', async () => {
    const { db, devices } = makeDb();
    const { deps } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);
    const { req, res } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY, attestation_capability: 'hardware_tpm' },
    });
    await handler(req, res, () => {});
    const stored = [...devices.values()][0] as { attestation_capability: string };
    expect(stored.attestation_capability).toBe('software');
  });

  // /10-01 (supersedes addendum 3): every agent with its own wallet draws
  // its own device grant, however it was onboarded — a parent-spawned agent included.
  it.each([
    ['names a parent', 'wallet_aw_parent', 1],
    ['names no parent', null, 1],
  ])('an agent wallet that %s', async (_label, parentWalletId, expectedGrants) => {
    invalidateGenesisConfigCache();
    const { db, genesisClaims } = makeDb({ genesisActivation: ARMED_GENESIS_DEVICE_LINK });
    const { deps, processGenesisQualification } = makeDeps(db, { approveGenesis: true });
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({
      agentWallet: { ...AGENT_WALLET, parent_wallet_id: parentWalletId } as unknown as AgentWalletDocument,
      body: { ...VALID_BODY, registration_id: 'device-child-genesis-0001' },
    });
    await handler(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.statusCode).toBe(201);
    expect(genesisClaims.size).toBe(expectedGrants);
    expect(processGenesisQualification).toHaveBeenCalledTimes(expectedGrants);
    invalidateGenesisConfigCache();
  });

  it('registers the device but writes no Genesis outbox while PVT9 activation is disarmed', async () => {
    invalidateGenesisConfigCache();
    const { db, genesisClaims } = makeDb();
    const { deps, processGenesisQualification } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({ agentWallet: AGENT_WALLET, body: { ...VALID_BODY } });
    await handler(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.statusCode).toBe(201);
    expect(processGenesisQualification).not.toHaveBeenCalled();
    expect(genesisClaims.size).toBe(0);
  });

  it('uses the registered device id for a bearer/software agent device (NO attestation gate)', async () => {
    invalidateGenesisConfigCache();
    // Default (bearer) agent device - cannot hardware-attest (e.g. Atlas on a Mac
    // Mini). Eligibility must NOT be gated by attestation type: an armed campaign
    // pays it just like any other device, deduped per device id, bounded by caps.
    const { db, genesisClaims } = makeDb({ genesisActivation: ARMED_GENESIS_DEVICE_LINK });
    const { deps, processGenesisQualification } = makeDeps(db, { approveGenesis: true });
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({ agentWallet: AGENT_WALLET, body: { ...VALID_BODY } });
    await handler(req, res, () => {});
    // Processing is fired-and-forgotten after the 201; flush pending work.
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.statusCode).toBe(201);
    expect(processGenesisQualification).toHaveBeenCalledTimes(1);
    expect(genesisClaims.size).toBe(1);
    expect([...genesisClaims.values()][0]).toMatchObject({
      action_type: 'genesis_device_link',
      wallet_id: 'wallet_aw_agent1',
      economic_actor_id: 'wallet_aw_agent1',
      immutable_anchor: {
        anchor_kind: 'registered_device_id',
      },
    });
    invalidateGenesisConfigCache();
  });

  it('retries one committed registration without creating a second device, PE, or Genesis outbox', async () => {
    const { db, devices, genesisClaims, collections } = makeDb({
      genesisActivation: ARMED_GENESIS_DEVICE_LINK,
    });
    const { deps, accruals, enqueued } = makeDeps(db, {
      failAccrualOnce: true,
      approveGenesis: true,
    });
    const handler = createRegisterDeviceHandler(deps);
    const body = {
      ...VALID_BODY,
      device_key: `pdk_${'1'.repeat(32)}`,
      device_secret: `pds_${'2'.repeat(64)}`,
    };

    const first = makeReqRes({ agentWallet: AGENT_WALLET, body });
    await handler(first.req, first.res, () => {});
    expect(first.captured.statusCode).toBe(503);

    const retry = makeReqRes({ agentWallet: AGENT_WALLET, body });
    await handler(retry.req, retry.res, () => {});
    expect(retry.captured.statusCode).toBe(201);
    expect(retry.captured.body?.idempotent_replay).toBe(true);
    expect(devices.size).toBe(1);
    expect(genesisClaims.size).toBe(1);
    expect(accruals.filter((entry) => entry.actionType === 'device_register')).toHaveLength(2);
    // One staged act, priced again on the retry with the same identity (never a second PE).
    expect(enqueued).toHaveLength(0);
    expect((collections.get('meter_relay_acts_v1') ?? new Map()).size).toBe(1);
    const registerAccruals = accruals.filter((entry) => entry.actionType === 'device_register');
    expect(registerAccruals[1].peId).toBe(registerAccruals[0].peId);
    expect(registerAccruals[1].peHash).toBe(registerAccruals[0].peHash);
  });

  it('401s when neither req.agentWallet nor req.user is present (no owner context)', async () => {
    const { db } = makeDb();
    const { deps } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);
    const { req, res, captured } = makeReqRes({ body: { ...VALID_BODY } });
    await handler(req, res, () => {});
    expect(captured.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// M9 / Security Invariant #9 - item 6
// ---------------------------------------------------------------------------

describe('agent device_register accrual passes NO device anchor (M9 / Invariant #9)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('records the PE but supplies no deviceAttestationId -> mints 0 PVT (not a farming vector)', async () => {
    const { db } = makeDb();
    const { deps, accruals } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);

    const { req, res, captured } = makeReqRes({
      agentWallet: AGENT_WALLET,
      body: { ...VALID_BODY },
    });
    await handler(req, res, () => {});
    // Allow the fire-and-forget accrual promise to settle.
    await new Promise((r) => setImmediate(r));

    expect(captured.statusCode).toBe(201);
    const accrual = accruals.find((a) => a.actionType === 'device_register');
    expect(accrual).toBeDefined();
    // The PE IS recorded (isDevicePE true) ...
    expect(accrual!.isDevicePE).toBe(true);
    expect(accrual!.attestationDepth).toBe('software');
    // ... but with NO physical-device anchor. A rate-limited setup PE type with
    // no device_attestation_id is denied at mint -> 0 PVT (Invariant #9).
    expect(accrual!.deviceAttestationId).toBeUndefined();
    expect(accrual!.deviceId).toBeUndefined();
  });

  it('the same is true regardless of any device anchor the caller tries to put in the body', async () => {
    const { db } = makeDb();
    const { deps, accruals } = makeDeps(db);
    const handler = createRegisterDeviceHandler(deps);
    const { req, res } = makeReqRes({
      agentWallet: AGENT_WALLET,
      // Attempt to smuggle an anchor; the handler must not forward it.
      body: { ...VALID_BODY, device_attestation_id: 'sneaky-anchor', deviceAttestationId: 'sneaky-anchor' },
    });
    await handler(req, res, () => {});
    await new Promise((r) => setImmediate(r));
    const accrual = accruals.find((a) => a.actionType === 'device_register');
    expect(accrual!.deviceAttestationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validate-before-burn at the HANDLER : a mangled paste must not
// consume the invite; the correct line stays single-use.
// ---------------------------------------------------------------------------

describe('validate-before-burn: the invite survives a mangled paste ', () => {
  const INVITE_TOKEN = 'c'.repeat(64);

  async function seedInvite(db: import('firebase-admin/firestore').Firestore) {
    await db.collection('setup_tokens').doc(INVITE_TOKEN).update({
      type: 'agent_device_registration',
      agent_wallet_id: AGENT_WALLET.id,
      used: false,
      created_at: Date.now(),
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    await db.collection('agent_wallets').doc(AGENT_WALLET.id).update(
      AGENT_WALLET as unknown as Record<string, unknown>,
    );
  }

  async function tokenState(db: import('firebase-admin/firestore').Firestore) {
    const snap = await db.collection('setup_tokens').doc(INVITE_TOKEN).get();
    return snap.data() as { used?: boolean } | undefined;
  }

  function pendingReq(body: Record<string, unknown>) {
    return makeReqRes({
      agentWallet: AGENT_WALLET,
      pendingDeviceSetupToken: { kind: 'agent_device_registration', token: INVITE_TOKEN },
      body,
    });
  }

  it('a malformed body 400s WITHOUT consuming the invite; the corrected re-paste succeeds and burns it', async () => {
    const { db, devices } = makeDb();
    await seedInvite(db);
    const handler = createRegisterDeviceHandler(makeDeps(db).deps);

    // The mangled paste: Authorization survived, device_name did not.
    const mangled = pendingReq({ ...VALID_BODY, device_name: undefined });
    await handler(mangled.req, mangled.res, () => {});
    expect(mangled.captured.statusCode).toBe(400);
    expect((await tokenState(db))?.used).toBe(false); // THE DECIDED PROPERTY
    expect(devices.size).toBe(0);

    // The corrected re-paste of the same line.
    const correct = pendingReq({ ...VALID_BODY });
    await handler(correct.req, correct.res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(correct.captured.statusCode).toBe(201);
    expect((await tokenState(db))?.used).toBe(true);
    expect(devices.size).toBe(1);
  });

  it('the correct line stays single-use: a different Idempotency-Key after the burn is refused', async () => {
    const { db, devices } = makeDb();
    await seedInvite(db);
    const handler = createRegisterDeviceHandler(makeDeps(db).deps);

    const first = pendingReq({ ...VALID_BODY });
    await handler(first.req, first.res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(first.captured.statusCode).toBe(201);
    expect(devices.size).toBe(1);

    // Re-use with a DIFFERENT registration id: the burn refuses, no second device.
    const reuse = pendingReq({ ...VALID_BODY, registration_id: 'device-handler-test-0002' });
    await handler(reuse.req, reuse.res, () => {});
    expect(reuse.captured.statusCode).toBe(401);
    expect(reuse.captured.body).toMatchObject({ error: 'Invalid or expired registration token' });
    expect(devices.size).toBe(1);

    // Re-running the SAME line idempotently replays instead of failing.
    const replay = pendingReq({ ...VALID_BODY, device_key: undefined, device_secret: undefined });
    await handler(replay.req, replay.res, () => {});
    await new Promise((r) => setImmediate(r));
    expect([201, 409]).toContain(replay.captured.statusCode);
    expect(devices.size).toBe(1);
  });
});
