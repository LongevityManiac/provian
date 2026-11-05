/** Authenticated durable receipt and push dispatch before acknowledgement; retries survive scale-to-zero. */
import crypto from 'crypto';
import { Timestamp, FieldValue, FieldPath } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import type { GeneratePEParams } from '../agent-bank/pe-utils';
import { bumpOpsCounter, flushOpsCounters } from '../observability/ops-counters';
import { handleGitHubWebhook, verifyGitHubSignature, type GitHubWebhookInput, type GitHubWebhookResult } from './github-webhook';
import { loadGitHubAppConfig } from './github-app-config';
import { checkAndMarkDelivery } from './github-webhook';
import { enqueueGitHubTask, type GitHubTask } from './github-task-queue';

export const GITHUB_INBOX = 'github_webhook_inbox_v1';
const LEASE_MS = 30 * 60_000; // longer than Cloud Run's maximum request duration
const RETENTION_MS = 90 * 86_400_000;
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export async function acceptGitHubWebhook(deps: Pick<AgentBankDeps, 'db'>, input: GitHubWebhookInput,
  enqueue: (task: GitHubTask) => Promise<void> = enqueueGitHubTask): Promise<GitHubWebhookResult> {
  if (!input.config.enabled || !input.config.webhookSecret) return { status: 503, body: { error: 'github_webhook_not_configured' } };
  if (!verifyGitHubSignature(input.rawBody, input.signatureHeader, input.config.webhookSecret)) {
    bumpOpsCounter('gitwitness.invalid_signature');
    return { status: 401, body: { error: 'invalid_signature' } };
  }
  if (!input.eventType || !/^[a-z][a-z0-9_]{0,63}$/.test(input.eventType) ||
      !input.deliveryId || !/^[a-zA-Z0-9-]{1,100}$/.test(input.deliveryId)) return { status: 400, body: { error: 'invalid_delivery_headers' } };
  try {
    const payload = JSON.parse(input.rawBody);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('shape');
  } catch { return { status: 400, body: { error: 'invalid_payload' } }; }
  const ref = deps.db.collection(GITHUB_INBOX).doc(digest(input.deliveryId));
  const bodyHash = digest(`${input.eventType}\n${input.rawBody}`);
  let deadline: NodeJS.Timeout | undefined;
  try {
    const receipt = deps.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return snap.data()?.body_hash !== bodyHash ? 'conflict' : snap.data()?.status === 'done' ? 'done' : 'duplicate';
      const now = Date.now();
      tx.set(ref, {
        delivery_id: input.deliveryId, event_type: input.eventType, raw_body: input.rawBody,
        body_hash: bodyHash, received_at: now, available_at: now, status: 'pending', attempts: 0,
        // No expiry on unprocessed work. The private-store facade encrypts payload and plan.
      });
      return 'accepted';
    }, { maxAttempts: 2 }).then(async result => {
      if (result === 'accepted' || result === 'duplicate') await enqueue({ kind: 'receipt', id: ref.id });
      return result;
    });
    // A late commit is safe: a retry reads the same durable receipt. Never send a success
    // before commit, and return a retryable failure before GitHub's ten-second deadline.
    const result = await Promise.race([receipt, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('github_receipt_deadline')), 5000);
    })]);
    if (result === 'conflict') return { status: 400, body: { error: 'delivery_content_conflict' } };
    return { status: 200, body: { ok: true, durable: true, idempotent: result !== 'accepted' } };
  } catch {
    bumpOpsCounter('gitwitness.receipt_failed');
    return { status: 503, body: { error: 'github_receipt_unavailable' } };
  } finally { if (deadline) clearTimeout(deadline); }
}

