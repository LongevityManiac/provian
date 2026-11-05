/**
 * settlement runtime — THE END-TO-END FORK PROOF.
 *
 * A synthetic qualifying act goes in one end and PVT comes out the other, through EXACTLY the
 * production code path: `runSettlement` from `core/pvt/wp4/operator-runtime.ts` the same
 * function the operator script and the relay route call. Nothing is stubbed, re-implemented,
 * or short-circuited for the harness; if this passes, that function works.
 *
 * PE + pe_history (Firestore emulator)
 * -> claim inlet -> pvt9_claim_ledger_v1 row
 * -> runSettlementCycle -> approve on the REAL verifier -> settleStandardPEBatch
 * -> PVT balance on the REAL kernel
 *
 * WHAT IS REAL AND WHAT IS NOT
 *
 * REAL: the deployed `ProvianPVT9` at `0x8b2306be…` and `ProvianPVT9EligibilityVerifier` at
 * `0xEfbC0651…`, their storage, epoch-zero arming, epoch 0's policy and its snapshotted
 * verifier configuration — all of it forked from Base mainnet at a live block. Firestore is the
 * real emulator with real query semantics, not the in-memory test fake.
 *
 * NOT REAL, DELIBERATELY: the two operator EOAs. The fork repoints `operationalMinter` and
 * `batchApprover` to anvil's own published test accounts, so no production key material is ever
 * loaded, decrypted, or held by this process. That is why the harness cannot accidentally touch
 * mainnet: it holds no key that mainnet would honour.
 *
 * Run: `scripts/wp4-fork-e2e.sh`, which starts anvil + the emulator and repoints the roles.
 */

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import * as admin from 'firebase-admin';
import { GENESIS_PREV_HASH } from '../src/core/pe/constants';
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../src/core/pvt/wp-ev/eligibility';
import {
  runEpochKeeperRuntime,
  runSettlement,
  summarizeSettlementRun,
} from '../src/core/pvt/wp4/operator-runtime';
import {
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  WALLETS_COLLECTION,
} from '../src/core/pvt/wp4/claim-inlet-source';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf } from '../src/core/pvt/wp4/durable-settlement-store';
import { GENESIS_QUALIFICATION_COLLECTION } from '../src/core/pvt/wp4/genesis-inlet-source';
import {
  RECONCILIATION_CURRENT_DOC,
  RECONCILIATION_REPORTS_COLLECTION,
  JUDGEABLE_REPORT_SCHEMA,
  recomputeReportSha256,
} from '../src/core/pvt/wp4/standard-lane-recon-gate';
import { DEPLOYED_TREE_GIT_HEAD } from '../src/core/pvt/tree-stamp.generated';
import type { SettlementDb } from '../src/core/pvt/wp4/durable-settlement-store';

/**
 * an EMULATOR-ONLY admitting reconciliation report, bound to the tree
 * stamp, so `judgeStandardLaneAdmission` inside the production `runSettlement`
 * path admits the standard lane through its real code (digest recompute, tree
 * comparison, check rows). The caller has already proven
 * FIRESTORE_EMULATOR_HOST is set; this never touches a real database.
 */
async function publishAdmittingFixtureReport(
  firestore: admin.firestore.Firestore,
  gitHead: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    schema_version: JUDGEABLE_REPORT_SCHEMA,
    cut_line_ms: PVT9_ELIGIBILITY_CUT_LINE_MS,
    inventory: { note: 'fork-e2e fixture; unused when C1/C3/C6 pass' },
    cursors: {},
    checks: [
      { id: 'C1_batch_graph_complete', status: 'pass', evaluated_items: 1, detail: 'fixture' },
      { id: 'C3_recipients_resolve', status: 'pass', evaluated_items: 1, detail: 'fixture' },
      { id: 'C6_genesis_pool_ledger_exact', status: 'pass', evaluated_items: 1, detail: 'fixture' },
    ],
    bound_tree: { git_head: gitHead, tree_dirty: false },
    c6_downgrade: null,
    acknowledged_vacuous_checks: [],
    reconciled: false,
    reconciled_excluding_not_evaluated: false,
  };
  const sha = recomputeReportSha256(body);
  if (sha === null) fail('fixture report unserializable');
  const report = { ...body, report_sha256: sha };
  await firestore.collection(RECONCILIATION_REPORTS_COLLECTION)
    .doc(RECONCILIATION_CURRENT_DOC)
    .set({
      schema_version: 'pvt9-reconciliation-publication/v1',
      report_json: JSON.stringify(report),
      report_sha256: sha,
      git_head: gitHead,
      published_at_ms: Date.now(),
    });
  console.log(`fixture reconciliation report published (sha ${String(sha).slice(0, 12)}…, tree ${gitHead.slice(0, 12)}…)`);
}

