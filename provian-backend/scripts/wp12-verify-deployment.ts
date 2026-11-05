/**
 * activation — INDEPENDENT post-deploy verifier. READ-ONLY. Holds no key, sends nothing.
 *
 * Why this exists separately from `wp12-deploy-pvt9.ts` that script verifies its
 * own work and then reports success. If its verification logic is wrong, its
 * report is wrong in exactly the same direction — the failure is invisible. This
 * re-checks the same facts with an INDEPENDENT implementation and independently
 * re-derived expectations, so "what landed is the reviewed source" is confirmed by
 * something other than the deploying script's own word.
 *
 * Deliberately does NOT import from `wp12-deploy-pvt9.ts`. The bytecode
 * comparison, the immutable-offset masking and the expectation tables are all
 * re-written here from the reviewed kernel source and `loadPvt9ArmingInputs()`.
 * Sharing them would reproduce a shared bug and defeat the point.
 *
 * Usage:
 * wp12-verify-deployment.ts --receipt <path> [--rpc <url>]
 * wp12-verify-deployment.ts --kernel <a> --verifier <a>
 * [--escrow <a>] [--promise <a>] [--pool <a>]
 * [--bond <a>] [--court <a>] [--rpc <url>]
 * wp12-verify-deployment.ts --self-test (no network, no addresses)
 *
 * `--self-test` runs the verifier's own positive and negative controls and is the
 * evidence that it can FAIL. Run it before trusting a green verification run: a
 * comparator that always returns "match" would pass every real check silently.
 *
 * Exit 0 = every check passed. Exit 1 = at least one failed, and each failure is
 * named with the contract, the getter or byte offset, expected and actual.
 */

import fs from 'fs';
import path from 'path';

import { Contract, getAddress, isAddress } from 'ethers';

import { createRetryingProvider, waitForCode } from './lib/retrying-provider';

import { loadPvt9ArmingInputs, KERNEL_BOOTSTRAP_ADMIN } from '../src/core/pvt/policy/pvt9-arming-inputs';

const BASE_CHAIN_ID = 8453n;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CONTRACTS_OUT = path.join(__dirname, '..', '..', 'contracts', 'out');

/** Solc artifact shape, narrowed to the fields this verifier reads. */
interface Artifact {
  readonly abi: unknown;
  readonly deployedBytecode: {
    readonly object: string;
    readonly immutableReferences?: Record<string, ReadonlyArray<{ start: number; length: number }>>;
  };
}

function loadArtifact(name: string): Artifact {
  const p = path.join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`artifact missing: ${p} — run \`forge build\` in contracts/ first`);
  }
  const a = JSON.parse(fs.readFileSync(p, 'utf8')) as Artifact;
  if (!a.deployedBytecode?.object) throw new Error(`artifact malformed (no runtime bytecode): ${p}`);
  return a;
}

function normalizeRuntime(code: string): string {
  return code.toLowerCase().replace(/^0x/, '');
}

/**
 * Byte offsets solc records as immutable slots. Independent re-implementation:
 * these are the ONLY offsets allowed to differ from the artifact. A contract with
 * no immutables yields an empty set, so its runtime must match byte-for-byte.
 */
function immutableByteOffsets(art: Artifact): Set<number> {
  const offsets = new Set<number>();
  for (const spans of Object.values(art.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of spans) {
      for (let i = 0; i < length; i += 1) offsets.add(start + i);
    }
  }
  return offsets;
}

export interface BytecodeVerdict {
  readonly ok: boolean;
  /** Bytes differing INSIDE recorded immutable slots — expected and tolerated. */
  readonly immutableDiffs: number;
  /** Byte offsets differing OUTSIDE any immutable slot — each one is fatal. */
  readonly unexplained: readonly number[];
  readonly reason?: string;
}

/**
 * Compare a deployed runtime against a compiled artifact. Returns a verdict
 * rather than throwing so the caller can report EVERY contract's result instead
 * of stopping at the first, and so the self-test can assert on failures.
 */
