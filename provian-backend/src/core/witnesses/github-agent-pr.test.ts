import { createAgentPr } from './github-agent-pr';
import type { PrGateDeps } from './github-pr-gate';
it('retires App-authored wallet proxy PRs before reading keys, wallets or calling GitHub', async () => {
  const deps = { db: { collection: jest.fn() }, api: { call: jest.fn() } };
  await expect(createAgentPr(deps as unknown as PrGateDeps, {} as never))
    .rejects.toMatchObject({ status: 410, message: 'app_authored_prs_disabled_use_authors_own_github_account' });
  expect(deps.db.collection).not.toHaveBeenCalled();
  expect(deps.api.call).not.toHaveBeenCalled();
});
