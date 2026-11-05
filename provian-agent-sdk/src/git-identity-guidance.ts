/**
 * git-identity-guidance — the ONE copy source for "register your git identity"
 * guidance (Part 2). Dependency-free (no fetch, no fs) so the observer's
 * GitPlugin, register-device, and the bootstrap can all print the same lines
 * without pulling the relay client in.
 *
 * Why this exists: the GitHub / GitLab / Bitbucket webhook witness credits the
 * commit's git AUTHOR by a registered identity → wallet mapping, and drops a
 * commit whose author has no mapping (`dropped_unmapped_author`,). An
 * agent's own daemon still witnesses its local commits, so nothing is lost —
 * but pushes to a CONNECTED repo only credit the agent once its git author
 * email is registered. This tells the agent exactly how.
 */
import { cliCommand } from './cli-command';

export type GitIdentityProvider = 'github' | 'gitlab' | 'bitbucket';

export interface GitIdentityGuidanceInput {
  /** The git author email detected on this machine (`git config user.email`). */
  authorEmail: string;
  /** Provider to pre-fill; omitted → github (the common case). */
  provider?: GitIdentityProvider;
  /** Installation id to pre-fill when the owner has several installs. */
  installationId?: string;
}

/** The exact one-line command the agent runs. Single source; tests pin it. */
export function registerGitIdentityCommand(input: GitIdentityGuidanceInput): string {
  const parts = [cliCommand('register-git-identity'), `--email ${input.authorEmail}`];
  if (input.provider && input.provider !== 'github') parts.push(`--provider ${input.provider}`);
  if (input.installationId) parts.push(`--installation ${input.installationId}`);
  return parts.join(' ');
}

/**
 * Plain-sentence guidance lines. `hasInstall` is what the caller could learn:
 *   true  → a connected repo exists for this owner; register now.
 *   false → no connected repo yet; the command is still the right next step
 *           once one is connected.
 *   null  → unknown (the caller could not ask the relay); print the
 *           conditional form.
 */
export function gitIdentityGuidanceLines(
  input: GitIdentityGuidanceInput,
  hasInstall: boolean | null,
): string[] {
  const command = registerGitIdentityCommand(input);
  const lead = hasInstall === true
    ? `A connected repository is witnessing pushes. Commits authored as ${input.authorEmail} credit this wallet only once that git identity is registered:`
    : hasInstall === false
      ? `No repository is connected yet. When one is (Provian GitHub App, or a GitLab / Bitbucket webhook), register the git identity ${input.authorEmail} so its pushes credit this wallet:`
      : `If a repository you push to is connected to Provian, commits authored as ${input.authorEmail} credit this wallet only once that git identity is registered:`;
  return [
    lead,
    `  ${command}`,
    '  Local commits are already witnessed by the daemon; this adds the forge-side witness for the same work.',
  ];
}

/**
 * The daemon's per-author hint (logged once per distinct author email). No
 * relay lookup — the daemon holds device credentials, not agent credentials,
 * so it cannot read the mapping list; it can only say what a mapping would do.
 */
export function unmappedAuthorHint(authorEmail: string): string {
  return `commit author ${authorEmail}: a connected repository's webhook credits this author only once the identity is registered — ${registerGitIdentityCommand({ authorEmail })}`;
}
