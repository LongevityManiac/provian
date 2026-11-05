/**
 * Same-owner detection — behaviour plus its RED controls.
 *
 * `RED CONTROL 1` drives the REAL `computeRecordSnapshot` with the REAL launch
 * policy and shows that a self-transfer MINTS when `selfReferencing` is false —
 * the state every PE was in before this module existed.
 *
 * every fixture below is now built by `seedAgent()`, which writes the
 * SAME three documents production writes, with the SAME field semantics. The
 * first version of this suite seeded a native-index row giving two agent wallets
 * one shared `owner_id` a state no production writer can create, because every
 * writer sets `owner_id` to the AGENT id. That test passed while the behaviour
 * it claimed to prove did not work. Fixtures that production cannot produce are
 * not evidence.
 */

import crypto from 'crypto';

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  nativeAgentRegistrationIndexId,
} from '../native-wallet-registration';
import { PROVEN_ADDRESSES_COLLECTION } from '../../external-address/link';
import { AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../../agent-wallet/key-rotation-transition';
import { computeRecordSnapshot } from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import {
  classifyAgentWalletDoc,
  classifyNativeIndexRow,
  classifyProvenAddressRow,
  classifyRegistrationRow,
  classifyRetiredAddressRow,
  detectSameOwnerTransfer,
  resolveAddressOwnership,
} from './same-owner-detection';

const HUMAN = 'user_H';
const AGENT_1 = 'agent_1';
const AGENT_2 = 'agent_2';
const WALLET_1 = 'wallet_aw_1';
const WALLET_2 = 'wallet_aw_2';
const ADDR_1 = '0x1111111111111111111111111111111111111111';
const ADDR_2 = '0x2222222222222222222222222222222222222222';
const STRANGER_ADDR = '0x3333333333333333333333333333333333333333';

type DB = ReturnType<typeof createFakeFirestore>;

/**
 * Writes exactly what production writes for a registered agent wallet:
 *  - the native ADDRESS index row (`owner_id` = the AGENT id — routes/agent-wallet.ts,
 *    key-rotation-transition.ts)
 *  - the agent REGISTRATION index row (agent_id -> wallet_id)
 *  - the agent_wallets doc carrying `linked_human_user_id`
 */
function seedAgent(
  db: DB,
  opts: { agentId: string; walletId: string; address: string; human: string | null },
): void {
  db.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(opts.address)}`,
    {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: opts.address,
      wallet_id: opts.walletId,
      owner_type: 'agent',
      owner_id: opts.agentId, // <- the AGENT id, exactly as production writes it
      created_at_ms: 1,
    },
  );
  db.store.set(
    `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(opts.agentId)}`,
    { wallet_id: opts.walletId, agent_id: opts.agentId },
  );
  db.store.set(`agent_wallets/${opts.walletId}`, {
    id: opts.walletId,
    linked_human_user_id: opts.human,
  });
}

function seedHumanWallet(db: DB, opts: { userId: string; address: string }): void {
  db.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(opts.address)}`,
    {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: opts.address,
      wallet_id: `wallet_h_${crypto.createHash('sha256').update(opts.userId).digest('hex').slice(0, 8)}`,
      owner_type: 'human',
      owner_id: opts.userId,
      created_at_ms: 1,
    },
  );
}

function snapshotFor(selfReferencing: boolean, sharedBeneficialOwnership: boolean) {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe_test',
    economicActorId: AGENT_1,
    // F-A7 repriced the relay-draft `agent_evm_transaction` to record_only (its
    // value mints on the on-chain event via the outbound watcher, never the
    // draft), so it no longer exercises the same-owner fence. `swap` is the
    // financial-attestation-neutral, fence-governed family this suite proves
    // below — eligible when not self-dealing, record_only when the fence fires.
    actionType: 'swap',
    recordedAtMs: 1_785_800_000_000,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: 'base:8453:pe_test:0',
    selfReferencing,
    sharedBeneficialOwnership,
    pairChurnDetected: false,
    sessionLineageId: 'session:pe_test',
    genesisReservation: null,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
  });
}

