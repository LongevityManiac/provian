import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { BurnConsumptionError } from '../core/commons/burn-consumption';
import { GitHubPrApi, GitHubPrApiError, isPrGateRepository, objectOf } from '../core/witnesses/github-pr-api';
import { acceptPrGatePresentation, issuePrGateChallenge, prGateId, PrGateError, PR_GATES_COLLECTION,
  PR_GATE_PRICE_ATOMIC, readGitHubPr, isPrGateOwner, resolvePrAuthor, syncPrGate, type PrGateRow, type PrGateDeps } from '../core/witnesses/github-pr-gate';
import type { PresentRateLimiter } from './present';
import { enqueueGitHubTask, type GitHubTask } from '../core/witnesses/github-task-queue';

export function createGitHubPrGateRouter(db: Firestore, cache: PresentRateLimiter, overrides?: Partial<PrGateDeps>,
  enqueue: (task: GitHubTask) => Promise<void> = enqueueGitHubTask): Router {
  const router = Router();
  const deps: PrGateDeps = { db, api: new GitHubPrApi(), ...overrides };
  router.use(async (req, res, next) => {
    if (process.env.GITHUB_PR_GATE_ENABLED !== 'true') { res.status(503).json({ error: 'pr_gate_unavailable' }); return; }
    try {
      const limit = await cache.checkRateLimit(`pr-gate:${req.ip}`, 30, 60);
      if (!limit.allowed) { res.status(429).json({ error: 'rate_limited' }); return; }
      res.set('Cache-Control', 'no-store'); next();
    } catch { res.status(503).json({ error: 'pr_gate_unavailable' }); }
  });
  const run = (action: (repo: 'provian' | 'provian-reference-gate', number: number, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const repo = req.params.repo; const number = Number(req.params.number);
      if (!isPrGateRepository(repo) || !/^[1-9][0-9]{0,9}$/.test(req.params.number)) { res.status(404).json({ error: 'gate_not_found' }); return; }
      try { await action(repo, number, req, res); }
      catch (error) {
        if (error instanceof PrGateError || error instanceof BurnConsumptionError) res.status(error.status).json({ error: error.message });
        else if (error instanceof GitHubPrApiError && error.status === 404) res.status(404).json({ error: 'pr_not_found' });
        else res.status(503).json({ error: 'pr_gate_unavailable_retry_same_token' });
      }
    };
  router.get('/:repo/:number', run(async (repo, number, _req, res) => {
    const current = await readGitHubPr(deps, repo, number);
    if (isPrGateOwner(current)) { res.json({ exempt: true, reason: 'repository_owner', minimum_burn_atomic: '0', minimum_burn_pvt: '0' }); return; }
    await syncPrGate(deps, repo, number);
    const row = (await db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number)).get()).data() as PrGateRow | undefined;
    res.json({ cleared: !!row?.cleared && !!await resolvePrAuthor(deps, current, row.cleared.presenter_id), minimum_burn_atomic: PR_GATE_PRICE_ATOMIC.toString(), minimum_burn_pvt: '50' });
  }));
  router.get('/:repo/:number/challenge', run(async (repo, number, req, res) => {
    const walletId = typeof req.query.wallet_id === 'string' ? req.query.wallet_id : undefined;
    res.json(await issuePrGateChallenge(deps, repo, number, walletId));
  }));
  router.post('/:repo/:number/present', run(async (repo, number, req, res) => {
    const token = objectOf(req.body).token;
    if (typeof token !== 'string') { res.status(400).json({ error: 'token_required' }); return; }
    try { await acceptPrGatePresentation(deps, repo, number, token); }
    catch (error) {
      if (error instanceof PrGateError && error.status === 425) {
        const row = (await db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number)).get()).data() as PrGateRow | undefined;
        if (row?.pending) await enqueue({ kind: 'pr_gate', repo, number, burnId: row.pending.burn_id });
      }
      throw error;
    }
    const accepted = (await db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number)).get()).data() as PrGateRow | undefined;
    if (accepted?.cleared) await enqueue({ kind: 'pr_gate', repo, number, burnId: accepted.cleared.burn_id });
    // Acceptance is durable before GitHub writes. Retrying this same token never burns again.
    await syncPrGate(deps, repo, number);
    res.json({ cleared: true });
  }));
  return router;
}
