import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

import { countingFirestore } from './__test-helpers__/counting-firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_ADMISSION_EVENT_COLLECTION,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_RESERVATION_COLLECTION,
  GENESIS_TEST_PLATFORM_DENIAL,
  GENESIS_WALLET_LEDGER_COLLECTION,
  TEST_PLATFORM_VALUE,
  buildGenesisQualification,
  isTestPlatformWallet,
  closeGenesisAdmission,
  drainGenesisQualifications,
  processGenesisQualification,
  writeGenesisQualification,
  type GenesisStateMachineDeps,
} from './genesis-award-state-machine';
import {
  hashGenesisCampaignPolicyManifest,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';
import { hashRecordEconomicSnapshot } from './policy/monetary-accounting';
import { makeGenesisSettlementDeps } from './__test-helpers__/genesis-settlement-deps';
import { generatePE } from '../agent-bank/pe-utils';

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
const START = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms;
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function activation(): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'frank-signed-test-audit',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-test-manifest',
    ledger_namespace: 'pvt9-genesis-test-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-test-audit',
  };
}

function humanQualification(walletId = 'wallet-human-1') {
  return buildGenesisQualification({
    actionType: 'genesis_human_signup',
    walletId,
    economicActorId: `user:${walletId}`,
    actorAddress: '0x1111111111111111111111111111111111111111',
    immutableAnchorId: walletId,
    qualifyingActEvidenceId: `human-wallet:${walletId}`,
    qualifyingActAtMs: START,
    walletCreatedAtMs: START,
    walletCreatedEvidenceId: `human-wallet:${walletId}`,
  });
}

// emission shape, byte-for-byte what `routes/agent-wallet.ts` builds at
// `/create`: the qualifying act is the wallet creation itself, the actor is the
// agent's OWN native address, the evidence id is `agent-wallet:<walletId>`, and
// the one-time anchor is the agent id. No external proof is involved. The prior
// fixture carried a `proven-address:` evidence id and a separate proven address —
// the self-referential-control defect the run contract names, because it agreed
// with the RETIRED create-and-prove branch instead of the shape the route emits.
const AGENT_SIGNUP_NATIVE_ADDRESS = '0x3333333333333333333333333333333333333333';
function agentSignupQualification(walletId = 'wallet-agent-signup-1') {
  return buildGenesisQualification({
    actionType: 'genesis_signup',
    walletId,
    economicActorId: `agent:${walletId}`,
    actorAddress: AGENT_SIGNUP_NATIVE_ADDRESS,
    immutableAnchorId: `agent:${walletId}`,
    qualifyingActEvidenceId: `agent-wallet:${walletId}`,
    qualifyingActAtMs: START,
    walletCreatedAtMs: START,
    walletCreatedEvidenceId: `agent-wallet:${walletId}`,
  });
}

function agentDeviceQualification(walletId = 'wallet-agent-device-1') {
  const deviceId = `device:${walletId}`;
  return buildGenesisQualification({
    actionType: 'genesis_device_link',
    walletId,
    economicActorId: walletId,
    actorAddress: '0x4444444444444444444444444444444444444444',
    immutableAnchorId: deviceId,
    qualifyingActEvidenceId: `registered-device:${deviceId}`,
    qualifyingActAtMs: START,
    walletCreatedAtMs: START,
    walletCreatedEvidenceId: `agent-wallet:${walletId}`,
  });
}

// The single genesis settlement-deps double lives in the shared helper so the route
// end-to-end control settles a REAL /create emission through the same emitter these
// unit tests trust — never a second hand-rolled copy of it (self-referential rule).
function makeDeps(fake: FakeFirestore, options: {
  failAccrualOnce?: boolean;
  useRealActivationVerifier?: boolean;
} = {}) {
  return makeGenesisSettlementDeps(fake, options);
}

async function enqueueAct(
  fake: FakeFirestore,
  qualification = humanQualification(),
  walletOverrides: Record<string, unknown> = {},
): Promise<void> {
  const batch = fake.batch();
  // Optional `platform` override lets the RED control seed a `platform: 'test'`
  // flag on the SAME `wallets` doc the human source-integrity re-check reads and
  // the award-path guard now judges — the owner-type-correct collection for a
  // human leg. `platform` is not integrity-checked, so a valid human wallet can
  // still carry it.
  batch.set(fake.collection('wallets').doc(qualification.wallet_id), {
    id: qualification.wallet_id,
    type: 'human',
    user_id: qualification.economic_actor_id,
    address: qualification.actor_address,
    created_at: qualification.observation_context.wallet_created.created_at_ms,
    ...walletOverrides,
  });
  writeGenesisQualification(
    batch as unknown as FirebaseFirestore.WriteBatch,
    fake as unknown as Firestore,
    qualification,
  );
  await batch.commit();
}

// seed ONLY the authoritative agent_wallets record the source-integrity
// re-check reads — no `proven_addresses` doc, because create-only never proves an
// external address. The native address IS the actor address, and creation time IS
// the qualifying-act time. Optional `platform`/`address` overrides let the RED
// controls below construct violating inputs against the exact record the guard reads.
async function enqueueAgentSignupAct(
  fake: FakeFirestore,
  qualification = agentSignupQualification(),
  walletOverrides: Record<string, unknown> = {},
): Promise<void> {
  const batch = fake.batch();
  batch.set(fake.collection('agent_wallets').doc(qualification.wallet_id), {
    id: qualification.wallet_id,
    agent_id: qualification.economic_actor_id,
    address: qualification.actor_address,
    created_at: qualification.observation_context.wallet_created.created_at_ms,
    ...walletOverrides,
  });
  writeGenesisQualification(
    batch as unknown as FirebaseFirestore.WriteBatch,
    fake as unknown as Firestore,
    qualification,
  );
  await batch.commit();
}

