/**
 * Base-mainnet fork harness for the agent sovereign-wallet EVM signer (slice 1/2).
 *
 * Proves the SDK signs + BROADCASTS real txs against a REAL Base-mainnet fork
 * (anvil), not a mock: real nonce, real gas estimate, real eth_sendRawTransaction,
 * txs mine, balances move, and the live BondPool accepts a real approve->postBond.
 *
 * ADDRESSES ARE THE SDK'S OWN, never a harness literal. The PVT token is
 * `getToken('base', 'PVT')` (the SDK allowlist the signer itself resolves — the
 * PVT9 successor kernel) and the BondPool is `bondPoolAddressForChain('base')`
 * (the SDK's `contract-addresses.ts` resolution of the institution deployment/PVT9 BondPool from
 * `contracts/deployments/base-pvt9-institutions.json`). A PREFLIGHT, which needs
 * no RPC, then checks those against the repo's other sources before anything is
 * broadcast: the PVT token must equal `config/pvt9-base.json` `assets.pvt9.address`
 * and sit outside its `validation.forbidden_pvt_addresses`; neither address may be
 * one of the SDK's `retiredBaseAddresses()` (the Pass-3 stack + PVTv8). So if the
 * SDK pin ever drifts from the live kernel, the harness refuses to run instead of
 * proving the wrong contract. `FORK_PREFLIGHT_ONLY=1` runs just that step.
 *
 * No real money: the fork is local; ETH comes from anvil's funded dev account,
 * and PVT/USDC are "dealt" into the agent's balance via anvil_setStorageAt. The
 * balance-mapping and totalSupply slots are DISCOVERED on the fork (probe a slot,
 * read the getter back, restore), not transcribed, so a layout change cannot make
 * the deal silently land in the wrong slot. totalSupply is raised by exactly the
 * dealt amount so the kernel's supply invariant holds and the BondPool's
 * `pvt.burn` cannot underflow. The agent EOA is anvil dev account[0] (known key).
 *
 * Run:
 * 1. anvil --fork-url https://mainnet.base.org --port 8545 --silent (separate shell)
 * 2. npm --prefix provian-agent-sdk run build
 * 3. node provian-agent-sdk/test-harness/fork-base.mjs
 * It writes the real tx hashes to /tmp/fork-hashes.json for the backend verifier
 * harness (provian-backend/scripts/fork-verify.ts) to validate.
 */
import sdk from '../dist/index.js';
// Not re-exported from the package root; the same module CommonsInstitutions.topUpBond uses.
import evmBond from '../dist/evm-bond.js';
import {
  createPublicClient, http, keccak256, encodeAbiParameters, toHex, parseEther, getAddress,
} from 'viem';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const {
  transferToken, transferNative, sendTransaction, getToken, bondPoolAddressForChain, retiredBaseAddresses,
  encodeApprove, encodePostBond, encodeRenewBond, grossUpTotalDeposit, requiredBondWei, waitForReceipt,
} = sdk;
const { encodeTopUpBond } = evmBond;

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8545';
// anvil dev account[0] - funded with 10000 ETH on the fork; we use it as the agent EOA.
const AGENT = {
  privateKeyHex: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};
// A fresh address with NO code on Base. (anvil dev account[1] is EIP-7702
// delegated on Base mainnet - sending ETH there runs delegated code and the
// value does not simply land, which would break the native delta assertion.)
const RECIPIENT = getAddress('0x00000000000000000000000000000000deadbeef');
// Resolved exactly as the SDK signer resolves them (see header).
const PVT = getAddress(getToken('base', 'PVT').address);
const USDC = getAddress(getToken('base', 'USDC').address);
const POOL = getAddress(bondPoolAddressForChain('base'));

let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ FAIL: ' + msg); }
};

