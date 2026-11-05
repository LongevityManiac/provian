import crypto from 'crypto';

import {
  INERT_GENESIS_CAMPAIGN_ACTIVATION,
  buildGenesisDedupeKey,
  computeGenesisGrantMultiplierBps,
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
  type GenesisCampaignLedgerState,
  type GenesisReservationInput,
  type GenesisReservationObservationContext,
} from './genesis-policy-engine';
import {
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
  RETIRED_GENESIS_ACTION_TYPES,
  type ProposedGenesisCampaignPolicyManifest,
} from './proposed-genesis-policy';
import { createArmedGenesisPolicyForTest } from '../__test-helpers__/armed-genesis-policy';

const ATOMIC = 10n ** 18n;
const NAMESPACE = 'base-mainnet-genesis-ledger-v2';
const TEST_GENESIS_CAMPAIGN_POLICY = createArmedGenesisPolicyForTest();
const WINDOW_START = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms;
const TEST_SIGNATURE = {
  scheme: 'sshsig-ed25519' as const,
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: `sha256:${'a'.repeat(64)}`,
  armored_signature: 'test-only-structured-signature',
};

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function approvedActivation(
  manifest: ProposedGenesisCampaignPolicyManifest = TEST_GENESIS_CAMPAIGN_POLICY,
): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: sha256('formal-approval-manifest'),
    approval_signature: TEST_SIGNATURE,
    frank_approval_audit_id: 'frank-approval-test-fixture',
    approved_policy_version: manifest.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(manifest),
    approved_monetary_policy_template_hash: sha256('monetary-policy-template'),
    effective_at_ms: manifest.window.start_ms,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-test-manifest',
    ledger_namespace: NAMESPACE,
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-activation-test-fixture',
  };
}

type GenesisAction = 'genesis_human_signup' | 'genesis_signup' | 'genesis_device_link';

function inputFor(
  actionType: GenesisAction,
  options: {
    walletId?: string;
    anchorId?: string;
    peId?: string;
    actAtMs?: number;
  } = {},
): GenesisReservationInput {
  const walletId = options.walletId ?? 'wallet-1';
  const bounty = TEST_GENESIS_CAMPAIGN_POLICY.bounties.find(
    (candidate) => candidate.canonical_bounty_key === actionType,
  );
  if (!bounty) throw new Error(`missing bounty ${actionType}`);
  const anchorKind = bounty.dedupe.required_anchor;
  const anchorId = options.anchorId ?? (actionType === 'genesis_human_signup'
    ? walletId
    : actionType === 'genesis_signup'
      ? `agent:${walletId}`
      : `registered-device:${walletId}`);
  const actAtMs = options.actAtMs ?? WINDOW_START;
  const peId = options.peId ?? `pe-${actionType}-${walletId}-${anchorId}`;
  return {
    pe_id: peId,
    action_type: actionType,
    wallet_id: walletId,
    economic_actor_id: actionType === 'genesis_signup' ? anchorId : walletId,
    immutable_anchor: { anchor_kind: anchorKind, anchor_id: anchorId },
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: `evidence-${actionType}-${walletId}-${anchorId}`,
      evidence_hash: sha256(`${actionType}:${walletId}:${anchorId}:${actAtMs}`),
      subject_wallet_id: walletId,
      canonical_bounty_key: actionType,
      qualifying_act: bounty.qualifying_act,
      immutable_anchor_kind: anchorKind,
      immutable_anchor_id: anchorId,
      qualifying_act_at_ms: actAtMs,
    },
  };
}

function contextFor(
  input: GenesisReservationInput,
  options: { observedAtMs?: number; walletCreatedAtMs?: number } = {},
): GenesisReservationObservationContext {
  const observedAtMs = options.observedAtMs
    ?? input.qualifying_act_evidence.qualifying_act_at_ms;
  const walletCreatedAtMs = options.walletCreatedAtMs
    ?? input.qualifying_act_evidence.qualifying_act_at_ms;
  return {
    verification_status: 'verified',
    observed_at_ms: observedAtMs,
    wallet_created: {
      wallet_id: input.wallet_id,
      created_at_ms: walletCreatedAtMs,
      evidence_id: `wallet-created-${input.wallet_id}`,
      evidence_hash: sha256(`wallet-created:${input.wallet_id}:${walletCreatedAtMs}`),
      source: 'authoritative_wallet_record',
    },
  };
}

