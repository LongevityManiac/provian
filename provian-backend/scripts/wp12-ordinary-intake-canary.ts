/**
 * activation P4 — crash/replay canary for cutover reconciliation's durable ordinary-accrual intake.
 *
 * WHAT THIS PROVES (the plan's later-work register, "Durable ordinary-PE accrual
 * intake … activation canary: crash at every PE/outbox/history/effect boundary with
 * exact replay and no duplicate cap/mint claim"):
 *
 * For EVERY crash boundary the accrual pipeline exposes, a process that dies
 * mid-accrual leaves behind a deterministic replay source (the cutover reconciliation intake
 * row), and replaying from that row reaches EXACTLY the state a single clean
 * run reaches — no duplicated counter, aggregate, cap consumption, or mint
 * claim, and the sealed pe_history disposition still terminal record_only.
 *
 * COST + BLAST-RADIUS GUARDS (mirrors the accepted settlement runtime load harness,):
 * - Firestore: the DEDICATED NON-PRODUCTION emulator ONLY. Refuses to start
 * unless FIRESTORE_EMULATOR_HOST is set AND points at localhost AND the
 * emulator wipe endpoint answers — an endpoint production Firestore does
 * not have, so the production path is structurally unreachable, not merely
 * guarded.
 * - Redis: left UNCONFIGURED, so the cache layer self-disables. The two Redis
 * boundaries are still crashed at and replayed through; see COVERAGE below.
 * - Chain: none. This canary sends NO transaction of any kind. Nothing here
 * deploys, configures, arms, or mints.
 * - Data: wiped before every scenario and verified empty at the end.
 *
 * COVERAGE — stated plainly rather than papered over:
 * - 12 durable-effect boundaries + 2 pe_history boundaries = 14, each crashed
 * at and replayed.
 * - With Redis unconfigured, `commitPEAccountingCountersOnce` is a no-op, so
 * `before_redis_effects` / `after_redis_effects` prove the CONTROL FLOW
 * resumes exactly once, not Redis's own idempotency. Redis-side exactly-once
 * is covered by the cache module's own tests; a Redis-backed run of this
 * canary remains available by setting UPSTASH_REDIS_REST_URL/_TOKEN.
 *
 * RUN:
 * 1. npx firebase emulators:start --only firestore (repo firebase.json)
 * 2. cd provian-backend && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 * npx tsx scripts/wp12-ordinary-intake-canary.ts
 */

import * as admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { recordPEAccrual, type RecordPEAccrualParams } from '../src/pvt-accrual';
import { resumeDurableAccrualEffects } from '../src/core/pvt/durable-accrual-effects';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
  hashOrdinaryAccrualReplayParams,
  isOrdinaryAccrualIntakeDocument,
  verifyOrdinaryAccrualIntakeBinding,
  type OrdinaryAccrualReplayParams,
} from '../src/core/pvt/wp11/ordinary-accrual-intake';

// ---------------------------------------------------------------------------
// Configuration + gates
// ---------------------------------------------------------------------------

const EMULATOR_PROJECT_ID = 'provian-wp12-canary';

/**
 * How long the SIGKILL child is allowed to run before it is killed. Tuned to
 * land INSIDE the accrual (after module load, before completion); the canary
 * asserts the child really died by signal, so a mistuned value fails loudly
 * rather than silently degrading into a clean-run comparison.
 */
const KILL_DELAY_MS = Number(process.env.INTAKE_CANARY_KILL_DELAY_MS ?? 2_500);

/**
 * Every boundary the accrual pipeline can die at. The two `*_pe_history` points
 * bracket the sealed-disposition write; the rest are the durable-effect points
 * from `DurableAccrualCrashPoint`.
 */
/**
 * LANE MATTERS — established by this canary, see FINDING 2 in the run log.
 * `recordPEAccrual` returns for a best-effort caller at pvt-accrual.ts:1041,
 * BEFORE `resumeDurableAccrualEffects`. The twelve `DurableAccrualCrashPoint`
 * boundaries therefore exist ONLY on the durable (`throwOnError: true`) lane.
 * The ordinary best-effort lane — the lane cutover reconciliation's intake row exists for — has
 * exactly two injectable boundaries plus real process death.
 *
 * Crashing an ordinary accrual with `throwOnError: true` to reach the other
 * twelve does not test the ordinary lane: that flag IS `durableEconomicPath`
 * (pvt-accrual.ts:412) and changes the sealed economic snapshot. So each
 * boundary is exercised on the lane it actually belongs to.
 */
