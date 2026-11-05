/**
 * the ordering rule for deploying `provian-api` without breaking the
 * standard-lane settlement gate.
 *
 * `standard-lane-recon-gate.ts` admits settlement only when the published
 * reconciliation report's `bound_tree.git_head` EQUALS the deployed image's
 * tree stamp. Two artifacts, produced by two different commands, that must
 * name the same commit — and nothing enforced their ordering, so the pair
 * could silently diverge in three ways:
 *
 * 1. deploy without publishing -> gate refuses `report_absent`
 * 2. publish at an undeployed commit -> gate refuses `report_stale_tree`
 * 3. deploy an unstamped image -> gate refuses `runtime_tree_unstamped`
 *
 * Every one of those is FAIL-CLOSED, so none of them can mint wrongly. What
 * they cost is a working gate: (2) in particular flips an ADMITTING lane to
 * refusing, which is why "the report looks stale, let me refresh it" is the
 * dangerous instinct rather than the safe one. Publishing binds the report to
 * whatever HEAD is NOW; if that commit is not what is deployed, the pair is
 * broken by the act of refreshing it.
 *
 * The correct order is therefore PUBLISH-FIRST, exactly as
 * `scripts/stamp-tree-for-deploy.mjs` documents it:
 *
 * dry-run -> publish -> stamp -> deploy -> --reset
 *
 * This module is the single source of that rule. `scripts/deploy-api-gated.ts`
 * EXECUTES it and `deploy-gate-ordering.test.ts` ASSERTS it, both by importing
 * from here — so the test cannot pass against a private copy of the rules while
 * the script does something else (the self-referential-control defect).
 *
 * It decides ordering ONLY. It cannot mint, settle, publish, stamp, or deploy,
 * and it reads no network, filesystem, or clock.
 */

/** The ordered steps of a gate-safe deploy. */
export type DeployStep = 'dry_run' | 'publish' | 'stamp' | 'deploy' | 'reset';

/**
 * THE order. Exported so the test enumerates the real sequence rather than
 * restating it, and so a reordering here is a reordering everywhere.
 */
export const DEPLOY_SEQUENCE: readonly DeployStep[] = [
  'dry_run', 'publish', 'stamp', 'deploy', 'reset',
];

/** Every reason this module can refuse a step. Exhaustive by construction. */
export type RefusalReason =
  | 'head_unresolved'
  | 'tree_dirty'
  | 'artifact_absent'
  | 'artifact_stale'
  | 'publish_missing'
  | 'publish_stale'
  | 'stamp_missing'
  | 'stamp_mismatch'
  | 'out_of_order';

export const REFUSAL_REASONS: readonly RefusalReason[] = [
  'head_unresolved', 'tree_dirty', 'artifact_absent', 'artifact_stale',
  'publish_missing', 'publish_stale', 'stamp_missing', 'stamp_mismatch',
  'out_of_order',
];

/**
 * Observed state of the deploy, as the wrapper can actually determine it.
 *
 * Every field is nullable because "not yet done" and "done wrong" are different
 * answers and the guard must distinguish them — collapsing them is how a
 * missing publish gets reported as a stale one.
 */
export interface DeployGateState {
  /** `git rev-parse HEAD`, 40-hex, or null if it did not resolve. */
  readonly headSha: string | null;
  /** True when the tree carries dirt beyond the tolerated stamp/artifact set. */
  readonly treeDirty: boolean;
  /** `bound_tree.git_head` of the dry-run artifact on disk, or null. */
  readonly artifactBoundHead: string | null;
  /** `bound_tree.git_head` of the report actually published, or null. */
  readonly publishedReportHead: string | null;
  /** Current value of `DEPLOYED_TREE_GIT_HEAD`, or null when reset. */
  readonly stampValue: string | null;
  /** Steps already completed in this run, in order. */
  readonly completed: readonly DeployStep[];
}

export type StepVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RefusalReason; readonly message: string };

const GIT_SHA_RE = /^[0-9a-f]{40}$/;

function refuse(reason: RefusalReason, message: string): StepVerdict {
  return { ok: false, reason, message };
}

/**
 * True when `step` is the next one due given what has completed.
 *
 * `reset` is the deliberate exception: it is the CLEANUP half of stamping and
 * must be legal the moment the stamp exists, because a deploy that throws still
 * has to restore the null stamp. A reset that could only run after a successful
 * deploy would leave a failed run with a stamped working tree — the exact dirt
 * the next `stamp` call refuses on.
 */
