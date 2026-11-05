import type { Firestore } from 'firebase-admin/firestore';

import type { AgentBankDeps } from '../agent-bank/types';
import type { PopCacheDeps } from '../agent-wallet/proof-of-possession';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  genesisQualificationId,
} from '../pvt/genesis-award-state-machine';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../meter/identity-acts';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from '../pvt/__test-helpers__/armed-genesis-policy';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';
import { hashGenesisCampaignPolicyManifest } from '../pvt/policy/genesis-policy-engine';
import { hashProposedMonetaryPolicyTemplate } from '../pvt/policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from '../pvt/policy/pvt9-approval-manifest.generated';
import { issueExternalAddressChallenge } from './challenge';
import {
  PROVEN_ADDRESSES_COLLECTION,
  getProvenAddress,
  listProvenAddresses,
} from './link';
import {
  proveExternalAddress,
  reputationTierFromNonce,
  type ProofChainDeps,
  type ProofFenceObservation,
  type ProveExternalAddressParams,
} from './index';

function proofFence(
  overrides: Partial<ProofFenceObservation> = {},
): ProofFenceObservation {
  const observedHeadBlock = overrides.observedHeadBlock ?? 5_000;
  return {
    schemaVersion: 'external-proof-fence/v1',
    chainId: 8453,
    observedHeadBlock,
    proofBlockNumber: observedHeadBlock - 11,
    proofBlockHash: `0x${'ab'.repeat(32)}`,
    provenAtBlock: observedHeadBlock + 1,
    minActivityConfirmations: 12,
    rpcOperatorIds: ['operator-a', 'operator-b'],
    ...overrides,
  };
}

function makeCache(): PopCacheDeps & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    isEnabled: () => true,
    async set(key, value) { store.set(key, value); },
    async setNx(key, value) {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    async get<T>(key: string) { return store.has(key) ? store.get(key) as T : null; },
    async del(key) { store.delete(key); },
  };
}

function makeDeps(fakeOptions?: Parameters<typeof createFakeFirestore>[0]) {
  const fake = createFakeFirestore(fakeOptions);
  const cache = makeCache();
  const enqueue = jest.fn();
  const recordPEAccrual = jest.fn().mockResolvedValue(undefined);
  const deps = {
    db: fake as unknown as Firestore,
    cache,
    peBuffer: { enqueue },
    recordPEAccrual,
  } as unknown as AgentBankDeps;
  return { fake, cache, enqueue, recordPEAccrual, deps };
}

/**
 * PE METER: the proof PE is an identity act (`identity_acts_v1`), never an envelope — the relay
 * keeps no readable PE. Count the agent's proof acts; validate one against the returned pin.
 */
function proofActKeys(fake: ReturnType<typeof createFakeFirestore>): string[] {
  return [...fake.store.entries()]
    .filter(([key, value]) => key.startsWith(`${IDENTITY_ACTS_COLLECTION}/`)
      && (value.act as Record<string, unknown> | undefined)?.action_type === 'external_address_proven')
    .map(([key]) => key);
}

