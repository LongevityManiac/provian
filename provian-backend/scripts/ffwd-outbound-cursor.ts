/**
 * One-off operator action (D-XXX): fast-forward the outbound-USDC watcher cursor
 * over its provably/observably-empty backlog to block 49,646,132.
 *
 * Pre-fence [cursor+1, minFence-1] is empty by CODE INVARIANT (outbound-usdc-watcher.ts:499
 * skips before any durable write). Post-fence [minFence, 49646132] is empty by TWO
 * independent exhaustive archive sweeps (0 from-side USDC logs). Four RED controls must
 * all REFUSE before the compare-and-set commit runs. DRY_RUN=1 runs controls without writing.
 *
 * Run: DRY_RUN=1 npx tsx scripts/ffwd-outbound-cursor.ts   (then without DRY_RUN to execute)
 */
import admin from 'firebase-admin';
import {
  commitWatcherCheckpoint,
  readWatcherCheckpointSnapshot,
} from '../src/core/pvt/watcher-address-admission';
import { listProvenAddresses } from '../src/core/external-address/link';
import { scriptDb } from './lib/script-db';

const CHECKPOINT_COLLECTION = 'activity_outbound_checkpoints';
const CHAIN_ID = 8453;
const FENCE_WINDOW_FROM = 49_191_173; // the sole proven address's fence (also the sweep floor)
const JUMP_TARGET = 49_646_132;       // last_processed_block to set; next scan resumes at +1

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const A = '0x5ed6e53c1b9e784dabe48d517a54c5865f0ff4f5';
const FROMTOPIC = '0x000000000000000000000000' + A.slice(2);

interface Sweep { name: string; exhaustive: boolean; logCount: number; fromBlock: number; toBlock: number; posControlPass: boolean; }
interface Watched { walletId: string; fence: number; }
type Auth = { ok: boolean; status: string; minFence?: number; cursorNext?: number };

/** The single authorization predicate. GREEN on real inputs; every RED control feeds a
 *  mutated input to THIS function and asserts it refuses (no self-referential re-impl). */
