import type { SignedGitHubPrRequest } from './github-pr-request';
import { PrGateError, type PrGateDeps } from './github-pr-gate';
export const APP_PR_REQUESTS = 'github_app_pr_requests_v1';
export const GIT_WITNESS_BOT = 'provian-git-witness[bot]';

/** Retired: an App-authored PR must never charge a different actor's wallet. */
export async function createAgentPr(_deps: PrGateDeps, _request: SignedGitHubPrRequest): Promise<{ number: number; url: string }> {
  throw new PrGateError(410, 'app_authored_prs_disabled_use_authors_own_github_account');
}