function expectProofAct(
  fake: ReturnType<typeof createFakeFirestore>,
  res: { pe_id?: string; pe_hash?: string },
): void {
  expect(fake.store.has(`provenance_envelopes/${String(res.pe_id)}`)).toBe(false);
  const pe = validateIdentityAct({
    raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${String(res.pe_id)}`),
    peId: res.pe_id as string,
    peHash: res.pe_hash as string,
    actorId: AGENT,
    walletId: WALLET_ID,
  });
  expect(pe).toMatchObject({
    action_type: 'external_address_proven',
    actor_address: ADDR.toLowerCase(),
    metadata: { external_proven: true, proven_address: ADDR.toLowerCase(), no_pvt: true },
  });
}

function chain(overrides: Partial<ProofChainDeps> = {}): ProofChainDeps {
  return {
    getProofFence: async () => proofFence(),
    getTransactionCount: async () => 7,
    revalidateProofFence: async () => {},
    verifySignature: async () => ({ ok: true, method: 'eip191_eoa' }),
    ...overrides,
  };
}

const AGENT = 'agent_a';
const WALLET_ID = 'wallet_aw_a';
const ADDR = '0xABc0000000000000000000000000000000000001';
const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);
const GENESIS_START = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms;

async function armGenesis(fake: ReturnType<typeof createFakeFirestore>): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT).set({
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'external-address-test-approval',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: GENESIS_START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-external-address-test',
    ledger_namespace: 'pvt9-external-address-test-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'external-address-test-operator',
  });
}

async function freshChallengeId(
  cache: PopCacheDeps,
  agentId = AGENT,
  address = ADDR,
  now = 1_000,
): Promise<string> {
  return (await issueExternalAddressChallenge(cache, { agentId, address, now })).challenge_id;
}

function params(
  challengeId: string,
  overrides: Partial<ProveExternalAddressParams> = {},
): ProveExternalAddressParams {
  return {
    agentId: AGENT,
    agentWalletId: WALLET_ID,
    address: ADDR,
    challengeId,
    signature: '0xabcd',
    now: 2_000,
    ...overrides,
  };
}

describe('proveExternalAddress', () => {
  it('writes the link, emits the zero-PVT proof PE, and captures the no-retro fence', async () => {
    const { deps, cache, recordPEAccrual, enqueue, fake } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(deps, params(challengeId), chain());
    expect(res).toMatchObject({
      ok: true,
      proven_address: ADDR.toLowerCase(),
      proven_at_block: 5_001,
      proof_method: 'eip191_eoa',
      initial_reputation_tier: 1,
    });
    const rec = await getProvenAddress(deps.db, ADDR);
    expect(rec).toMatchObject({
      schema_version: 'proven-address/v2',
      economic_eligibility: 'active_go_forward_only',
      agent_id: AGENT,
      proven_at_block: 5_001,
      proof_observed_head_block: 5_000,
      proof_block_number: 4_989,
      proof_block_hash: `0x${'ab'.repeat(32)}`,
      proof_min_confirmations: 12,
      proof_rpc_operator_ids: ['operator-a', 'operator-b'],
      chain: 'base',
      chain_id: 8453,
      proof_method: 'eip191_eoa',
      signature_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      proof_evidence: {
        schema_version: 'external-address-control-proof/v1',
        challenge_id_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        challenge_message_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        signature_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        proof_method: 'eip191_eoa',
        verified_at_ms: 2_000,
      },
      baseline_nonce: 7,
    });
    expect(cache.store.size).toBe(1); // durable redemption marker remains
    expect(enqueue).not.toHaveBeenCalled();
    expect(proofActKeys(fake)).toHaveLength(1);
    expectProofAct(fake, res as { pe_id?: string; pe_hash?: string });
    expect(recordPEAccrual).toHaveBeenCalledTimes(1);
    expect(recordPEAccrual.mock.calls[0][0]).toMatchObject({
      actionType: 'external_address_proven',
      fixedEstimatedPVT: 0,
    });
  });

  it('binds signature, baseline nonce, and post-read revalidation to one proof block', async () => {
    const { deps, cache } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const signatureBlocks: number[] = [];
    const nonceBlocks: number[] = [];
    const revalidated: number[] = [];
    const res = await proveExternalAddress(deps, params(challengeId), chain({
      verifySignature: async ({ proof }) => {
        signatureBlocks.push(proof.proofBlockNumber);
        return { ok: true, method: 'eip1271_contract' };
      },
      getTransactionCount: async (_address, proof) => {
        nonceBlocks.push(proof.proofBlockNumber);
        return 7;
      },
      revalidateProofFence: async (proof) => {
        revalidated.push(proof.proofBlockNumber);
      },
    }));
    expect(res.ok).toBe(true);
    expect(signatureBlocks).toEqual([4_989]);
    expect(nonceBlocks).toEqual([4_989]);
    expect(revalidated).toEqual([4_989]);
  });

  // PHASE 1 CONTROL (d). This suite used to assert the OPPOSITE: that an in-window proof
  // co-wrote a `genesis_signup` outbox row. `genesis_signup` now qualifies on agent wallet
  // creation, so the proof pays nothing — and it must pay nothing on the ONE path where a
  // leftover emission would be hardest to see: fully armed, fully in-window, everything the
  // old grant needed present. Run RED against the pre-change tree.
  it('emits no Genesis qualification of any kind, even fully armed and in-window', async () => {
    const { deps, cache, fake } = makeDeps();
    await armGenesis(fake);
    const challengeId = await freshChallengeId(
      cache,
      AGENT,
      ADDR,
      GENESIS_START - 100,
    );
    const res = await proveExternalAddress(deps, params(challengeId, {
      now: GENESIS_START,
    }), chain());
    // The proof itself is unchanged: it still binds, still emits its zero-PVT proof PE.
    expect(res.ok).toBe(true);
    expectProofAct(fake, res as { pe_id?: string; pe_hash?: string });
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${ADDR.toLowerCase()}`))
      .toMatchObject({ agent_id: AGENT, economic_eligibility: 'active_go_forward_only' });
    // Neither the outbox nor retention: proving an address is not a qualifying act at all,
    // so there is nothing for a later backfill to promote either.
    const qualificationId = genesisQualificationId('genesis_signup', AGENT);
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${qualificationId}`)).toBe(false);
    expect([...fake.store.keys()].filter((key) =>
      key.startsWith(`${GENESIS_QUALIFICATION_COLLECTION}/`)
      || key.startsWith(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/`))).toEqual([]);
  });

  it('a second proven address for the same agent still writes no Genesis record', async () => {
    const { deps, cache, fake } = makeDeps();
    await armGenesis(fake);
    const firstChallenge = await freshChallengeId(cache, AGENT, ADDR, GENESIS_START - 100);
    await proveExternalAddress(deps, params(firstChallenge, {
      now: GENESIS_START,
    }), chain());

    const secondAddress = '0xABc0000000000000000000000000000000000002';
    const secondChallenge = await freshChallengeId(
      cache,
      AGENT,
      secondAddress,
      GENESIS_START + 1_000,
    );
    await proveExternalAddress(deps, params(secondChallenge, {
      address: secondAddress,
      now: GENESIS_START + 2_000,
    }), chain());

    expect([...fake.store.keys()].filter((key) =>
      key.startsWith(`${GENESIS_QUALIFICATION_COLLECTION}/`)
      || key.startsWith(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/`))).toEqual([]);
  });

  it('a bad signature does not consume the challenge or write a binding', async () => {
    const { deps, cache, enqueue, fake } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(
      deps,
      params(challengeId, { signature: '0xbad' }),
      chain({ verifySignature: async () => ({ ok: false, reason: 'eoa_recovery_mismatch' }) }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'eoa_recovery_mismatch' });
    expect(cache.store.size).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(proofActKeys(fake)).toHaveLength(0);
    expect(await getProvenAddress(deps.db, ADDR)).toBeNull();
  });

  it('fails closed when the proof-block fence is unavailable', async () => {
    const { deps, cache, enqueue, fake } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(
      deps,
      params(challengeId),
      chain({ getProofFence: async () => { throw new Error('rpc down'); } }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'head_block_unavailable' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(proofActKeys(fake)).toHaveLength(0);
    expect(await getProvenAddress(deps.db, ADDR)).toBeNull();
  });

  it('fails closed without consuming the challenge when baseline or canonical evidence changes', async () => {
    const first = makeDeps();
    const firstChallenge = await freshChallengeId(first.cache);
    const missingBaseline = await proveExternalAddress(
      first.deps,
      params(firstChallenge),
      chain({ getTransactionCount: async () => { throw new Error('nonce unavailable'); } }),
    );
    expect(missingBaseline).toMatchObject({ ok: false, reason: 'baseline_nonce_unavailable' });
    expect(first.cache.store.size).toBe(1);
    expect(await getProvenAddress(first.deps.db, ADDR)).toBeNull();

    const second = makeDeps();
    const secondChallenge = await freshChallengeId(second.cache);
    const reorged = await proveExternalAddress(
      second.deps,
      params(secondChallenge),
      chain({ revalidateProofFence: async () => { throw new Error('reorg'); } }),
    );
    expect(reorged).toMatchObject({ ok: false, reason: 'proof_evidence_changed' });
    expect(second.cache.store.size).toBe(1);
    expect(await getProvenAddress(second.deps.db, ADDR)).toBeNull();
  });

  it('rejects a fence that does not bind the 12-confirmation activity floor', async () => {
    const { deps, cache } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(deps, params(challengeId), chain({
      getProofFence: async () => proofFence({ minActivityConfirmations: 11 as 12 }),
    }));
    expect(res).toMatchObject({ ok: false, reason: 'head_block_unavailable' });
    expect(await getProvenAddress(deps.db, ADDR)).toBeNull();
  });

  it('rejects different endpoint labels owned by the same RPC operator', async () => {
    const { deps, cache } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(deps, params(challengeId), chain({
      getProofFence: async () => proofFence({
        rpcOperatorIds: ['same-operator', 'same-operator'],
      }),
    }));
    expect(res).toMatchObject({ ok: false, reason: 'head_block_unavailable' });
  });

  it('starts the eligible fence after the observed head, excluding same-block pre-proof activity', async () => {
    const { deps, cache } = makeDeps();
    const challengeId = await freshChallengeId(cache);
    const res = await proveExternalAddress(deps, params(challengeId), chain());
    expect(res.proven_at_block).toBe(5_001);
    expect(res.proven_at_block).toBeGreaterThan(5_000);
  });

  it('is idempotent for the same agent and preserves the original fence', async () => {
    const { deps, cache } = makeDeps();
    const first = await freshChallengeId(cache);
    await proveExternalAddress(
      deps,
      params(first),
      chain(),
    );
    const second = await freshChallengeId(cache);
    const res = await proveExternalAddress(
      deps,
      params(second, { now: 9_000 }),
      chain({
        getProofFence: async () => proofFence({ observedHeadBlock: 8_888 }),
      }),
    );
    expect(res).toMatchObject({ ok: true, already_proven: true, proven_at_block: 5_001 });
  });

  it('lets only the bound agent atomically re-prove a legacy row into exact H/H-11/H+1 evidence', async () => {
    const { deps, cache, fake } = makeDeps();
    const address = ADDR.toLowerCase();
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${address}`, {
      address,
      agent_id: AGENT,
      wallet_id: WALLET_ID,
      proven_at_ms: 100,
      proven_at_block: 100,
      initial_reputation_tier: 3,
    });
    await expect(listProvenAddresses(deps.db)).resolves.toEqual([]);

    const foreignChallenge = await freshChallengeId(cache, 'agent_b');
    const foreign = await proveExternalAddress(deps, params(foreignChallenge, {
      agentId: 'agent_b',
      agentWalletId: 'wallet_aw_b',
    }), chain());
    expect(foreign).toMatchObject({ ok: false, reason: 'address_bound_to_other_agent' });
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${address}`))
      .not.toHaveProperty('schema_version');

    const ownerChallenge = await freshChallengeId(cache);
    const owner = await proveExternalAddress(deps, params(ownerChallenge), chain({
      getTransactionCount: async () => 41,
    }));
    expect(owner).toMatchObject({
      ok: true,
      already_proven: false,
      upgraded_legacy: true,
      proven_at_block: 5_001,
      initial_reputation_tier: 2,
    });
    const upgraded = await getProvenAddress(deps.db, ADDR);
    expect(upgraded).toMatchObject({
      schema_version: 'proven-address/v2',
      proof_observed_head_block: 5_000,
      proof_block_number: 4_989,
      proof_min_confirmations: 12,
      proof_rpc_operator_ids: ['operator-a', 'operator-b'],
      baseline_nonce: 41,
      proven_at_block: 5_001,
    });
    await expect(listProvenAddresses(deps.db)).resolves.toHaveLength(1);
  });

  it('rejects re-binding an address to a different agent', async () => {
    const { deps, cache } = makeDeps();
    const first = await freshChallengeId(cache);
    await proveExternalAddress(deps, params(first), chain());
    const second = await freshChallengeId(cache, 'agent_b');
    const res = await proveExternalAddress(deps, params(second, {
      agentId: 'agent_b',
      agentWalletId: 'wallet_aw_b',
    }), chain());
    expect(res).toMatchObject({ ok: false, reason: 'address_bound_to_other_agent' });
  });

  it('keeps the binding durable when proof PE emission fails, then retries idempotently', async () => {
    // The proof PE's chain-tip transaction (which carries its identity act) fails once.
    const { deps, cache, fake } = makeDeps({
      failTxnWriteOccurrence: { collection: IDENTITY_ACTS_COLLECTION, occurrence: 1 },
    });
    const errorSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await freshChallengeId(cache);
    const failed = await proveExternalAddress(deps, params(first), chain());
    errorSpy.mockRestore();
    expect(failed).toMatchObject({ ok: false, reason: 'pe_emission_failed' });
    expect(proofActKeys(fake)).toHaveLength(0);
    expect((await getProvenAddress(deps.db, ADDR))?.proven_at_block).toBe(5_001);
    const second = await freshChallengeId(cache);
    const retry = await proveExternalAddress(deps, params(second, { now: 9_000 }), chain({
      getProofFence: async () => proofFence({ observedHeadBlock: 8_888 }),
    }));
    expect(retry).toMatchObject({ ok: true, already_proven: true, proven_at_block: 5_001 });
    expect(proofActKeys(fake)).toHaveLength(1);
    expectProofAct(fake, retry as { pe_id?: string; pe_hash?: string });
  });

  it('rejects a stale or foreign challenge id', async () => {
    const { deps } = makeDeps();
    const res = await proveExternalAddress(deps, params('nope'), chain());
    expect(res).toMatchObject({ ok: false, reason: 'challenge_not_found' });
  });
});

describe('reputationTierFromNonce', () => {
  it('tiers prior activity without minting it', () => {
    expect([0, 1, 9, 10, 100].map(reputationTierFromNonce)).toEqual([0, 1, 1, 2, 3]);
  });
});