const RPC = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const KERNEL = '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61';

/** anvil accounts #3 and #4. Published test keys; they control nothing anywhere else. */
const EARNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const GENESIS_EARNER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const KERNEL_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function currentEpoch() view returns (uint64)',
  'function lastOpenedEpoch() view returns (uint64)',
  'function nextFinalizedCursor() view returns (uint256)',
  'function claimSettled(bytes32) view returns (bool)',
  'function genesisAnchorUsed(bytes32) view returns (bool)',
  'function getEpochPolicy(uint64) view returns (tuple(bool opened, uint64 epoch, uint64 startsAt,'
    + ' uint8 combinedCapMode, uint256 mintRate, uint256 genesisCap, uint256 combinedCap,'
    + ' address provianTreasury, address foundationTreasury, uint256 agentFoundationBps,'
    + ' tuple(address verifier, bytes32 configurationId, uint64 version) beneficiaryVerifier,'
    + ' tuple(address verifier, bytes32 configurationId, uint64 version) eligibilityVerifier,'
    + ' bytes32 policyHash))',
] as const;

function fail(message: string): never {
  console.error(`FORK E2E FAILED: ${message}`);
  process.exit(1);
}

/**
 * A synthetic qualifying act, written the way the relay writes one.
 *
 * The timestamp is deliberately AFTER `PVT9_ELIGIBILITY_CUT_LINE_MS` (bound to the module's own
 * constant, not a literal) and `prev_hash` is the genesis sentinel so the chain link is real
 * rather than asserted. Every other field name comes from `PEHistoryDocument`.
 */
async function seedQualifyingAct(db: admin.firestore.Firestore, peId: string): Promise<void> {
  const timestamp = PVT9_ELIGIBILITY_CUT_LINE_MS + 60_000;

  await db.collection(WALLETS_COLLECTION).doc('w-fork-earner').set({
    user_id: 'fork-earner', type: 'human', address: EARNER.toLowerCase(),
  });

  await db.collection(ENVELOPES_COLLECTION).doc(peId).set({
    id: peId,
    prev_hash: GENESIS_PREV_HASH,
    hash: `0x${'7e'.repeat(32)}`,
    timestamp,
    action_type: 'agent_task_completed',
    user_id: 'fork-earner',
    counterparty_address: null,
    counterparty_type: null,
    durability: 'final',
  });

  await db.collection(PE_HISTORY_COLLECTION).doc(peId).set({
    peId,
    userId: 'fork-earner',
    timestamp,
    attestationDepth: 'software',
    // Production-shaped for the STANDARD lane: `server.ts` (device/wallet registration) and
    // `routes/devices.ts` do pass `attestation_verified: true` on real submissions. The Genesis
    // path does not — see `seedGenesisAct`.
    attestation_verified: true,
    mint_status: 'eligible',
    record_points_atomic: '1000000000000000000',
    corroboration_status: 'none',
    is_genesis_grant: false,
    replication_pack: {
      input_hash: null,
      output_hash: `0x${'a7'.repeat(32)}`,
      model_id: null,
      model_checkpoint_hash: null,
      pack_hash: null,
    },
  });
}

/**
 * A synthetic GENESIS qualifying act: a completed reservation in the state machine's outbox,
 * plus its PE. This is the lane with real qualifying acts already waiting, and the one whose
 * economics are a fixed grant rather than record points.
 */
