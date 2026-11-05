/**
 * activation — crash/replay canary for the agent wallet-key rotation identity cut.
 *
 * WHAT THIS PROVES (the launch-stop precondition #11,
 * docs/launch/KEY_ROTATION_REENABLEMENT_LAUNCH_STOP.md):
 *
 * The rotation identity transition is ONE Firestore transaction
 * (`executeKeyRotationTransition` → `advanceChainTipAtomic`). So under an
 * abrupt kill at ANY step, every survivor state is EITHER the OLD identity
 * fully intact OR the NEW identity fully live — NEVER a split where one
 * address-keyed subsystem points at the old address and another at the new.
 * Resuming from any survivor converges to the NEW identity exactly once; a
 * replay after the cut committed is idempotent (it never double-applies).
 *
 * The invariant is checked across the FULL address-keyed subsystem set that a
 * rotation moves together — the wallet doc, the trust-graph mirror, the native
 * address index (new created / old deleted), the durable retirement tombstone,
 * the API-credential prefix index (new / old), the watcher admission (new
 * registration-fenced admission with a bumped membership generation / old
 * retired), the agent registration index re-point, the directory address, the
 * sealed `agent_key_rotated` PE, the rotation_history entry (NON-NULL pe_id),
 * and the append-only chain-tip advance. A mixed state is a HARD FAIL.
 *
 * COVERAGE — the boundaries, stated plainly:
 * 1. clean — one uninterrupted rotation → NEW-consistent.
 * 2. prepare_crash — the two-operator head read throws in `prepare` (before
 * any write) → OLD-consistent → resume → NEW.
 * 3. precondition_conflict — the NEW address is pre-claimed, so `readAndAssert`
 * aborts the transaction mid-flight → OLD-consistent →
 * clear + resume → NEW.
 * 4. committed_replay — a completed rotation is re-executed with the same plan
 * → the transition fails closed (already applied) and
 * the NEW state is byte-unchanged (no double-apply).
 * 5. sigkill_sweep — a REAL child process runs the rotation and is SIGKILLed
 * across a delay sweep that walks the whole transition
 * window (before → during → after the Firestore commit).
 * EVERY survivor is OLD-consistent or NEW-consistent,
 * never split; resume converges to NEW. This is the one
 * boundary an in-process throw cannot model: no catch,
 * no finally, no unwind.
 *
 * COST + BLAST-RADIUS GUARDS (mirror the accepted settlement runtime/activation harnesses,):
 * - Firestore: the DEDICATED NON-PRODUCTION emulator ONLY. Refuses to start
 * unless FIRESTORE_EMULATOR_HOST is set AND localhost AND the emulator wipe
 * endpoint answers — an endpoint production Firestore does not have, so the
 * production path is structurally unreachable, not merely guarded.
 * - Chain: NONE. The transition's only chain read is the two-operator agreed
 * Base head (`readAgreedBaseHead` → `eth_blockNumber`). The canary injects it
 * deterministically via the machinery's own `readBaseHead` test seam (the
 * exact seam `key-rotation-transition.test.ts` uses), so crash/replay
 * determinism never depends on a live RPC. Head AGREEMENT itself is proven by
 * the machinery's unit tests; this canary proves the durable identity cut.
 * NO transaction of any kind is sent. Nothing here deploys, arms, or mints.
 * - Data: wiped before every scenario and verified empty at the end.
 *
 * RUN:
 * 1. npx firebase emulators:start --only firestore (repo firebase.json)
 * 2. cd provian-backend && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 * npx tsx scripts/wp12-key-rotation-canary.ts
 */

import * as admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { generateApiCredentialsAsync, type ApiCredentials } from '../src/core/agent-wallet/api-key';
import type { AgentBankDeps } from '../src/core/agent-bank/types';
import {
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
} from '../src/core/pvt/native-wallet-registration';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  watcherAddressAdmissionDocId,
} from '../src/core/pvt/watcher-address-admission';
import {
  AGENT_DIRECTORY_COLLECTION,
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  ROTATION_HISTORY_SUBCOLLECTION,
  executeKeyRotationTransition,
  prepareKeyRotationTransition,
  rotationHistoryId,
  rotationPeId,
  type KeyRotationNewIdentity,
} from '../src/core/agent-wallet/key-rotation-transition';

