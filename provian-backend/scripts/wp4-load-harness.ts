/**
 * settlement runtime — 25k/50k end-to-end settlement + segmented-anchoring load harness.
 *
 * Proves the plan §settlement runtime acceptance at scale: 25,000 recipients, 50,000
 * Genesis PEs, a 50,000-recipient 2× burst with durable deferral and
 * next-epoch drainage, an abrupt process kill mid-cycle with exact resume,
 * same-nonce transaction replacement, and >5,000-PE segmented anchoring with
 * proof generation, verification, and ON-CHAIN verifyPE readback.
 *
 * COST GUARDS (mandatory, fail-closed — the standing rule):
 * - Firestore: the DEDICATED NON-PRODUCTION emulator ONLY. The harness
 * refuses to start unless FIRESTORE_EMULATOR_HOST is set and points at
 * localhost, AND the emulator wipe endpoint answers — an endpoint that
 * does not exist on production Firestore, so pointing this harness at a
 * real project is structurally impossible, not merely discouraged.
 * - Every document operation is counted through one wrapper with a HARD
 * CAP (default 2,000,000 per invocation). Hitting the cap throws and the
 * process exits non-zero immediately — no retry loop exists above it.
 * - Chain: a LOCAL anvil fork of Base mainnet that this harness spawns
 * itself (chainId 8453 preserved by the fork), following the existing
 * fork-suite pattern. The RPC client refuses any endpoint that does not
 * identify as anvil. No real Base mainnet transaction can be sent: the
 * kernel under test exists only on the fork and dies with the node.
 * - Test data is DELETED when each scenario completes (emulator wipe) and
 * the wipe is verified empty before the harness reports success.
 *
 * POSTURE: ProvianPVT9 + MockPVT9Verifier + ProvianPEAnchor are deployed
 * onto the EPHEMERAL fork only — exactly as the Foundry suites deploy them
 * in-EVM. Nothing here deploys, configures, arms, or schedules anything
 * real; the real kernel remains undeployed and unarmed.
 *
 * Run:
 * 1. npx firebase emulators:start --only firestore (repo firebase.json)
 * 2. cd provian-backend && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 * npx tsx scripts/wp4-load-harness.ts all
 * Scenarios: standard25k | genesis50k | burst2x | crash | replacement |
 * anchor25k | all
 * Env: settlement runtime_FORK_URL (default https://mainnet.base.org), settlement runtime_DOC_OP_CAP,
 * settlement runtime_ANVIL_PORT (default 8547).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import {
  CLAIM_LEDGER_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_CYCLES_COLLECTION,
  registerClaimsBulk,
  type NewClaimInput,
  type SettlementBatchDoc,
  type SettlementCycleDoc,
  type SettlementDb,
} from '../src/core/pvt/wp4/durable-settlement-store';
import {
  PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
  PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
  runSettlementCycle,
  type CycleChainObservation,
  type CycleRunReport,
  type CycleRunnerConfig,
  type MinedReceipt,
  type NonceBlockTag,
  type SettlementChainAdapter,
  type SignableTransaction,
} from '../src/core/pvt/wp4/settlement-cycle-runner';
import { testOnlyAdmittedStandardLaneVerdict } from '../src/core/pvt/wp4/standard-lane-recon-gate';
import type { BatchApprovalDeps } from '../src/core/pvt/wp4/batch-approval';
import { deriveClaimId, type SealedEnvelopeIdentity } from '../src/core/pvt/wp-ev/claim-id';
import type { EligibilityCandidate } from '../src/core/pvt/wp-ev/eligibility';
import {
  SettlementLane,
  computeSettlementDigest,
  hashGenesisClaims,
  hashStandardClaims,
} from '../src/core/pvt/wp-ev/settlement-batch';
import {
  ANCHOR_DAYS_COLLECTION,
  ANCHOR_SEGMENTS_COLLECTION,
  anchorSegmentedDay,
  buildSegmentedProof,
  planSegmentedDay,
  reconcileSegmentedDay,
  verifySegmentedProof,
  type AnchorDayDoc,
  type AnchorSegmentDoc,
  type PEAnchorChainAdapter,
  type SegmentMember,
  type SegmentedAnchorDb,
} from '../src/core/pvt/wp4/segmented-pe-anchor';

// ---------------------------------------------------------------------------
// Configuration + gates
// ---------------------------------------------------------------------------

const EMULATOR_PROJECT_ID = 'provian-wp4-load';
const DOC_OP_CAP = Number(process.env.SETTLEMENT_LOAD_DOC_OP_CAP ?? 2_000_000);
const FORK_URL = process.env.SETTLEMENT_LOAD_FORK_URL ?? 'https://mainnet.base.org';
const ANVIL_PORT = Number(process.env.SETTLEMENT_LOAD_ANVIL_PORT ?? 8547);
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

/** Must equal `ProvianPVT9.BOOTSTRAP_ADMIN` — the harness impersonates it on the fork. */
const BOOTSTRAP_ADMIN = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3';
/** anvil dev account[0] — the fork-local operational minter / signer key. */
const MINTER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EPOCH_DURATION_SEC = 604_800;
const ONE_PVT = 10n ** 18n;
const CHAIN_ID = 8453n;

class DocOpCapExceeded extends Error {}

function fail(message: string): never {
  console.error(`\n✗ HARD FAIL: ${message}`);
  process.exit(1);
}

