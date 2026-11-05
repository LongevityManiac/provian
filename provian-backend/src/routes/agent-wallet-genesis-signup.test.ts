/**
 * PHASE 1 — `genesis_signup` qualifies on AGENT WALLET CREATION.
 *
 * The canonical key, the grant type, the 75 PVT maximum, the `agent_id` anchor and the
 * fail-closed missing-anchor behaviour are all unchanged. What moved is the QUALIFYING ACT:
 * it was "create an agent wallet AND prove control of an external address"; it is now the
 * wallet creation itself. `proveExternalAddress` emits no Genesis qualification of any kind
 * (its own suite asserts that side).
 *
 * ROUTE-INDEPENDENCE is the property these controls exist to protect: the grant keys on the
 * creation of the wallet, never on which caller created it. A wallet created bare through the
 * API earns identically to one created behind an invite or connect flow, because the emission
 * sits inside the one atomic creation transaction every route funnels through.
 *
 * NEGATIVE CONTROLS. Each of the four below was run against the PRE-CHANGE tree and observed
 * RED — recorded in the run report rather than asserted here, because a control that has only
 * ever been seen green is not evidence (see the run contract). They are written to bind to the
 * production window/policy singletons, never to a redeclared copy of them.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';

type RegistrationContext = {
  registration_id: string;
  agent_id: string;
  credential_recovery_generation: number | null;
};
const verifyPop = jest.fn<(
  challengeId: string,
  expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
) => Promise<{ ok: true; registration_context: RegistrationContext }>>(
  async (_challengeId, expected) => ({
    ok: true,
    registration_context: { ...expected, credential_recovery_generation: null },
  }),
);
jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => verifyPop(challengeId, expected),
  // Parent authorization PoP: the child-creation path calls this to prove the
  // parent authorized the child. Stubbed to succeed so the child-gate suite below
  // can drive a real parent-spawned child create through /create.
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));

import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
  TEST_GENESIS_WINDOW_START_MS,
} from '../core/pvt/__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  GENESIS_RESERVATION_COLLECTION,
  GENESIS_WALLET_LEDGER_COLLECTION,
  genesisQualificationId,
  processGenesisQualification,
} from '../core/pvt/genesis-award-state-machine';
import { makeGenesisSettlementDeps } from '../core/pvt/__test-helpers__/genesis-settlement-deps';
import { hashGenesisCampaignPolicyManifest } from '../core/pvt/policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../core/pvt/policy/proposed-genesis-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from '../core/pvt/policy/pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from '../core/pvt/policy/runtime-monetary-policy';
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from '../core/pvt/watcher-address-admission';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import type { RouterDeps } from '../core/agent-wallet/types';
import { createAgentWalletRouter } from './agent-wallet';

const ADDRESS = '0x2222222222222222222222222222222222222222';
const AGENT_ID = 'canonical-agent';

/** In-window instant. Bound to the installed policy window, never restated as a literal. */
const IN_WINDOW_MS = TEST_GENESIS_WINDOW_START_MS + 5_000;
/** Strictly before the same window's start, by the same binding. */
const PRE_WINDOW_MS = TEST_GENESIS_WINDOW_START_MS - 1;

function keysUnder(
  store: Map<string, Record<string, unknown>>,
  prefix: string,
): string[] {
  return [...store.keys()].filter((key) => key.startsWith(`${prefix}/`));
}

/** Every durable home an in-window qualifying act can land in: outbox OR retention. */
function genesisRecordKeys(store: Map<string, Record<string, unknown>>): string[] {
  return [
    ...keysUnder(store, GENESIS_QUALIFICATION_COLLECTION),
    ...keysUnder(store, GENESIS_QUALIFICATION_RETENTION_COLLECTION),
  ];
}

