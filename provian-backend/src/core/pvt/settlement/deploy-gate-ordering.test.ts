/**
 * controls for the deploy ordering rule.
 *
 * The thing under test is a GATE-PATH guard, so per the run contract it ships
 * with its RED controls rather than a green-only assertion: every refusal
 * branch is shown firing, the admit branch is shown admitting, and the sweep at
 * the end proves the reason set is fully exercised — a guard with an
 * unreachable branch is the defect this suite exists to prevent.
 *
 * Everything is imported from the module the wrapper script executes. Nothing
 * here restates the sequence or the reasons; a private copy would let this
 * suite stay green while the script did something else entirely.
 */
import {
  DEPLOY_SEQUENCE,
  REFUSAL_REASONS,
  judgeDeployStep,
  judgeDeployStampReady,
  judgeFinalState,
} from './deploy-gate-ordering';
import type {
  DeployGateState, DeployStep, RefusalReason, StepVerdict,
} from './deploy-gate-ordering';

const HEAD = 'a395b89a091529b7e0006adcec43c246698f241d';
const OTHER = '8365f1e3aa11bb22cc33dd44ee55ff6677889900';

/** A clean pre-flight state. Fields are overridden per case. */
function state(over: Partial<DeployGateState> = {}): DeployGateState {
  return {
    headSha: HEAD,
    treeDirty: false,
    artifactBoundHead: null,
    publishedReportHead: null,
    stampValue: null,
    completed: [],
    ...over,
  };
}

function reasonOf(verdict: StepVerdict): RefusalReason | 'ADMITTED' {
  return verdict.ok ? 'ADMITTED' : verdict.reason;
}

function expectRefusal(verdict: StepVerdict, reason: RefusalReason): void {
  expect(reasonOf(verdict)).toBe(reason);
}

/**
 * One real input per refusal branch, for the reachability sweep. The sweep runs every one of these
 * itself (it used to read a set the negative controls filled as a side effect, so
 * `jest --randomize` running the sweep first saw only part of it).
 */
const REFUSAL_INPUTS: ReadonlyArray<readonly [DeployStep, DeployGateState]> = [
  ['dry_run', state({ headSha: null })],
  ['dry_run', state({ treeDirty: true })],
  ['publish', state({ completed: ['dry_run'], artifactBoundHead: null })],
  ['publish', state({ completed: ['dry_run'], artifactBoundHead: OTHER })],
  ['stamp', state({ completed: ['dry_run', 'publish'], artifactBoundHead: HEAD, publishedReportHead: null })],
  ['stamp', state({ completed: ['dry_run', 'publish'], artifactBoundHead: HEAD, publishedReportHead: OTHER })],
  ['deploy', state({ completed: ['dry_run', 'publish', 'stamp'], publishedReportHead: HEAD, stampValue: null })],
  ['deploy', state({ completed: ['dry_run', 'publish', 'stamp'], publishedReportHead: HEAD, stampValue: OTHER })],
  ['stamp', state()],
];

describe(' · the deploy sequence admits in order', () => {
  it('POSITIVE CONTROL — the happy path admits at every step, so the judge is not hardwired to refuse', () => {
    let s = state();
    const admitted: DeployStep[] = [];

    for (const step of DEPLOY_SEQUENCE) {
      const verdict = judgeDeployStep(step, s);
      expect({ step, verdict: reasonOf(verdict) }).toEqual({ step, verdict: 'ADMITTED' });
      admitted.push(step);
      // Advance the world exactly as the wrapper does.
      s = state({
        completed: [...admitted],
        artifactBoundHead: admitted.includes('dry_run') ? HEAD : null,
        publishedReportHead: admitted.includes('publish') ? HEAD : null,
        stampValue: admitted.includes('reset') ? null : (admitted.includes('stamp') ? HEAD : null),
      });
    }

    // The population is asserted, not assumed: a sequence that silently became
    // empty would satisfy a bare "every step admitted" loop vacuously.
    expect(admitted).toEqual([...DEPLOY_SEQUENCE]);
    expect(admitted.length).toBeGreaterThanOrEqual(5);
    expect(judgeFinalState(s)).toEqual({ ok: true });
  });
});