async function seedGenesisAct(
  db: admin.firestore.Firestore,
  params: { peId: string; qualificationId: string; walletId: string; address: string },
): Promise<void> {
  // Inside the on-chain Genesis window (`genesisStartsAt` 2026-07-27, `genesisEndsAt`
  // 2026-10-19) and after the eligibility cut line. The kernel checks both, in chain time.
  const qualifyingAtMs = 1_785_110_400_000 + 3_600_000;

  await db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(params.qualificationId).set({
    schema_version: 'pvt-genesis-qualification/v2',
    qualification_id: params.qualificationId,
    pe_id: params.peId,
    action_type: 'genesis_human_signup',
    wallet_id: params.walletId,
    economic_actor_id: 'fork-genesis-earner',
    actor_address: params.address.toLowerCase(),
    immutable_anchor: { anchor_kind: 'wallet_id', anchor_id: params.walletId },
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: 'fork-evidence-1',
      evidence_hash: 'fork-evidence-hash-1',
      subject_wallet_id: params.walletId,
      canonical_bounty_key: 'genesis_human_signup',
      qualifying_act: 'wallet_created',
      immutable_anchor_kind: 'wallet_id',
      immutable_anchor_id: params.walletId,
      qualifying_act_at_ms: qualifyingAtMs,
    },
    status: 'complete',
    reserved_atomic: '75000000000000000000',
    created_at_ms: qualifyingAtMs,
    updated_at_ms: qualifyingAtMs,
    completed_at_ms: qualifyingAtMs,
  });

  await db.collection(ENVELOPES_COLLECTION).doc(params.peId).set({
    id: params.peId,
    prev_hash: GENESIS_PREV_HASH,
    hash: `0x${'6e'.repeat(32)}`,
    timestamp: qualifyingAtMs,
    action_type: 'genesis_human_signup',
    user_id: 'fork-genesis-earner',
    counterparty_address: null,
    counterparty_type: null,
    // THE AUTHOR. `generatePE` stamps this on every envelope it writes, and it is what
    // classifies the act as `server_authored` rather than `unverified`. Omitting it is the same
    // fixture defect in a new place: the first run of this harness after the provenance change
    // registered ZERO Genesis claims because of exactly that.
    integration_source: 'agent_bank_generate_pe',
    durability: 'final',
  });

  await db.collection(PE_HISTORY_COLLECTION).doc(params.peId).set({
    peId: params.peId,
    userId: 'fork-genesis-earner',
    timestamp: qualifyingAtMs,
    attestationDepth: 'software',
    // `attestation_verified` is ABSENT, exactly as production writes it: the Genesis state
    // machine emits through `agent-bank/pe-utils.ts::generatePE`, which never sets the field,
    // so `pe-history.ts` defaults it to false. The earlier version of this harness hard-coded
    // `true` here and produced a Genesis settlement production could never reproduce. See
    // `wp4/genesis-signature-gate.test.ts`.
    mint_status: 'eligible',
    record_points_atomic: '75000000000000000000',
    corroboration_status: 'none',
    is_genesis_grant: true,
    replication_pack: null,
  });
}

