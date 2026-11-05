/**
 * The Base chain surface the facilitator needs, behind an interface so every refusal path is
 * unit-testable without a node, and the real one (viem) is exercised end-to-end on an anvil fork.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
  type Log,
  type PublicClient,
  type Transport,
  type Chain,
} from 'viem';
import { TransactionReceiptNotFoundError } from 'viem';
import { base } from 'viem/chains';
import { estimateL1Fee } from 'viem/op-stack';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { FacilitatorEvmSigner } from '@x402/evm';
import { settlerAbi, erc20Abi, chainlinkAbi } from './abi.js';
import { BASE_CHAINLINK_ETH_USD } from '../constants.js';
import { randomUUID } from 'node:crypto';
import { sendWithCanonicalNonce, type NonceJournalStore, type SignedNonceAttempt } from '../canonical-nonce.js';

export interface Eip3009Call {
  readonly kind: 'eip3009';
  readonly buyer: `0x${string}`;
  readonly seller: `0x${string}`;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
  readonly signature: Hex;
  readonly fee: bigint;
}

export interface Permit2Call {
  readonly kind: 'permit2';
  readonly token: `0x${string}`;
  readonly amount: bigint;
  readonly permitNonce: bigint;
  readonly deadline: bigint;
  readonly buyer: `0x${string}`;
  readonly seller: `0x${string}`;
  readonly validAfter: bigint;
  readonly signature: Hex;
  readonly fee: bigint;
}

export type SettleCall = Eip3009Call | Permit2Call;

export interface Receipt {
  readonly status: 'success' | 'reverted';
  readonly logs: readonly Log[];
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

export interface BaseChain {
  readonly operator: `0x${string}`;
  readonly settler: `0x${string}`;
  /** Verification-only signer for @x402/evm's ExactEvmScheme: every write method throws. */
  readonly verifySigner: FacilitatorEvmSigner;
  encodeSettle(call: SettleCall): Hex;
  estimateSettleGas(call: SettleCall): Promise<bigint>;
  /** eth_call of the exact settle call from the operator; throws on revert. */
  simulateSettle(call: SettleCall): Promise<void>;
  latestBaseFee(): Promise<bigint>;
  priorityFee(): Promise<bigint>;
  l1Fee(data: Hex, gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<bigint>;
  ethUsd(): Promise<{ answer: bigint; decimals: number; updatedAt: number }>;
  allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
  balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint>;
  nativeBalance(addr: `0x${string}`): Promise<bigint>;
  /**
   * Sign the settlement, hand its hash to `beforeBroadcast` (the facilitator records it durably),
   * THEN broadcast (2026-10-17). A broadcast failure after the hash was handed out throws
   * {@link BroadcastError}; any other failure happened before anything could reach the chain.
   */
  sendSettle(
    call: SettleCall,
    gas: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    beforeBroadcast?: (hash: Hex) => Promise<void>,
  ): Promise<Hex>;
  waitReceipt(hash: Hex, timeoutMs: number): Promise<Receipt>;
  /** The receipt if the node has mined this hash, null when it has not; throws when the lookup itself fails. */
  getReceipt(hash: Hex): Promise<Receipt | null>;
  readSettlerConfig(): Promise<{ usdc: string; operator: string; feeRecipient: string; permit2Proxy: string; pvt: string; maxFee: bigint }>;
  /** Raw contract write from the operator (refill/sweep only). */
  sendRaw(to: `0x${string}`, data: Hex, value: bigint): Promise<Hex>;
}

function settleArgs(call: SettleCall) {
  if (call.kind === 'eip3009') {
    return {
      functionName: 'settleWithAuthorization' as const,
      args: [call.buyer, call.seller, call.value, call.validAfter, call.validBefore, call.nonce, call.signature, call.fee] as const,
    };
  }
  return {
    functionName: 'settleWithPermit2' as const,
    args: [
      { permitted: { token: call.token, amount: call.amount }, nonce: call.permitNonce, deadline: call.deadline },
      call.buyer,
      { to: call.seller, validAfter: call.validAfter },
      call.signature,
      call.fee,
    ] as const,
  };
}

