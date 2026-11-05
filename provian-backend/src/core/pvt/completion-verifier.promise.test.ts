/**
 * the `promise_fulfilled` and `goal_envelope_completed` verifiers.
 *
 * The promise witness is now the relay's WALLET-BOUND `human_promises` close-out
 * record: both parties' EIP-191 close-out signatures over the agreed digest. The
 * distinct-owner fence (`detectSameOwnerTransfer`) and the mint-once claim
 * (`prepareCompletionMintClaim`) are separately, exhaustively tested; here they
 * are mocked to controllable verdicts so this suite exercises the VERIFIER's own
 * composition — dispatch by type, the relay-record bind, the two-close-out-signature
 * re-verification, and the awaiting/refuse/promote decision. The close-out
 * signatures are REAL (signed with ethers wallets), so the re-verification arm is
 * genuinely exercised, never mocked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';

// The fence: real `isResolvableCounterpartyAddress`, controllable verdict.
const sameOwnerVerdict = {
  value: { selfReferencing: false, sharedBeneficialOwnership: false, unresolvable: false, reason: 'distinct_owner:test' },
};
jest.mock('./policy/same-owner-detection', () => {
  const actual = jest.requireActual('./policy/same-owner-detection') as typeof import('./policy/same-owner-detection');
  return {
    ...actual,
    detectSameOwnerTransfer: jest.fn(async () => sameOwnerVerdict.value),
  };
});

// The mint-once claim: real canonical-id derivation, controllable relation.
const claimFailure = { closed: false };
const claimEvidence = { value: { relation: 'owner' as string, claim: { owner_pe_id: 'pe_A' } } };
jest.mock('./completion-claim', () => {
  const actual = jest.requireActual('./completion-claim') as typeof import('./completion-claim');
  return {
    ...actual,
    prepareCompletionMintClaim: jest.fn(async () => {
      if (claimFailure.closed) { const { ClosedCrossWitnessOccurrenceError } = jest.requireActual('./mint-once-claim') as typeof import('./mint-once-claim'); throw new ClosedCrossWitnessOccurrenceError(); }
      return { evidence: claimEvidence.value };
    }),
  };
});

// eslint-disable-next-line import/first
import { verifySubstantiveOutcomeCompletion } from './completion-verifier';
// eslint-disable-next-line import/first
import { humanPromiseSignMessage } from '../human-promises/promise-signing';
// eslint-disable-next-line import/first
import { HUMAN_PROMISES_COLLECTION } from '../human-promises/types';

const PROMISE = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);
// Deterministic wallets for the two parties + a stranger.
const WALLET_A = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const WALLET_B = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const WALLET_C = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const A_ADDR = WALLET_A.address.toLowerCase();
const B_ADDR = WALLET_B.address.toLowerCase();
const C_ADDR = WALLET_C.address.toLowerCase();
const PE_A = 'pe_A';
const T0 = 1_800_000_000_000;

async function closeoutSig(wallet: ethers.Wallet, digest = DIGEST): Promise<string> {
  return wallet.signMessage(humanPromiseSignMessage('closeout', PROMISE, digest));
}

/** The row's own sealed promise_fulfilled envelope (actor A, names B). */
function promiseEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PE_A,
    action_type: 'promise_fulfilled',
    user_id: 'user_A',
    wallet_id: 'user_A',
    actor_address: A_ADDR,
    counterparty_address: B_ADDR,
    promise_id: PROMISE,
    timestamp: T0,
    ...over,
  };
}

/** The relay close-out record, fully mutually closed by default. */
function relayRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promise_id: PROMISE,
    digest: DIGEST,
    status: 'fulfilled',
    creator_address: A_ADDR,
    acceptor_address: B_ADDR,
    parties: {},
    closeout: {},
    created_at: T0 - 10_000,
    updated_at: T0 + 2_000,
    expires_at: T0 + 100_000,
    ...over,
  };
}

