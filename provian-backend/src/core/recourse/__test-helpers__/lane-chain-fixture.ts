import { Transaction, Wallet, keccak256, type TransactionRequest } from 'ethers';
import type { LaneChain } from '../transaction-lane';
import type { FinalizedOwnerTransaction } from '../transaction-finality';

/** A small simulated Base: one account's nonce, a mempool, two-second blocks,
 * receipts and the twelve-confirmation rule. Public deterministic test key. */
export const LANE_TEST_KEY = `0x${'5a'.repeat(32)}`;
export function laneTestWallet(): Wallet { return new Wallet(LANE_TEST_KEY); }

export interface SimulatedBase extends LaneChain {
  readonly state: {
    head: number; baseFee: bigint; balance: bigint; latest: number;
    mempool: Map<number, string>;
    mined: Map<string, { block: number; status: 0 | 1; nonce: number }>;
    broadcasts: string[];
    failBroadcasts: number;
    /** Transactions with maxFee below this are never included. */
    inclusionFloor: bigint;
    /** Receipt status per transaction; defaults to success. */
    status(raw: string): 0 | 1;
    /** Highest number of unmined transactions seen at once. */
    maxPending: number;
    estimateCalls: number;
  };
  /** Produce one block, including every contiguous mempool transaction that pays the floor. */
  mine(): number;
  /** Produce `n` blocks. */
  advance(n: number): void;
  /** Mark another writer using the key. */
  foreign(): void;
  /** Two seconds of chain time per mined block. */
  elapsedMs(): number;
  /** Wall time plus elapsed chain time, for a lane run's clock. */
  now(): number;
}

export function simulatedBase(address: string, options: { balance?: bigint; baseFee?: bigint } = {}): SimulatedBase {
  const state: SimulatedBase['state'] = {
    head: 1_000, baseFee: options.baseFee ?? 10_000_000n, balance: options.balance ?? 10n ** 18n, latest: 0,
    mempool: new Map(), mined: new Map(), broadcasts: [], failBroadcasts: 0, inclusionFloor: 0n,
    status: () => 1, maxPending: 0, estimateCalls: 0,
  };
  const pending = () => { let n = state.latest; while (state.mempool.has(n)) n++; return n; };
  let elapsed = 0;
  const chain: SimulatedBase = {
    state,
    async nonces(who) {
      if (who.toLowerCase() !== address.toLowerCase()) throw Error('wrong_address');
      return { latest: state.latest, pending: pending() };
    },
    async baseFee() { return state.baseFee; },
    async estimateGas() { state.estimateCalls++; return 100_000n; },
    async cost(unsigned: TransactionRequest) { return BigInt(unsigned.gasLimit!.toString()) * BigInt(unsigned.maxFeePerGas!.toString()) + 1_000n; },
    async balance() { return state.balance; },
    async broadcast(raw) {
      if (state.failBroadcasts > 0) { state.failBroadcasts--; throw Error('recourse_lane_broadcast_failed'); }
      state.broadcasts.push(raw);
      const tx = Transaction.from(raw);
      if (tx.from?.toLowerCase() !== address.toLowerCase()) throw Error('wrong_sender');
      if (tx.nonce < state.latest) return; // already mined
      const prior = state.mempool.get(tx.nonce);
      if (prior && prior !== raw) {
        const old = Transaction.from(prior);
        if (tx.maxFeePerGas! < old.maxFeePerGas! * 11n / 10n) throw Error('replacement transaction underpriced');
      }
      state.mempool.set(tx.nonce, raw);
      state.maxPending = Math.max(state.maxPending, state.mempool.size);
    },
    async confirmed(raw): Promise<FinalizedOwnerTransaction | null> {
      const hash = keccak256(raw), mined = state.mined.get(hash);
      if (!mined) return null;
      if (state.head - mined.block + 1 < 12) throw Error('recourse_transaction_not_finalized');
      return { transactionHash: hash, blockHash: `0x${mined.block.toString(16).padStart(64, '0')}`, block: mined.block, status: mined.status };
    },
    mine() {
      state.head++; elapsed += 2_000;
      let included = 0;
      while (state.mempool.has(state.latest)) {
        const raw = state.mempool.get(state.latest)!, tx = Transaction.from(raw);
        if (tx.maxFeePerGas! < state.baseFee || tx.maxFeePerGas! < state.inclusionFloor) break;
        state.mined.set(keccak256(raw), { block: state.head, status: state.status(raw), nonce: tx.nonce });
        state.mempool.delete(state.latest);
        state.latest++; included++;
      }
      return included;
    },
    advance(n) { for (let i = 0; i < n; i++) chain.mine(); },
    foreign() { state.latest++; },
    elapsedMs: () => elapsed,
    now: () => Date.now() + elapsed,
  };
  return chain;
}