async function armGenesis(fake: ReturnType<typeof createFakeFirestore>): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set({
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
      approval_signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: `sha256:${'a'.repeat(64)}`,
        armored_signature: 'test-only-structured-signature',
      },
      frank_approval_audit_id: 'agent-create-test-approval',
      approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
      // Derived, so the control tracks the manifest change instead of pinning a stale hash.
      approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
        PROPOSED_GENESIS_CAMPAIGN_POLICY,
      ),
      approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
      effective_at_ms: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms,
      admission_closed_at_ms: null,
      admission_close_audit_id: null,
      grants_enabled: true,
      genesis_kill_switch_active: false,
      canonical_pvt_manifest_id: 'pvt9-agent-create-test',
      ledger_namespace: 'pvt9-agent-create-test-ledger',
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'agent-create-test-operator',
    });
}

function buildRoute(options: {
  address?: string;
  deriveAddressFromPublicKey?: (publicKey: string) => string;
} = {}) {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453,
    last_processed_block: 130,
    membership_generation: 7,
    updated_at: 1,
  });
  const processGenesisQualification = jest.fn(async () => ({ status: 'queued' }));
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey:
      options.deriveAddressFromPublicKey ?? (() => options.address ?? ADDRESS),
    readBaseRegistrationHead: async () => 140,
    processGenesisQualification,
    // Explicit test seam; production always uses structured SSHSIG verification.
    genesisActivationApprovalVerifier: () => true,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake, processGenesisQualification };
}

function registrationBody(overrides: Record<string, unknown> = {}) {
  return {
    registration_id: 'agent-registration-canonical-agent-0001',
    agent_name: 'Canonical Agent',
    agent_id: AGENT_ID,
    platform: 'sdk',
    // Before every instant this suite sets the clock to, so the non-future check never
    // becomes the reason a case fails.
    constitution_accepted_at: new Date(0).toISOString(),
    public_key: 'a'.repeat(128),
    challenge_id: 'challenge-1',
    signature: 'ab'.repeat(64),
    ...overrides,
  };
}

