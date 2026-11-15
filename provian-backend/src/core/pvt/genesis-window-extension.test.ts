/**
 * Genesis open through December 31, 2026, on the successor kernel.
 *
 * Moving `window.end_ms` moves `hashGenesisCampaignPolicyManifest`, and every reservation
 * sealed since 2026-08-03 is stamped with the PRIOR hash. The ledger validator accepts a
 * stored row only under the current hash or exactly one superseded binding, so without the
 * binding every wallet holding a Genesis reservation would wedge on `invalid_state`
 * the moment the extension deployed. These tests pin:
 *
 * 1. the extension itself (end 2027-01-01T00:00:00Z == the successor's genesisEndsAt);
 * 2. continuity — a ledger holding a row sealed under the prior hash keeps admitting grants;
 * 3. the RED controls — an UNKNOWN hash, or a prior-hash row that claims any multiplier but
 * 10000 bps, still refuses (the binding widened exactly one identity, nothing else);
 * 4. the in-flight PE check accepts the prior identity and nothing unknown.
 */
import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

import {
  computeSupersededGenesisMultiplierBps,
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
  type GenesisCampaignLedgerState,
  type GenesisReservationInput,
  type GenesisReservationObservationContext,
} from './policy/genesis-policy-engine';
import {
  GENESIS_GRANT_MULTIPLIER_BPS,
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
  SUPERSEDED_GENESIS_POLICY_BINDINGS,
} from './policy/proposed-genesis-policy';
import { genesisBountyFor, isRecognizedGenesisPolicyManifestHash } from './genesis-award-state-machine';

/** The Genesis policy identity every reservation from 2026-08-03 to the deploy carries. */
const PRIOR_GENESIS_WINDOW_POLICY_HASH = 'sha256:12e1e87177bd62b36f4b40a440a1e9bb3c770f4f30260424cc8e65692776ddf0';
const UNKNOWN_HASH = `sha256:${'d'.repeat(64)}`;
const DAY_MS = 86_400_000;
const NAMESPACE = PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;
const WINDOW_START = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms as number;
const CURRENT_HASH = hashGenesisCampaignPolicyManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY);

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function activation(): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: sha256('d486-approval-manifest'),
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'frank-approval-d486',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: CURRENT_HASH,
    approved_monetary_policy_template_hash: sha256('monetary-policy-template'),
    effective_at_ms: WINDOW_START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.canonical_pvt_manifest_id as string,
    ledger_namespace: NAMESPACE,
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-activation-d486',
  };
}

function signupInput(walletId: string, actAtMs: number): GenesisReservationInput {
  const anchorId = `agent:${walletId}`;
  return {
    pe_id: `pe-genesis-signup-${walletId}`,
    action_type: 'genesis_signup',
    wallet_id: walletId,
    economic_actor_id: anchorId,
    immutable_anchor: { anchor_kind: 'agent_id', anchor_id: anchorId },
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: `evidence-genesis-signup-${walletId}`,
      evidence_hash: sha256(`genesis_signup:${walletId}:${actAtMs}`),
      subject_wallet_id: walletId,
      canonical_bounty_key: 'genesis_signup',
      qualifying_act: genesisBountyFor('genesis_signup').qualifying_act,
      immutable_anchor_kind: 'agent_id',
      immutable_anchor_id: anchorId,
      qualifying_act_at_ms: actAtMs,
    },
  };
}

function contextFor(input: GenesisReservationInput, walletCreatedAtMs: number): GenesisReservationObservationContext {
  return {
    verification_status: 'verified',
    observed_at_ms: input.qualifying_act_evidence.qualifying_act_at_ms,
    wallet_created: {
      wallet_id: input.wallet_id,
      created_at_ms: walletCreatedAtMs,
      evidence_id: `wallet-created-${input.wallet_id}`,
      evidence_hash: sha256(`wallet-created:${input.wallet_id}:${walletCreatedAtMs}`),
      source: 'authoritative_wallet_record',
    },
  };
}

function reserve(state: GenesisCampaignLedgerState, walletId: string, actAtMs: number) {
  const input = signupInput(walletId, actAtMs);
  return reserveGenesisCampaignGrant({
    manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation: activation(),
    state,
    input,
    observation_context: contextFor(input, actAtMs - 3 * DAY_MS),
    activation_approval_verifier: () => true,
  });
}

/** A ledger holding ONE reservation, re-stamped as if sealed under `hash` (the stored row as it sits in Firestore). */
function ledgerSealedUnder(hash: string, bps?: number): GenesisCampaignLedgerState {
  const first = reserve(createEmptyGenesisLedgerState(NAMESPACE), 'wallet-sealed-before-d486', WINDOW_START + 10 * DAY_MS);
  if (!first.allowed) throw new Error(`setup reservation denied: ${first.reason}`);
  const [key, row] = Object.entries(first.next_state.reservations_by_dedupe_key)[0];
  return {
    ...first.next_state,
    reservations_by_dedupe_key: {
      [key]: { ...row, policy_manifest_hash: hash, ...(bps === undefined ? {} : { decay_multiplier_bps: bps }) },
    },
  };
}