/** Static checks: the SDK's pins agree with the repo's live-kernel config. No RPC. */
function preflight() {
  console.log('0) preflight (no RPC): SDK pins vs repo config');
  const cfgPath = fileURLToPath(new URL('../../config/pvt9-base.json', import.meta.url));
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const livePvt9 = getAddress(cfg.assets.pvt9.address);
  const forbidden = (cfg.validation?.forbidden_pvt_addresses ?? []).map((a) => getAddress(a));
  const retired = retiredBaseAddresses().map((a) => getAddress(a));
  assert(PVT === livePvt9, 'SDK PVT token ' + PVT + ' is config/pvt9-base.json assets.pvt9.address ' + livePvt9);
  assert(forbidden.length > 0 && !forbidden.includes(PVT), 'SDK PVT token is not a forbidden_pvt_address (' + forbidden.length + ' checked)');
  assert(retired.length > 0 && !retired.includes(PVT), 'SDK PVT token is not a retired Base address (' + retired.length + ' checked)');
  assert(!retired.includes(POOL), 'SDK BondPool ' + POOL + ' is not a retired Base address');
  assert(USDC === getAddress(cfg.assets.usdc.address), 'SDK USDC ' + USDC + ' is config/pvt9-base.json assets.usdc.address');
}

const pub = createPublicClient({ chain: base, transport: http(RPC) });

const balOfAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const allowanceAbi = [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }];
const requiredBondAbi = [{ type: 'function', name: 'getRequiredBond', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
const totalSupplyAbi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const requiredAtPostAbi = [{ type: 'function', name: 'requiredAtPost', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const bondsAbi = [{
  type: 'function', name: 'bonds', stateMutability: 'view', inputs: [{ type: 'address' }],
  outputs: [
    { name: 'amount', type: 'uint256' }, { name: 'autonomyLevel', type: 'uint8' },
    { name: 'createdAt', type: 'uint256' }, { name: 'lastRenewalAt', type: 'uint256' },
    { name: 'renewalDeadline', type: 'uint256' }, { name: 'status', type: 'uint8' },
    { name: 'pendingClaims', type: 'uint256' },
  ],
}];

const mappingSlot = (addr, slotIndex) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(addr), BigInt(slotIndex)]));
const setStorage = (contract, slot, valueWei) =>
  pub.request({ method: 'anvil_setStorageAt', params: [contract, slot, toHex(valueWei, { size: 32 })] });
const balOf = (token, who) => pub.readContract({ address: token, abi: balOfAbi, functionName: 'balanceOf', args: [who] });
const supplyOf = (token) => pub.readContract({ address: token, abi: totalSupplyAbi, functionName: 'totalSupply' });
const getStorage = (contract, slot) => pub.getStorageAt({ address: contract, slot });

// Probe up to this many root slots when discovering a layout (both contracts sit well inside it).
const MAX_PROBE_SLOT = 256;
const SENTINEL = 0x5e5e5e5e5e5e5e5e5e5en;

/** Find the root slot of `balanceOf` by writing a sentinel and reading the getter back (then restoring). */
async function findBalanceSlot(token, who) {
  for (let i = 0; i < MAX_PROBE_SLOT; i++) {
    const key = mappingSlot(who, i);
    const orig = await getStorage(token, key);
    await setStorage(token, key, SENTINEL);
    const seen = await balOf(token, who);
    await pub.request({ method: 'anvil_setStorageAt', params: [token, key, orig ?? toHex(0n, { size: 32 })] });
    if (seen === SENTINEL) return i;
  }
  throw new Error('balanceOf slot not found for ' + token);
}

/** Find the plain slot holding `totalSupply` the same way. */
async function findTotalSupplySlot(token) {
  for (let i = 0; i < MAX_PROBE_SLOT; i++) {
    const key = toHex(BigInt(i), { size: 32 });
    const orig = await getStorage(token, key);
    await setStorage(token, key, SENTINEL);
    const seen = await supplyOf(token);
    await pub.request({ method: 'anvil_setStorageAt', params: [token, key, orig ?? toHex(0n, { size: 32 })] });
    if (seen === SENTINEL) return key;
  }
  throw new Error('totalSupply slot not found for ' + token);
}

async function main() {
  preflight();
  if (failed > 0) {
    console.log('\nPREFLIGHT FAILED — the SDK pins do not name the live PVT9 kernel / BondPool; nothing broadcast');
    process.exit(1);
  }
  if (process.env.FORK_PREFLIGHT_ONLY === '1') {
    console.log('\nPREFLIGHT PASSED (FORK_PREFLIGHT_ONLY=1: no fork contacted)');
    process.exit(0);
  }
  console.log('\nBase-fork harness @ ' + RPC + '  (chainId ' + (await pub.getChainId()) + ')');
  console.log('agent ' + AGENT.address + '  recipient ' + RECIPIENT);
  console.log('PVT ' + PVT + '  BondPool ' + POOL + '  USDC ' + USDC + '\n');

  // ---- Deal tokens (no real money; fork-local) ----
  const usdcDeal = 100_000_000n;          // 100 USDC
  const pvtDeal = 2000n * 10n ** 18n;     // 2000 PVT
  const usdcSlot = await findBalanceSlot(USDC, AGENT.address);
  await setStorage(USDC, mappingSlot(AGENT.address, usdcSlot), usdcDeal);
  const pvtSlot = await findBalanceSlot(PVT, AGENT.address);
  const pvtSupplySlot = await findTotalSupplySlot(PVT);
  const pvtHeldBefore = await balOf(PVT, AGENT.address);
  const supplyBefore = await supplyOf(PVT);
  await setStorage(PVT, mappingSlot(AGENT.address, pvtSlot), pvtDeal);
  // Keep sum(balances) <= totalSupply: raise supply by exactly what was dealt.
  await setStorage(PVT, pvtSupplySlot, supplyBefore - pvtHeldBefore + pvtDeal);
  assert((await balOf(PVT, AGENT.address)) === pvtDeal, 'dealt 2000 PVT on the PVT9 kernel (balanceOf root slot ' + pvtSlot + ')');
  assert((await balOf(USDC, AGENT.address)) === usdcDeal, 'dealt 100 USDC (balanceOf root slot ' + usdcSlot + ')');
  console.log('');

  // ---- 1. transferNative(ETH) ----
  console.log('1) transferNative(ETH)');
  const nativeAmt = parseEther('0.001');
  const rBefore = await pub.getBalance({ address: RECIPIENT });
  const nRes = await transferNative(AGENT, { to: RECIPIENT, amount: nativeAmt, chain: 'base', rpcUrl: RPC });
  const nRec = await pub.waitForTransactionReceipt({ hash: nRes.hash });
  assert(nRec.status === 'success', 'native tx accepted + mined (' + nRes.hash + ')');
  assert((await pub.getBalance({ address: RECIPIENT })) - rBefore === nativeAmt, 'recipient ETH +0.001');

  // ---- 2. transferToken(USDC) ----
  console.log('2) transferToken(USDC)');
  const usdcAmt = 1_000_000n; // 1 USDC
  const uBefore = await balOf(USDC, RECIPIENT);
  const uRes = await transferToken(AGENT, { token: 'USDC', to: RECIPIENT, amount: usdcAmt, chain: 'base', rpcUrl: RPC });
  const uRec = await pub.waitForTransactionReceipt({ hash: uRes.hash });
  assert(uRec.status === 'success', 'USDC transfer accepted + mined (' + uRes.hash + ')');
  assert((await balOf(USDC, RECIPIENT)) - uBefore === usdcAmt, 'recipient USDC +1');

  // ---- 3. transferToken(PVT) ----
  console.log('3) transferToken(PVT)');
  const pvtAmt = 10n ** 18n; // 1 PVT
  const pBefore = await balOf(PVT, RECIPIENT);
  const pRes = await transferToken(AGENT, { token: 'PVT', to: RECIPIENT, amount: pvtAmt, chain: 'base', rpcUrl: RPC });
  const pRec = await pub.waitForTransactionReceipt({ hash: pRes.hash });
  assert(pRec.status === 'success', 'PVT transfer accepted + mined (' + pRes.hash + ')');
  assert((await balOf(PVT, RECIPIENT)) - pBefore === pvtAmt, 'recipient PVT +1');

  // ---- 4. postBond: approve -> await receipt -> postBond (the CommonsInstitutions sequence) ----
  console.log('4) postBond (approve -> postBond) against the real BondPool');
  const level = 2;
  const requiredOnChain = await pub.readContract({ address: POOL, abi: requiredBondAbi, functionName: 'getRequiredBond', args: [level, 0n] });
  const basePvtWhole = Number(requiredOnChain / 10n ** 18n);
  const reqWei = requiredBondWei(basePvtWhole, 0);
  const totalDeposit = grossUpTotalDeposit(reqWei);
  // Explicit gas on the nonReentrant BondPool calls: anvil's eth_estimateGas
  // can under-provision the reentrancy-guard cleanup SSTORE (ReentrancySentryOOG).
  const BOND_GAS = 600_000n;
  const approveRes = await sendTransaction(AGENT, { to: PVT, data: encodeApprove(POOL, totalDeposit), chain: 'base', rpcUrl: RPC });
  await waitForReceipt({ chain: 'base', hash: approveRes.hash, rpcUrl: RPC });
  const allowance = await pub.readContract({ address: PVT, abi: allowanceAbi, functionName: 'allowance', args: [AGENT.address, POOL] });
  assert(allowance >= totalDeposit, 'grossed-up approval (' + totalDeposit + ') covers deposit; allowance=' + allowance);
  const postRes = await sendTransaction(AGENT, { to: POOL, data: encodePostBond(level, 0), chain: 'base', rpcUrl: RPC, gas: BOND_GAS });
  const postRec = await pub.waitForTransactionReceipt({ hash: postRes.hash });
  assert(postRec.status === 'success', 'postBond accepted + mined (' + postRes.hash + ')');
  const bond = await pub.readContract({ address: POOL, abi: bondsAbi, functionName: 'bonds', args: [AGENT.address] });
  // viem returns a multi-output getter as a positional tuple: [amount, autonomyLevel, ...].
  assert(bond[0] > 0n && Number(bond[1]) === level, 'bond is posted on-chain (amount=' + bond[0] + ', level=' + bond[1] + ')');

  // ---- 5. renewBond ----
  console.log('5) renewBond');
  const renewRes = await sendTransaction(AGENT, { to: POOL, data: encodeRenewBond(), chain: 'base', rpcUrl: RPC, gas: BOND_GAS });
  const renewRec = await pub.waitForTransactionReceipt({ hash: renewRes.hash });
  assert(renewRec.status === 'success', 'renewBond accepted + mined (' + renewRes.hash + ')');

  // ---- 6. topUpBond : restore the renewal's erosion, capped at requiredAtPost ----
  console.log('6) topUpBond (approve -> topUpBond) back to the posted requirement');
  const requiredLock = await pub.readContract({ address: POOL, abi: requiredAtPostAbi, functionName: 'requiredAtPost', args: [AGENT.address] });
  const afterRenew = await pub.readContract({ address: POOL, abi: bondsAbi, functionName: 'bonds', args: [AGENT.address] });
  const shortfall = requiredLock - afterRenew[0];
  assert(shortfall > 0n, 'renewal left a shortfall to top up (' + shortfall + ')');
  const topApprove = await sendTransaction(AGENT, { to: PVT, data: encodeApprove(POOL, shortfall), chain: 'base', rpcUrl: RPC });
  await waitForReceipt({ chain: 'base', hash: topApprove.hash, rpcUrl: RPC });
  const topRes = await sendTransaction(AGENT, { to: POOL, data: encodeTopUpBond(shortfall), chain: 'base', rpcUrl: RPC, gas: BOND_GAS });
  const topRec = await pub.waitForTransactionReceipt({ hash: topRes.hash });
  assert(topRec.status === 'success', 'topUpBond accepted + mined (' + topRes.hash + ')');
  const afterTop = await pub.readContract({ address: POOL, abi: bondsAbi, functionName: 'bonds', args: [AGENT.address] });
  assert(afterTop[0] === requiredLock, 'bond restored to requiredAtPost (' + afterTop[0] + ')');

  // ---- emit hashes for the backend verifier harness ----
  const out = {
    chainId: 8453, agent: AGENT.address, recipient: RECIPIENT, pool: POOL, pvt: PVT, usdc: USDC,
    native: { hash: nRes.hash, amountWei: nativeAmt.toString() },
    usdc_transfer: { hash: uRes.hash, amountAtomic: usdcAmt.toString() },
    pvt_transfer: { hash: pRes.hash, amountAtomic: pvtAmt.toString() },
    postBond: { hash: postRes.hash, approveHash: approveRes.hash, level, totalDeposit: totalDeposit.toString() },
    renewBond: { hash: renewRes.hash },
    topUpBond: { hash: topRes.hash, approveHash: topApprove.hash, amountAtomic: shortfall.toString() },
  };
  writeFileSync('/tmp/fork-hashes.json', JSON.stringify(out, null, 2));
  console.log('\nwrote /tmp/fork-hashes.json');
  console.log(failed === 0 ? '\nALL SDK FORK ASSERTIONS PASSED' : '\n' + failed + ' SDK FORK ASSERTIONS FAILED');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