function authorizeJump(a: {
  watched: Watched[]; cursorLastProcessed: number; jumpTarget: number; head: number; sweeps: Sweep[];
}): Auth {
  const cursorNext = a.cursorLastProcessed + 1;
  if (!Array.isArray(a.watched) || a.watched.length === 0) return { ok: false, status: 'EMPTY_POPULATION' };
  const fences = a.watched.map((w) => w.fence);
  if (fences.some((f) => !Number.isSafeInteger(f) || f < 0)) return { ok: false, status: 'BAD_FENCE' };
  const minFence = Math.min(...fences);
  if (!Number.isSafeInteger(a.jumpTarget) || a.jumpTarget > a.head - 12) return { ok: false, status: 'ABOVE_HEAD_CEIL' };
  if (a.jumpTarget <= a.cursorLastProcessed) return { ok: false, status: 'NOT_FORWARD' };
  const good = a.sweeps.filter((s) => s.exhaustive === true && s.logCount === 0 && s.posControlPass === true);
  if (good.length < 2) return { ok: false, status: 'INSUFFICIENT_EXHAUSTIVE_SWEEPS' };
  const sweepFloor = Math.max(...good.map((s) => s.fromBlock));
  const sweepCeil = Math.min(...good.map((s) => s.toBlock));
  if (sweepFloor > minFence) return { ok: false, status: 'SWEEP_FLOOR_ABOVE_FENCE' };
  if (a.jumpTarget > sweepCeil) return { ok: false, status: 'JUMP_ABOVE_SWEEP_CEIL' };
  return { ok: true, status: 'GREEN', minFence, cursorNext };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(u: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = (await r.json()) as { error?: unknown; result?: unknown };
  if (j.error) throw new Error('rpc ' + JSON.stringify(j.error).slice(0, 90));
  return j.result;
}
async function exhaustiveSweep(name: string, u: string, chunk: number, from: number, to: number): Promise<Sweep> {
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
        const res = await rpc(u, 'eth_getLogs', [{ fromBlock: '0x' + c.from.toString(16), toBlock: '0x' + c.to.toString(16), address: USDC, topics: [TRANSFER, FROMTOPIC] }]);
        logs += res.length; ok = true;
      } catch { await sleep(250 * attempt); }
    }
    if (!ok) failed++;
    await sleep(15);
  }
  // positive control: a from-filter roundtrip near the top of the window must find >=1
  let posControlPass = false;
  try {
    const s = await rpc(u, 'eth_getLogs', [{ fromBlock: '0x' + (to - 3).toString(16), toBlock: '0x' + to.toString(16), address: USDC, topics: [TRANSFER] }]);
    if (s.length) { const f = s[0].topics[1]; const rr = await rpc(u, 'eth_getLogs', [{ fromBlock: '0x' + (to - 3).toString(16), toBlock: '0x' + to.toString(16), address: USDC, topics: [TRANSFER, f] }]); posControlPass = rr.length >= 1; }
  } catch { posControlPass = false; }
  const exhaustive = tiling && failed === 0 && covered === (to - from + 1);
  return { name, exhaustive, logCount: logs, fromBlock: from, toBlock: to, posControlPass };
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb();

  const head = parseInt(await rpc('https://mainnet.base.org', 'eth_blockNumber', []), 16);
  const proven = await listProvenAddresses(db as any);
  const watched: Watched[] = proven.map((r) => ({ walletId: r.wallet_id, fence: r.proven_at_block }));
  const current = await readWatcherCheckpointSnapshot(db as any, CHECKPOINT_COLLECTION, CHAIN_ID);
  console.log('LIVE STATE:', JSON.stringify({ head, headCeil: head - 12, cursor: current, watchedCount: watched.length, watched }));

  console.log('Sweeping [', FENCE_WINDOW_FROM, ',', JUMP_TARGET, '] on two independent archives (fresh)...');
  const baseorg = await exhaustiveSweep('base.org', 'https://mainnet.base.org', 10_000, FENCE_WINDOW_FROM, JUMP_TARGET);
  const tenderly = await exhaustiveSweep('Tenderly', 'https://base.gateway.tenderly.co', 2_000, FENCE_WINDOW_FROM, JUMP_TARGET);
  console.log('SWEEP base.org :', JSON.stringify(baseorg));
  console.log('SWEEP Tenderly :', JSON.stringify(tenderly));
  const sweeps = [baseorg, tenderly];
  // dRPC's realized non-exhaustive run (7x HTTP 429) — the RED-4 negative-control input.
  const drpcNonExhaustive: Sweep = { name: 'dRPC', exhaustive: false, logCount: 0, fromBlock: FENCE_WINDOW_FROM, toBlock: JUMP_TARGET, posControlPass: true };

  const green = authorizeJump({ watched, cursorLastProcessed: current.lastProcessedBlock ?? -1, jumpTarget: JUMP_TARGET, head, sweeps });
  const red1 = authorizeJump({ watched: [...watched, { walletId: 'INJECTED', fence: (current.lastProcessedBlock ?? -1) + 1 }], cursorLastProcessed: current.lastProcessedBlock ?? -1, jumpTarget: JUMP_TARGET, head, sweeps });
  const red2 = authorizeJump({ watched: [], cursorLastProcessed: current.lastProcessedBlock ?? -1, jumpTarget: JUMP_TARGET, head, sweeps });
  const red3 = authorizeJump({ watched, cursorLastProcessed: current.lastProcessedBlock ?? -1, jumpTarget: JUMP_TARGET + 1, head, sweeps });
  const red4 = authorizeJump({ watched, cursorLastProcessed: current.lastProcessedBlock ?? -1, jumpTarget: JUMP_TARGET, head, sweeps: [baseorg, drpcNonExhaustive] });

  console.log('GREEN            :', JSON.stringify(green));
  console.log('RED1 fence-in-win:', JSON.stringify(red1), '(expect SWEEP_FLOOR_ABOVE_FENCE)');
  console.log('RED2 empty-pop   :', JSON.stringify(red2), '(expect EMPTY_POPULATION)');
  console.log('RED3 off-by-one  :', JSON.stringify(red3), '(expect JUMP_ABOVE_SWEEP_CEIL)');
  console.log('RED4 non-exhaust :', JSON.stringify(red4), '(expect INSUFFICIENT_EXHAUSTIVE_SWEEPS)');

  const controlsPass =
    green.ok === true &&
    red1.ok === false && red1.status === 'SWEEP_FLOOR_ABOVE_FENCE' &&
    red2.ok === false && red2.status === 'EMPTY_POPULATION' &&
    red3.ok === false && red3.status === 'JUMP_ABOVE_SWEEP_CEIL' &&
    red4.ok === false && red4.status === 'INSUFFICIENT_EXHAUSTIVE_SWEEPS';

  if (!controlsPass) {
    console.error('STOP: a RED control did not refuse as expected, or GREEN was not authorized. NO WRITE.');
    process.exit(2);
  }
  console.log('ALL CONTROLS PASS (GREEN authorized, 4 RED controls refused).');

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
      const after = await commitWatcherCheckpoint(db as any, CHECKPOINT_COLLECTION, CHAIN_ID, expected, JUMP_TARGET, Date.now());
      console.log('COMMITTED. before=', JSON.stringify(current), 'after=', JSON.stringify(after));
      return;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('watcher_checkpoint_changed') || msg.includes('watcher_membership_generation_changed')) {
        expected = await readWatcherCheckpointSnapshot(db as any, CHECKPOINT_COLLECTION, CHAIN_ID);
        console.warn('CAS contention, re-read and retry once:', JSON.stringify(expected));
        if ((expected.lastProcessedBlock ?? -1) >= JUMP_TARGET) { console.log('Advanced to/past target by watcher; done.'); return; }
        continue;
      }
      throw e;
    }
  }
  throw new Error('CAS failed after retry');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
