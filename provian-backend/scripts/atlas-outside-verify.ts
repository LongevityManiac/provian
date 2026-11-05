/**
 * Atlas outside-verification harness — READ-ONLY.
 *
 * Answers, from OUTSIDE the agent, whether a freshly-signed-up agent wallet
 * (Atlas) landed in the Genesis rail correctly. It writes NOTHING: it reads two
 * production Firestore docs and asserts three things STATUS.md's "verify from
 * outside only" hand-off names:
 * 1. the wallet exists and is NOT a `platform:'test'` wallet (test wallets are
 * deliberately excluded from Genesis — GENESIS_TEST_PLATFORM_DENIAL);
 * 2. its `genesis_signup` qualification was ENQUEUED (outbox doc present, not
 * denied) — the qualifying act is wallet creation itself;
 * 3. the reservation is exactly 75 PVT GROSS (75000000000000000000 atomic,
 * the genesis_signup fixed grant in proposed-genesis-policy.ts).
 *
 * The qualification doc id is derived, not searched: gq_<sha256(action\nanchor)>
 * where the anchor for genesis_signup is the agent's own agent_id (see
 * agent-wallet.ts create path). So this reads by primary key, no query.
 *
 * Every green check ships with its RED control : `--self-test` runs the
 * three pure checks over deliberately-passing AND deliberately-failing fixtures
 * (no Firestore, no network) and refuses to exit 0 unless each control behaves.
 * A read-harness whose checks cannot fail would report a healthy Atlas over a
 * broken one; the self-test is what makes a green run mean something.
 *
 * npx tsx scripts/atlas-outside-verify.ts <wallet_id> [--agent-id <agent_id>]
 * npx tsx scripts/atlas-outside-verify.ts --self-test
 *
 * Exit 0 = all three checks green (live) or all controls behaved (self-test);
 * exit 1 otherwise.
 */
import * as admin from 'firebase-admin';
import {
  GENESIS_QUALIFICATION_COLLECTION,
  genesisQualificationId,
} from '../src/core/pvt/genesis-award-state-machine';
import { scriptDb } from './lib/script-db';

/** genesis_signup fixed grant, GROSS atomic units (75 PVT). Mirrors
 *  proposed-genesis-policy.ts `fixed_grant_atomic` for the agent signup leg. */
const GENESIS_SIGNUP_GROSS_ATOMIC = '75000000000000000000';

interface WalletView {
  readonly exists: boolean;
  readonly platform?: unknown;
  readonly agent_id?: unknown;
}
interface QualView {
  readonly exists: boolean;
  readonly status?: unknown;
  readonly reserved_atomic?: unknown;
  readonly wallet_id?: unknown;
}
interface CheckResult { readonly ok: boolean; readonly label: string; readonly detail: string; }

// --- PURE checks (fixture-controllable; the live path and --self-test share them) ---

function checkWallet(w: WalletView): CheckResult {
  const label = 'wallet exists + platform≠test';
  if (!w.exists) {
    return { ok: false, label, detail: 'agent_wallets/<wallet_id> not found — wrong wallet id, or the wallet was never created' };
  }
  const platform = typeof w.platform === 'string' ? w.platform : JSON.stringify(w.platform);
  const ok = platform !== 'test';
  return {
    ok,
    label,
    detail: ok
      ? `wallet exists, platform=${JSON.stringify(w.platform)}`
      : `platform='test' — this is a TEST wallet, deliberately excluded from Genesis`,
  };
}

function checkQualificationEnqueued(q: QualView): CheckResult {
  const label = 'genesis_signup qualification enqueued';
  if (!q.exists) {
    return { ok: false, label, detail: 'no qualification outbox doc — creation did not enqueue it (or the agent_id is wrong)' };
  }
  const status = typeof q.status === 'string' ? q.status : JSON.stringify(q.status);
  const ok = status !== 'denied';
  return {
    ok,
    label,
    detail: ok ? `status=${status}` : `status=denied — the qualifying act was refused`,
  };
}

function checkReservationGross(q: QualView): CheckResult {
  const label = 'reservation 75 PVT gross';
  const reserved = typeof q.reserved_atomic === 'string' ? q.reserved_atomic : JSON.stringify(q.reserved_atomic);
  const ok = reserved === GENESIS_SIGNUP_GROSS_ATOMIC;
  if (ok) return { ok, label, detail: `reserved_atomic=${reserved} (75 PVT gross)` };
  const status = typeof q.status === 'string' ? q.status : '';
  const pendingNote = status === 'pending_reservation'
    ? ' — status is pending_reservation; the reservation processor has not settled it yet, re-check shortly'
    : '';
  return { ok, label, detail: `reserved_atomic=${reserved}, expected ${GENESIS_SIGNUP_GROSS_ATOMIC}${pendingNote}` };
}

function render(results: readonly CheckResult[]): boolean {
  let allOk = true;
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(34)} ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  return allOk;
}

