/**
 * Unanchored Batch Backfill Check
 *
 * Read-only script. Queries every BatchMinted event ever emitted by the
 * production PVTv4 contract on Base / Arbitrum / Optimism, then for each
 * batchId checks PEAnchor.batches(batchId).exists. For unanchored batchIds
 * it then probes Firestore (collection: pvt_mint_batch_snapshots) to
 * determine whether anchor recovery would even be possible.
 *
 * Outputs a per-chain report:
 *   - total minted batches
 *   - total anchored
 *   - list of unanchored batchIds with mint block, mint tx hash, snapshot
 *     status (present / missing)
 *
 * NEVER writes anything. NEVER calls anchorBatch. NEVER mutates Firestore.
 *
 * Usage:
 *   BASE_RPC_URL=... ARBITRUM_RPC_URL=... OPTIMISM_RPC_URL=... \
 *     [GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json] \
 *     [FROM_BLOCK_BASE=...] [FROM_BLOCK_ARBITRUM=...] [FROM_BLOCK_OPTIMISM=...] \
 *     npm run check-unanchored
 *
 * If Firestore creds are not present, snapshot status is reported as
 * "skipped" rather than blocking the chain-side report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

// =============================================================================
// MANIFEST + ABIS
// =============================================================================

const DEPLOYMENTS_DIR = path.resolve(__dirname, '../../contracts/deployments');

// Minimal ABIs - events only for PVT, single read for PEAnchor.
const PVT_V4_EVENT_ABI = [
  'event BatchMinted(bytes32 indexed batchId, uint256 indexed epoch, uint256 totalMinted, uint256 contributorTotal, uint256 provianShare, uint256 foundationShare, bytes32 merkleRoot, uint256 effectiveMintRate, uint256 supplyScaler, uint256 humanSharePortion, uint256 agentSharePortion)',
] as const;

const PE_ANCHOR_READ_ABI = [
  'function batches(bytes32) view returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
] as const;

const SNAPSHOTS_COLLECTION = 'pvt_mint_batch_snapshots';

interface PvtV4Manifest {
  network: string;
  chainId: number;
  contracts: { pvtV4: string };
}

interface PvtV3Manifest {
  network: string;
  chainId: number;
  contracts: { peAnchor?: string };
}

interface SprintFixesManifest {
  contracts: { peAnchor: string };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, file), 'utf8')) as T;
}

// =============================================================================
// CHAIN CONFIG
// =============================================================================

interface ChainConfig {
  network: 'base' | 'arbitrum' | 'optimism';
  chainId: number;
  rpcUrl: string;
  pvtV4: string;
  peAnchor: string;
  /** First block to scan from. */
  fromBlock?: number;
  /** Max blocks per eth_getLogs call (public RPCs cap this). */
  blockChunk: number;
}

