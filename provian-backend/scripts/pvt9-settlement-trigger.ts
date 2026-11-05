/**
 * Trigger a settlement run ON THE DEPLOYED RELAY and follow it to the end.
 *
 *     npx ts-node scripts/pvt9-settlement-trigger.ts --dry-run [--lane standard|genesis|both]
 *     npx ts-node scripts/pvt9-settlement-trigger.ts --settle  [--lane standard|genesis|both]
 *
 * It calls `POST /v1/internal/settlement/pvt9-run` — the same handler the daily 12:00Z cron
 * calls — with the admin key read from Secret Manager (never printed). The relay keeps every gate;
 * this script decides nothing. `--settle` sends the arming confirmation; `--dry-run` shows what
 * would settle. With neither, it prints this usage and exits.
 *
 * While the request is open it prints each stage from the run's durable records (claims
 * registered, the settlement cycle, each transaction sent, each confirmation, the cycle outcome).
 * Its wait outlasts the longest the relay can hold the request open, and if the answer is lost
 * (a 5xx or a dropped connection) it keeps following the cycle record, which decides the outcome.
 * A run that completes is never reported as a timeout.
 *
 * (`scripts/pvt9-settlement-run.ts` is the other entrypoint: it runs settlement IN THIS PROCESS
 * with local keys. This one runs it on the relay.)
 */

import { execFileSync } from 'child_process';
import * as https from 'https';
import * as admin from 'firebase-admin';
import { ARMING_TOKEN, SETTLEMENT_CYCLE_MAX_RUN_MS } from '../src/core/pvt/wp4/operator-runtime';
import {
  CLAIM_LEDGER_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_CYCLES_COLLECTION,
} from '../src/core/pvt/wp4/durable-settlement-store';
import {
  initialNarratorState,
  judgeFollow,
  narrateProgress,
  settlementWaitBudgetMs,
  type BatchView,
  type CycleView,
  type HttpOutcome,
  type ProgressSnapshot,
} from '../src/core/settlement-monitoring/settlement-progress';
import { scriptDb } from './lib/script-db';

const RELAY_URL = 'https://api.provian.ai/v1/internal/settlement/pvt9-run';
const PROJECT = 'provian-ai';
const SERVICE = 'provian-api';
const REGION = 'us-central1';
const POLL_MS = 5_000;
/** Records written this long before the POST still count as this run's (clock skew). */
const CLOCK_SKEW_MS = 5_000;

function usage(): never {
  console.log('usage: npx ts-node scripts/pvt9-settlement-trigger.ts (--dry-run | --settle) [--lane standard|genesis|both]');
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; lane: string | null } {
  const dryRun = argv.includes('--dry-run');
  const settle = argv.includes('--settle');
  if (dryRun === settle) usage();
  const laneAt = argv.indexOf('--lane');
  const lane = laneAt >= 0 ? argv[laneAt + 1] ?? '' : null;
  if (lane !== null && !['standard', 'genesis', 'both'].includes(lane)) usage();
  return { dryRun, lane };
}