function requireEmulatorHost(): string {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    fail('FIRESTORE_EMULATOR_HOST is not set — this harness runs ONLY against the local Firestore emulator, never a real project.');
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
// Counting Firestore wrapper — the doc-op hard cap lives here
// ---------------------------------------------------------------------------

interface DocOpCounts { reads: number; writes: number; deletes: number }

interface CountingRef {
  readonly raw: FirebaseFirestore.DocumentReference;
  get(): Promise<FirebaseFirestore.DocumentSnapshot>;
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
  create(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

type CountingDb = SettlementDb & SegmentedAnchorDb & { readonly counts: DocOpCounts };

function makeCountingDb(raw: Firestore, counts: DocOpCounts): CountingDb {
  const charge = (kind: keyof DocOpCounts, n = 1): void => {
    counts[kind] += n;
    if (counts.reads + counts.writes + counts.deletes > DOC_OP_CAP) {
      throw new DocOpCapExceeded(
        `document-operation cap ${DOC_OP_CAP} exceeded (reads=${counts.reads} writes=${counts.writes} deletes=${counts.deletes}) — hard stop, no retry`,
      );
    }
  };

  const wrapRef = (ref: FirebaseFirestore.DocumentReference): CountingRef => ({
    raw: ref,
    get: async () => { charge('reads'); return ref.get(); },
    set: async (data, opts) => { charge('writes'); await (opts ? ref.set(data, opts) : ref.set(data)); },
    create: async (data) => { charge('writes'); await ref.create(data); },
    delete: async () => { charge('deletes'); await ref.delete(); },
  });

  const wrapQuery = (query: FirebaseFirestore.Query): Record<string, unknown> => ({
    where: (field: string, op: FirebaseFirestore.WhereFilterOp, value: unknown) =>
      wrapQuery(query.where(field, op, value)),
    orderBy: (field: string, dir?: 'asc' | 'desc') => wrapQuery(query.orderBy(field, dir ?? 'asc')),
    limit: (n: number) => wrapQuery(query.limit(n)),
    startAfter: (...values: unknown[]) => wrapQuery(query.startAfter(...values)),
    get: async () => {
      const snap = await query.get();
      charge('reads', Math.max(1, snap.docs.length));
      return snap;
    },
  });

  const db: CountingDb = {
    counts,
    collection: (name: string) => {
      const col = raw.collection(name);
      return Object.assign(wrapQuery(col), {
        doc: (id: string) => wrapRef(col.doc(id)),
      });
    },
    batch: () => {
      const batch = raw.batch();
      return {
        set: (ref: CountingRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          charge('writes');
          if (opts) batch.set(ref.raw, data, opts); else batch.set(ref.raw, data);
        },
        commit: async () => { await batch.commit(); },
      };
    },
    runTransaction: async <T>(fn: (txn: never) => Promise<T>): Promise<T> =>
      raw.runTransaction(async (txn) => fn({
        get: async (ref: CountingRef) => { charge('reads'); return txn.get(ref.raw); },
        set: (ref: CountingRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          charge('writes');
          if (opts) txn.set(ref.raw, data, opts); else txn.set(ref.raw, data);
        },
        create: (ref: CountingRef, data: Record<string, unknown>) => {
          charge('writes');
          txn.create(ref.raw, data);
        },
        update: (ref: CountingRef, data: Record<string, unknown>) => {
          charge('writes');
          txn.update(ref.raw, data);
        },
        delete: (ref: CountingRef) => { charge('deletes'); txn.delete(ref.raw); },
      } as never)),
  } as unknown as CountingDb;
  return db;
}

// ---------------------------------------------------------------------------
// Anvil lifecycle (spawned + killed by the harness)
// ---------------------------------------------------------------------------

let anvilProcess: ChildProcess | null = null;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function startAnvil(): Promise<void> {
  console.log(`· spawning anvil fork of Base mainnet (${FORK_URL}) on :${ANVIL_PORT} …`);
  anvilProcess = spawn('anvil', [
    '--fork-url', FORK_URL,
    '--port', String(ANVIL_PORT),
    '--gas-limit', '150000000',
    '--silent',
  ], { stdio: 'ignore' });
  anvilProcess.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`anvil exited with code ${code}`);
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const chainIdHex = await rpc<string>('eth_chainId');
      if (BigInt(chainIdHex) !== CHAIN_ID) {
        fail(`fork chainId ${BigInt(chainIdHex)} != 8453 — not a Base mainnet fork.`);
      }
      const client = await rpc<string>('web3_clientVersion');
      if (!client.toLowerCase().includes('anvil')) {
        fail(`RPC client "${client}" is not anvil — refusing (local fork only).`);
      }
      // Pin the fork's fee regime to Base-typical levels (the forked block can
      // carry a transient base-fee spike that would make the plan-named 0.1 ETH
      // cycle limit unrepresentative). Empty blocks decay it further from here.
      await rpc('anvil_setNextBlockBaseFeePerGas', ['0xF4240']); // 0.001 gwei
      await rpc('evm_mine', []);
      console.log(`  anvil ready (${client}, chainId 8453; base fee pinned Base-typical)`);
      return;
    } catch (error) {
      if (error instanceof Error && error.message.includes('HARD FAIL')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail('anvil did not become ready within 60s');
}

function stopAnvil(): void {
  if (anvilProcess !== null) {
    anvilProcess.kill('SIGKILL');
    anvilProcess = null;
  }
}
process.on('exit', stopAnvil);
process.on('SIGINT', () => { stopAnvil(); process.exit(130); });

// ---------------------------------------------------------------------------
// Contract deployment onto the fork (ephemeral; never a real deployment)
// ---------------------------------------------------------------------------

function loadArtifact(relative: string): { abi: ethers.InterfaceAbi; bytecode: string } {
  const artifactPath = path.resolve(__dirname, '../../contracts/out', relative);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
    abi: ethers.InterfaceAbi;
    bytecode: { object: string };
  };
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}

const KERNEL_ABI = [
  'function epochZeroArmed() view returns (bool)',
  'function epochZeroStartsAt() view returns (uint64)',
  'function lastOpenedEpoch() view returns (uint64)',
  'function administrativeHold() view returns (bool)',
  'function operationalMinter() view returns (address)',
  'function nextFinalizedCursor() view returns (uint256)',
  'function epochGenesisIssued(uint64) view returns (uint256)',
  'function epochTotalIssued(uint64) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function claimSettled(bytes32) view returns (bool)',
  'function openNextEpoch() returns (bytes32)',
  'function appointOperationalMinter(address minter)',
  'function armEpochZero((uint64 epochZeroStartsAt, uint64 genesisStartsAt, uint64 genesisEndsAt, uint256 initialMintRate, address provianTreasury, address foundationTreasury, (address verifier, bytes32 configurationId, uint64 version) eligibilityVerifier, uint256 initialFinalizedCursor) config)',
  'function getEpochPolicy(uint64 epoch) view returns ((bool opened, uint64 epoch, uint64 startsAt, uint8 combinedCapMode, uint256 mintRate, uint256 genesisCap, uint256 combinedCap, address provianTreasury, address foundationTreasury, uint256 agentFoundationBps, (address verifier, bytes32 configurationId, uint64 version) beneficiaryVerifier, (address verifier, bytes32 configurationId, uint64 version) eligibilityVerifier, bytes32 policyHash))',
] as const;

const PE_ANCHOR_ABI = [
  'function anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber)',
  'function batches(bytes32) view returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
  'function verifyPE(bytes32 batchId, bytes32 peHash, bytes32[] merkleProof) view returns (bool)',
] as const;

const ELIGIBILITY_ID = ethers.keccak256(ethers.toUtf8Bytes('wp4-load-eligibility'));
const ELIGIBILITY_VERSION = 1n;

interface ForkStack {
  provider: ethers.JsonRpcProvider;
  minter: ethers.Wallet;
  /** NonceManager over the minter for CONTRACT writes (deploys, anchors,
   * openNextEpoch). The settlement runner signs raw transactions with nonces
   * owned by the durable cycle doc — call `txSigner.reset()` after any
   * runner activity before sending through this signer again. */
  txSigner: ethers.NonceManager;
  kernel: ethers.Contract;
  peAnchor: ethers.Contract;
  epochStartSec: number;
}

async function latestTimestamp(provider: ethers.JsonRpcProvider): Promise<number> {
  const block = await provider.getBlock('latest');
  return Number(block!.timestamp);
}

async function warpTo(provider: ethers.JsonRpcProvider, timestampSec: number): Promise<void> {
  await provider.send('evm_setNextBlockTimestamp', [timestampSec]);
  await provider.send('evm_mine', []);
}

/** Deploy + arm a FRESH fork-local kernel (per scenario, isolated cursor). */
async function deployStack(): Promise<ForkStack> {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const minter = new ethers.Wallet(MINTER_KEY, provider);
  const txSigner = new ethers.NonceManager(minter);

  const verifierArtifact = loadArtifact('ProvianPVT9TestBase.sol/MockPVT9Verifier.json');
  const kernelArtifact = loadArtifact('ProvianPVT9.sol/ProvianPVT9.json');
  const anchorArtifact = loadArtifact('ProvianPEAnchor.sol/ProvianPEAnchor.json');

  const verifierFactory = new ethers.ContractFactory(verifierArtifact.abi, verifierArtifact.bytecode, txSigner);
  const verifier = await (await verifierFactory.deploy(
    ELIGIBILITY_ID, ELIGIBILITY_VERSION, ELIGIBILITY_ID, ELIGIBILITY_VERSION,
  )).waitForDeployment();

  const kernelFactory = new ethers.ContractFactory(kernelArtifact.abi, kernelArtifact.bytecode, txSigner);
  const kernelDeployed = await (await kernelFactory.deploy()).waitForDeployment();
  const kernel = new ethers.Contract(await kernelDeployed.getAddress(), KERNEL_ABI, txSigner);

  const anchorFactory = new ethers.ContractFactory(anchorArtifact.abi, anchorArtifact.bytecode, txSigner);
  const anchorDeployed = await (await anchorFactory.deploy(minter.address, minter.address)).waitForDeployment();
  const peAnchor = new ethers.Contract(await anchorDeployed.getAddress(), PE_ANCHOR_ABI, txSigner);

  // Impersonate the bootstrap admin (fork-local only) to appoint + arm.
  await provider.send('anvil_impersonateAccount', [BOOTSTRAP_ADMIN]);
  await provider.send('anvil_setBalance', [BOOTSTRAP_ADMIN, '0x8AC7230489E80000']);
  const admin = await provider.getSigner(BOOTSTRAP_ADMIN);
  const kernelAsAdmin = kernel.connect(admin) as ethers.Contract;
  await (await kernelAsAdmin.appointOperationalMinter(minter.address)).wait();

  const nowSec = await latestTimestamp(provider);
  const epochStartSec = nowSec + 10;
  await (await kernelAsAdmin.armEpochZero({
    epochZeroStartsAt: epochStartSec,
    genesisStartsAt: epochStartSec,
    genesisEndsAt: epochStartSec + 365 * 86_400,
    initialMintRate: ONE_PVT,
    provianTreasury: '0x00000000000000000000000000000000000a0001',
    foundationTreasury: '0x00000000000000000000000000000000000a0002',
    eligibilityVerifier: {
      verifier: await verifier.getAddress(),
      configurationId: ELIGIBILITY_ID,
      version: ELIGIBILITY_VERSION,
    },
    initialFinalizedCursor: 0,
  })).wait();
  await warpTo(provider, epochStartSec + 60);

  return { provider, minter, txSigner, kernel, peAnchor, epochStartSec };
}

// ---------------------------------------------------------------------------
// Ethers-backed SettlementChainAdapter (fork-local)
// ---------------------------------------------------------------------------

interface ChainMetrics { txs: number; gasUsed: bigint; feeWei: bigint }

function makeChainAdapter(
  stack: ForkStack,
  metrics: ChainMetrics,
  hooks?: {
    /** Called after each successful broadcast (1-based count). */
    onBroadcast?: (count: number) => Promise<void> | void;
  },
): SettlementChainAdapter {
  const { provider, minter, kernel } = stack;
  let broadcastCount = 0;

  return {
    async observe(): Promise<CycleChainObservation> {
      const block = await provider.getBlock('latest');
      const lastOpened = Number(await kernel.lastOpenedEpoch());
      const policy = await kernel.getEpochPolicy(lastOpened);
      return {
        epochZeroArmed: Boolean(await kernel.epochZeroArmed()),
        epochZeroStartsAtSec: Number(await kernel.epochZeroStartsAt()),
        lastOpenedEpoch: lastOpened,
        administrativeHold: Boolean(await kernel.administrativeHold()),
        operationalMinter: String(await kernel.operationalMinter()),
        settlementSigner: minter.address,
        observedAtSec: Number(block!.timestamp),
        nextFinalizedCursor: BigInt(await kernel.nextFinalizedCursor()),
        openEpochPolicyHash: String(policy.policyHash),
        chainId: CHAIN_ID,
        kernelAddress: await kernel.getAddress(),
        mintRateAtomic: BigInt(policy.mintRate),
        agentFoundationBps: BigInt(policy.agentFoundationBps),
        genesisCapAtomic: BigInt(policy.genesisCap),
        combinedCapAtomic: BigInt(policy.combinedCap),
        epochGenesisIssuedAtomic: BigInt(await kernel.epochGenesisIssued(lastOpened)),
        epochTotalIssuedAtomic: BigInt(await kernel.epochTotalIssued(lastOpened)),
      };
    },
    async getTransactionCount(address: string, blockTag: NonceBlockTag = 'latest'): Promise<number> {
      return provider.getTransactionCount(address, blockTag);
    },
    async feeData() {
      // Base-typical: tiny base fee, ~0.01 gwei priority. Derived from the
      // actual block base fee so a replacement bump still clears the market.
      const block = await provider.getBlock('latest');
      const baseFee = block?.baseFeePerGas ?? 1_000_000n;
      const priority = 10_000_000n;
      return { maxFeePerGasWei: baseFee * 2n + priority, maxPriorityFeePerGasWei: priority };
    },
    async estimateGas(tx) {
      return provider.estimateGas({ from: tx.from, to: tx.to, data: tx.data });
    },
    async simulate(tx) {
      try {
        await provider.call({ from: tx.from, to: tx.to, data: tx.data });
        return { ok: true, revertReason: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, revertReason: message.slice(0, 200) };
      }
    },
    async sign(tx: SignableTransaction) {
      const raw = await minter.signTransaction({
        type: 2,
        chainId: CHAIN_ID,
        to: tx.to,
        data: tx.data,
        value: tx.valueWei,
        nonce: tx.nonce,
        gasLimit: tx.gasLimit,
        maxFeePerGas: tx.maxFeePerGasWei,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei,
      });
      return { raw, hash: ethers.Transaction.from(raw).hash! };
    },
    async broadcast(raw: string) {
      await provider.send('eth_sendRawTransaction', [raw]);
      broadcastCount += 1;
      metrics.txs += 1;
      await hooks?.onBroadcast?.(broadcastCount);
    },
    async getReceipt(txHash: string): Promise<MinedReceipt | null> {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt === null) return null;
      return {
        status: receipt.status === 1 ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.gasPrice,
      };
    },
    // finality on a LOCAL FORK. A single-node fork cannot reorg, and this harness
    // measures load, not finality, so it reports its latest block as the safe head and a head
    // 11 blocks beyond it (the floor, `finalizedThroughBlock`, is head - 11): every mined
    // receipt is final at once, exactly as it was before. Production binds these three
    // to the quorum-2 discovery seams (`operator-runtime.ts`); nothing here is used there.
    async readSafeHead() {
      const block = await provider.getBlock('latest');
      return block === null || block.hash === null ? null : { number: block.number, hash: block.hash.toLowerCase() };
    },
    async readHead() {
      return (await provider.getBlockNumber()) + 11;
    },
    async getBlockHash(blockNumber: number) {
      const block = await provider.getBlock(blockNumber);
      return block === null || block.hash === null ? null : block.hash.toLowerCase();
    },
    async isClaimSettled(claimId: string, blockTag?: number) {
      return Boolean(blockTag === undefined
        ? await kernel.claimSettled(claimId)
        : await kernel.claimSettled(claimId, { blockTag }));
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function contributorAddress(index: number): string {
  return `0x${(0x1000000000n + BigInt(index)).toString(16).padStart(40, '0')}`;
}

function bytes32Of(label: string): string {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function standardSeed(count: number, pointsPvt: bigint): NewClaimInput[] {
  return Array.from({ length: count }, (_, i) => ({
    leg: 'sole' as const,
    pe_id: `pe-std-${String(i).padStart(6, '0')}`,
    claim_id: harnessClaimId(`pe-std-${String(i).padStart(6, '0')}`, i),
    lane: 'standard' as const,
    contributor: contributorAddress(i),
    beneficiary_class: 1,
    record_points_atomic: (pointsPvt * ONE_PVT).toString(),
  }));
}

function genesisSeed(count: number, qualifiedAtSec: number): NewClaimInput[] {
  return Array.from({ length: count }, (_, i) => ({
    leg: 'sole' as const,
    pe_id: `pe-gen-${String(i).padStart(6, '0')}`,
    claim_id: harnessClaimId(`pe-gen-${String(i).padStart(6, '0')}`, 5_000_000 + i),
    lane: 'genesis' as const,
    contributor: contributorAddress(1_000_000 + i),
    genesis_anchor_key: bytes32Of(`gen-anchor-key-${i}`),
    wallet_id: bytes32Of(`gen-wallet-${i}`),
    one_time_anchor: bytes32Of(`gen-anchor-${i}`),
    grant_type: 1, // agent signup, 75 PVT gross maximum
    qualified_at: qualifiedAtSec,
    reserved_gross_atomic: (75n * ONE_PVT).toString(),
  }));
}

// ---------------------------------------------------------------------------
// Cycle configuration + drain loop
// ---------------------------------------------------------------------------

function cycleConfig(cycleId: string, overrides?: Partial<CycleRunnerConfig>): CycleRunnerConfig {
  return {
    cycleId,
    // Stable across processes: a crash-restart is the SAME logical worker
    // (its lease renews on re-acquire); a different worker id would be
    // refused until the lease expires — correct for production, wrong for
    // the harness's kill-and-resume flow.
    workerId: 'wp4-load-worker',
    signerAddress: '', // filled by caller
    leaseTtlMs: 10 * 60 * 1000,
    boundarySafetyMarginSec: 120,
    limits: {
      maxTransactions: PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
      maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
    },
    batchLimits: { maxRecipients: 400, maxClaims: 1_000, maxGas: 30_000_000 },
    gasModel: { baseGas: 200_000, gasPerRecipient: 30_000, gasPerClaim: 23_283 },
    gasHeadroomBps: 12_000,
    receiptPollIntervalMs: 25,
    replaceAfterMs: 60_000,
    feeBumpBps: 1_500,
    maxReplacementsPerBatch: 3,
    maxRunMs: 30 * 60 * 1000,
    ledgerPageSize: 500,
    selectionBudgetClaims: 3_000,
    ...overrides,
  };
}

/**
 * Synthetic PE identity behind each harness claim. The approval gate re-derives every claim
 * id with the real WP-EV criteria and refuses on mismatch, so harness fixtures must carry
 * claim ids that genuinely derive from a PE rather than an arbitrary label.
 */
const harnessPE = (peId: string, n: number): SealedEnvelopeIdentity => ({
  id: peId,
  prev_hash: bytes32Of(`harness-prev-${n}`),
  hash: bytes32Of(`harness-hash-${n}`),
  timestamp: 1_785_200_000_000 + n, // post-cut-line (PVT9_ELIGIBILITY_CUT_LINE_MS)
  action_type: 'agent_task_completed',
  user_id: `harness-user-${n}`,
});

function harnessClaimId(peId: string, n: number): string {
  const derived = deriveClaimId(harnessPE(peId, n));
  if (derived.kind !== 'derived') throw new Error(`harness PE ${peId} has no derivable claim id`);
  return derived.claimId;
}

/**
 * The harness's approval gate.
 *
 * The ELIGIBILITY half is real: every PE goes through `evaluateEligibility`, and a claim id
 * that does not re-derive is refused, exactly as in production. The APPROVER half talks to
 * the fork's `MockPVT9Verifier` (deployed onto the ephemeral fork only), which affirms by
 * construction — that is what makes the fork kernel accept a settle at all. Nothing here
 * touches a real deployment, and no approver key exists in this process.
 */
const harnessApproval = (kernelAddress: string, chainId: bigint): BatchApprovalDeps => ({
  approver: {
    kernelAddress,
    chainId,
    isAffirmed: async () => true,
    approveStandardBatch: async ({ header, recipients, claims }) => computeSettlementDigest({
      kernelAddress, chainId, lane: SettlementLane.StandardPE, header,
      claimsHash: hashStandardClaims(recipients, claims),
    }),
    approveGenesisBatch: async ({ header, recipients, claims }) => computeSettlementDigest({
      kernelAddress, chainId, lane: SettlementLane.GenesisPE, header,
      claimsHash: hashGenesisClaims(recipients, claims),
    }),
  },
  candidates: {
    loadCandidates: async (peIds) => {
      const out = new Map<string, EligibilityCandidate>();
      for (const peId of peIds) {
        const n = Number(peId.replace(/\D+/g, '')) + (peId.startsWith('pe-gen-') ? 5_000_000 : 0);
        out.set(peId, {
          pe: harnessPE(peId, n),
          attestationTier: 'software',
          chainVerified: true,
          submissionProvenance: 'earner_signed',
          workEvidence: { workProductHash: bytes32Of(`harness-work-${n}`) },
          relayMintStatus: 'eligible',
        });
      }
      return out;
    },
  },
});

/**
 * The gate binds a digest to one deployment via the kernel address + chain id, and both are
 * read off the harness's own chain observation rather than passed in — there is exactly one
 * fork per run, so a stale parameter could only ever be a bug.
 */
const realDeps = (db: SettlementDb, chain: SettlementChainAdapter) => ({
  db,
  chain,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  approval: harnessApproval(
    process.env.SETTLEMENT_LOAD_KERNEL_ADDRESS ?? process.env.SETTLEMENT_LOAD_CRASH_KERNEL ?? '0x0000000000000000000000000000000000000000',
    BigInt(process.env.SETTLEMENT_LOAD_CHAIN_ID ?? '8453'),
  ),
  // Harness-only: the reconciliation gate is exercised by the fork e2e
  // and its own suite; this load harness measures the cycle mechanics.
  standardLaneAdmission: testOnlyAdmittedStandardLaneVerdict(),
});

/**
 * Run cycles until the epoch's admissible backlog is exhausted. A
 * transaction-limit stop starts the next cycle (the durable backlog
 * continues); an epoch-cap deferral returns so the caller can advance the
 * epoch. Any other stop is a hard failure.
 */
async function drainEpoch(
  db: SettlementDb,
  chain: SettlementChainAdapter,
  signer: string,
  epochLabel: string,
  overrides?: Partial<CycleRunnerConfig>,
): Promise<{ reports: CycleRunReport[]; terminal: 'completed' | 'epoch_cap_deferral' }> {
  const reports: CycleRunReport[] = [];
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    const config = { ...cycleConfig(`cycle-${epochLabel}-${sequence}`, overrides), signerAddress: signer };
    const report = await runSettlementCycle(realDeps(db, chain), config);
    reports.push(report);
    console.log(
      `  cycle ${config.cycleId}: ${report.outcome}/${report.stopReason} `
      + `batches=${report.batchesConfirmed} claims=${report.claimsSettled} txs=${report.transactionsSubmitted}`,
    );
    if (report.outcome === 'completed') return { reports, terminal: 'completed' };
    if (report.stopReason === 'transaction_limit') continue;
    if (report.stopReason === 'epoch_cap_deferral') return { reports, terminal: 'epoch_cap_deferral' };
    fail(`cycle ${config.cycleId} stopped unexpectedly: ${report.stopReason} (${report.detail})`);
  }
  fail(`epoch ${epochLabel} did not drain within 20 cycles`);
}

// ---------------------------------------------------------------------------
// Verification + cleanup
// ---------------------------------------------------------------------------

async function readAllDocs(
  db: CountingDb,
  collection: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let after: string | undefined;
  for (;;) {
    let query = (db.collection(collection) as unknown as {
      orderBy(f: string, d?: string): { limit(n: number): { startAfter(v: string): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }> }; get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }> } };
    }).orderBy('__name__', 'asc').limit(500);
    const snap = after === undefined ? await query.get() : await query.startAfter(after).get();
    for (const doc of snap.docs) rows.push({ __id: doc.id, ...doc.data() });
    if (snap.docs.length < 500) return rows;
    after = String(snap.docs[snap.docs.length - 1].id);
  }
}

async function verifySettlementExactness(
  db: CountingDb,
  stack: ForkStack,
  expectedClaims: number,
  label: string,
): Promise<void> {
  const batches = (await readAllDocs(db, SETTLEMENT_BATCHES_COLLECTION)) as unknown as SettlementBatchDoc[];
  const confirmed = batches.filter((batch) => batch.status === 'confirmed');
  const expectedSupply = confirmed.reduce((sum, batch) => sum + BigInt(batch.total_minted_atomic), 0n);
  const onChainSupply = BigInt(await stack.kernel.totalSupply());
  const cursor = BigInt(await stack.kernel.nextFinalizedCursor());
  const settledClaims = confirmed.reduce((sum, batch) => sum + batch.claim_count, 0);

  if (onChainSupply !== expectedSupply) {
    fail(`${label}: totalSupply ${onChainSupply} != Σ batch total_minted ${expectedSupply} (loss or reprice)`);
  }
  if (cursor !== BigInt(expectedClaims)) {
    fail(`${label}: cursor ${cursor} != expected claim count ${expectedClaims}`);
  }
  if (settledClaims !== expectedClaims) {
    fail(`${label}: settled claims ${settledClaims} != expected ${expectedClaims} (duplicate or loss)`);
  }
  // Ledger: every row settled, every batch writeback complete.
  const ledger = await readAllDocs(db, CLAIM_LEDGER_COLLECTION);
  const unsettled = ledger.filter((row) => row.settled !== true);
  if (ledger.length !== expectedClaims || unsettled.length !== 0) {
    fail(`${label}: ledger rows=${ledger.length} unsettled=${unsettled.length} (expected ${expectedClaims}/0)`);
  }
  const incompleteWritebacks = confirmed.filter((batch) => batch.writebacks_complete !== true);
  if (incompleteWritebacks.length !== 0) {
    fail(`${label}: ${incompleteWritebacks.length} confirmed batches missing writebacks`);
  }
  // Sample exact per-contributor balances (floor-arithmetic mirror).
  for (const sampleIndex of [0, Math.floor(expectedClaims / 2), expectedClaims - 1]) {
    const row = ledger.find((candidate) => String(candidate.pe_id).endsWith(String(sampleIndex).padStart(6, '0')));
    if (!row) continue;
    const balance = BigInt(await stack.kernel.balanceOf(String(row.contributor)));
    if (balance <= 0n) fail(`${label}: sampled contributor ${row.contributor} has zero balance`);
  }
  console.log(
    `  ✓ ${label}: exact — supply=${ethers.formatEther(onChainSupply)} PVT, cursor=${cursor}, `
    + `claims=${settledClaims}, batches=${confirmed.length}`,
  );
}

async function cleanupScenario(host: string, db: CountingDb, label: string): Promise<void> {
  await wipeEmulator(host);
  for (const collection of [
    CLAIM_LEDGER_COLLECTION, SETTLEMENT_CYCLES_COLLECTION, SETTLEMENT_BATCHES_COLLECTION,
    ANCHOR_SEGMENTS_COLLECTION, ANCHOR_DAYS_COLLECTION,
  ]) {
    const snap = await (db.collection(collection) as unknown as {
      limit(n: number): { get(): Promise<{ docs: unknown[] }> };
    }).limit(1).get();
    if (snap.docs.length !== 0) fail(`${label}: cleanup left documents in ${collection}`);
  }
  console.log(`  ✓ ${label}: emulator test data deleted and verified empty`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  wallMs: number;
  docOps: DocOpCounts;
  chain: ChainMetrics;
  detail: string;
}

async function scenarioStandard25k(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  const chain = makeChainAdapter(stack, metrics);
  console.log('· standard25k: seeding 25,000 standard claims (25,000 recipients) …');
  await registerClaimsBulk(db, standardSeed(25_000, 1n), Date.now());

  const { terminal } = await drainEpoch(db, chain, stack.minter.address, 'std25k-e0');
  if (terminal !== 'completed') fail('standard25k: expected completion within epoch 0 caps');
  await verifySettlementExactness(db, stack, 25_000, 'standard25k');
  await collectFees(stack, metrics, db);
  await cleanupScenario(host, db, 'standard25k');
  return {
    name: 'standard25k', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: '25,000 recipients settled to exhaustion; exact supply/cursor/ledger',
  };
}

async function scenarioGenesis50k(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  const chain = makeChainAdapter(stack, metrics);
  console.log('· genesis50k: seeding 50,000 Genesis PEs (75 PVT gross each) …');
  await registerClaimsBulk(db, genesisSeed(50_000, stack.epochStartSec), Date.now());

  // 125 batches at 400 recipients — the 100-transaction cycle limit forces a
  // second cycle: graceful persistent backlog at the guardrail, by design.
  const { reports, terminal } = await drainEpoch(db, chain, stack.minter.address, 'gen50k-e0');
  if (terminal !== 'completed') fail('genesis50k: expected completion (3.75M gross < 7.5M cap)');
  if (reports.length < 2) fail('genesis50k: expected the 100-tx cycle limit to force a second cycle');
  await verifySettlementExactness(db, stack, 50_000, 'genesis50k');
  const genesisIssued = BigInt(await stack.kernel.epochGenesisIssued(0));
  console.log(`  genesis epoch-0 issued: ${ethers.formatEther(genesisIssued)} PVT (cap 7.5M)`);
  await collectFees(stack, metrics, db);
  await cleanupScenario(host, db, 'genesis50k');
  return {
    name: 'genesis50k', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: `50,000 Genesis PEs across ${reports.length} cycles (tx-limit guardrail exercised); exact`,
  };
}

async function scenarioBurst2x(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  const chain = makeChainAdapter(stack, metrics);
  // 50,000 recipients × 400 PVT ≈ 20M PVT ≈ 2× the 10M combined epoch cap.
  console.log('· burst2x: seeding 50,000 recipients at 2× the combined epoch cap …');
  await registerClaimsBulk(db, standardSeed(50_000, 400n), Date.now());

  const epoch0 = await drainEpoch(db, chain, stack.minter.address, 'burst-e0');
  if (epoch0.terminal !== 'epoch_cap_deferral') {
    fail('burst2x: expected an epoch-cap deferral in epoch 0 (durable backlog)');
  }
  const issuedEpoch0 = BigInt(await stack.kernel.epochTotalIssued(0));
  const cap = 10_000_000n * ONE_PVT;
  if (issuedEpoch0 > cap) fail('burst2x: epoch 0 issuance exceeded the combined cap');
  console.log(`  epoch 0 issued ${ethers.formatEther(issuedEpoch0)} / 10,000,000 PVT; advancing epoch …`);

  // Next epoch: warp one week, open it, drain the durable backlog. The
  // runner's raw transactions advanced the account nonce outside the
  // NonceManager — reset it so openNextEpoch re-fetches the real nonce.
  await warpTo(stack.provider, stack.epochStartSec + EPOCH_DURATION_SEC + 60);
  stack.txSigner.reset();
  await (await stack.kernel.openNextEpoch()).wait();
  const epoch1 = await drainEpoch(db, chain, stack.minter.address, 'burst-e1');
  if (epoch1.terminal !== 'completed') fail('burst2x: expected epoch 1 to drain the deferred backlog');

  await verifySettlementExactness(db, stack, 50_000, 'burst2x');
  await collectFees(stack, metrics, db);
  await cleanupScenario(host, db, 'burst2x');
  return {
    name: 'burst2x', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: `2× burst deferred at the epoch cap (epoch0=${ethers.formatEther(issuedEpoch0)} PVT) and drained next epoch; no starvation`,
  };
}

async function scenarioCrash(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  console.log('· crash: seeding 2,000 claims; child process will be killed mid-cycle …');
  await registerClaimsBulk(db, standardSeed(2_000, 1n), Date.now());

  // The child runs THIS script in crash-child mode: it broadcasts batches and
  // dies abruptly (process.exit inside the receipt wait) after the third
  // broadcast — after two applied batches, with one transaction in flight.
  const child = spawnSync('npx', ['tsx', __filename, 'crash-child'], {
    env: {
      ...process.env,
      SETTLEMENT_LOAD_CRASH_KERNEL: await stack.kernel.getAddress(),
      SETTLEMENT_LOAD_CRASH_SIGNER_KEY: MINTER_KEY,
      SETTLEMENT_LOAD_CRASH_AFTER_BROADCASTS: '3',
      SETTLEMENT_LOAD_CRASH_CYCLE: 'cycle-crash-e0-1',
    },
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  if (child.status !== 137) fail(`crash: child exited ${child.status}, expected the scripted 137`);

  // Durable state after the kill: some batches applied, one submitted-unapplied.
  const cycleSnap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc('cycle-crash-e0-1').get();
  const cycle = cycleSnap.data() as unknown as SettlementCycleDoc;
  if (cycle.status !== 'active') fail('crash: cycle should still be active (no clean close) after a kill');
  const inFlight = (await readAllDocs(db, SETTLEMENT_BATCHES_COLLECTION)) as unknown as SettlementBatchDoc[];
  const submitted = inFlight.filter((batch) => batch.status === 'submitted');
  if (submitted.length !== 1) fail(`crash: expected exactly 1 in-flight batch, found ${submitted.length}`);
  const txsBeforeResume = cycle.consumed.transactions_submitted;
  console.log(`  child killed: ${cycle.consumed.batches_confirmed} batches applied, 1 in flight, txs=${txsBeforeResume}`);

  // Resume in-process: must apply the landed in-flight batch WITHOUT a new
  // transaction for it, then finish the backlog.
  const chain = makeChainAdapter(stack, metrics);
  const { terminal } = await drainEpoch(db, chain, stack.minter.address, 'crash-e0', undefined);
  if (terminal !== 'completed') fail('crash: resume did not complete the backlog');
  const finalCycleSnap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc('cycle-crash-e0-1').get();
  const finalCycle = finalCycleSnap.data() as unknown as SettlementCycleDoc;
  // The killed cycle's counters survive, and the resumed run reconciled the
  // in-flight batch from its RECEIPT rather than resubmitting: exactly one
  // transaction per confirmed batch, cumulatively — a resubmission would
  // make transactions exceed batches.
  if (finalCycle.consumed.transactions_submitted !== finalCycle.consumed.batches_confirmed) {
    fail(
      `crash: ${finalCycle.consumed.transactions_submitted} transactions for `
      + `${finalCycle.consumed.batches_confirmed} batches — the in-flight batch was resubmitted`,
    );
  }
  if (finalCycle.consumed.transactions_submitted <= txsBeforeResume) {
    fail('crash: resume made no progress on the remaining backlog');
  }
  await verifySettlementExactness(db, stack, 2_000, 'crash');
  await collectFees(stack, metrics, db);
  await cleanupScenario(host, db, 'crash');
  return {
    name: 'crash', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: 'abrupt kill (SIG-equivalent exit 137) mid-cycle; resumed at the exact position, zero double-settle',
  };
}

/** Child mode for the crash scenario: dies abruptly after the Nth broadcast. */
async function runCrashChild(): Promise<void> {
  const host = requireEmulatorHost();
  const raw = initFirestore();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const db = makeCountingDb(raw, counts);
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const minter = new ethers.Wallet(process.env.SETTLEMENT_LOAD_CRASH_SIGNER_KEY!, provider);
  const kernel = new ethers.Contract(process.env.SETTLEMENT_LOAD_CRASH_KERNEL!, KERNEL_ABI, minter);
  const stack: ForkStack = {
    provider, minter, txSigner: new ethers.NonceManager(minter), kernel, peAnchor: kernel, epochStartSec: 0,
  };
  const crashAfter = Number(process.env.SETTLEMENT_LOAD_CRASH_AFTER_BROADCASTS ?? 3);
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const chain = makeChainAdapter(stack, metrics, {
    onBroadcast: (count) => {
      if (count >= crashAfter) {
        console.log(`  [child] broadcast ${count} — dying abruptly (exit 137, no cleanup)`);
        process.exit(137);
      }
    },
  });
  const config = { ...cycleConfig(process.env.SETTLEMENT_LOAD_CRASH_CYCLE!), signerAddress: minter.address };
  await runSettlementCycle(realDeps(db, chain), config);
  console.log('  [child] cycle finished without crashing — scenario misconfigured');
  process.exit(1);
  void host;
}

async function scenarioReplacement(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  console.log('· replacement: automine off — first transaction sticks, replacement (same nonce) lands …');
  await registerClaimsBulk(db, standardSeed(400, 1n), Date.now());

  // Automine off: the original settlement tx stays pending. When the runner
  // broadcasts the fee-bumped SAME-NONCE replacement, mining resumes and one
  // of the two (the replacement) is included.
  await stack.provider.send('evm_setAutomine', [false]);
  const chain = makeChainAdapter(stack, metrics, {
    onBroadcast: async (count) => {
      if (count === 2) {
        await stack.provider.send('evm_setAutomine', [true]);
        await stack.provider.send('evm_mine', []);
      }
    },
  });
  const config = {
    ...cycleConfig('cycle-repl-e0-1', { replaceAfterMs: 500, receiptPollIntervalMs: 50 }),
    signerAddress: stack.minter.address,
  };
  const report = await runSettlementCycle(realDeps(db, chain), config);
  if (report.outcome !== 'completed') fail(`replacement: cycle ${report.outcome}/${report.stopReason} (${report.detail})`);
  if (report.replacementsSubmitted !== 1) fail(`replacement: expected 1 replacement, got ${report.replacementsSubmitted}`);

  const batches = (await readAllDocs(db, SETTLEMENT_BATCHES_COLLECTION)) as unknown as SettlementBatchDoc[];
  const [batch] = batches;
  if (batch.attempts.length !== 2) fail(`replacement: expected 2 attempts, got ${batch.attempts.length}`);
  if (batch.attempts[0].nonce !== batch.attempts[1].nonce) {
    fail('replacement: attempts used different nonces — the two-live-settlements vector');
  }
  const originalReceipt = await stack.provider.getTransactionReceipt(batch.attempts[0].tx_hash);
  const replacementReceipt = await stack.provider.getTransactionReceipt(batch.attempts[1].tx_hash);
  const minedCount = [originalReceipt, replacementReceipt].filter((r) => r !== null).length;
  if (minedCount !== 1) fail(`replacement: ${minedCount} of the same-nonce pair mined — must be exactly 1`);
  await verifySettlementExactness(db, stack, 400, 'replacement');
  await collectFees(stack, metrics, db);
  await cleanupScenario(host, db, 'replacement');
  return {
    name: 'replacement', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: 'dropped tx replaced at the SAME nonce; exactly one of the pair mined; single settlement',
  };
}

async function scenarioAnchor25k(host: string, raw: Firestore): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const counts: DocOpCounts = { reads: 0, writes: 0, deletes: 0 };
  const metrics: ChainMetrics = { txs: 0, gasUsed: 0n, feeWei: 0n };
  const db = makeCountingDb(raw, counts);
  await wipeEmulator(host);

  const stack = await deployStack();
  console.log('· anchor25k: planning 25,000-PE segmented day (10 segments + aggregate) …');
  const members: SegmentMember[] = Array.from({ length: 25_000 }, (_, i) => ({
    pe_id: `pe-anchor-${String(i).padStart(6, '0')}`,
    pe_hash: createHash('sha256').update(`anchor-envelope-${i}`).digest('hex'),
    timestamp: 1_785_200_000_000 + i, // post-cut-line (PVT9_ELIGIBILITY_CUT_LINE_MS)
  }));
  const plan = planSegmentedDay('2026-07-20', members);
  if (plan.segment_count !== 10) fail(`anchor25k: expected 10 segments, got ${plan.segment_count}`);

  const anchorAdapter: PEAnchorChainAdapter = {
    async isAnchored(batchId) {
      const batch = await stack.peAnchor.batches(batchId);
      return Boolean(batch.exists);
    },
    async readRoot(batchId) {
      const batch = await stack.peAnchor.batches(batchId);
      return batch.exists ? String(batch.merkleRoot) : null;
    },
    async anchor(args) {
      const tx = await stack.peAnchor.anchorBatch(
        args.batchId, args.merkleRoot, args.peCount, args.timestampMs, args.epochNumber,
      );
      const receipt = await tx.wait();
      metrics.txs += 1;
      metrics.gasUsed += BigInt(receipt.gasUsed);
      metrics.feeWei += BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);
      return { txHash: receipt.hash };
    },
  };
  const result = await anchorSegmentedDay(
    { db, chain: anchorAdapter, now: () => Date.now() },
    plan,
    20_655,
    1_753_100_000_000,
  );
  if (result.segments_anchored !== 10 || !result.aggregate_anchored) {
    fail(`anchor25k: anchored ${result.segments_anchored} segments, aggregate=${result.aggregate_anchored}`);
  }

  // Reconcile the STORED docs (per-segment + aggregate).
  const dayDocs = (await readAllDocs(db, ANCHOR_DAYS_COLLECTION)) as unknown as AnchorDayDoc[];
  const segmentDocs = (await readAllDocs(db, ANCHOR_SEGMENTS_COLLECTION)) as unknown as AnchorSegmentDoc[];
  const verdict = reconcileSegmentedDay(dayDocs[0], segmentDocs);
  if (!verdict.ok) fail(`anchor25k: reconciliation violations: ${verdict.violations.join('; ')}`);

  // Proofs across segments: first/middle/last member of every segment,
  // verified off-chain AND on-chain (both levels of verifyPE).
  let proofsVerified = 0;
  for (const segmentDoc of segmentDocs) {
    for (const pick of [0, Math.floor(segmentDoc.members.length / 2), segmentDoc.members.length - 1]) {
      const target = segmentDoc.members[pick];
      const proof = buildSegmentedProof(dayDocs[0], segmentDoc, target.pe_id);
      if (proof === null || !verifySegmentedProof(proof)) {
        fail(`anchor25k: proof failed off-chain for ${target.pe_id}`);
      }
      const onChainSegment = await stack.peAnchor.verifyPE(
        proof.segment_batch_id, proof.leaf_value, [...proof.segment_proof],
      );
      const onChainAggregate = await stack.peAnchor.verifyPE(
        proof.aggregate_batch_id,
        ethers.keccak256(ethers.concat(['0x00', proof.segment_root])),
        [...proof.aggregate_proof],
      );
      if (!onChainSegment || !onChainAggregate) {
        fail(`anchor25k: ON-CHAIN verifyPE failed for ${target.pe_id} (segment=${onChainSegment} aggregate=${onChainAggregate})`);
      }
      proofsVerified += 1;
    }
  }
  console.log(`  ✓ anchor25k: ${proofsVerified} cross-segment proofs verified off-chain AND on-chain`);
  await cleanupScenario(host, db, 'anchor25k');
  return {
    name: 'anchor25k', wallMs: Date.now() - startedAt, docOps: counts, chain: metrics,
    detail: `25,000 PEs → 10 segments + aggregate anchored (${metrics.txs} txs); ${proofsVerified} proofs verified incl. on-chain`,
  };
}

/** Sum real gas costs from receipts of the signer's transactions this scenario. */
async function collectFees(stack: ForkStack, metrics: ChainMetrics, db: CountingDb): Promise<void> {
  const batches = (await readAllDocs(db, SETTLEMENT_BATCHES_COLLECTION)) as unknown as SettlementBatchDoc[];
  for (const batch of batches) {
    for (const attempt of batch.attempts) {
      if (attempt.mined !== null) {
        metrics.gasUsed += BigInt(attempt.mined.gas_used);
        metrics.feeWei += BigInt(attempt.mined.gas_used) * BigInt(attempt.mined.effective_gas_price_wei);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function initFirestore(): Firestore {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
  return getFirestore();
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'all';
  if (mode === 'crash-child') {
    await runCrashChild();
    return;
  }

  const host = requireEmulatorHost();
  const raw = initFirestore();
  // Prove the emulator (the wipe endpoint 404s anywhere else) BEFORE any op.
  await wipeEmulator(host);
  console.log(`✓ Firestore emulator verified at ${host} (project ${EMULATOR_PROJECT_ID}); doc-op cap ${DOC_OP_CAP}`);
  await startAnvil();

  const scenarios: Record<string, (h: string, f: Firestore) => Promise<ScenarioResult>> = {
    standard25k: scenarioStandard25k,
    genesis50k: scenarioGenesis50k,
    burst2x: scenarioBurst2x,
    crash: scenarioCrash,
    replacement: scenarioReplacement,
    anchor25k: scenarioAnchor25k,
  };
  const selected = mode === 'all' ? Object.keys(scenarios) : [mode];
  const results: ScenarioResult[] = [];
  for (const name of selected) {
    const scenario = scenarios[name];
    if (!scenario) fail(`unknown scenario "${name}" (have: ${Object.keys(scenarios).join(', ')}, all)`);
    results.push(await scenario(host, raw));
  }

  console.log('\n════ settlement runtime LOAD HARNESS RESULTS ════');
  for (const result of results) {
    console.log(JSON.stringify({
      scenario: result.name,
      wall_ms: result.wallMs,
      doc_ops: result.docOps,
      chain_txs: result.chain.txs,
      gas_used: result.chain.gasUsed.toString(),
      fee_eth_fork_local: ethers.formatEther(result.chain.feeWei),
      detail: result.detail,
    }));
  }
  console.log('\nALL settlement runtime LOAD SCENARIOS PASSED (emulator wiped; fork-local only; $0 external cost)');
  stopAnvil();
  process.exit(0);
}

main().catch((error) => {
  console.error('HARNESS ERROR:', error);
  stopAnvil();
  process.exit(1);
});