describe('the engine this feeds — RED controls', () => {
  it('RED CONTROL 1: with selfReferencing=false the REAL engine does NOT seal record_only', () => {
    const snap = snapshotFor(false, false);
    expect(snap.mintDisposition).not.toBe('record_only');
    expect(snap.mintReasonCode).not.toBe('self_or_shared_beneficial_ownership');
  });

  it('GREEN: flipping ONLY selfReferencing flips the same engine to record_only', () => {
    expect(snapshotFor(true, false).mintReasonCode).toBe('self_or_shared_beneficial_ownership');
  });

  it('GREEN: sharedBeneficialOwnership alone also seals record_only', () => {
    expect(snapshotFor(false, true).mintReasonCode).toBe('self_or_shared_beneficial_ownership');
  });

  it('RED CONTROL 2: the fixture action type is genuinely governed by the policy', () => {
    expect(snapshotFor(false, false).mintDisposition)
      .not.toBe(snapshotFor(true, false).mintDisposition);
  });
});

/**
 * 3d — the LOAD-BEARING fence for admitting a native agent wallet's own
 * x402 to the outbound watcher. Once the native address is in the watched set,
 * `detectSameOwnerTransfer` is the ONLY thing stopping self-payment farming, so
 * it is proven here on the REAL fence + REAL engine composed for the exact
 * `x402_payment` action type the watcher emits.
 *
 * MANDATORY RED control (from the directive): "a native->native x402 that
 * pays ANYTHING is a FAIL." The pair below is that control — the self-payment
 * MUST seal `record_only`, and the identical payment to a genuine third party
 * MUST NOT (else the assertion would pass vacuously for a fence that never runs).
 */
function x402SnapshotFor(selfReferencing: boolean, sharedBeneficialOwnership: boolean) {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe_x402',
    economicActorId: AGENT_1,
    actionType: 'x402_payment',
    recordedAtMs: 1_785_800_000_000,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: 'base:8453:pe_x402:0',
    selfReferencing,
    sharedBeneficialOwnership,
    pairChurnDetected: false,
    // x402_payment is financial-attestation-neutral (session lineage OPTIONAL),
    // so a null lineage does NOT gate it — the ONLY thing that can seal
    // record_only here is the same-owner verdict.
    sessionLineageId: null,
    genesisReservation: null,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
  });
}

describe(' 3d — native agent x402 self-payment cannot pay', () => {
  it('GREEN: a native agent x402 to its OWN registered address seals record_only (pays 0)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const verdict = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_1,
    });
    expect(verdict.selfReferencing).toBe(true);
    expect(verdict.unresolvable).toBe(false);
    const snap = x402SnapshotFor(verdict.selfReferencing, verdict.sharedBeneficialOwnership);
    expect(snap.mintDisposition).toBe('record_only');
    expect(snap.mintReasonCode).toBe('self_or_shared_beneficial_ownership');
  });

  it('GREEN: a native agent x402 to a SIBLING agent under the same human also seals record_only', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    const verdict = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(verdict.sharedBeneficialOwnership).toBe(true);
    const snap = x402SnapshotFor(verdict.selfReferencing, verdict.sharedBeneficialOwnership);
    expect(snap.mintDisposition).toBe('record_only');
  });

  it('RED CONTROL: the IDENTICAL x402 to a genuine third party is NOT record_only (would mint)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const verdict = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: STRANGER_ADDR,
    });
    expect(verdict.selfReferencing).toBe(false);
    expect(verdict.sharedBeneficialOwnership).toBe(false);
    const snap = x402SnapshotFor(verdict.selfReferencing, verdict.sharedBeneficialOwnership);
    // Proves the record_only in the GREEN cases is the FENCE firing, not a blanket
    // rule that zeroes every x402 — this one is free to mint.
    expect(snap.mintDisposition).not.toBe('record_only');
    expect(snap.mintReasonCode).not.toBe('self_or_shared_beneficial_ownership');
  });
});

/**
 * native parity extends the same-owner fence beyond x402 to the rest of
 * the priced chain-financial family (`send`, `swap`). These types share
 * x402's `financial_attestation_neutral` + `record_only_if_self_shared_or_churn`
 * policy, so — exactly as for x402 — a null session lineage does NOT gate them
 * and the ONLY thing that can seal `record_only` is the same-owner verdict. The
 * fence itself (`detectSameOwnerTransfer`) is action-type-agnostic, so these
 * tests prove the SAME verdict flows into each type's snapshot. Each carries its
 * own RED control (identical act to a third party mints; the self-dealing
 * case does not).
 */
