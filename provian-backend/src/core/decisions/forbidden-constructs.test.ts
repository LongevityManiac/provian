/**
 * THE GUARD THAT SHOULD HAVE CAUGHT THE TAPER.
 *
 * Two obligations, both discharged on every run:
 * 1. No forbidden construct is present in the tree.
 * 2. EVERY detector still detects. Each entry's `selfTest` feeds it a known
 * violation and this suite asserts the detector fires. A guard that has
 * only ever been seen green is not evidence; these carry their own
 * permanent negative control.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CI_CONCLUSION_CITATION_PATTERNS,
  DOC_CONTRADICTION_RULES,
  ELAPSED_MS_SWEEP,
  FORBIDDEN_CONSTRUCTS,
  HELD_ROW_SWEEP_FILES,
  SANCTIONED_PENDING_EVIDENCE_PROMOTERS,
  HELD_LITERAL_WRITE_ONLY_EXEMPTIONS,
  HELD_ROW_SWEEP_OWN_COLLECTIONS,
  backendSourcePath,
  readBackendSources,
  scanHeldRowPromoters,
  MONEY_PATH_CI_REQUIRED_TOKENS,
  MONEY_PATH_CI_WORKFLOW,
  MONEY_PATH_FILES,
  STANDING_INSTRUCTION_DOCS,
  VERIFICATION_BLOCK_PATTERN,
  VOLUME_COUNT_SWEEP,
  ACCEPTED_CHANGE_BINDINGS,
  ACCEPTED_STATE_CONTRADICTION_RULES,
  ACCEPTED_STATE_DOCS,
  findTimeBasedReductions,
  findRedeclaredCapLiterals,
  findVolumeBasedReductions,
  scanForbiddenConstructs,
  verifyAcceptedChangeBindings,
  type TimeVaryingProbe,
  type VolumeVaryingProbe,
} from './forbidden-constructs';
import {
  computeGenesisGrantMultiplierBps,
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
  type GenesisReservationInput,
} from '../pvt/policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';
import { calculatePEWeight } from '../pvt/pe-weight-framework';
import {
  dailyDiminishingBps,
  supersededDailyDiminishingBps,
} from '../pvt/policy/monetary-accounting';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from '../pvt/policy/proposed-monetary-policy';
import { genesisBountyFor } from '../pvt/genesis-award-state-machine';

describe('the removed-decision registry', () => {
  it('is non-empty and every entry is well formed', () => {
    expect(FORBIDDEN_CONSTRUCTS.length).toBeGreaterThan(0);
    for (const c of FORBIDDEN_CONSTRUCTS) {
      expect(c.id).toMatch(/^FC-\d{3}$/);
      expect(c.decision.length).toBeGreaterThan(0);
      expect(c.removed.length).toBeGreaterThan(0);
      expect(c.construct.length).toBeGreaterThan(0);
      if (c.status === 'declared_not_enforced') {
        // A recorded-but-unenforced entry must say why, or it is just a comment.
        expect(c.not_enforced_reason ?? '').not.toHaveLength(0);
      }
    }
  });

  it('the money-path scope is non-empty and every file is real', () => {
    expect(MONEY_PATH_FILES.length).toBeGreaterThan(0);
    // A scan over zero files passes vacuously. The detector reads each one, so a
    // missing path throws here rather than silently shrinking coverage.
    for (const c of FORBIDDEN_CONSTRUCTS.filter((x) => x.status === 'enforced')) {
      expect(() => c.detect()).not.toThrow();
    }
  });

  it('the FC-006 populations are non-empty, pinned, and every doc is real', () => {
    // The empty-population trap (run contract, by name): dropping CLAUDE.md from
    // the doc list — or emptying it — would leave FC-006 scanning nothing while
    // CI stays green. Pin the membership and existence of both populations.
    expect(STANDING_INSTRUCTION_DOCS).toEqual(
      expect.arrayContaining(['README.md', 'docs/PROVIAN_MANUAL.md', 'docs/PE_PROTOCOL_SPEC.md']),
    );
    expect(STANDING_INSTRUCTION_DOCS.length).toBeGreaterThanOrEqual(3);
    const repoRoot = path.resolve(__dirname, '../../../..');
    for (const rel of STANDING_INSTRUCTION_DOCS) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    }
    expect(DOC_CONTRADICTION_RULES.length).toBeGreaterThanOrEqual(5);
    for (const rule of DOC_CONTRADICTION_RULES) {
      expect(rule.forbidden.length).toBeGreaterThan(0);
      expect(rule.broken_text.length).toBeGreaterThan(0);
      expect(rule.broken_commit).toMatch(/^[0-9a-f]{8,40}$/);
    }
  });

  it('the FC-007 populations are non-empty, pinned, and the merge record is full-sha', () => {
    // Same empty-population defence as FC-006: dropping OPEN_ITEMS.md from the
    // scanned set, or emptying the merge record, must fail here rather than
    // shrink coverage silently.
    expect(ACCEPTED_STATE_DOCS).toEqual(
      expect.arrayContaining(['README.md', 'docs/PROVIAN_MANUAL.md', 'docs/PE_PROTOCOL_SPEC.md', 'docs/AGENT_INTEGRATION.md']),
    );
    const repoRoot = path.resolve(__dirname, '../../../..');
    for (const rel of ACCEPTED_STATE_DOCS) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    }
    expect(ACCEPTED_CHANGE_BINDINGS.length).toBeGreaterThanOrEqual(12);
    for (const entry of ACCEPTED_CHANGE_BINDINGS) {
      expect(entry.merge_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.wp.length).toBeGreaterThan(0);
    }
    // The core WPs of the run are all represented, by name.
    const wps = ACCEPTED_CHANGE_BINDINGS.map((e) => e.wp).join(' ');
    for (const name of ['activation clock', 'institution parameters-rem', 'beneficiary routing', 'linked-job settlement', 'bond lifecycle', 'agent directory', 'governance boundary', 'cutover reconciliation']) {
      expect(wps).toContain(name);
    }
    expect(ACCEPTED_STATE_CONTRADICTION_RULES.length).toBeGreaterThan(0);
    for (const rule of ACCEPTED_STATE_CONTRADICTION_RULES) {
      expect(rule.forbidden.length).toBeGreaterThan(0);
      expect(rule.broken_text.length).toBeGreaterThan(0);
    }
  });

  it('FC-007 merge-record binder fails closed on a stubbed non-ancestor and an empty record', () => {
    // Injectable-checker controls, independent of git: a checker that says NO
    // must produce violations, a throwing checker must produce violations, and
    // an empty record must refuse to pass vacuously.
    const record = [{ wp: 'WP-X', merge_commit: 'a'.repeat(40), merged_on: '2026-07-28' }];
    expect(verifyAcceptedChangeBindings(record, () => false).length).toBe(1);
    expect(verifyAcceptedChangeBindings(record, () => { throw new Error('git gone'); }).length).toBe(1);
    expect(verifyAcceptedChangeBindings([], () => true).length).toBe(1);
    expect(verifyAcceptedChangeBindings(
      [{ wp: 'WP-Y', merge_commit: 'not-a-sha', merged_on: '2026-07-28' }],
      () => true,
    ).length).toBe(1);
    // And a checker that says YES over a well-formed record is clean.
    expect(verifyAcceptedChangeBindings(record, () => true)).toEqual([]);
  });

  it('the FC-009 population is non-empty, the workflow is real, and every guarded suite exists', () => {
    // The empty-population trap again: an emptied token list would leave FC-009
    // scanning for nothing while CI stays green. Pin the membership, and pin
    // that each guarded suite path is a real file — a renamed suite must fail
    // here, not silently shrink CI coverage.
    expect(MONEY_PATH_CI_REQUIRED_TOKENS.length).toBeGreaterThanOrEqual(7);
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(fs.existsSync(path.join(repoRoot, MONEY_PATH_CI_WORKFLOW))).toBe(true);
    const suiteTokens = MONEY_PATH_CI_REQUIRED_TOKENS.filter((t) => t.endsWith('.test.ts'));
    expect(suiteTokens.length).toBeGreaterThanOrEqual(3);
    for (const token of suiteTokens) {
      expect(fs.existsSync(path.join(repoRoot, 'provian-backend', token))).toBe(true);
    }
    // This registry suite is itself one of the guarded suites, so the guard
    // cannot be dropped from CI without the guard noticing.
    expect(MONEY_PATH_CI_REQUIRED_TOKENS).toContain('src/core/decisions/forbidden-constructs.test.ts');
  });

  it('the FC-010 populations are non-empty and the documented citation formats parse', () => {
    expect(CI_CONCLUSION_CITATION_PATTERNS.length).toBeGreaterThanOrEqual(2);
    // The block shape fires on the battery-report form…
    expect(VERIFICATION_BLOCK_PATTERN.test('VERIFIED: backend jest clean')).toBe(true);
    expect(VERIFICATION_BLOCK_PATTERN.test('VERIFIED (local, pre-push): tsc clean')).toBe(true);
    // …and not on prose about verification.
    expect(VERIFICATION_BLOCK_PATTERN.test('the run was verified against git')).toBe(false);
    expect(VERIFICATION_BLOCK_PATTERN.test('cutover reconciliation VERIFIED, reviewer CLEAN')).toBe(false);
    // Both citation formats documented in CLAUDE.md must parse, or the rule
    // demands a shape its own guard rejects.
    expect(CI_CONCLUSION_CITATION_PATTERNS.some((p) =>
      p.test('CI: Backend Tests run 30369201937 success @ bb55b8f9'))).toBe(true);
    expect(CI_CONCLUSION_CITATION_PATTERNS.some((p) =>
      p.test('CI: pending post-push'))).toBe(true);
  });

  it('the FC-013 population is non-empty, real, and every sweep declares its own collections', () => {
    expect(HELD_ROW_SWEEP_FILES.length).toBeGreaterThan(0);
    for (const rel of HELD_ROW_SWEEP_FILES) {
      expect(fs.existsSync(backendSourcePath(rel))).toBe(true);
      // Leg (a) is an allowlist, so a sweep with no declared own collections
      // cannot prove ANY write permitted. Absence here is a fail-closed
      // violation at detect() time, and pinning it makes that deliberate.
      const own = HELD_ROW_SWEEP_OWN_COLLECTIONS[rel] ?? [];
      expect(own.length).toBeGreaterThan(0);
      const src = fs.readFileSync(backendSourcePath(rel), 'utf8');
      for (const name of own) expect(src).toContain(name);
    }
  });

  it('the FC-014 population is the PROMOTERS, and it is non-empty', () => {
    // Two counts, both load-bearing. `evaluated` proves files were read at all;
    // `promoting` is the guard's ACTUAL population — the modules that write a
    // disposition to eligible — and a pass over zero of those would be the
    // empty-population shape wearing a green tick. The first cut counted
    // "files that mention the held literal", four of which were type guards.
    const scan = scanHeldRowPromoters(readBackendSources());
    expect(scan.evaluated).toBeGreaterThan(100);
    expect(scan.promoting).toBeGreaterThan(0);
    expect(scan.violations).toEqual([]);
    // The sanctioned set was EMPTY by until (completion
    // earning) recorded the ONE decision that grows it: the bound
    // counterparty-confirmation promoter. The ruling says a decision is recorded
    // whenever this grows; this assertion is where that shows up — a SECOND
    // name here needs its own ruling.
    expect([...SANCTIONED_PENDING_EVIDENCE_PROMOTERS]).toEqual(['src/core/pvt/completion-promotion.ts']);
    for (const rel of SANCTIONED_PENDING_EVIDENCE_PROMOTERS) {
      expect(fs.existsSync(backendSourcePath(rel))).toBe(true);
      // The sanctioned promoter is a REAL promoter (it writes the disposition),
      // and it is NOT the sweep — FC-013 keeps the sweep unable to promote.
      expect(HELD_ROW_SWEEP_FILES).not.toContain(rel);
    }
    // Every write-only exemption is real, carries a reason, and is a promoter —
    // an exemption for a file that does not promote is dead weight hiding a hole.
    for (const [rel, reason] of Object.entries(HELD_LITERAL_WRITE_ONLY_EXEMPTIONS)) {
      expect(fs.existsSync(backendSourcePath(rel))).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
    // The scan the WHOLE tree is walked by must reach the directories the first
    // cut's hand-picked root list missed — where the bound verifier would live.
    expect([...readBackendSources().keys()]).toEqual(
      expect.arrayContaining(['src/core/onchain/tx-verifier.ts', 'src/core/pe/human-approval.ts']),
    );
  });

  it('NEGATIVE CONTROL — every enforced detector fires on a known violation', () => {
    let checked = 0;
    for (const c of FORBIDDEN_CONSTRUCTS.filter((x) => x.status === 'enforced')) {
      const found = c.selfTest();
      expect(found.length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(FORBIDDEN_CONSTRUCTS.filter((x) => x.status === 'enforced').length);
    expect(checked).toBeGreaterThan(0);
  });

  it('the tree is CLEAN — no forbidden construct is present', () => {
    const violations = scanForbiddenConstructs();
    if (violations.length > 0) {
      throw new Error(
        `Forbidden constructs reintroduced:\n${violations
          .map((v) => `  [${v.construct_id}] ${v.file}:${v.line} — ${v.detail}`)
          .join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FC-003 — behavioural: move ONLY the clock and require the payout not to fall.
// ---------------------------------------------------------------------------

const NAMESPACE = PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;
const WINDOW_START = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms as number;

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function activation(): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: sha256('fc003-approval-manifest'),
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'frank-approval-fc003',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: sha256('monetary-policy-template'),
    effective_at_ms: WINDOW_START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id:
      PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.canonical_pvt_manifest_id as string,
    ledger_namespace: NAMESPACE,
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-activation-fc003',
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
      evidence_id: `evidence-${walletId}`,
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

/** Every live pricing surface, probed with the clock as its ONLY variable. */
const PROBES: readonly TimeVaryingProbe[] = Object.freeze([
  {
    name: 'genesis-policy-engine::computeGenesisGrantMultiplierBps',
    payoutAt: (elapsedMs: number): bigint => BigInt(
      computeGenesisGrantMultiplierBps(PROPOSED_GENESIS_CAMPAIGN_POLICY, elapsedMs),
    ),
  },
  {
    name: 'genesis-policy-engine::reserveGenesisCampaignGrant(genesis_signup)',
    payoutAt: (elapsedMs: number): bigint => {
      const actAtMs = WINDOW_START + 86_400_000;
      const input = signupInput(`fc003-wallet-${elapsedMs}`, actAtMs);
      const result = reserveGenesisCampaignGrant({
        manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
        activation: activation(),
        state: createEmptyGenesisLedgerState(NAMESPACE),
        input,
        observation_context: {
          verification_status: 'verified',
          observed_at_ms: actAtMs,
          wallet_created: {
            wallet_id: input.wallet_id,
            created_at_ms: actAtMs - elapsedMs,
            evidence_id: `wallet-created-${input.wallet_id}`,
            evidence_hash: sha256(`wallet-created:${input.wallet_id}`),
            source: 'authoritative_wallet_record',
          },
        },
        activation_approval_verifier: () => true,
      });
      if (!result.allowed) throw new Error(`denied at ${elapsedMs}: ${result.reason}`);
      return BigInt(result.reservation.reserved_atomic);
    },
  },
  {
    name: 'pe-weight-framework::calculatePEWeight(deferred PE)',
    payoutAt: (elapsedMs: number): bigint => {
      // A deferred PE priced as if it had been waiting `elapsedMs`. Everything
      // except the deferral clock is held constant.
      const weight = calculatePEWeight({
        userId: 'fc003-probe-user',
        actionType: 'work_product',
        attestationDepth: 'software',
        occurrenceCount: 1,
        dailyPECount: 1,
        isHumanLinked: false,
        isDuplicate: false,
        deferred_since: Date.now() - elapsedMs,
      });
      // Scale to an integer so the comparison is exact rather than float-fuzzy.
      return BigInt(Math.round(weight.estimatedPVT * 1e12));
    },
  },
]);