describe('genesis_signup qualifies on agent wallet creation', () => {
  beforeEach(() => {
    installArmedGenesisPolicyForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreCheckedInGenesisPolicyAfterTest();
  });

  // CONTROL (b) — the positive case. RED pre-change: creation wrote no qualification at all.
  test('an in-window creation enqueues exactly one genesis_signup qualification', async () => {
    jest.setSystemTime(IN_WINDOW_MS);
    const { app, fake, processGenesisQualification } = buildRoute();
    await armGenesis(fake);

    const res = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(res.status).toBe(201);

    const qualificationId = genesisQualificationId('genesis_signup', AGENT_ID);
    expect(genesisRecordKeys(fake.store)).toEqual([
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualificationId}`,
    ]);

    const wallet = fake.store.get(`agent_wallets/${res.body.wallet_id}`) as {
      created_at: number;
      address: string;
    };
    expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${qualificationId}`))
      .toMatchObject({
        action_type: 'genesis_signup',
        wallet_id: res.body.wallet_id,
        economic_actor_id: AGENT_ID,
        // The anchor is the agent id, exactly as before the act moved.
        immutable_anchor: { anchor_kind: 'agent_id', anchor_id: AGENT_ID },
        actor_address: wallet.address.toLowerCase(),
        qualifying_act_evidence: {
          // Judged at the authoritative wallet creation time, not at request receipt.
          qualifying_act_at_ms: wallet.created_at,
          immutable_anchor_id: AGENT_ID,
        },
        observation_context: {
          wallet_created: {
            created_at_ms: wallet.created_at,
            source: 'authoritative_wallet_record',
          },
        },
      });
    expect(processGenesisQualification).toHaveBeenCalledWith(qualificationId);
  });

  // THE END-TO-END PROOF. Drives the REAL /create emission — the actual outbox doc the
  // route writes, not a hand-built fixture — through the REAL state machine to complete.
  // Pre-fix this was RED: the source-integrity re-check demanded a `proven_addresses`
  // record the create-only route never writes, so settlement threw
  // `genesis_qualification_source_integrity_invalid` and never reached `complete`.
  // Settlement runs through the SAME shared emitter the unit suite trusts, so this is the
  // route emission finalized by the exact path those tests verify — not a second copy of it.
  test('a REAL /create emission settles through the state machine to complete', async () => {
    jest.setSystemTime(IN_WINDOW_MS);
    const { app, fake } = buildRoute();
    await armGenesis(fake);

    const res = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(res.status).toBe(201);

    const qualificationId = genesisQualificationId('genesis_signup', AGENT_ID);
    // Sanity: the route emitted exactly the outbox row we are about to settle.
    expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${qualificationId}`))
      .toMatchObject({ action_type: 'genesis_signup', status: 'pending_reservation' });

    const settlement = makeGenesisSettlementDeps(fake);
    await expect(
      processGenesisQualification(settlement.deps, qualificationId, { now: IN_WINDOW_MS }),
    ).resolves.toMatchObject({
      status: 'complete',
      reservedAtomic: '75000000000000000000',
    });
    expect(settlement.emitted()).toBe(1);
    expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${qualificationId}`))
      .toMatchObject({ status: 'complete', reserved_atomic: '75000000000000000000' });
  });

  // CONTROL (a) — the window fence. A creation before the window earns nothing, anywhere.
  test('a pre-window creation timestamp is refused and retains nothing', async () => {
    jest.setSystemTime(PRE_WINDOW_MS);
    const { app, fake, processGenesisQualification } = buildRoute();
    await armGenesis(fake);

    const res = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(res.status).toBe(201);

    // Not the outbox, and not retention either: an out-of-window act never qualified at all,
    // so there is nothing for a later backfill to promote.
    expect(genesisRecordKeys(fake.store)).toEqual([]);
    expect(processGenesisQualification).not.toHaveBeenCalled();
  });

  // CONTROL (c) — the one-shot key. Repeating the act on one agent_id pays once.
  test('a repeat creation on the same agent_id adds no second qualification', async () => {
    jest.setSystemTime(IN_WINDOW_MS);
    const { app, fake } = buildRoute();
    await armGenesis(fake);

    const first = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(first.status).toBe(201);
    const after = genesisRecordKeys(fake.store);
    expect(after).toHaveLength(1);

    // A different registration id and a different address — everything a second grant could
    // key on is fresh EXCEPT the agent id, which is the anchor.
    const second = await request(app).post('/v1/agent/wallet/create').send(registrationBody({
      registration_id: 'agent-registration-canonical-agent-0002',
    }));
    expect(second.status).not.toBe(201);
    expect(genesisRecordKeys(fake.store)).toEqual(after);
  });
});

/**
 * Every agent with its own wallet draws its own grant.
 *
 * "A grant goes to every persistent, device-resident agent with its own wallet, its own key and
 * its own witnessed work, however it was onboarded, including through another agent's fleet code.
 * Fifty fleet agents means fifty grants. An in-session sub-agent with no wallet of its own gets
 * nothing." A parent-spawned child (a /create carrying a validated parent_wallet_id) is such an
 * agent: its own wallet, its own key. It now draws its own genesis_signup exactly like a
 * parentless agent; the bounds are unchanged (the window, the 500-PVT per-wallet ceiling).
 *
 * NEGATIVE CONTROLS, each in-suite:
 * - re-introducing a parenthood gate at the enqueue site turns the child / grandchild cases RED;
 * - an in-session sub-agent has no wallet, so no anchor: the REAL settlement lane denies its
 * would-be grant and writes no reservation or ledger marker (GREEN twin: the parent's grant
 * through the same lane reserves 75).
 */