function freshState(): GenesisCampaignLedgerState {
  return createEmptyGenesisLedgerState(NAMESPACE);
}

function reserve(
  input: GenesisReservationInput,
  state: GenesisCampaignLedgerState = freshState(),
  options: {
    activation?: GenesisCampaignActivation | null;
    observedAtMs?: number;
    walletCreatedAtMs?: number;
  } = {},
) {
  return reserveGenesisCampaignGrant({
    manifest: TEST_GENESIS_CAMPAIGN_POLICY,
    activation: options.activation === undefined ? approvedActivation() : options.activation,
    state,
    input,
    observation_context: contextFor(input, options),
    activation_approval_verifier: () => true,
  });
}

describe('atomic accounting pure Genesis reservation kernel', () => {
  describe('armed proposal (Phase 2,) and fail-closed activation', () => {
    test('the checked-in ARMED proposal clears validateManifest; reverting any arming constant re-fails it (RED control)', () => {
      // 'invalid_policy' is returned ONLY by the validateManifest gate (checked
      // before any activation/state/window logic), so it cleanly isolates that gate.
      const input = inputFor('genesis_human_signup', {
        actAtMs: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!,
      });
      const reasonFor = (manifest: ProposedGenesisCampaignPolicyManifest) =>
        reserveGenesisCampaignGrant({
          manifest,
          activation: approvedActivation(manifest),
          state: freshState(),
          input,
          observation_context: contextFor(input),
          activation_approval_verifier: () => true,
        }).reason;
      // Positive: the armed checked-in manifest passes validateManifest — the
      // reason is no longer the pre-arm 'invalid_policy'. (It still stops later on
      // the test ledger namespace; this assertion isolates the validateManifest gate.)
      expect(reasonFor(PROPOSED_GENESIS_CAMPAIGN_POLICY)).not.toBe('invalid_policy');
      // RED controls: each arming constant is individually load-bearing. Revert one
      // at a time to a pre-arm value and confirm validateManifest rejects the whole
      // manifest again. Each violation is constructible (plain field override).
      const withArming = (
        arming: Partial<ProposedGenesisCampaignPolicyManifest['arming']>,
      ): ProposedGenesisCampaignPolicyManifest => ({
        ...PROPOSED_GENESIS_CAMPAIGN_POLICY,
        arming: { ...PROPOSED_GENESIS_CAMPAIGN_POLICY.arming, ...arming },
      });
      const reverts: Array<[string, ProposedGenesisCampaignPolicyManifest]> = [
        ['state', withArming({ state: 'disarmed_requires_explicit_pvt9_activation' })],
        ['grants_enabled', withArming({ grants_enabled: false })],
        ['ledger_namespace', withArming({ ledger_namespace: 'pvt9_genesis_pending' })],
        ['canonical_pvt_manifest_id', withArming({ canonical_pvt_manifest_id: null })],
        ['bounties.launch_armed', {
          ...PROPOSED_GENESIS_CAMPAIGN_POLICY,
          bounties: PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map((b) => ({ ...b, launch_armed: false })),
        }],
      ];
      expect(reverts.length).toBe(5); // non-empty, enumerated population
      for (const [label, manifest] of reverts) {
        // Label-tag the reason so a failure names WHICH revert stopped rejecting.
        expect(`${label}=${reasonFor(manifest)}`).toBe(`${label}=invalid_policy`);
      }
    });

    test('no approval and the checked-in inert activation cannot reserve', () => {
      const input = inputFor('genesis_human_signup');
      expect(reserve(input, freshState(), { activation: null })).toMatchObject({
        allowed: false,
        reason: 'proposal_not_approved',
      });
      expect(reserve(input, freshState(), {
        activation: INERT_GENESIS_CAMPAIGN_ACTIVATION,
      })).toMatchObject({
        allowed: false,
        reason: 'genesis_kill_switch_active',
      });
    });

    test('a structurally approved activation is inert without a valid signable-manifest SSHSIG', () => {
      const input = inputFor('genesis_human_signup');
      const result = reserveGenesisCampaignGrant({
        manifest: TEST_GENESIS_CAMPAIGN_POLICY,
        activation: approvedActivation(),
        state: freshState(),
        input,
        observation_context: contextFor(input),
      });
      expect(result).toMatchObject({ allowed: false, reason: 'proposal_not_approved' });
    });

    test('a legacy activation with no signature fails closed without throwing', () => {
      const input = inputFor('genesis_human_signup');
      const unsigned = {
        ...approvedActivation(),
        approval_signature: undefined,
      } as unknown as GenesisCampaignActivation;
      expect(() => reserveGenesisCampaignGrant({
        manifest: TEST_GENESIS_CAMPAIGN_POLICY,
        activation: unsigned,
        state: freshState(),
        input,
        observation_context: contextFor(input),
        activation_approval_verifier: () => true,
      })).not.toThrow();
      expect(reserve(input, freshState(), { activation: unsigned }))
        .toMatchObject({ allowed: false, reason: 'proposal_not_approved' });
    });

    test.each([
      ['missing the operator approval', { frank_approval_audit_id: null }, 'proposal_not_approved'],
      ['wrong manifest hash', { approved_policy_manifest_hash: sha256('wrong') }, 'proposal_not_approved'],
      ['grants disabled without a close cutoff', { grants_enabled: false }, 'successor_not_armed'],
      ['closed cutoff without an audit id', {
        grants_enabled: false,
        admission_closed_at_ms: WINDOW_START,
      }, 'successor_not_armed'],
      ['PVT9 manifest missing', { canonical_pvt_manifest_id: null }, 'successor_not_armed'],
      ['prior state not reconciled', { prior_reservations_reconciled: false }, 'successor_not_armed'],
      ['operator audit missing', { operator_activation_audit_id: null }, 'successor_not_armed'],
      ['unknown activation field', { unexpected: true }, 'proposal_not_approved'],
      ['non-boolean reconciliation flag', {
        prior_reservations_reconciled: 'true',
      }, 'successor_not_armed'],
    ] as const)('%s fails closed', (_label, patch, reason) => {
      const result = reserve(inputFor('genesis_human_signup'), freshState(), {
        activation: {
          ...approvedActivation(),
          ...patch,
        } as unknown as GenesisCampaignActivation,
      });
      expect(result).toMatchObject({ allowed: false, reason });
    });

    test('the kill switch is evaluated before malformed state or request data', () => {
      const malformed = { ...freshState(), revision: '01' } as GenesisCampaignLedgerState;
      const result = reserve(
        { ...inputFor('genesis_human_signup'), pe_id: 'not a canonical id' },
        malformed,
        { activation: { ...approvedActivation(), genesis_kill_switch_active: true } },
      );
      expect(result.reason).toBe('genesis_kill_switch_active');
      expect(result.next_state).toBe(malformed);
    });
  });

  describe('the three decided grants and anchors', () => {
    test.each([
      ['genesis_human_signup', 75n, 'human_wallet_id'],
      ['genesis_signup', 75n, 'agent_id'],
      ['genesis_device_link', 25n, 'registered_device_id'],
    ] as const)('%s reserves exactly %s PVT against %s', (actionType, amount, anchorKind) => {
      const input = inputFor(actionType);
      expect(input.immutable_anchor.anchor_kind).toBe(anchorKind);
      const result = reserve(input);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error(result.reason);
      expect(result.reservation.fixed_grant_atomic).toBe((amount * ATOMIC).toString());
      expect(result.reservation.reserved_atomic).toBe((amount * ATOMIC).toString());
      expect(result.reservation.decay_multiplier_bps).toBe(10_000);
    });

    test('registered-device dedupe needs no hardware, Secure Enclave, MAC, or attestation field', () => {
      const input = inputFor('genesis_device_link', { anchorId: 'relay-registration-id-42' });
      expect(Object.keys(input.immutable_anchor)).toEqual(['anchor_kind', 'anchor_id']);
      const result = reserve(input);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error(result.reason);
      expect(result.reservation.immutable_anchor_kind).toBe('registered_device_id');
    });

    test('agent signup is once per agent even when the claimed recipient wallet changes', () => {
      const first = reserve(inputFor('genesis_signup', {
        walletId: 'agent-wallet-1',
        anchorId: 'agent-123',
      }));
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error(first.reason);
      const replay = reserve(inputFor('genesis_signup', {
        walletId: 'agent-wallet-2',
        anchorId: 'agent-123',
        peId: 'pe-second-wallet-same-agent',
      }), first.next_state);
      expect(replay).toMatchObject({ allowed: false, reason: 'replay' });
    });

    test.each(RETIRED_GENESIS_ACTION_TYPES)('%s cannot be re-armed by the reservation kernel', (actionType) => {
      const input = {
        ...inputFor('genesis_signup'),
        action_type: actionType,
      };
      expect(reserve(input)).toMatchObject({ allowed: false, reason: 'unknown_bounty_action' });
    });

    test('an anchor of the wrong kind is denied rather than warned', () => {
      const input = inputFor('genesis_device_link');
      const wrong = {
        ...input,
        immutable_anchor: { anchor_kind: 'physical_device_attestation_id', anchor_id: 'att-1' },
        qualifying_act_evidence: {
          ...input.qualifying_act_evidence,
          immutable_anchor_kind: 'physical_device_attestation_id',
          immutable_anchor_id: 'att-1',
        },
      };
      expect(reserve(wrong)).toMatchObject({ allowed: false, reason: 'invalid_immutable_anchor' });
    });
  });

  describe('constant grant multiplier and wallet ceiling', () => {
    test('pays the FULL 75 immediately after wallet birth — no one-bps haircut ', () => {
      const actAtMs = WINDOW_START + 1;
      const input = inputFor('genesis_human_signup', { actAtMs });
      const result = reserve(input, freshState(), {
        observedAtMs: actAtMs,
        walletCreatedAtMs: WINDOW_START,
      });
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error(result.reason);
      // Was 9999 bps / 74992500000000000000 under the retired taper.
      expect(result.reservation.decay_multiplier_bps).toBe(10_000);
      expect(result.reservation.reserved_atomic).toBe('75000000000000000000');
    });

    test('the multiplier is constant, and a very old wallet still gets the full grant', () => {
      const FOURTEEN_DAYS = 1_209_600_000; // the retired half-life
      expect(computeGenesisGrantMultiplierBps(TEST_GENESIS_CAMPAIGN_POLICY, 0)).toBe(10_000);
      expect(computeGenesisGrantMultiplierBps(TEST_GENESIS_CAMPAIGN_POLICY, FOURTEEN_DAYS))
        .toBe(10_000);
      expect(computeGenesisGrantMultiplierBps(TEST_GENESIS_CAMPAIGN_POLICY, FOURTEEN_DAYS * 20))
        .toBe(10_000);

      // A wallet one retired-half-life old at the qualifying act. Under the taper this
      // device link reserved 12.5 PVT (half of 25); it now reserves the full 25.
      const actAtMs = WINDOW_START + FOURTEEN_DAYS;
      const result = reserve(inputFor('genesis_device_link', { actAtMs }), freshState(), {
        observedAtMs: actAtMs,
        walletCreatedAtMs: WINDOW_START,
      });
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error(result.reason);
      expect(result.reservation.reserved_atomic).toBe('25000000000000000000');
    });

    test('the 500 PVT wallet cap permits an exact partial tail and then stops', () => {
      let state = freshState();
      for (let index = 0; index < 19; index += 1) {
        const result = reserve(inputFor('genesis_device_link', {
          walletId: 'wallet-cap',
          anchorId: `registered-device-${index}`,
          peId: `pe-device-${index}`,
        }), state);
        expect(result.allowed).toBe(true);
        if (!result.allowed) throw new Error(result.reason);
        state = result.next_state;
      }
      expect(state.wallet_reserved_atomic['wallet-cap']).toBe((475n * ATOMIC).toString());

      const tail = reserve(inputFor('genesis_human_signup', {
        walletId: 'wallet-cap',
        peId: 'pe-wallet-cap-signup',
      }), state);
      expect(tail.allowed).toBe(true);
      if (!tail.allowed) throw new Error(tail.reason);
      expect(tail.reservation.reserved_atomic).toBe((25n * ATOMIC).toString());
      expect(tail.next_state.wallet_reserved_atomic['wallet-cap']).toBe((500n * ATOMIC).toString());

      const stopped = reserve(inputFor('genesis_device_link', {
        walletId: 'wallet-cap',
        anchorId: 'registered-device-over-cap',
        peId: 'pe-device-over-cap',
      }), tail.next_state);
      expect(stopped).toMatchObject({ allowed: false, reason: 'wallet_lifetime_cap_reached' });
    });
  });

  describe('time admission, replay, and scalability invariants', () => {
    test('an evented close denies later acts but preserves pre-cutoff outboxes', () => {
      const cutoff = WINDOW_START + 1_000;
      const closedActivation: GenesisCampaignActivation = {
        ...approvedActivation(),
        grants_enabled: false,
        admission_closed_at_ms: cutoff,
        admission_close_audit_id: 'close-test-audit',
      };
      const beforeClose = reserve(inputFor('genesis_human_signup', {
        walletId: 'wallet-before-close',
        actAtMs: cutoff,
      }), freshState(), {
        activation: closedActivation,
        observedAtMs: cutoff,
        walletCreatedAtMs: cutoff,
      });
      expect(beforeClose).toMatchObject({ allowed: true, reason: 'reserved' });

      const afterCloseAt = cutoff + 1;
      const afterClose = reserve(inputFor('genesis_human_signup', {
        walletId: 'wallet-after-close',
        actAtMs: afterCloseAt,
      }), freshState(), {
        activation: closedActivation,
        observedAtMs: afterCloseAt,
        walletCreatedAtMs: afterCloseAt,
      });
      expect(afterClose).toMatchObject({ allowed: false, reason: 'campaign_closed' });
    });

    test.each([
      [WINDOW_START - 1, 'campaign_not_started'],
      [TEST_GENESIS_CAMPAIGN_POLICY.window.end_ms + 1, 'campaign_closed'],
    ] as const)('observation at %s is denied as %s', (observedAtMs, reason) => {
      const input = inputFor('genesis_human_signup', { actAtMs: observedAtMs });
      const activation = { ...approvedActivation(), effective_at_ms: WINDOW_START - 10 };
      expect(reserve(input, freshState(), {
        activation,
        observedAtMs,
        walletCreatedAtMs: observedAtMs,
      })).toMatchObject({ allowed: false, reason });
    });

    test('campaign boundaries are inclusive and a post-close retry cannot create a new reservation', () => {
      for (const now of [WINDOW_START, TEST_GENESIS_CAMPAIGN_POLICY.window.end_ms]) {
        const result = reserve(inputFor('genesis_human_signup', {
          walletId: `wallet-${now}`,
          actAtMs: now,
        }), freshState(), { observedAtMs: now, walletCreatedAtMs: now });
        expect(result.allowed).toBe(true);
      }
      const input = inputFor('genesis_device_link', { actAtMs: WINDOW_START });
      expect(reserve(input, freshState(), {
        observedAtMs: TEST_GENESIS_CAMPAIGN_POLICY.window.end_ms + 1,
        walletCreatedAtMs: WINDOW_START,
      })).toMatchObject({ allowed: false, reason: 'campaign_closed' });
    });

    test('neither campaign total nor per-action total is an admission cap', () => {
      let state = freshState();
      for (let index = 0; index < 200; index += 1) {
        const result = reserve(inputFor('genesis_human_signup', {
          walletId: `wallet-scale-${index}`,
          peId: `pe-scale-${index}`,
        }), state);
        expect(result.allowed).toBe(true);
        if (!result.allowed) throw new Error(result.reason);
        state = result.next_state;
      }
      expect(state.total_reserved_atomic).toBe((15_000n * ATOMIC).toString());
      expect(state.revision).toBe('200');
    });

    test('dedupe is deterministic and a replay leaves the state object unchanged', () => {
      const input = inputFor('genesis_device_link');
      const first = reserve(input);
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error(first.reason);
      expect(first.reservation.dedupe_key).toBe(buildGenesisDedupeKey(
        'genesis_device_link',
        input.immutable_anchor,
      ));
      const replay = reserve(input, first.next_state);
      expect(replay).toMatchObject({ allowed: false, reason: 'replay' });
      expect(replay.next_state).toBe(first.next_state);
    });

    test('corrupted ledger arithmetic is blocked before a reservation is attempted', () => {
      const corrupt = {
        ...freshState(),
        total_reserved_atomic: '1',
      } as GenesisCampaignLedgerState;
      expect(reserve(inputFor('genesis_human_signup'), corrupt)).toMatchObject({
        allowed: false,
        reason: 'invalid_state',
      });
    });

    test.each([
      ['canonical dedupe key', (entry: Record<string, unknown>) => ({
        entry: { ...entry, dedupe_key: 'genesis_human_signup:human_wallet_id:deadbeef' },
        key: 'genesis_human_signup:human_wallet_id:deadbeef',
      })],
      ['derived reservation id', (entry: Record<string, unknown>) => ({
        entry: { ...entry, reservation_id: 'genesis-reservation:deadbeef' },
      })],
      ['revision sequence', (entry: Record<string, unknown>) => ({
        entry: {
          ...entry,
          state_revision_before: '99',
          state_revision_after: '100',
        },
      })],
      ['approved decayed amount', (entry: Record<string, unknown>) => ({
        entry: { ...entry, reserved_atomic: (74n * ATOMIC).toString() },
        amount: (74n * ATOMIC).toString(),
      })],
      ['exact reservation schema', (entry: Record<string, unknown>) => ({
        entry: { ...entry, unexpected: true },
      })],
    ])('a self-consistent rewrite of the %s cannot erase the replay fence', (
      _label,
      mutate,
    ) => {
      const first = reserve(inputFor('genesis_human_signup'));
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error(first.reason);
      const [originalKey, originalEntry] = Object.entries(
        first.next_state.reservations_by_dedupe_key,
      )[0];
      const mutation = mutate(originalEntry as unknown as Record<string, unknown>) as {
        entry: Record<string, unknown>;
        key?: string;
        amount?: string;
      };
      const key = mutation.key ?? originalKey;
      const amount = mutation.amount ?? first.next_state.total_reserved_atomic;
      const corrupt = {
        ...first.next_state,
        total_reserved_atomic: amount,
        wallet_reserved_atomic: { 'wallet-1': amount },
        reservations_by_dedupe_key: { [key]: mutation.entry },
      } as unknown as GenesisCampaignLedgerState;

      expect(reserve(inputFor('genesis_device_link', {
        walletId: 'wallet-2',
        anchorId: `second-${_label.replace(/\s+/g, '-')}`,
      }), corrupt)).toMatchObject({ allowed: false, reason: 'invalid_state' });
    });

    test('negative authoritative wallet birth time is rejected rather than tapered', () => {
      const input = inputFor('genesis_human_signup');
      expect(reserve(input, freshState(), { walletCreatedAtMs: -1 }))
        .toMatchObject({ allowed: false, reason: 'unverified_observation_context' });
    });

    test('unknown reservation input fields fail closed before any grant', () => {
      const input = {
        ...inputFor('genesis_human_signup'),
        unexpected: true,
      } as unknown as GenesisReservationInput;
      expect(reserve(input)).toMatchObject({ allowed: false, reason: 'invalid_request' });
    });
  });
});