// ---------------------------------------------------------------------------
// Configuration + gates
// ---------------------------------------------------------------------------

const EMULATOR_PROJECT_ID = 'provian-wp12-rotation-canary';

/** Deterministic identities. NOW is far-future so the watcher time-monotonicity
 * guard (now >= checkpoint.updated_at) is satisfied against a real-time seed. */
const AGENT_ID = 'canary-rotation-agent';
const WALLET_ID = 'wallet_aw_canaryrotation01';
const REGISTRATION_ID = 'agent-registration-canary-rotation-0001';
const OLD_ADDRESS = '0x2222222222222222222222222222222222222222';
const OLD_PUBLIC_KEY = 'a'.repeat(128);
const OLD_API_PREFIX = 'pvn_live_000000000000abc';
const NOW = 10_000_000_000_000;
const BIRTH_HEAD = 140;
const ROTATION_HEAD = 500;

const NEW_SIGNER = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const NEW_ADDRESS = NEW_SIGNER.address.toLowerCase();
const NEW_PUBLIC_KEY = NEW_SIGNER.signingKey.publicKey.slice(4); // strip 0x04

/** SIGKILL delay sweep (ms). Walks the whole transition window: 0 lands before
 * any write; the large values land after the Firestore commit. Determinism of
 * WHERE the kill hits is not required — the property is that NO delay yields a
 * split, and every survivor resumes to NEW. */
const KILL_DELAYS_MS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 130, 200, 400];

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
// Seed a consistent OLD identity graph (exactly the docs the transition reads)
// ---------------------------------------------------------------------------

const OLD_ADMISSION_ID = watcherAddressAdmissionDocId({
  direction: 'inbound', chainId: 8453, address: OLD_ADDRESS,
  walletId: WALLET_ID, agentId: AGENT_ID, eligibilityStartBlock: 0,
});
const NEW_ADMISSION_ID = watcherAddressAdmissionDocId({
  direction: 'inbound', chainId: 8453, address: NEW_ADDRESS,
  walletId: WALLET_ID, agentId: AGENT_ID, eligibilityStartBlock: 0,
});
const OLD_ADDR_IDX_ID = nativeWalletAddressIndexId(OLD_ADDRESS);
const NEW_ADDR_IDX_ID = nativeWalletAddressIndexId(NEW_ADDRESS);
const AGENT_IDX_ID = nativeAgentRegistrationIndexId(AGENT_ID);
const BIRTH_FENCE = createNativeWalletRegistrationFence(BIRTH_HEAD);
const BIRTH_TIP_HASH = 'b'.repeat(64);
const SEED_CHECKPOINT_GENERATION = 7;