describe('the Genesis window is extended through 2026-12-31', () => {
  it('closes at 2027-01-01T00:00:00Z, the exact second the successor kernel arms as genesisEndsAt', () => {
    const endMs = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms as number;
    expect(new Date(endMs).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const config = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../config/pvt9-base.json'), 'utf8'));
    const [start, end] = config.genesis.chain_observed_reference_only.genesis_window_on_chain.split(' .. ');
    expect(Date.parse(end)).toBe(endMs);
    expect(Date.parse(start)).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms);
  });

  it('the manifest identity moved, and the prior identity is recorded as a superseded binding', () => {
    expect(CURRENT_HASH).not.toBe(PRIOR_GENESIS_WINDOW_POLICY_HASH);
    const binding = SUPERSEDED_GENESIS_POLICY_BINDINGS.find((b) => b.policy_manifest_hash === PRIOR_GENESIS_WINDOW_POLICY_HASH);
    expect(binding).toBeDefined();
    expect(binding!.policy_version).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version);
    expect(binding!.multiplier_rule).toBe('fixed_grant_no_time_based_reduction');
  });

  it('the binding re-derives exactly 10000 bps at every age (it priced nothing differently)', () => {
    const binding = SUPERSEDED_GENESIS_POLICY_BINDINGS.find((b) => b.policy_manifest_hash === PRIOR_GENESIS_WINDOW_POLICY_HASH)!;
    const ages = [0, 1, DAY_MS, 14 * DAY_MS, 365 * DAY_MS];
    let evaluated = 0;
    for (const age of ages) {
      expect(computeSupersededGenesisMultiplierBps(binding, age)).toBe(GENESIS_GRANT_MULTIPLIER_BPS);
      evaluated += 1;
    }
    expect(evaluated).toBe(ages.length);
  });
});

describe('a ledger sealed before the extension keeps admitting grants', () => {
  it('a row sealed under the prior identity validates, and the next wallet reserves 75 PVT', () => {
    const next = reserve(ledgerSealedUnder(PRIOR_GENESIS_WINDOW_POLICY_HASH), 'wallet-after-d486', WINDOW_START + 90 * DAY_MS);
    expect(next.allowed).toBe(true);
    expect(next.reservation!.reserved_atomic).toBe('75000000000000000000');
    expect(next.reservation!.policy_manifest_hash).toBe(CURRENT_HASH);
  });

  it('a qualification after the predecessor close (2026-11-10) reserves inside the extended window', () => {
    const next = reserve(createEmptyGenesisLedgerState(NAMESPACE), 'wallet-november', Date.UTC(2026, 10, 10));
    expect(next.allowed).toBe(true);
  });

  it('RED — a row under an UNKNOWN identity still wedges the ledger (invalid_state)', () => {
    const next = reserve(ledgerSealedUnder(UNKNOWN_HASH), 'wallet-after-d486', WINDOW_START + 90 * DAY_MS);
    expect(next.allowed).toBe(false);
    expect(next.reason).toBe('invalid_state');
  });

  it('RED — a prior-identity row claiming any multiplier but 10000 bps is refused', () => {
    const next = reserve(ledgerSealedUnder(PRIOR_GENESIS_WINDOW_POLICY_HASH, 9_999), 'wallet-after-d486', WINDOW_START + 90 * DAY_MS);
    expect(next.allowed).toBe(false);
    expect(next.reason).toBe('invalid_state');
  });

  it('the close is inclusive, exactly like the kernel (qualifiedAt > genesisEndsAt reverts), and RED one ms later', () => {
    const atClose = reserve(createEmptyGenesisLedgerState(NAMESPACE), 'wallet-at-close', Date.UTC(2027, 0, 1));
    expect(atClose.allowed).toBe(true);
    const late = reserve(createEmptyGenesisLedgerState(NAMESPACE), 'wallet-too-late', Date.UTC(2027, 0, 1) + 1);
    expect(late.allowed).toBe(false);
  });
});

describe('an in-flight Genesis PE written before the extension resumes after it', () => {
  it('accepts the current identity and the prior identity', () => {
    expect(isRecognizedGenesisPolicyManifestHash(CURRENT_HASH)).toBe(true);
    expect(isRecognizedGenesisPolicyManifestHash(PRIOR_GENESIS_WINDOW_POLICY_HASH)).toBe(true);
  });

  it('RED — refuses an unknown identity and a non-string', () => {
    expect(isRecognizedGenesisPolicyManifestHash(UNKNOWN_HASH)).toBe(false);
    expect(isRecognizedGenesisPolicyManifestHash(undefined)).toBe(false);
    expect(isRecognizedGenesisPolicyManifestHash(CURRENT_HASH.toUpperCase())).toBe(false);
  });
});
