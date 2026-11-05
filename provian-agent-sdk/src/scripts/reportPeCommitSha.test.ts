import { describe, it, expect } from 'vitest';
import {
  classifyReportPeInvocation, evaluateCommitWitness,
  COMMIT_WITNESS_FRESHNESS_MS, COMMIT_WITNESS_FUTURE_SKEW_MS,
} from './report-pe';

/**
 * report-pe serves only the git post-commit hook. A `--commit-sha` names WHICH commit the
 * hook captured; whether it is a witness (a commit that just happened here) is decided by
 * `evaluateCommitWitness` against git, never by the caller.
 */
describe('report-pe classifyReportPeInvocation ', () => {
  const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

  it('`--hook post-commit` (bare) is hook mode naming HEAD', () => {
    expect(classifyReportPeInvocation(['--hook', 'post-commit'])).toEqual({ mode: 'hook', claimedSha: null });
  });

  it('`--hook post-commit --commit-sha <sha>` names the captured commit', () => {
    expect(classifyReportPeInvocation(['--hook', 'post-commit', '--commit-sha', SHA]))
      .toEqual({ mode: 'hook', claimedSha: SHA });
  });

  it('an unknown --hook value is refused', () => {
    expect(classifyReportPeInvocation(['--hook', 'pre-push', '--commit-sha', SHA]).mode).toBe('refused');
  });

  it('the legacy hook shape names its sha (any case); a non-sha is refused', () => {
    expect(classifyReportPeInvocation(['--type', 'coding_session', '--commit-sha', SHA.toUpperCase(), '--branch', 'main']))
      .toEqual({ mode: 'hook', claimedSha: SHA });
    expect(classifyReportPeInvocation(['--commit-sha', '', '--branch', 'x']).mode).toBe('refused');
    expect(classifyReportPeInvocation(['--hook', 'post-commit', '--commit-sha', 'HEAD~3']).mode).toBe('refused');
  });

  it('every manual invocation is refused', () => {
    expect(classifyReportPeInvocation([]).mode).toBe('refused');
    expect(classifyReportPeInvocation(['--type', 'research', '--description', 'surveyed three designs']).mode).toBe('refused');
    expect(classifyReportPeInvocation(['--type', 'myapp:user_signup']).mode).toBe('refused');
  });

  it('--help is served', () => {
    expect(classifyReportPeInvocation(['--help'])).toEqual({ mode: 'help' });
  });
});

describe('report-pe evaluateCommitWitness ( ): a witness is a commit that just happened here', () => {
  const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
  const NOW = 1_790_000_000_000;

  it('a fresh commit made on this box is a witness', () => {
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: NOW - 2_000 }, NOW))
      .toEqual({ ok: true, commitSha: SHA });
    // The bound is inclusive at exactly the window edge.
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: NOW - COMMIT_WITNESS_FRESHNESS_MS }, NOW).ok)
      .toBe(true);
  });

  it('RED: a commit older than the freshness window is refused (replay of existing history)', () => {
    const v = evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: NOW - COMMIT_WITNESS_FRESHNESS_MS - 1 }, NOW);
    expect(v.ok).toBe(false);
  });

  it('RED: a committer time further in the future than the skew is refused', () => {
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: NOW + COMMIT_WITNESS_FUTURE_SKEW_MS + 1 }, NOW).ok)
      .toBe(false);
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: NOW + COMMIT_WITNESS_FUTURE_SKEW_MS }, NOW).ok)
      .toBe(true);
  });

  it('RED: a commit not in the repo, not reachable from HEAD, or without a committer time is refused', () => {
    expect(evaluateCommitWitness({ resolvedSha: null, madeOnThisBox: false, committerTimeMs: null }, NOW).ok).toBe(false);
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: false, committerTimeMs: NOW }, NOW).ok).toBe(false);
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: null }, NOW).ok).toBe(false);
    expect(evaluateCommitWitness({ resolvedSha: SHA, madeOnThisBox: true, committerTimeMs: Number.NaN }, NOW).ok).toBe(false);
  });
});
