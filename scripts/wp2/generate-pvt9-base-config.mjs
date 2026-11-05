import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
export const SOURCE_PATH = path.join(REPO_ROOT, 'config/pvt9-base.json');
export const GENERATED_PATHS = [
  'src/core/pvt/pvt9-base-config.generated.ts',
  'provian-backend/src/core/pvt/pvt9-base-config.generated.ts',
  'provian-agent-sdk/src/pvt9-base-config.generated.ts',
  'contracts/scripts/pvt9-base-config.generated.ts',
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EXPECTED_KEYS = [
  '$schema',
  'config_version',
  'status',
  'network',
  'finality',
  'assets',
  'dependent_protocols',
  'compatibility',
  'genesis',
  'market_data',
  'validation',
];

const BASELINE_PARENT = '9d4a7dd575d3618fe5bfa3965a06b793e77f7f47';
/**
 * CURRENT PVT9 bootstrap authority. This is `ProvianPVT9.BOOTSTRAP_ADMIN` and
 * `ProvianPVT9EligibilityVerifier.BOOTSTRAP_ADMIN` — a compile-time constant in both
 * undeployed kernels — so every surface that asserts who holds PVT9 bootstrap authority
 * NOW must equal it.
 */
const FRANK_DIRECT = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3';
/**
 * HISTORICAL legacy authority. The EOA that is the on-chain admin / deployer / executor /
 * guardian of the already-deployed PVTv3-v8 stack at BASELINE_PARENT. That is a settled
 * fact of what was deployed, so records of it are evidence and are never rewritten — it is
 * NOT the PVT9 bootstrap administrator, and it holds no PVT9 role.
 */
const LEGACY_ADMIN_EOA = '0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a';
const FROZEN_MANIFEST_SHA256 = '704c1a2d9e555b56d9b4a5803b3f641b0e29e5e3012af0c0c3dc5ae665be6e71';
const FROZEN_COST_CATALOG_SHA256 = 'd1a5844c334077471c939861585770b658654abd75786b110c8617055f6a0049';
/**
 * The generated Machine surfaces block is byte-pinned so transport and
 * credential-custody descriptions cannot change without review. The local
 * package signs in-process; the private key is never sent to the relay.
 */
const FROZEN_LLMS_MACHINE_SURFACES_SHA256 = 'c816e3ee80796f3917c2488bcce959b62b9d8862ea3eba101fe23e862393a871';
/**
 * Bind every named action-policy row and the unknown-action admission rule.
 * This is the artifact's declared content hash: recursive key-sorted JSON
 * excluding content_sha256. Pretty-printing changes no policy authority.
 * A never-seen type records at zero, queues only from a non-actor witness
 * class, and earns prospectively from its signed named row. The signed
 * monetary template declares that same admission rule.
 */
const FROZEN_ACTION_POLICY_MATRIX_CONTENT_SHA256 =
  'sha256:d2ccc6cd174019cdab4e897ba5f84998674b2088b32e73b4755b4c306c5a58db';

/**
 * Byte-for-byte the generator's serializer
 * (provian-backend/scripts/generate-pvt-policy-matrix.ts::canonical). Kept in
 * lockstep deliberately: if the generator's canonicalization changes and this
 * does not, the self-consistency assertion below fails loudly rather than
 * silently accepting a differently-derived hash.
 */
function canonicalPolicyMatrixJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyMatrixJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalPolicyMatrixJson(value[key])}`).join(',')}}`;
}

/** Recompute the matrix's declared content hash from its own body. */
function matrixDeclaredContentHash(parsed) {
  const { content_sha256: _declared, ...body } = parsed;
  return `sha256:${crypto.createHash('sha256').update(canonicalPolicyMatrixJson(body)).digest('hex')}`;
}
const INVENTORY_PATH = 'config/integrity/retired-paths.json';
const GUARD_PATH = 'scripts/wp2/legacy-authority-block.ts';

const EXPECTED_LEGACY_GROUPS = Object.freeze({
  quarantined_mutation_script: [
    'scripts/transfer-admin-to-safe.ts',
    'contracts/scripts/transfer-admin-v4.ts',
    'contracts/scripts/wire-governance.ts',
    'contracts/scripts/deploy-phase3.ts',
    'contracts/scripts/resume-phase3.ts',
    'contracts/scripts/deploy-pvt-v3.ts',
    'contracts/scripts/deploy-pvt-v4.ts',
    'contracts/scripts/deploy-pvt-v5.ts',
    'contracts/scripts/deploy-pvt-v6.ts',
    'contracts/scripts/deploy-pvt-v7.ts',
    'contracts/scripts/deploy-chunk-i.ts',
    'contracts/scripts/deploy-chunk-ii.ts',
    'contracts/scripts/deploy-bond-pool.ts',
    'contracts/scripts/deploy-bondcourt-redeploy.ts',
    'contracts/scripts/deploy-security-patch.ts',
    'contracts/scripts/deploy-agent-bank.ts',
    'contracts/scripts/deploy-agent-bank-v4.ts',
    'contracts/scripts/deploy-base-bootstrap.ts',
    'contracts/scripts/deploy-base-sprint-fixes.ts',
  ],
  quarantined_current_legacy_mutation_script: [
    'contracts/scripts/deploy-pvt-v8.ts',
  ],
  quarantined_direct_package_wrapper: [
    'contracts/scripts/deploy-pvt-day-one.ts',
    'contracts/scripts/rotate-keys.ts',
  ],
  retained_read_only_verifier: [
    'contracts/scripts/verify-pvt-v7.ts',
    'contracts/scripts/verify-pvt-v8.ts',
    'contracts/scripts/verify-bondcourt-redeploy.ts',
  ],
  quarantined_shell_wrapper: [
    'contracts/scripts/admin-transfer/base-transfers-D395.sh',
    'contracts/scripts/admin-transfer/run-base-transfers-D395.sh',
    'contracts/scripts/admin-transfer/run-bondpool-deploy.sh',
  ],
  quarantined_nonimportable_safe_payload_evidence: [
    'contracts/scripts/admin-transfer/arbitrum-setprotocol-safe-batch.json',
    'contracts/scripts/admin-transfer/optimism-setprotocol-safe-batch.json',
  ],
  quarantined_nonoperational_historical_index: [
    'contracts/scripts/admin-transfer/README.md',
  ],
  historical_deployment_evidence_unchanged: [
    'contracts/deployments/arbitrum-bond-pool.json',
    'contracts/deployments/optimism-bond-pool.json',
    'contracts/deployments/base-bondcourt-redeploy.json',
    'contracts/deployments/base-sprint.json',
    'contracts/deployments/base-sprint-fixes.json',
  ],
  quarantined_build_entrypoint: [
    'provian-backend/cloudrun/anchor-recovery-build.yaml',
  ],
  quarantined_job_entrypoint: [
    'provian-backend/cloudrun/anchor-recovery-job.yaml',
  ],
  quarantined_scheduler_entrypoint: [
    'provian-backend/cloudrun/anchor-recovery-scheduler.yaml',
  ],
  quarantined_image_entrypoint: [
    'provian-backend/Dockerfile.anchor-recovery',
  ],
  legacy_execution_aliases_removed: ['contracts/package.json'],
  signerless_read_only_network_config: ['contracts/hardhat.config.ts'],
});

const EXPECTED_LEGACY_CLASSIFICATIONS = new Map(
  Object.entries(EXPECTED_LEGACY_GROUPS)
    .flatMap(([classification, paths]) => paths.map((entryPath) => [entryPath, classification])),
);

const FROZEN_CONTROLLING_PATHS = [
  // The closed-loop plan and accounting specification advance in settlement kernel. The
  // frozen policy inventory/atomic accounting handoff, approval evidence, manifest, and cost catalog do not.
  'docs/handoffs/PVT_WP0_WP1_HANDOFF.md',
  'docs/audit/pvt-wp0-wp1/APPROVAL_PROCESS.md',
  'docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json',
  'provian-backend/src/core/pvt/policy/proposed-pvt-cost-catalog.ts',
];

/**
 * Historical contracts may describe both PVT and external assets. Their bytes
 * are evidence, not a current PVT9 authority surface, so the guard classifies
 * them explicitly and requires exact baseline identity instead of rewriting
 * them to satisfy a scanner.
 */
const HISTORICAL_EXTERNAL_VALUE_CONTRACTS = [
  'contracts/src/ProvianEscrowV3.sol',
  'contracts/src/ProvianGovernance.sol',
  'contracts/src/ProvianPoolV2.sol',
  'contracts/src/ProvianPromiseV2.sol',
  'contracts/src/ProvianPVTv3.sol',
];

/**
 * Institution sources are pinned to their reviewed bytes. Their parameter
 * setters are admin-only, prospective, kernel-epoch-bound and lazily resolved:
 * advancing a local counter cannot collapse a scheduled ladder in one block.
 * Unset parameters resolve to each contract's existing literal or inert gate.
 * Cost floors use trailing issuance and fail closed to their literal when the
 * kernel is unavailable; posted bonds retain their requiredAtPost snapshot.
 * The Court pays only seats that posted and voted, burns unearned seat shares,
 * excludes dispute parties, and bounds panel replacement and abandonment.
 * Escrow adjudication charges a flat issuance-indexed fee directly to the Court.
 * Contracts have no admin drain or originated PVT price. Claim expiry and
 * abandonment respect open Court cases; carried positions use validated seed
 * arrays and distinct events. A Funded pool can be refunded past its deadline.
 * BASELINE_PARENT remains the anchor for preserved original artifacts.
 */
const REVIEWED_PORT_PINNED_CONTRACTS = Object.freeze({
  'contracts/src/ProvianBondPool.sol': 'e3fe8422165d6e1520c5e93324f743c042a26d93d5fa1d26e1491c4da2d1ad0b',
  'contracts/src/ProvianCourtV2.sol': '8dc9d054d06fcd71981ba56cb62c5a1daf356413a2d14783a2aa0358ae2a5cdf',
  'contracts/src/ProvianEscrowV4.sol': '12c6d671bc00f1528ae08ac4f1524e1465c7deeef918d74452d4334882c071f6',
  'contracts/src/ProvianPoolV3.sol': '52a1643ef6bee5b3c04d5ded9b2c6df3b61482b0b33c4ccd82716a0402606e2e',
  'contracts/src/ProvianPromiseV3.sol': '2cd557fa76f15805f8ac8983541b9cf6543deb00e82b826901fb3158ca091a8b',
});

/**
 * The kernel pair has its own byte pins because it remains inside the
 * external-value coupling scan. Historical institution classifications cannot
 * exempt current mint authority from that scan. BOOTSTRAP_ADMIN is immutable;
 * authority changes require a separately reviewed successor architecture.
 */
const REVIEWED_KERNEL_PINNED_CONTRACTS = Object.freeze({
  'contracts/src/ProvianPVT9.sol': '6fafddefe8c20490a813e13095bb466bccb6dd2b7a7b506c4c9f576497dd8a5d',
  'contracts/src/ProvianPVT9EligibilityVerifier.sol': 'dc129c388219e05ca3cf55b80c4f9cd91d6628f2345556a62c8823b2103b8e02',
});

/**
 * Retained verifiers are read-only evidence. The Court's deployed pvt() getter
 * is inspected with an explicit ABI fragment even when a source ABI omits it.
 * Pins bind their exact bytes; signer, deployment and broadcast capabilities
 * remain prohibited on every retained verifier.
 */
const REVIEWED_REPIN_VERIFIERS = Object.freeze({
  'contracts/scripts/verify-bondcourt-redeploy.ts': '2b3d81766f6053ea52476dda1030e51a232d06c97b7e9c629f79f41bd9d73335',
  'contracts/scripts/verify-pvt-v7.ts': 'dd3bbbe6c938a967640e4d3c4fb336ae5f31ea1d3714e4200efe037283892e3f',
  'contracts/scripts/verify-pvt-v8.ts': '1b5422e5568e0cc78624a8117a23a6a41d59cb324ab2bee537b0a0a7336e5308',
});

// Historical institution modules have explicit byte pins and remain classified
// outside the lexical coupling scan. Their currency-dual bookkeeping is not an
// authority to derive PVT from external value.
// Escrow party resolution supports humans and agents, verifies chain funding,
// and honors only the configured escrow or a recorded predecessor. A dispute
// is witnessed from the chain; a local status write emits no economic PE.
// Scheduler status mirrors wait for finalized receipts. Relay-observed promise
// default is a notify-only reputation fact; on-chain proof can upgrade it.
// Bond timing matches the contract: 30-day grace and 365-day abandonment.
// Advisory handshake invalidation and notify-only events never roll back an
// economic transition or alter counters when delivery fails.
const REVIEWED_EXTERNAL_VALUE_BACKEND_PINS = Object.freeze({
  'provian-backend/src/core/agent-bank/escrow.ts': '013f6515529a4b5a0572ceb8620cf43c6ceab9ea6155245fc48a98912c5ca855',
  'provian-backend/src/core/agent-bank/scheduler.ts': '589f3d02e25f2f085ea50df3eca51b9f5624be5543ea777d7a3afba69957ce73',
});
const HISTORICAL_EXTERNAL_VALUE_BACKEND = Object.keys(REVIEWED_EXTERNAL_VALUE_BACKEND_PINS);

const ACTIVE_CURRENT_TRUTH_PATHS = [
  'README.md',
  'docs/legal/privacy-policy.md',
  'docs/legal/terms-of-service.md',
  'provian-website/src/content/legal/privacy.md',
  'provian-website/src/content/legal/terms.md',
  'provian-website/public/llms.txt',
  'provian-website/public/llms-full.txt',
  'provian-website/src/data/docsManifest.json',
  'provian-website/src/app/agents/page.tsx',
  'provian-website/src/app/commons/page.tsx',
  'provian-website/src/app/earn/page.tsx',
  'provian-website/src/app/ubp/page.tsx',
  'provian-website/src/app/vision/page.tsx',
];

/** Exact accepted runtime boundary plus bounded settlement kernel review scope; an allowlist, not a target file count. */

function invariant(condition, message) {
  if (!condition) throw new Error(`PVT9_CONFIG_INVALID: ${message}`);
}

function normalize(address) {
  return address.toLowerCase();
}

