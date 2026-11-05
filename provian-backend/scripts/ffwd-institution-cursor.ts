/**
 * One-off operator action : fast-forward the institution-funding watcher
 * cursor (`pvt_institution_watcher_checkpoints_v1/8453`) over its empty backlog.
 *
 * Sibling of `ffwd-outbound-cursor.ts`; same `commitWatcherCheckpoint`
 * compare-and-set, same exhaustiveness gate and RED-control discipline, with the
 * predicate adapted to THIS watcher's fence shape:
 *
 * - The cursor (49,502,208, cold-started 2026-08-03 at its finality ceiling)
 * sits ABOVE all three institution deployment blocks (earliest 49,367,232),
 * so — unlike, where the cursor sat BELOW the proof fence and only the
 * post-fence window was swept — there is NO code-empty sub-region inside the
 * backlog. The ENTIRE backlog [cursor+1, jumpTarget] is swept.
 * - The watcher's ceiling is min(finalized head-11, L1-batched SAFE HEAD)
 *, not head-12. The predicate refuses a jumpTarget above THAT ceiling.
 *
 * Two independent guarantees the backlog cannot pay, each verified live:
 * (A) SWEEP / did-not-occur: two independent exhaustive archives (base.org +
 * Tenderly) sweep the 6 funding events across all 3 contracts over
 * [cursor+1, jumpTarget] = 0 logs. Contracts are live across the whole
 * window (all deployed << cursor+1), so 0 logs is a real did-not-occur, not
 * a not-yet-deployed artifact.
 * (B) platform:'test' / cannot-pay: `institution-funding-watcher.ts:1329` refuses
 * a `platform:'test'` owner, and every agent_wallet in the system is
 * platform:'test' (18/18) — so no funding could resolve to a payable actor
 * even if one existed. Its permanent RED control is
 * `institution-funding-watcher.test.ts:1099`.
 *
 * The deployment-block fence still holds (nothing below 49,367,232 can emit) but
 * lies below the backlog and is not load-bearing for this jump; (A) and (B) are.
 *
 * SIX RED controls must all REFUSE before the compare-and-set commit runs.
 * DRY_RUN=1 runs the sweep + controls without writing.
 *
 * Run: DRY_RUN=1 npx tsx scripts/ffwd-institution-cursor.ts (then without DRY_RUN)
 */
import admin from 'firebase-admin';
import {
  commitWatcherCheckpoint,
  readWatcherCheckpointSnapshot,
} from '../src/core/pvt/watcher-address-admission';
import {
  INSTITUTION_CHECKPOINT_COLLECTION,
  INSTITUTION_WATCHER_CHAIN_ID,
  INSTITUTION_CONFIRMATION_FLOOR,
  INSTITUTION_ADDRESSES,
  INSTITUTION_FUNDING_EVENTS,
} from '../src/core/pvt/institution-funding-watcher';
import { scriptDb } from './lib/script-db';

const CHAIN_ID = INSTITUTION_WATCHER_CHAIN_ID; // 8453
// jumpTarget: pinned below the current safe head; the live ceiling only grows, so
// a fixed target stays valid. Leaves ~1k blocks for the watcher to drain live on
// its first scheduled tick (proving the cron works, mirroring 's remainder).
const JUMP_TARGET = 49_660_000;

// The six funding topic0s, DERIVED from the module's own event specs (never pasted),
// across the three deployed institution addresses. If a signature moved, the topic
// moves with it — the watcher would be listening for a topic no contract emits and
// this sweep would inherit the same (correct) empty result.
const FUNDING_TOPIC0S = Object.freeze(
  Array.from(new Set(INSTITUTION_FUNDING_EVENTS.map((e) => e.topic0))),
);
const FUNDING_ADDRESSES = Object.freeze([
  INSTITUTION_ADDRESSES.escrow,
  INSTITUTION_ADDRESSES.promise,
  INSTITUTION_ADDRESSES.pool,
]);
// Deployment blocks (from base-pvt9-institutions.json tx hashes, read on-chain
// 2026-08-07). The watched population + the contract-liveness fence.
const CONTRACT_DEPLOYS: ReadonlyArray<{ name: string; deployBlock: number }> = Object.freeze([
  { name: 'escrowV4', deployBlock: 49_367_232 },
  { name: 'promiseV3', deployBlock: 49_367_461 },
  { name: 'poolV3', deployBlock: 49_367_467 },
]);