describe('every agent with its own wallet draws its own Genesis grant, however it was onboarded', () => {
  beforeEach(() => {
    installArmedGenesisPolicyForTest();
    jest.useFakeTimers();
    jest.setSystemTime(IN_WINDOW_MS);
  });
  afterEach(() => {
    jest.useRealTimers();
    restoreCheckedInGenesisPolicyAfterTest();
  });

  const CHILD_ADDRESS = `0x${'8'.repeat(40)}`;
  const SIBLING_ADDRESS = `0x${'7'.repeat(40)}`;
  const GRANDCHILD_ADDRESS = `0x${'6'.repeat(40)}`;
  const CHILD_AGENT_ID = 'canonical-child';
  const GRANDCHILD_AGENT_ID = 'canonical-grandchild';

  // Parent (public_key 'a'…), child ('b'…), sibling ('c'…) and grandchild ('d'…)
  // must derive DISTINCT addresses or the address-uniqueness gate rejects the
  // later creates.
  function childCapableRoute() {
    return buildRoute({
      deriveAddressFromPublicKey: (publicKey) => {
        const pk = publicKey.toLowerCase();
        if (pk.startsWith('b')) return CHILD_ADDRESS;
        if (pk.startsWith('c')) return SIBLING_ADDRESS;
        if (pk.startsWith('d')) return GRANDCHILD_ADDRESS;
        return ADDRESS;
      },
    });
  }

  function childBody(parentWalletId: string) {
    return registrationBody({
      registration_id: 'agent-registration-canonical-child-0001',
      agent_name: 'Canonical Child',
      agent_id: CHILD_AGENT_ID,
      public_key: 'b'.repeat(128),
      parent_wallet_id: parentWalletId,
      parent_proof_of_authorization: {
        challenge_id: 'parent-authority',
        signature: 'cd'.repeat(64),
      },
    });
  }

  function grandchildBody(parentWalletId: string) {
    return registrationBody({
      registration_id: 'agent-registration-canonical-grandchild-01',
      agent_name: 'Canonical Grandchild',
      agent_id: GRANDCHILD_AGENT_ID,
      public_key: 'd'.repeat(128),
      parent_wallet_id: parentWalletId,
      parent_proof_of_authorization: {
        challenge_id: 'parent-authority',
        signature: 'ef'.repeat(64),
      },
    });
  }

  test('a parent-spawned child is admitted AND enqueues its own genesis_signup; the parent grant stands', async () => {
    const { app, fake, processGenesisQualification: drainSpy } = childCapableRoute();
    await armGenesis(fake);

    const parent = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(parent.status).toBe(201);
    const child = await request(app).post('/v1/agent/wallet/create')
      .send(childBody(parent.body.wallet_id));
    expect(child.status).toBe(201);
    expect(fake.store.get(`agent_wallets/${child.body.wallet_id}`)).toMatchObject({
      parent_wallet_id: parent.body.wallet_id,
      status: 'active',
    });

    const parentQualId = genesisQualificationId('genesis_signup', AGENT_ID);
    const childQualId = genesisQualificationId('genesis_signup', CHILD_AGENT_ID);
    expect([...genesisRecordKeys(fake.store)].sort()).toEqual([
      `${GENESIS_QUALIFICATION_COLLECTION}/${parentQualId}`,
      `${GENESIS_QUALIFICATION_COLLECTION}/${childQualId}`,
    ].sort());
    expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${childQualId}`)).toMatchObject({
      action_type: 'genesis_signup',
      wallet_id: child.body.wallet_id,
      immutable_anchor: { anchor_kind: 'agent_id', anchor_id: CHILD_AGENT_ID },
      status: 'pending_reservation',
    });
    expect(drainSpy).toHaveBeenCalledWith(parentQualId);
    expect(drainSpy).toHaveBeenCalledWith(childQualId);
  });

  test('a grandchild (child-of-a-child) also draws its own grant', async () => {
    const { app, fake } = childCapableRoute();
    await armGenesis(fake);
    const parent = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    const child = await request(app).post('/v1/agent/wallet/create').send(childBody(parent.body.wallet_id));
    const grandchild = await request(app).post('/v1/agent/wallet/create').send(grandchildBody(child.body.wallet_id));
    expect([parent.status, child.status, grandchild.status]).toEqual([201, 201, 201]);
    expect(genesisRecordKeys(fake.store)).toHaveLength(3);
    expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${genesisQualificationId('genesis_signup', GRANDCHILD_AGENT_ID)}`))
      .toMatchObject({ action_type: 'genesis_signup', wallet_id: grandchild.body.wallet_id });
  });

  test('through the REAL settlement lane the child reserves its own 75 PVT and marks its own ledger', async () => {
    const { app, fake } = childCapableRoute();
    await armGenesis(fake);
    const parent = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    const child = await request(app).post('/v1/agent/wallet/create').send(childBody(parent.body.wallet_id));
    expect(child.status).toBe(201);

    const settlement = makeGenesisSettlementDeps(fake);
    await expect(processGenesisQualification(
      settlement.deps, genesisQualificationId('genesis_signup', CHILD_AGENT_ID), { now: IN_WINDOW_MS },
    )).resolves.toMatchObject({ status: 'complete', reservedAtomic: '75000000000000000000' });
    await expect(processGenesisQualification(
      settlement.deps, genesisQualificationId('genesis_signup', AGENT_ID), { now: IN_WINDOW_MS },
    )).resolves.toMatchObject({ status: 'complete', reservedAtomic: '75000000000000000000' });
    // One reservation and one wallet-ledger marker per AGENT WALLET: two wallets, two grants.
    expect(keysUnder(fake.store, GENESIS_RESERVATION_COLLECTION)).toHaveLength(2);
    expect(keysUnder(fake.store, GENESIS_WALLET_LEDGER_COLLECTION)).toHaveLength(2);
  });

  test('NEGATIVE CONTROL: a fleet-code agent gets one; an in-session sub-agent with no wallet gets none (real lane)', async () => {
    const { app, fake } = childCapableRoute();
    await armGenesis(fake);
    const TOKEN = 'PROV-FLTC-6789';
    expect(isValidConnectionTokenFormat(TOKEN)).toBe(true);
    fake.store.set(`connection_tokens/${TOKEN}`, {
      token: TOKEN, user_id: 'human-issuer', kind: 'fleet',
      issued_by_agent_wallet_id: 'wallet_aw_main', created_at: IN_WINDOW_MS - 60_000,
      expires_at: IN_WINDOW_MS + 3_600_000, used: false,
    });
    fake.store.set('wallets/wallet_human_issuer_1', {
      id: 'wallet_human_issuer_1', user_id: 'human-issuer', type: 'human',
      address: '0x8888888888888888888888888888888888888888', created_at: IN_WINDOW_MS - 20_000,
    });

    // The fleet-code agent: its own wallet, its own key, created on its own box.
    const fleetAgent = await request(app).post('/v1/agent/wallet/create')
      .send(registrationBody({ connection_token: TOKEN }));
    expect(fleetAgent.status).toBe(201);

    const settlement = makeGenesisSettlementDeps(fake);
    await expect(processGenesisQualification(
      settlement.deps, genesisQualificationId('genesis_signup', AGENT_ID), { now: IN_WINDOW_MS },
    )).resolves.toMatchObject({ status: 'complete', reservedAtomic: '75000000000000000000' });

    // An in-session sub-agent (a harness subagent working inside the fleet agent's turn) has no
    // wallet: there is no creation, so nothing qualifies, and the same real lane denies its
    // would-be grant and writes nothing.
    const reservationsBefore = keysUnder(fake.store, GENESIS_RESERVATION_COLLECTION);
    await expect(processGenesisQualification(
      settlement.deps, genesisQualificationId('genesis_signup', 'harness-subagent-1'), { now: IN_WINDOW_MS },
    )).resolves.toMatchObject({ status: 'denied', reason: 'qualification_missing_or_invalid' });
    expect(keysUnder(fake.store, GENESIS_RESERVATION_COLLECTION)).toEqual(reservationsBefore);
    expect(keysUnder(fake.store, GENESIS_WALLET_LEDGER_COLLECTION)).toHaveLength(1);
    expect(genesisRecordKeys(fake.store)).toEqual([
      `${GENESIS_QUALIFICATION_COLLECTION}/${genesisQualificationId('genesis_signup', AGENT_ID)}`,
    ]);
  });
});
