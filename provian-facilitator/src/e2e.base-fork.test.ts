/**
 * End to end on a Base mainnet fork (anvil): the REAL settler bytecode, REAL Base USDC (EIP-3009),
 * REAL Permit2 + x402's exact Permit2 proxy + PVT9, REAL Chainlink + GasPriceOracle, and @x402/evm's
 * REAL ExactEvmScheme verification — verify → settle through Provian's facilitator.
 *
 * Proves: the payment lands with the seller and the fee lands at the fee recipient in ONE transaction;
 * a settlement whose fee cannot be collected is never broadcast (operator nonce and ETH unchanged).
 *
 * Runs when `BASE_FORK_RPC_URL` is set and `anvil` is on PATH; otherwise it is skipped and says so.
 *   BASE_FORK_RPC_URL=https://mainnet.base.org npx vitest run src/e2e.base-fork.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NonceJournal } from './canonical-nonce.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  pad,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createViemBaseChain } from './base/chain.js';
import { BaseFacilitator } from './base/facilitator.js';
import { chainlinkAbi, erc20Abi } from './base/abi.js';
import { usdcAtomicFromWei } from './fee-math.js';
import { MemoryStore } from './store.js';
import { recordingWitness, seller, noFetch } from './test-support/fakes.js';
import { BASE_CHAINLINK_ETH_USD, BASE_PVT, BASE_USDC, PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY } from './constants.js';
import type { Payload, Requirements } from './x402-types.js';

const FORK = process.env.BASE_FORK_RPC_URL;
const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
const enabled = Boolean(FORK) && hasAnvil;

// Fresh keys per run (anvil's well-known dev keys carry EIP-7702 delegation code on Base mainnet,
// which makes them smart wallets to x402's verifier). Funded with fork-only ETH via anvil_setBalance.
const OPERATOR_KEY = generatePrivateKey();
const SELLER_KEY = generatePrivateKey();
const BUYER_KEY = generatePrivateKey();
const FEE_RECIPIENT_KEY = generatePrivateKey();
const operator = privateKeyToAccount(OPERATOR_KEY);
const sellerAcct = privateKeyToAccount(SELLER_KEY);
const buyer = privateKeyToAccount(BUYER_KEY);
const feeRecipient = privateKeyToAccount(FEE_RECIPIENT_KEY);

const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
let anvil: ChildProcess | null = null;
let pub: PublicClient;
let settler: `0x${string}`;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function balance(token: `0x${string}`, who: `0x${string}`): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

/** Set an ERC-20 balance by finding its mapping slot (like forge's `deal`). */
async function deal(token: `0x${string}`, who: `0x${string}`, amount: bigint): Promise<void> {
  for (let slot = 0n; slot < 64n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, slot]));
    const prior = (await rpc('eth_getStorageAt', [token, key, 'latest'])) as Hex;
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })]);
    if ((await balance(token, who)) === amount) return;
    await rpc('anvil_setStorageAt', [token, key, prior]);
  }
  throw new Error(`no balance slot found for ${token}`);
}

/** Actual cost of a receipt (L2 gas + OP-stack L1 fee) in USDC at the fork's Chainlink price, rounded up. */
async function expectFeeCovers(rc: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null }, charged: bigint): Promise<void> {
  const [, answer] = await pub.readContract({ address: BASE_CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: 'latestRoundData' });
  const actualWei = rc.gasUsed * rc.effectiveGasPrice + (rc.l1Fee ?? 0n);
  const actualUsdc = usdcAtomicFromWei(actualWei, answer, 8);
  expect(charged).toBeGreaterThanOrEqual(actualUsdc + 300n);
}

const wallet = (key: `0x${string}`) => createWalletClient({ chain: base, transport: http(RPC), account: privateKeyToAccount(key) });

function usdcReq(amount: bigint): Requirements {
  return { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount: amount.toString(), payTo: sellerAcct.address, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } };
}

async function eip3009Payload(r: Requirements, nonce: Hex): Promise<Payload> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = { from: buyer.address, to: sellerAcct.address, value: BigInt(r.amount), validAfter: 0n, validBefore: now + 3600n, nonce };
  const signature = await buyer.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  return {
    x402Version: 2,
    accepted: r,
    payload: {
      signature,
      authorization: {
        from: buyer.address,
        to: sellerAcct.address,
        value: r.amount,
        validAfter: '0',
        validBefore: authorization.validBefore.toString(),
        nonce,
      },
    },
  };
}

