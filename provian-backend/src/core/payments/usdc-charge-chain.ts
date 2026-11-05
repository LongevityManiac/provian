import { CanonicalWallet } from '../onchain/canonical-wallet';
/**
 * The USDC charge path's chain side: verify the payer's USDC authorization and collect a service
 * fee on Base with Provian's charge gas key (`PAYOUT_BASE_GAS_KEY`, Secret Manager
 * `payout-base-gas-key`, its own EOA so it never races the facilitator or the minter for a nonce).
 * Every service fee (the $1 payout, the $5-per-GB PE Archive) is collected by this one key under
 * one nonce lease.
 *
 * Custody: none. `transferWithAuthorization` moves USDC from the payer straight to the revenue
 * wallet; the gas key only pays gas and can move nothing but its own ETH. The recovered signer of
 * the EIP-712 authorization must equal `from` before anything is submitted.
 */
import { Contract, JsonRpcProvider, Signature, Wallet, ethers } from 'ethers';
import { firstBlockAtOrAfter } from '../onchain/block-time-search';
import {
  BASE_USDC_ADDRESS,
  BASE_USDC_EIP712_DOMAIN,
  USDC_CHARGE_CHAIN_ID,
  USDC_CHARGE_EXPIRY_GRACE_SECONDS,
  USDC_CHARGE_RECIPIENT,
  type ChargeSearch,
  type ChargeSearchStart,
  type UsdcChargeChain,
  type UsdcChargePayment,
} from './usdc-charge';

export const USDC_CHARGE_GAS_KEY_ENV = 'PAYOUT_BASE_GAS_KEY';

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const USDC_ABI = [
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const AUTHORIZATION_USED_TOPIC = ethers.id('AuthorizationUsed(address,bytes32)');
/** Wall-clock slack; the chain may change cadence and repeat whole-second timestamps. */
export const FIND_CHARGE_SLACK_SECONDS = 300;
/**
 * 2026-10-17: Base RPC providers cap `eth_getLogs` at 500 blocks; a request with the longest
 * permitted validity (420 s = 210 blocks) plus slack spans ~510, and one over-cap call threw,
 * leaving a charge whose reply was lost `pending` forever. The search is paged to fit the cap.
 */
export const FIND_CHARGE_PAGE_BLOCKS = 500;

/** The parts of a receipt log the charge checks read (ethers `Log`). */
export interface ChargeLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  /** The log's index in its block (`logIndex`). */
  readonly index: number;
  readonly transactionHash: string;
}

/** The read-only chain calls a charge search makes (an ethers provider satisfies it). */
export interface ChargeSearchProvider {
  getBlock(tag: 'latest' | number): Promise<{ readonly number: number; readonly timestamp: number } | null>;
  getLogs(filter: { address: string; topics: (string | null)[]; fromBlock: number; toBlock: number }): Promise<readonly ChargeLog[]>;
  getTransactionReceipt(hash: string): Promise<{ readonly status: number | null; readonly logs: readonly ChargeLog[] } | null>;
}

const topicAddress = (topic: string): string => ethers.getAddress(ethers.dataSlice(topic, 12)).toLowerCase();

/**
 * Did THIS authorization move the fee in this receipt? FiatToken's `_transferWithAuthorization`
 * emits `AuthorizationUsed(from, nonce)` and then, as the very next log, the Transfer it causes
 * (verified on Base: Atlas's archive payment 0x6500f6a1…, logIndex 0x97 then 0x98). So the log
 * right after the matching AuthorizationUsed must be USDC's Transfer(from → revenue wallet, exactly
 * the authorized value). A Transfer elsewhere in the transaction proves nothing about this
 * authorization: one real fee payment could otherwise be counted for several authorizations used in
 * the same transaction.
 */
export function authorizationPaidFee(logs: readonly ChargeLog[], payment: UsdcChargePayment): boolean {
  const a = payment.authorization;
  const usdc = (log: ChargeLog): boolean => log.address.toLowerCase() === BASE_USDC_ADDRESS;
  for (const used of logs) {
    if (!usdc(used) || used.topics.length !== 3 || used.topics[0] !== AUTHORIZATION_USED_TOPIC) continue;
    if (topicAddress(used.topics[1]) !== a.from || used.topics[2].toLowerCase() !== a.nonce.toLowerCase()) continue;
    const next = logs.find((log) => log.index === used.index + 1);
    if (next === undefined || !usdc(next) || next.topics.length !== 3 || next.topics[0] !== TRANSFER_TOPIC) return false;
    return topicAddress(next.topics[1]) === a.from
      && topicAddress(next.topics[2]) === USDC_CHARGE_RECIPIENT
      && BigInt(next.data) === BigInt(a.value);
  }
  return false;
}