function gcloud(args: string[]): string {
  return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readRequestTimeoutMs(): number | null {
  try {
    const seconds = Number(gcloud([
      'run', 'services', 'describe', SERVICE, '--region', REGION, '--project', PROJECT,
      '--format=value(spec.template.spec.timeoutSeconds)',
    ]));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** One POST with no client-side header or body timeout shorter than `waitMs`. */
function post(body: unknown, adminKey: string, waitMs: number): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(RELAY_URL, {
      method: 'POST',
      headers: {
        'x-admin-key': adminKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: waitMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(waitMs / 60000)} min`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function readSnapshot(db: admin.firestore.Firestore, sinceMs: number): Promise<ProgressSnapshot> {
  const [claims, cycleDocs, batchDocs] = await Promise.all([
    db.collection(CLAIM_LEDGER_COLLECTION).where('created_at', '>=', sinceMs).count().get(),
    db.collection(SETTLEMENT_CYCLES_COLLECTION).where('updated_at', '>=', sinceMs).get(),
    db.collection(SETTLEMENT_BATCHES_COLLECTION).where('updated_at', '>=', sinceMs).get(),
  ]);
  const cycles: CycleView[] = cycleDocs.docs.map((doc) => {
    const d = doc.data();
    const consumed = (d.consumed ?? {}) as Record<string, unknown>;
    const lease = (d.lease ?? null) as Record<string, unknown> | null;
    return {
      cycle_id: str(d.cycle_id) ?? doc.id,
      status: str(d.status) ?? 'unknown',
      stop_reason: str(d.stop_reason),
      batches_confirmed: num(consumed.batches_confirmed),
      claims_settled: num(consumed.claims_settled),
      lease_expires_at_ms: lease && typeof lease.expires_at_ms === 'number' ? lease.expires_at_ms : null,
    };
  });
  const batches: BatchView[] = batchDocs.docs.map((doc) => {
    const d = doc.data();
    const attempts = Array.isArray(d.attempts) ? d.attempts as Array<Record<string, unknown>> : [];
    return {
      batch_id: str(d.batch_id) ?? doc.id,
      cycle_id: str(d.cycle_id) ?? '',
      lane: str(d.lane) ?? '?',
      status: str(d.status) ?? 'unknown',
      claim_count: num(d.claim_count),
      total_minted_atomic: str(d.total_minted_atomic) ?? '0',
      attempt_tx_hashes: attempts.map((a) => str(a.tx_hash)).filter((h): h is string => h !== null),
      confirmed_tx_hash: str(d.confirmed_tx_hash),
      confirmed_block_number: typeof d.confirmed_block_number === 'number' ? d.confirmed_block_number : null,
      dead_reason: str(d.dead_reason),
    };
  });
  return { claimsRegistered: claims.data().count, cycles, batches };
}

function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  return `[+${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s]`;
}

async function main(): Promise<void> {
  const { dryRun, lane } = parseArgs(process.argv.slice(2));
  const adminKey = gcloud(['secrets', 'versions', 'access', 'latest', '--secret', 'admin-api-key', '--project', PROJECT]);
  const waitMs = settlementWaitBudgetMs(readRequestTimeoutMs(), SETTLEMENT_CYCLE_MAX_RUN_MS);

  if (admin.apps.length === 0) admin.initializeApp({ projectId: PROJECT });
  const db = scriptDb();

  const body: Record<string, unknown> = dryRun ? { dryRun: true } : { confirm: ARMING_TOKEN };
  if (lane !== null) body.lane = lane;

  const startMs = Date.now();
  const deadlineMs = startMs + waitMs;
  const say = (line: string): void => console.log(`${elapsed(startMs)} ${line}`);
  say(`${dryRun ? 'dry run' : 'settlement run'} sent to the relay (lane: ${lane ?? 'both'}); `
    + `following it for up to ${Math.round(waitMs / 60000)} min`);

  // Written by the request's callbacks while the loop below polls.
  const relay: { http: HttpOutcome; answer: { status: number; text: string } | null } = {
    http: { kind: 'pending' },
    answer: null,
  };
  post(body, adminKey, waitMs).then(
    (res) => { relay.answer = res; relay.http = { kind: 'answered', status: res.status, atMs: Date.now() }; },
    (err: Error) => { relay.http = { kind: 'lost', reason: err.message, atMs: Date.now() }; },
  );

  let state = initialNarratorState();
  let lastQuietLine = Date.now();
  for (;;) {
    let snap: ProgressSnapshot | null = null;
    try {
      snap = await readSnapshot(db, startMs - CLOCK_SKEW_MS);
      const out = narrateProgress(state, snap);
      state = out.state;
      for (const line of out.lines) say(line);
      if (out.lines.length > 0) lastQuietLine = Date.now();
    } catch (err) {
      say(`(could not read progress records: ${(err as Error).message})`);
    }

    const judgement = judgeFollow({ http: relay.http, cycles: snap?.cycles ?? [], nowMs: Date.now(), deadlineMs });
    if (judgement.done) {
      const { http, answer: final } = relay;
      if (final !== null) {
        say(`relay answered HTTP ${final.status}`);
        console.log(final.text);
      } else if (http.kind === 'lost') {
        say(`relay answer lost (${http.reason}); outcome taken from the cycle record`);
      }
      let ok = judgement.ok;
      if (final !== null && judgement.ok) {
        try {
          if ((JSON.parse(final.text) as { alarm?: unknown }).alarm === true) ok = false;
        } catch { /* a non-JSON 2xx body is printed above and judged by status alone */ }
      }
      say(ok ? `done: ${judgement.reason}` : `NOT OK: ${judgement.reason}${ok === judgement.ok ? '' : ' (relay raised an alarm)'}`);
      process.exit(ok ? 0 : 1);
    }

    if (relay.http.kind === 'lost' && judgement.reason === 'cycle_still_running' && Date.now() - lastQuietLine > 60_000) {
      say('relay answer lost; the cycle is still running, following its record');
      lastQuietLine = Date.now();
    } else if (Date.now() - lastQuietLine > 60_000) {
      say('still running…');
      lastQuietLine = Date.now();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((error) => {
  console.error('settlement trigger failed:', (error as Error).message);
  process.exit(1);
});