function financialSnapshotFor(
  actionType: 'send' | 'swap',
  selfReferencing: boolean,
  sharedBeneficialOwnership: boolean,
) {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: `pe_${actionType}`,
    economicActorId: AGENT_1,
    actionType,
    recordedAtMs: 1_785_800_000_000,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: `base:8453:pe_${actionType}:0`,
    selfReferencing,
    sharedBeneficialOwnership,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
  });
}

describe.each(['send', 'swap'] as const)(
  ' native parity — a native agent %s self-payment cannot pay',
  (actionType) => {
    it(`GREEN: a native ${actionType} to its OWN registered address seals record_only (pays 0)`, async () => {
      const db = createFakeFirestore();
      seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
      const verdict = await detectSameOwnerTransfer(db as never, {
        economicActorId: AGENT_1, counterpartyAddress: ADDR_1,
      });
      expect(verdict.selfReferencing).toBe(true);
      const snap = financialSnapshotFor(actionType, verdict.selfReferencing, verdict.sharedBeneficialOwnership);
      expect(snap.mintDisposition).toBe('record_only');
      expect(snap.mintReasonCode).toBe('self_or_shared_beneficial_ownership');
    });

    it(`GREEN: a native ${actionType} to a SIBLING under the same human also seals record_only`, async () => {
      const db = createFakeFirestore();
      seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
      seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
      const verdict = await detectSameOwnerTransfer(db as never, {
        economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
      });
      expect(verdict.sharedBeneficialOwnership).toBe(true);
      const snap = financialSnapshotFor(actionType, verdict.selfReferencing, verdict.sharedBeneficialOwnership);
      expect(snap.mintDisposition).toBe('record_only');
    });

    it(`RED CONTROL: the IDENTICAL ${actionType} to a genuine third party is NOT record_only (would mint)`, async () => {
      const db = createFakeFirestore();
      seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
      const verdict = await detectSameOwnerTransfer(db as never, {
        economicActorId: AGENT_1, counterpartyAddress: STRANGER_ADDR,
      });
      expect(verdict.selfReferencing).toBe(false);
      expect(verdict.sharedBeneficialOwnership).toBe(false);
      const snap = financialSnapshotFor(actionType, verdict.selfReferencing, verdict.sharedBeneficialOwnership);
      // The record_only in the GREEN cases is the FENCE firing, not a blanket rule
      // that zeroes every native transfer — this one is free to mint.
      expect(snap.mintDisposition).not.toBe('record_only');
      expect(snap.mintReasonCode).not.toBe('self_or_shared_beneficial_ownership');
    });
  },
);

describe('resolveAddressOwnership', () => {
  it('resolves a native address to owner_type + owner_id + wallet_id', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    expect(await resolveAddressOwnership(db as never, ADDR_1)).toMatchObject({
      walletId: WALLET_1, ownerId: AGENT_1, ownerType: 'agent', source: 'native_address_index',
    });
  });

  it('is case-insensitive on the address', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const got = await resolveAddressOwnership(db as never, ADDR_1.toUpperCase().replace('0X', '0x'));
    expect(got?.walletId).toBe(WALLET_1);
  });

  it('falls through to proven_addresses', async () => {
    const db = createFakeFirestore();
    db.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${ADDR_1}`, { wallet_id: WALLET_1, agent_id: AGENT_1 });
    expect(await resolveAddressOwnership(db as never, ADDR_1))
      .toMatchObject({ walletId: WALLET_1, source: 'proven_external_address' });
  });

  it('falls through to retired addresses — rotation is not a laundering step', async () => {
    const db = createFakeFirestore();
    db.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${ADDR_1}`,
      { walletId: WALLET_1, agentId: AGENT_1 });
    expect(await resolveAddressOwnership(db as never, ADDR_1))
      .toMatchObject({ walletId: WALLET_1, source: 'retired_address' });
  });

  it('returns null for an unknown address and for a malformed one', async () => {
    const db = createFakeFirestore();
    expect(await resolveAddressOwnership(db as never, STRANGER_ADDR)).toBeNull();
    expect(await resolveAddressOwnership(db as never, 'not-an-address')).toBeNull();
  });
});