/** A retry reuses the exact frozen PE input and id, including after seal-before-completion crashes. */
export async function processGitHubReceipt(deps: AgentBankDeps, id: string,
  config = loadGitHubAppConfig(), now = Date.now()): Promise<boolean> {
  const ref = deps.db.collection(GITHUB_INBOX).doc(id);
  const token = crypto.randomUUID();
  const row = await deps.db.runTransaction(async tx => {
    const snap = await tx.get(ref); const value = snap.data();
    if (!value || value.status === 'done' || value.available_at > now) return null;
    tx.update(ref, { status: 'processing', lease: token, available_at: now + LEASE_MS, attempts: (value.attempts ?? 0) + 1 });
    return value;
  });
  if (!row) return false;
  const ownedWrite = async (patch: Record<string, unknown>) => deps.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.data()?.lease !== token) throw new Error('github_receipt_lease_lost');
    tx.update(ref, patch);
  });
  try {
    if (!config.enabled || !config.webhookSecret) throw new Error('github_worker_not_configured');
    // Only the trusted encrypted inbox is read here. Re-signing with the current secret permits
    // secret rotation without stranding receipts already authenticated at ingress.
    const signatureHeader = `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(row.raw_body).digest('hex')}`;
    const result = await handleGitHubWebhook(deps, {
      rawBody: row.raw_body, eventType: row.event_type, deliveryId: row.delivery_id, signatureHeader, config,
      durable: {
        receivedAt: row.received_at, preparedPE: row.prepared_pe,
        preparePE: async params => {
          if (row.prepared_pe) return row.prepared_pe as GeneratePEParams;
          const prepared = JSON.parse(JSON.stringify({ ...params, peIdOverride: `pe_gh_${id}`, timestampOverride: row.received_at }));
          await ownedWrite({ prepared_pe: prepared });
          row.prepared_pe = prepared;
          return prepared;
        },
      },
    });
    // A missing/revoked installation is not silently thrown away; repair and retry remain possible.
    if (result.status !== 200) throw new Error(`github_processing_${result.status}`);
    // Keep the old receipt namespace for compatibility with deliveries processed before this change.
    // Deterministic PE identity protects the seal if this completion write is interrupted.
    const installation = JSON.parse(row.raw_body).installation;
    if (installation?.id) {
      const { getServiceInstallByInstallationId } = await import('./service-installs');
      const install = await getServiceInstallByInstallationId(deps.db, 'github', String(installation.id));
      if (install) await checkAndMarkDelivery(deps, { userId: install.user_id, provider: 'github', deliveryId: row.delivery_id });
    }
    await ownedWrite({ status: 'done', completed_at: Date.now(), available_at: Number.MAX_SAFE_INTEGER,
      result: result.body, raw_body: FieldValue.delete(), prepared_pe: FieldValue.delete(), expire_at: Timestamp.fromMillis(Date.now() + RETENTION_MS) });
    bumpOpsCounter('gitwitness.processed');
    return true;
  } catch {
    const attempts = (row.attempts ?? 0) + 1;
    await ownedWrite({ status: 'pending', available_at: Date.now() + Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempts, 10)), last_failure_at: Date.now() });
    bumpOpsCounter('gitwitness.processing_retry');
    return false;
  }
}

export async function drainGitHubWebhookInbox(deps: AgentBankDeps): Promise<{ processed: number; pending_sample: number; alarm: boolean }> {
  const started = Date.now(); let processed = 0;
  const rows = await deps.db.collection(GITHUB_INBOX).where('available_at', '<=', started).orderBy('available_at').limit(20).get();
  for (const row of rows.docs) {
    if (Date.now() - started > 45_000) break;
    if (await processGitHubReceipt(deps, row.id)) processed++;
  }
  return { processed, ...await publishGitHubWebhookInboxHealth(deps) };
}

/** Event-driven health plus the daily recovery snapshot; no empty-queue timer. */
export async function publishGitHubWebhookInboxHealth(deps: Pick<AgentBankDeps, 'db'>): Promise<{ pending_sample: number; alarm: boolean }> {
  const pending = await deps.db.collection(GITHUB_INBOX).where('available_at', '<', Number.MAX_SAFE_INTEGER).limit(100).get();
  const oldest = pending.docs.reduce((min, row) => Math.min(min, Number(row.data().received_at)), Date.now());
  const alarm = pending.docs.length > 0 && Date.now() - oldest > 10 * 60_000;
  await deps.db.collection('system_status').doc('github_webhook_inbox').set({
    checked_at: Date.now(), timestamp: Date.now(), pending_sample: pending.docs.length,
    oldest_pending_at: pending.docs.length ? oldest : null, alarm,
    verdict: alarm ? 'GitHub deliveries are durably retained but processing is delayed' : 'GitHub durable worker healthy',
  });
  await flushOpsCounters(deps.db);
  return { pending_sample: pending.docs.length, alarm };
}

/** Daily lost-event net. Requeue due rows without making the scheduler the processing path. */
export async function redispatchGitHubWebhookInbox(deps: Pick<AgentBankDeps, 'db'>,
  enqueue: (task: GitHubTask) => Promise<void> = enqueueGitHubTask): Promise<number> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let count = 0;
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    let query = deps.db.collection(GITHUB_INBOX).where('available_at', '<=', started)
      .orderBy('available_at').orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const rows = await query.get();
    for (const row of rows.docs) { await enqueue({ kind: 'receipt', id: row.id }); count++; }
    if (rows.docs.length < 100) break;
    cursor = rows.docs[rows.docs.length - 1];
  }
  await publishGitHubWebhookInboxHealth(deps);
  return count;
}