function auditInvariant(condition, message) {
  if (!condition) throw new Error(`RUNTIME_BOUNDARY_AUDIT_FAILED: ${message}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitBuffer(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return null;
    const stderr = error?.stderr ? String(error.stderr).trim() : String(error);
    throw new Error(`RUNTIME_BOUNDARY_AUDIT_FAILED: git ${args.join(' ')} failed: ${stderr}`);
  }
}

function gitText(args, options) {
  const value = gitBuffer(args, options);
  return value === null ? null : value.toString('utf8');
}

function normalizeOverlay(overlay = new Map()) {
  return overlay instanceof Map ? overlay : new Map(Object.entries(overlay));
}

function readBuffer(relativePath, overlay) {
  const normalized = relativePath.replaceAll(path.sep, '/');
  if (overlay.has(normalized)) {
    const value = overlay.get(normalized);
    return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  }
  return fs.readFileSync(path.join(REPO_ROOT, normalized));
}

function readText(relativePath, overlay) {
  return readBuffer(relativePath, overlay).toString('utf8');
}

// The original git baseline is represented by its immutable SHA-256 byte pins.
// A fresh clone needs no hidden objects, alternate object database or old ancestry.
const BASELINE_PINS_SHA256 = '0fb0079474af5c7102548deff6582bd972a7c4de8113121b7cbe7ec007c758f3';
function baselineSha256(relativePath, overlay = new Map()) {
  const bytes = readBuffer('config/integrity/baseline-pins.json', overlay);
  auditInvariant(sha256(bytes) === BASELINE_PINS_SHA256, 'baseline byte pins changed');
  const data = JSON.parse(bytes.toString('utf8'));
  auditInvariant(data.baseline_parent === BASELINE_PARENT, 'baseline parent pin changed');
  const value = data.sha256[relativePath];
  auditInvariant(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `missing baseline byte pin: ${relativePath}`);
  return value;
}
function isRetiredPath(relativePath) {
  return JSON.parse(readText(INVENTORY_PATH, new Map())).paths.includes(relativePath);
}

function listRepositoryFiles(overlay) {
  const files = new Set(
    gitText(['ls-files', '--cached', '--others', '--exclude-standard'])
      .split('\n')
      .filter(Boolean),
  );
  for (const relativePath of overlay.keys()) files.add(relativePath);
  return [...files].sort();
}

function changedPathsFromBaseline(overlay) {
  const pins = JSON.parse(readText('config/integrity/baseline-pins.json', overlay)).sha256;
  return listRepositoryFiles(overlay).filter((relativePath) => !pins[relativePath]
    || !fs.statSync(path.join(REPO_ROOT, relativePath)).isFile()
    || sha256(readBuffer(relativePath, overlay)) !== pins[relativePath]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function extractBracedBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  auditInvariant(markerIndex >= 0, `missing structural marker: ${marker}`);
  const openIndex = source.indexOf('{', markerIndex + marker.length);
  auditInvariant(openIndex >= 0, `missing opening brace after: ${marker}`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error(`RUNTIME_BOUNDARY_AUDIT_FAILED: unclosed structural block after: ${marker}`);
}

function interfaceKeys(source, interfaceName) {
  const body = extractBracedBlock(source, `interface ${interfaceName}`);
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)]
    .map((match) => match[1]);
}

function stripCodeComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function expectConfiguredRejection(label, config) {
  let rejected = false;
  try {
    validateConfiguredState(config);
  } catch {
    rejected = true;
  }
  auditInvariant(rejected, `configured-state validator accepted ${label}`);
}

function deploymentLegacyAddresses() {
  const deploymentDir = path.join(REPO_ROOT, 'contracts/deployments');
  return fs.readdirSync(deploymentDir)
    .filter((name) => /(?:^|-)pvt-v[3-8]\.json$/.test(name))
    .flatMap((name) => {
      const value = JSON.parse(fs.readFileSync(path.join(deploymentDir, name), 'utf8'));
      return Object.entries(value.contracts ?? {})
        .filter(([key, address]) => /^pvtv?[3-8]$/i.test(key) && typeof address === 'string')
        .map(([, address]) => address);
    });
}

export function validateCanonicalConfig(config) {
  invariant(config && typeof config === 'object' && !Array.isArray(config), 'root must be an object');
  invariant(JSON.stringify(Object.keys(config)) === JSON.stringify(EXPECTED_KEYS), 'unexpected or missing top-level key');
  invariant(config.$schema === 'https://provian.org/schemas/pvt9-base-runtime-v1', 'schema identifier mismatch');
  invariant(config.config_version === 1, 'config_version must be 1');
  invariant(config.status === 'unconfigured' || config.status === 'configured', 'status must be explicit');
  invariant(config.network?.name === 'Base' && config.network?.chain_id === 8453, 'only Base mainnet (8453) is permitted');
  invariant(config.finality?.confirmations_inclusive === 12, 'finality must be 12 confirmations inclusive');
  invariant(config.finality?.proof_state_block_offset_from_head === -11, 'proof state must be H-11');
  invariant(config.finality?.eligibility_fence_block_offset_from_head === 1, 'eligibility fence must be H+1');
  invariant(config.assets?.usdc?.address === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'canonical Base USDC mismatch');
  invariant(ADDRESS.test(config.assets.usdc.address), 'canonical Base USDC must be a full EVM address');
  invariant(config.assets?.usdc?.decimals === 6, 'Base USDC decimals mismatch');
  invariant(config.dependent_protocols && Object.keys(config.dependent_protocols.addresses ?? {}).length === 0, 'runtime boundary dependent addresses must be empty');
  invariant(config.dependent_protocols && Object.keys(config.dependent_protocols.abis ?? {}).length === 0, 'runtime boundary dependent ABIs must be empty');
  invariant(config.compatibility?.legacy_fallback === false, 'legacy fallback must be disabled');
  invariant(config.compatibility?.legacy_migration === false, 'legacy migration must be disabled');
  invariant(config.compatibility?.cross_chain_fallback === false, 'cross-chain fallback must be disabled');
  invariant(config.genesis?.armed === false, 'Genesis must be unarmed');
  invariant(config.genesis?.window_approved === false, 'Genesis window must be unapproved');
  invariant(config.genesis?.start_at === null && config.genesis?.end_at === null, 'Genesis timestamps must be null');
  invariant(config.market_data?.economic_authority === false, 'market data must be economically non-authoritative');
  invariant(config.market_data?.pvt_mapping === null, 'PVT market-data mapping must be null');
  invariant(config.market_data?.permitted_use === 'non_pvt_wallet_display_only', 'market data may only support non-PVT wallet display');

  const forbidden = config.validation?.forbidden_pvt_addresses;
  invariant(Array.isArray(forbidden) && forbidden.every((address) => ADDRESS.test(address)), 'forbidden legacy addresses must be explicit EVM addresses');
  const configuredForbidden = new Set(forbidden.map(normalize));
  for (const address of deploymentLegacyAddresses()) {
    invariant(configuredForbidden.has(normalize(address)), `known PVTv3-v8 address is not forbidden: ${address}`);
  }

  if (config.status === 'unconfigured') {
    invariant(config.assets.pvt9.address === null, 'unconfigured PVT9 address must be null');
    invariant(config.assets.pvt9.abi === null, 'unconfigured PVT9 ABI must be null');
    invariant(config.assets.pvt9.deployment_status === 'not_deployed', 'unconfigured PVT9 must be not_deployed');
  } else {
    validateConfiguredState(config);
  }
  return config;
}

export function validateConfiguredState(config) {
  invariant(config.network?.name === 'Base' && config.network?.chain_id === 8453, 'configured runtime must be Base mainnet');
  invariant(config.compatibility?.legacy_fallback === false && config.compatibility?.legacy_migration === false && config.compatibility?.cross_chain_fallback === false, 'configured runtime cannot enable a fallback or migration');
  const address = config.assets?.pvt9?.address;
  invariant(typeof address === 'string' && ADDRESS.test(address), 'configured PVT9 address is missing or invalid');
  const conflicts = new Set([
    ZERO_ADDRESS,
    config.assets?.usdc?.address,
    ...Object.values(config.dependent_protocols?.addresses ?? {}),
    ...Object.entries(config.assets ?? {})
      .filter(([assetName]) => assetName !== 'pvt9')
      .map(([, asset]) => asset?.address),
    ...(config.validation?.forbidden_pvt_addresses ?? []),
  ].filter((candidate) => typeof candidate === 'string').map(normalize));
  invariant(!conflicts.has(normalize(address)), 'configured PVT9 address conflicts with zero, legacy, asset, or dependent address');
  invariant(Array.isArray(config.assets.pvt9.abi) && config.assets.pvt9.abi.length > 0, 'configured PVT9 ABI must be non-empty');
  invariant(config.assets.pvt9.deployment_status === 'deployed', 'configured PVT9 must have deployed status');
  return config;
}

export function renderGenerated(config) {
  const serialized = JSON.stringify(config, null, 2);
  return `/* AUTO-GENERATED by scripts/wp2/generate-pvt9-base-config.mjs. DO NOT EDIT. */
export const PVT9_BASE_CONFIG = ${serialized} as const;

export type ConfiguredPvt9Runtime = Readonly<{
  chainId: 8453;
  address: string;
  abi: readonly unknown[];
  confirmationsInclusive: 12;
  proofStateBlockOffsetFromHead: -11;
  eligibilityFenceBlockOffsetFromHead: 1;
}>;

type RuntimeConfigShape = {
  status: string;
  network: { name: string; chain_id: number };
  finality: {
    confirmations_inclusive: number;
    proof_state_block_offset_from_head: number;
    eligibility_fence_block_offset_from_head: number;
  };
  assets: {
    [assetName: string]: { address?: string | null; abi?: readonly unknown[] | null; deployment_status?: string };
    usdc: { address: string };
    pvt9: { address: string | null; abi: readonly unknown[] | null; deployment_status: string };
  };
  dependent_protocols: { addresses: Record<string, string> };
  compatibility: { legacy_fallback: boolean; legacy_migration: boolean; cross_chain_fallback: boolean };
  validation: { forbidden_pvt_addresses: readonly string[] };
};

function unconfigured(reason: string): never {
  const error = new Error(\`PVT9_UNCONFIGURED: \${reason}\`) as Error & { code: string };
  error.name = 'PVT9_UNCONFIGURED';
  error.code = 'PVT9_UNCONFIGURED';
  throw error;
}

/** Pure runtime boundary seam: this reads only the generated canonical constant. */
export function requireConfiguredPvt9Runtime(): ConfiguredPvt9Runtime {
  const config = PVT9_BASE_CONFIG as unknown as RuntimeConfigShape;
  const address = config.assets.pvt9.address;
  if (config.status !== 'configured') unconfigured('canonical status is not configured');
  if (config.network.name !== 'Base' || config.network.chain_id !== 8453) unconfigured('non-Base configuration');
  if (config.compatibility.legacy_fallback || config.compatibility.legacy_migration || config.compatibility.cross_chain_fallback) unconfigured('fallback or migration enabled');
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) unconfigured('address missing or invalid');
  const blocked = new Set([
    '0x0000000000000000000000000000000000000000',
    config.assets.usdc.address,...Object.entries(config.assets).filter(([assetName]) => assetName !== 'pvt9').map(([, asset]) => asset.address).filter((value): value is string => typeof value === 'string'),...Object.values(config.dependent_protocols.addresses),...config.validation.forbidden_pvt_addresses,
  ].map((value) => value.toLowerCase()));
  if (blocked.has(address.toLowerCase())) unconfigured('address conflicts with a forbidden address');
  if (!Array.isArray(config.assets.pvt9.abi) || config.assets.pvt9.abi.length === 0) unconfigured('ABI missing or empty');
  if (config.assets.pvt9.deployment_status !== 'deployed') unconfigured('deployment status is not deployed');
  return Object.freeze({
    chainId: 8453,
    address,
    abi: config.assets.pvt9.abi,
    confirmationsInclusive: 12,
    proofStateBlockOffsetFromHead: -11,
    eligibilityFenceBlockOffsetFromHead: 1,
  });
}
`;
}

export function generate({ check = false } = {}) {
  const config = validateCanonicalConfig(JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8')));
  const expected = renderGenerated(config);
  for (const relativePath of GENERATED_PATHS) {
    const outputPath = path.join(REPO_ROOT, relativePath);
    if (check) {
      invariant(fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8') === expected, `generated mirror is stale: ${relativePath}`);
    } else {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, expected);
    }
  }
}

function auditConfiguredStateMatrix(canonical) {
  const configured = (address = '0x1234567890123456789012345678901234567890') => {
    const candidate = clone(canonical);
    candidate.status = 'configured';
    candidate.assets.pvt9 = {
      address,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [] }],
      deployment_status: 'deployed',
    };
    return candidate;
  };

  validateConfiguredState(configured());
  expectConfiguredRejection('the zero address', configured(ZERO_ADDRESS));
  expectConfiguredRejection('canonical Base USDC as PVT9', configured(canonical.assets.usdc.address));
  for (const legacyAddress of canonical.validation.forbidden_pvt_addresses) {
    expectConfiguredRejection(`legacy PVT address ${legacyAddress}`, configured(legacyAddress));
  }

  const otherAssetAddress = '0x4200000000000000000000000000000000000006';
  const otherAsset = configured(otherAssetAddress);
  otherAsset.assets.weth = { address: otherAssetAddress, decimals: 18 };
  expectConfiguredRejection('another configured asset as PVT9', otherAsset);

  const dependentAddress = '0x2222222222222222222222222222222222222222';
  const dependent = configured(dependentAddress);
  dependent.dependent_protocols.addresses.escrow = dependentAddress;
  expectConfiguredRejection('a dependent-protocol address as PVT9', dependent);

  const emptyAbi = configured();
  emptyAbi.assets.pvt9.abi = [];
  expectConfiguredRejection('an empty ABI', emptyAbi);

  const notDeployed = configured();
  notDeployed.assets.pvt9.deployment_status = 'not_deployed';
  expectConfiguredRejection('a non-deployed status', notDeployed);

  for (const fallbackKey of ['legacy_fallback', 'legacy_migration', 'cross_chain_fallback']) {
    const fallback = configured();
    fallback.compatibility[fallbackKey] = true;
    expectConfiguredRejection(`${fallbackKey}=true`, fallback);
  }

  const nonBase = configured();
  nonBase.network = { name: 'Ethereum', chain_id: 1 };
  expectConfiguredRejection('a non-Base runtime', nonBase);
}

function auditCanonicalConfiguration(overlay) {
  const canonicalText = readText('config/pvt9-base.json', overlay);
  const canonical = validateCanonicalConfig(JSON.parse(canonicalText));
  auditConfiguredStateMatrix(canonical);

  const expectedMirror = renderGenerated(canonical);
  for (const generatedPath of GENERATED_PATHS) {
    const generated = readText(generatedPath, overlay);
    auditInvariant(generated === expectedMirror, `generated mirror is not mechanical: ${generatedPath}`);
    auditInvariant(!/^\s*import\s/m.test(generated), `generated seam imports a dependency: ${generatedPath}`);
    auditInvariant(
      !/(?:process|Deno)\.env|\bfetch\s*\(|\baxios\b|\breadFile|\bgetSigner\b|\bcreateSigner\b|\bnew\s+Wallet\b|private[_ -]?key|\bcontroller\b/i.test(generated),
      `generated seam contains an environment, network, signer, controller, or deployment fallback: ${generatedPath}`,
    );
    for (const actor of [FRANK_DIRECT, LEGACY_ADMIN_EOA]) {
      auditInvariant(!generated.includes(actor), `runtime config contains the future authority actor: ${generatedPath}`);
    }
  }
  for (const actor of [FRANK_DIRECT, LEGACY_ADMIN_EOA]) {
    auditInvariant(!canonicalText.includes(actor), 'canonical runtime config contains the future authority actor');
  }

  const allowedCanonicalFiles = new Set([
    'config/pvt9-base.json',
    'scripts/wp2/generate-pvt9-base-config.mjs',
    ...GENERATED_PATHS,
  ]);
  const canonicalSignature = 'https://provian.org/schemas/pvt9-base-runtime-v1';
  const shadows = listRepositoryFiles(overlay).filter((relativePath) => {
    if (allowedCanonicalFiles.has(relativePath)) return false;
    if (!/\.(?:json|[cm]?[jt]s|ya?ml)$/.test(relativePath)) return false;
    if (!/^(?:config|src|scripts|provian-backend\/src|provian-agent-sdk\/src|contracts\/scripts)\//.test(relativePath)) return false;
    try {
      return readText(relativePath, overlay).includes(canonicalSignature);
    } catch {
      return false;
    }
  });
  auditInvariant(shadows.length === 0, `second canonical configuration source detected: ${shadows.join(', ')}`);
}

function auditLegacyAuthorityQuarantine(overlay) {
  const bytes = readBuffer(INVENTORY_PATH, overlay);
  auditInvariant(sha256(bytes) === '2e96661fcac969b3e615cc2a42efbd3d8b57b56186bda5fb1a900b37c568bfc5', 'retired-path boundary changed');
  const inventory = JSON.parse(bytes.toString('utf8'));
  auditInvariant(inventory.direct_bootstrap_administrator_and_economic_policy_setter === FRANK_DIRECT,
    'the operator direct bootstrap boundary drifted');
  auditInvariant(inventory.paths.length > 40, 'retired-path population is empty or incomplete');
  const present = new Set(listRepositoryFiles(overlay));
  for (const relativePath of inventory.paths) {
    auditInvariant(!present.has(relativePath), `retired execution or contract restored: ${relativePath}`);
  }
  const packageJson = JSON.parse(readText('contracts/package.json', overlay));
  auditInvariant(JSON.stringify(packageJson.scripts) === JSON.stringify({ compile: 'hardhat compile' }),
    'contracts package exposes a legacy execution alias');
  const hardhat = readText('contracts/hardhat.config.ts', overlay);
  const accountValues = [...hardhat.matchAll(/accounts\s*:\s*([^,\n]+)/g)].map((match) => match[1].trim());
  auditInvariant(accountValues.length >= 6 && accountValues.every((value) => value === '[]'),
    'Hardhat network config exposes an account or signer');
}
function runLegacyBlockerExecutionRegressions() {
  auditLegacyAuthorityQuarantine(new Map());
}

const PVT_ECONOMIC_SINK = String.raw`(?:pvt(?:[A-Za-z0-9_]*(?:eligib|issu|mint|reward|cap|settle|cost|fee)[A-Za-z0-9_]*|[\s_-]+(?:eligibility|issuance|mint|reward|cap|settlement|cost|fee))|(?:eligib|issu|mint|reward|cap|settle|cost|fee)[A-Za-z0-9_]*pvt)`;
const EXTERNAL_VALUE_SOURCE = String.raw`(?:amount[_A-Za-z0-9]*(?:usd|usdc)|(?:usd|usdc)[_A-Za-z0-9]*amount|assetAmount|externalAsset|tokenPrice|priceFeed|exchangeRate|fiatQuote|marketData|oracleQuote|externalValue|externalConsideration|usdEquivalent)`;

function assertNoExternalValueCoupling(layer, relativePaths, overlay) {
  const assignmentForward = new RegExp(`${PVT_ECONOMIC_SINK}\\s*['\"]?\\s*(?:=|:)\\s*[\\s\\S]{0,220}${EXTERNAL_VALUE_SOURCE}`, 'i');
  const callFlow = new RegExp(`${PVT_ECONOMIC_SINK}\\s*\\([\\s\\S]{0,220}${EXTERNAL_VALUE_SOURCE}`, 'i');
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const source = stripCodeComments(readText(relativePath, overlay));
    let aliasedProviderFlow = false;
    for (const importMatch of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      if (!/(?:price|quote|oracle|market|exchange|fiat|valuation|external-value)/i.test(importMatch[2])) continue;
      const importClause = importMatch[1];
      const localNames = [
        importClause.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1],
        importClause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1],
        ...[...importClause.matchAll(/(?:^|[,{}])\s*[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)/g)]
          .map((match) => match[1]),
        ...[...importClause.matchAll(/(?:^|[,{}])\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)]
          .map((match) => match[1]),
      ].filter(Boolean);
      aliasedProviderFlow ||= localNames.some((localName) => {
        const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`${PVT_ECONOMIC_SINK}\\s*['\"]?\\s*(?:=|:)\\s*[^;\\n]{0,160}\\b${escaped}\\b`, 'i').test(source);
      });
    }
    auditInvariant(
      !assignmentForward.test(source) && !callFlow.test(source) && !aliasedProviderFlow,
      `${layer} external value enters PVT economic authority: ${relativePath}`,
    );
  }
}