describe('detectSameOwnerTransfer — production-shaped fixtures only', () => {
  it('flags a transfer to the agent OWN registered address as selfReferencing', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_1,
    });
    expect(v.selfReferencing).toBe(true);
    expect(v.unresolvable).toBe(false);
  });

  /**
   * THE DEFECT-1 REGRESSION TEST. This is the negative control, built
   * from production writers: human H owns agent_1 and agent_2, agent_1 sends to
   * agent_2's registered address. Before this returned
   * `distinct_owner:native_address_index` and MINTED — because `owner_id` is the
   * agent id, so the two never matched. It is a closed-loop wash: both mints
   * route the linked-human share back to H.
   */
  it('RED CONTROL 3: agent -> SIBLING agent under the same human is sharedBeneficialOwnership', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.sharedBeneficialOwnership).toBe(true);
    expect(v.selfReferencing).toBe(false);
    expect(v.reason).toContain(HUMAN);
  });

  it('RED CONTROL 4: agent -> its OWN human\'s wallet is sharedBeneficialOwnership', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedHumanWallet(db, { userId: HUMAN, address: ADDR_2 });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.sharedBeneficialOwnership).toBe(true);
  });

  it('does NOT flag a genuine third party', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: 'agent_bob', walletId: 'wallet_bob', address: ADDR_2, human: 'user_bob' });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.selfReferencing).toBe(false);
    expect(v.sharedBeneficialOwnership).toBe(false);
    expect(v.unresolvable).toBe(false);
  });

  // Two UNLINKED agents must not be treated as siblings just because both
  // resolve their beneficial owner to null. "Unlinked" is not a shared identity.
  it('RED CONTROL 5: two UNLINKED agents are NOT siblings', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: null });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: null });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.sharedBeneficialOwnership).toBe(false);
    expect(v.selfReferencing).toBe(false);
  });

  it('does not flag when there is no counterparty address', async () => {
    const db = createFakeFirestore();
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: null,
    });
    expect(v.reason).toBe('no_counterparty_address');
    expect(v.unresolvable).toBe(false);
  });

  it('RED CONTROL 6: a registry read failure yields unresolvable, NOT a silent false', async () => {
    const db = createFakeFirestore();
    const broken = {
      collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('firestore_down')) }) }),
      store: db.store,
    };
    const v = await detectSameOwnerTransfer(broken as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_1,
    });
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('ownership_registry_unavailable');
    expect(v.reason).not.toBe('counterparty_unknown_to_registries');
  });

  /**
   *. RED CONTROL 6 fails EVERY collection, so the very first read
   * (`resolveAddressOwnership`) always throws and the two reads added by * `agent_wallets` and the agent registration index — are never the throwing
   * source. Both of their fail-closed catches were therefore untested, and the
   * reviewer proved it: neutering either `catch` to return a value instead of
   * throwing left the suite 16/16 green, while an `agent_wallets` outage silently
   * yielded `distinct_owner` and a sibling-agent wash minted.
   *
   * These two fail ONE collection each, so each catch is the sole throwing source.
   */
  function failingOnly(db: DB, collectionName: string) {
    return {
      store: db.store,
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: () => (name === collectionName
            ? Promise.reject(new Error(`${collectionName}_down`))
            : Promise.resolve({
              exists: db.store.has(`${name}/${id}`),
              data: () => db.store.get(`${name}/${id}`),
            })),
        }),
      }),
    };
  }

  it('RED CONTROL 7: an agent_wallets outage ALONE yields unresolvable', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    const v = await detectSameOwnerTransfer(failingOnly(db, 'agent_wallets') as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('agent_wallets');
    // The specific harm this prevents: without the throw this read the
    // sibling-agent wash resolves `distinct_owner` and mints.
    expect(v.reason).not.toContain('distinct_owner');
  });

  /**
   *. RED 7 and 8 both throw at or before `resolveActor`, so the THIRD
   * await — `resolveBeneficialOwner(db, ownership)` on the COUNTERPARTY side —
   * was never reached under failure by any test. Appending `.catch(() => null)`
   * to it left the suite 18/18 green, a real fail-open: the sibling-agent wash
   * then resolves `distinct_owner` and mints.
   *
   * A HUMAN actor is the sharpest case. `resolveActor` returns early for a human
   * without ever reading `agent_wallets`, so with that collection down this call
   * site is the ONLY thing standing between a human→own-agent transfer and an
   * unchecked mint.
   */
  it('RED CONTROL 9: HUMAN actor + agent_wallets down is unresolvable, not distinct_owner', async () => {
    const db = createFakeFirestore();
    seedHumanWallet(db, { userId: HUMAN, address: ADDR_1 });
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_2, human: HUMAN });
    const v = await detectSameOwnerTransfer(failingOnly(db, 'agent_wallets') as never, {
      economicActorId: HUMAN, counterpartyAddress: ADDR_2,
    });
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('agent_wallets');
    expect(v.sharedBeneficialOwnership).toBe(false);
    expect(v.reason).not.toContain('distinct_owner');
  });

  /**
   *. The last two uncontrolled awaits. `proven_addresses` and the
   * retirement tombstones are only REACHED when the native index read succeeds
   * and MISSES — and RED 6 rejects every collection, so it short-circuits on the
   * native index and never gets there. Neither catch was ever the sole throwing
   * source, and both mutated to real fail-opens that stayed 19/19 green: an
   * outage on either silently became "this address is not ours", and the
   * sibling wash minted.
   *
   * Each seeds the counterparty ONLY in the target registry, so the native index
   * genuinely misses first.
   */
  it('RED CONTROL 10: a proven_addresses outage ALONE yields unresolvable', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    // Sibling reachable ONLY via its proven external address.
    db.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${ADDR_2}`,
      { wallet_id: WALLET_2, agent_id: AGENT_2 });
    db.store.set(`agent_wallets/${WALLET_2}`, { id: WALLET_2, linked_human_user_id: HUMAN });
    const v = await detectSameOwnerTransfer(failingOnly(db, PROVEN_ADDRESSES_COLLECTION) as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('proven_addresses');
    // The harm: without the throw this reads as "not ours" and the wash mints.
    expect(v.reason).not.toContain('counterparty_unknown_to_registries');
  });

  it('RED CONTROL 11: a retirement-tombstone outage ALONE yields unresolvable', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    // Sibling reachable ONLY via a rotated-away address. This is the registry
    // whose whole purpose is that rotation cannot launder a self-transfer.
    db.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${ADDR_2}`,
      { walletId: WALLET_2, agentId: AGENT_2 });
    db.store.set(`agent_wallets/${WALLET_2}`, { id: WALLET_2, linked_human_user_id: HUMAN });
    const v = await detectSameOwnerTransfer(
      failingOnly(db, AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION) as never,
      { economicActorId: AGENT_1, counterpartyAddress: ADDR_2 },
    );
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('address_retirements');
    expect(v.reason).not.toContain('counterparty_unknown_to_registries');
  });

  it('RED CONTROL 8: an agent registration index outage ALONE yields unresolvable', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    const v = await detectSameOwnerTransfer(
      failingOnly(db, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION) as never,
      { economicActorId: AGENT_1, counterpartyAddress: ADDR_2 },
    );
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toContain('agent_registration_index');
    expect(v.reason).not.toContain('distinct_owner');
  });
});

