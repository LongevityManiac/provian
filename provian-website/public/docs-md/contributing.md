# Contributing to Provian

**The repository owner, LongevityManiac, is exempt:** owner pushes and PRs, including CC/Codex work from the owner’s checkout, need no burn, presentation, gate check or review; direct push and merge are allowed.

For every other PR, **the actual GitHub author presents from its own verified wallet**. A human author uses that human’s wallet in the app; an agent author uses that agent’s wallet through the SDK, MCP or CLI. Another wallet cannot sponsor or pay for the PR. Opening a contributor pull request on **LongevityManiac/provian** or **LongevityManiac/provian-reference-gate** requires a **50 PVT burn-to-present handshake, once per PR**. Provian operates this live gate on its own door. The gate’s identity is **provian.ai**, published at [its well-known key document](https://provian.ai/.well-known/provian-requester.json).

An opened or reopened PR receives the **Provian PR gate** check, the `presentation-required` label and one instructions comment. The check stays unsuccessful until the PR author presents against that PR’s signed challenge with at least 50 PVT burned. A verified presentation clears the PR for ordinary review. Clearance only unlocks merge. After clearance, the repository owner must submit an **Approve** review on the current PR head. For non-owner PRs, Git Witness merges the protected branches; a push requires a fresh approval without another burn. Further pushes and reopening a cleared PR require no additional burn. A presentation for another PR is refused. A burn is destroyed PVT; the gate receives no payment. This is this gate’s configured price; protocol floors and other gates’ prices are unchanged. **Git Witness earning is unchanged: merged commits keep earning.**

## Agent contributor

1. Obtain a wallet before opening the PR. A linked human opens **Connect an agent** in the app and gives the agent the one-time curl command shown there:

   ```sh
   curl -fsSL -H 'x-provian-token: PROV-XXXX-XXXX' https://api.provian.ai/v1/bootstrap/agent | sh
   ```

   The code comes from that human’s app. The command creates the agent wallet, installs its witness and requests the beneficiary link. An independent agent can also create a sovereign wallet through the [SDK or MCP wallet flow](https://provian.ai/docs-md/burn-to-present.md).

2. Prove control of the GitHub account that will author the PR. The CLI starts GitHub device authorization:

   ```sh
   provian git-identity github-link
   # Open verification_uri and authorize user_code as the PR author, then poll:
   provian git-identity github-link --state <state>
   ```

   Poll no faster than the returned `interval` until `status` is `completed`. The SDK uses `githubIdentityLink(config)` followed by `githubIdentityLink(config, state)`; MCP uses `link_github_identity({})` followed by `link_github_identity({state})`. GitHub proves the account id; a claimed username, commit email or Git Witness installation cannot substitute for this proof. The authorization token is used only to read the account identity and is never stored or returned. Git Witness repository installation and earning continue separately.

   The agent opens the PR using its own authenticated GitHub account (for example, `gh pr create`), then presents from its own linked wallet. App-bot PR creation cannot substitute for that authorship and is retired. Atlas pays only for PRs authored by Atlas’s own GitHub account.

3. Open the PR, read the gate comment and fetch the PR-specific challenge. For example, for PR 123 in `provian`:

   ```sh
   GATE=https://api.provian.ai/v1/gates/github/provian/123
   curl -fsS "$GATE/challenge" -o challenge.json
   provian respond --challenge-json @challenge.json --rpc-url https://mainnet.base.org --tier reputation \
     --burn-amount-atomic 50000000000000000000 --yes > response.json
   jq '{token: .token}' response.json | curl -fsS "$GATE/present" \
     -H 'Content-Type: application/json' --data-binary @-
   ```

   Replace `provian` with `provian-reference-gate` for the other repository. If the GitHub account has multiple linked wallets, add `?wallet_id=<wallet-id>` to the challenge URL to select the presenting wallet. The CLI verifies the signed requester and addressed wallet **before burning**. If the gate says finality is pending, retry the final POST with the **same token** after Base finality; do not burn again. If the CLI reports a broadcast burn handle after interruption, resume with its `--burn-tx` and `--burn-amount-atomic` flags. A cleared PR’s challenge endpoint returns `pr_already_cleared`, preventing another burn.

The [SDK](https://github.com/LongevityManiac/provian/tree/master/provian-agent-sdk#prove-yourself-to-a-counterparty-burn-to-present) and [MCP](https://github.com/LongevityManiac/provian/tree/master/provian-mcp) presenter examples use the same gate and the same presentation primitive.

## Human contributor

1. [Get the Provian app](https://provian.ai/download) and create or recover your wallet. In **Connect → GitHub**, link the GitHub account you will use to open the PR. Tap **Link GitHub for the PR gate**, enter the displayed code on GitHub and authorize your PR author account. This verifies account control separately from the Git Witness installation used for repository earnings.
2. Open your PR and follow its gate comment to the [PR gate page](https://provian.ai/gates/pr). Get the signed challenge for that repository and PR number.
3. In the app’s **Present my credentials** outside-gate flow, paste the complete challenge. Check that the requester is verified as **provian.ai**. The app selects **reputation** and displays this gate’s **50 PVT** price. Confirm the burn with biometrics.
4. Copy or share the resulting presentation token back to that PR’s gate page and submit it. The required check passes and the label is removed. If finality is pending, submit the same token again; you do not need another burn.

One burn clears this PR, including later pushes and reopening. Your Git Witness earnings continue unchanged.

## Code and review

Only the Git Witness App can update the protected branches (`master` and `prod` in `provian`, `main` in the reference gate). It checks the exact repository, PR number, author, durable clearance, current head and the repository owner’s approving GitHub review. The review must be submitted **after clearance** and refer to that same head. Clearance, a comment, another reviewer’s approval or an approval from before clearance cannot authorize merge. A later push keeps the clearance and needs a fresh owner approval. Transient merge failures may retry the same explicit approval while its head and review remain current.

GitHub checks attach to commits. The App’s PR-specific clearance and review checks remain authoritative even if another PR reuses a successful commit. Branch protection also requires the gate check and the repository owner’s code-owner review; the App cannot bypass those separate protections. Direct human merges and direct pushes cannot bypass the App’s per-PR admission check.

Describe the behavior changed and the checks run. Preserve wallet custody, mint-once accounting, sealed proofs, signed policy bytes and contract authority boundaries. Use Node 20. In the product repository, run `npm run check:wp2`, `npm run money-path` and relevant full typechecks and tests before pushing; enable local hooks with `git config core.hooksPath .githooks`. In the reference gate repository, run `npm test` and `npm run typecheck`.

The agent SDK, CLI, MCP server, PE specification and contracts are MIT licensed. The wallet, Commons, relay, backend and website are source-visible and proprietary. The reference gate is a separate MIT project. See each repository’s license and disclaimer. Integration starts with the [developer setup](https://provian.ai/docs-md/manual.md) and [PE specification](https://provian.ai/docs-md/pe-protocol-spec.md).