export function verifyRuntime(onChainRaw: string, art: Artifact): BytecodeVerdict {
  const onChain = normalizeRuntime(onChainRaw);
  const expected = normalizeRuntime(art.deployedBytecode.object);
  if (onChain.length === 0) {
    return { ok: false, immutableDiffs: 0, unexplained: [], reason: 'no code at address' };
  }
  if (onChain.length !== expected.length) {
    return {
      ok: false,
      immutableDiffs: 0,
      unexplained: [],
      reason: `runtime length ${onChain.length / 2}B != artifact ${expected.length / 2}B`,
    };
  }
  const immutables = immutableByteOffsets(art);
  const unexplained: number[] = [];
  let immutableDiffs = 0;
  for (let i = 0; i < expected.length; i += 2) {
    if (onChain.slice(i, i + 2) === expected.slice(i, i + 2)) continue;
    const byteOffset = i / 2;
    if (immutables.has(byteOffset)) immutableDiffs += 1;
    else unexplained.push(byteOffset);
  }
  return {
    ok: unexplained.length === 0,
    immutableDiffs,
    unexplained,
    reason: unexplained.length > 0
      ? `${unexplained.length} byte(s) differ OUTSIDE any immutable slot (first at offset ${unexplained[0]}) — the deployed code is NOT the reviewed source`
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Expectations — re-derived here, never imported from the deploy script.
// Kernel literals come from the reviewed ProvianPVT9 source; addresses come from
// loadPvt9ArmingInputs(); institution wiring from /.
// ---------------------------------------------------------------------------

interface Target {
  readonly artifact: string;
  readonly address: string;
  /** zero-arg getter -> required return value, stringified. */
  readonly expect: Record<string, string>;
}

function buildTargets(addrs: Record<string, string | undefined>): Target[] {
  const inputs = loadPvt9ArmingInputs();
  const admin = getAddress(KERNEL_BOOTSTRAP_ADMIN);
  const provianTreasury = getAddress(inputs.epochZeroConfig.provianTreasury);
  const kernel = getAddress(addrs.kernel!);
  const { configurationId, configurationVersion } = inputs.eligibilityVerifierConstructor;

  const targets: Target[] = [
    {
      artifact: 'ProvianPVT9',
      address: kernel,
      expect: {
        BOOTSTRAP_ADMIN: admin,
        EPOCH_DURATION: String(7 * 24 * 60 * 60),
        INITIAL_GENESIS_EPOCH_CAP: (7_500_000n * 10n ** 18n).toString(),
        INITIAL_MIN_MINT_RATE: (5n * 10n ** 17n).toString(),
        INITIAL_MAX_MINT_RATE: (2n * 10n ** 18n).toString(),
        PROVIAN_BPS: '50',
        HUMAN_FOUNDATION_BPS: '50',
      },
    },
  ];

  if (addrs.verifier) {
    targets.push({
      artifact: 'ProvianPVT9EligibilityVerifier',
      address: getAddress(addrs.verifier),
      expect: {
        KERNEL: kernel,
        CONFIGURATION_ID: configurationId,
        CONFIGURATION_VERSION: String(configurationVersion),
        BOOTSTRAP_ADMIN: admin,
      },
    });
  }

  const institutionExpect = {
    admin,
    feeWallet: provianTreasury,
    usdc: getAddress(BASE_USDC),
    pvt: kernel,
    epochClock: kernel,
  };
  for (const [key, artifact] of [
    ['escrow', 'ProvianEscrowV4'],
    ['promise', 'ProvianPromiseV3'],
    ['pool', 'ProvianPoolV3'],
  ] as const) {
    if (addrs[key]) targets.push({ artifact, address: getAddress(addrs[key]!), expect: institutionExpect });
  }
  if (addrs.bond) {
    targets.push({
      artifact: 'ProvianBondPool',
      address: getAddress(addrs.bond),
      expect: { admin, provianTechWallet: provianTreasury, pvt: kernel, epochClock: kernel },
    });
  }
  if (addrs.court) {
    targets.push({
      artifact: 'ProvianCourtV2',
      address: getAddress(addrs.court),
      // escrowContract is only checkable when the escrow address was supplied too.
      expect: {
        admin,
        epochClock: kernel,
        ...(addrs.escrow ? { escrowContract: getAddress(addrs.escrow) } : {}),
      },
    });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Self-test: the controls that prove this verifier can FAIL.
// ---------------------------------------------------------------------------

function selfTest(): number {
  console.log('=== SELF-TEST — the controls that prove this verifier can FAIL ===\n');
  const art = loadArtifact('ProvianPVT9');
  const runtime = normalizeRuntime(art.deployedBytecode.object);
  const withImmutables = loadArtifact('ProvianEscrowV4');
  const immutableSlots = immutableByteOffsets(withImmutables);
  let failures = 0;

  const check = (label: string, pass: boolean, detail: string) => {
    console.log(`  ${pass ? 'PASS' : '**FAIL**'}  ${label}\n          ${detail}`);
    if (!pass) failures += 1;
  };

  // POSITIVE 1 — an identical runtime verifies.
  const v1 = verifyRuntime(`0x${runtime}`, art);
  check('identical runtime verifies', v1.ok && v1.unexplained.length === 0,
    `ok=${v1.ok} immutableDiffs=${v1.immutableDiffs} unexplained=${v1.unexplained.length}`);

  // NEGATIVE 1 — one byte flipped OUTSIDE any immutable slot must be fatal, and
  // must name the offset. The kernel has no immutables, so any offset qualifies.
  const flipAt = Math.floor(runtime.length / 4) * 2; // an arbitrary interior byte
  const orig = runtime.slice(flipAt, flipAt + 2);
  const flipped = `${runtime.slice(0, flipAt)}${orig === 'ff' ? 'fe' : 'ff'}${runtime.slice(flipAt + 2)}`;
  const v2 = verifyRuntime(`0x${flipped}`, art);
  check('a byte flipped outside an immutable slot is REJECTED and named',
    !v2.ok && v2.unexplained.length === 1 && v2.unexplained[0] === flipAt / 2,
    `ok=${v2.ok} unexplained=[${v2.unexplained.join(',')}] expected=[${flipAt / 2}]`);

  // NEGATIVE 2 — a DIFFERENT contract's runtime must be rejected. This is the
  // control that catches an address/artifact mix-up, not just a corrupted byte.
  const v3 = verifyRuntime(`0x${normalizeRuntime(withImmutables.deployedBytecode.object)}`, art);
  check("another contract's runtime is REJECTED", !v3.ok, `ok=${v3.ok} reason=${v3.reason}`);

  // NEGATIVE 3 — an empty runtime (nothing deployed) must be rejected, NOT
  // treated as a vacuous match. A comparator that loops over zero bytes and
  // reports success is the empty-population defect.
  const v4 = verifyRuntime('0x', art);
  check('an EMPTY runtime is REJECTED, not a vacuous pass', !v4.ok, `ok=${v4.ok} reason=${v4.reason}`);

  // POSITIVE 2 — a byte flipped INSIDE a recorded immutable slot is tolerated,
  // and counted. Without this the verifier would reject every correct deploy of a
  // contract that has immutables.
  if (immutableSlots.size === 0) {
    check('a byte inside an immutable slot is TOLERATED', false,
      'SKIPPED — ProvianEscrowV4 records no immutable slots, so this control could not be constructed');
  } else {
    const slot = [...immutableSlots][0];
    const r2 = normalizeRuntime(withImmutables.deployedBytecode.object);
    const at = slot * 2;
    const o2 = r2.slice(at, at + 2);
    const m2 = `${r2.slice(0, at)}${o2 === 'ff' ? 'fe' : 'ff'}${r2.slice(at + 2)}`;
    const v5 = verifyRuntime(`0x${m2}`, withImmutables);
    check('a byte inside an immutable slot is TOLERATED and counted',
      v5.ok && v5.immutableDiffs === 1,
      `ok=${v5.ok} immutableDiffs=${v5.immutableDiffs} (slot offset ${slot})`);
  }

  console.log(`\n=== SELF-TEST ${failures === 0 ? 'PASSED — the verifier can fail, and fails for the right reasons' : `FAILED (${failures})`} ===`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

interface ReceiptEntry {
  readonly name: string;
  readonly address: string;
  readonly txHash: string;
  readonly runtimeSha256?: string;
}

const RECEIPT_KEY: Record<string, string> = {
  ProvianPVT9: 'kernel',
  ProvianPVT9EligibilityVerifier: 'verifier',
  ProvianEscrowV4: 'escrow',
  ProvianPromiseV3: 'promise',
  ProvianPoolV3: 'pool',
  ProvianBondPool: 'bond',
  ProvianCourtV2: 'court',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(selfTest());
  }

  const rpcUrl = flag(args, '--rpc') ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  const addrs: Record<string, string | undefined> = {};
  let receipt: ReceiptEntry[] = [];

  const receiptPath = flag(args, '--receipt');
  if (receiptPath) {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReceiptEntry[];
    for (const e of receipt) {
      const key = RECEIPT_KEY[e.name];
      if (key) addrs[key] = e.address;
    }
    console.log(`receipt                 ${receiptPath}  (${receipt.length} entr${receipt.length === 1 ? 'y' : 'ies'})`);
  } else {
    for (const k of ['kernel', 'verifier', 'escrow', 'promise', 'pool', 'bond', 'court']) {
      addrs[k] = flag(args, `--${k}`);
    }
  }

  if (!addrs.kernel) {
    console.error(
      'Usage: wp12-verify-deployment.ts --receipt <path> [--rpc <url>]\n'
      + ' or: wp12-verify-deployment.ts --kernel <addr> --verifier <addr> [--escrow …] [--rpc <url>]\n'
      + ' or: wp12-verify-deployment.ts --self-test\n'
      + 'READ-ONLY. Holds no key and sends no transaction.',
    );
    process.exit(2);
  }

  const provider = createRetryingProvider(rpcUrl);
  const net = await provider.getNetwork();
  console.log(`rpc                     ${rpcUrl}`);
  console.log(`chainId                 ${net.chainId}`);
  if (net.chainId !== BASE_CHAIN_ID) {
    throw new Error(`refusing: chainId ${net.chainId} is not Base mainnet (${BASE_CHAIN_ID})`);
  }

  const targets = buildTargets(addrs);
  let failures = 0;
  const fail = (msg: string) => { failures += 1; console.log(`  ** FAIL ** ${msg}`); };

  for (const t of targets) {
    console.log(`\n--- ${t.artifact} @ ${t.address} ---`);
    const art = loadArtifact(t.artifact);

    // (a) INDEPENDENT bytecode verification.
    // Poll rather than single-read: an empty getCode right after a deploy is
    // UNKNOWN, not ABSENT (a lagging node returns `0x`). If it stays empty the
    // verdict is still a hard failure — `verifyRuntime` is unchanged and still
    // treats an empty runtime as a rejection, never a vacuous pass.
    const verdict = verifyRuntime(
      await waitForCode(provider, t.address, {
        onWait: (a) => console.log(`  [rpc] getCode empty (attempt ${a}) — waiting for the node to catch up`),
      }),
      art,
    );
    if (!verdict.ok) fail(`bytecode: ${verdict.reason}`);
    else {
      console.log(`  bytecode  VERIFIED — ${verdict.immutableDiffs === 0
        ? 'EXACT match against the compiled artifact'
        : `${verdict.immutableDiffs} byte(s) differ, all inside recorded immutable slots`}`);
    }

    // (b) INDEPENDENT constructor-arg / immutable readback.
    const instance = new Contract(t.address, art.abi as never, provider);
    for (const [getter, want] of Object.entries(t.expect)) {
      try {
        const raw: unknown = await (instance as unknown as Record<string, () => Promise<unknown>>)[getter]();
        const got = typeof raw === 'string' && isAddress(raw) ? getAddress(raw) : String(raw);
        const wantNorm = isAddress(want) ? getAddress(want) : want;
        if (got.toLowerCase() !== wantNorm.toLowerCase()) {
          fail(`${getter}() = ${got}, expected ${wantNorm}`);
        } else {
          console.log(`  readback  ${getter}() = ${got}  OK`);
        }
      } catch (e) {
        fail(`${getter}() threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // (c) NOT ARMED — this verifier runs between deploy and arm, so epoch zero
    //     must still be closed. If this is ever true here, something armed the
    //     kernel outside the reviewed arm command.
    if (t.artifact === 'ProvianPVT9') {
      try {
        const armed = await (instance as unknown as { epochZeroArmed: () => Promise<boolean> }).epochZeroArmed();
        if (armed) fail('epochZeroArmed() = true — the kernel is ALREADY ARMED (expected false pre-arm)');
        else console.log('  readback  epochZeroArmed() = false  OK (not armed, as expected pre-arm)');
      } catch (e) {
        fail(`epochZeroArmed() threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // (d) Deployment transactions, when a receipt was supplied: confirm each tx
  //     exists, succeeded, and actually created the address it claims.
  if (receipt.length > 0) {
    console.log('\n--- deployment transactions ---');
    for (const e of receipt) {
      // ADOPTED entries carry `adopted:<addr>`, not a tx hash — this run did not
      // create them, so there is no deployment receipt to fetch. Skipping is
      // correct, but it must be VISIBLE: silently dropping them would let an
      // adopted contract look transaction-verified when it never was. Its code
      // and constructor args were still fully checked above.
      if (e.txHash.startsWith('adopted:')) {
        console.log(`  ${e.name.padEnd(32)} ADOPTED (not deployed by that run) — no deploy tx to verify`);
        continue;
      }
      const rcpt = await provider.getTransactionReceipt(e.txHash);
      if (!rcpt) { fail(`${e.name}: tx ${e.txHash} not found on chain`); continue; }
      if (rcpt.status !== 1) { fail(`${e.name}: tx ${e.txHash} status ${rcpt.status} (not success)`); continue; }
      const created = rcpt.contractAddress ? getAddress(rcpt.contractAddress) : null;
      if (created !== getAddress(e.address)) {
        fail(`${e.name}: tx created ${created ?? '<none>'} but receipt claims ${e.address}`);
        continue;
      }
      console.log(`  ${e.name.padEnd(32)} block ${rcpt.blockNumber}  tx ${e.txHash}  OK`);
    }
  }

  console.log(
    failures === 0
      ? '\n=== INDEPENDENT VERIFICATION PASSED — deployed code IS the reviewed source, and NOT armed ==='
      : `\n=== INDEPENDENT VERIFICATION FAILED — ${failures} problem(s) above. STOP; do not arm. ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[wp12-verify-deployment] STOPPED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