async function seedOldIdentity(db: Firestore): Promise<void> {
  const oldApiCreds = await generateApiCredentialsAsync();
  await Promise.all([
    db.collection('agent_wallets').doc(WALLET_ID).set({
      id: WALLET_ID,
      agent_id: AGENT_ID,
      address: OLD_ADDRESS,
      public_key: OLD_PUBLIC_KEY,
      api_key_hash: oldApiCreds.api_key_hash,
      api_key_salt: oldApiCreds.api_key_salt,
      api_key_prefix: OLD_API_PREFIX,
      status: 'active',
      rotation_count: 0,
      created_at: 1,
      updated_at: 1,
      native_watcher_registration: BIRTH_FENCE,
    }),
    db.collection('wallets').doc(WALLET_ID).set({
      id: WALLET_ID,
      type: 'agent',
      agent_id: AGENT_ID,
      address: OLD_ADDRESS,
      public_key: OLD_PUBLIC_KEY,
      native_watcher_registration: BIRTH_FENCE,
    }),
    db.collection('api_key_index').doc(OLD_API_PREFIX).set({
      api_key_prefix: OLD_API_PREFIX,
      wallet_id: WALLET_ID,
      created_at: 1,
    }),
    db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION).doc(AGENT_IDX_ID).set({
      schema_version: 'native-agent-registration/v1',
      registration_id: REGISTRATION_ID,
      request_fingerprint_sha256: 'c'.repeat(64),
      agent_id: AGENT_ID,
      address: OLD_ADDRESS,
      wallet_id: WALLET_ID,
      pe_id: 'pe_birth_canary',
      pe_hash: BIRTH_TIP_HASH,
      api_key_prefix: OLD_API_PREFIX,
      created_at_ms: 1,
      credential_recovery_generation: 0,
      updated_at_ms: 1,
    }),
    db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(OLD_ADDR_IDX_ID).set({
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: OLD_ADDRESS,
      wallet_id: WALLET_ID,
      owner_type: 'agent',
      owner_id: AGENT_ID,
      created_at_ms: 1,
    }),
    db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).doc(OLD_ADMISSION_ID).set({
      schema_version: 'pvt-watcher-address-admission/v3',
      direction: 'inbound',
      chain_id: 8453,
      address: OLD_ADDRESS,
      wallet_id: WALLET_ID,
      agent_id: AGENT_ID,
      eligibility_start_block: BIRTH_FENCE.eligibility_start_block,
      state: 'live',
      backfill_next_block: BIRTH_FENCE.eligibility_start_block,
      catch_up_through_block: BIRTH_FENCE.eligibility_start_block - 1,
      membership_generation: SEED_CHECKPOINT_GENERATION,
      generation_fenced_at_registration: true,
      revision: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
    }),
    db.collection(INBOUND_WATCHER_CHECKPOINT_COLLECTION).doc('8453').set({
      chain_id: 8453,
      last_processed_block: 130,
      membership_generation: SEED_CHECKPOINT_GENERATION,
      updated_at: 1,
    }),
    db.collection('pe_chain_tips').doc(AGENT_ID).set({
      hash: BIRTH_TIP_HASH,
      user_id: AGENT_ID,
      updated_at: 1,
    }),
    db.collection(AGENT_DIRECTORY_COLLECTION).doc(WALLET_ID).set({
      wallet_id: WALLET_ID,
      address: OLD_ADDRESS,
      display_name: 'Canary Rotation Agent',
    }),
  ]);
}