describe(' · NEGATIVE CONTROLS — each way the pair can diverge is refused', () => {
  it('publish-first is enforced: stamping before publishing is refused as publish_missing', () => {
    expectRefusal(
      judgeDeployStep('stamp', state({
        completed: ['dry_run', 'publish'], artifactBoundHead: HEAD, publishedReportHead: null,
      })),
      'publish_missing',
    );
  });

  it('THE TRAP — publishing at a commit that is not deployed is refused as publish_stale', () => {
    // The dangerous instinct: "the report looks stale, refresh it." Refreshing
    // at a HEAD the runtime is not running flips an ADMITTING gate to refusing.
    expectRefusal(
      judgeDeployStep('stamp', state({
        completed: ['dry_run', 'publish'],
        artifactBoundHead: HEAD,
        publishedReportHead: OTHER,
      })),
      'publish_stale',
    );
  });

  it('deploying an unstamped tree is refused as stamp_missing', () => {
    expectRefusal(
      judgeDeployStep('deploy', state({
        completed: ['dry_run', 'publish', 'stamp'],
        publishedReportHead: HEAD,
        stampValue: null,
      })),
      'stamp_missing',
    );
  });

  it('deploying a tree stamped with the wrong commit is refused as stamp_mismatch', () => {
    expectRefusal(
      judgeDeployStep('deploy', state({
        completed: ['dry_run', 'publish', 'stamp'],
        publishedReportHead: HEAD,
        stampValue: OTHER,
      })),
      'stamp_mismatch',
    );
  });

  it('a report republished by someone else between stamp and deploy is caught at the deploy boundary', () => {
    expectRefusal(
      judgeDeployStep('deploy', state({
        completed: ['dry_run', 'publish', 'stamp'],
        publishedReportHead: OTHER,
        stampValue: HEAD,
      })),
      'publish_stale',
    );
  });

  it('publishing a stale dry-run artifact is refused as artifact_stale', () => {
    expectRefusal(
      judgeDeployStep('publish', state({
        completed: ['dry_run'], artifactBoundHead: OTHER,
      })),
      'artifact_stale',
    );
  });

  it('publishing with no artifact at all is refused as artifact_absent, distinctly from stale', () => {
    expectRefusal(
      judgeDeployStep('publish', state({ completed: ['dry_run'], artifactBoundHead: null })),
      'artifact_absent',
    );
  });

  it('a dirty tree is refused as tree_dirty — the commit claimed is not the tree built', () => {
    expectRefusal(judgeDeployStep('dry_run', state({ treeDirty: true })), 'tree_dirty');
  });

  it('an unresolved HEAD is refused as head_unresolved, including a non-40-hex value', () => {
    expectRefusal(judgeDeployStep('dry_run', state({ headSha: null })), 'head_unresolved');
    expectRefusal(judgeDeployStep('dry_run', state({ headSha: 'HEAD' })), 'head_unresolved');
  });

  it('every out-of-sequence step is refused as out_of_order, reported as ordering not precondition', () => {
    // Skipping ahead from a clean start: only the first step is legal.
    for (const step of DEPLOY_SEQUENCE.filter((s) => s !== 'dry_run')) {
      expectRefusal(judgeDeployStep(step, state()), 'out_of_order');
    }
    // Repeating a completed step is equally out of order.
    expectRefusal(
      judgeDeployStep('dry_run', state({ completed: ['dry_run'], artifactBoundHead: HEAD })),
      'out_of_order',
    );
  });

  it('reset is legal the moment a stamp exists, so a FAILED deploy still restores the tree', () => {
    // The whole point: if reset required a successful deploy, a thrown deploy
    // would leave a stamped tree, which is the dirt the next stamp refuses on.
    expect(judgeDeployStep('reset', state({
      completed: ['dry_run', 'publish', 'stamp'],
      publishedReportHead: HEAD,
      stampValue: HEAD,
    }))).toEqual({ ok: true });

    // ...but not before there is anything to reset.
    expectRefusal(judgeDeployStep('reset', state({ completed: ['dry_run'] })), 'out_of_order');
  });

  it('reset is admitted even when the state is otherwise unusable (dirty tree, unresolved HEAD)', () => {
    expect(judgeDeployStep('reset', state({
      completed: ['dry_run', 'publish', 'stamp', 'deploy'],
      headSha: null,
      treeDirty: true,
      stampValue: HEAD,
    }))).toEqual({ ok: true });
  });
});