async function enqueueAgentDeviceAct(
  fake: FakeFirestore,
  qualification = agentDeviceQualification(),
): Promise<void> {
  const deviceId = qualification.immutable_anchor.anchor_id;
  const batch = fake.batch();
  batch.set(fake.collection('agent_wallets').doc(qualification.wallet_id), {
    id: qualification.wallet_id,
    agent_id: `agent-owner:${qualification.wallet_id}`,
    address: qualification.actor_address,
    created_at: qualification.observation_context.wallet_created.created_at_ms,
  });
  batch.set(fake.collection('devices').doc(deviceId), {
    device_id: deviceId,
    owner_wallet_id: qualification.wallet_id,
    owner_user_id: qualification.economic_actor_id,
    owner_address: qualification.actor_address,
    owner_type: 'agent',
    created_at: qualification.qualifying_act_evidence.qualifying_act_at_ms,
  });
  writeGenesisQualification(
    batch as unknown as FirebaseFirestore.WriteBatch,
    fake as unknown as Firestore,
    qualification,
  );
  await batch.commit();
}

async function arm(fake: FakeFirestore): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set(activation() as unknown as Record<string, unknown>);
}

describe('atomic accounting crash-safe Genesis award state machine', () => {
  test('qualifying act and deterministic outbox can commit in one batch', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    expect(fake.store.has(`wallets/${qualification.wallet_id}`)).toBe(true);
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({
      pe_id: qualification.pe_id,
      status: 'pending_reservation',
      immutable_anchor: { anchor_kind: 'human_wallet_id' },
    });
  });

  test('stays pending with no signed PVT9 activation and reserves nothing', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    const { deps } = makeDeps(fake);
    const result = await processGenesisQualification(deps, qualification.qualification_id);
    expect(result).toMatchObject({
      status: 'pending_activation',
      reason: 'genesis_activation_missing',
      reservedAtomic: '0',
    });
    expect([...fake.store.keys()].some((key) => key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`)))
      .toBe(false);
  });

  test('rejects a syntactically valid but different approval manifest hash', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await fake.collection(GENESIS_ACTIVATION_COLLECTION)
      .doc(GENESIS_ACTIVATION_DOCUMENT)
      .set({
        ...activation(),
        approval_manifest_sha256: `sha256:${'f'.repeat(64)}`,
      });
    const { deps } = makeDeps(fake);
    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .resolves.toMatchObject({
        status: 'pending_activation',
        reason: 'formal_approval_manifest_hash_mismatch',
        reservedAtomic: '0',
      });
  });

  test('the current corrections-pending digest cannot authorize a reservation', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const { deps } = makeDeps(fake, { useRealActivationVerifier: true });

    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .resolves.toMatchObject({
        status: 'pending_activation',
        reason: 'genesis_activation_proposal_not_approved',
        reservedAtomic: '0',
      });
    expect([...fake.store.keys()].some(
      (key) => key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`),
    )).toBe(false);
  });

  test('the current Gate 1-approved non-signable digest cannot authorize close or recovery', async () => {
    const fake = createFakeFirestore();
    await arm(fake);
    await expect(closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: 'current-digest-close-audit',
      closedBy: 'operator-test',
      now: START,
    })).rejects.toThrow('genesis_admission_close_rejected:proposal_not_approved');

    const { deps } = makeDeps(fake, { useRealActivationVerifier: true });
    await expect(drainGenesisQualifications(deps, { now: START }))
      .rejects.toThrow('genesis_recovery_activation_not_approved');
    expect([...fake.store.keys()].some(
      (key) => key.startsWith(`${GENESIS_ADMISSION_EVENT_COLLECTION}/`),
    )).toBe(false);
  });

  test('runs exact 75 PVT gross and bypasses linked-agent beneficiary routing', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const result = await processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
    );
    expect(result).toMatchObject({
      status: 'complete',
      reservedAtomic: '75000000000000000000',
      peId: qualification.pe_id,
    });
    const outbox = fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    );
    expect(outbox).toMatchObject({ status: 'complete', reserved_atomic: '75000000000000000000' });
    expect(
      (outbox?.economic_snapshot as {
        economicActorId: string;
        recordTimeFactors: { beneficiaryAgentShareBps: number };
      }).recordTimeFactors.beneficiaryAgentShareBps,
    ).toBe(10_000);
    expect((outbox?.economic_snapshot as { economicActorId: string }).economicActorId)
      .toBe(qualification.economic_actor_id);
    expect(harness.emitted()).toBe(1);
  });

  test.each([
    {
      label: 'human signup',
      build: () => humanQualification('wallet-fixed-kernel-human'),
      enqueue: enqueueAct,
      expectedAtomic: '75000000000000000000',
    },
    {
      label: 'agent signup',
      build: () => agentSignupQualification('wallet-fixed-kernel-agent'),
      enqueue: enqueueAgentSignupAct,
      expectedAtomic: '75000000000000000000',
    },
    {
      label: 'device link',
      build: () => agentDeviceQualification('wallet-fixed-kernel-device'),
      enqueue: enqueueAgentDeviceAct,
      expectedAtomic: '25000000000000000000',
    },
  ])('$label preserves its exact reservation for the PVT9 settlement kernel', async ({
    build,
    enqueue,
    expectedAtomic,
  }) => {
    const fake = createFakeFirestore();
    const qualification = build();
    await enqueue(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete', reservedAtomic: expectedAtomic });
    const outbox = fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    );
    const snapshot = outbox?.economic_snapshot;
    expect(snapshot).toMatchObject({
      economicActorId: qualification.economic_actor_id,
      recordPointsAtomic: expectedAtomic,
      recordTimeFactors: {
        fixedGrantSource: 'genesis_campaign_reservation',
        fixedGrantAtomic: expectedAtomic,
      },
    });
    expect(outbox).toMatchObject({
      status: 'complete',
      reserved_atomic: expectedAtomic,
      economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot as never),
    });
  });

  // the money-layer pricing bump widened the economic-snapshot binding gate
  // in isQualificationEconomicSnapshotBound from {v1} to {v1, v2} — a Genesis fixed
  // grant is never multiplied, so its recordCalculation (numerator=grant,
  // denominator=1) is identical under both schemas and each reconciles. This RED
  // control proves the widening did NOT open the gate to "any version": a completed
  // reservation whose sealed snapshot is relabeled to an UNSUPPORTED schema (its
  // hash re-sealed so ONLY the schemaVersion conjunct is under test) is denied at
  // isQualification with reason `qualification_missing_or_invalid`. The v2 case
  // (the supported current version) reconciles, proving the relabel+rehash
  // mechanism is sound — so the rejections below are specifically the schemaVersion
  // gate firing, not a side effect. (v1 is likewise accepted at this gate: a
  // v1 relabel gets PAST isQualification and fails only later, at the reservation
  // cross-integrity check, because this single-copy relabel does not also touch the
  // linked reservation snapshot — a test artifact downstream of the gate.)
  test.each([
    ['pvt-monetary-accounting/v1', false],
    ['pvt-monetary-accounting/v2', false],
    ['pvt-monetary-accounting/v3', false],
    ['pvt-monetary-accounting/v4', true],
    ['not-a-schema', true],
  ] as const)(' RED: a completed reservation whose economic_snapshot schema is %s → gate-rejected=%s on replay', async (schemaVersion, expectRejected) => {
    const fake = createFakeFirestore();
    const suffix = schemaVersion.replace(/[^a-z0-9]/gi, '-');
    const qualification = humanQualification(`wallet-schema-${suffix}`);
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });

    // Relabel the sealed snapshot's schema version and RE-SEAL its hash, so the hash
    // conjunct still holds and the schemaVersion conjunct alone decides the verdict.
    const key = `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`;
    const stored = fake.store.get(key)!;
    const relabeled = { ...(stored.economic_snapshot as Record<string, unknown>), schemaVersion };
    fake.store.set(key, {
      ...stored,
      economic_snapshot: relabeled,
      economic_snapshot_hash: hashRecordEconomicSnapshot(relabeled as never),
    });

    if (!expectRejected) {
      const oldHash=stored.economic_snapshot_hash;
      const newHash=hashRecordEconomicSnapshot(relabeled as never);
      const rebind=(value:unknown):unknown=>{
        if (value===oldHash) return newHash;
        if (Array.isArray(value))return value.map(rebind);
        if (!value || typeof value!=='object')return value;
        const r=value as Record<string,unknown>;
        if (r.schemaVersion===(stored.economic_snapshot as Record<string,unknown>).schemaVersion)return {...r,schemaVersion};
        return Object.fromEntries(Object.entries(r).map(([k,v])=>[k,rebind(v)]));
      };
      for(const [path,row] of fake.store)fake.store.set(path,rebind(row) as Record<string,unknown>);
    }
    const replay = await processGenesisQualification(harness.deps, qualification.qualification_id);
    if (expectRejected) {
      expect(replay).toMatchObject({ status: 'denied', reason: 'qualification_missing_or_invalid' });
    } else {
      expect(replay).toMatchObject({ status: 'complete' });
    }
  });

  test.each([
    ['source wallet', (store: Map<string, Record<string, unknown>>, qualification: ReturnType<typeof humanQualification>) => {
      store.delete(`wallets/${qualification.wallet_id}`);
    }],
    ['reservation', (store: Map<string, Record<string, unknown>>) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))!;
      store.delete(key);
    }],
    ['wallet ledger', (store: Map<string, Record<string, unknown>>) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${GENESIS_WALLET_LEDGER_COLLECTION}/`))!;
      store.delete(key);
    }],
    ['activation', (store: Map<string, Record<string, unknown>>) => {
      store.delete(`${GENESIS_ACTIVATION_COLLECTION}/${GENESIS_ACTIVATION_DOCUMENT}`);
    }],
    ['provenance envelope', (
      store: Map<string, Record<string, unknown>>,
      qualification: ReturnType<typeof humanQualification>,
    ) => {
      store.delete(`provenance_envelopes/${qualification.pe_id}`);
    }],
    ['pe_history acknowledgement', (
      store: Map<string, Record<string, unknown>>,
      qualification: ReturnType<typeof humanQualification>,
    ) => {
      store.delete(`pe_history/${qualification.pe_id}`);
    }],
  ])('a completed replay revalidates its authoritative %s dependency', async (_label, mutate) => {
    const fake = createFakeFirestore();
    const qualification = humanQualification(`wallet-complete-replay-${_label.replace(/\s+/g, '-')}`);
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });
    mutate(fake.store, qualification);
    const operationsBeforeReplay = [...fake.ops];

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow();
    expect(fake.ops).toEqual(operationsBeforeReplay);
    expect(harness.emitted()).toBe(1);
  });

  // an agent signup qualifies on WALLET CREATION and settles to complete when
  // rebound to the create-only agent_wallets record — no external proof. Pre-fix, the
  // source-integrity re-check demanded a `proven_addresses` doc the route never writes,
  // so this same shape threw `genesis_qualification_source_integrity_invalid` (RED).
  test('settles an agent signup that qualified on wallet creation, rebinding the native record', async () => {
    const fake = createFakeFirestore();
    const qualification = agentSignupQualification();
    await enqueueAgentSignupAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({
        status: 'complete',
        reservedAtomic: '75000000000000000000',
      });
    expect(harness.emitted()).toBe(1);
  });

  // RED negative control for the source-integrity branch: the ONLY thing wrong is
  // the native address on the authoritative record — it no longer equals the actor
  // address the qualification was sealed with. A guard that had degenerated to "any
  // agent_wallets doc admits" would pass this; the real one fails closed by name.
  test('RED: an agent signup whose native address diverges from the actor address is refused', async () => {
    const fake = createFakeFirestore();
    const qualification = agentSignupQualification('wallet-agent-signup-divergent');
    await enqueueAgentSignupAct(fake, qualification, {
      address: '0x5555555555555555555555555555555555555555',
    });
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow('genesis_qualification_source_integrity_invalid');
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(false);
    expect(harness.emitted()).toBe(0);
  });

  // The platform:test gate sits AFTER source integrity in the award transaction.
  // Pre-fix, a genesis_signup threw at source integrity (missing proof) before the gate
  // could run, so the gate was unreachable on this path. Now it executes: a test agent
  // wallet is denied BY NAME on the genesis_signup path, not merely on the human path.
  test('RED: a platform:test agent signup is refused by the gate on THIS path', async () => {
    const fake = createFakeFirestore();
    const qualification = agentSignupQualification('wallet-agent-signup-testplatform');
    await enqueueAgentSignupAct(fake, qualification, { platform: TEST_PLATFORM_VALUE });
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({
        status: 'denied',
        reason: GENESIS_TEST_PLATFORM_DENIAL,
        reservedAtomic: '0',
      });
    // Refusal is durable and named, and no reservation or PE was produced.
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(false);
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    expect(harness.emitted()).toBe(0);
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'denied', denial_reason: GENESIS_TEST_PLATFORM_DENIAL });
  });

  test('binds an agent device grant to its wallet-id economic actor', async () => {
    const fake = createFakeFirestore();
    const qualification = agentDeviceQualification();
    await enqueueAgentDeviceAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({
        status: 'complete',
        reservedAtomic: '25000000000000000000',
      });
    expect(harness.emitted()).toBe(1);
  });

  test('a config close preserves a qualifying act durably queued at the cutoff', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-close-boundary');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const close = await closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: 'close-test-audit',
      closedBy: 'operator-test',
      now: START,
      approvalVerifier: () => true,
    });
    expect(close).toMatchObject({ idempotent: false, cutoffAtMs: START });
    expect([...fake.store.keys()].filter(
      (key) => key.startsWith(`${GENESIS_ADMISSION_EVENT_COLLECTION}/`),
    )).toHaveLength(1);
    expect(fake.store.get(
      `${GENESIS_ACTIVATION_COLLECTION}/${GENESIS_ACTIVATION_DOCUMENT}`,
    )).toMatchObject({
      grants_enabled: false,
      genesis_kill_switch_active: false,
      admission_closed_at_ms: START,
    });
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
      { now: START + 86_400_000 },
    )).resolves.toMatchObject({
      status: 'complete',
      reservedAtomic: '75000000000000000000',
    });
    expect(harness.emitted()).toBe(1);
  });

  test.each([
    ['unknown field', (event: Record<string, unknown>) => ({ ...event, unexpected: true })],
    ['schema', (event: Record<string, unknown>) => ({ ...event, schema_version: 'wrong' })],
    ['event identity', (event: Record<string, unknown>) => ({ ...event, event_id: 'wrong' })],
    ['cutoff', (event: Record<string, unknown>) => ({
      ...event,
      cutoff_at_ms: (event.cutoff_at_ms as number) + 1,
    })],
    ['prior activation hash', (event: Record<string, unknown>) => ({
      ...event,
      prior_activation_sha256: `sha256:${hash('wrong-prior')}`,
    })],
    ['closed activation hash', (event: Record<string, unknown>) => ({
      ...event,
      closed_activation_sha256: `sha256:${hash('wrong-closed')}`,
    })],
    ['recorded timestamp', (event: Record<string, unknown>) => ({
      ...event,
      recorded_at_ms: (event.recorded_at_ms as number) + 1,
    })],
    ['preservation verdict', (event: Record<string, unknown>) => ({
      ...event,
      preserves_pre_cutoff_outboxes: false,
    })],
  ])('an idempotent close rejects a corrupted %s', async (_label, mutate) => {
    const fake = createFakeFirestore();
    await arm(fake);
    const auditId = `close-integrity-${_label.replace(/\s+/g, '-')}`;
    const close = await closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: auditId,
      closedBy: 'operator-test',
      now: START,
      approvalVerifier: () => true,
    });
    const eventKey = `${GENESIS_ADMISSION_EVENT_COLLECTION}/${close.eventId}`;
    fake.store.set(eventKey, mutate(fake.store.get(eventKey)!));

    await expect(closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: auditId,
      closedBy: 'operator-test',
      now: START + 1,
      approvalVerifier: () => true,
    })).rejects.toThrow('genesis_admission_already_closed_with_different_event');
  });

  test('resumes after a crash immediately following the reservation commit', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: { afterReservation: () => { throw new Error('crash-after-reservation'); } },
    })).rejects.toThrow('crash-after-reservation');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )?.status).toBe('reserved');
    expect(harness.emitted()).toBe(0);

    const resumed = await processGenesisQualification(harness.deps, qualification.qualification_id);
    expect(resumed.status).toBe('complete');
    expect(harness.emitted()).toBe(1);
    const ledger = [...fake.store.entries()].find(
      ([key]) => key.startsWith(`${GENESIS_WALLET_LEDGER_COLLECTION}/`),
    )?.[1];
    expect(ledger).toMatchObject({ revision: '1', total_reserved_atomic: '75000000000000000000' });
  });

  // F-A1-1 — the scheduled DRAIN re-drives a grant stranded by an instance
  // reclaim. Simulates the exact sweep scenario: the fire-and-forget advance
  // dies after the reservation commit (a Cloud Run instance reclaimed after
  // res.send), leaving the row at 'reserved' — which the settlement inlet
  // (status=='complete' only) never selects, so it mints 0 forever. The drain
  // (now scheduled via provian-genesis-drain) drives it to complete and mints.
  test('F-A1-1: drainGenesisQualifications re-drives a row stranded mid-state to complete (75 PVT)', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    // Instance reclaim during the fire-and-forget advance: crash after reservation.
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: { afterReservation: () => { throw new Error('instance-reclaim'); } },
    })).rejects.toThrow('instance-reclaim');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )?.status).toBe('reserved'); // stranded — not 'complete', so the inlet never mints it

    // The scheduled drain re-drives the stranded row.
    const results = await drainGenesisQualifications(harness.deps, { now: START + 1 });
    expect(results.some((r) => r.status === 'complete')).toBe(true);
    const outbox = fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    );
    expect(outbox).toMatchObject({ status: 'complete', reserved_atomic: '75000000000000000000' });
    expect(harness.emitted()).toBe(1);
  });

  test('the drain reads only stranded rows, not every Genesis row ever recorded', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: { afterReservation: () => { throw new Error('instance-reclaim'); } },
    })).rejects.toThrow('instance-reclaim');
    // 300 settled rows from history that a drain has nothing to do with.
    for (let i = 0; i < 300; i += 1) {
      const id = `settled-${String(i).padStart(4, '0')}`;
      fake.store.set(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`, { qualification_id: id, status: i % 2 ? 'complete' : 'denied' });
    }
    const counting = countingFirestore(fake as unknown as Firestore, GENESIS_QUALIFICATION_COLLECTION);
    const drained: string[] = [];
    await drainGenesisQualifications({ ...harness.deps, db: counting.db } as typeof harness.deps, {
      now: START + 1,
      processQualification: (async (_deps: unknown, id: string) => { drained.push(id); return { qualificationId: id, status: 'complete' }; }) as unknown as typeof processGenesisQualification,
    });
    expect(drained).toEqual([qualification.qualification_id]);
    // NEGATIVE CONTROL: the pre- full scan read all 301 rows here.
    expect(counting.docsRead()).toBe(1);
  });

  test.each([
    ['persisted reservation schema', (
      store: Map<string, Record<string, unknown>>,
    ) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))!;
      store.set(key, { ...store.get(key)!, unexpected: true });
    }],
    ['persisted reservation identity', (
      store: Map<string, Record<string, unknown>>,
    ) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))!;
      store.set(key, { ...store.get(key)!, qualification_id: 'gq_wrong' });
    }],
    ['wallet-ledger replay entry', (
      store: Map<string, Record<string, unknown>>,
    ) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${GENESIS_WALLET_LEDGER_COLLECTION}/`))!;
      const ledger = store.get(key)!;
      const entries = ledger.reservations_by_dedupe_key as Record<string, Record<string, unknown>>;
      const [dedupeKey, entry] = Object.entries(entries)[0];
      store.set(key, {
        ...ledger,
        reservations_by_dedupe_key: {
          [dedupeKey]: { ...entry, unexpected: true },
        },
      });
    }],
  ])('malformed %s remains economically fenced during crash recovery', async (
    _label,
    mutate,
  ) => {
    const fake = createFakeFirestore();
    const qualification = humanQualification(`wallet-integrity-${_label.replace(/\s+/g, '-')}`);
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
      { hooks: { afterReservation: () => { throw new Error('crash-after-reservation'); } } },
    )).rejects.toThrow('crash-after-reservation');
    mutate(fake.store);

    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
    )).rejects.toThrow('genesis_reservation_integrity_invalid');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'reserved' });
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    expect(fake.store.get(`pe_history/${qualification.pe_id}`)).toBeUndefined();
  });

  test('a reservation corrupted after validation is blocked inside the PE transaction', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-precondition-race');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
      {
        hooks: {
          afterReservation: () => {
            const key = [...fake.store.keys()].find((candidate) =>
              candidate.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))!;
            fake.store.set(key, { ...fake.store.get(key)!, unexpected: true });
          },
        },
      },
    )).rejects.toThrow('genesis_reservation_integrity_invalid');
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    expect(fake.store.get(`pe_history/${qualification.pe_id}`)).toBeUndefined();
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'reserved' });
  });

  test('a complete qualification whose grant has minted replays as complete (follow-up)', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-minted-replay');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const first = await processGenesisQualification(harness.deps, qualification.qualification_id);
    expect(first.status).toBe('complete');
    // Settlement lands the grant on-chain.
    const historyKey = `pe_history/${qualification.pe_id}`;
    fake.store.set(historyKey, { ...fake.store.get(historyKey)!, mint_status: 'minted' });
    const before = JSON.stringify([...fake.store.entries()]);

    const replay = await processGenesisQualification(harness.deps, qualification.qualification_id);
    expect(replay.status).toBe('complete');
    expect(JSON.stringify([...fake.store.entries()])).toBe(before); // the replay writes nothing
  });

  test('RED: a minted row never completes a qualification that was not already complete', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-minted-early');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
      {
        hooks: {
          afterPERecorded: () => {
            const key = `pe_history/${qualification.pe_id}`;
            fake.store.set(key, { ...fake.store.get(key)!, mint_status: 'minted' });
          },
        },
      },
    )).rejects.toThrow('Genesis pe_history acknowledgement is missing or mismatched');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'pe_recorded' });
  });

  test('RED: a complete qualification still refuses any other drifted status', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-complete-drift');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    expect((await processGenesisQualification(harness.deps, qualification.qualification_id)).status)
      .toBe('complete');
    const historyKey = `pe_history/${qualification.pe_id}`;
    fake.store.set(historyKey, { ...fake.store.get(historyKey)!, mint_status: 'record_only' });
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow('Genesis pe_history acknowledgement is missing or mismatched');
  });

  test('finalization transaction rejects a changed pe_history acknowledgement', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-history-race');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(
      harness.deps,
      qualification.qualification_id,
      {
        hooks: {
          afterPERecorded: () => {
            const key = `pe_history/${qualification.pe_id}`;
            fake.store.set(key, { ...fake.store.get(key)!, record_points_atomic: '1' });
          },
        },
      },
    )).rejects.toThrow('Genesis pe_history acknowledgement is missing or mismatched');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'pe_recorded' });
    const reservation = [...fake.store.entries()].find(([key]) =>
      key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))?.[1];
    expect(reservation).toMatchObject({ state: 'pe_recorded' });
  });

  test.each([
    ['wallet binding', (pe: Record<string, unknown>) => ({ ...pe, wallet_id: 'wallet-rewritten' })],
    ['actor binding', (pe: Record<string, unknown>) => ({
      ...pe,
      actor_address: '0x2222222222222222222222222222222222222222',
    })],
    ['timestamp binding', (pe: Record<string, unknown>) => ({
      ...pe,
      timestamp: (pe.timestamp as number) + 1,
    })],
    ['chain binding', (pe: Record<string, unknown>) => ({ ...pe, prev_hash: hash('rewritten-prev') })],
    ['metadata schema', (pe: Record<string, unknown>) => ({
      ...pe,
      metadata: { ...(pe.metadata as Record<string, unknown>), unexpected: true },
    })],
    ['content hash', (pe: Record<string, unknown>) => ({ ...pe, hash: hash('rewritten-hash') })],
  ])('%s rewrite of a recorded Genesis PE cannot recover', async (_label, mutate) => {
    const fake = createFakeFirestore();
    const qualification = humanQualification(`wallet-pe-binding-${_label.replace(/\s+/g, '-')}`);
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: { afterPERecorded: () => { throw new Error('crash-after-pe'); } },
    })).rejects.toThrow('crash-after-pe');

    const peKey = `provenance_envelopes/${qualification.pe_id}`;
    fake.store.set(peKey, mutate(fake.store.get(peKey)!));
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow('genesis_pe_integrity_invalid');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'pe_recorded' });
    const reservation = [...fake.store.entries()].find(([key]) =>
      key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))?.[1];
    expect(reservation).toMatchObject({ state: 'pe_recorded' });
    expect(harness.accrualCalls()).toBe(1);
  });

  // addendum. The fake emitter above hand-copies the stored PE shape, so when the Trust
  // Layer build (e6803336) added `witness_class` / `witnessed_at_ms` to what the PRODUCTION
  // `generatePE` writes, this suite stayed green while every live Genesis grant from 2026-09-16
  // stuck at `pe_recorded` on `genesis_pe_integrity_invalid`. This test binds to the real writer.
  // In production a Genesis grant is never a chain's first PE (the wallet-created PE precedes
  // it), so the chain tip is a real hash, not the `genesis` sentinel. Seal that prior PE with
  // the same production writer.
  async function sealPriorPE(
    deps: GenesisStateMachineDeps,
    qualification: ReturnType<typeof humanQualification>,
  ): Promise<void> {
    await generatePE(deps, {
      walletId: qualification.wallet_id,
      agentId: qualification.economic_actor_id,
      actorAddress: qualification.actor_address,
      actionType: 'wallet_created',
      metadata: {},
      timestampOverride: qualification.observation_context.observed_at_ms - 1_000,
      awaitAccrual: true,
    });
  }

  test('a Genesis PE sealed by the production generatePE completes', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-production-generate-pe');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const deps: GenesisStateMachineDeps = { ...harness.deps, emitGenesisPE: undefined };
    await sealPriorPE(deps, qualification);

    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });
    // Non-vacuous, PE METER: no envelope is kept; the act key the outbox's pe_hash names is the
    // acknowledgement, it carries no legs (the grant settles only on the Genesis lane) and no TTL
    // until the grant mints.
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    const outbox = fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`)!;
    const key = fake.store.get(`meter_act_keys_v1/${qualification.pe_id}`)!;
    expect(key.pe_hash).toBe(outbox.pe_hash);
    expect(key.legs).toBeNull();
    expect(key.expire_at).toBeNull();
    expect(harness.emitted()).toBe(0);
  });

  const tamperKey: Array<[string, (key: Record<string, unknown>) => Record<string, unknown>]> = [
    ['a different PE hash', (key) => ({ ...key, pe_hash: 'f'.repeat(64) })],
    ['a different prev hash', (key) => ({ ...key, prev_hash: 'e'.repeat(64) })],
    ['a different actor', (key) => ({ ...key, actor_id: 'someone_else' })],
    ['a different occurrence time', (key) => ({ ...key, timestamp: (key.timestamp as number) + 1 })],
    ['standard-lane legs on a Genesis grant', (key) => ({ ...key, legs: [{ leg: 'sole' }] })],
    ['a row that is not a Genesis grant', (key) => ({ ...key, row: { ...(key.row as Record<string, unknown>), is_genesis_grant: false } })],
    ['a different reserved amount', (key) => ({ ...key, row: { ...(key.row as Record<string, unknown>), record_points_atomic: '1' } })],
  ];
  test.each(tamperKey)('an act key with %s cannot complete a production-sealed Genesis grant', async (_label, mutate) => {
    const fake = createFakeFirestore();
    const qualification = humanQualification(`wallet-key-${_label.replace(/\s+/g, '-')}`);
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const deps: GenesisStateMachineDeps = { ...harness.deps, emitGenesisPE: undefined };
    await sealPriorPE(deps, qualification);
    await expect(processGenesisQualification(deps, qualification.qualification_id, {
      hooks: { afterPERecorded: () => { throw new Error('crash-after-pe'); } },
    })).rejects.toThrow('crash-after-pe');

    const keyPath = `meter_act_keys_v1/${qualification.pe_id}`;
    const sealed = fake.store.get(keyPath)!;
    expect(sealed.pe_hash).toBeDefined();
    fake.store.set(keyPath, mutate(sealed));
    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .rejects.toThrow('Genesis pe_history acknowledgement is missing or mismatched');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'pe_recorded' });
  });

  test('a staged relay intake that does not name the grant cannot resume', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-intake-tamper');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const deps: GenesisStateMachineDeps = { ...harness.deps, emitGenesisPE: undefined };
    await sealPriorPE(deps, qualification);
    await expect(processGenesisQualification(deps, qualification.qualification_id, {
      hooks: { afterPERecorded: () => { throw new Error('crash-after-pe'); } },
    })).rejects.toThrow('crash-after-pe');
    const intakePath = `meter_relay_acts_v1/${qualification.pe_id}`;
    const intake = fake.store.get(intakePath)!;
    expect(intake).toBeDefined();
    fake.store.set(intakePath, { ...intake, act: { ...(intake.act as Record<string, unknown>), pe_hash: 'f'.repeat(64) } });
    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .rejects.toThrow('genesis_pe_integrity_invalid');
  });

  test('a completed grant whose records are all retired replays as complete and writes nothing', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-retired-replay');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });
    fake.store.delete(`provenance_envelopes/${qualification.pe_id}`);
    fake.store.delete(`pe_history/${qualification.pe_id}`);
    const operationsBeforeReplay = [...fake.ops];
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });
    expect(fake.ops.slice(operationsBeforeReplay.length)).toEqual([]);
  });

  test('a qualification cannot reserve after its authoritative wallet identity changes', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-source-before-reservation');
    await enqueueAct(fake, qualification);
    await arm(fake);
    fake.store.set(`wallets/${qualification.wallet_id}`, {
      ...fake.store.get(`wallets/${qualification.wallet_id}`)!,
      address: '0x2222222222222222222222222222222222222222',
    });
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow('genesis_qualification_source_integrity_invalid');
    expect([...fake.store.keys()].some(
      (key) => key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`),
    )).toBe(false);
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
  });

  test('a source rewrite after reservation is blocked inside the PE transaction', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-source-after-reservation');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);

    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: {
        afterReservation: () => {
          fake.store.set(`wallets/${qualification.wallet_id}`, {
            ...fake.store.get(`wallets/${qualification.wallet_id}`)!,
            address: '0x2222222222222222222222222222222222222222',
          });
        },
      },
    })).rejects.toThrow('genesis_qualification_source_integrity_invalid');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'reserved' });
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    expect(fake.store.get(`pe_history/${qualification.pe_id}`)).toBeUndefined();
  });

  test('an oversized emission error remains parseable and recovery succeeds', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-long-emission-error');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    const delegate = harness.deps.emitGenesisPE!;
    let failOnce = true;
    const deps: GenesisStateMachineDeps = {
      ...harness.deps,
      emitGenesisPE: async (...args) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('x'.repeat(3_000));
        }
        return delegate(...args);
      },
    };

    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .rejects.toThrow('x'.repeat(3_000));
    const afterFailure = fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    );
    expect(afterFailure).toMatchObject({ status: 'reserved' });
    expect((afterFailure?.last_error as string)).toHaveLength(2_000);

    await expect(processGenesisQualification(deps, qualification.qualification_id))
      .resolves.toMatchObject({ status: 'complete' });
    expect(harness.emitted()).toBe(1);
  });

  test('a reserved qualification cannot recover after activation approval becomes invalid', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-recovery-signature-fence');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const approvedHarness = makeDeps(fake);
    await expect(processGenesisQualification(
      approvedHarness.deps,
      qualification.qualification_id,
      { hooks: { afterReservation: () => { throw new Error('crash-after-reservation'); } } },
    )).rejects.toThrow('crash-after-reservation');
    expect(approvedHarness.emitted()).toBe(0);

    const rejectedDeps: GenesisStateMachineDeps = {
      ...approvedHarness.deps,
      verifyGenesisActivationApproval: () => false,
    };
    await expect(processGenesisQualification(
      rejectedDeps,
      qualification.qualification_id,
    )).resolves.toMatchObject({
      status: 'pending_activation',
      reason: 'genesis_activation_proposal_not_approved',
    });
    await expect(drainGenesisQualifications(rejectedDeps, { now: START + 1 }))
      .rejects.toThrow('genesis_recovery_activation_not_approved');
    expect(approvedHarness.emitted()).toBe(0);
  });

  test('resumes after PE commit without emitting or reserving twice', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake);
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id, {
      hooks: { afterPERecorded: () => { throw new Error('crash-after-pe'); } },
    })).rejects.toThrow('crash-after-pe');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )?.status).toBe('pe_recorded');
    expect(harness.emitted()).toBe(1);

    const resumed = await processGenesisQualification(harness.deps, qualification.qualification_id);
    expect(resumed.status).toBe('complete');
    expect(harness.emitted()).toBe(1);
    expect([...fake.store.keys()].filter(
      (key) => key.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`),
    )).toHaveLength(1);
  });

  test('an accrual failure after atomic PE emission remains pe_recorded and retries safely', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification();
    await enqueueAct(fake, qualification);
    await arm(fake);
    const harness = makeDeps(fake, { failAccrualOnce: true });
    await expect(processGenesisQualification(harness.deps, qualification.qualification_id))
      .rejects.toThrow('injected accrual failure');
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )?.status).toBe('pe_recorded');
    expect(harness.emitted()).toBe(1);

    const resumed = await processGenesisQualification(harness.deps, qualification.qualification_id);
    expect(resumed.status).toBe('complete');
    expect(harness.emitted()).toBe(1);
    expect(harness.accrualCalls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// / WS5 — the Genesis award path filters `platform: 'test'` like the other
// seven economic surfaces, from the OWNER-TYPE-CORRECT collection: `wallets` for
// a human leg, `agent_wallets` for an agent leg. The prior guard read a hardcoded
// `agent_wallets` doc, so a `platform: 'test'` HUMAN wallet — whose id lives in
// `wallets`, never `agent_wallets` — was never denied (how `0x903c` reserved
// 75 PVT). Both RED controls seed the flag on the SAME record the source-integrity
// re-check validates, so each proves the guard reads the correct collection.
// Every assertion binds to the module's OWN constants (`TEST_PLATFORM_VALUE`,
// `GENESIS_TEST_PLATFORM_DENIAL`), never a re-typed 'test' literal.
// ---------------------------------------------------------------------------
describe(' Genesis award path excludes platform:test wallets', () => {
  // THE GREEN BASELINE. Without this the RED controls below are worthless: a guard
  // that refused EVERY wallet would satisfy "test wallet is refused" too. A human
  // wallet with no `platform` field must reserve.
  test('GREEN: a human wallet with no platform field still reserves', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-d271-no-platform');
    await enqueueAct(fake, qualification);
    await arm(fake);
    const { deps } = makeDeps(fake);

    const result = await processGenesisQualification(deps, qualification.qualification_id);

    expect(result.reason).not.toBe(GENESIS_TEST_PLATFORM_DENIAL);
    expect(result.status).not.toBe('denied');
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(true);
  });

  // THE SECOND GREEN. This is what stops the guard degenerating into "any wallet
  // carrying a platform refuses" — the field EXISTS here (non-test) and must not
  // refuse. The guard keys on the value, not on presence.
  test('GREEN: a non-test platform reserves — the guard keys on the value, not on presence', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-d271-real-platform');
    await enqueueAct(fake, qualification, { platform: 'claude-code' });
    await arm(fake);
    const { deps } = makeDeps(fake);

    const result = await processGenesisQualification(deps, qualification.qualification_id);

    expect(result.reason).not.toBe(GENESIS_TEST_PLATFORM_DENIAL);
    expect(result.status).not.toBe('denied');
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(true);
  });

  // THE RED CONTROL — the WS5 fix. A `platform: 'test'` HUMAN wallet (flag on the
  // `wallets` doc, the human-leg subject collection) is refused. Under the prior
  // hardcoded-`agent_wallets` guard this reserved 75 PVT; it must now deny.
  test('RED: a platform:test HUMAN wallet refuses BY NAME and reserves nothing', async () => {
    const fake = createFakeFirestore();
    const qualification = humanQualification('wallet-d271-human-test');
    await enqueueAct(fake, qualification, { platform: TEST_PLATFORM_VALUE });
    await arm(fake);
    const { deps } = makeDeps(fake);

    const result = await processGenesisQualification(deps, qualification.qualification_id);

    // Refused, under its OWN reason — not an upstream one that would make this
    // control pass for the wrong cause.
    expect(result).toMatchObject({
      status: 'denied',
      reason: GENESIS_TEST_PLATFORM_DENIAL,
      reservedAtomic: '0',
    });
    // No reservation, no wallet ledger, no PE. Refusal is not a partial award.
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(false);
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_WALLET_LEDGER_COLLECTION}/`))).toBe(false);
    expect(fake.store.get(`provenance_envelopes/${qualification.pe_id}`)).toBeUndefined();
    // The refusal is DURABLE and auditable, not a silent skip.
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'denied', denial_reason: GENESIS_TEST_PLATFORM_DENIAL });
  });

  // THE SECOND RED — regression. The agent leg must STILL deny a test wallet via
  // its own collection (`agent_wallets`). Proves the owner-type-correct selection
  // did not simply move the miss from humans to agents.
  test('RED: a platform:test AGENT wallet refuses BY NAME and reserves nothing', async () => {
    const fake = createFakeFirestore();
    const qualification = agentSignupQualification('wallet-d271-agent-test');
    await enqueueAgentSignupAct(fake, qualification, { platform: TEST_PLATFORM_VALUE });
    await arm(fake);
    const { deps } = makeDeps(fake);

    const result = await processGenesisQualification(deps, qualification.qualification_id);

    expect(result).toMatchObject({
      status: 'denied',
      reason: GENESIS_TEST_PLATFORM_DENIAL,
      reservedAtomic: '0',
    });
    expect([...fake.store.keys()].some((k) =>
      k.startsWith(`${GENESIS_RESERVATION_COLLECTION}/`))).toBe(false);
    expect(fake.store.get(
      `${GENESIS_QUALIFICATION_COLLECTION}/${qualification.qualification_id}`,
    )).toMatchObject({ status: 'denied', denial_reason: GENESIS_TEST_PLATFORM_DENIAL });
  });

  test('the predicate itself: only the exact platform value refuses', () => {
    expect(isTestPlatformWallet({ platform: TEST_PLATFORM_VALUE })).toBe(true);
    // Non-test values, missing field, and absent document all admit.
    for (const notTest of [
      { platform: 'production' },
      { platform: 'claude-code' },
      { platform: `${TEST_PLATFORM_VALUE}-harness` },
      { platform: TEST_PLATFORM_VALUE.toUpperCase() },
      {},
      undefined,
      null,
    ]) {
      expect(isTestPlatformWallet(notTest)).toBe(false);
    }
  });
});