function loadChains(env: NodeJS.ProcessEnv): ChainConfig[] {
  const baseV4 = readJson<PvtV4Manifest>('base-pvt-v4.json');
  const arbV4 = readJson<PvtV4Manifest>('arbitrum-pvt-v4.json');
  const opV4 = readJson<PvtV4Manifest>('optimism-pvt-v4.json');
  const sprint = readJson<SprintFixesManifest>('base-sprint-fixes.json');
  const arbV3 = readJson<PvtV3Manifest>('arbitrum-pvt-v3.json');
  const opV3 = readJson<PvtV3Manifest>('optimism-pvt-v3.json');

  if (!arbV3.contracts.peAnchor || !opV3.contracts.peAnchor) {
    throw new Error('Arb/Op pvt-v3 manifest is missing peAnchor');
  }

  return [
    {
      network: 'base',
      chainId: baseV4.chainId,
      rpcUrl: env.BASE_RPC_URL ?? '',
      pvtV4: baseV4.contracts.pvtV4,
      peAnchor: sprint.contracts.peAnchor,
      fromBlock: parseIntOpt(env.FROM_BLOCK_BASE),
      // mainnet.base.org caps eth_getLogs at 10K blocks; stay well under.
      blockChunk: 5_000,
    },
    {
      network: 'arbitrum',
      chainId: arbV4.chainId,
      rpcUrl: env.ARBITRUM_RPC_URL ?? '',
      pvtV4: arbV4.contracts.pvtV4,
      peAnchor: arbV3.contracts.peAnchor!,
      fromBlock: parseIntOpt(env.FROM_BLOCK_ARBITRUM),
      // Arbitrum has 250ms blocks → much higher block count per day; use a
      // larger chunk where the public RPC permits.
      blockChunk: 100_000,
    },
    {
      network: 'optimism',
      chainId: opV4.chainId,
      rpcUrl: env.OPTIMISM_RPC_URL ?? '',
      pvtV4: opV4.contracts.pvtV4,
      peAnchor: opV3.contracts.peAnchor!,
      fromBlock: parseIntOpt(env.FROM_BLOCK_OPTIMISM),
      blockChunk: 5_000,
    },
  ];
}

function parseIntOpt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// =============================================================================
// CREATION-BLOCK HEURISTIC
// =============================================================================

/**
 * Find the deployment block for `address` by binary search over
 * eth_getCode. Returns 0 if the address has no code anywhere in the
 * accessible range (caller will treat as "scan from genesis" - but the
 * caller should never reach this path for a deployed PVT contract).
 */
async function findCreationBlock(
  provider: ethers.JsonRpcProvider,
  address: string,
  latest: number,
): Promise<number> {
  // Sanity - does the contract exist now?
  const codeNow = await provider.getCode(address, latest);
  if (codeNow === '0x' || codeNow === '0x0') return 0;

  let lo = 1;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code: string;
    try {
      code = await provider.getCode(address, mid);
    } catch {
      // Some RPCs reject historical lookups beyond an archive depth; in that
      // case we accept `mid` as the lower bound and continue narrowing above.
      lo = mid + 1;
      continue;
    }
    if (code === '0x' || code === '0x0') {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// =============================================================================
// EVENT SCAN
// =============================================================================

interface BatchMintRecord {
  batchId: string;
  blockNumber: number;
  txHash: string;
  merkleRoot: string;
}

async function scanBatchMintedEvents(
  provider: ethers.JsonRpcProvider,
  pvtAddress: string,
  fromBlock: number,
  toBlock: number,
  blockChunk: number,
  log: (s: string) => void,
): Promise<BatchMintRecord[]> {
  const contract = new ethers.Contract(pvtAddress, PVT_V4_EVENT_ABI, provider);
  const filter = contract.filters.BatchMinted();
  const records: BatchMintRecord[] = [];

  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + blockChunk - 1, toBlock);
    const events = await retry(() => contract.queryFilter(filter, cursor, end), 5);
    for (const evt of events) {
      const e = evt as ethers.EventLog;
      if (!e.args) continue;
      records.push({
        batchId: e.args.batchId as string,
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
        merkleRoot: e.args.merkleRoot as string,
      });
    }
    if (events.length > 0) {
      log(`  scanned [${cursor}..${end}] events=${events.length} cumulative=${records.length}`);
    }
    cursor = end + 1;
  }
  return records;
}

async function retry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }
  throw lastErr;
}

// =============================================================================
// ANCHOR CHECK
// =============================================================================

async function isAnchored(
  peAnchor: ethers.Contract,
  batchId: string,
): Promise<boolean | 'error'> {
  try {
    const r = await retry(() => peAnchor.batches(batchId), 5);
    if (typeof r === 'object' && r !== null) {
      if ('exists' in r) return Boolean((r as { exists: unknown }).exists);
      if (Array.isArray(r) && r.length >= 5) return Boolean(r[4]);
    }
    return false;
  } catch {
    return 'error';
  }
}