describe(' · the final-state invariant is independently checkable', () => {
  it('refuses a run that left the working tree stamped', () => {
    expectRefusal(
      judgeFinalState(state({ publishedReportHead: HEAD, stampValue: HEAD })),
      'tree_dirty',
    );
  });

  it('refuses when the published report does not name the deployed commit', () => {
    expectRefusal(
      judgeFinalState(state({ publishedReportHead: OTHER, stampValue: null })),
      'publish_stale',
    );
    expectRefusal(
      judgeFinalState(state({ publishedReportHead: null, stampValue: null })),
      'publish_stale',
    );
  });

  it('refuses an unresolved HEAD rather than passing it through', () => {
    expectRefusal(
      judgeFinalState(state({ headSha: null, publishedReportHead: HEAD })),
      'head_unresolved',
    );
  });

  it('admits the correctly finished pair, so the invariant is not hardwired to refuse', () => {
    expect(judgeFinalState(state({ publishedReportHead: HEAD, stampValue: null })))
      .toEqual({ ok: true });
  });
});

describe(' · judgeDeployStampReady — the shell deploy entrypoint stamp guard', () => {
  const STAMP = 'a395b89a091529b7e0006adcec43c246698f241d';

  it('POSITIVE CONTROL — a stamp equal to HEAD admits, so the guard is not hardwired to refuse', () => {
    const v = judgeDeployStampReady(STAMP, STAMP, false);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.overridden).toBe(false);
  });

  it('RED CONTROL — a NULL stamp refuses (stamp_missing): this is the incident input', () => {
    const v = judgeDeployStampReady(null, STAMP, false);
    expect(v).toMatchObject({ ok: false, reason: 'stamp_missing' });
  });

  it('RED CONTROL — a stale stamp (valid sha ≠ HEAD) refuses (stamp_mismatch)', () => {
    const v = judgeDeployStampReady(OTHER, STAMP, false);
    expect(v).toMatchObject({ ok: false, reason: 'stamp_mismatch' });
  });

  it('RED CONTROL — a non-sha stamp refuses (stamp_mismatch), never admitted by accident', () => {
    expect(judgeDeployStampReady('null-but-not-the-literal', STAMP, false))
      .toMatchObject({ ok: false, reason: 'stamp_mismatch' });
  });

  it('RED CONTROL — an unresolved HEAD refuses (head_unresolved) rather than trusting the stamp', () => {
    expect(judgeDeployStampReady(STAMP, null, false)).toMatchObject({ ok: false, reason: 'head_unresolved' });
    expect(judgeDeployStampReady(STAMP, 'not-a-sha', false)).toMatchObject({ ok: false, reason: 'head_unresolved' });
  });

  it('the override admits a null stamp deliberately, and marks the verdict overridden', () => {
    const v = judgeDeployStampReady(null, STAMP, true);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.overridden).toBe(true);
  });

  it('every stamp-guard reason is observed firing (no unreachable branch)', () => {
    const fired = new Set(
      [
        judgeDeployStampReady(null, STAMP, false),
        judgeDeployStampReady(OTHER, STAMP, false),
        judgeDeployStampReady(STAMP, null, false),
      ].map((v) => (v.ok ? 'ADMITTED' : v.reason)),
    );
    expect([...fired].sort()).toEqual(['head_unresolved', 'stamp_mismatch', 'stamp_missing']);
  });
});

describe(' · reachability sweep — no refusal branch is unreachable', () => {
  it('every declared refusal reason was actually observed firing', () => {
    // An enumerated guard whose branches are never exercised is indistinguishable
    // from a guard that cannot fire. Reported as a set difference so a NEW reason
    // added without a control fails here rather than shipping untested.
    const observed = new Set<RefusalReason>();
    for (const [step, input] of REFUSAL_INPUTS) {
      const verdict = judgeDeployStep(step, input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) observed.add(verdict.reason);
    }
    const unexercised = REFUSAL_REASONS.filter((r) => !observed.has(r));
    expect({ unexercised, observedCount: observed.size }).toEqual({
      unexercised: [], observedCount: REFUSAL_REASONS.length,
    });
    expect(REFUSAL_REASONS.length).toBeGreaterThanOrEqual(9);
  });
});
