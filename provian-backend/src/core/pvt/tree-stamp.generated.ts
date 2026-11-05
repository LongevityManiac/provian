/**
 * GENERATED AT DEPLOY TIME — checked in as null on purpose.
 *
 * `scripts/stamp-tree-for-deploy.mjs` writes the deploying commit's git HEAD
 * here (clean-tree enforced) immediately before the image build, and
 * `--reset` restores the null after. The repository copy is ALWAYS null:
 * a null stamp makes `judgeStandardLaneAdmission` refuse with
 * `runtime_tree_unstamped`, so an image built outside the stamped flow
 * fail-closes the standard settlement lane rather than settling against a
 * reconciliation of an unknowable tree.
 *
 * Do not hand-edit a real sha into this file: a committed stamp would claim
 * every later commit as its own, which is the staleness lie the stamp exists
 * to make impossible.
 */
export const DEPLOYED_TREE_GIT_HEAD: string | null = null;
