/**
 * Live On-Chain Role Verification
 *
 * Read-only script that connects to Base, Arbitrum, and Optimism via the
 * BASE_RPC_URL, ARBITRUM_RPC_URL, OPTIMISM_RPC_URL env vars and verifies
 * that the role addresses on each deployed contract match the expected
 * values from contracts/deployments/*.json.
 *
 * Expected admin on every contract: the Foundation Safe
 *   0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936
 *
 * Verifies:
 *   - PVTv4: admin(), minter(), governanceContract(), courtContract(),
 *            registry(), activationState()
 *   - PEAnchor (Base only, address from base-sprint-fixes.json):
 *            admin(), minter()
 *   - EscrowV4, PromiseV3, PoolV3: admin()
 *
 * Exits non-zero if ANY mismatch is found.
 *
 * Usage:
 *   BASE_RPC_URL=... ARBITRUM_RPC_URL=... OPTIMISM_RPC_URL=... \
 *     npm run verify-roles
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

// =============================================================================
// CONSTANTS
// =============================================================================

const FOUNDATION_SAFE = '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936';
// Post-rotation minter, identical on Base / Arbitrum / Optimism. Rotated from
// the deployer key after sprint-fixes deploy. Source: project memory + Cloud
// Run env (PVT_MINTER_KEY-derived address).
const EXPECTED_MINTER = '0xF0Ea014CAa37C34aF5D0a7F646ad7d7A79C09dF7';

const DEPLOYMENTS_DIR = path.resolve(__dirname, '../../contracts/deployments');

// Minimal read-only ABIs. We only need address-returning view functions plus
// activationState() for PVTv4.
const PVT_V4_READ_ABI = [
  'function admin() view returns (address)',
  'function minter() view returns (address)',
  'function governanceContract() view returns (address)',
  'function courtContract() view returns (address)',
  'function registry() view returns (address)',
  'function activationState() view returns (uint8)',
] as const;

const PE_ANCHOR_READ_ABI = [
  'function admin() view returns (address)',
  'function minter() view returns (address)',
] as const;

const ADMIN_READ_ABI = ['function admin() view returns (address)'] as const;

// =============================================================================
// TYPES
// =============================================================================

interface ChainConfig {
  network: 'base' | 'arbitrum' | 'optimism';
  chainId: number;
  rpcUrl: string;
  pvtV4: string;
  registry: string;
  governance: string;
  court: string;
  escrowV4: string;
  promiseV3: string;
  poolV3: string;
  // Base-only:
  peAnchor?: string;
}

interface MatrixRow {
  chain: string;
  contract: string;
  role: string;
  expected: string;
  actual: string;
  pass: boolean;
}

// =============================================================================
// MANIFEST LOADING
// =============================================================================

function readJson<T>(file: string): T {
  const full = path.join(DEPLOYMENTS_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw) as T;
}

interface PvtV4Manifest {
  network: string;
  chainId: number;
  contracts: { registryStub: string; pvtV4: string };
  wiring: {
    governance: string;
    court: string;
    escrowV4: string;
    promiseV3: string;
    poolV3: string;
  };
  finalAdmin: string;
}

interface SprintFixesManifest {
  contracts: {
    pvtV3: string;
    peAnchor: string;
    governance: string;
    courtV2: string;
  };
  config: { admin: string; minter: string };
}

interface PvtV3Manifest {
  network: string;
  chainId: number;
  contracts: { peAnchor?: string };
}

function loadChainConfigs(env: NodeJS.ProcessEnv): ChainConfig[] {
  const base = readJson<PvtV4Manifest>('base-pvt-v4.json');
  const arb = readJson<PvtV4Manifest>('arbitrum-pvt-v4.json');
  const op = readJson<PvtV4Manifest>('optimism-pvt-v4.json');
  const sprint = readJson<SprintFixesManifest>('base-sprint-fixes.json');
  // Arb / Op never got a sprint-fixes redeploy of PEAnchor - they use the
  // V3.1 deployment recorded in the *-pvt-v3 manifests. Same role check
  // (admin = Foundation Safe, minter = rotated minter) applies.
  const arbV3 = readJson<PvtV3Manifest>('arbitrum-pvt-v3.json');
  const opV3 = readJson<PvtV3Manifest>('optimism-pvt-v3.json');

  const configs: ChainConfig[] = [
    {
      network: 'base',
      chainId: base.chainId,
      rpcUrl: env.BASE_RPC_URL ?? '',
      pvtV4: base.contracts.pvtV4,
      registry: base.contracts.registryStub,
      governance: base.wiring.governance,
      court: base.wiring.court,
      escrowV4: base.wiring.escrowV4,
      promiseV3: base.wiring.promiseV3,
      poolV3: base.wiring.poolV3,
      peAnchor: sprint.contracts.peAnchor,
    },
    {
      network: 'arbitrum',
      chainId: arb.chainId,
      rpcUrl: env.ARBITRUM_RPC_URL ?? '',
      pvtV4: arb.contracts.pvtV4,
      registry: arb.contracts.registryStub,
      governance: arb.wiring.governance,
      court: arb.wiring.court,
      escrowV4: arb.wiring.escrowV4,
      promiseV3: arb.wiring.promiseV3,
      poolV3: arb.wiring.poolV3,
      peAnchor: arbV3.contracts.peAnchor,
    },
    {
      network: 'optimism',
      chainId: op.chainId,
      rpcUrl: env.OPTIMISM_RPC_URL ?? '',
      pvtV4: op.contracts.pvtV4,
      registry: op.contracts.registryStub,
      governance: op.wiring.governance,
      court: op.wiring.court,
      escrowV4: op.wiring.escrowV4,
      promiseV3: op.wiring.promiseV3,
      poolV3: op.wiring.poolV3,
      peAnchor: opV3.contracts.peAnchor,
    },
  ];

  return configs;
}

// =============================================================================
// VERIFICATION
// =============================================================================

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function safeRead<T>(label: string, fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  // Retry up to 6 times with exponential backoff. Public RPCs
  // (mainnet.base.org etc) rate-limit aggressively and frequently return
  // CALL_EXCEPTION with `missing revert data` when throttled. Retries clear
  // it. Use a real RPC URL for production verification.
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return { value: await fn() };
    } catch (err) {
      lastErr = err;
      if (attempt < 6) {
        const delayMs = 500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return { error: `${label}: ${msg}` };
}

const callDelayMs = Number(process.env.VERIFY_CALL_DELAY_MS ?? '0');
async function maybeStagger(): Promise<void> {
  if (callDelayMs > 0) {
    await new Promise((r) => setTimeout(r, callDelayMs));
  }
}

async function verifyChain(cfg: ChainConfig, log: (s: string) => void): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  if (!cfg.rpcUrl) {
    log(`[${cfg.network}] SKIPPED - no RPC URL set`);
    rows.push({
      chain: cfg.network,
      contract: '*',
      role: 'rpc_url',
      expected: 'set',
      actual: 'unset',
      pass: false,
    });
    return rows;
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  // Sanity: does the provider see the right chain?
  try {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== cfg.chainId) {
      rows.push({
        chain: cfg.network,
        contract: '*',
        role: 'chain_id',
        expected: String(cfg.chainId),
        actual: String(net.chainId),
        pass: false,
      });
      return rows;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rows.push({
      chain: cfg.network,
      contract: '*',
      role: 'rpc_connect',
      expected: 'ok',
      actual: msg,
      pass: false,
    });
    return rows;
  }

  // -------------------------------------------------------------------------
  // PVTv4
  // -------------------------------------------------------------------------
  {
    const pvt = new ethers.Contract(cfg.pvtV4, PVT_V4_READ_ABI, provider);

    // Serialized - public RPCs (esp mainnet.base.org) sometimes drop one of
    // many simultaneous eth_calls and return CALL_EXCEPTION even though the
    // contract responds correctly under raw eth_call.
    const admin = await safeRead('admin', () => pvt.admin() as Promise<string>);
    await maybeStagger();
    const minter = await safeRead('minter', () => pvt.minter() as Promise<string>);
    await maybeStagger();
    const gov = await safeRead('governanceContract', () => pvt.governanceContract() as Promise<string>);
    await maybeStagger();
    const court = await safeRead('courtContract', () => pvt.courtContract() as Promise<string>);
    await maybeStagger();
    const registry = await safeRead('registry', () => pvt.registry() as Promise<string>);
    await maybeStagger();
    const actState = await safeRead('activationState', () => pvt.activationState() as Promise<bigint>);

    pushRoleAddr(rows, cfg.network, 'PVTv4', 'admin', FOUNDATION_SAFE, admin);
    pushRoleAddr(rows, cfg.network, 'PVTv4', 'minter', EXPECTED_MINTER, minter);
    pushRoleAddr(rows, cfg.network, 'PVTv4', 'governanceContract', cfg.governance, gov);
    pushRoleAddr(rows, cfg.network, 'PVTv4', 'courtContract', cfg.court, court);
    pushRoleAddr(rows, cfg.network, 'PVTv4', 'registry', cfg.registry, registry);

    if (actState.error) {
      rows.push({
        chain: cfg.network,
        contract: 'PVTv4',
        role: 'activationState',
        expected: '<readable>',
        actual: actState.error,
        pass: false,
      });
    } else {
      // 0=PreVerification, 1=HumanGovernanceActive, 2=PVTGovernanceActive
      // We accept any of {0,1,2} as "readable"; expected default at deploy is 0.
      const actual = String(actState.value);
      const ok = actual === '0' || actual === '1' || actual === '2';
      rows.push({
        chain: cfg.network,
        contract: 'PVTv4',
        role: 'activationState',
        expected: '{0|1|2}',
        actual,
        pass: ok,
      });
    }
  }

  // -------------------------------------------------------------------------
  // PEAnchor (Base only)
  // -------------------------------------------------------------------------
  if (cfg.peAnchor) {
    const peAnchor = new ethers.Contract(cfg.peAnchor, PE_ANCHOR_READ_ABI, provider);
    const admin = await safeRead('admin', () => peAnchor.admin() as Promise<string>);
    await maybeStagger();
    const minter = await safeRead('minter', () => peAnchor.minter() as Promise<string>);
    pushRoleAddr(rows, cfg.network, 'PEAnchor', 'admin', FOUNDATION_SAFE, admin);
    pushRoleAddr(rows, cfg.network, 'PEAnchor', 'minter', EXPECTED_MINTER, minter);
  }

  // -------------------------------------------------------------------------
  // EscrowV4 / PromiseV3 / PoolV3 - admin() only
  // -------------------------------------------------------------------------
  for (const [label, addr] of [
    ['EscrowV4', cfg.escrowV4],
    ['PromiseV3', cfg.promiseV3],
    ['PoolV3', cfg.poolV3],
  ] as const) {
    const c = new ethers.Contract(addr, ADMIN_READ_ABI, provider);
    const admin = await safeRead('admin', () => c.admin() as Promise<string>);
    pushRoleAddr(rows, cfg.network, label, 'admin', FOUNDATION_SAFE, admin);
    await maybeStagger();
  }

  return rows;
}

function pushRoleAddr(
  rows: MatrixRow[],
  chain: string,
  contract: string,
  role: string,
  expected: string,
  result: { value?: string; error?: string },
): void {
  if (result.error) {
    rows.push({ chain, contract, role, expected, actual: result.error, pass: false });
    return;
  }
  const actual = result.value ?? '';
  rows.push({ chain, contract, role, expected, actual, pass: eq(expected, actual) });
}

function pushRoleNonZero(
  rows: MatrixRow[],
  chain: string,
  contract: string,
  role: string,
  result: { value?: string; error?: string },
): void {
  if (result.error) {
    rows.push({ chain, contract, role, expected: '<non-zero>', actual: result.error, pass: false });
    return;
  }
  const actual = result.value ?? '';
  const pass = !!actual && actual.toLowerCase() !== '0x0000000000000000000000000000000000000000';
  rows.push({ chain, contract, role, expected: '<non-zero>', actual, pass });
}

// =============================================================================
// REPORT
// =============================================================================

function renderMatrix(rows: MatrixRow[]): string {
  const headers = ['chain', 'contract', 'role', 'expected', 'actual', 'result'];
  const widths = headers.map((h) => h.length);
  const data = rows.map((r) => [
    r.chain,
    r.contract,
    r.role,
    r.expected,
    r.actual,
    r.pass ? 'PASS' : 'FAIL',
  ]);
  for (const row of data) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  return [fmt(headers), sep, ...data.map(fmt)].join('\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  const log = (s: string) => console.log(s);
  const configs = loadChainConfigs(process.env);

  const allRows: MatrixRow[] = [];
  for (const cfg of configs) {
    log(`\n--- ${cfg.network} (chainId=${cfg.chainId}) ---`);
    const rows = await verifyChain(cfg, log);
    allRows.push(...rows);
  }

  log('\n========== ROLE VERIFICATION MATRIX ==========');
  log(renderMatrix(allRows));

  const fails = allRows.filter((r) => !r.pass);
  log('\n');
  log(`total checks: ${allRows.length}`);
  log(`pass:         ${allRows.length - fails.length}`);
  log(`fail:         ${fails.length}`);

  if (fails.length > 0) {
    log('\nFAILURES:');
    for (const f of fails) {
      log(`  - ${f.chain} ${f.contract}.${f.role}: expected=${f.expected} actual=${f.actual}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-onchain-roles] fatal:', err);
    process.exit(1);
  });
}