async function main(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST === undefined) {
    fail('FIRESTORE_EMULATOR_HOST is not set. This harness refuses to touch a real database.');
  }
  const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const kernel = new Contract(KERNEL, KERNEL_ABI as unknown as string[], provider);

  const code = await provider.getCode(KERNEL);
  if (code === '0x') fail(`no kernel code at ${KERNEL} — is anvil forking Base?`);

  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
  const firestore = admin.firestore();
  const db = firestore as unknown as SettlementDb;

  const peId = `pe-fork-${process.env.FORK_RUN_ID ?? '1'}`;
  const genesisPeId = `pe-fork-genesis-${process.env.FORK_RUN_ID ?? '1'}`;
  await seedQualifyingAct(firestore, peId);
  await seedGenesisAct(firestore, {
    peId: genesisPeId,
    qualificationId: 'q-fork-1',
    walletId: 'wallet_fork_genesis_1',
    address: GENESIS_EARNER,
  });
  console.log(`SEEDED standard act ${peId} -> ${EARNER}`);
  console.log(`SEEDED genesis act  ${genesisPeId} -> ${GENESIS_EARNER}`);

  const before = {
    balance: BigInt(await kernel.balanceOf(EARNER)),
    genesisBalance: BigInt(await kernel.balanceOf(GENESIS_EARNER)),
    supply: BigInt(await kernel.totalSupply()),
    cursor: BigInt(await kernel.nextFinalizedCursor()),
  };
  console.log('BEFORE', {
    earnerBalance: before.balance.toString(),
    genesisEarnerBalance: before.genesisBalance.toString(),
    totalSupply: before.supply.toString(),
    cursor: before.cursor.toString(),
  });

  // ---- The production path, unmodified ------------------------------------------------
  const env = { ...process.env, BASE_RPC_URL: RPC };

  // the standard-lane reconciliation gate is part of the production
  // path this e2e proves. The flow is the OPERATOR's own flow, no test seam:
  // stamp the tree (`node scripts/stamp-tree-for-deploy.mjs`), and this
  // harness publishes a minimal admitting v5 report bound to that stamp into
  // its own Firestore. A null stamp fails here with the same instruction an
  // operator would get.
  if (DEPLOYED_TREE_GIT_HEAD === null) {
    fail('tree stamp is null — run `node scripts/stamp-tree-for-deploy.mjs` first '
      + '(and `--reset` after); the settlement gate refuses an unstamped runtime by design');
  }
  await publishAdmittingFixtureReport(firestore, DEPLOYED_TREE_GIT_HEAD);

  const dry = await runSettlement({ db, env, dryRun: true, log: console.log });
  console.log('DRY RUN', JSON.stringify(summarizeSettlementRun(dry), null, 2));
  if (dry.standardInlet.registered !== 1) {
    fail(`the standard inlet registered ${dry.standardInlet.registered} claims, expected 1. `
      + `skips=${JSON.stringify(dry.standardInlet.skips)}`);
  }
  // The Genesis lane settles, on a PRODUCTION-SHAPED fixture: no `attestation_verified`, so the
  // PE classifies as `server_authored` and is eligible on its own honest provenance rather than
  // on a claimed signature that does not exist.
  if (dry.genesisInlet.registered !== 1) {
    fail(`the Genesis inlet registered ${dry.genesisInlet.registered} claims, expected 1. `
      + `skips=${JSON.stringify(dry.genesisInlet.skips)}`);
  }

  const ledger = await firestore.collection(CLAIM_LEDGER_COLLECTION)
    .doc(claimKeyOf(peId, 'sole')).get();
  if (!ledger.exists) fail('no claim ledger row was written');
  const claimId = String(ledger.data()?.claim_id);
  console.log(`CLAIM ${claimId} contributor=${ledger.data()?.contributor}`);
  if (await kernel.claimSettled(claimId)) fail('the claim id is already settled on chain');

  const armed = await runSettlement({ db, env, dryRun: false, log: console.log });
  console.log('SETTLEMENT', JSON.stringify(summarizeSettlementRun(armed), null, 2));

  // ---- What actually happened on chain ------------------------------------------------
  const after = {
    balance: BigInt(await kernel.balanceOf(EARNER)),
    genesisBalance: BigInt(await kernel.balanceOf(GENESIS_EARNER)),
    supply: BigInt(await kernel.totalSupply()),
    cursor: BigInt(await kernel.nextFinalizedCursor()),
  };
  console.log('AFTER', {
    earnerBalance: after.balance.toString(),
    genesisEarnerBalance: after.genesisBalance.toString(),
    totalSupply: after.supply.toString(),
    cursor: after.cursor.toString(),
  });

  if (!(await kernel.claimSettled(claimId))) fail('claimSettled is still false — nothing settled');
  if (after.balance <= before.balance) fail('the earner balance did not increase');
  if (after.cursor <= before.cursor) fail('the finalized cursor did not advance');

  // 1 PVT gross at the epoch-0 mint rate, split 99 / 0.5 / 0.5. The contributor's 99% is the
  // number that proves the immutable floor was applied and not bypassed.
  const expectedContributor = 990_000000000000000n;
  if (after.balance - before.balance !== expectedContributor) {
    fail(`contributor received ${after.balance - before.balance}, expected ${expectedContributor}`);
  }
  const settledRow = await firestore.collection(CLAIM_LEDGER_COLLECTION)
    .doc(claimKeyOf(peId, 'sole')).get();
  if (settledRow.data()?.settled !== true) fail('the ledger row was not marked settled');

  // The Genesis lane: 75 PVT gross under the same immutable 99 / 0.5 / 0.5 split.
  const expectedGenesisContributor = 74_250000000000000000n;
  if (after.genesisBalance - before.genesisBalance !== expectedGenesisContributor) {
    fail(`Genesis contributor received ${after.genesisBalance - before.genesisBalance}, `
      + `expected ${expectedGenesisContributor}`);
  }
  const genesisRow = await firestore.collection(CLAIM_LEDGER_COLLECTION)
    .doc(claimKeyOf(genesisPeId, 'sole')).get();
  if (genesisRow.data()?.settled !== true) fail('the Genesis ledger row was not marked settled');
  const anchorKey = String(genesisRow.data()?.genesis_anchor_key);
  if (!(await kernel.genesisAnchorUsed(anchorKey))) {
    fail('genesisAnchorUsed is false for the settled anchor key — the derivation disagrees '
      + 'with the kernel');
  }

  console.log('\n=== BOTH LANES SETTLED ===');
  console.log(`standard contributor +${after.balance - before.balance} atomic PVT`);
  console.log(`genesis  contributor +${after.genesisBalance - before.genesisBalance} atomic PVT`);
  console.log(`genesisAnchorUsed[${anchorKey}] = true`);
  console.log(`total supply ${before.supply} -> ${after.supply}`);
  console.log(`cursor ${before.cursor} -> ${after.cursor}`);
  console.log(`ledger row settled=${settledRow.data()?.settled} tx=${settledRow.data()?.settled_tx_hash}`);

  // ---- The epoch keeper, on the SAME fork ---------------------------------------------
  // Run it BEFORE any time warp: nothing is owed, so a keeper that opens anything here is
  // broken. This is the harness's own empty-population guard.
  const quiet = await runEpochKeeperRuntime({ db, env, log: console.log });
  console.log('KEEPER (nothing owed)', JSON.stringify({
    stopReason: quiet.keeper.stopReason,
    opened: quiet.keeper.opened,
    lag: quiet.keeper.lag.level,
    capClock: quiet.capClock.level,
  }, null, 2));
  if (quiet.keeper.opened.length !== 0) fail('the keeper opened an epoch that was not due');
  if (quiet.keeper.lag.level !== 'ok') fail(`expected lag ok, got ${quiet.keeper.lag.level}`);
  // Epoch 0 is Automatic with zero issuance until this run; after settling, issuance exists.
  console.log(`CAP CLOCK before epoch 1: ${quiet.capClock.level} — ${quiet.capClock.message}`);

  // Warp past the epoch-0 boundary. `evm_increaseTime` + `evm_mine` is the fork's own clock;
  // the kernel reads `block.timestamp`, so this is the same fact it will see on 2026-08-03.
  const epochDuration = 7 * 24 * 60 * 60;
  await provider.send('evm_increaseTime', [epochDuration + 120]);
  await provider.send('evm_mine', []);
  console.log(`\nWARPED past the epoch-0 boundary. currentEpoch=${await kernel.currentEpoch()} `
    + `lastOpenedEpoch=${await kernel.lastOpenedEpoch()}`);

  const due = await runEpochKeeperRuntime({ db, env, log: console.log });
  console.log('KEEPER (epoch 1 due)', JSON.stringify({
    stopReason: due.keeper.stopReason,
    opened: due.keeper.opened,
    stillOwed: due.keeper.stillOwed,
    lag: due.keeper.lag,
    capClock: { level: due.capClock.level, message: due.capClock.message },
  }, null, 2));

  if (due.keeper.opened.length !== 1 || due.keeper.opened[0].epoch !== 1) {
    fail(`expected the keeper to open exactly epoch 1, got ${JSON.stringify(due.keeper.opened)}`);
  }
  if (Number(await kernel.lastOpenedEpoch()) !== 1) fail('epoch 1 is not open on chain');
  if (due.keeper.lag.alarm) fail('the keeper still alarms after opening epoch 1');

  // the operator scheduled Fixed / MAX / MAX for epoch 1. Opening epoch 1 is what applies it.
  const policy1 = await kernel.getEpochPolicy(1);
  const MAX_UINT256 = (1n << 256n) - 1n;
  console.log('EPOCH 1 POLICY', {
    opened: policy1.opened,
    combinedCapMode: Number(policy1.combinedCapMode),
    genesisCap: BigInt(policy1.genesisCap) === MAX_UINT256 ? 'MAX_UINT256' : String(policy1.genesisCap),
    combinedCap: BigInt(policy1.combinedCap) === MAX_UINT256 ? 'MAX_UINT256' : String(policy1.combinedCap),
    mintRate: String(policy1.mintRate),
  });
  if (policy1.opened !== true) fail('epoch 1 policy is not opened');
  if (Number(policy1.combinedCapMode) !== 1) fail('epoch 1 is not in Fixed cap mode');
  if (BigInt(policy1.combinedCap) !== MAX_UINT256) fail('epoch 1 combined cap is not MAX_UINT256');
  if (BigInt(policy1.genesisCap) !== MAX_UINT256) fail('epoch 1 genesis cap is not MAX_UINT256');
  if (due.capClock.level !== 'not_applicable') {
    fail(`cap clock should be not_applicable under a Fixed cap, got ${due.capClock.level}`);
  }

  // Idempotency, proven rather than asserted: run it again, immediately.
  const again = await runEpochKeeperRuntime({ db, env, log: console.log });
  if (again.keeper.opened.length !== 0) fail('a second keeper run opened another epoch');
  if (again.keeper.stopReason !== 'up_to_date') {
    fail(`second run stopped with ${again.keeper.stopReason}`);
  }

  console.log('\n=== EPOCH KEEPER PROVEN ===');
  console.log(`epoch 1 opened in ${due.keeper.opened[0].txHash}`);
  console.log('cap policy is Fixed / MAX / MAX; cap clock is not_applicable');
  console.log('a second run opened nothing (idempotent)');
}

main().catch((error) => {
  console.error('fork e2e failed:', error);
  process.exit(1);
});