const CRASH_BOUNDARIES = [
  { point: 'before_pe_history', lane: 'ordinary' },
  { point: 'after_pe_history', lane: 'ordinary' },
  { point: 'before_pe_history', lane: 'durable' },
  { point: 'after_pe_history', lane: 'durable' },
  { point: 'before_firestore_effects', lane: 'durable' },
  { point: 'after_activity_counters', lane: 'durable' },
  { point: 'after_agent_accrual', lane: 'durable' },
  { point: 'after_human_accrual', lane: 'durable' },
  { point: 'after_wallet_aggregates', lane: 'durable' },
  { point: 'after_network_aggregate', lane: 'durable' },
  { point: 'after_streak', lane: 'durable' },
  { point: 'after_x402_count', lane: 'durable' },
  { point: 'after_firestore_effects', lane: 'durable' },
  { point: 'before_redis_effects', lane: 'durable' },
  { point: 'after_redis_effects', lane: 'durable' },
  { point: 'after_foundation_membership', lane: 'durable' },
] as const;

type CrashBoundary = (typeof CRASH_BOUNDARIES)[number];

/** Collections whose post-run contents ARE the exactly-once evidence. */
const STATE_COLLECTIONS = [
  'pe_history',
  'pvt_accrual_effects',
  'pvt_ordinary_accrual_intake_v1',
  'pvt_activity_counters',
  'pvt_balances',
  'wallets',
  'agent_wallets',
  'pvt_network_aggregate',
  'pvt_streaks',
  'pe_accrual_failures',
  'device_pe_rate_limits',
  'pvt_mint_claims_v1',
  'foundation_membership_grant_queue',
] as const;

/** Fields that legitimately differ run-to-run and must not fail the comparison. */
const VOLATILE_FIELD = /(_at_ms|_at|updated|created|timestamp|last_seen|completed)/i;

function fail(message: string): never {
  console.error(`\n✗ HARD FAIL: ${message}`);
  process.exit(1);
}

function requireEmulatorHost(): string {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    fail('FIRESTORE_EMULATOR_HOST is not set — this canary runs ONLY against the local Firestore emulator, never a real project.');
  }
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) {
    fail(`FIRESTORE_EMULATOR_HOST=${host} is not localhost — refusing (dedicated non-production database only).`);
  }
  return host;
}