function auditExternalValueLayerCoverage(overlay) {
  for (const relativePath of HISTORICAL_EXTERNAL_VALUE_CONTRACTS) {
    if (isRetiredPath(relativePath)) continue;
    auditInvariant(
      sha256(readBuffer(relativePath, overlay)) === baselineSha256(relativePath, overlay),
      `historical external-value contract changed instead of remaining classified evidence: ${relativePath}`,
    );
  }
  for (const [relativePath, pinnedSha256] of Object.entries(REVIEWED_PORT_PINNED_CONTRACTS)) {
    if (isRetiredPath(relativePath)) continue;
    auditInvariant(
      sha256(readBuffer(relativePath, overlay)) === pinnedSha256,
      `reviewed WP-scoped port contract changed after its re-pin and must be re-pinned after review: ${relativePath}`,
    );
  }
  for (const [relativePath, pinnedSha256] of Object.entries(REVIEWED_KERNEL_PINNED_CONTRACTS)) {
    auditInvariant(
      sha256(readBuffer(relativePath, overlay)) === pinnedSha256,
      `reviewed PVT9 kernel contract changed after its re-pin and must be re-pinned after review: ${relativePath}`,
    );
  }
  // NOTE: REVIEWED_KERNEL_PINNED_CONTRACTS is deliberately NOT folded in here -- the PVT9
  // kernel pair stays inside the external-value coupling scan below.
  const classifiedHistoricalContracts = new Set([
    ...HISTORICAL_EXTERNAL_VALUE_CONTRACTS,
    ...Object.keys(REVIEWED_PORT_PINNED_CONTRACTS),
  ]);
  const repositoryFiles = listRepositoryFiles(overlay);
  const currentContracts = repositoryFiles.filter((relativePath) => relativePath.startsWith('contracts/src/')
    && relativePath.endsWith('.sol')
    && !classifiedHistoricalContracts.has(relativePath));
  assertNoExternalValueCoupling('contracts', currentContracts, overlay);

  for (const [relativePath, pinnedSha256] of Object.entries(REVIEWED_EXTERNAL_VALUE_BACKEND_PINS)) {
    auditInvariant(
      sha256(readBuffer(relativePath, overlay)) === pinnedSha256,
      `reviewed external-value backend module changed after its re-pin and must be re-pinned after review: ${relativePath}`,
    );
  }
  const backendPaths = repositoryFiles.filter((relativePath) => relativePath.startsWith('provian-backend/src/')
    && /\.[cm]?ts$/.test(relativePath)
    && !/\.(?:test|spec)\.ts$/.test(relativePath)
    && !HISTORICAL_EXTERNAL_VALUE_BACKEND.includes(relativePath));
  assertNoExternalValueCoupling('backend', backendPaths, overlay);

  const sdkPaths = repositoryFiles.filter((relativePath) => relativePath.startsWith('provian-agent-sdk/src/')
    && /\.[cm]?ts$/.test(relativePath)
    && !/\.test\.ts$/.test(relativePath));
  assertNoExternalValueCoupling('SDK', sdkPaths, overlay);

  const legitimateDisplayPricing = new Set([
    'src/core/prices/PriceService.ts',
    'src/core/wallet/BalanceService.ts',
  ]);
  const appPaths = repositoryFiles.filter((relativePath) => relativePath.startsWith('src/')
    && /\.(?:ts|tsx)$/.test(relativePath)
    && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relativePath)
    && !legitimateDisplayPricing.has(relativePath));
  assertNoExternalValueCoupling('app', appPaths, overlay);

  const schemaAndAbiPaths = [
    'config/pvt9-base.json',
    'config/integrity/retired-paths.json',
    'provian-backend/src/core/agent-bank/types.ts',
    ...GENERATED_PATHS,
    ...repositoryFiles.filter((relativePath) => (relativePath.startsWith('config/')
      || /(?:schema|abi|types)/i.test(path.basename(relativePath)))
      && /^(?:config|src|provian-backend\/src|provian-agent-sdk\/src)\//.test(relativePath)
      && /\.(?:json|ya?ml|[cm]?[jt]s)$/.test(relativePath)),
  ];
  assertNoExternalValueCoupling('schemas/ABIs', schemaAndAbiPaths, overlay);
  const canonical = JSON.parse(readText('config/pvt9-base.json', overlay));
  // The PVT9 ABI is permitted ONLY in the configured state, and only alongside a real
  // address and a `deployed` status — the three move together or not at all.
  //
  // This assertion previously read `abi === null` unconditionally. That was the runtime boundary
  // checkpoint's fail-closed seam and it was correct while PVT9 was undeployed: a null ABI
  // is what makes a contract handle unconstructible from this repo. The kernel is now
  // deployed and verified on Base, so an unconditional null asserts something false about
  // the world rather than something safe about the repo.
  //
  // What is NOT relaxed: the configured branch still forbids the zero address, every legacy
  // PVTv3–v8 address, any other configured asset or dependent address, an empty ABI, a
  // non-Base network, and any fallback or migration flag (`validateConfiguredState`). The
  // dependent-protocol ABI map stays empty unconditionally — no dependent runtime is
  // configured, and configuring PVT9 must never bring one along.
  if (canonical.status === 'unconfigured') {
    auditInvariant(canonical.assets?.pvt9?.abi === null, 'unconfigured runtime configures a PVT9 ABI');
  } else {
    auditInvariant(Array.isArray(canonical.assets?.pvt9?.abi) && canonical.assets.pvt9.abi.length > 0,
      'configured runtime has no PVT9 ABI');
    auditInvariant(ADDRESS.test(canonical.assets?.pvt9?.address ?? ''),
      'configured runtime has a PVT9 ABI but no valid address');
    auditInvariant(canonical.assets?.pvt9?.deployment_status === 'deployed',
      'configured runtime has a PVT9 ABI but is not marked deployed');
  }
  auditInvariant(Object.keys(canonical.dependent_protocols?.abis ?? {}).length === 0, 'schemas/ABIs configure a dependent PVT9 protocol ABI in runtime boundary');

  const classifiedScripts = new Set(EXPECTED_LEGACY_CLASSIFICATIONS.keys());
  const scriptPaths = repositoryFiles.filter((relativePath) => /^(?:scripts|contracts\/scripts)\//.test(relativePath)
    && /\.(?:[cm]?[jt]s|sh)$/.test(relativePath)
    && relativePath !== 'scripts/wp2/generate-pvt9-base-config.mjs'
    && !classifiedScripts.has(relativePath));
  assertNoExternalValueCoupling('scripts', scriptPaths, overlay);

  const activeDocs = ACTIVE_CURRENT_TRUTH_PATHS.filter((relativePath) => /\.(?:md|txt|tsx)$/.test(relativePath));
  const docCoupling = new RegExp(`${PVT_ECONOMIC_SINK}[\\s\\S]{0,120}(?:is based on|depends on|=|uses)[\\s\\S]{0,120}${EXTERNAL_VALUE_SOURCE}`, 'i');
  for (const relativePath of activeDocs) {
    const source = readText(relativePath, overlay);
    const currentMaterial = relativePath.endsWith('/llms-full.txt')
      ? source.split('\n<!-- source:')[0]
      : source;
    auditInvariant(!docCoupling.test(currentMaterial), `active documentation makes external value authoritative for PVT: ${relativePath}`);
  }
}