/**
 * -a — fail-OPEN RETURNS, distinct from throws.
 *
 * Every throw site above is fail-closed (`unresolvable: true`). But four
 * shapes where a registry ANSWERED with an unusable document did not throw —
 * they returned as if the registry had said "not ours", and the verdict fell
 * through to `distinct_owner` (fence OFF):
 * 1. a HUMAN native-index row with `owner_id` absent,
 * 2. an index/proven row whose `wallet_id` is unreadable (`walletId === null`),
 * 3. an ABSENT `agent_wallets` doc for a wallet a registry row names
 * (this one is REACHABLE in production: the 2026-09-03 outbound incident
 * was an orphaned index row whose `agent_wallets` doc had been deleted —
 * see the `listWatchedAddresses` comment in `outbound-usdc-watcher.ts`),
 * 4. a registration row whose `wallet_id` is unreadable.
 * "Unknown = Block" an unusable answer is UNKNOWN, not absence. Each now
 * surfaces as `unresolvable: true` with reason `ownership_registry_unusable:*`
 * a reason string distinct from the throw path's
 * `ownership_registry_unavailable:*` and the caller routes it to the
 * recoverable `pending_review` hold (`resolveOperationalDisposition`,
 * `pvt-accrual.ts`), never to a mint.
 *
 * Each shape is constructible at two layers: the raw document seeded through
 * the fake Firestore (end-to-end, below) and the exported boundary classifier
 * that accepts `Record<string, unknown> | null` (widened input type, further
 * below). The transcribed PRE-FIX decision is asserted against in every case.
 *
 * RED CONTROL RECORD (observed against the pre-fix source, commit 8b408220,
 * before the classifiers existed — the end-to-end block only, since the
 * boundary block imports symbols that did not yet exist):
 * - shape 1 FAILED: reason was `distinct_owner:native_address_index`,
 * unresolvable false (agent -> its OWN human's wallet minted).
 * - shape 2 (native) FAILED: `distinct_owner:native_address_index`.
 * - shape 2 (proven) FAILED: `distinct_owner:proven_external_address`.
 * - shape 3 FAILED: `distinct_owner:native_address_index` (sibling wash
 * to an orphaned wallet minted).
 * - shape 3 (actor side) FAILED: `distinct_owner:native_address_index`.
 * - shape 4 FAILED: `distinct_owner:native_address_index` (sibling wash
 * under a corrupted registration row minted).
 * - -b FAILED: reason was `no_counterparty_address` for a `0X`
 * counterparty (fence skipped on a self-transfer); `resolveAddressOwnership`
 * returned null for the `0X` form.
 */