// USDC on Base — the positive-control canary (a high-volume address+topic filter
// that MUST surface logs, proving the archive's eth_getLogs is not silently empty).
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface Sweep {
  name: string; exhaustive: boolean; logCount: number;
  fromBlock: number; toBlock: number; posControlPass: boolean;
}
interface Contract { name: string; deployBlock: number }
type Auth = { ok: boolean; status: string; ceiling?: number; cursorNext?: number };

/** The single authorization predicate. GREEN on real inputs; every RED control
 * feeds a mutated input to THIS function and asserts it refuses. Adapted from
 * 's `authorizeJump` to the institution watcher's fence shape. */
function authorizeJump(a: {
  contracts: Contract[];
  cursorLastProcessed: number;
  jumpTarget: number;
  head: number;
  safeHead: number;
  sweeps: Sweep[];
}): Auth {
  const cursorNext = a.cursorLastProcessed + 1;
  // Non-vacuous population (empty-population guard).
  if (!Array.isArray(a.contracts) || a.contracts.length === 0) {
    return { ok: false, status: 'EMPTY_POPULATION' };
  }
  const deploys = a.contracts.map((c) => c.deployBlock);
  if (deploys.some((f) => !Number.isSafeInteger(f) || f < 0)) {
    return { ok: false, status: 'BAD_DEPLOY_BLOCK' };
  }
  // THE WATCHER'S REAL CEILING : min(finalized head-11, safe head), NOT
  // head-12. Inclusive floor: at 12 confirmations `head - 11` is eligible.
  if (!Number.isSafeInteger(a.head) || !Number.isSafeInteger(a.safeHead)) {
    return { ok: false, status: 'BAD_HEAD' };
  }
  const finalized = a.head - (INSTITUTION_CONFIRMATION_FLOOR - 1);
  const ceiling = Math.min(finalized, a.safeHead);
  if (!Number.isSafeInteger(a.jumpTarget) || a.jumpTarget > ceiling) {
    return { ok: false, status: 'ABOVE_SAFE_HEAD_CEIL' };
  }
  if (a.jumpTarget <= a.cursorLastProcessed) {
    return { ok: false, status: 'NOT_FORWARD' };
  }
  // Every swept contract must be LIVE across the whole backlog, else its 0-log
  // result is a not-yet-deployed artifact, not a did-not-occur (vacuous pass).
  if (Math.max(...deploys) > cursorNext) {
    return { ok: false, status: 'CONTRACT_NOT_LIVE_ACROSS_BACKLOG' };
  }
  const good = a.sweeps.filter(
    (s) => s.exhaustive === true && s.logCount === 0 && s.posControlPass === true,
  );
  if (good.length < 2) return { ok: false, status: 'INSUFFICIENT_EXHAUSTIVE_SWEEPS' };
  const sweepFloor = Math.max(...good.map((s) => s.fromBlock));
  const sweepCeil = Math.min(...good.map((s) => s.toBlock));
  // The sweep must tile the ENTIRE backlog from the first unscanned block. A floor
  // above cursor+1 leaves an unswept, unguaranteed gap at the bottom of the backlog.
  if (sweepFloor > cursorNext) return { ok: false, status: 'SWEEP_FLOOR_ABOVE_BACKLOG' };
  if (a.jumpTarget > sweepCeil) return { ok: false, status: 'JUMP_ABOVE_SWEEP_CEIL' };
  return { ok: true, status: 'GREEN', ceiling, cursorNext };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(u: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = (await r.json()) as { error?: unknown; result?: unknown };
  if (j.error) throw new Error('rpc ' + JSON.stringify(j.error).slice(0, 90));
  return j.result;
}

async function exhaustiveSweep(
  name: string, u: string, chunk: number, from: number, to: number,
): Promise<Sweep> {
  const chunks: Array<{ from: number; to: number }> = [];
  for (let s = from; s <= to; s += chunk) chunks.push({ from: s, to: Math.min(s + chunk - 1, to) });
  let tiling = chunks[0].from === from && chunks[chunks.length - 1].to === to;
  for (let i = 1; i < chunks.length; i++) if (chunks[i].from !== chunks[i - 1].to + 1) tiling = false;
  const covered = chunks.reduce((acc, c) => acc + (c.to - c.from + 1), 0);
  let failed = 0; let logs = 0;
  for (const c of chunks) {
    let ok = false;
    for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
      try {
        const res = await rpc(u, 'eth_getLogs', [{
          fromBlock: '0x' + c.from.toString(16),
          toBlock: '0x' + c.to.toString(16),
          address: FUNDING_ADDRESSES,
          topics: [FUNDING_TOPIC0S],
        }]);
        logs += res.length; ok = true;
      } catch { await sleep(250 * attempt); }
    }
    if (!ok) failed++;
    await sleep(15);
  }
  // positive control: a populated address+topic-array filter (USDC Transfer) over a
  // small window near the top must return >=1 — proves eth_getLogs is not silently
  // empty for the query SHAPE the sweep uses.
  let posControlPass = false;
  try {
    const s = await rpc(u, 'eth_getLogs', [{
      fromBlock: '0x' + (to - 3).toString(16),
      toBlock: '0x' + to.toString(16),
      address: USDC,
      topics: [[TRANSFER]],
    }]);
    posControlPass = Array.isArray(s) && s.length >= 1;
  } catch { posControlPass = false; }
  const exhaustive = tiling && failed === 0 && covered === (to - from + 1);
  return { name, exhaustive, logCount: logs, fromBlock: from, toBlock: to, posControlPass };
}