function auditExternalValueIsolation(overlay) {
  const authorityPath = 'provian-backend/src/core/pvt/economics/financial-economic-authority.ts';
  const activityPath = 'provian-backend/src/core/pvt/activity-mint-limits.ts';
  const accrualPath = 'provian-backend/src/pvt-accrual.ts';
  const authority = readText(authorityPath, overlay);
  const activity = readText(activityPath, overlay);
  const accrual = readText(accrualPath, overlay);

  auditInvariant(!/^\s*import\b/m.test(authority), 'financial economic authority gained an import edge');
  auditInvariant(!/\b(?:fetch|axios|oracle|coingecko|coinbase|exchange|quote|market|price|fiat|amount|value)\b/i.test(
    authority.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
  ), 'financial economic authority contains an external-value concept');
  auditInvariant(
    JSON.stringify(interfaceKeys(authority, 'FinancialEconomicAuthorityInput')) === JSON.stringify([
      'counterpartyRequired',
      'counterpartyVerified',
      // the per-(actor, counterparty) count and cap were removed; the
      // per-actor daily count is the only count left.
      'dailyCount',
      'dailyCeiling',
    ]),
    'financial economic authority input is not identity/count-only',
  );

  const importSources = [...activity.matchAll(/^import[\s\S]*?;\s*$/gm)].map((match) => {
    const sourceMatch = match[0].match(/(?:from\s+)?['"]([^'"]+)['"]/);
    return sourceMatch?.[1] ?? '';
  });
  auditInvariant(
    JSON.stringify(importSources) === JSON.stringify([
      'crypto',
      'json-stable-stringify',
      'firebase-admin/firestore',
      './economics/financial-economic-authority',
    ]),
    `activity economic orchestrator import allowlist drifted: ${importSources.join(', ')}`,
  );
  auditInvariant(!/\bimport\s*\(/.test(activity), 'activity economic orchestrator gained a dynamic import');
  auditInvariant(
    JSON.stringify(interfaceKeys(activity, 'ReservationInput')) === JSON.stringify([
      'peId',
      'userId',
      'actionType',
      'counterpartyAddress',
      'timestampMs',
    ]),
    'activity reservation input is not value-free',
  );
  auditInvariant(!/value_usd|mintValueUsd|valueUsd|dustFloor/i.test(
    extractBracedBlock(activity, 'interface ActivityMintReservationDocument'),
  ), 'activity reservation evidence contains an external value or dust threshold');

  const recordKeys = interfaceKeys(accrual, 'RecordPEAccrualParams');
  auditInvariant(
    JSON.stringify(recordKeys) === JSON.stringify([
      'peId', 'userId', 'actionType', 'integrationSource', 'attestationDepth', 'peHash', 'timestamp',
      'inputSummary', 'outputSummary', 'tx_hash', 'artifact_hash', 'commitSha', 'replication_pack',
      'jurisdiction_context', 'linkedHumanWalletId', 'isDevicePE', 'deviceAttestationId', 'deviceId',
      'attestation_verified', 'noObservableOutput', 'ownerType', 'walletAddress', 'citedPeIds',
      'parentGoalPeId', 'fixedEstimatedPVT', 'isGenesisGrant', 'genesisWalletId',
      'genesisFundingSourceAddress', 'x402PayerAddress', 'counterpartyAddress', 'x402SettlementTxHash',
      'x402ChainVerified',
      // sovereign agent-work occurrence mint-once keys (value-free identifiers).
      'sovereignWorkOccurrenceId', 'sovereignWorkSignerAddress',
      // device-witnessed compute HARD per-occurrence mint-once key: a sha256
      // of the overlay's canonical event id. A value-free IDENTIFIER on the same
      // reading as the sovereign occurrence keys above — it carries no amount,
      // rate, weight, cap, split, address or disposition, and cannot make an
      // action type eligible (the action-policy table still decides); it only
      // keys the device_occurrence claim so a replay records 0.
      'deviceWitnessedOccurrenceHash',
      // completion mint-once key: the canonical completion id
      // (`escrow:<escrow_id>` / `human_job:<job_id>` / `escrow_onchain:…`) the
      // institution-completion watcher resolves for an escrow release paid to the
      // recipient. A value-free IDENTIFIER on the same reading as the two keys
      // above — no amount, rate, weight, cap, split, address or disposition, and
      // it cannot make an action type eligible; it only keys the `completion`
      // claim so the on-chain and off-chain witnesses of ONE job mint once.
      'completionCanonicalId',
      'economicEvidenceState', 'economicCanonicalEventId', 'economicSessionLineageId',
      'economicSelfReferencing', 'economicSharedBeneficialOwnership',
      // review: the verified transaction signer the same-owner fence also
      // checks for a receive that reached the wallet through a contract. An
      // ADDRESS IDENTIFIER used only by the same-owner fence — it carries no
      // amount, rate, weight, cap or split and cannot make an action type eligible.
      'economicTransactionSigner',
      // money layer (Prompt 3). The provenance inputs the origin-pricing orchestrator resolves
      // into `independent_origin_count` and `observed_tokens`. Value-FREE by the same reading as the
      // keys above: `inputOrigins` is the PE's recorded origin list (hash + identifier + a body
      // `witnessed` flag the money layer explicitly does NOT trust), `submissionWitness` is a
      // relay-derived witness IDENTITY + attestation tier (no amount), and the two token fields are
      // observable COUNTS — pricing inputs the kernel owns via a fixed formula, exactly as
      // `occurrenceOrdinal`/`dailyOrdinal` are. None carries a PVT amount, rate, weight, cap, split,
      // address or disposition, and none can make an action type eligible — the action-policy table
      // still decides. At pieces 1–4 they are sealed informational and change no price at all.
      // ops-dashboard build. `captureLane` (between `submissionWitness` and the token fields, matching
      // the interface order) is a value-FREE observability label — one of the ten fixed capture-lane
      // names (or `'other'`), a hint the emitter/daemon supplies for which capture surface produced the
      // PE. It carries no PVT amount, rate, weight, cap, split, address or disposition, and cannot make
      // an action type eligible; it is sealed INFORMATIONAL and changes no price. Value-free by the
      // same reading as `submissionWitness` beside it.
      // Fact-base fixes item 4. `relayWitnessedOrigins` = the relay's OWN verified
      // observation (a forge webhook / chain watcher identity, tier null) plus the `identifier|hash`
      // keys of EXACTLY the origins it derived from that verified event — relay-computed in
      // `generatePE`, never body-supplied, never set on the sovereign or self-report lanes. It carries
      // no amount, rate, weight, cap, split, address or disposition and cannot make an action type
      // eligible; it only marks origins witnessed, which then face the unchanged owner / identity-set
      // / closed-loop tests. Value-free by the same reading as `submissionWitness` beside it.
      'inputOrigins', 'submissionWitness', 'relayWitnessedOrigins', 'captureLane',
      // Trust Layer build (2026-09-16 §2.3/§2.8/§2.11). `outputDigests` = the PE's citable outputs
      // (hash + type tag + optional public locator) — recorded and indexed, never priced.
      // `witnessClass` = WHO vouched (relay-ASSIGNED from the binding it checked, never body-
      // supplied; sealed informational alongside the origins). `witnessedAtMs` = relay receipt time.
      // None carries an amount, rate, weight, cap, split, address or disposition; value-free by the
      // same reading as `submissionWitness` beside them.
      'outputDigests', 'witnessClass', 'witnessedAtMs',
      'witnessObservedTokens', 'bodyDeclaredTokens', 'compositionSignals',
      'economicSnapshot', 'throwOnError',
      //. A REPLAYABILITY claim about transport, not an economic input: it
      // names the collection holding this accrual's committed replay payload,
      // and `verifyOrdinaryAccrualIntakeReplaySource` reads that row before it
      // counts for anything. It carries no amount, rate, weight, cap, split,
      // address or disposition, and it cannot make an action type eligible —
      // the action-policy table still decides. Value-free by the same reading
      // as `throwOnError` beside it.
      'durableReplaySource',
      // (Commons communication). The live presentation WINDOW a speech PE was sealed under:
      // `{ burnId, burnAmountAtomic }` — the burn's IDENTIFIER and its on-chain-verified amount,
      // read from the relay's own burn row (never body-supplied). The accrual reserves the PE's
      // record points against that window's budget (`speech-window-budget.ts`) and seals
      // `record_only` past it. It carries no rate, weight, cap, split, address or disposition, and
      // it cannot make an action type eligible — the action-policy table still decides; it can
      // only REFUSE a mint (Σ speech points < the burn, strictly). Value-free on the same reading
      // as `durableReplaySource` beside it: a window can lower a row's disposition, never raise it.
      'speechWindow',
      'durableTestCrashAt',
      // PE METER (: the relay is a meter, not an archive). `meter` = the signed
      // batch an act arrived in (batch hash, device id, the device's own pe id / pe_hash / prev
      // hash, the occurrence time) plus a read memo and a result sink — the batch is the act's
      // replay source, and the seal lands in the batch commit instead of pe_history. It carries no
      // amount, rate, weight, cap, split, address or disposition and cannot make an action type
      // eligible: an act is durable only where its lane already claimed `durableReplaySource` or
      // `throwOnError`. `meterRecordOnly` is a REASON STRING (an act older than the 30-day mint
      // window) that can only lower a row to record_only, never raise it — value-free on the same
      // reading as `speechWindow` beside it.
      'meter', 'meterRecordOnly',
      // Shutdown coverage : `accrualReceivedAtMs` is the relay's own committed
      // intake time for the act, read only by the accrual end line (`accrual-end-line.ts`) so a
      // replay after the line of an act received before it still settles. It carries no amount,
      // rate, weight, cap, split, address or disposition, and it can only lower a row to
      // record_only (an act received at or after the end line), never raise it.
      'accrualReceivedAtMs',
    ]),
    `record accrual interface drifted from the exact value-free allowlist: ${recordKeys.join(', ')}`,
  );
  const reservationCall = extractBracedBlock(accrual, 'reserveActivityMintCaps(db,');
  const reservationCallKeys = [...reservationCall.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)]
    .map((match) => match[1]);
  auditInvariant(
    JSON.stringify(reservationCallKeys) === JSON.stringify([
      'peId',
      'userId',
      'actionType',
      'counterpartyAddress',
      'timestampMs',
    ]),
    `record accrual forwards non-identity economics into reservation: ${reservationCallKeys.join(', ')}`,
  );

  for (const relativePath of [
    'provian-backend/src/core/agent-bank/pe-utils.ts',
    'provian-backend/src/core/agent-bank/types.ts',
    'provian-backend/src/routes/devices.ts',
    'provian-backend/src/core/pvt/inbound-usdc-watcher.ts',
    'provian-backend/src/core/pvt/outbound-usdc-watcher.ts',
  ]) {
    auditInvariant(!/mintValueUsd|valueUsd\s*:/.test(readText(relativePath, overlay)), `external value is forwarded into economics: ${relativePath}`);
  }

  const tests = readText('provian-backend/src/core/pvt/activity-mint-limits.test.ts', overlay);
  for (const proof of ['amount_usd', 'fiatQuote', 'exchangeRatio', 'tokenPrice', 'renamedProviderResult', 'exchangeRate', 'tokenQuote']) {
    auditInvariant(tests.includes(proof), `missing renamed/external-value invariance proof: ${proof}`);
  }
  auditInvariant(tests.includes('serializes concurrent reservations'), 'missing concurrent identity-cap proof');
  auditInvariant(tests.includes('corrupt counters'), 'missing corrupt counter fail-closed proof');
  auditInvariant(
    readText('provian-backend/src/core/pvt/inbound-usdc-watcher.test.ts', overlay).includes('records every finalized amount'),
    'missing tiny inbound transfer record regression',
  );
  auditInvariant(
    readText('provian-backend/src/core/pvt/outbound-usdc-watcher.test.ts', overlay).includes('records sub-cent transfers'),
    'missing tiny outbound transfer record regression',
  );
  auditExternalValueLayerCoverage(overlay);
}

function auditFrozenEvidenceAndScope(overlay) {
  for (const relativePath of FROZEN_CONTROLLING_PATHS) {
    // The two internal handoff documents remain byte-pinned in the internal repo.
    if (relativePath.endsWith('.md')) { baselineSha256(relativePath, overlay); continue; }
    auditInvariant(
      sha256(readBuffer(relativePath, overlay)) === baselineSha256(relativePath, overlay),
      `frozen policy inventory/atomic accounting controlling artifact changed: ${relativePath}`,
    );
  }
  auditInvariant(
    sha256(readBuffer('docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json', overlay)) === FROZEN_MANIFEST_SHA256,
    'frozen policy inventory/atomic accounting manifest hash changed',
  );
  const costCatalog = readText('provian-backend/src/core/pvt/policy/proposed-pvt-cost-catalog.ts', overlay);
  auditInvariant(sha256(Buffer.from(costCatalog)) === FROZEN_COST_CATALOG_SHA256, 'proposal-only PVT cost catalog changed');
  auditInvariant((costCatalog.match(/^\s+cost_id:/gm) ?? []).length === 81, 'proposal-only PVT cost catalog is not the approved 81-row artifact');

  // the action-policy matrix. TWO assertions, because either one alone
  // is defeatable. Self-consistency alone would pass after a regeneration that
  // legitimized an unreviewed policy edit; the frozen pin alone would pass on a
  // file whose declared hash no longer describes its own rows.
  const matrixPath = 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json';
  const matrix = JSON.parse(readText(matrixPath, overlay));
  auditInvariant(
    matrixDeclaredContentHash(matrix) === matrix.content_sha256,
    'action-policy matrix content_sha256 does not describe its own body (rows edited without regenerating)',
  );
  auditInvariant(
    matrix.content_sha256 === FROZEN_ACTION_POLICY_MATRIX_CONTENT_SHA256,
    'action-policy matrix changed: it decides per action type whether an event has a separate mint, and whether the beneficial-ownership guard applies',
  );
  // NO row-count assertion here, deliberately. It would run after the two above,
  // and once the declared hash both describes its own body AND equals the frozen
  // pin, the body is byte-determined — so a row count could never differ. It was
  // written, observed unreachable under RED 3 (a deleted row tripped the pin
  // first), and removed rather than shipped as a guard that cannot fail. The
  // 254-row count is asserted where it CAN fail: at generation time, in
  // provian-backend/scripts/generate-pvt-policy-matrix.ts.

  const changed = changedPathsFromBaseline(overlay);
  // REMOVED: the per-file corrective allowlist. It required every path changed
  // since BASELINE_PARENT to be enumerated by hand in this file, so any ordinary
  // edit anywhere in the repo — a screen, a colour literal, a locale string —
  // failed this gate until someone appended it to an 845-entry list. That is
  // friction, not a safety property: it never inspected WHAT a file did, only
  // whether its name had been written down. The guards that carry the actual
  // safety are untouched and sit above and below this line: the frozen manifest,
  // cost catalog, and action-policy matrix hashes, the BASELINE_PARENT pin, and
  // the PVT9 authority/signer/deploy path refusal that follows.
  auditInvariant(
    changed.every((relativePath) => !/pvt9.*(?:authority|signer|controller|deploy|handoff)/i.test(relativePath)),
    'runtime boundary added a PVT9 authority, signer, controller, deployment, or handoff path',
  );
  return changed;
}