describe.skipIf(!enabled)('e2e on a Base fork: verify → settle through Provian\'s facilitator', () => {
  let store: MemoryStore;
  let witness: ReturnType<typeof recordingWitness>;
  let fac: BaseFacilitator;

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', FORK!, '--port', String(PORT), '--chain-id', '8453', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await rpc('eth_chainId', []);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    pub = createPublicClient({ chain: base, transport: http(RPC) }) as PublicClient;
    for (const a of [operator, sellerAcct, buyer, feeRecipient]) await rpc('anvil_setBalance', [a.address, toHex(10n ** 18n)]);
    const here = dirname(fileURLToPath(import.meta.url));
    const artifact = JSON.parse(readFileSync(join(here, '../../contracts/out/ProvianX402FeeSettler.sol/ProvianX402FeeSettler.json'), 'utf8')) as { bytecode: { object: Hex } };
    const deployer = wallet(OPERATOR_KEY);
    const hash = await deployer.deployContract({
      abi: [{ type: 'constructor', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }], stateMutability: 'nonpayable' }],
      bytecode: artifact.bytecode.object,
      args: [BASE_USDC, operator.address, feeRecipient.address, X402_EXACT_PERMIT2_PROXY, BASE_PVT],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    settler = receipt.contractAddress!;

    await deal(BASE_USDC, buyer.address, 100_000_000n);
    await deal(BASE_PVT, buyer.address, 100n * 10n ** 18n);
    // The seller's one-time fee approval to the settler (the seller pays its own gas — no sponsored approvals).
    await pub.waitForTransactionReceipt({ hash: await wallet(SELLER_KEY).writeContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'approve', args: [settler, 1_000_000n] }) });

    store = new MemoryStore();
    await store.upsertSeller(seller('base', sellerAcct.address, { pvt_prices: [{ resource: '/report', amount_atomic: (5n * 10n ** 18n).toString() }] }));
    witness = recordingWitness();
    fac = new BaseFacilitator({
      chain: createViemBaseChain({ rpcUrl: RPC, account: operator, settler, nonceStore: (() => {
        let state: NonceJournal | null = null;
        return { transact: async (_key, change) => { state = change(state); return state; } };
      })() }),
      store,
      relayUrl: 'https://relay.invalid',
      fetch: noFetch,
      witness: witness.reporter,
      priceMaxAgeSeconds: 6 * 3600,
      now: () => Date.now(),
      feeRecipient: feeRecipient.address,
    });
  }, 120_000);

  afterAll(() => {
    anvil?.kill('SIGKILL');
  });

  it('USDC: the payment lands with the seller and the fee with Provian, in one transaction; both parties witnessed', async () => {
    const amount = 1_000_000n; // $1
    const r = usdcReq(amount);
    const p = await eip3009Payload(r, keccak256(toHex('e2e-usdc-1')));
    const v = await fac.verify(p, r);
    expect(`${v.invalidReason ?? ''} ${v.invalidMessage ?? ''}`.trim()).toBe('');
    expect(v).toMatchObject({ isValid: true });
    const fee = BigInt((v.extra as { provianFee: { amount: string } }).provianFee.amount);
    expect(fee).toBeGreaterThan(300n);

    const before = { seller: await balance(BASE_USDC, sellerAcct.address), fee: await balance(BASE_USDC, feeRecipient.address), buyer: await balance(BASE_USDC, buyer.address) };
    const s = await fac.settle(p, r);
    expect(s.errorReason).toBeUndefined();
    expect(s.success).toBe(true);
    const rc = await pub.getTransactionReceipt({ hash: s.transaction as Hex });
    expect(rc.to?.toLowerCase()).toBe(settler.toLowerCase());
    const charged = BigInt((s.extra as { provianFee: { amount: string } }).provianFee.amount);
    expect(await balance(BASE_USDC, sellerAcct.address)).toBe(before.seller + amount - charged);
    expect(await balance(BASE_USDC, feeRecipient.address)).toBe(before.fee + charged);
    expect(await balance(BASE_USDC, buyer.address)).toBe(before.buyer - amount);
    // The fee covers what the transaction actually cost: gas used × effective price + the L1 data fee, in USDC.
    await expectFeeCovers(rc, charged);
    console.log(`[e2e] eip3009 settle gasUsed=${rc.gasUsed} fee=${charged} atomic USDC`);
    expect(witness.reports.at(-1)).toMatchObject({ chain: 'base', tx_hash: s.transaction, buyer: buyer.address.toLowerCase(), seller: sellerAcct.address.toLowerCase(), scheme: 'eip3009' });

    // Replaying the same authorization settles nothing new.
    const again = await fac.settle(p, r);
    expect(again).toMatchObject({ success: true, transaction: s.transaction });
  });

  it('RED: a fee that cannot be collected is never broadcast and costs nothing', async () => {
    // The seller withdraws its fee approval.
    await pub.waitForTransactionReceipt({ hash: await wallet(SELLER_KEY).writeContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'approve', args: [settler, 0n] }) });
    const r = usdcReq(2_000_000n);
    const p = await eip3009Payload(r, keccak256(toHex('e2e-usdc-uncollectable')));
    const nonceBefore = await pub.getTransactionCount({ address: operator.address });
    const ethBefore = await pub.getBalance({ address: operator.address });
    const s = await fac.settle(p, r);
    expect(s).toMatchObject({ success: false, errorReason: 'fee_uncollectable' });
    expect(await pub.getTransactionCount({ address: operator.address })).toBe(nonceBefore);
    expect(await pub.getBalance({ address: operator.address })).toBe(ethBefore);
    // Control: restore the approval and the same authorization settles.
    await pub.waitForTransactionReceipt({ hash: await wallet(SELLER_KEY).writeContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'approve', args: [settler, 1_000_000n] }) });
    expect((await fac.settle(p, r)).success).toBe(true);
  });

  it('PVT through x402\'s Permit2 proxy: PVT to the seller, USDC fee from the seller, one transaction', async () => {
    // The buyer's own one-time Permit2 approval for PVT (PVT has no gasless signed transfer).
    await pub.waitForTransactionReceipt({ hash: await wallet(BUYER_KEY).writeContract({ address: BASE_PVT, abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] }) });
    const amount = 5n * 10n ** 18n;
    const r: Requirements = { scheme: 'exact', network: 'eip155:8453', asset: BASE_PVT, amount: amount.toString(), payTo: sellerAcct.address, maxTimeoutSeconds: 60, extra: {} };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = 0xabcdefn;
    const signature = await buyer.signTypedData({
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'Witness' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        Witness: [
          { name: 'to', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
        ],
      },
      primaryType: 'PermitWitnessTransferFrom',
      message: { permitted: { token: BASE_PVT, amount }, spender: X402_EXACT_PERMIT2_PROXY, nonce, deadline, witness: { to: sellerAcct.address, validAfter: 0n } },
    });
    const p: Payload = {
      x402Version: 2,
      accepted: r,
      payload: {
        signature,
        permit2Authorization: {
          from: buyer.address,
          permitted: { token: BASE_PVT, amount: amount.toString() },
          spender: X402_EXACT_PERMIT2_PROXY,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          witness: { to: sellerAcct.address, validAfter: '0' },
        },
      },
    };
    // The PVT seller's fee comes from its own USDC.
    await deal(BASE_USDC, sellerAcct.address, 5_000_000n);
    const before = { pvt: await balance(BASE_PVT, sellerAcct.address), usdc: await balance(BASE_USDC, sellerAcct.address), fee: await balance(BASE_USDC, feeRecipient.address) };
    const s = await fac.settle(p, r);
    expect(`${s.errorReason ?? ''} ${s.errorMessage ?? ''}`.trim()).toBe('');
    expect(s.success).toBe(true);
    const charged = BigInt((s.extra as { provianFee: { amount: string } }).provianFee.amount);
    expect(await balance(BASE_PVT, sellerAcct.address)).toBe(before.pvt + amount);
    expect(await balance(BASE_USDC, sellerAcct.address)).toBe(before.usdc - charged);
    expect(await balance(BASE_USDC, feeRecipient.address)).toBe(before.fee + charged);
    const rc = await pub.getTransactionReceipt({ hash: s.transaction as Hex });
    await expectFeeCovers(rc, charged);
    console.log(`[e2e] permit2 settle gasUsed=${rc.gasUsed} fee=${charged} atomic USDC`);
    expect(witness.reports.at(-1)).toMatchObject({ scheme: 'permit2', asset: BASE_PVT.toLowerCase(), amount: amount.toString() });
  });
});

describe.skipIf(enabled)('e2e on a Base fork (skipped)', () => {
  it('set BASE_FORK_RPC_URL and install anvil to run the fork end-to-end test', () => {
    expect(enabled).toBe(false);
  });
});