function isNextInSequence(step: DeployStep, completed: readonly DeployStep[]): boolean {
  if (step === 'reset') return completed.includes('stamp');
  const expected = DEPLOY_SEQUENCE[completed.length];
  return expected === step;
}

/**
 * Judge whether `step` may run now. The single admit route for the wrapper.
 *
 * Ordering is checked FIRST so that an out-of-order step is reported as such
 * rather than as whichever precondition it happens to also violate.
 */
export function judgeDeployStep(step: DeployStep, state: DeployGateState): StepVerdict {
  if (!isNextInSequence(step, state.completed)) {
    return refuse('out_of_order',
      `${step} is not the next step — completed [${state.completed.join(', ')}], `
      + `expected ${DEPLOY_SEQUENCE[state.completed.length] ?? 'nothing (sequence complete)'}. `
      + `The order is ${DEPLOY_SEQUENCE.join(' -> ')}.`);
  }

  // `reset` restores the null stamp and must survive any earlier failure, so it
  // carries no preconditions beyond having something to reset.
  if (step === 'reset') return { ok: true };

  const head = state.headSha;
  if (head === null || !GIT_SHA_RE.test(head)) {
    return refuse('head_unresolved',
      `git HEAD did not resolve to a 40-hex sha (${String(head)}) — nothing can be bound to it`);
  }
  if (state.treeDirty) {
    return refuse('tree_dirty',
      'the tree carries changes beyond the deploy stamp and the dry-run artifacts, so the '
      + `commit being claimed (${head.slice(0, 12)}…) is not the tree being built`);
  }

  switch (step) {
    case 'dry_run':
      return { ok: true };

    case 'publish': {
      if (state.artifactBoundHead === null) {
        return refuse('artifact_absent',
          'no dry-run artifact to publish — run the dry run first');
      }
      if (state.artifactBoundHead !== head) {
        return refuse('artifact_stale',
          `the artifact binds ${state.artifactBoundHead.slice(0, 12)}… but HEAD is `
          + `${head.slice(0, 12)}… — re-run the dry run at the current commit`);
      }
      return { ok: true };
    }

    case 'stamp': {
      if (state.publishedReportHead === null) {
        return refuse('publish_missing',
          'no reconciliation report has been published — stamping and deploying now would '
          + 'produce a runtime the gate refuses as report_absent');
      }
      if (state.publishedReportHead !== head) {
        return refuse('publish_stale',
          `the published report binds ${state.publishedReportHead.slice(0, 12)}… but HEAD is `
          + `${head.slice(0, 12)}… — deploying this tree would refuse as report_stale_tree`);
      }
      return { ok: true };
    }

    case 'deploy': {
      if (state.stampValue === null) {
        return refuse('stamp_missing',
          'the tree carries no deploy stamp — the built image could not prove which tree it '
          + 'runs and the gate would refuse it as runtime_tree_unstamped');
      }
      if (state.stampValue !== head) {
        return refuse('stamp_mismatch',
          `the stamp names ${state.stampValue.slice(0, 12)}… but HEAD is ${head.slice(0, 12)}… — `
          + 're-stamp before building');
      }
      // Re-checked at the deploy boundary rather than trusted from the stamp
      // step: the report is the half that lives in Firestore and could have been
      // republished by another operator between the two steps.
      if (state.publishedReportHead !== head) {
        return refuse('publish_stale',
          `the published report binds ${String(state.publishedReportHead)} but this deploy would `
          + `ship ${head.slice(0, 12)}… — the pair must name one commit`);
      }
      return { ok: true };
    }

    default: {
      const exhaustive: never = step;
      return refuse('out_of_order', `unknown step ${String(exhaustive)}`);
    }
  }
}

/**
 * The invariant that must hold when the wrapper finishes: the deployed pair
 * names ONE commit, and the working tree is back to a null stamp.
 *
 * Separate from the step judge because it describes the RESULT, and a result
 * check that reuses the step preconditions would pass for the same reason they
 * did rather than for an independent one.
 */