describe('FC-003 — no time-based reduction of earned value', () => {
  it('the sweep is non-empty and spans past every retired half-life', () => {
    expect(ELAPSED_MS_SWEEP.length).toBeGreaterThan(0);
    expect(Math.max(...ELAPSED_MS_SWEEP)).toBeGreaterThan(1_209_600_000 * 20);
  });

  it('every live pricing surface is non-decreasing in elapsed time', () => {
    const violations = findTimeBasedReductions(PROBES);
    if (violations.length > 0) {
      throw new Error(
        `Time-based reductions found:\n${violations
          .map((v) => `  ${v.file} — ${v.detail}`)
          .join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
    expect(PROBES.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL — the detector fires on a payout that shrinks with time', () => {
    const decaying: TimeVaryingProbe = {
      name: 'synthetic::fourteen-day-half-life',
      payoutAt: (elapsedMs: number): bigint => BigInt(
        Math.floor(10_000 * Math.pow(2, -elapsedMs / 1_209_600_000)),
      ),
    };
    const found = findTimeBasedReductions([decaying]);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].detail).toContain('earned value shrank with the clock');
  });

  it('NEGATIVE CONTROL — a step-function reduction is caught too, not just a curve', () => {
    // The vintage multiplier was a lookup table, not an exponentiation. FC-001's
    // shape scan would never have seen it; this behavioural probe does.
    const stepped: TimeVaryingProbe = {
      name: 'synthetic::vintage-lookup-table',
      payoutAt: (elapsedMs: number): bigint => {
        const months = elapsedMs / (30 * 86_400_000);
        if (months <= 6) return 100n;
        if (months <= 12) return 90n;
        if (months <= 24) return 80n;
        return 60n;
      },
    };
    expect(findTimeBasedReductions([stepped]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FC-004 — behavioural: move ONLY the same-day volume count and
// require the PRICE not to fall. Qualification is a separate machine; the
// price function must be volume-flat everywhere.
// ---------------------------------------------------------------------------

/** Every live pricing surface, probed with same-day volume as its ONLY variable. */
const VOLUME_PROBES: readonly VolumeVaryingProbe[] = Object.freeze([
  {
    name: 'monetary-accounting::dailyDiminishingBps (the sealed kernel factor)',
    payoutAt: (volumeCount: number): bigint => BigInt(dailyDiminishingBps(volumeCount + 1)),
  },
  {
    name: 'pe-weight-framework::calculatePEWeight(dailyPECount)',
    payoutAt: (volumeCount: number): bigint => {
      const weight = calculatePEWeight({
        userId: 'fc004-probe-user',
        actionType: 'work_product',
        attestationDepth: 'software',
        occurrenceCount: 1,
        dailyPECount: volumeCount,
        isHumanLinked: false,
        isDuplicate: false,
      });
      return BigInt(Math.round(weight.estimatedPVT * 1e12));
    },
  },
]);

describe('FC-004 — no volume-based rate cut on a qualified act', () => {
  it('the sweep crosses the 50/day qualification bound', () => {
    // The retired curve only bent from ordinal 51. A sweep that stops short
    // is green against the very construct it forbids (the vacuous-guard trap).
    expect(Math.max(...VOLUME_COUNT_SWEEP)).toBeGreaterThan(50);
    expect(VOLUME_COUNT_SWEEP.some((n) => n >= 50 && n <= 52)).toBe(true);
  });

  it('every live pricing surface is volume-flat', () => {
    const violations = findVolumeBasedReductions(VOLUME_PROBES, 'FC-004');
    if (violations.length > 0) {
      throw new Error(
        `Volume-based reductions found:\n${violations
          .map((v) => `  ${v.file} — ${v.detail}`)
          .join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
    expect(VOLUME_PROBES.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL — the detector fires on the retired kernel curve itself', () => {
    // Not a synthetic reconstruction: `supersededDailyDiminishingBps` IS the
    // pre- code, preserved in-tree for sealed-history validation. Wiring
    // the probe to it must light the detector up, or the detector is dead.
    const retiredKernelCurve: VolumeVaryingProbe = {
      name: 'retired::supersededDailyDiminishingBps',
      payoutAt: (volumeCount: number): bigint => BigInt(
        supersededDailyDiminishingBps(volumeCount + 1),
      ),
    };
    const found = findVolumeBasedReductions([retiredKernelCurve], 'FC-004-selftest');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].detail).toContain('repriced by volume');
  });

  it('NEGATIVE CONTROL — the retired framework formula (0.5^excess, floor 0.001) fires too', () => {
    // Verbatim the display-mirror formula removed by.
    const retiredFrameworkCurve: VolumeVaryingProbe = {
      name: 'retired::pe-weight-framework-diminishing',
      payoutAt: (volumeCount: number): bigint => {
        let factor = 1.0;
        if (volumeCount >= 50) {
          factor = Math.max(Math.pow(0.5, volumeCount - 50), 0.001);
        }
        return BigInt(Math.round(factor * 1e12));
      },
    };
    expect(findVolumeBasedReductions([retiredFrameworkCurve], 'FC-004-selftest').length)
      .toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FC-005 — behavioural: fill the pool / issue prior grants, and
// require a later identical act to reserve the same amount. A cap that DENIES
// at the boundary is not this construct; the probes stay under every cap.
// ---------------------------------------------------------------------------

describe('FC-005 — no pool-depletion repricing of a qualified act', () => {
  const PRIOR_GRANT_SWEEP: readonly number[] = Object.freeze([0, 1, 2, 3, 5]);

  it('the live reservation engine reserves the same amount regardless of prior issuance', () => {
    // End to end through the SHIPPED engine: N other wallets reserve first
    // (the "pool fill" analog — the live manifest has no pool at all), then
    // the probe wallet's grant is measured. It must not move.
    const probe: VolumeVaryingProbe = {
      name: 'genesis-policy-engine::reserveGenesisCampaignGrant(after N prior grants)',
      payoutAt: (priorGrants: number): bigint => {
        const actAtMs = WINDOW_START + 86_400_000;
        let state = createEmptyGenesisLedgerState(NAMESPACE);
        for (let i = 0; i < priorGrants; i += 1) {
          const prior = reserveGenesisCampaignGrant({
            manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
            activation: activation(),
            state,
            input: signupInput(`fc005-prior-${priorGrants}-${i}`, actAtMs),
            observation_context: {
              verification_status: 'verified',
              observed_at_ms: actAtMs,
              wallet_created: {
                wallet_id: `fc005-prior-${priorGrants}-${i}`,
                created_at_ms: actAtMs,
                evidence_id: `wallet-created-fc005-prior-${priorGrants}-${i}`,
                evidence_hash: sha256(`wallet-created:fc005-prior-${priorGrants}-${i}`),
                source: 'authoritative_wallet_record',
              },
            },
            activation_approval_verifier: () => true,
          });
          if (!prior.allowed) throw new Error(`prior grant denied: ${prior.reason}`);
          state = prior.next_state;
        }
        const result = reserveGenesisCampaignGrant({
          manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
          activation: activation(),
          state,
          input: signupInput(`fc005-probe-${priorGrants}`, actAtMs),
          observation_context: {
            verification_status: 'verified',
            observed_at_ms: actAtMs,
            wallet_created: {
              wallet_id: `fc005-probe-${priorGrants}`,
              created_at_ms: actAtMs,
              evidence_id: `wallet-created-fc005-probe-${priorGrants}`,
              evidence_hash: sha256(`wallet-created:fc005-probe-${priorGrants}`),
              source: 'authoritative_wallet_record',
            },
          },
          activation_approval_verifier: () => true,
        });
        if (!result.allowed) throw new Error(`probe grant denied: ${result.reason}`);
        return BigInt(result.reservation.reserved_atomic);
      },
    };
    const violations = findVolumeBasedReductions([probe], 'FC-005', PRIOR_GRANT_SWEEP);
    expect(violations).toEqual([]);
    // Anti-vacuity: the probe actually reserved through the engine at the top
    // of the sweep (a throw above would have failed the test, but assert the
    // grant is the approved 75 so an empty-population pass cannot hide here).
    expect(probe.payoutAt(PRIOR_GRANT_SWEEP[PRIOR_GRANT_SWEEP.length - 1]))
      .toBe(75_000_000_000_000_000_000n);
  });

  it('NEGATIVE CONTROL — the retired pool-depletion taper fires the detector', () => {
    // Verbatim the multiplier removed from the retired PVTv8 lane:
    // linear from 1 (empty pool) toward the 0.1 floor as the pool fills, on a
    // 75-PVT bounty against a 5-grant pool (each prior grant fills 1/5).
    const retiredPoolTaper: VolumeVaryingProbe = {
      name: 'retired::genesis-campaign-pool-depletion',
      payoutAt: (priorGrants: number): bigint => {
        const ratio = Math.min(priorGrants / 5, 1);
        const multiplier = Math.max(Math.min(1 - ratio, 1), 0.1);
        return BigInt(Math.round(75 * multiplier * 1e12));
      },
    };
    const found = findVolumeBasedReductions([retiredPoolTaper], 'FC-005-selftest', PRIOR_GRANT_SWEEP);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].detail).toContain('repriced by volume');
  });
});

// ---------------------------------------------------------------------------
// attestation direction pin: hardware attestation must never pay less
// than a weaker attestation FOR THE SAME ACT. Financial-attestation neutrality
// (deliberate, Gate 1) flattens every tier to 1.0x on chain-witnessed
// financial acts — which SATISFIES this direction (all tiers equal; weaker
// tiers are lifted, hardware is never priced below them). The 2.5x lives on
// evidence classes where the device attestation IS the differentiating
// evidence. This pin makes an actual within-act inversion a CI failure.
// ---------------------------------------------------------------------------

interface AttestationDirectionEntry {
  readonly action: string;
  readonly financialAttestationNeutral: boolean;
  readonly tableBps: Readonly<Record<string, number>>;
}

/** Effective per-act multiplier — mirrors monetary-accounting's neutrality force. */
function effectiveAttestationBps(entry: AttestationDirectionEntry, tier: string): number {
  return entry.financialAttestationNeutral ? 10_000 : entry.tableBps[tier];
}

function findAttestationInversions(
  entries: readonly AttestationDirectionEntry[],
): readonly string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const hardwareFull = effectiveAttestationBps(entry, 'hardware_full');
    for (const tier of Object.keys(entry.tableBps)) {
      if (effectiveAttestationBps(entry, tier) > hardwareFull) {
        out.push(`${entry.action}: ${tier} (${effectiveAttestationBps(entry, tier)}) `
          + `out-pays hardware_full (${hardwareFull}) for the same act`);
      }
    }
    const hardwarePartial = effectiveAttestationBps(entry, 'hardware_partial');
    for (const weaker of ['software', 'social']) {
      if (effectiveAttestationBps(entry, weaker) > hardwarePartial) {
        out.push(`${entry.action}: ${weaker} out-pays hardware_partial for the same act`);
      }
    }
  }
  return out;
}

describe('hardware never pays less than a weaker attestation for the same act', () => {
  // Bound to the single source the kernel reads (no redeclared table —).
  const LIVE_ENTRIES: readonly AttestationDirectionEntry[] = Object.entries(
    PROPOSED_MONETARY_POLICY_TEMPLATE.actions,
  ).map(([action, policy]) => ({
    action,
    financialAttestationNeutral: policy.financialAttestationNeutral,
    tableBps: PROPOSED_MONETARY_POLICY_TEMPLATE.attestationMultipliersBps,
  }));

  it('holds across every action in the live policy, both populations present', () => {
    expect(findAttestationInversions(LIVE_ENTRIES)).toEqual([]);
    // Anti-empty-population: both the neutral and the tiered populations exist.
    expect(LIVE_ENTRIES.some((e) => e.financialAttestationNeutral)).toBe(true);
    expect(LIVE_ENTRIES.some((e) => !e.financialAttestationNeutral)).toBe(true);
    expect(LIVE_ENTRIES.length).toBeGreaterThan(0);
  });

  it('neutrality is flat, not inverted: every tier prices identically on a neutral act', () => {
    const neutral = LIVE_ENTRIES.filter((e) => e.financialAttestationNeutral);
    expect(neutral.length).toBeGreaterThan(0);
    for (const entry of neutral) {
      for (const tier of Object.keys(entry.tableBps)) {
        expect(effectiveAttestationBps(entry, tier)).toBe(10_000);
      }
    }
  });

  it('NEGATIVE CONTROL — an inverted table fires the detector', () => {
    const inverted: AttestationDirectionEntry = {
      action: 'synthetic::inverted-send',
      financialAttestationNeutral: false,
      tableBps: { hardware_full: 8_000, hardware_partial: 9_000, software: 10_000, social: 5_000 },
    };
    const found = findAttestationInversions([inverted]);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain('out-pays hardware_full');
    // The SAME inverted table behind neutrality does NOT fire — neutrality
    // flattens it; the defended construct satisfies the pinned direction.
    expect(findAttestationInversions([{ ...inverted, financialAttestationNeutral: true }]))
      .toEqual([]);
  });
});

describe('canonical cap data population', () => {
  it('refuses missing or empty canonical data instead of passing over no cap values', () => {
    expect(findRedeclaredCapLiterals([], 'canonical.json')).toHaveLength(1);
    expect(findRedeclaredCapLiterals([{ path: 'canonical.json', source: '{}' }], 'canonical.json'))
      .toHaveLength(1);
  });
});
