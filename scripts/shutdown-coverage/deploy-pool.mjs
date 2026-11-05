#!/usr/bin/env node
/**
 * Shutdown coverage (2026-10-20) — replace the live ProvianPoolV3 with one whose Funded pools are
 * refundable by anyone past their own deadline (contracts/src/ProvianPoolV3.sol `refundPool`).
 * NO PVT REDEPLOY: the kernel, verifier, EscrowV4, PromiseV3, BondPool and CourtV2 stay where they
 * are. PoolV3 has no setter wiring — no Court, Bond or kernel registry names it — so the constructor
 * IS the wiring, and it is copied from the live pool on-chain.
 *
 * State to carry: none, and the script proves it before it deploys. The live pool must hold zero
 * USDC and zero PVT, have no active cost schedule, and have emitted not one log since it was
 * deployed (no pool was ever created). Any of those failing is a STOP (funds would be stranded).
 *
 *   node scripts/shutdown-coverage/deploy-pool.mjs rehearse            # anvil fork, impersonated admin
 *   node scripts/shutdown-coverage/deploy-pool.mjs preflight --rpc URL
 *   node scripts/shutdown-coverage/deploy-pool.mjs deploy --rpc URL --admin-1password --expect-pool ADDR
 *
 * Signing: `--admin-1password` reads the bootstrap admin's key in-process from the 1Password item
 * "Metamask ProvianAdmin2" (Personal vault). `--deployer-secret NAME` instead reads a gas-only relay
 * key from Secret Manager (project provian-ai) in-process. The deployer gets NO authority over the
 * pool: the admin is a constructor argument, copied from the live pool (the bootstrap admin). Keys
 * never reach argv, an environment variable, a file or a log line. Evidence:
 * contracts/deployments/shutdown-coverage/.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { sendCanonicalDeployment } from './canonical-deploy.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(REPO, 'provian-backend/package.json'));
const { ethers } = require('ethers');

export const ADMIN = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3';
export const KERNEL = '0x8811441914381143b9408c5C32247367F86F173A';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const OLD_POOL = '0xb355C79a78DC0F33b7d1EF5dA230CD8097630a84';
export const OLD_POOL_DEPLOY_BLOCK = 52101008;
const OUT_DIR = resolve(REPO, 'contracts/deployments/shutdown-coverage');

const ART = JSON.parse(readFileSync(resolve(REPO, 'contracts/out/ProvianPoolV3.sol/ProvianPoolV3.json'), 'utf8'));
const PL = new ethers.Interface(ART.abi);
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const lc = (a) => String(a).toLowerCase();

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

/** Runtime code with every immutable slot zeroed, so a deployed copy compares to the artifact. */
function maskImmutables(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  for (const refs of Object.values(ART.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return bytes.toString('hex');
}

function loadAdminFromOnePassword({ item = 'Metamask ProvianAdmin2', vault = 'Personal' } = {}) {
  let raw;
  try {
    raw = execFileSync('op', ['item', 'get', item, '--vault', vault, '--format', 'json', '--reveal'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error(`'op item get' failed for "${item}" in vault "${vault}" (approve the 1Password prompt)`);
  }
  const fields = JSON.parse(raw).fields ?? [];
  raw = null;
  for (const f of fields) {
    if (typeof f?.value !== 'string') continue;
    const v = f.value.trim();
    const hex = /^(0x)?[0-9a-fA-F]{64}$/.test(v) ? (v.startsWith('0x') ? v : `0x${v}`) : null;
    if (!hex) continue;
    try {
      const w = new ethers.Wallet(hex);
      if (lc(w.address) === lc(ADMIN)) return w;
    } catch { /* not a key */ }
  }
  throw new Error(`none of the fields in "${item}" holds the key for ${ADMIN} (values not shown)`);
}

function loadFromSecretManager(name) {
  let raw;
  try {
    raw = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, '--project=provian-ai'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  } catch {
    throw new Error(`could not read secret ${name} (value not shown)`);
  }
  const hex = /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? (raw.startsWith('0x') ? raw : `0x${raw}`) : null;
  raw = null;
  if (!hex) throw new Error(`secret ${name} is not a private key (value not shown)`);
  return new ethers.Wallet(hex);
}

export function createRun({ provider, signer, statePath, expectPool = null, logProvider = provider, confirmations = 2, log = console.log }) {
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { schema: 'provian.shutdown-coverage.pool.v1', steps: {} };
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, statePath);
    const directory = openSync(dirname(statePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const pool = (addr) => new ethers.Contract(addr, ART.abi, provider);

  async function poolArgs(addr) {
    const c = pool(addr);
    return { admin: await c.admin(), feeWallet: await c.feeWallet(), usdc: await c.usdc(), pvt: await c.pvt(), epochClock: await c.epochClock() };
  }

  async function scanLogs(addr, from, to) {
    let total = 0, step = 10_000;
    while (from <= to) {
      const end = Math.min(from + step - 1, to);
      try { total += (await logProvider.getLogs({ address: addr, fromBlock: from, toBlock: end })).length; from = end + 1; }
      catch (e) { if (step > 500) { step = Math.floor(step / 2); continue; } throw e; }
    }
    return total;
  }

  async function preflight() {
    log('PREFLIGHT');
    const { chainId } = await provider.getNetwork();
    if (chainId !== 8453n) throw new Error(`chain ${chainId} is not Base (8453)`);
    const old = await poolArgs(OLD_POOL);
    if (lc(old.admin) !== lc(ADMIN) || lc(old.usdc) !== lc(USDC) || lc(old.pvt) !== lc(KERNEL) || lc(old.epochClock) !== lc(KERNEL)) {
      throw new Error(`live PoolV3 wiring is not the expected set: ${JSON.stringify(old)} — STOP`);
    }
    const usdcBal = await new ethers.Contract(USDC, ERC20, provider).balanceOf(OLD_POOL);
    const pvtBal = await new ethers.Contract(KERNEL, ERC20, provider).balanceOf(OLD_POOL);
    if (usdcBal !== 0n || pvtBal !== 0n) throw new Error(`live PoolV3 holds funds (USDC ${usdcBal}, PVT ${pvtBal}) — STOP`);
    for (const fn of ['activeFeeBps', 'activeThresholdCap', 'activeMaximumDeadline', 'activeMaxContributors']) {
      const [ex] = await pool(OLD_POOL)[fn]();
      if (ex) throw new Error(`live PoolV3 has an active ${fn} schedule — the new pool would have to carry it; STOP`);
    }
    const head = await provider.getBlockNumber();
    // On a fork the history is the upstream's: scan it there (anvil serves wide getLogs slowly).
    const logs = await scanLogs(OLD_POOL, OLD_POOL_DEPLOY_BLOCK, Math.min(head, await logProvider.getBlockNumber()));
    if (logs !== 0) throw new Error(`live PoolV3 has ${logs} logs since deploy — it has had activity; STOP`);
    const deployer = signer ? await signer.getAddress() : ADMIN;
    const nonce = await provider.getTransactionCount(deployer, 'latest');
    const balance = await provider.getBalance(deployer);
    state.preflight = {
      at_block: head,
      old_pool: { address: OLD_POOL, ...old, usdc_balance: usdcBal.toString(), pvt_balance: pvtBal.toString(), logs_since_deploy: logs, logs_scanned: [OLD_POOL_DEPLOY_BLOCK, head] },
      deployer, deployer_nonce: nonce, deployer_balance_wei: balance.toString(),
      predicted_pool: ethers.getCreateAddress({ from: deployer, nonce }),
    };
    save();
    log(`  live PoolV3 ${OLD_POOL}: USDC 0, PVT 0, no schedules, ${logs} logs over blocks ${OLD_POOL_DEPLOY_BLOCK}..${head}`);
    log(`  deployer ${deployer} nonce ${nonce} (next CREATE ${state.preflight.predicted_pool}), balance ${ethers.formatEther(balance)} ETH`);
    if (balance < 10n ** 14n) throw new Error('admin balance below 0.0001 ETH');
    return old;
  }

  async function deploy(old) {
    log('DEPLOY — ProvianPoolV3 with the permissionless past-deadline refund of a Funded pool');
    let addr = state.steps.poolV3?.address;
    if (!(addr && (await provider.getCode(addr)) !== '0x')) {
      const from = await signer.getAddress();
      const nonce = state.steps.poolV3Attempt?.nonce ?? await provider.getTransactionCount(from, 'latest');
      const predicted = ethers.getCreateAddress({ from, nonce });
      if (expectPool && lc(predicted) !== lc(expectPool)) throw new Error(`the deploy would land at ${predicted} (${from} nonce ${nonce}), not the expected ${expectPool} — STOP`);
      const bal = await provider.getBalance(from);
      if (bal < 10n ** 14n) throw new Error(`deployer ${from} balance ${ethers.formatEther(bal)} ETH is below 0.0001`);
      const factory = new ethers.ContractFactory(ART.abi, ART.bytecode.object, signer);
      const call = await factory.getDeployTransaction(old.admin, old.feeWallet, old.usdc, old.pvt, old.epochClock);
      const tx = await sendCanonicalDeployment({ provider, signer, call, prior: state.steps.poolV3Attempt, expectedNonce: nonce, confirmations,
        persist: async attempt => { state.steps.poolV3Attempt = attempt; save(); } });
      const receipt = tx.receipt;
      if (tx.nonce !== nonce || lc(tx.predicted) !== lc(predicted)) throw new Error('deployment_nonce_binding_changed');
      addr = ethers.getAddress(receipt.contractAddress);
      state.steps.poolV3 = { address: addr, tx: tx.hash, block: receipt.blockNumber, deployer: from, nonce, gasUsed: receipt.gasUsed.toString() };
      save();
      log(`  poolV3: ${tx.hash} -> ${addr} (block ${receipt.blockNumber})`);
    } else log(`  poolV3: already at ${addr}`);
    return addr;
  }

  async function verify(addr, old) {
    log('VERIFY');
    const got = await poolArgs(addr);
    for (const k of Object.keys(old)) if (lc(got[k]) !== lc(old[k])) throw new Error(`new PoolV3 ${k} is ${got[k]}, expected ${old[k]}`);
    if ((await pool(addr).VERSION()) !== 'v3') throw new Error('new PoolV3 VERSION != v3');
    const code = await provider.getCode(addr);
    const codeMatches = maskImmutables(code) === maskImmutables(ART.deployedBytecode.object);
    if (!codeMatches) throw new Error('deployed runtime code does not match contracts/out ProvianPoolV3 (the fix is not what was deployed)');
    const oldCodeMatches = maskImmutables(await provider.getCode(OLD_POOL)) === maskImmutables(ART.deployedBytecode.object);
    if (oldCodeMatches) throw new Error('the OLD pool already carries this code — nothing to replace');
    state.verify = { new_pool: addr, constructor_args: got, runtime_code_matches_artifact: true, old_pool_code_differs: true };
    save();
    log(`  ${addr}: wiring copied from ${OLD_POOL}; runtime code == contracts/out ProvianPoolV3 (immutables masked); old pool's code differs`);
  }

  return { state, preflight, deploy, verify };
}

async function rehearse(args) {
  const port = Number(args.port || 8551);
  const upstream = args.upstream || process.env.BASE_RPC_URL;
  if (!upstream) throw new Error('rehearse needs --upstream or BASE_RPC_URL');
  const anvil = spawn('anvil', ['--fork-url', upstream, '--port', String(port), '--chain-id', '8453', '--silent'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const url = `http://127.0.0.1:${port}`;
  try {
    const provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true });
    for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 500)); } }
    // A disposable fork-only signer can produce recovery bytes; impersonation cannot.
    const signer = new ethers.Wallet('0x' + '13'.repeat(32), provider);
    await provider.send('anvil_setBalance', [signer.address, '0x' + (10n ** 18n).toString(16)]);
    const run = createRun({ provider, signer, statePath: resolve(OUT_DIR, 'rehearsal/execution.json'), logProvider: new ethers.JsonRpcProvider(upstream, 8453, { staticNetwork: true }), confirmations: 1 });
    run.state.fork_block = await provider.getBlockNumber();
    const old = await run.preflight();
    const addr = await run.deploy(old);
    if (lc(addr) !== lc(run.state.preflight.predicted_pool)) throw new Error(`landed at ${addr}, predicted ${run.state.preflight.predicted_pool}`);
    await run.verify(addr, old);
    // Behavioural proof on the fork: a Funded pool past its deadline is refunded by a stranger.
    const creator = ethers.getAddress('0x' + 'c1'.repeat(20));
    const contributor = ethers.getAddress('0x' + 'c2'.repeat(20));
    const stranger = ethers.getAddress('0x' + 'c3'.repeat(20));
    const kernel = new ethers.Contract(KERNEL, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'], provider);
    const holder = ethers.getAddress(args['pvt-holder'] || '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936');
    for (const a of [creator, contributor, stranger, holder]) {
      await provider.send('anvil_setBalance', [a, '0x' + (10n ** 18n).toString(16)]);
      await provider.send('anvil_impersonateAccount', [a]);
    }
    const amount = 10n ** 18n;
    await (await kernel.connect(await provider.getSigner(holder)).transfer(contributor, amount)).wait();
    const p = (who) => new ethers.Contract(addr, ART.abi, who);
    const id = ethers.id('shutdown-coverage-rehearsal');
    const block = await provider.getBlock('latest');
    await (await p(await provider.getSigner(creator)).createPool(id, creator, amount, block.timestamp + 3600, 1)).wait();
    await (await kernel.connect(await provider.getSigner(contributor)).approve(addr, amount)).wait();
    await (await p(await provider.getSigner(contributor)).contribute(id, amount)).wait();
    const before = await kernel.balanceOf(contributor);
    await provider.send('evm_increaseTime', [3601]);
    await provider.send('evm_mine', []);
    await (await p(await provider.getSigner(stranger)).refundPool(id)).wait();
    const after = await kernel.balanceOf(contributor);
    if (after - before !== amount) throw new Error(`fork refund returned ${after - before}, expected ${amount}`);
    run.state.fork_behaviour = { funded_pool_refunded_by_stranger_past_deadline: true, amount: amount.toString() };
    writeFileSync(resolve(OUT_DIR, 'rehearsal/execution.json'), JSON.stringify(run.state, null, 2) + '\n');
    console.log(`\nREHEARSAL PASSED — a Funded PVT pool past its deadline was refunded by a stranger on the fork; new pool at the admin's next CREATE address ${addr}`);
  } finally {
    anvil.kill();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'rehearse') return rehearse(args);
  if (!['preflight', 'deploy', 'whoami'].includes(cmd)) throw new Error('usage: deploy-pool.mjs <rehearse|preflight|deploy> --rpc URL [--admin-1password] [--expect-pool ADDR]');
  if (!args.rpc) throw new Error('--rpc URL is required');
  const provider = new ethers.JsonRpcProvider(args.rpc, 8453, { staticNetwork: true });
  let signer = null;
  if (cmd === 'deploy' || cmd === 'whoami') {
    if (args['admin-1password'] !== undefined) signer = loadAdminFromOnePassword().connect(provider);
    else if (typeof args['deployer-secret'] === 'string') signer = loadFromSecretManager(args['deployer-secret']).connect(provider);
    else throw new Error('deploy needs --admin-1password or --deployer-secret NAME');
  }
  if (cmd === 'whoami') {
    const from = await signer.getAddress();
    const nonce = await provider.getTransactionCount(from, 'latest');
    console.log(`deployer ${from} nonce ${nonce} balance ${ethers.formatEther(await provider.getBalance(from))} ETH next CREATE ${ethers.getCreateAddress({ from, nonce })}`);
    return;
  }
  if (cmd === 'deploy' && !args['expect-pool']) throw new Error('deploy needs --expect-pool (the deployer\'s next CREATE address; `whoami` prints it)');
  const run = createRun({ provider, signer, statePath: resolve(OUT_DIR, 'mainnet/execution.json'), expectPool: args['expect-pool'] || null });
  const old = await run.preflight();
  if (cmd === 'preflight') return;
  const addr = await run.deploy(old);
  await run.verify(addr, old);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