export function judgeFinalState(state: DeployGateState): StepVerdict {
  if (state.stampValue !== null) {
    return refuse('tree_dirty',
      `the working tree is still stamped with ${state.stampValue.slice(0, 12)}… — run --reset`);
  }
  const head = state.headSha;
  if (head === null || !GIT_SHA_RE.test(head)) {
    return refuse('head_unresolved', `git HEAD did not resolve (${String(head)})`);
  }
  if (state.publishedReportHead !== head) {
    return refuse('publish_stale',
      `the published report binds ${String(state.publishedReportHead)}, not the deployed `
      + `${head.slice(0, 12)}… — the gate will refuse report_stale_tree`);
  }
  return { ok: true };
}

/**
 * the STAMP HALF of the deploy gate, callable by the shell deploy
 * entrypoint (`deploy-env.sh`, via `scripts/require-tree-stamp.ts`).
 *
 * `deploy-env.sh` is a sanctioned STANDALONE entrypoint — its own usage doc says
 * "bash deploy-env.sh" that builds and deploys from source but never stamps
 * the tree. A direct run therefore ships a NULL-stamped image, which the
 * standard-lane reconciliation gate refuses as `runtime_tree_unstamped`, and the
 * lane then HOLDS its backlog SILENTLY until the next settlement run pages it
 * (/ OP-1 — the exact incident this closes). This turns that silent
 * multi-hour hold into a fail-fast at deploy time.
 *
 * It is the SAME stamp invariant `judgeDeployStep('deploy', …)` enforces for the
 * gated wrapper (`stampValue` non-null AND equal to HEAD), narrowed to the two
 * facts a shell guard can cheaply observe — the stamp file and `git rev-parse
 * HEAD` so BOTH entrypoints refuse an unstamped image for one reason. The
 * gated wrapper stamps HEAD before calling `deploy-env.sh`, so this admits on
 * that path; only an out-of-band deploy is refused.
 *
 * The reasons intentionally REUSE the step-guard vocabulary (`head_unresolved`,
 * `stamp_missing`, `stamp_mismatch`) but live in their own verdict type: this is
 * a different entrypoint at a different moment, not a second copy of the step
 * judge, and it must not perturb the `REFUSAL_REASONS` reachability sweep.
 */
export type StampGuardReason =
  | 'head_unresolved'
  | 'stamp_missing'
  | 'stamp_mismatch';

export type StampGuardVerdict =
  | { readonly ok: true; readonly overridden: boolean; readonly message: string }
  | { readonly ok: false; readonly reason: StampGuardReason; readonly message: string };

export function judgeDeployStampReady(
  stampValue: string | null,
  headSha: string | null,
  allowOverride: boolean,
): StampGuardVerdict {
  // The override is a deliberate, auditable escape hatch (PROVIAN_ALLOW_UNSTAMPED_DEPLOY=1),
  // mirroring the caller-set opt-outs elsewhere in the tree. It admits, but says plainly
  // that the standard lane will hold until the report is re-published at the deployed commit.
  if (allowOverride) {
    return {
      ok: true,
      overridden: true,
      message:
        'PROVIAN_ALLOW_UNSTAMPED_DEPLOY=1 — shipping without a verified tree stamp; the standard '
        + 'settlement lane will HOLD until the reconciliation report is re-published at the deployed commit.',
    };
  }
  if (headSha === null || !GIT_SHA_RE.test(headSha)) {
    return {
      ok: false,
      reason: 'head_unresolved',
      message: `git HEAD did not resolve to a 40-hex sha (${String(headSha)}); cannot verify the stamp`,
    };
  }
  if (stampValue === null) {
    return {
      ok: false,
      reason: 'stamp_missing',
      message:
        'the tree stamp is null — this image would fail-close the standard settlement lane '
        + '(runtime_tree_unstamped) and silently HOLD its backlog. Deploy via '
        + 'scripts/deploy-api-gated.ts --execute (it stamps and re-publishes the reconciliation report '
        + 'at the deployed commit), or set PROVIAN_ALLOW_UNSTAMPED_DEPLOY=1 to override deliberately.',
    };
  }
  if (!GIT_SHA_RE.test(stampValue) || stampValue !== headSha) {
    return {
      ok: false,
      reason: 'stamp_mismatch',
      message:
        `the tree stamp (${stampValue}) does not match HEAD (${headSha}) — a stale stamp names the `
        + 'wrong commit and the gate refuses report_stale_tree. Re-run scripts/deploy-api-gated.ts --execute.',
    };
  }
  return { ok: true, overridden: false, message: `stamp ${stampValue.slice(0, 12)}… matches HEAD` };
}