async function live(walletId: string, agentIdArg: string | undefined): Promise<void> {
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb();

  // Atlas is an AGENT, so its subject wallet lives in `agent_wallets` (the award
  // path now selects the collection by owner type; this verifier is agent-only).
  const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
  const wdata = (walletSnap.data() ?? {}) as Record<string, unknown>;
  const w: WalletView = { exists: walletSnap.exists, platform: wdata.platform, agent_id: wdata.agent_id };

  const agentId = agentIdArg ?? (typeof wdata.agent_id === 'string' ? wdata.agent_id : '');
  console.log(`Atlas outside-verify (READ-ONLY) — wallet ${walletId}`);
  if (!agentId) {
    console.log('  ✗ cannot resolve agent_id (wallet doc has no agent_id and none was passed via --agent-id)');
    process.exit(1);
  }

  const qid = genesisQualificationId('genesis_signup', agentId);
  const qualSnap = await db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qid).get();
  const qdata = (qualSnap.data() ?? {}) as Record<string, unknown>;
  const q: QualView = {
    exists: qualSnap.exists,
    status: qdata.status,
    reserved_atomic: qdata.reserved_atomic,
    wallet_id: qdata.wallet_id,
  };
  console.log(`  agent_id=${agentId}  qualification_id=${qid}`);
  console.log('');

  const results = [checkWallet(w), checkQualificationEnqueued(q), checkReservationGross(q)];
  // Cross-check: the qualification's wallet_id must be the wallet we looked up.
  if (q.exists && typeof q.wallet_id === 'string' && q.wallet_id !== walletId) {
    results.push({ ok: false, label: 'qualification↔wallet binding', detail: `qualification.wallet_id=${q.wallet_id} ≠ ${walletId}` });
  }
  const allOk = render(results);
  console.log('');
  console.log(allOk ? 'RESULT: PASS — Atlas is qualified and reserved.' : 'RESULT: FAIL — see the ✗ lines above.');
  process.exit(allOk ? 0 : 1);
}

function selfTest(): void {
  const GROSS = GENESIS_SIGNUP_GROSS_ATOMIC;
  interface Control {
    readonly name: string;
    readonly run: () => CheckResult;
    readonly wantOk: boolean;
  }
  const controls: readonly Control[] = [
    // GREEN
    { name: 'qualifying wallet', run: () => checkWallet({ exists: true, platform: 'atlas', agent_id: 'a' }), wantOk: true },
    { name: 'enqueued (reserved)', run: () => checkQualificationEnqueued({ exists: true, status: 'reserved' }), wantOk: true },
    { name: 'enqueued (pending)', run: () => checkQualificationEnqueued({ exists: true, status: 'pending_reservation' }), wantOk: true },
    { name: '75 PVT gross reserved', run: () => checkReservationGross({ exists: true, status: 'reserved', reserved_atomic: GROSS }), wantOk: true },
    // RED
    { name: 'test-platform wallet', run: () => checkWallet({ exists: true, platform: 'test' }), wantOk: false },
    { name: 'missing wallet', run: () => checkWallet({ exists: false }), wantOk: false },
    { name: 'no qualification doc', run: () => checkQualificationEnqueued({ exists: false }), wantOk: false },
    { name: 'denied qualification', run: () => checkQualificationEnqueued({ exists: true, status: 'denied' }), wantOk: false },
    { name: 'wrong reservation amount', run: () => checkReservationGross({ exists: true, status: 'reserved', reserved_atomic: '25000000000000000000' }), wantOk: false },
    { name: 'reservation still pending', run: () => checkReservationGross({ exists: true, status: 'pending_reservation', reserved_atomic: '0' }), wantOk: false },
  ];
  console.log('Atlas outside-verify — SELF-TEST (no Firestore; RED/GREEN controls)');
  let bad = 0;
  for (const c of controls) {
    const r = c.run();
    const behaved = r.ok === c.wantOk;
    if (!behaved) bad += 1;
    console.log(`  ${behaved ? '✓' : '✗'} [${c.wantOk ? 'GREEN' : 'RED  '}] ${c.name.padEnd(26)} -> ok=${r.ok} ${behaved ? '' : '(CONTROL MISBEHAVED)'}`);
  }
  console.log('');
  console.log(bad === 0 ? 'SELF-TEST PASS — every control behaved; the checks are non-vacuous.' : `SELF-TEST FAIL — ${bad} control(s) misbehaved.`);
  process.exit(bad === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { selfTest(); return; }
  const positional = args.filter((a) => !a.startsWith('--'));
  const walletId = positional[0];
  if (!walletId) {
    console.error('usage: npx tsx scripts/atlas-outside-verify.ts <wallet_id> [--agent-id <agent_id>]');
    console.error('       npx tsx scripts/atlas-outside-verify.ts --self-test');
    process.exit(2);
  }
  const agentIdx = args.indexOf('--agent-id');
  const agentIdArg = agentIdx >= 0 ? args[agentIdx + 1] : undefined;
  await live(walletId, agentIdArg);
}

void main();