/** Firestore double: doc().get() over both collections. */
function mockDb(
  envelopes: Record<string, Record<string, unknown>>,
  promises: Record<string, Record<string, unknown>>,
  heldActs: Record<string, Record<string, unknown>> = {},
) {
  const collection = (name: string) => {
    const docsOf = () => {
      if (name === 'provenance_envelopes') return envelopes;
      if (name === HUMAN_PROMISES_COLLECTION) return promises;
      if (name === 'meter_held_acts_v1') return heldActs;
      return {} as Record<string, Record<string, unknown>>;
    };
    return {
      doc: (id: string) => ({
        get: async () => ({ exists: docsOf()[id] !== undefined, data: () => docsOf()[id] }),
      }),
    };
  };
  return { collection } as unknown as import('firebase-admin').firestore.Firestore;
}

const ROW = { peId: PE_A, userId: 'user_A', actionType: 'promise_fulfilled', timestamp: T0 };

beforeEach(() => {
  claimFailure.closed = false;
  sameOwnerVerdict.value = { selfReferencing: false, sharedBeneficialOwnership: false, unresolvable: false, reason: 'distinct_owner:test' };
  claimEvidence.value = { relation: 'owner', claim: { owner_pe_id: PE_A } };
});

describe('verifyPromiseFulfilled — the relay close-out record is the witness', () => {
  async function bothClosed(): Promise<Record<string, Record<string, unknown>>> {
    return {
      [PROMISE]: relayRecord({
        closeout: {
          [A_ADDR]: { address: A_ADDR, signature: await closeoutSig(WALLET_A), signed_at: T0 + 1000 },
          [B_ADDR]: { address: B_ADDR, signature: await closeoutSig(WALLET_B), signed_at: T0 + 2000 },
        },
      }),
    };
  }

  it('promotes when the relay record holds BOTH valid close-out signatures for the two parties', async () => {
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, await bothClosed()), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('promote');
    if (v.kind === 'promote') {
      expect(v.facts.confirmationPeId).toBe(`human_promise_closeout:${PROMISE}`);
      expect(v.facts.canonicalId).toBe(`promise:${PROMISE}`);
      // Observation time = the LATER of the two close-out signatures.
      expect(v.facts.confirmationTimestampMs).toBe(T0 + 2000);
    }
  });

  it('PE METER: a held act with no envelope is read from its held-act record (the migrated pre-meter hold) — RED: neither present refuses', async () => {
    const env = promiseEnvelope();
    const held = { [PE_A]: { relay_pe_id: PE_A, held_reason: 'pending_evidence', key: { facts: { ...env, user_id: 'user_A', job_id: null } } } };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({}, await bothClosed(), held), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('promote');
    const none = await verifySubstantiveOutcomeCompletion(mockDb({}, await bothClosed()), ROW, { nowMs: T0 + 5000 });
    expect(none.kind).toBe('refused');
  });

  it('awaits when there is no relay record yet (a self-claim mints 0)', async () => {
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, {}), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('awaiting');
    if (v.kind === 'awaiting') expect(v.reason).toMatch(/relay_record/);
  });

  // ── RED control: the two-close-out-signature bind actually discriminates ──
  it('RED — a record with only ONE close-out signature does NOT promote (no unilateral close)', async () => {
    const onlyA = {
      [PROMISE]: relayRecord({
        status: 'accepted',
        closeout: { [A_ADDR]: { address: A_ADDR, signature: await closeoutSig(WALLET_A), signed_at: T0 + 1000 } },
      }),
    };
    const blocked = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, onlyA), ROW, { nowMs: T0 + 5000 });
    expect(blocked.kind).toBe('awaiting'); // not promoted

    // Counter-proof: add B's valid close-out and the SAME path promotes.
    (onlyA[PROMISE].closeout as Record<string, unknown>)[B_ADDR] = { address: B_ADDR, signature: await closeoutSig(WALLET_B), signed_at: T0 + 2000 };
    const promoted = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, onlyA), ROW, { nowMs: T0 + 5000 });
    expect(promoted.kind).toBe('promote');
  });

  // ── RED control: a present-but-INVALID close-out signature is refused ──
  it('RED — a close-out signature that does not recover to the party is refused', async () => {
    const forged = {
      [PROMISE]: relayRecord({
        closeout: {
          [A_ADDR]: { address: A_ADDR, signature: await closeoutSig(WALLET_A), signed_at: T0 + 1000 },
          // B's slot carries C's signature — present but does NOT recover to B.
          [B_ADDR]: { address: B_ADDR, signature: await closeoutSig(WALLET_C), signed_at: T0 + 2000 },
        },
      }),
    };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, forged), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.reason).toMatch(/closeout_signature_invalid/);
  });

  // ── RED control: the PE's named counterparty must be a party of record ──
  it('RED — a PE naming a counterparty who is NOT the other party of record is refused (no piggyback)', async () => {
    // Relay record is between A and C; the PE names B as counterparty → mismatch.
    const acRecord = {
      [PROMISE]: relayRecord({
        acceptor_address: C_ADDR,
        closeout: {
          [A_ADDR]: { address: A_ADDR, signature: await closeoutSig(WALLET_A), signed_at: T0 + 1000 },
          [C_ADDR]: { address: C_ADDR, signature: await closeoutSig(WALLET_C), signed_at: T0 + 2000 },
        },
      }),
    };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, acRecord), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.reason).toMatch(/relay_parties_mismatch/);
  });

  it('refuses self-dealing when the fence resolves the two sides to one owner', async () => {
    sameOwnerVerdict.value = { selfReferencing: false, sharedBeneficialOwnership: true, unresolvable: false, reason: 'shared_beneficial_owner:test' };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, await bothClosed()), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.outcome).toBe('refused_completion_self_dealing');
  });

  it('refuses (fail closed) when the row PE carries no resolvable counterparty address', async () => {
    const v = await verifySubstantiveOutcomeCompletion(
      mockDb({ [PE_A]: promiseEnvelope({ counterparty_address: null }) }, await bothClosed()), ROW, { nowMs: T0 + 5000 },
    );
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.outcome).toBe('refused_completion_counterparty_unresolvable');
  });

  it('refuses (fail closed) when the fence read is unresolvable — never "distinct owner"', async () => {
    sameOwnerVerdict.value = { selfReferencing: false, sharedBeneficialOwnership: false, unresolvable: true, reason: 'ownership_registry_unavailable:boom' };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, await bothClosed()), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.outcome).toBe('refused_verifier_error');
  });

  it('a carried closed occurrence is a terminal duplicate, while read errors remain verifier errors', async () => {
    claimFailure.closed = true;
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, await bothClosed()), ROW, { nowMs: T0 + 3_000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.outcome).toBe('refused_canonical_event_already_minted');
  });

  it('refuses when the promise mint-once slot is already owned (each actor mints once per promise)', async () => {
    claimEvidence.value = { relation: 'duplicate', claim: { owner_pe_id: 'pe_other' } };
    const v = await verifySubstantiveOutcomeCompletion(mockDb({ [PE_A]: promiseEnvelope() }, await bothClosed()), ROW, { nowMs: T0 + 5000 });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.outcome).toBe('refused_canonical_event_already_minted');
  });
});

describe('verifyGoalEnvelopeCompleted — self-directed, no distinct counterparty', () => {
  it('refuses by name (an unverifiable self-claim mints 0)', async () => {
    const v = await verifySubstantiveOutcomeCompletion(
      mockDb({}, {}), { peId: 'pe_goal', userId: 'user_A', actionType: 'goal_envelope_completed', timestamp: T0 },
      { nowMs: T0 + 5000 },
    );
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') {
      expect(v.outcome).toBe('refused_no_verifier_for_class');
      expect(v.reason).toMatch(/self_directed/);
    }
  });
});