/**
 * Search the chain for this authorization's charge. The window runs from the Base block recorded
 * when the request was made (or, for a request without one, the block at its time) to the block at
 * `validBefore`, finding timestamp boundaries from actual canonical blocks. This
 * includes every block sharing a second and ranges crossing a cadence change.
 * `windowClosed` only when Base's head itself is past `validBefore` + grace:
 * chain time, so a sequencer stall or a lagging RPC keeps the charge pending rather than failed.
 */
export async function findChargeVia(
  provider: ChargeSearchProvider,
  payment: UsdcChargePayment,
  since: ChargeSearchStart,
): Promise<ChargeSearch> {
  const a = payment.authorization;
  const head = await provider.getBlock('latest');
  if (head === null) throw new Error('usdc_charge_head_unavailable');
  const validBefore = Number(a.validBefore);
  const cache = new Map<number, { readonly number: number; readonly timestamp: number }>([[head.number, head]]);
  const read = async (height: number) => {
    const cached = cache.get(height);
    if (cached) return cached;
    const block = await provider.getBlock(height);
    if (block) cache.set(height, block);
    return block;
  };
  const first = await firstBlockAtOrAfter(read, head, Math.floor(since.ms / 1000) - FIND_CHARGE_SLACK_SECONDS);
  const fromBlock = Math.max(0, since.block === null ? first : Math.min(since.block, first));
  const toBlock = Math.min(head.number,
    (await firstBlockAtOrAfter(read, head, validBefore + FIND_CHARGE_SLACK_SECONDS + 1)) - 1);
  const windowClosed = head.timestamp >= validBefore + USDC_CHARGE_EXPIRY_GRACE_SECONDS;
  if (toBlock < fromBlock) return { txHash: null, windowClosed };
  for (let pageFrom = fromBlock; pageFrom <= toBlock; pageFrom += FIND_CHARGE_PAGE_BLOCKS) {
    const pageTo = Math.min(toBlock, pageFrom + FIND_CHARGE_PAGE_BLOCKS - 1);
    const logs = await provider.getLogs({
      address: BASE_USDC_ADDRESS,
      topics: [AUTHORIZATION_USED_TOPIC, ethers.zeroPadValue(a.from, 32), a.nonce.toLowerCase()],
      fromBlock: pageFrom,
      toBlock: pageTo,
    });
    for (const log of logs) {
      const receipt = await provider.getTransactionReceipt(log.transactionHash);
      if (receipt === null) throw new Error('usdc_charge_receipt_unavailable');
      if (receipt.status === 1 && authorizationPaidFee(receipt.logs, payment)) {
        return { txHash: String(log.transactionHash).toLowerCase(), windowClosed };
      }
    }
  }
  return { txHash: null, windowClosed };
}

/** The OP-stack gas price oracle predeploy on Base (L1 data fee). */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const GAS_PRICE_ORACLE_ABI = ['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)'];

/** The address that signed this authorization, lowercased (throws on a malformed signature). */
export function recoverUsdcChargeSigner(payment: UsdcChargePayment): string {
  return ethers.verifyTypedData(
    BASE_USDC_EIP712_DOMAIN,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    payment.authorization,
    payment.signature,
  ).toLowerCase();
}

export function createUsdcChargeChain(params: { rpcUrl: string; gasKey: string }): UsdcChargeChain {
  const provider = new JsonRpcProvider(params.rpcUrl, USDC_CHARGE_CHAIN_ID, { staticNetwork: true });
  const signer = new CanonicalWallet(params.gasKey, provider);
  const usdcRead = new Contract(BASE_USDC_ADDRESS, USDC_ABI, provider);
  const usdcWrite = new Contract(BASE_USDC_ADDRESS, USDC_ABI, signer);
  const oracle = new Contract(GAS_PRICE_ORACLE, GAS_PRICE_ORACLE_ABI, provider);
  return {
    gasAddress: signer.address.toLowerCase(),
    authorizationUsed: async (from, nonce) => Boolean(await usdcRead.authorizationState(from, nonce)),
    usdcBalance: async (address) => BigInt(await usdcRead.balanceOf(address)),
    gasBalanceWei: async () => provider.getBalance(signer.address),
    gasPriceWei: async () => {
      const fee = await provider.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      if (price === null) throw new Error('payout_gas_price_unavailable');
      return price;
    },
    l1FeeUpperBoundWei: async (bytes) => BigInt(await oracle.getL1FeeUpperBound(bytes)),
    submitCharge: async (payment) => {
      const sig = Signature.from(payment.signature);
      const a = payment.authorization;
      const tx = await usdcWrite.transferWithAuthorization(
        a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig.v, sig.r, sig.s,
      );
      return String(tx.hash).toLowerCase();
    },
    confirmCharge: async (txHash, payment) => {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt === null) return 'pending';
      if (receipt.status !== 1) return 'reverted';
      return authorizationPaidFee(receipt.logs, payment) ? 'confirmed' : 'reverted';
    },
    headBlock: async () => provider.getBlockNumber(),
    findCharge: async (payment, since) => findChargeVia(provider, payment, since),
  };
}