/** The signed settlement may or may not have reached the chain: its hash is known, its outcome is not. */
export class BroadcastError extends Error {
  constructor(readonly hash: Hex, readonly cause: unknown) {
    super(`broadcast failed for ${hash}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BroadcastError';
  }
}

export function encodeSettleCall(call: SettleCall): Hex {
  const a = settleArgs(call);
  return a.functionName === 'settleWithAuthorization'
    ? encodeFunctionData({ abi: settlerAbi, functionName: a.functionName, args: a.args })
    : encodeFunctionData({ abi: settlerAbi, functionName: a.functionName, args: a.args });
}

/** Recovery records must bind the exact wire bytes to their signer and business call. */
export async function assertOperatorAttempt(attempt: SignedNonceAttempt, operator: string, chainId: number): Promise<void> {
  const raw = attempt.raw as TransactionSerialized;
  const decoded = parseTransaction(raw);
  const sender = await recoverTransactionAddress({ serializedTransaction: raw });
  const call = `${decoded.to?.toLowerCase()}:${(decoded.data ?? '0x').toLowerCase()}`;
  const value = decoded.value ?? 0n;
  const intents = value === 0n ? [call, `${call}:0`] : [`${call}:${value}`];
  if (keccak256(raw) !== attempt.hash || sender.toLowerCase() !== operator.toLowerCase()
    || decoded.chainId !== chainId || decoded.nonce !== attempt.nonce
    || !intents.includes(attempt.intent.toLowerCase())) throw new Error('nonce_attempt_binding_invalid');
}

/** One sender at a time: the operator's nonce is never raced by two concurrent settlements. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function createViemBaseChain(opts: {
  rpcUrl: string;
  account: PrivateKeyAccount;
  settler: `0x${string}`;
  chain?: Chain;
  nonceStore: NonceJournalStore;
}): BaseChain {
  const chain = opts.chain ?? base;
  const transport: Transport = http(opts.rpcUrl, { timeout: 20_000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const operator = opts.account.address;
  const sendLock = new Mutex();
  const send = async (
    intent: string,
    prepare: (nonce: number) => Promise<Hex>,
    beforeBroadcast?: (hash: Hex) => Promise<void>,
    resumeSameIntent = false,
  ): Promise<Hex> => {
    const attempt = await sendWithCanonicalNonce({
      store: opts.nonceStore, now: Date.now, owner: randomUUID,
      latestNonce: () => pub.getTransactionCount({ address: operator, blockTag: 'latest' }),
      finalizedNonce: async () => {
        const head = await pub.getBlockNumber();
        return pub.getTransactionCount({ address: operator, blockNumber: head > 11n ? head - 11n : 0n });
      },
      canReplay: true,
      broadcast: async (a: SignedNonceAttempt) => {
        await assertOperatorAttempt(a, operator, chain.id);
        try { await pub.sendRawTransaction({ serializedTransaction: a.raw as Hex }); }
        catch (error) {
          if (!/already known|already imported/i.test(String(error))) throw new BroadcastError(a.hash as Hex, error);
        }
      },
    }, `${chain.id}_${operator.toLowerCase()}`, intent, async (nonce) => {
      const raw = await prepare(nonce);
      return { nonce, raw, hash: keccak256(raw) };
    }, { resumeSameIntent, beforeBroadcast: beforeBroadcast ? (hash) => beforeBroadcast(hash as Hex) : undefined });
    return attempt.hash as Hex;
  };

  const refuseWrite = async (): Promise<never> => {
    throw new Error('verification signer cannot write');
  };

  const verifySigner: FacilitatorEvmSigner = {
    getAddresses: () => [operator],
    readContract: (args) =>
      pub.readContract({
        address: args.address,
        abi: args.abi as readonly unknown[] as never,
        functionName: args.functionName as never,
        args: (args.args ?? []) as never,
        account: operator,
      }) as Promise<unknown>,
    verifyTypedData: (args) =>
      pub.verifyTypedData({
        address: args.address,
        domain: args.domain as never,
        types: args.types as never,
        primaryType: args.primaryType as never,
        message: args.message as never,
        signature: args.signature,
      }),
    writeContract: refuseWrite,
    sendTransaction: refuseWrite,
    waitForTransactionReceipt: refuseWrite,
    getCode: async (args) => (await pub.getCode({ address: args.address })) ?? undefined,
  };

  return {
    operator,
    settler: opts.settler,
    verifySigner,
    encodeSettle: encodeSettleCall,
    async estimateSettleGas(call) {
      return pub.estimateGas({ account: operator, to: opts.settler, data: encodeSettleCall(call) });
    },
    async simulateSettle(call) {
      await pub.call({ account: operator, to: opts.settler, data: encodeSettleCall(call) });
    },
    async latestBaseFee() {
      const block = await pub.getBlock({ blockTag: 'latest' });
      if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) throw new Error('no base fee');
      return block.baseFeePerGas;
    },
    async priorityFee() {
      return pub.estimateMaxPriorityFeePerGas();
    },
    async l1Fee(data, gas, maxFeePerGas, maxPriorityFeePerGas) {
      return estimateL1Fee(pub, {
        account: operator,
        chain,
        to: opts.settler,
        data,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    },
    async ethUsd() {
      const [round, decimals] = await Promise.all([
        pub.readContract({ address: BASE_CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: 'latestRoundData' }),
        pub.readContract({ address: BASE_CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: 'decimals' }),
      ]);
      return { answer: round[1], decimals: Number(decimals), updatedAt: Number(round[3]) };
    },
    async allowance(token, owner, spender) {
      return pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
    },
    async balanceOf(token, owner) {
      return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    },
    async nativeBalance(addr) {
      return pub.getBalance({ address: addr });
    },
    async sendSettle(call, gas, maxFeePerGas, maxPriorityFeePerGas, beforeBroadcast) {
      return sendLock.run(async () => {
        // Sign locally so the hash exists BEFORE the network sees the transaction: the facilitator
        // writes `submitted` + hash first, and a store or instance failure can no longer strand a
        // broadcast payment behind a record that knows no hash (2026-10-17).
        const data = encodeSettleCall(call);
        return send(`${opts.settler}:${data}`, (nonce) => opts.account.signTransaction({
          type: 'eip1559', chainId: chain.id, to: opts.settler, data,
          value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas, nonce,
        }), beforeBroadcast, true);
      });
    },
    async waitReceipt(hash, timeoutMs) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      return { status: r.status, logs: r.logs, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
    },
    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        return { status: r.status, logs: r.logs, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null; // the node knows no receipt: not mined
        throw err; // the lookup failed: outcome unknown
      }
    },
    async readSettlerConfig() {
      const [usdc, operatorOnChain, feeRecipient, permit2Proxy, pvt, maxFee] = await Promise.all([
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'usdc' }),
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'operator' }),
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'feeRecipient' }),
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'permit2Proxy' }),
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'pvt' }),
        pub.readContract({ address: opts.settler, abi: settlerAbi, functionName: 'MAX_FEE' }),
      ]);
      return { usdc, operator: operatorOnChain, feeRecipient, permit2Proxy, pvt, maxFee };
    },
    async sendRaw(to, data, value) {
      return sendLock.run(async () => {
        const [gas, fees] = await Promise.all([
          pub.estimateGas({ account: opts.account, prepare: false, to, data, value }), pub.estimateFeesPerGas(),
        ]);
        return send(`${to}:${data}:${value}`, (nonce) => opts.account.signTransaction({
          type: 'eip1559', chainId: chain.id, to, data, value, nonce, gas,
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }));
      });
    },
  };
}