async function readSafeHead(u: string): Promise<number> {
  const b = await rpc(u, 'eth_getBlockByNumber', ['safe', false]);
  if (!b || typeof b.number !== 'string') throw new Error('no_safe_block');
  return parseInt(b.number, 16);
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb();

  const head = parseInt(await rpc('https://mainnet.base.org', 'eth_blockNumber', []), 16);
  const safeHead = await readSafeHead('https://mainnet.base.org');
  const finalized = head - (INSTITUTION_CONFIRMATION_FLOOR - 1);
  const ceiling = Math.min(finalized, safeHead);
  const current = await readWatcherCheckpointSnapshot(db as any, INSTITUTION_CHECKPOINT_COLLECTION, CHAIN_ID);
  const cursorNext = (current.lastProcessedBlock ?? -1) + 1;
  console.log('LIVE STATE:', JSON.stringify({
    head, safeHead, finalized, ceiling, jumpTarget: JUMP_TARGET,
    cursor: current, cursorNext,
    backlogBlocks: ceiling - (current.lastProcessedBlock ?? -1),
    contracts: CONTRACT_DEPLOYS, fundingTopic0Count: FUNDING_TOPIC0S.length,
  }));

  console.log('Sweeping backlog [', cursorNext, ',', JUMP_TARGET, '] on two independent archives (fresh)...');
  const baseorg = await exhaustiveSweep('base.org', 'https://mainnet.base.org', 10_000, cursorNext, JUMP_TARGET);
  const tenderly = await exhaustiveSweep('Tenderly', 'https://base.gateway.tenderly.co', 2_000, cursorNext, JUMP_TARGET);
  console.log('SWEEP base.org :', JSON.stringify(baseorg));
  console.log('SWEEP Tenderly :', JSON.stringify(tenderly));
  const sweeps = [baseorg, tenderly];
  // A simulated non-exhaustive run (as if an archive 429-throttled some chunks) —
  // the RED-4 negative-control input.
  const nonExhaustive: Sweep = {
    name: 'throttled', exhaustive: false, logCount: 0,
    fromBlock: cursorNext, toBlock: JUMP_TARGET, posControlPass: true,
  };

  const base = {
    contracts: CONTRACT_DEPLOYS.map((c) => ({ ...c })),
    cursorLastProcessed: current.lastProcessedBlock ?? -1,
    jumpTarget: JUMP_TARGET, head, safeHead, sweeps,
  };

  const green = authorizeJump(base);
  const red1 = authorizeJump({ ...base, sweeps: [{ ...baseorg, fromBlock: cursorNext + 1 }, { ...tenderly, fromBlock: cursorNext + 1 }] });
  const red2 = authorizeJump({ ...base, contracts: [] });
  const red3 = authorizeJump({ ...base, jumpTarget: Math.min(baseorg.toBlock, tenderly.toBlock) + 1 });
  const red4 = authorizeJump({ ...base, sweeps: [baseorg, nonExhaustive] });
  const red5 = authorizeJump({ ...base, jumpTarget: ceiling + 1 });
  const red6 = authorizeJump({ ...base, contracts: [...CONTRACT_DEPLOYS, { name: 'INJECTED', deployBlock: cursorNext + 1 }] });

  console.log('GREEN                 :', JSON.stringify(green));
  console.log('RED1 backlog-floor gap:', JSON.stringify(red1), '(expect SWEEP_FLOOR_ABOVE_BACKLOG)');
  console.log('RED2 empty-population :', JSON.stringify(red2), '(expect EMPTY_POPULATION)');
  console.log('RED3 jump>sweepCeil   :', JSON.stringify(red3), '(expect JUMP_ABOVE_SWEEP_CEIL)');
  console.log('RED4 non-exhaustive   :', JSON.stringify(red4), '(expect INSUFFICIENT_EXHAUSTIVE_SWEEPS)');
  console.log('RED5 above-safe-ceil  :', JSON.stringify(red5), '(expect ABOVE_SAFE_HEAD_CEIL)');
  console.log('RED6 contract-not-live:', JSON.stringify(red6), '(expect CONTRACT_NOT_LIVE_ACROSS_BACKLOG)');

  const controlsPass =
    green.ok === true &&
    red1.ok === false && red1.status === 'SWEEP_FLOOR_ABOVE_BACKLOG' &&
    red2.ok === false && red2.status === 'EMPTY_POPULATION' &&
    red3.ok === false && red3.status === 'JUMP_ABOVE_SWEEP_CEIL' &&
    red4.ok === false && red4.status === 'INSUFFICIENT_EXHAUSTIVE_SWEEPS' &&
    red5.ok === false && red5.status === 'ABOVE_SAFE_HEAD_CEIL' &&
    red6.ok === false && red6.status === 'CONTRACT_NOT_LIVE_ACROSS_BACKLOG';

  if (!controlsPass) {
    console.error('STOP: a RED control did not refuse as expected, or GREEN was not authorized. NO WRITE.');
    process.exit(2);
  }
  console.log('ALL CONTROLS PASS (GREEN authorized, 6 RED controls refused).');

  if ((current.lastProcessedBlock ?? -1) >= JUMP_TARGET) {
    console.log('Cursor already >= target; nothing to do.');
    return;
  }
  if (dryRun) {
    console.log('DRY_RUN=1 — controls verified, cursor NOT moved.');
    return;
  }

  let expected = current;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const after = await commitWatcherCheckpoint(
        db as any, INSTITUTION_CHECKPOINT_COLLECTION, CHAIN_ID, expected, JUMP_TARGET, Date.now(),
      );
      console.log('COMMITTED. before=', JSON.stringify(current), 'after=', JSON.stringify(after));
      return;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('watcher_checkpoint_changed') || msg.includes('watcher_membership_generation_changed')) {
        expected = await readWatcherCheckpointSnapshot(db as any, INSTITUTION_CHECKPOINT_COLLECTION, CHAIN_ID);
        console.warn('CAS contention, re-read and retry once:', JSON.stringify(expected));
        if ((expected.lastProcessedBlock ?? -1) >= JUMP_TARGET) { console.log('Advanced to/past target; done.'); return; }
        continue;
      }
      throw e;
    }
  }
  throw new Error('CAS failed after retry');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
