#!/usr/bin/env node
/**
 * Deploy `ProvianX402FeeSettler` on Base for the PVT token the permanent protocol pointer names now.
 *
 *   forge build --root ../contracts
 *   BASE_RPC_URL=… node scripts/deploy-fee-settler.mjs              # dry run: prints what would be deployed
 *   BASE_RPC_URL=… node scripts/deploy-fee-settler.mjs --broadcast  # deploys, then verifies every immutable
 *
 * The deployer is the facilitator's Base gas wallet (the settler's operator and fee recipient). Its
 * key is read from Secret Manager inside this process and is never a command-line argument, an
 * environment variable or printed output. The settler has immutables only: no owner, no setters.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, getAddress, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GAS_WALLET = '0xA37fC594E98e951571C771C9e77CDC73f67d3efB';
const PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
const POINTER = '0x619eAe740CE56C5a8edbB2B047E58369281ddAD7';
const MAX_FEE = 50_000n;

const abi = [
  { type: 'constructor', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }], stateMutability: 'nonpayable' },
  ...['usdc', 'operator', 'feeRecipient', 'permit2Proxy', 'pvt'].map((name) => ({ type: 'function', name, inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' })),
  { type: 'function', name: 'MAX_FEE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];
const pointerAbi = [{ type: 'function', name: 'component', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' }];

const fail = (message) => { console.error(`deploy-fee-settler: ${message}`); process.exit(1); };
const broadcast = process.argv.includes('--broadcast');
const rpcUrl = process.env.BASE_RPC_URL;
if (!rpcUrl) fail('BASE_RPC_URL is not set');

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(here, '../../contracts/out/ProvianX402FeeSettler.sol/ProvianX402FeeSettler.json'), 'utf8'));
const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
if ((await pub.getChainId()) !== 8453) fail('the RPC is not Base mainnet');

const pvt = getAddress(await pub.readContract({ address: POINTER, abi: pointerAbi, functionName: 'component', args: [0n] }));
const args = [USDC, GAS_WALLET, GAS_WALLET, PERMIT2_PROXY, pvt];
const data = encodeDeployData({ abi, bytecode: artifact.bytecode.object, args });
const gas = await pub.estimateGas({ account: GAS_WALLET, data });
const fees = await pub.estimateFeesPerGas();
const balance = await pub.getBalance({ address: GAS_WALLET });
console.log(JSON.stringify({ pvt, constructor_args: args, gas: gas.toString(), max_cost_wei: (gas * fees.maxFeePerGas).toString(), deployer_balance_wei: balance.toString() }, null, 2));
if (balance < gas * fees.maxFeePerGas * 2n) fail('the gas wallet cannot cover the deployment twice over');
if (!broadcast) { console.log('dry run: nothing sent (pass --broadcast to deploy)'); process.exit(0); }

const key = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=facilitator-base-gas-key', '--project=provian-ai'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
if (!isAddressEqual(account.address, GAS_WALLET)) fail('the secret is not the facilitator gas wallet key');
const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
const hash = await wallet.sendTransaction({ data, gas: (gas * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
console.log(`deploy tx ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 3 });
if (receipt.status !== 'success' || !receipt.contractAddress) fail(`deployment failed (${receipt.status})`);
const address = getAddress(receipt.contractAddress);

const read = (functionName) => pub.readContract({ address, abi, functionName });
const [usdc, operator, feeRecipient, permit2Proxy, boundPvt, maxFee] = await Promise.all(
  ['usdc', 'operator', 'feeRecipient', 'permit2Proxy', 'pvt', 'MAX_FEE'].map(read));
const ok = isAddressEqual(usdc, USDC) && isAddressEqual(operator, GAS_WALLET) && isAddressEqual(feeRecipient, GAS_WALLET)
  && isAddressEqual(permit2Proxy, PERMIT2_PROXY) && isAddressEqual(boundPvt, pvt) && maxFee === MAX_FEE;
if (!ok) fail(`immutables on ${address} do not match`);
console.log(JSON.stringify({ address, deploy_tx: hash, block: Number(receipt.blockNumber), deployer: account.address, constructor_args: { usdc, operator, feeRecipient, permit2Proxy, pvt: boundPvt }, max_fee: maxFee.toString() }, null, 2));