// =============================================================================
// FIRESTORE SNAPSHOT PROBE
// =============================================================================

interface SnapshotProbe {
  status: 'present' | 'missing' | 'skipped' | 'error';
  detail?: string;
}

interface FirestoreLike {
  collection(name: string): {
    doc(id: string): { get(): Promise<{ exists: boolean }> };
  };
}

async function buildFirestoreOrSkip(
  log: (s: string) => void,
): Promise<FirestoreLike | null> {
  const hasCreds =
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    !!process.env.FIRESTORE_PROJECT_ID;
  if (!hasCreds) {
    log(
      '[firestore] GOOGLE_APPLICATION_CREDENTIALS not set - skipping snapshot probes (chain-side only)',
    );
    return null;
  }
  try {
    const admin = await import('firebase-admin');
    const { scriptDb } = await import('./lib/script-db');
    if (admin.apps.length === 0) admin.initializeApp();
    return scriptDb() as unknown as FirestoreLike;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[firestore] init failed (${msg}) - skipping snapshot probes`);
    return null;
  }
}

async function probeSnapshot(
  db: FirestoreLike | null,
  batchId: string,
): Promise<SnapshotProbe> {
  if (!db) return { status: 'skipped' };
  try {
    const snap = await db.collection(SNAPSHOTS_COLLECTION).doc(batchId).get();
    return { status: snap.exists ? 'present' : 'missing' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', detail: msg };
  }
}

// =============================================================================
// PER-CHAIN RUN
// =============================================================================

interface ChainReport {
  network: string;
  chainId: number;
  rpcOk: boolean;
  scannedFrom: number;
  scannedTo: number;
  totalMinted: number;
  totalAnchored: number;
  unanchored: Array<{
    batchId: string;
    blockNumber: number;
    txHash: string;
    snapshot: SnapshotProbe;
  }>;
  errors: string[];
}

async function runChain(
  cfg: ChainConfig,
  db: FirestoreLike | null,
  log: (s: string) => void,
): Promise<ChainReport> {
  const report: ChainReport = {
    network: cfg.network,
    chainId: cfg.chainId,
    rpcOk: false,
    scannedFrom: 0,
    scannedTo: 0,
    totalMinted: 0,
    totalAnchored: 0,
    unanchored: [],
    errors: [],
  };

  if (!cfg.rpcUrl) {
    report.errors.push('RPC URL not set');
    log(`[${cfg.network}] SKIPPED - no RPC URL`);
    return report;
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  let latest: number;
  try {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== cfg.chainId) {
      report.errors.push(`chain id mismatch: rpc=${net.chainId} expected=${cfg.chainId}`);
      return report;
    }
    latest = await provider.getBlockNumber();
    report.rpcOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`rpc init: ${msg}`);
    return report;
  }

  let fromBlock = cfg.fromBlock;
  if (fromBlock === undefined) {
    log(`[${cfg.network}] resolving PVTv4 creation block via binary search...`);
    try {
      fromBlock = await findCreationBlock(provider, cfg.pvtV4, latest);
      log(`[${cfg.network}] PVTv4 created at block ${fromBlock}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`creation-block search failed: ${msg}`);
      // Fall back to a 7-day lookback heuristic.
      const blocksPerDay = cfg.network === 'arbitrum' ? 350_000 : 43_200;
      fromBlock = Math.max(0, latest - blocksPerDay * 7);
      log(`[${cfg.network}] falling back to fromBlock=${fromBlock} (7 days)`);
    }
  }

  report.scannedFrom = fromBlock;
  report.scannedTo = latest;
  log(`[${cfg.network}] scanning BatchMinted from ${fromBlock} to ${latest}`);

  let events: BatchMintRecord[];
  try {
    events = await scanBatchMintedEvents(
      provider,
      cfg.pvtV4,
      fromBlock,
      latest,
      cfg.blockChunk,
      log,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`event scan failed: ${msg}`);
    return report;
  }

  report.totalMinted = events.length;

  const peAnchor = new ethers.Contract(cfg.peAnchor, PE_ANCHOR_READ_ABI, provider);

  for (const evt of events) {
    const anchored = await isAnchored(peAnchor, evt.batchId);
    if (anchored === 'error') {
      report.errors.push(`anchor probe error for ${evt.batchId}`);
      continue;
    }
    if (anchored) {
      report.totalAnchored++;
      continue;
    }
    const snapshot = await probeSnapshot(db, evt.batchId);
    report.unanchored.push({
      batchId: evt.batchId,
      blockNumber: evt.blockNumber,
      txHash: evt.txHash,
      snapshot,
    });
  }

  return report;
}