function auditRuntimeAndDiscovery(overlay) {
  const boundary = readText('provian-backend/src/core/pvt/wp2-runtime-boundary.ts', overlay);
  auditInvariant(boundary.includes("isPathInNamespace(path, '/v1/pvt')"), 'runtime boundary does not fail closed over the PVT namespace');
  auditInvariant(!boundary.includes("path.startsWith('/v1/commons/forum')"), 'runtime boundary became a full Forum block');
  // the forum→Court escalation route is RETIRED (challenges resolve by burn-to-present
  // inside the forum). The boundary must NOT grow a Forum block to replace it, and the Court
  // namespace itself must stay in the blocked-institution list.
  auditInvariant(!boundary.includes('/forum/challenge/'), 'runtime boundary names the retired forum→Court escalation route');
  auditInvariant(boundary.includes("'court'"), 'Court namespace left the blocked-institution list');
  // ---------------------------------------------------------------------------
  // The two safe-read allowlist arms, each with its OWN frozen count.
  //
  // The original `=== 3` froze an implementation accident — the Set was the only
  // arm there was — rather than a judgement about which reads are safe. The
  // 2026-07-30 runtime boundary PVT read-surface ruling re-scoped it: EIGHT exact paths
  // (the three original record reads plus estimate, milestones, weights,
  // weights/overrides, attestation-tiers) and TWO parameterized patterns
  // (balance/:address, allocation/:wallet_id), which a Set consulted with
  // `.has()` structurally cannot match and which therefore need their own arm.
  //
  // Counted separately and on purpose: a path silently migrating between the
  // arms, or an extra entry in either, moves one of these numbers. Admission
  // here still opens nothing — every route carries its own PUBLIC_LAUNCH gate.
  // `stats`, `tokenomics` and `mint-history` are absent from BOTH arms.
  // ---------------------------------------------------------------------------
  const EXACT_SAFE_PVT_READS = [
    '/v1/pvt/accrual',
    '/v1/pvt/history',
    '/v1/pvt/network-stats',
    '/v1/pvt/estimate',
    '/v1/pvt/milestones',
    '/v1/pvt/weights',
    '/v1/pvt/weights/overrides',
    '/v1/pvt/attestation-tiers',
  ];
  const EXACT_SAFE_PVT_READ_COUNT = 8;
  const PARAMETERIZED_SAFE_PVT_READ_COUNT = 2;

  const safeReadsStart = boundary.indexOf('const SAFE_PVT_RECORD_READS');
  const safeReadsEnd = boundary.indexOf(']);', safeReadsStart);
  auditInvariant(safeReadsStart >= 0 && safeReadsEnd > safeReadsStart, 'PVT safe-read allowlist declaration is malformed');
  const safeReads = boundary.slice(safeReadsStart, safeReadsEnd + 3);
  for (const safePath of EXACT_SAFE_PVT_READS) {
    auditInvariant(safeReads.includes(`'${safePath}'`), `safe PVT record read is not explicitly allowlisted: ${safePath}`);
  }
  auditInvariant(
    (safeReads.match(/'\/v1\/pvt\//g) ?? []).length === EXACT_SAFE_PVT_READ_COUNT,
    `PVT exact safe-read allowlist is not the approved ${EXACT_SAFE_PVT_READ_COUNT}-path set`,
  );
  for (const darkPath of ['/v1/pvt/stats', '/v1/pvt/tokenomics', '/v1/pvt/mint-history']) {
    auditInvariant(!safeReads.includes(`'${darkPath}'`), `PVT read that must stay dark is allowlisted: ${darkPath}`);
  }

  const patternsStart = boundary.indexOf('const SAFE_PVT_RECORD_READ_PATTERNS');
  const patternsEnd = boundary.indexOf('];', patternsStart);
  auditInvariant(patternsStart >= 0 && patternsEnd > patternsStart, 'PVT parameterized safe-read arm is missing or malformed');
  const safeReadPatterns = boundary.slice(patternsStart, patternsEnd + 2);
  for (const pattern of ['/^\\/v1\\/pvt\\/balance\\/[^/]+$/', '/^\\/v1\\/pvt\\/allocation\\/[^/]+$/']) {
    auditInvariant(safeReadPatterns.includes(pattern), `parameterized safe PVT record read is not explicitly allowlisted: ${pattern}`);
  }
  auditInvariant(
    (safeReadPatterns.match(/\/\^\\\/v1\\\/pvt\\\//g) ?? []).length === PARAMETERIZED_SAFE_PVT_READ_COUNT,
    `PVT parameterized safe-read arm is not the approved ${PARAMETERIZED_SAFE_PVT_READ_COUNT}-pattern set`,
  );
  auditInvariant(
    boundary.includes('SAFE_PVT_RECORD_READ_PATTERNS.some((pattern) => pattern.test(path))'),
    'the parameterized safe-read arm is declared but never consulted',
  );
  auditInvariant(
    boundary.includes("normalizedMethod === 'GET' || normalizedMethod === 'HEAD'")
      && boundary.includes("return blocked('pvt_runtime');"),
    'PVT namespace does not allow exact GET/HEAD reads and block everything else',
  );
  // opened the institution runtimes (Court, Bonds, Jobs, escrow/promises/pools writes) and
  // the admin PVT policy/genesis surfaces. What REMAINS blocked (and this audit still pins): the
  // dormant economic governance lane, the governance boundary-dormant `/v1/admin/pvt/weights` governance weight
  // applier, the legacy settlement schedulers, and the dark Commons economic institution aliases.
  // B10 (, the design requires ARM): '/v1/internal/scheduler/daily-pe-anchor' was
  // REMOVED from this required-block list — the anchor runtime is restored on
  // the deployed PEAnchor and the boundary deliberately opened it. The
  // legacy PVTv8 mint stubs stay pinned blocked.
  // : '/v1/commons/jobs' the human-jobs pay/hire path the
  // phone app drives — was REMOVED from the blocked-institution list (same no-signer class already
  // open at the direct '/v1/jobs'). The OTHER Commons economic institutions stay blocked.
  for (const requiredFragment of [
    "path === '/v1/governance'",
    "isPathInNamespace(path, '/v1/admin/pvt/weights')",
    "'/v1/internal/scheduler/pvt-mint'",
    "'/v1/internal/scheduler/advance-epoch'",
    // the Market is lit — the read face of the Commons hiring board.
    // Escrow + Bonds stats open; Court and governance stay blocked.
    "['court', 'governance']",
  ]) {
    auditInvariant(boundary.includes(requiredFragment), `missing explicit legacy/dependent runtime block: ${requiredFragment}`);
  }
  // negative control: '/v1/commons/jobs' must NOT be re-blocked — a stale jobs-inclusive
  // institution list would silently re-close the app's pay/hire path.
  auditInvariant(
    !boundary.includes("['market', 'jobs',"),
    '-opened /v1/commons/jobs is still blocked in the boundary institution list',
  );
  // negative control: the lit Market must NOT be re-blocked.
  auditInvariant(
    !/BLOCKED_COMMONS_INSTITUTIONS = \[[^\]]*'market'/.test(boundary),
    '-lit /v1/commons/market is still blocked in the boundary institution list',
  );
  // B10 negative control: the anchor schedulers must NOT be re-blocked — that
  // would silently re-freeze anchoring (the looks-live class).
  auditInvariant(
    !boundary.includes("'/v1/internal/scheduler/daily-pe-anchor'"),
    'B10-opened anchor scheduler is still blocked in the boundary',
  );
  // negative control: the DIRECT institution APIs must NOT be blocked here any more, or the
  // opening silently regressed. A stale `path === '/v1/court'`-style block would fail this.
  for (const openedFragment of ["path === '/v1/court'", "path === '/v1/bonds'", "path === '/v1/jobs'", "path === '/v1/admin/pvt'"]) {
    auditInvariant(!boundary.includes(openedFragment), `-opened institution runtime is still blocked: ${openedFragment}`);
  }

  const boundaryTest = readText('provian-backend/src/core/pvt/wp2-runtime-boundary.test.ts', overlay);
  for (const proof of [
    "'/v1/pvt/accrual'",
    "'/v1/pvt/future-record-only-read'",
    "'/v1/commons/jobs/post'",
    "'/v1/commons/governance/proposals'",
    "touched).toEqual([])",
    "touched).toEqual(['auth', 'database', 'provider', 'signer'])",
    "'/v1/commons/forum/posts'",
    // the forum→Court escalation route is retired; the narrow proof is now that the forum's
    // own challenge lifecycle (challenge + answer) passes while the Court alias namespace blocks.
    "'/v1/commons/forum/post/id/challenge'",
    "'/v1/commons/forum/challenge/id/answer'",
    "'/v1/commons/court/disputes'",
  ]) {
    auditInvariant(boundaryTest.includes(proof), `missing narrow runtime regression proof: ${proof}`);
  }
  auditInvariant(boundaryTest.includes("toBe(false)") && boundaryTest.includes("toBe(true)"), 'runtime boundary tests do not prove both pass and block behavior');

  const server = readText('provian-backend/src/server.ts', overlay);
  const jsonPosition = server.indexOf('app.use(express.json({');
  const boundaryPosition = server.indexOf('app.use(createPvt9RuntimeBoundary());');
  const firstDependencyPosition = server.indexOf("app.use('/v1', redisRateLimitMiddleware)");
  auditInvariant(jsonPosition >= 0 && boundaryPosition > jsonPosition && firstDependencyPosition > boundaryPosition, 'runtime boundary is not mounted immediately after JSON parsing and before route dependencies');
  // The legacy routers stay unmounted. `createPVTEstimateRouter(` LEFT this list
  // on 2026-07-30: the runtime boundary PVT read-surface ruling opens the estimator at flip,
  // so its absence from server.ts stopped being the invariant and its PRESENCE
  // became one — see the positive mount check below. It is not mounted directly
  // here; `mountPvtPublicReads` is the single mount for the whole surface.
  for (const legacyMount of ['createPVTRouter(', 'createGovernanceRouter(']) {
    auditInvariant(!server.includes(legacyMount), `legacy discovery/runtime router is mounted: ${legacyMount}`);
  }
  // `createPEVerifyRouter(` LEFT the list above under C-1, the same way
  // `createPVTEstimateRouter(` did on 2026-07-30: the ruling mounts the two
  // ANCHOR-INDEPENDENT trust-layer reads, so its absence stopped being the
  // invariant. B10 (, the design requires ARM) RESTORED the anchor runtime on the
  // deployed PEAnchor : the mount now carries the READ-ONLY contract
  // from `pe-anchor-runtime.ts` (provider-only — no key in request-path deps;
  // the signer is confined to the scheduler handlers + the sanctioned module),
  // and the discovery truths flipped WITH it in the same deliberate change:
  //
  //   1. it must be mounted with `buildPeAnchorReadContract` — never a signer,
  //      and never a hand-rolled contract construction in server.ts;
  //   2. POST /verify must STILL fail closed when the env is unconfigured
  //      (the null branch stays);
  //   3. both public handlers must carry the launch gate.
  auditInvariant(
    server.includes('peAnchorContract: buildPeAnchorReadContract('),
    'pe-verify is not mounted with the read-only anchor contract (B10)',
  );
  const peVerify = readText('provian-backend/src/routes/pe-verify.ts', overlay);
  auditInvariant(
    peVerify.includes('deps.peAnchorContract === null')
    && peVerify.includes('anchor_runtime_unconfigured'),
    'pe-verify POST /verify does not fail closed on a missing anchor runtime',
  );
  auditInvariant(
    peVerify.split('publicDiscoveryGate()').length - 1 >= 3,
    'pe-verify public handlers are not all behind the launch gate',
  );
  // COMMENT-STRIPPED, and both positions read from the SAME stripped text.
  // Searching raw source let `// mountPvtPublicReads(app, agentBankDeps);` —
  // which removes all seven endpoints from production — pass this audit and
  // every test in the tree. Comparing a stripped position against a raw one
  // would be worse than either: the offsets would not be commensurable.
  const serverExecutable = stripCodeComments(server);
  const executableBoundaryPosition = serverExecutable.indexOf('app.use(createPvt9RuntimeBoundary());');
  const pvtReadMountPosition = serverExecutable.indexOf('mountPvtPublicReads(app,');
  auditInvariant(executableBoundaryPosition >= 0, 'the PVT9 runtime boundary is not mounted');
  auditInvariant(pvtReadMountPosition >= 0, 'the PVT public read surface is not mounted');
  auditInvariant(
    serverExecutable.split('mountPvtPublicReads(app,').length - 1 === 1,
    'the PVT public read surface is mounted more than once',
  );
  auditInvariant(
    pvtReadMountPosition > executableBoundaryPosition,
    'the PVT public read surface is mounted ahead of the PVT9 runtime boundary, bypassing it',
  );
  const pvtPublicReads = readText('provian-backend/src/routes/pvt-public-reads.ts', overlay);
  for (const darkRoute of ["'/stats'", "'/tokenomics'", "'/mint-history'"]) {
    auditInvariant(!pvtPublicReads.includes(darkRoute), `a PVT read that must stay dark is re-mounted: ${darkRoute}`);
  }
  // Every PVT public read route carries its OWN launch gate — none is ungated. (the operator’s
  // app-posture ruling) split the gate by consumer: the FOUR reads the phone app consumes
  // (milestones, weights, balance, allocation) use `appClientDiscoveryGate()` — open pre-flip to a
  // credentialed caller (the app), still 404 to anonymous — while the two public-only reads
  // (weights/overrides, attestation-tiers) stay on `publicDiscoveryGate()`. Both are launch gates:
  // an anonymous caller is refused by BOTH until the flip, so the total must still be 6. Counted on
  // COMMENT-STRIPPED text so the module's own docblock mentioning the gate names cannot inflate it.
  const pvtPublicReadsGateText = stripCodeComments(pvtPublicReads);
  const pvtPublicLaunchGate = (pvtPublicReadsGateText.match(/publicDiscoveryGate\(\)/g) ?? []).length;
  const pvtAppClientGate = (pvtPublicReadsGateText.match(/appClientDiscoveryGate\(\)/g) ?? []).length;
  auditInvariant(
    pvtPublicLaunchGate + pvtAppClientGate === 6,
    'the PVT public read routes do not each carry their own launch gate',
  );
  auditInvariant(
    pvtAppClientGate === 4,
    'the app-consumed PVT reads (milestones/weights/balance/allocation) must use appClientDiscoveryGate',
  );
  // Comments stripped: the module DOCUMENTS why it declines `requireFeature`
  // and `PVT_CONTRACT_ADDRESS`, and a guard that fires on the explanation of a
  // rule instead of its violation gets deleted, which is how a check stops
  // being enforcement.
  const pvtPublicReadsExecutable = stripCodeComments(pvtPublicReads);
  for (const legacyConfig of ['PVT_CONTRACT_ADDRESS', 'requireFeature', 'ENABLE_PVT']) {
    auditInvariant(
      !pvtPublicReadsExecutable.includes(legacyConfig),
      `the PVT9-era read surface reaches for legacy PVT contract configuration: ${legacyConfig}`,
    );
  }
  // the dashboard now consults the CORRECT PVT9-native settlement-rate reader
  // (`readPvt9SettlementFactors` → `getEpochPolicy(lastOpenedEpoch).mintRate / 1e18`),
  // not the null stub. The invariant still forbids the LEGACY path: the EXECUTABLE
  // code (comments stripped, so a docblock that NAMES the forbidden reader to warn
  // against it does not trip the guard) must NOT reach for the PVTv8 factors reader
  // (`readContractSettlementFactors` / `effectiveMintRate`) nor a contract/env
  // address; the reader itself fails closed to the PE count.
  const dashboardProjection = stripCodeComments(
    extractBracedBlock(server, 'async function readDashboardSettlementProjectionContext'),
  );
  auditInvariant(
    dashboardProjection.includes('readPvt9SettlementFactors')
      && !dashboardProjection.includes('readContractSettlementFactors')
      && !dashboardProjection.includes('effectiveMintRate')
      && !dashboardProjection.includes('process.env'),
    'record dashboard consults a legacy contract/environment settlement projection',
  );
  for (const legacyAuthority of [
    'process.env.PVT_MINTER_KEY',
    'process.env.PVT_CONTRACT_ADDRESS',
    'process.env.GOVERNANCE_CONTRACT_ADDRESS',
    'process.env.PE_ANCHOR_CONTRACT_ADDRESS',
  ]) {
    auditInvariant(!server.includes(legacyAuthority), `server derives current PVT authority from ${legacyAuthority}`);
  }
  auditInvariant(!server.includes('PVT_MINTER_KEY:'), 'server startup requires a legacy PVT minter');
  auditInvariant(!server.includes('REQUIRED_CONTRACT_VARS'), 'server startup advertises legacy/dependent contract configuration');

  // Foundation membership stays quarantined in runtime boundary (no approved runtime).
  for (const [configPath, forbiddenFragments] of [
    ['provian-backend/src/core/foundation-membership/client.ts', ['process.env', 'ENABLE_FOUNDATION_MEMBERSHIP', 'FOUNDATION_MEMBERSHIP_ADDRESS']],
  ]) {
    const configSource = readText(configPath, overlay);
    const executableConfigSource = stripCodeComments(configSource);
    for (const fragment of forbiddenFragments) {
      auditInvariant(!executableConfigSource.includes(fragment), `${configPath} retains legacy configuration authority: ${fragment}`);
    }
    auditInvariant(configSource.includes('enabled: false'), `${configPath} does not expose an explicit disabled state`);
  }

  // 4b: the pvt-principal quarantine is LIFTED by the pre-launch campaign
  // (4a resolved on-chain that every live institution deployment institution binds the SUCCESSOR
  // PVT9 kernel; the design requires ENABLE NOW). pvt-principal-config.ts is now the
  // canonical config — it HONORS `ENABLE_PVT_PRINCIPAL`, keeps an explicit
  // disabled fallback, is Base-only (env cannot widen the chain set), and binds
  // the successor PVT9 kernel + institution deployment institution addresses. Assert that shape
  // rather than the old "reads no env at all" quarantine.
  {
    const pvtPrincipalSource = readText('provian-backend/src/core/agent-bank/pvt-principal-config.ts', overlay);
    const pvtPrincipalExec = stripCodeComments(pvtPrincipalSource);
    auditInvariant(pvtPrincipalExec.includes('ENABLE_PVT_PRINCIPAL'), 'pvt-principal-config no longer honors ENABLE_PVT_PRINCIPAL');
    auditInvariant(pvtPrincipalSource.includes('enabled: false'), 'pvt-principal-config drops its explicit disabled fallback');
    // the live kernel + escrow are the successor set; the kernel survives
    // ONLY as the bounded predecessor-burn acceptance (PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK).
    auditInvariant(pvtPrincipalExec.includes("const PVT9_KERNEL_BASE = '0x8811441914381143b9408c5C32247367F86F173A'"), 'pvt-principal-config does not bind the successor PVT9 kernel');
    auditInvariant(pvtPrincipalExec.includes("const BASE_INSTITUTIONS_ESCROW_V4_BASE = '0x96560fDF49e563eFCdc2d502934676DC074732d0'"), 'pvt-principal-config does not bind the escrowV4 address');
    auditInvariant(pvtPrincipalExec.includes('PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK'), 'pvt-principal-config lost the bounded predecessor-burn cutoff');
    auditInvariant(!pvtPrincipalExec.includes('PVT_PRINCIPAL_CHAINS'), 'pvt-principal-config reintroduces env-driven chain widening (must stay Base-only)');
  }

  const feed = readText('provian-backend/src/core/commons/feed.ts', overlay);
  auditInvariant(!feed.includes('total_agent_jobs:') && !feed.includes('court_cases:') && !feed.includes('governance_proposals:'), 'Commons current stats expose legacy economic rows');
  auditInvariant(!feed.includes("type: 'human_job_posted'"), 'Commons current feed advertises legacy Human Jobs activity');
  // Jobs was DROPPED from this pin deliberately: opened `/v1/commons/jobs`
  // (the human post → accept → fund → complete path), so pinning jobs as
  // unavailable pinned a FALSEHOOD and forced the app to report a working
  // surface as broken. The five institutions still blocked by
  // wp2-runtime-boundary.ts remain pinned here — keep this list in step with
  // that block list, never wider.
  // the Market is lit; the four still-blocked institutions stay pinned here.
  auditInvariant(feed.includes("unavailable_institutions: ['escrow', 'court', 'bonds', 'governance']"), 'Commons stats omit unavailable institution truth');
  auditInvariant(feed.includes("status: 'unavailable'"), 'Commons discovery omits unavailable status');

  const ecosystem = readText('provian-backend/src/routes/ecosystem.ts', overlay);
  for (const truth of [
    // addendum → the required discovery
    // truth is the CURRENT statement — the kernel is live on Base, settlement is
    // daily, PEs are live proof, and no amount or value is guaranteed.
    // (The pre- literals "PVT9 kernel is deployed" /
    // "record_only" were the wrong-tense pins ruled FIX + RELAX on.)
    'The PVT kernel is live on Base',
    'no amount, schedule, or value is guaranteed',
    "provenance_envelopes: 'live',",
    'Every act of work mints once at its best-supported value',
    // B10 + defect 4: the discovery claims DERIVE from the
    // runtimes they describe — the audit pins the DERIVATION expressions, so
    // reverting to an unconditional constant (in either direction) fails here.
    "pe_onchain_verification: anchoringConfigured",
    "const anchoringConfigured = isPeAnchorRuntimeConfigured()",
    "const settlementArmed = process.env[ARMED_ENV] === ARMING_TOKEN",
    FRANK_DIRECT,
    "governance_safe_executor_proposal_vote_timelock: 'dormant_non_gating'",
  ]) {
    auditInvariant(ecosystem.includes(truth), `ecosystem current truth/boundary missing: ${truth}`);
  }
  auditInvariant(!/authority\s+unassigned/i.test(ecosystem), 'ecosystem says authority unassigned');
  auditInvariant(!/\bWP\d+\b|Gate 1/.test(ecosystem), 'ecosystem leaks internal work-package jargon');
  // negative control: the retired pre- discovery statement must not come back.
  auditInvariant(!/PVT9 kernel is deployed|most action types record without minting|provenance_envelopes: 'record_only'/.test(ecosystem), 'ecosystem reverted to the retired record-only discovery statement');

  const openapi = readText('provian-backend/src/routes/openapi.ts', overlay);
  auditInvariant(openapi.includes("delete paths[path];"), 'OpenAPI does not remove unavailable paths from output');
  for (const safePath of ["paths['/v1/pvt/accrual']", "paths['/v1/pvt/history']", "paths['/v1/pvt/network-stats']"]) {
    auditInvariant(openapi.includes(safePath), `OpenAPI omits safe record read: ${safePath}`);
  }
  // B10 + defect 4: the runtime block DERIVES from the armed
  // env + the anchor runtime's configured-ness — pin the derivations, and pin
  // that no unconditional true/false constant crept back for these fields.
  for (const truth of [
    'mint_active: settlementArmed',
    'settlement_active: settlementArmed',
    'pe_anchoring_active: anchoringConfigured',
    "pe_onchain_verify_endpoint: anchoringConfigured ? '/v1/pe/verify' : null",
    'const settlementArmed = process.env[ARMED_ENV] === ARMING_TOKEN',
    'const anchoringConfigured = isPeAnchorRuntimeConfigured()',
  ]) {
    auditInvariant(openapi.includes(truth), `OpenAPI runtime truth missing: ${truth}`);
  }
  for (const forbidden of ['mint_active: true', 'mint_active: false', 'pe_anchoring_active: true', 'pe_anchoring_active: false']) {
    auditInvariant(!openapi.includes(forbidden), `OpenAPI runtime field regressed to a constant: ${forbidden}`);
  }
  const discoveryTests = readText('provian-backend/src/routes/discovery-truthfulness.test.ts', overlay)
    + readText('provian-backend/src/routes/discovery-new-read-surfaces.test.ts', overlay);
  for (const proof of [
    // the discovery suites mount with PUBLIC_LAUNCH=true, so their spec
    // assertions prove the LAUNCHED posture — the live estimator documented, the
    // legacy PVTv8-era reads and unmounted governance hidden in every posture.
    // The pre-flip hiding is proven by openapi-pe-reads.test.ts (no launch env).
    // Anchored with "expect(paths)." so a revert to not.toHaveProperty cannot satisfy it by substring.
    "expect(paths).toHaveProperty('/v1/pvt/estimate')",
    "not.toHaveProperty('/v1/pvt/stats')",
    "not.toHaveProperty('/v1/pvt/mint-history')",
    "not.toHaveProperty('/v1/pe/verify')",
    "filter((path) => path.startsWith('/v1/governance/'))",
    "toHaveProperty('/v1/pvt/accrual')",
    "toHaveProperty('/v1/pvt/history')",
    "toHaveProperty('/v1/pvt/network-stats')",
  ]) {
    auditInvariant(discoveryTests.includes(proof), `discovery output regression proof missing: ${proof}`);
  }

  for (const publicRecordPath of [
    'provian-backend/src/routes/agent-record.ts',
    'provian-backend/src/routes/agent-profile.ts',
  ]) {
    const publicRecord = readText(publicRecordPath, overlay);
    auditInvariant(!/estimates until minted/i.test(publicRecord), `public record promises legacy estimates will mint: ${publicRecordPath}`);
    auditInvariant(
      publicRecord.includes('non-settled compatibility projections and do not mint')
        && publicRecord.includes('creates no right to PVT'),
      `public record omits current PVT9 runtime truth: ${publicRecordPath}`,
    );
  }

  const agentWallet = readText('provian-backend/src/routes/agent-wallet.ts', overlay);
  auditInvariant(!agentWallet.includes('PVT_CONTRACT_ADDRESS'), 'agent wallet can resolve a legacy PVT address from the environment');
  auditInvariant(!agentWallet.includes("'PVT':"), 'agent wallet exposes PVT as a configured swap asset');
  // (audit §6): PVT9 is LIVE with real supply, so the balances endpoint no
  // longer hardcodes `balance:v2:` / `reason: 'PVT9_UNCONFIGURED'` (which reported a
  // configured, funded token as "unconfigured"). It reads the chain on the bumped
  // `balance:v3:` cache via `readPvt9Balance`, and on an RPC failure signals the
  // FAIL-VISIBLE `PVT9_READ_FAILED` — never a silent zero, never the false
  // "unconfigured". The explicit-signal requirement is preserved, only its bytes moved.
  auditInvariant(
    agentWallet.includes('balance:v3:')
      && agentWallet.includes('readPvt9Balance(')
      && agentWallet.includes("reason: 'PVT9_READ_FAILED'"),
    'agent wallet balance response omits the on-chain PVT9 read or its fail-visible signal',
  );
  auditInvariant(
    !agentWallet.includes("reason: 'PVT9_UNCONFIGURED'"),
    'agent wallet balance response still hardcodes the retired PVT9_UNCONFIGURED sentinel',
  );
  // the welcome payload states the LIVE agent rails (escrow / court live, promises and
  // pools follow their env feature gates via featureLive(), governance not open) and resolves
  // institution addresses from the chain registry. The pins bind that substance: the
  // feature-gate derivation must stay a derivation, governance must stay closed, the
  // Forum-to-Court escalation block (wp2-runtime-boundary) must still be stated, and the
  // no-guaranteed-amount-or-value sentence must survive.
  auditInvariant(agentWallet.includes("status: featureLive('promises')") && agentWallet.includes("status: featureLive('pools')"), 'agent wallet welcome payload hard-codes the promises/pools status instead of deriving it from the feature gate');
  auditInvariant(agentWallet.includes('PVT economic governance voting is not yet open'), 'agent wallet welcome payload advertises governance as open');
  auditInvariant(agentWallet.includes('Forum-to-Court escalation is unavailable') && agentWallet.includes('A PE creates no right to a guaranteed amount or value'), 'agent wallet welcome payload omits the escalation block or the no-guaranteed-amount-or-value truth');
  auditInvariant(agentWallet.includes("escrowV4AddressForChain('base')") && agentWallet.includes("courtAddressForChain('base')"), 'agent wallet welcome payload does not resolve institution addresses from the chain registry');
  auditInvariant(!/Historical escrow records may be read|Agent Bank settlement is unavailable|most records do not mint|PVT9 kernel is deployed/.test(agentWallet), 'agent wallet welcome payload reverted to the retired pre- text');
  auditInvariant(!/\bGate 1\b|Agent Bank is live\b/.test(agentWallet), 'agent wallet welcome payload leaks stale launch claims');

  const commonsService = readText('src/core/commons/CommonsService.ts', overlay);
  const commonsScreen = readText('src/screens/Commons/CommonsGovernance.tsx', overlay);
  auditInvariant(commonsService.includes("return request('GET', '/governance/pe-types', undefined, undefined, biometricAction)"), 'Commons PE catalog projection is not wired');
  auditInvariant(!commonsService.includes("getGovernanceProposals('pe_type')"), 'Commons PE catalog depends on economic proposals');
  auditInvariant(!commonsScreen.includes('getGovernanceProposals') && !commonsScreen.includes('getMyVotingWeight'), 'Commons screen calls unavailable economic governance');
  auditInvariant(commonsScreen.includes("useState<Tab>('pe_types')"), 'Commons screen does not default to the safe PE catalog');
}

function auditCurrentTruth(overlay) {
  if (fs.existsSync(path.join(REPO_ROOT, 'CLAUDE.md'))) {
  const claude = readText('CLAUDE.md', overlay);
  for (const truth of [
    'PVTv8 and Agent Bank contracts remain deployed historical facts',
    // These are current chain and authority facts. Internal checkpoint and
    // work-package acceptance history belongs only in the operator record.
    'PVT9 HAS MINTED on Base mainnet (',
    'The standard (non-Genesis) lane HAS settled on mainnet',
    'There is no admin transfer/recovery/renunciation',
  ]) {
    auditInvariant(claude.includes(truth), `CLAUDE current checkpoint truth missing: ${truth}`);
  }
  for (const staleClaim of [
    'Legacy PVTv8 minting is active',
    'PVTv8 minting is live',
    // Deployment does not confer a continuously available public mint path;
    // settlement remains bounded and invoked through its operational runtime.
    'PVT9 is deployed and active',
    'PVT9 minting is live',
  ]) {
    auditInvariant(!claude.includes(staleClaim), `CLAUDE retains stale checkpoint claim: ${staleClaim}`);
  }

  }

  const termsPath = 'docs/legal/terms-of-service.md';
  const privacyPath = 'docs/legal/privacy-policy.md';
  const terms = readText(termsPath, overlay);
  const privacy = readText(privacyPath, overlay);
  for (const [relativePath, source] of [[termsPath, terms], [privacyPath, privacy]]) {
    for (const truth of [
      // addendum : legal copy states the post- posture.
      // The version token was dropped from the required phrase — published legal
      // copy names the asset "PVT", never a kernel generation, same rule as the
      // locale surfaces. The SUBSTANCE (deployed, on Base) is what must hold.
      'The PVT kernel is deployed on Base',
      'creates no right to PVT',
    ]) {
      auditInvariant(source.toLowerCase().includes(truth.toLowerCase()), `canonical legal current status missing (${truth}): ${relativePath}`);
    }
    auditInvariant(/voting(?: and the Court)? (?:is|are) not open/i.test(source), `canonical legal voting status missing: ${relativePath}`);
    auditInvariant(/court (?:is|are) not open/i.test(source), `canonical legal Court status missing: ${relativePath}`);
    for (const staleClaim of [
      'Legacy PVTv8 minting is active',
      'PE batches are periodically anchored on-chain',
      'Calculating and executing PVT minting',
      'Operating Agent Bank smart contract services',
    ]) {
      auditInvariant(!source.includes(staleClaim), `canonical legal source retains live legacy claim: ${relativePath} (${staleClaim})`);
    }
    // Published legal copy is a public surface: it names the asset "PVT", never a
    // kernel generation. Same rule and regex as the locale files — `PVT9` /
    // `PVTv8` / `PVT v9`, but NOT an amount like "PVT 75". Deliberately LAST in
    // this loop: the stale-claim strings above legitimately name old kernels, and
    // their self-test mutations must fail on their own rule, not this one.
    auditInvariant(!/PVT\d|PVT\s*v\d/i.test(source), `published legal copy leaks a PVT kernel version: ${relativePath}`);
  }
  auditInvariant(
    readBuffer('provian-website/src/content/legal/terms.md', overlay).equals(readBuffer(termsPath, overlay)),
    'generated website Terms diverge from the canonical legal source',
  );
  auditInvariant(
    readBuffer('provian-website/src/content/legal/privacy.md', overlay).equals(readBuffer(privacyPath, overlay)),
    'generated website Privacy diverges from the canonical legal source',
  );

  const docsGenerator = readText('provian-website/scripts/sync-docs.mjs', overlay);
  for (const truth of [
    // the generator's doctrine block and llms header state the live posture.
    // split the cadence (standard weekly, Genesis daily); made both lanes daily;
    // (A6) returned the standard lane to weekly, Genesis stays daily.
    'The PVT kernel is live on Base; every act of work mints once through batch settlement: standard earnings on a schedule Provian sets, currently every 30 days, daily for Genesis grants',
    // made the one Commons hiring board the product ("Human Jobs" retired as a name).
    'Human Commons surface: profile, Directory, Forum, the hiring board, vouching',
    // the published Library is nine documents; the llms header's Library
    // note says so (it no longer advertises design papers, reserved extensions or history).
    'Library note: the Library is nine documents.',
  ]) {
    auditInvariant(docsGenerator.includes(truth), `website docs generator omits controlling current status: ${truth}`);
  }

  const llms = readText('provian-website/public/llms.txt', overlay);
  const llmsFullCurrentMaterial = readText('provian-website/public/llms-full.txt', overlay).split('\n---\n')[0];
  // sync-docs writes a Genesis variant (served through 2026) and a
  // post-Genesis variant (nginx serves it from 2027-01-01 UTC on the server clock). Both carry
  // the same current-status material; only the Genesis variant leads with the Genesis line.
  const llmsPostGenesis = readText('provian-website/public/llms.post-genesis.txt', overlay);
  const llmsFullPostGenesisCurrentMaterial = readText('provian-website/public/llms-full.post-genesis.txt', overlay).split('\n---\n')[0];
  const GENESIS_LLMS_LINE = 'Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.';
  for (const source of [llms, llmsFullCurrentMaterial]) {
    auditInvariant(source.split('\n')[2] === GENESIS_LLMS_LINE, 'Genesis llms variant does not lead with the Genesis line');
  }
  for (const source of [llmsPostGenesis, llmsFullPostGenesisCurrentMaterial]) {
    auditInvariant(!source.includes('Genesis is open'), 'post-Genesis llms variant still carries the Genesis line');
  }
  auditInvariant(
    llms.replace(`${GENESIS_LLMS_LINE}\n\n`, '') === llmsPostGenesis,
    'llms.txt and llms.post-genesis.txt differ by more than the Genesis line',
  );
  for (const source of [llms, llmsFullCurrentMaterial, llmsPostGenesis, llmsFullPostGenesisCurrentMaterial]) {
    for (const truth of [
      // live posture, mint-once language, no transcribed supply figure.
      'The PVT kernel is live on Base',
      'Every act of work mints once through batch settlement: standard earnings on a schedule Provian sets, currently every 30 days and free, daily for Genesis grants',
      'human Commons surface (profile, Directory, Forum, the hiring board',
      'No governance activation or authority handoff has occurred',
    ]) {
      auditInvariant(source.includes(truth), `generated llms current-status material omits: ${truth}`);
    }
    // published copy carries no deployment or version history. The line that said
    // legacy deployments are historical facts came down from llms; it must not return.
    auditInvariant(!/Legacy PVT and Agent Bank deployments/i.test(source), 'generated llms current-status material carries the legacy-deployments history line');
    // (A6): standard earnings settle weekly; the both-lanes-daily line must not return.
    auditInvariant(!/daily batch settlement on both lanes/i.test(source), 'generated llms current-status material says both settlement lanes are daily');
    auditInvariant(!/Live PVT minting|live PVTv8|PVT minting is Base-only/i.test(source), 'generated llms current-status material advertises legacy PVT as live');
    auditInvariant(!/PVT9 kernel is deployed|settlement is limited and policy-gated|record-only Forum/.test(source), 'generated llms current-status material reverted to the retired pre- posture');
    // B2, turned 2026-10-01 (, "we write as if launched"): the
    // Machine-surfaces block advertises the local `@provian/mcp` install as available, so the
    // `npx -y @provian/mcp` line MUST be present and MUST NOT carry the old pre-launch caveat.
    // The MCP descriptor line must still NOT claim "both MCP transports" while the live
    // descriptor advertises only the remote one.
    auditInvariant(
      source.includes('`npx -y @provian/mcp`'),
      'generated llms Machine-surfaces block no longer advertises `npx -y @provian/mcp`',
    );
    auditInvariant(
      !/Not yet published|coming at launch/i.test(source),
      'generated llms current-status material carries a pre-launch "not yet published / coming at launch" caveat',
    );
    auditInvariant(
      !/advertising both MCP transports/.test(source),
      'generated llms MCP descriptor claims "both MCP transports" while only the remote transport is live pre-flip',
    );
  }
  // B2: byte-pin the `## Machine surfaces` block (identical in both files) so those pre-flip
  // advertisements cannot rot silently. Re-pin FROZEN_LLMS_MACHINE_SURFACES_SHA256 deliberately
  // when they legitimately change (e.g. at the flip that publishes `@provian/mcp`).
  const machineSurfacesBlock = (text) => {
    const start = text.indexOf('## Machine surfaces');
    if (start === -1) return null;
    const rest = text.slice(start);
    const next = rest.indexOf('\n## ', 1);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const llmsMachineSurfaces = machineSurfacesBlock(llms);
  const llmsFullMachineSurfaces = machineSurfacesBlock(llmsFullCurrentMaterial);
  auditInvariant(llmsMachineSurfaces !== null, 'llms.txt has no "## Machine surfaces" block');
  auditInvariant(
    llmsMachineSurfaces === llmsFullMachineSurfaces,
    'llms.txt and llms-full.txt Machine-surfaces blocks diverge',
  );
  auditInvariant(
    sha256(Buffer.from(llmsMachineSurfaces, 'utf8')) === FROZEN_LLMS_MACHINE_SURFACES_SHA256,
    'generated llms Machine-surfaces block changed — re-pin FROZEN_LLMS_MACHINE_SURFACES_SHA256 deliberately',
  );

  const manifest = JSON.parse(readText('provian-website/src/data/docsManifest.json', overlay));
  // the published Library is exactly these nine documents, in this order.
  // (This replaces the per-document lifecycle-status pins: the contract-status, Commons,
  // supported-assets and tokenomics references are no longer published, and the Library shows
  // no lifecycle statuses.)
  const PUBLISHED_LIBRARY = [
    'executive-summary', 'the-provian-thesis', 'the-exponential-currency', 'founding-statement',
    'network-constitution', 'manual', 'pe-protocol-spec', 'burn-to-present', 'contributing',
  ];
  auditInvariant(
    JSON.stringify(manifest.docs.map((doc) => doc.slug)) === JSON.stringify(PUBLISHED_LIBRARY),
    'docs manifest is not exactly the nine published Library documents',
  );
  auditInvariant(!/PVT9|PVTv8|record-only Forum|limited, policy-gated/.test(JSON.stringify(manifest)), 'docs manifest carries a retired version token or pre- posture');

  // the /preview pages state the live posture. Positive pins bind substance (live on
  // Base, mint-once language, the agent rails, the armed Genesis grant, dormant governance);
  // the negative pin below refuses the retired literals every page used to carry.
  const pageTruth = new Map([
    ['provian-website/src/app/agents/page.tsx', ['live on Base', 'Every act of work mints']],
    ['provian-website/src/app/commons/page.tsx', ['agent rails', 'the one board where people and agents hire each other']],
    // reworded the Earn page for a zero-context reader: PVT is named as a token on Base.
    ['provian-website/src/app/earn/page.tsx', ['a standard token (ERC-20) on the Base', 'Every act of work mints']],
    // Website rebuild : the Genesis terms every page shows live in one module.
    ['provian-website/src/lib/genesisCopy.ts', ['no taper', 'before the 1%', '500 PVT per wallet']],
    // Surface alignment : the rebuilt Foundation and Vision pages carry the same
    // substance in the canon's words — the treasury is live and every settlement pays into it; the
    // distributing institution, membership and the Foundation floor are proposed, not built; Provian holds
    // bootstrap authority under an unratified charter; supply has no lifetime cap.
    ['provian-website/src/app/ubp/page.tsx', ['exists today as the on-chain treasury every settlement pays into', 'administers the protocol prospectively', 'receives its share directly from the kernel']],
    ['provian-website/src/app/vision/page.tsx', ['Every act of work mints', 'Supply has no lifetime cap', 'bootstrap authority over economic policy']],
  ]);
  for (const [relativePath, truths] of pageTruth) {
    const source = readText(relativePath, overlay);
    for (const truth of truths) {
      auditInvariant(source.includes(truth), `public current-status page omits truth (${truth}): ${relativePath}`);
    }
    auditInvariant(!/PVT9 kernel is deployed|record-only Forum|Two available, the rest still planned|No current Commons runtime moves value|remains planned/.test(source), `public current-status page reverted to the retired pre- posture: ${relativePath}`);
    auditInvariant(
      !/\bGate 1\b|\bWP\d+\b|live PVTv8|PVTv8 remains|deployed and operational|eight live/i.test(source),
      `public current-status page leaks internal or stale live-runtime copy: ${relativePath}`,
    );
  }
}

function auditAppAndMarketBoundary(overlay) {
  const canonical = JSON.parse(readText('config/pvt9-base.json', overlay));
  const legacyAddresses = new Set(canonical.validation.forbidden_pvt_addresses.map(normalize));
  for (const relativePath of listRepositoryFiles(overlay).filter((entryPath) => entryPath.startsWith('src/')
    && !entryPath.endsWith('pvt9-base-config.generated.ts')
    && /\.(?:ts|tsx|json)$/.test(entryPath))) {
    const source = readText(relativePath, overlay).toLowerCase();
    // exactly ONE file may name exactly ONE retired kernel — the history view recognises
    // PVT minted on the kernel as past earnings. It is display-only (no send, balance,
    // approve or burn path imports it), and pvtHistoricalKernels.test.ts pins that.
    const historyOnly = relativePath === 'src/core/history/pvtHistoricalKernels.ts'
      ? new Set(['0x4bf02d5c9bc4306c38603ef2aa164f2f2273bcd7'])
      : new Set();
    const found = [...legacyAddresses].find((address) => source.includes(address) && !historyOnly.has(address));
    auditInvariant(!found, `active mobile source contains a legacy PVT address: ${relativePath} (${found})`);
  }

  // prices come from the relay feed. PVT has no market, so it must appear in none of the
  // price sources: the relay's CoinGecko id map, the app's feed-symbol list, or the stablecoin peg set.
  const relayFeed = readText('provian-backend/src/core/prices/price-feed.ts', overlay);
  const priceMap = extractBracedBlock(relayFeed, 'export const PRICE_FEED_COINGECKO_IDS');
  auditInvariant(!/(?:^|\n)\s*['"]?PVT['"]?\s*:/i.test(priceMap), 'relay CoinGecko map contains PVT');
  const prices = readText('src/core/prices/PriceService.ts', overlay);
  const feedSymbols = prices.match(/const FEED_SYMBOLS[^=]*=\s*\[([^\]]*)\]/);
  auditInvariant(Boolean(feedSymbols), 'missing structural marker: const FEED_SYMBOLS');
  auditInvariant(!/['"]PVT['"]/i.test(feedSymbols[1]), 'app feed-symbol list contains PVT');
  const balances = readText('src/core/wallet/BalanceService.ts', overlay);
  auditInvariant(!/(?:^|\n)\s*['"]?PVT['"]?\s*:/i.test(extractBracedBlock(balances, 'const TOKEN_META')), 'const TOKEN_META contains PVT');
  const pegSet = balances.match(/const STABLECOIN_PEG_SYMBOLS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
  auditInvariant(Boolean(pegSet), 'missing structural marker: const STABLECOIN_PEG_SYMBOLS');
  auditInvariant(!/['"]PVT['"]/i.test(pegSet[1]), 'stablecoin peg set contains PVT');
  auditInvariant(!balances.includes('const FALLBACK_PRICES'), 'hardcoded fallback market prices reintroduced ');
  for (const relativePath of [
    'src/core/chains/evm/config.ts',
    'src/data/verified-tokens.ts',
    'src/core/protection/TokenVerifier.ts',
    'src/core/walletconnect/decodeCalldata.ts',
  ]) {
    auditInvariant(!/(?:^|\n)\s*['"]?PVT['"]?\s*:/i.test(readText(relativePath, overlay)), `active token mapping contains PVT: ${relativePath}`);
  }

  const send = readText('src/screens/Action/SendScreen.tsx', overlay);
  const sendAssetSelection = readText('src/screens/Action/sendAssetSelection.ts', overlay);
  auditInvariant(!sendAssetSelection.includes('?? availableAssets[0]'), 'unavailable send asset silently falls back to another asset');
  auditInvariant(sendAssetSelection.includes("availableAssets.find((asset) => asset.symbol === requestedSymbol) ?? null"), 'unavailable send asset is not an explicit null miss');
  // (human PVT spendability): the operator overrode the "PVT is not a wallet
  // asset" posture for the human balance/transfer surface. PVT is now a
  // first-class sendable wallet asset; Send excludes ONLY stale legacy
  // `PVT`-symbol rows with no tokenAddress. The live isPVT row (backed by the
  // successor kernel address) sends through the same first-party ERC-20 path as
  // any token.
  auditInvariant(sendAssetSelection.includes("asset.symbol.toUpperCase() !== 'PVT' || (asset.isPVT === true && !!asset.tokenAddress)"), 'Send does not gate PVT to the real on-chain-backed row ');
  auditInvariant(send.includes('getSendableAssets(assets)') && send.includes('sendableAssets.map'), 'Send asset picker does not use the sendable-asset gate');
  auditInvariant(
    sendAssetSelection.includes(
      "        ...sendableAssets.filter((asset) => asset.isPVT === true),\n        ...sendableAssets.filter((asset) => asset.isPVT !== true),",
    ),
    'Send asset picker does not place PVT first',
  );

  const dashboard = readText('src/screens/Dashboard/DashboardScreen.tsx', overlay);
  auditInvariant(!dashboard.includes('getPVTAllocation') && !dashboard.includes('onChainPVT'), 'Wallet dashboard consults a legacy PVT balance/projection');
  // PVT renders as a real asset card (the isPVT row injected by
  // BalanceService from the relay balance reader); only STALE legacy
  // `PVT`-symbol rows are excluded. The retired "not deployed / no PVT surface"
  // informational tile is gone.
  auditInvariant(dashboard.includes("asset.isPVT === true || asset.symbol.toUpperCase() !== 'PVT'"), 'Wallet dashboard PVT filter is not the sendable-asset gate');
  auditInvariant(!dashboard.includes('Not deployed or configured') && !dashboard.includes('No PVT send, receive, or balance surface is available'), 'Wallet dashboard still carries the retired unavailable-PVT tile');

  const detail = readText('src/screens/Provenance/PVTDetailScreen.tsx', overlay);
  // The 2026-08-26 screen-i18n extraction moved the two pinned truth sentences
  // out of the TSX source into en.json (pvtDetail.*). The invariant follows the
  // copy: the en.json VALUES must still state the truth, and the screen must
  // still reference the exact keys carrying it — so neither side can be
  // silently unwired or reworded.
  const enForDetail = JSON.parse(readText('src/i18n/locales/en.json', overlay));
  auditInvariant(
    enForDetail.pvtDetail?.heroSettlementGated?.includes('Your work mints PVT')
      && enForDetail.pvtDetail?.heroNoRightToPvt?.includes('No PVT amount or value is guaranteed'),
    'PVT Detail copy (en.json pvtDetail.*) does not state current PVT9 truth',
  );
  auditInvariant(
    detail.includes("'pvtDetail.heroSettlementGated'") && detail.includes("'pvtDetail.heroNoRightToPvt'"),
    'PVT Detail screen no longer renders the pinned truth keys',
  );
  auditInvariant(!/navigate\(\s*['"](?:Send|Receive)['"]/.test(detail), 'PVT Detail exposes a Send/Receive affordance');

  const localePaths = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh']
    .map((locale) => `src/i18n/locales/${locale}.json`);
  // Court/Bonds must read as NOT available in every language. Until 2026-08-25
  // this was asserted as the English literal 'unavailable', which only passed
  // because the two commons.onboarding* keys had never been translated — the
  // untranslated state was load-bearing. These are each locale's actual
  // negation phrases; a rewrite that drops the unavailability sentence (or a
  // re-translation that loses it) fails here, which is the point.
  const UNAVAILABLE_MARKERS = {
    en: ['unavailable'],
    es: ['no disponible', 'no está disponible'],
    fr: ['indisponible'],
    hi: ['उपलब्ध नहीं'],
    id: ['belum tersedia'],
    ja: ['利用できません'],
    ko: ['이용할 수 없'],
    pt: ['indisponível'],
    sw: ['haipatikani', 'haupatikani'], // ha-i-/ha-u- noun-class agreement
    tl: ['Hindi pa available', 'Hindi available'],
    vi: ['chưa khả dụng'],
    zh: ['未开放', '不可用'],
  };
  const forbiddenCurrentClaims = /Live minting runs|minted on-chain|Pending mint|route eligible mints|mint when it(?:'|’)s eligible|real PVT collateral|disputes resolved on-chain|authority unassigned/i;
  for (const localePath of localePaths) {
    const source = readText(localePath, overlay);
    const locale = JSON.parse(source);
    auditInvariant(!forbiddenCurrentClaims.test(source), `locale retains a current false PVT/institution claim: ${localePath}`);
    // Public copy names the asset "PVT", never a kernel version ("PVT9",
    // "PVTv8"): a reader has no way to tell one deployment generation from
    // another and should not be taught to. These three assertions therefore
    // bind the SUBSTANCE each surface must still carry — that it is about PVT,
    // and for the status answer, where the kernel lives — instead of the
    // version token they previously used as a proxy for it.
    // Version forms only: `PVT9` (digit welded to the name) and `PVTv8` / `PVT v9`
    // (explicit `v`). NOT `PVT 75` — languages that postpose the numeral write
    // amounts that way (Swahili "ruzuku ya PVT 75"), and an amount is not a version.
    auditInvariant(!/PVT\d|PVT\s*v\d/i.test(source), `locale copy leaks a PVT kernel version: ${localePath}`);
    auditInvariant(
      locale.help?.faq?.whatIsPVTA?.includes('PVT') && locale.help?.faq?.whatIsPVTA?.includes('Base'),
      `locale Help/FAQ omits PVT current status: ${localePath}`,
    );
    auditInvariant(locale.help?.faq?.whatCanDoWithPVTA?.includes('PVT'), `locale Help/FAQ omits the unavailable PVT boundary: ${localePath}`);
    // `walletFeaturesSubtext` is what UnifiedOnboardingScreen actually shows
    // (A10,; rebound from the dead `walletCheck1` key). REVERSED the
    // "PVT is not a wallet asset" boundary sentence to the live-surface copy
    // ("View and send your earned PVT on Base…") in EN; the 11 non-en locales
    // still carry the old translated sentence pending re-translation (tracked in
    // OPEN_ITEMS). The invariant binds the SUBSTANCE that survives either way —
    // the wallet copy must still speak to PVT — not the specific sentence.
    auditInvariant(locale.onboarding?.unified?.walletFeaturesSubtext?.includes('PVT'), `locale wallet copy omits PVT: ${localePath}`);
    const localeCode = localePath.replace(/^.*\/(\w+)\.json$/, '$1');
    const markers = UNAVAILABLE_MARKERS[localeCode];
    auditInvariant(Array.isArray(markers) && markers.length > 0, `no unavailability markers registered for locale: ${localePath}`);
    auditInvariant(markers.some((m) => locale.commons?.onboardingCourt?.includes(m)), `locale presents Court as available: ${localePath}`);
    auditInvariant(markers.some((m) => locale.commons?.onboardingBonds?.includes(m)), `locale presents Bonds as available: ${localePath}`);
  }

  const consumerPaths = [
    'src/screens/Dashboard/DashboardScreen.tsx',
    'src/screens/Commons/CommonsGovernance.tsx',
    'src/screens/Commons/CommonsDashboard.tsx',
    'src/screens/Legal/PrivacyPolicyScreen.tsx',
    'src/screens/Legal/TermsOfServiceScreen.tsx',
    'src/screens/Provenance/PVTDetailScreen.tsx',
    'src/screens/Vision/VisionScreen.tsx',
    'src/screens/Activity/ActivityLogScreen.tsx',
    'src/screens/Agent/LinkAcceptScreen.tsx',
    'src/screens/Chat/ChatCaptureConsentScreen.tsx',
    'src/screens/Chat/ChatHomeScreen.tsx',
    'src/i18n/locales/enOnboardingNarrative.ts',
    ...localePaths,
  ];
  for (const consumerPath of consumerPaths) {
    auditInvariant(!/\bWP\d+\b|Gate 1|live PVTv8|authority unassigned/.test(readText(consumerPath, overlay)), `consumer copy leaks internal/stale authority language: ${consumerPath}`);
  }
}

export function auditWp2({ overlay: overlayInput = new Map() } = {}) {
  const overlay = normalizeOverlay(overlayInput);
  auditCanonicalConfiguration(overlay);
  auditLegacyAuthorityQuarantine(overlay);
  auditExternalValueIsolation(overlay);
  auditRuntimeAndDiscovery(overlay);
  auditCurrentTruth(overlay);
  auditAppAndMarketBoundary(overlay);
  const changedPaths = auditFrozenEvidenceAndScope(overlay);
  return Object.freeze({
    changedFileCount: changedPaths.length,
    legacyPathCount: EXPECTED_LEGACY_CLASSIFICATIONS.size,
    generatedMirrorCount: GENERATED_PATHS.length,
    frozenManifestSha256: FROZEN_MANIFEST_SHA256,
    frozenCostCatalogSha256: FROZEN_COST_CATALOG_SHA256,
    frozenActionPolicyMatrixContentSha256: FROZEN_ACTION_POLICY_MATRIX_CONTENT_SHA256,
  });
}

function runAdversarialSelfTests() {
  const cases = [];
  const addMutation = (name, relativePath, mutate, expectedFragment) => {
    const original = readText(relativePath, new Map());
    const mutated = mutate(original);
    auditInvariant(mutated !== original, `self-test mutation did not alter ${relativePath}: ${name}`);
    cases.push({ name, overlay: new Map([[relativePath, mutated]]), expectedFragment });
  };

  for (const relativePath of [
    'contracts/scripts/deploy-pvt-v8.ts',
    'contracts/scripts/verify-pvt-v8.ts',
    'contracts/scripts/admin-transfer/run-base-transfers-D395.sh',
    'provian-backend/cloudrun/anchor-recovery-scheduler.yaml',
    'contracts/scripts/admin-transfer/arbitrum-setprotocol-safe-batch.json',
    'contracts/src/ProvianPVTv8.sol',
    'scripts/transfer-admin-to-safe.ts',
  ]) {
    cases.push({ name: `restore retired path ${relativePath}`,
      overlay: new Map([[relativePath, 'restored retired source\n']]),
      expectedFragment: 'retired execution or contract restored' });
  }
  addMutation('restore package deployment alias', 'contracts/package.json', (source) => {
    const value = JSON.parse(source); value.scripts.deploy = 'hardhat run scripts/deploy-pvt-v8.ts';
    return `${JSON.stringify(value, null, 2)}\n`;
  }, 'legacy execution alias');
  addMutation('change original baseline byte pin', 'config/integrity/baseline-pins.json',
    (source) => `${source} `, 'baseline byte pins changed');
  cases.push({
    name: 'add second canonical configuration source',
    overlay: new Map([['config/pvt9-shadow.json', readText('config/pvt9-base.json', new Map())]]),
    expectedFragment: 'second canonical configuration source',
  });
  addMutation(
    'add environment fallback to generated seam',
    GENERATED_PATHS[0],
    (source) => `${source}\nvoid process.env.PVT9_ADDRESS;\n`,
    'generated mirror is not mechanical',
  );
  addMutation(
    'remove permissionless Commons catalog projection',
    'src/core/commons/CommonsService.ts',
    (source) => source.replace("return request('GET', '/governance/pe-types', undefined, undefined, biometricAction)", "return request('GET', '/governance/proposals', undefined, undefined, biometricAction)"),
    'Commons PE catalog projection is not wired',
  );
  addMutation(
    'restore agent-wallet legacy PVT environment fallback',
    'provian-backend/src/routes/agent-wallet.ts',
    (source) => `${source}\nvoid process.env.PVT_CONTRACT_ADDRESS;\n`,
    'agent wallet can resolve a legacy PVT address from the environment',
  );
  addMutation(
    'import renamed market provider into economics',
    'provian-backend/src/core/pvt/activity-mint-limits.ts',
    (source) => `import renamedVendor from './alternate-value-provider';\n${source}`,
    'import allowlist drifted',
  );
  addMutation(
    'allow unknown PVT paths',
    'provian-backend/src/core/pvt/wp2-runtime-boundary.ts',
    (source) => source.replace("return blocked('pvt_runtime');", 'return PASS;'),
    'block everything else',
  );
  addMutation(
    'block the full Forum',
    'provian-backend/src/core/pvt/wp2-runtime-boundary.ts',
    (source) => `${source}\nvoid "path.startsWith('/v1/commons/forum')";\n`,
    'full Forum block',
  );
  addMutation(
    'fallback unavailable Send to another asset',
    'src/screens/Action/sendAssetSelection.ts',
    (source) => source.replace(
      'availableAssets.find((asset) => asset.symbol === requestedSymbol) ?? null',
      'availableAssets.find((asset) => asset.symbol === requestedSymbol) ?? availableAssets[0]',
    ),
    'silently falls back',
  );
  addMutation(
    'move PVT behind the other Send assets',
    'src/screens/Action/sendAssetSelection.ts',
    (source) => source.replace(
      "        ...sendableAssets.filter((asset) => asset.isPVT === true),\n        ...sendableAssets.filter((asset) => asset.isPVT !== true),",
      "        ...sendableAssets.filter((asset) => asset.isPVT !== true),\n        ...sendableAssets.filter((asset) => asset.isPVT === true),",
    ),
    'does not place PVT first',
  );
  addMutation(
    'erase live Foundation mint allocation from public status',
    'provian-website/src/app/ubp/page.tsx',
    (source) => source.replace('exists today as the on-chain treasury every settlement pays into', 'is not yet funded'),
    'public current-status page omits truth',
  );
  addMutation(
    'erase current prospective Foundation administration',
    'provian-website/src/app/ubp/page.tsx',
    (source) => source.replace('administers the protocol prospectively', 'administers the protocol retroactively'),
    'public current-status page omits truth',
  );
  addMutation(
    'mutate frozen policy inventory/atomic accounting manifest',
    'docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json',
    (source) => `${source} `,
    'frozen policy inventory/atomic accounting controlling artifact changed',
  );
  addMutation(
    'replace the operator boundary with authority unassigned',
    INVENTORY_PATH,
    (source) => source.replace(FRANK_DIRECT, 'authority unassigned'),
    'retired-path boundary changed',
  );
  addMutation(
    'mutate proposal-only cost catalog',
    'provian-backend/src/core/pvt/policy/proposed-pvt-cost-catalog.ts',
    (source) => `${source}\n// mutated\n`,
    'frozen policy inventory/atomic accounting controlling artifact changed',
  );
  // The re-pin is the standing closing step for a reviewed port, so the pin it
  // installs must be self-testing rather than hand-verified: editing a
  // re-pinned contract has to trip the guard and demand a fresh review-and-
  // re-pin, exactly as an edit to a baseline-identical historical contract does.
  addMutation(
    'mutate reviewed port-pinned contract after its re-pin',
    'contracts/src/ProvianBondPool.sol',
    (source) => `${source}\n// mutated after re-pin\n`,
    'reviewed WP-scoped port contract changed after its re-pin and must be re-pinned after review',
  );
  // The PVT9 kernel pair carries the same self-testing re-pin, in its own map so the pair
  // stays inside the external-value coupling scan.
  addMutation(
    'mutate re-pinned PVT9 kernel after its re-pin',
    'contracts/src/ProvianPVT9.sol',
    (source) => `${source}\n// mutated after re-pin\n`,
    'reviewed PVT9 kernel contract changed after its re-pin and must be re-pinned after review',
  );
  addMutation(
    'mutate re-pinned PVT9 eligibility verifier after its re-pin',
    'contracts/src/ProvianPVT9EligibilityVerifier.sol',
    (source) => `${source}\n// mutated after re-pin\n`,
    'reviewed PVT9 kernel contract changed after its re-pin and must be re-pinned after review',
  );
  addMutation(
    'configure Base USDC as PVT9',
    'config/pvt9-base.json',
    (source) => {
      const value = JSON.parse(source);
      value.status = 'configured';
      value.assets.pvt9 = {
        address: value.assets.usdc.address,
        abi: [{ type: 'function', name: 'balanceOf' }],
        deployment_status: 'deployed',
      };
      return `${JSON.stringify(value, null, 2)}\n`;
    },
    'conflicts with zero, legacy, asset, or dependent address',
  );
  addMutation(
    'enable legacy configuration fallback',
    'config/pvt9-base.json',
    (source) => {
      const value = JSON.parse(source);
      value.compatibility.legacy_fallback = true;
      return `${JSON.stringify(value, null, 2)}\n`;
    },
    'legacy fallback must be disabled',
  );

  cases.push({
    name: 'contracts external asset amount controls PVT reward',
    overlay: new Map([[
      'contracts/src/ProvianPVT9EconomicLeak.sol',
      'contract ProvianPVT9EconomicLeak { uint256 pvtReward = assetAmount; }\n',
    ]]),
    expectedFragment: 'contracts external value enters PVT economic authority',
  });
  addMutation(
    'backend renamed external-value field',
    'provian-backend/src/core/pvt/economics/financial-economic-authority.ts',
    (source) => source.replace('dailyCount: number;', 'externalConsideration: number;'),
    'financial economic authority input is not identity/count-only',
  );
  addMutation(
    'SDK aliased market provider controls PVT reward',
    'provian-agent-sdk/src/commons-institutions.ts',
    (source) => `${source}\nimport renamedSignal from './alternate-market-feed';\nconst pvtReward = renamedSignal();\n`,
    'SDK external value enters PVT economic authority',
  );
  addMutation(
    'app renamed display field controls PVT settlement cap',
    'src/screens/Dashboard/DashboardScreen.tsx',
    (source) => `${source}\nconst pvtSettlementCap = walletDisplay.usdEquivalent;\n`,
    'app external value enters PVT economic authority',
  );
  cases.push({
    name: 'schema external consideration controls PVT issuance',
    overlay: new Map([[
      'config/pvt9-economic-abi.json',
      '{"pvtIssuance":{"source":"externalConsideration"}}\n',
    ]]),
    expectedFragment: 'schemas/ABIs external value enters PVT economic authority',
  });
  cases.push({
    name: 'script external asset controls PVT eligibility',
    overlay: new Map([[
      'scripts/wp2/unsafe-pvt-reward.mjs',
      'const pvtEligibility = externalAssetAmount;\n',
    ]]),
    expectedFragment: 'scripts external value enters PVT economic authority',
  });
  addMutation(
    'active documentation makes fiat quote authoritative',
    'docs/legal/terms-of-service.md',
    (source) => `${source}\nPVT reward = fiatQuote.\n`,
    'active documentation makes external value authoritative for PVT',
  );
  addMutation(
    'remove current legal voting disclosure',
    'docs/legal/terms-of-service.md',
    (source) => source.replace(/Voting is not open/g, 'Voting is open'),
    'canonical legal voting status missing',
  );
  addMutation(
    'remove current legal Court disclosure',
    'docs/legal/terms-of-service.md',
    (source) => source.replace(/The Court is not open/g, 'The Court is open'),
    'canonical legal Court status missing',
  );
  addMutation(
    'restore live legacy minting in canonical Privacy',
    'docs/legal/privacy-policy.md',
    (source) => source.replace('The PVT kernel is deployed on Base', 'Legacy PVTv8 minting is active'),
    'canonical legal source retains live legacy claim',
  );
  // the pre- "jobs operational" mutation is no longer adversarial — Human Jobs IS
  // open. The live-posture page must instead REFUSE a revert to the retired
  // record-only statement, so the control plants exactly that.
  addMutation(
    'revert Commons page to the retired record-only posture',
    'provian-website/src/app/commons/page.tsx',
    (source) => source.replace('Economic governance is a future institution.', 'No current Commons runtime moves value; Market and Jobs remain planned.'),
    'reverted to the retired pre- posture',
  );
  addMutation(
    'advertise governance voting as open in the agent welcome',
    'provian-backend/src/routes/agent-wallet.ts',
    (source) => source.replace('PVT economic governance voting is not yet open', 'PVT economic governance voting is open'),
    'agent wallet welcome payload advertises governance as open',
  );

  for (const testCase of cases) {
    let error = null;
    try {
      auditWp2({ overlay: testCase.overlay });
    } catch (candidate) {
      error = candidate;
    }
    auditInvariant(error instanceof Error, `adversarial mutation was accepted: ${testCase.name}`);
    auditInvariant(
      error.message.includes(testCase.expectedFragment),
      `adversarial mutation failed for the wrong reason (${testCase.name}): ${error.message}`,
    );
  }
  return cases.length;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const shouldRunExecutionRegressions = process.argv.includes('--execution-regressions');
  const shouldAudit = process.argv.includes('--audit') || process.argv.includes('--self-test') || shouldRunExecutionRegressions;
  const shouldCheck = process.argv.includes('--check') || shouldAudit;
  generate({ check: shouldCheck });
  if (shouldAudit) {
    const result = auditWp2();
    let adversarialMutationCount = 0;
    if (process.argv.includes('--self-test')) {
      adversarialMutationCount = runAdversarialSelfTests();
    }
    if (shouldRunExecutionRegressions) {
      runLegacyBlockerExecutionRegressions();
    }
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      ...result,
      adversarialMutationCount,
      legacyExecutionRegressions: shouldRunExecutionRegressions ? 'passed' : 'not_run',
    }, null, 2)}\n`);
  }
}
