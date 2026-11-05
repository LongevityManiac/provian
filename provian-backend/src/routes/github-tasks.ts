import { Router, type Request } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { processGitHubReceipt, publishGitHubWebhookInboxHealth, GITHUB_INBOX } from '../core/witnesses/github-webhook-inbox';
import { isGitHubTask } from '../core/witnesses/github-task-queue';
import { GitHubPrApi } from '../core/witnesses/github-pr-api';
import { prGateId, PR_GATES_COLLECTION, syncPrGate, type PrGateDeps, type PrGateRow } from '../core/witnesses/github-pr-gate';
import { finalizeBurn, type BurnFinalityDeps } from '../core/presentation/burn-finality';
import { waitForFinalityWindow } from '../core/presentation/burn-finality-wait';
import { burnFinalityOf } from '../core/presentation/burn-finality-state';
import { PVT_BURN_RECORDS_COLLECTION } from '../core/commons/burn-consumption';
import { authenticateGitHubWorker as verifyWorker } from './middleware/github-worker-auth';

export function createGitHubTaskRouter(deps: AgentBankDeps, authenticateGitHubWorker: (req: Request) => Promise<boolean> = verifyWorker,
  overrides: { gate?: PrGateDeps; finalize?: (deps: BurnFinalityDeps, id: string) => Promise<unknown> } = {}): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    if (!await authenticateGitHubWorker(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
    const task: unknown = req.body;
    if (!isGitHubTask(task)) { res.status(400).json({ error: 'invalid_github_task' }); return; }
    try {
      if (task.kind === 'receipt') {
        await processGitHubReceipt(deps, task.id);
        await publishGitHubWebhookInboxHealth(deps);
        const row = (await deps.db.collection(GITHUB_INBOX).doc(task.id).get()).data();
        // A leased/backed-off row is NOT complete: retain the transport retry until done.
        if (row?.status !== 'done') { res.status(503).json({ error: 'github_receipt_pending' }); return; }
      } else {
        const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(task.repo, task.number));
        const row = (await ref.get()).data() as PrGateRow | undefined;
        if (row?.pending?.burn_id === task.burnId || row?.cleared?.burn_id === task.burnId) {
          if (row.pending) {
            const burn = (await deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(task.burnId).get()).data();
            if (!overrides.finalize && burnFinalityOf(burn) === 'provisional' && burn?.chain === 'base' && typeof burn.tx_hash === 'string') {
              // Cloud Run keeps CPU for this active request; no post-response finalizer is needed.
              await waitForFinalityWindow(burn.tx_hash, { deadlineAtMs: Date.now() + 90_000 });
            }
            await (overrides.finalize ?? finalizeBurn)({ db: deps.db }, task.burnId);
          }
          await syncPrGate(overrides.gate ?? { db: deps.db, api: new GitHubPrApi() }, task.repo, task.number);
          if (((await ref.get()).data() as PrGateRow | undefined)?.pending) {
            res.status(503).json({ error: 'burn_finality_pending' }); return;
          }
        }
      }
      res.json({ ok: true });
    } catch { res.status(503).json({ error: 'github_task_retry' }); }
  });
  return router;
}