describe('-a — unusable registry answers are UNKNOWN, not absence (end-to-end)', () => {
  const PRE_FIX_NATIVE = 'distinct_owner:native_address_index';
  const PRE_FIX_PROVEN = 'distinct_owner:proven_external_address';

  function expectUnusable(v: Awaited<ReturnType<typeof detectSameOwnerTransfer>>, detail: string) {
    expect(v.unresolvable).toBe(true);
    expect(v.reason).toMatch(/^ownership_registry_unusable:/);
    expect(v.reason).toContain(detail);
    // Distinct from the THROW path's reason.
    expect(v.reason).not.toContain('ownership_registry_unavailable');
    // And never the pre-fix fail-open verdict.
    expect(v.reason).not.toBe(PRE_FIX_NATIVE);
    expect(v.reason).not.toBe(PRE_FIX_PROVEN);
    expect(v.selfReferencing).toBe(false);
    expect(v.sharedBeneficialOwnership).toBe(false);
  }

  it('shape 1: a HUMAN index row with owner_id ABSENT is unresolvable (was distinct_owner)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedHumanWallet(db, { userId: HUMAN, address: ADDR_2 });
    const key = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(ADDR_2)}`;
    const row = { ...db.store.get(key)! };
    delete row.owner_id;
    db.store.set(key, row);
    // Agent -> its OWN human's wallet: RED CONTROL 4 proves this is
    // sharedBeneficialOwnership on a complete row.
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, 'native_address_index');
  });

  it('shape 2 (native): an index row whose wallet_id is unreadable is unresolvable (was distinct_owner)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    const key = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(ADDR_2)}`;
    db.store.set(key, { ...db.store.get(key)!, wallet_id: 42 });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, 'native_address_index');
  });

  it('shape 2 (proven): a proven_addresses row whose wallet_id is unreadable is unresolvable (was distinct_owner)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    // Sibling reachable ONLY via its proven external address, row missing wallet_id.
    db.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${ADDR_2}`, { agent_id: AGENT_2 });
    db.store.set(`agent_wallets/${WALLET_2}`, { id: WALLET_2, linked_human_user_id: HUMAN });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, 'proven_external_address');
  });

  it('shape 3: an ABSENT agent_wallets doc for a registry-named wallet is unresolvable (was distinct_owner)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    // The production orphan shape: index row survives, wallet doc deleted.
    db.store.delete(`agent_wallets/${WALLET_2}`);
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, `agent_wallets_missing:${WALLET_2}`);
  });

  it('shape 3 (actor side): the ACTOR\'s own agent_wallets doc absent is unresolvable too', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    db.store.delete(`agent_wallets/${WALLET_1}`);
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, `agent_wallets_missing:${WALLET_1}`);
  });

  it('shape 4: a registration row whose wallet_id is unreadable is unresolvable (was distinct_owner)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    db.store.set(
      `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(AGENT_1)}`,
      { agent_id: AGENT_1, wallet_id: 42 },
    );
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expectUnusable(v, 'agent_registration_index');
  });

  it('GREEN CONTROL: the identical complete rows still resolve (the hardening is not a blanket hold)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    seedAgent(db, { agentId: AGENT_2, walletId: WALLET_2, address: ADDR_2, human: HUMAN });
    seedAgent(db, { agentId: 'agent_bob', walletId: 'wallet_bob', address: STRANGER_ADDR, human: 'user_bob' });
    const sibling = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: ADDR_2,
    });
    expect(sibling.unresolvable).toBe(false);
    expect(sibling.sharedBeneficialOwnership).toBe(true);
    const stranger = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: STRANGER_ADDR,
    });
    expect(stranger.unresolvable).toBe(false);
    expect(stranger.reason).toBe(PRE_FIX_NATIVE);
    // Genuine ABSENCE (registries answered, none knew the address) is still
    // absence, not unknown.
    const unknown = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: '0x4444444444444444444444444444444444444444',
    });
    expect(unknown.unresolvable).toBe(false);
    expect(unknown.reason).toBe('counterparty_unknown_to_registries');
    // An UNLINKED agent (linked_human_user_id: null) is a legitimate, usable
    // answer — not unknown.
    seedAgent(db, { agentId: 'agent_solo', walletId: 'wallet_solo', address: '0x5555555555555555555555555555555555555555', human: null });
    const solo = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: '0x5555555555555555555555555555555555555555',
    });
    expect(solo.unresolvable).toBe(false);
    expect(solo.reason).toBe(PRE_FIX_NATIVE);
  });
});

describe('-b — counterparty prefix case does not skip the fence', () => {
  const UPPER_X_SELF = `0X${ADDR_1.slice(2)}`;

  it('a `0X`-prefixed counterparty is normalized and the fence runs (was no_counterparty_address)', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const v = await detectSameOwnerTransfer(db as never, {
      economicActorId: AGENT_1, counterpartyAddress: UPPER_X_SELF,
    });
    // Transcribed pre-fix decision: the fence was skipped entirely.
    expect(v.reason).not.toBe('no_counterparty_address');
    expect(v.selfReferencing).toBe(true);
    expect(v.reason).toBe(`self_transfer:native_address_index:wallet=${WALLET_1}`);
  });

  it('resolveAddressOwnership accepts the `0X` prefix and resolves to the lowercase row', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    const got = await resolveAddressOwnership(db as never, UPPER_X_SELF.toUpperCase());
    expect(got?.walletId).toBe(WALLET_1);
  });

  it('GREEN CONTROL: a genuinely malformed counterparty still reads as no_counterparty_address', async () => {
    const db = createFakeFirestore();
    seedAgent(db, { agentId: AGENT_1, walletId: WALLET_1, address: ADDR_1, human: HUMAN });
    for (const bad of ['0x1234', `0Y${ADDR_1.slice(2)}`, ADDR_1.slice(2), `0x${'g'.repeat(40)}`]) {
      const v = await detectSameOwnerTransfer(db as never, {
        economicActorId: AGENT_1, counterpartyAddress: bad,
      });
      expect(v.reason).toBe('no_counterparty_address');
    }
  });
});

/**
 * -a — the same four shapes at the WIDENED BOUNDARY. Each classifier takes
 * the raw document (`Record<string, unknown> | null`), so the violating input is
 * built directly rather than reached through a registry; the `resolved` sibling
 * of each proves the classifier is not a blanket `unusable`.
 */
describe('-a — raw-document classifiers (widened boundary)', () => {
  const canonicalHuman = {
    schema_version: 'native-wallet-address-index/v1',
    chain_id: 8453,
    address: ADDR_2,
    wallet_id: 'wallet_h_1',
    owner_type: 'human',
    owner_id: HUMAN,
    created_at_ms: 1,
  };

  it('shape 1: a HUMAN index row with owner_id absent is unusable; the complete row resolves', () => {
    const { owner_id: _dropped, ...withoutOwner } = canonicalHuman;
    expect(classifyNativeIndexRow(withoutOwner)).toMatchObject({ kind: 'unusable' });
    expect(classifyNativeIndexRow(canonicalHuman)).toEqual({
      kind: 'resolved',
      value: { ownerType: 'human', ownerId: HUMAN, walletId: 'wallet_h_1', source: 'native_address_index' },
    });
    // Absence (no document) is a distinct, non-unusable answer.
    expect(classifyNativeIndexRow(null)).toEqual({ kind: 'absent' });
    expect(classifyNativeIndexRow(undefined)).toEqual({ kind: 'absent' });
  });

  it('shape 2: a row whose wallet_id is unreadable is unusable in every address registry', () => {
    expect(classifyNativeIndexRow({ ...canonicalHuman, wallet_id: 42 })).toMatchObject({ kind: 'unusable' });
    expect(classifyNativeIndexRow({ ...canonicalHuman, wallet_id: '' })).toMatchObject({ kind: 'unusable' });
    expect(classifyProvenAddressRow({ agent_id: AGENT_2 })).toEqual({
      kind: 'unusable', reason: 'proven_external_address:wallet_id_unreadable',
    });
    expect(classifyProvenAddressRow({ wallet_id: WALLET_2 })).toEqual({
      kind: 'unusable', reason: 'proven_external_address:agent_id_unreadable',
    });
    expect(classifyRetiredAddressRow({ agent_id: AGENT_2 })).toEqual({
      kind: 'unusable', reason: 'retired_address:wallet_id_unreadable',
    });
    expect(classifyRetiredAddressRow({ walletId: WALLET_2 })).toEqual({
      kind: 'unusable', reason: 'retired_address:agent_id_unreadable',
    });
    // Complete rows resolve (snake_case writer shape AND the camelCase alias).
    expect(classifyProvenAddressRow({ agent_id: AGENT_2, wallet_id: WALLET_2 })).toEqual({
      kind: 'resolved',
      value: { ownerType: 'agent', ownerId: AGENT_2, walletId: WALLET_2, source: 'proven_external_address' },
    });
    expect(classifyRetiredAddressRow({ agent_id: AGENT_2, wallet_id: WALLET_2 })).toMatchObject({
      kind: 'resolved', value: { walletId: WALLET_2, ownerId: AGENT_2 },
    });
    expect(classifyRetiredAddressRow({ agentId: AGENT_2, walletId: WALLET_2 })).toMatchObject({
      kind: 'resolved', value: { walletId: WALLET_2, ownerId: AGENT_2 },
    });
  });

  it('shape 3: an ABSENT agent_wallets doc is unusable (never absent); linked/unlinked resolve', () => {
    expect(classifyAgentWalletDoc(null, WALLET_2)).toEqual({
      kind: 'unusable', reason: `agent_wallets_missing:${WALLET_2}`,
    });
    expect(classifyAgentWalletDoc(undefined, WALLET_2)).toEqual({
      kind: 'unusable', reason: `agent_wallets_missing:${WALLET_2}`,
    });
    expect(classifyAgentWalletDoc({ id: WALLET_2, linked_human_user_id: HUMAN }, WALLET_2)).toEqual({
      kind: 'resolved', value: { linkedHumanUserId: HUMAN },
    });
    // `null` and missing are both the documented UNLINKED value.
    expect(classifyAgentWalletDoc({ id: WALLET_2, linked_human_user_id: null }, WALLET_2)).toEqual({
      kind: 'resolved', value: { linkedHumanUserId: null },
    });
    expect(classifyAgentWalletDoc({ id: WALLET_2 }, WALLET_2)).toEqual({
      kind: 'resolved', value: { linkedHumanUserId: null },
    });
    // A present-but-unreadable link is unusable, not "unlinked".
    expect(classifyAgentWalletDoc({ id: WALLET_2, linked_human_user_id: 7 }, WALLET_2)).toEqual({
      kind: 'unusable', reason: `agent_wallets_linked_human_unreadable:${WALLET_2}`,
    });
    expect(classifyAgentWalletDoc({ id: WALLET_2, linked_human_user_id: '' }, WALLET_2)).toMatchObject({
      kind: 'unusable',
    });
  });

  it('shape 4: a registration row whose wallet_id is unreadable is unusable; absence is a real answer', () => {
    expect(classifyRegistrationRow({ agent_id: AGENT_1, wallet_id: 42 })).toEqual({
      kind: 'unusable', reason: 'agent_registration_index:wallet_id_unreadable',
    });
    expect(classifyRegistrationRow({ agent_id: AGENT_1 })).toMatchObject({ kind: 'unusable' });
    expect(classifyRegistrationRow({ agent_id: AGENT_1, wallet_id: WALLET_1 })).toEqual({
      kind: 'resolved', value: { walletId: WALLET_1 },
    });
    // No registration row = a human acting directly. Genuine absence.
    expect(classifyRegistrationRow(null)).toEqual({ kind: 'absent' });
  });
});