function bankDeps(db: Firestore): AgentBankDeps {
  return {
    db,
    cache: {
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
  } as unknown as AgentBankDeps;
}

let cachedNewIdentity: KeyRotationNewIdentity | null = null;
async function newIdentity(): Promise<KeyRotationNewIdentity> {
  if (cachedNewIdentity) return cachedNewIdentity;
  const creds: ApiCredentials = await generateApiCredentialsAsync();
  cachedNewIdentity = {
    newAddress: NEW_ADDRESS,
    newPublicKey: NEW_PUBLIC_KEY,
    newApiCredentials: creds,
  };
  return cachedNewIdentity;
}

async function runRotation(
  db: Firestore,
  identity: KeyRotationNewIdentity,
  readBaseHead: () => Promise<number>,
): Promise<void> {
  const plan = await prepareKeyRotationTransition({
    db, walletId: WALLET_ID, newIdentity: identity,
    rotationId: 'rotation-canary-0001', now: NOW, readBaseHead,
  });
  await executeKeyRotationTransition(bankDeps(db), plan);
}

// ---------------------------------------------------------------------------
// Invariant: classify the full address-keyed subsystem set as OLD | NEW | SPLIT
// ---------------------------------------------------------------------------

type Classification = { verdict: 'OLD' | 'NEW' | 'SPLIT'; detail: string };

async function classify(db: Firestore, identity: KeyRotationNewIdentity): Promise<Classification> {
  const newPrefix = identity.newApiCredentials.api_key_prefix;
  const [
    walletSnap, trustSnap, agentIdxSnap, oldAddrIdxSnap, newAddrIdxSnap,
    retirementSnap, oldApiSnap, newApiSnap, oldAdmSnap, newAdmSnap,
    dirSnap, rotationPeSnap, historySnap, checkpointSnap,
  ] = await Promise.all([
    db.collection('agent_wallets').doc(WALLET_ID).get(),
    db.collection('wallets').doc(WALLET_ID).get(),
    db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION).doc(AGENT_IDX_ID).get(),
    db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(OLD_ADDR_IDX_ID).get(),
    db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(NEW_ADDR_IDX_ID).get(),
    db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(OLD_ADDRESS).get(),
    db.collection('api_key_index').doc(OLD_API_PREFIX).get(),
    db.collection('api_key_index').doc(newPrefix).get(),
    db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).doc(OLD_ADMISSION_ID).get(),
    db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).doc(NEW_ADMISSION_ID).get(),
    db.collection(AGENT_DIRECTORY_COLLECTION).doc(WALLET_ID).get(),
    db.collection('provenance_envelopes').doc(rotationPeId(AGENT_ID, OLD_ADDRESS, NEW_ADDRESS)).get(),
    db.collection('agent_wallets').doc(WALLET_ID)
      .collection(ROTATION_HISTORY_SUBCOLLECTION).get(),
    db.collection(INBOUND_WATCHER_CHECKPOINT_COLLECTION).doc('8453').get(),
  ]);

  const wallet = walletSnap.data() ?? {};
  const trust = trustSnap.data() ?? {};
  const agentIdx = agentIdxSnap.data() ?? {};
  const dir = dirSnap.data() ?? {};
  const checkpoint = checkpointSnap.data() ?? {};
  const walletAddr = String(wallet.address ?? '').toLowerCase();
  const trustAddr = String(trust.address ?? '').toLowerCase();
  const agentIdxAddr = String(agentIdx.address ?? '').toLowerCase();
  const dirAddr = String(dir.address ?? '').toLowerCase();
  const rotationCount = wallet.rotation_count ?? 0;
  const historyDocs = historySnap.docs;

  // Every predicate that MUST be true for a pure OLD state.
  const oldChecks: Record<string, boolean> = {
    'wallet.address==OLD': walletAddr === OLD_ADDRESS,
    'trust.address==OLD': trustAddr === OLD_ADDRESS,
    'agentIdx.address==OLD': agentIdxAddr === OLD_ADDRESS,
    'wallet.api_prefix==OLD': wallet.api_key_prefix === OLD_API_PREFIX,
    'oldAddrIdx present': oldAddrIdxSnap.exists,
    'newAddrIdx absent': !newAddrIdxSnap.exists,
    'retirement absent': !retirementSnap.exists,
    'oldApiIdx present': oldApiSnap.exists,
    'newApiIdx absent': !newApiSnap.exists,
    'oldAdmission present': oldAdmSnap.exists,
    'newAdmission absent': !newAdmSnap.exists,
    'dir.address==OLD': dirAddr === OLD_ADDRESS,
    'rotation_count==0': rotationCount === 0,
    'no rotation PE': !rotationPeSnap.exists,
    'no rotation_history': historyDocs.length === 0,
    'checkpoint gen==seed': checkpoint.membership_generation === SEED_CHECKPOINT_GENERATION,
  };

  // Every predicate that MUST be true for a pure NEW state.
  const historyPeOk = historyDocs.length === 1
    && (historyDocs[0].data().pe_id === rotationPeId(AGENT_ID, OLD_ADDRESS, NEW_ADDRESS))
    && historyDocs[0].data().pe_id !== null
    && historyDocs[0].id === rotationHistoryId(rotationPeId(AGENT_ID, OLD_ADDRESS, NEW_ADDRESS));
  const newAdmission = newAdmSnap.data() ?? {};
  const newChecks: Record<string, boolean> = {
    'wallet.address==NEW': walletAddr === NEW_ADDRESS,
    'trust.address==NEW': trustAddr === NEW_ADDRESS,
    'agentIdx.address==NEW': agentIdxAddr === NEW_ADDRESS,
    'wallet.api_prefix==NEW': wallet.api_key_prefix === newPrefix,
    'agentIdx.api_prefix==NEW': agentIdx.api_key_prefix === newPrefix,
    'oldAddrIdx absent': !oldAddrIdxSnap.exists,
    'newAddrIdx present': newAddrIdxSnap.exists,
    'retirement present': retirementSnap.exists,
    'retirement->NEW': String((retirementSnap.data() ?? {}).new_address ?? '').toLowerCase() === NEW_ADDRESS,
    'oldApiIdx absent': !oldApiSnap.exists,
    'newApiIdx present': newApiSnap.exists,
    'oldAdmission absent': !oldAdmSnap.exists,
    'newAdmission present': newAdmSnap.exists,
    'newAdmission fenced': newAdmission.generation_fenced_at_registration === true,
    'newAdmission eligibility==H+1': newAdmission.eligibility_start_block === ROTATION_HEAD + 1,
    'dir.address==NEW': dirAddr === NEW_ADDRESS,
    'wallet.fence==H+1': (wallet.native_watcher_registration as { eligibility_start_block?: number } | undefined)
      ?.eligibility_start_block === ROTATION_HEAD + 1,
    'rotation_count==1': rotationCount === 1,
    'rotation PE sealed': rotationPeSnap.exists,
    'rotation PE actor==NEW': String((rotationPeSnap.data() ?? {}).actor_address ?? '').toLowerCase() === NEW_ADDRESS,
    'rotation PE prev==birth tip': (rotationPeSnap.data() ?? {}).prev_hash === BIRTH_TIP_HASH,
    'history 1 entry, non-null pe_id': historyPeOk,
    'membership bumped +1': checkpoint.membership_generation === SEED_CHECKPOINT_GENERATION + 1,
  };

  const oldFails = Object.entries(oldChecks).filter(([, ok]) => !ok).map(([k]) => k);
  const newFails = Object.entries(newChecks).filter(([, ok]) => !ok).map(([k]) => k);
  if (oldFails.length === 0) return { verdict: 'OLD', detail: 'pure old identity' };
  if (newFails.length === 0) return { verdict: 'NEW', detail: 'pure new identity' };
  // Neither pure-old nor pure-new: a split. Report whichever it is CLOSER to so
  // the mixed subsystems are named.
  const closerToNew = newFails.length < oldFails.length;
  return {
    verdict: 'SPLIT',
    detail: closerToNew
      ? `partial NEW — missing: ${newFails.join(', ')}`
      : `partial OLD — unexpected: ${oldFails.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Result { name: string; ok: boolean; detail: string; }

/** A completed rotation MUST classify NEW; any split is fatal. */
async function scenarioClean(db: Firestore, host: string): Promise<Result> {
  await wipeEmulator(host);
  await seedOldIdentity(db);
  const identity = await newIdentity();
  await runRotation(db, identity, async () => ROTATION_HEAD);
  const c = await classify(db, identity);
  return { name: 'clean', ok: c.verdict === 'NEW', detail: c.detail };
}

/** The head read throws in prepare (before any write): OLD intact, resume→NEW. */
async function scenarioPrepareCrash(db: Firestore, host: string): Promise<Result> {
  await wipeEmulator(host);
  await seedOldIdentity(db);
  const identity = await newIdentity();
  let threw = false;
  try {
    await runRotation(db, identity, async () => { throw new Error('injected head read failure'); });
  } catch { threw = true; }
  const mid = await classify(db, identity);
  if (!threw || mid.verdict !== 'OLD') {
    return { name: 'prepare_crash', ok: false, detail: `threw=${threw} mid=${mid.verdict} (${mid.detail})` };
  }
  await runRotation(db, identity, async () => ROTATION_HEAD);
  const after = await classify(db, identity);
  return { name: 'prepare_crash', ok: after.verdict === 'NEW', detail: `resume=${after.verdict} (${after.detail})` };
}

/** The NEW address is pre-claimed → readAndAssert aborts mid-transaction (a real
 * in-flight write rollback): OLD intact, clear the conflict, resume→NEW. */
async function scenarioPreconditionConflict(db: Firestore, host: string): Promise<Result> {
  await wipeEmulator(host);
  await seedOldIdentity(db);
  const identity = await newIdentity();
  await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(NEW_ADDR_IDX_ID).set({
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: NEW_ADDRESS,
    wallet_id: 'wallet_aw_someoneelse', owner_type: 'agent', owner_id: 'someone-else', created_at_ms: 1,
  });
  let threw = false;
  try {
    await runRotation(db, identity, async () => ROTATION_HEAD);
  } catch { threw = true; }
  // OLD identity must be intact (the conflicting foreign index is expected to remain).
  const wallet = (await db.collection('agent_wallets').doc(WALLET_ID).get()).data() ?? {};
  const oldIntact = String(wallet.address).toLowerCase() === OLD_ADDRESS
    && (wallet.rotation_count ?? 0) === 0
    && !(await db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(OLD_ADDRESS).get()).exists
    && !(await db.collection('provenance_envelopes')
      .doc(rotationPeId(AGENT_ID, OLD_ADDRESS, NEW_ADDRESS)).get()).exists;
  if (!threw || !oldIntact) {
    return { name: 'precondition_conflict', ok: false, detail: `threw=${threw} oldIntact=${oldIntact}` };
  }
  // Clear the foreign claim and resume.
  await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(NEW_ADDR_IDX_ID).delete();
  await runRotation(db, identity, async () => ROTATION_HEAD);
  const after = await classify(db, identity);
  return { name: 'precondition_conflict', ok: after.verdict === 'NEW', detail: `resume=${after.verdict} (${after.detail})` };
}

/** A committed cut re-executed with the same plan MUST fail closed and leave the
 * NEW state byte-unchanged (no double-apply). */
async function scenarioCommittedReplay(db: Firestore, host: string): Promise<Result> {
  await wipeEmulator(host);
  await seedOldIdentity(db);
  const identity = await newIdentity();
  await runRotation(db, identity, async () => ROTATION_HEAD);
  const before = await snapshotAll(db);
  let threw = false;
  try {
    await runRotation(db, identity, async () => ROTATION_HEAD);
  } catch { threw = true; }
  const after = await snapshotAll(db);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const c = await classify(db, identity);
  return {
    name: 'committed_replay',
    ok: threw && unchanged && c.verdict === 'NEW',
    detail: `replay_rejected=${threw} state_unchanged=${unchanged} verdict=${c.verdict}`,
  };
}

/** Full state snapshot for the no-double-apply comparison. */
async function snapshotAll(db: Firestore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const collections = [
    'agent_wallets', 'wallets', 'api_key_index', NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
    NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, WATCHER_ADDRESS_ADMISSION_COLLECTION,
    INBOUND_WATCHER_CHECKPOINT_COLLECTION, 'pe_chain_tips', 'provenance_envelopes',
    AGENT_DIRECTORY_COLLECTION, AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  ];
  for (const name of collections) {
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) out[`${name}/${doc.id}`] = doc.data();
  }
  const hist = await db.collection('agent_wallets').doc(WALLET_ID)
    .collection(ROTATION_HISTORY_SUBCOLLECTION).get();
  for (const doc of hist.docs) out[`rotation_history/${doc.id}`] = doc.data();
  return out;
}

/** A REAL child process runs the rotation and is SIGKILLed at `delayMs`. */
async function runKillChild(host: string, identity: KeyRotationNewIdentity, delayMs: number): Promise<{ code: number | null; signal: string | null }> {
  const childSource = `
import * as admin from 'firebase-admin';
import { prepareKeyRotationTransition, executeKeyRotationTransition } from '../src/core/agent-wallet/key-rotation-transition';
process.env.GOOGLE_CLOUD_PROJECT = ${JSON.stringify(EMULATOR_PROJECT_ID)};
admin.initializeApp({ projectId: ${JSON.stringify(EMULATOR_PROJECT_ID)} });
admin.firestore().settings({ ignoreUndefinedProperties: true });
const db = admin.firestore();
const identity = ${JSON.stringify(identity)};
const deps = { db, cache: { isEnabled: () => true, get: async () => null, set: async () => undefined, del: async () => undefined }, peBuffer: { enqueue: () => undefined }, recordPEAccrual: async () => undefined };
setTimeout(() => process.kill(process.pid, 'SIGKILL'), ${delayMs});
(async () => {
  const plan = await prepareKeyRotationTransition({ db, walletId: ${JSON.stringify(WALLET_ID)}, newIdentity: identity, rotationId: 'rotation-canary-0001', now: ${NOW}, readBaseHead: async () => ${ROTATION_HEAD} });
  await executeKeyRotationTransition(deps, plan);
})().catch(() => {});
`;
  const childPath = path.join(process.cwd(), 'scripts', `.wp12-rotation-child-${process.pid}-${delayMs}.ts`);
  fs.writeFileSync(childPath, childSource);
  const child = spawn('npx', ['tsx', childPath], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: host },
  });
  const death = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, sig) => resolve({ code, signal: sig }));
  });
  fs.rmSync(childPath, { force: true });
  return death;
}

/** SIGKILL sweep: for every delay, the survivor is OLD or NEW (never SPLIT), and
 * resuming converges to NEW. */
async function scenarioSigkillSweep(db: Firestore, host: string): Promise<Result> {
  const identity = await newIdentity();
  const observed = new Set<string>();
  for (const delay of KILL_DELAYS_MS) {
    await wipeEmulator(host);
    await seedOldIdentity(db);
    const death = await runKillChild(host, identity, delay);
    // npx forwards the child's self-SIGKILL as code 137 (null signal) or SIGKILL.
    const killed = death.signal === 'SIGKILL' || death.code === 137;
    const mid = await classify(db, identity);
    if (mid.verdict === 'SPLIT') {
      return { name: 'sigkill_sweep', ok: false, detail: `delay=${delay}ms SPLIT: ${mid.detail}` };
    }
    observed.add(mid.verdict);
    // Resume from the survivor and require convergence to NEW.
    if (mid.verdict === 'OLD') {
      await runRotation(db, identity, async () => ROTATION_HEAD);
    } else {
      // Already NEW: a resume must be a fail-closed no-op (idempotent).
      try { await runRotation(db, identity, async () => ROTATION_HEAD); } catch { /* expected */ }
    }
    const after = await classify(db, identity);
    if (after.verdict !== 'NEW') {
      return { name: 'sigkill_sweep', ok: false, detail: `delay=${delay}ms resume=${after.verdict} (${after.detail}) killed=${killed}` };
    }
  }
  return {
    name: 'sigkill_sweep',
    ok: true,
    detail: `${KILL_DELAYS_MS.length} kills, survivors observed: {${[...observed].sort().join(', ')}}, every resume→NEW`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const host = requireEmulatorHost();
  process.env.GOOGLE_CLOUD_PROJECT = EMULATOR_PROJECT_ID;
  admin.initializeApp({ projectId: EMULATOR_PROJECT_ID });
  admin.firestore().settings({ ignoreUndefinedProperties: true });
  const db = admin.firestore();

  await wipeEmulator(host);
  console.log(`· emulator ${host} project ${EMULATOR_PROJECT_ID} — wipe endpoint verified`);
  console.log(`· old ${OLD_ADDRESS} → new ${NEW_ADDRESS} (H=${ROTATION_HEAD}, fence H+1=${ROTATION_HEAD + 1})\n`);

  const results: Result[] = [];
  const scenarios: Array<[string, (db: Firestore, host: string) => Promise<Result>]> = [
    ['clean', scenarioClean],
    ['prepare_crash', scenarioPrepareCrash],
    ['precondition_conflict', scenarioPreconditionConflict],
    ['committed_replay', scenarioCommittedReplay],
    ['sigkill_sweep', scenarioSigkillSweep],
  ];
  for (const [label, fn] of scenarios) {
    process.stdout.write(`  ${label.padEnd(24)} `);
    const result = await fn(db, host);
    results.push(result);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} · ${result.detail}`);
  }

  await wipeEmulator(host);
  const residue = await snapshotAll(db);
  if (Object.keys(residue).length !== 0) {
    fail(`emulator not empty after final wipe (${Object.keys(residue).length} docs) — refusing to report success`);
  }
  console.log('· final wipe verified empty');

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(72));
  if (failed.length > 0) {
    for (const r of failed) console.log(`✗ ${r.name}: ${r.detail}`);
    fail(`activation key-rotation crash/replay canary FAILED (${failed.length}/${results.length} scenarios)`);
  }
  console.log(`\n✓ CANARY PASS — ${results.length} scenarios: no split state reachable under crash at any step; every survivor resumes to exactly one live identity.`);
  process.exit(0);
}

main().catch((error) => fail(`${(error as Error).stack ?? error}`));