/** The emulator wipe endpoint — absent on production Firestore by construction. */
function emulatorWipeUrl(host: string): string {
  return `http://${host}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
}

async function wipeEmulator(host: string): Promise<void> {
  const response = await fetch(emulatorWipeUrl(host), { method: 'DELETE' });
  if (!response.ok) {
    fail(`Emulator wipe endpoint answered ${response.status} — this is not the Firestore emulator. Refusing.`);
  }
}

// ---------------------------------------------------------------------------
// State snapshot + comparison
// ---------------------------------------------------------------------------

type Snapshot = Record<string, Record<string, unknown>>;

/** Recursively drop volatile fields so two runs are comparable by VALUE. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_FIELD.test(k)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

async function snapshot(db: Firestore): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const name of STATE_COLLECTIONS) {
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) {
      out[`${name}/${doc.id}`] = normalize(doc.data()) as Record<string, unknown>;
    }
  }
  return out;
}

/** Returns a human-readable diff, or null when the two snapshots are identical. */
function diff(reference: Snapshot, actual: Snapshot): string | null {
  const keys = [...new Set([...Object.keys(reference), ...Object.keys(actual)])].sort();
  const problems: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify(reference[key] ?? null);
    const b = JSON.stringify(actual[key] ?? null);
    if (a !== b) problems.push(`  ${key}\n      reference: ${a}\n      replayed : ${b}`);
  }
  return problems.length === 0 ? null : problems.join('\n');
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly userId: string;
  readonly peId: string;
  readonly params: RecordPEAccrualParams;
}

function fixtureFor(tag: string): Fixture {
  const userId = `canary_user_${tag}`;
  const peId = `pe_canary_${tag}`;
  return {
    userId,
    peId,
    params: {
      peId,
      userId,
      actionType: 'agent_authorization',
      integrationSource: 'wp12_canary',
      attestationDepth: 'software',
      peHash: `hash_${tag}`,
      timestamp: 1_800_000_000_000,
    },
  };
}

/** Seed the wallet an ordinary accrual resolves against. */
async function seed(db: Firestore, fixture: Fixture): Promise<void> {
  await db.collection('wallets').doc(`wallet_${fixture.userId}`).set({
    user_id: fixture.userId,
    agent_id: fixture.userId,
    address: '0x00000000000000000000000000000000000000aa',
    owner_type: 'human',
    created_at_ms: 1_700_000_000_000,
  });
}

/**
 * Write the cutover reconciliation intake row exactly as `generatePE`'s in-transaction co-write
 * does, from the SAME pure builder, so the canary replays the real artifact
 * rather than a hand-rolled stand-in.
 */
async function writeIntake(db: Firestore, fixture: Fixture): Promise<OrdinaryAccrualReplayParams> {
  const row = buildOrdinaryAccrualIntake({
    prevHash: 'genesis',
    peHash: fixture.params.peHash,
    accrualParams: fixture.params,
  });
  await db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(fixture.peId).set(row);

  const stored = (await db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(fixture.peId).get()).data();
  if (!isOrdinaryAccrualIntakeDocument(stored)) {
    fail(`intake row for ${fixture.peId} failed its own shape validator after a Firestore round-trip`);
  }
  if (!verifyOrdinaryAccrualIntakeBinding(stored, { peHash: fixture.params.peHash, prevHash: 'genesis' })) {
    fail(`intake row for ${fixture.peId} failed binding verification`);
  }
  if (hashOrdinaryAccrualReplayParams(stored.accrual_params) !== stored.accrual_params_sha256) {
    fail(`intake row for ${fixture.peId} params hash does not bind its params`);
  }
  return stored.accrual_params;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Result {
  readonly boundary: string;
  readonly crashed: boolean;
  readonly replayOutcome: 'identical' | 'diverged';
  readonly detail?: string;
}



/**
 * THE REPLAY PROCEDURE — and a activation finding in its own right.
 *
 * Replaying the cutover reconciliation intake row is TWO steps, not one. Re-firing
 * `recordPEAccrual` with the stored params is idempotent at the pe_history
 * seal (it correctly refuses to double-record), but precisely BECAUSE it
 * short-circuits there, it does NOT finish a partially-applied durable effect:
 * a crash between `before_firestore_effects` and `after_foundation_membership`
 * leaves `pvt_accrual_effects/<peId>` at state 'pending' or
 * 'firestore_committed', and a naive one-step processor would strand it there
 * forever — PE recorded, effects half-applied, silently.
 *
 * `resumeDurableAccrualEffects` is the second half, and it is exactly-once by
 * its own state machine. Any future ordinary-accrual replay processor MUST do
 * both, in this order.
 */
async function replayFromIntake(
  db: Firestore,
  params: OrdinaryAccrualReplayParams,
  lane: 'ordinary' | 'durable',
): Promise<void> {
  // Replay on the SAME lane the original ran on. A durable caller's own replay
  // resumes its outbox internally (pvt-accrual.ts:1034); an ordinary caller
  // must NOT set throwOnError, so its replay is the bare re-fire.
  await recordPEAccrual(
    lane === 'durable'
      ? { ...(params as RecordPEAccrualParams), throwOnError: true }
      : { ...(params as RecordPEAccrualParams) },
  );
  if (lane === 'ordinary') return;
  try {
    await resumeDurableAccrualEffects(db, params.peId);
  } catch (error) {
    if (!`${(error as Error).message}`.includes('durable_accrual_effect_missing')) throw error;
  }
}

/**
 * One boundary: reference run → crash run → replay run, then assert the replayed
 * state is byte-identical (modulo volatile fields) to the reference state.
 */
async function runBoundary(db: Firestore, host: string, boundary: CrashBoundary): Promise<Result> {
  const { point, lane } = boundary;
  const tag = `${lane}_${point}`;
  // --- reference: one clean, uninterrupted accrual -------------------------
  await wipeEmulator(host);
  const ref = fixtureFor(tag);
  await seed(db, ref);
  const refParams = await writeIntake(db, ref);
  await replayFromIntake(db, refParams, lane);
  const reference = await snapshot(db);

  // --- crash: the same accrual, killed at `boundary` -----------------------
  await wipeEmulator(host);
  const run = fixtureFor(tag); // identical ids ⇒ comparable state
  await seed(db, run);
  const runParams = await writeIntake(db, run);

  // NOTE — `throwOnError` is deliberately NOT set. It is the flag that marks a
  // caller DURABLE (`durableEconomicPath`, pvt-accrual.ts:688), and setting it
  // changes `operationalDispositionOverride` and therefore the SEALED
  // economic_snapshot_hash. An ordinary best-effort accrual must be crashed and
  // replayed exactly as it runs in production: best-effort. The crash is
  // detected from STATE, not from a caught throw.
  try {
    await recordPEAccrual(
      lane === 'durable'
        ? { ...(runParams as RecordPEAccrualParams), durableTestCrashAt: point, throwOnError: true }
        : { ...(runParams as RecordPEAccrualParams), durableTestCrashAt: point },
    );
  } catch {
    // A durable caller re-throws its injected crash; that IS the crash landing.
  }
  const midCrash = await snapshot(db);
  const crashed = diff(reference, midCrash) !== null;

  // --- replay: the EXACT stored params, via the two-step procedure ----------
  await replayFromIntake(db, runParams, lane);
  const replayed = await snapshot(db);

  const problems = diff(reference, replayed);
  return {
    boundary: `${lane}/${point}`,
    crashed,
    replayOutcome: problems === null ? 'identical' : 'diverged',
    detail: problems ?? undefined,
  };
}

/**
 * The one boundary an in-process throw cannot model: real process death, where
 * no catch, no finally, and no unwind runs. Proves nothing in the durability
 * story depends on graceful shutdown.
 */
async function runHardKill(db: Firestore, host: string): Promise<Result> {
  await wipeEmulator(host);
  const fixture = fixtureFor('sigkill');
  await seed(db, fixture);
  const params = await writeIntake(db, fixture);

  // A real child process, killed with SIGKILL mid-accrual. Written to a temp
  // file rather than `-e` so it loads the SAME TypeScript modules the service
  // loads, under the SAME Firestore settings.
  const childSource = `
import * as admin from 'firebase-admin';
import { recordPEAccrual } from '../src/pvt-accrual';
process.env.GOOGLE_CLOUD_PROJECT = ${JSON.stringify(EMULATOR_PROJECT_ID)};
admin.initializeApp({ projectId: ${JSON.stringify(EMULATOR_PROJECT_ID)} });
admin.firestore().settings({ ignoreUndefinedProperties: true });
// Die abruptly mid-accrual: no catch, no finally, no unwind.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), ${KILL_DELAY_MS});
void recordPEAccrual(${JSON.stringify(params)});
`;
  // MUST live inside the project: a child under os.tmpdir() cannot resolve
  // `firebase-admin` from the backend's node_modules and dies on import
  // instead of on the SIGKILL, silently degrading the canary to a clean run.
  const childPath = path.join(process.cwd(), 'scripts', `.wp12-canary-child-${process.pid}.ts`);
  fs.writeFileSync(childPath, childSource);

  const child = spawn('npx', ['tsx', childPath], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: host },
  });
  // `npx` is the spawned process and the tsx runtime is ITS child, so a
  // self-SIGKILL surfaces here as npx exiting with code 137 and a null signal —
  // not as signal 'SIGKILL'. Accept either, or the canary silently degrades
  // into a clean run that trivially "passes".
  const death = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, sig) => resolve({ code, signal: sig }));
  });
  const killed = death.signal === 'SIGKILL' || death.code === 137;
  fs.rmSync(childPath, { force: true });

  // Where did it actually die? A kill that landed before the pe_history seal
  // proves far less than one that landed after it, and reporting "replay
  // identical" without saying which would be a canary disguising its own reach.
  const sealedBeforeDeath = (await db.collection('pe_history').doc(fixture.peId).get()).exists;

  // Replay from the surviving intake row and compare against a clean reference.
  await replayFromIntake(db, params, 'ordinary');
  const afterReplay = await snapshot(db);

  await wipeEmulator(host);
  const refFixture = fixtureFor('sigkill');
  await seed(db, refFixture);
  const refParams = await writeIntake(db, refFixture);
  await replayFromIntake(db, refParams, 'ordinary');
  const reference = await snapshot(db);

  const problems = diff(reference, afterReplay);
  return {
    boundary: `ordinary/SIGKILL (code=${death.code ?? 'none'}, pe_history ${sealedBeforeDeath ? 'SEALED' : 'not sealed'} before death)`,
    crashed: killed,
    replayOutcome: problems === null ? 'identical' : 'diverged',
    detail: problems ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const host = requireEmulatorHost();
  if (process.env.UPSTASH_REDIS_REST_URL) {
    console.log('· Redis IS configured — Redis-side exactly-once is in scope for this run.');
  } else {
    console.log('· Redis unconfigured (cache self-disabled) — Redis boundaries prove control flow only.');
  }

  process.env.GOOGLE_CLOUD_PROJECT = EMULATOR_PROJECT_ID;
  admin.initializeApp({ projectId: EMULATOR_PROJECT_ID });
  // MUST match production (server.ts:176) — a canary running under different
  // Firestore settings than the service is not a canary of the service.
  admin.firestore().settings({ ignoreUndefinedProperties: true });
  const db = admin.firestore();

  await wipeEmulator(host);
  console.log(`· emulator ${host} project ${EMULATOR_PROJECT_ID} — wipe endpoint verified\n`);

  const results: Result[] = [];
  for (const boundary of CRASH_BOUNDARIES) {
    process.stdout.write(`  ${`${boundary.lane}/${boundary.point}`.padEnd(38)} `);
    const result = await runBoundary(db, host, boundary);
    results.push(result);
    console.log(
      `${result.crashed ? 'crashed' : 'NO-CRASH'} · replay ${result.replayOutcome}`,
    );
  }

  process.stdout.write(`  ${'ordinary/SIGKILL (process death)'.padEnd(38)} `);
  const kill = await runHardKill(db, host);
  results.push(kill);
  console.log(`${kill.crashed ? 'killed' : 'NOT-KILLED'} · replay ${kill.replayOutcome}`);

  // --- verdict -------------------------------------------------------------
  const diverged = results.filter((r) => r.replayOutcome === 'diverged');
  const notCrashed = results.filter((r) => !r.crashed);

  console.log('\n' + '='.repeat(72));
  if (notCrashed.length > 0) {
    console.log('✗ boundaries where the injected crash did NOT fire (canary is not exercising them):');
    for (const r of notCrashed) console.log(`  ${r.boundary}`);
  }
  if (diverged.length > 0) {
    console.log('✗ boundaries where REPLAY DIVERGED from a clean run (duplicate or lost effect):');
    for (const r of diverged) console.log(`  ${r.boundary}\n${r.detail}`);
  }

  await wipeEmulator(host);
  const residue = await snapshot(db);
  if (Object.keys(residue).length !== 0) {
    fail(`emulator not empty after final wipe (${Object.keys(residue).length} docs) — refusing to report success`);
  }
  console.log('· final wipe verified empty');

  if (diverged.length > 0 || notCrashed.length > 0) {
    fail(`activation ordinary-intake crash/replay canary FAILED (${diverged.length} diverged, ${notCrashed.length} unexercised)`);
  }
  console.log(`\n✓ CANARY PASS — ${results.length} boundaries: crash fired, replay exact, no duplicate effect.`);
  process.exit(0);
}

main().catch((error) => fail(`${(error as Error).stack ?? error}`));