// =============================================================================
// REPORT
// =============================================================================

function printReport(reports: ChainReport[], log: (s: string) => void): void {
  log('\n========== UNANCHORED BATCH REPORT ==========');
  for (const r of reports) {
    log(`\n--- ${r.network} (chainId=${r.chainId}) ---`);
    if (!r.rpcOk) {
      log(`  status:    ERROR (${r.errors.join('; ')})`);
      continue;
    }
    log(`  scanned:    blocks ${r.scannedFrom}..${r.scannedTo}`);
    log(`  minted:     ${r.totalMinted}`);
    log(`  anchored:   ${r.totalAnchored}`);
    log(`  unanchored: ${r.unanchored.length}`);
    if (r.errors.length > 0) {
      log(`  errors:     ${r.errors.length}`);
      for (const e of r.errors.slice(0, 5)) log(`    - ${e}`);
    }
    if (r.unanchored.length > 0) {
      const presentCount = r.unanchored.filter((u) => u.snapshot.status === 'present').length;
      const missingCount = r.unanchored.filter((u) => u.snapshot.status === 'missing').length;
      const skippedCount = r.unanchored.filter((u) => u.snapshot.status === 'skipped').length;
      const errorCount = r.unanchored.filter((u) => u.snapshot.status === 'error').length;
      log(`    snapshot present: ${presentCount}`);
      log(`    snapshot missing: ${missingCount}    ← BLOCKS anchor recovery`);
      log(`    snapshot skipped: ${skippedCount}    (Firestore not configured)`);
      if (errorCount > 0) log(`    snapshot error:   ${errorCount}`);
      log('  unanchored batches:');
      for (const u of r.unanchored) {
        log(
          `    - ${u.batchId}  block=${u.blockNumber}  tx=${u.txHash}  snapshot=${u.snapshot.status}${u.snapshot.detail ? ` (${u.snapshot.detail})` : ''}`,
        );
      }
    }
  }

  log('\n========== TOTALS ==========');
  const total = reports.reduce((acc, r) => acc + r.totalMinted, 0);
  const anchored = reports.reduce((acc, r) => acc + r.totalAnchored, 0);
  const unanchored = reports.reduce((acc, r) => acc + r.unanchored.length, 0);
  const missingSnapshots = reports.reduce(
    (acc, r) => acc + r.unanchored.filter((u) => u.snapshot.status === 'missing').length,
    0,
  );
  log(`total minted across all chains:     ${total}`);
  log(`total anchored:                     ${anchored}`);
  log(`total unanchored:                   ${unanchored}`);
  log(`unanchored AND missing snapshot:    ${missingSnapshots}    (cannot be auto-recovered)`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  const log = (s: string) => console.log(s);
  const chains = loadChains(process.env);
  const db = await buildFirestoreOrSkip(log);

  const reports: ChainReport[] = [];
  for (const cfg of chains) {
    log(`\n===== ${cfg.network} =====`);
    const r = await runChain(cfg, db, log);
    reports.push(r);
  }

  printReport(reports, log);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[check-unanchored-batches] fatal:', err);
    process.exit(1);
  });
}
