/** Fakes for unit tests: a scriptable Base chain, a scriptable Solana chain, a recording witness. */
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import type { FacilitatorEvmSigner } from '@x402/evm';
import type { KeyPairSigner } from '@solana/kit';
import type { BaseChain, Receipt, SettleCall } from '../base/chain.js';
import { encodeSettleCall } from '../base/chain.js';
import type { SolanaChain, ConfirmOutcome, SignatureStatus } from '../solana/chain.js';
import type { SolPrice } from '../solana/price.js';
import type { WitnessReport, WitnessReporter } from '../witness.js';
import type { SellerRecord } from '../store.js';

export class FakeBaseChain implements BaseChain {
  operator: `0x${string}` = '0x00000000000000000000000000000000000000A1';
  settler: `0x${string}` = '0x00000000000000000000000000000000000000B2';
  baseFee = 5_000_000n; // 0.005 gwei
  tip = 1_000_000n;
  gas = 90_000n;
  l1 = 2_000_000_000n; // 2 gwei-units of wei
  price = { answer: 2_700_00000000n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) - 60 };
  allowances = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  native = 10n ** 18n;
  simulateError: Error | null = null;
  estimateError: Error | null = null;
  receiptStatus: 'success' | 'reverted' = 'success';
  sent: Array<{ call: SettleCall; gas: bigint; maxFee: bigint }> = [];
  raw: Array<{ to: string; data: Hex; value: bigint }> = [];
  /** An ERC-20 approve sent through `sendRaw` shows in `allowance()` only after this many reads (RPC lag). */
  approvalLagReads = 0;
  private pendingApproval: { key: string; amount: bigint; readsLeft: number } | null = null;
  logsFor: (call: SettleCall) => Receipt['logs'] = () => [];

  readonly verifySigner: FacilitatorEvmSigner = {
    getAddresses: () => [this.operator],
    readContract: async () => {
      throw new Error('not used');
    },
    verifyTypedData: async () => true,
    writeContract: async () => {
      throw new Error('verification signer cannot write');
    },
    sendTransaction: async () => {
      throw new Error('verification signer cannot write');
    },
    waitForTransactionReceipt: async () => {
      throw new Error('verification signer cannot write');
    },
    getCode: async () => undefined,
  };

  key(token: string, a: string, b = ''): string {
    return `${token.toLowerCase()}|${a.toLowerCase()}|${b.toLowerCase()}`;
  }
  encodeSettle(call: SettleCall): Hex {
    return encodeSettleCall(call);
  }
  async estimateSettleGas(): Promise<bigint> {
    if (this.estimateError) throw this.estimateError;
    return this.gas;
  }
  async simulateSettle(): Promise<void> {
    if (this.simulateError) throw this.simulateError;
  }
  async latestBaseFee(): Promise<bigint> {
    return this.baseFee;
  }
  async priorityFee(): Promise<bigint> {
    return this.tip;
  }
  async l1Fee(): Promise<bigint> {
    return this.l1;
  }
  async ethUsd() {
    return this.price;
  }
  async allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
    const k = this.key(token, owner, spender);
    if (this.pendingApproval?.key === k) {
      if (this.pendingApproval.readsLeft > 0) this.pendingApproval.readsLeft -= 1;
      else {
        this.allowances.set(k, this.pendingApproval.amount);
        this.pendingApproval = null;
      }
    }
    return this.allowances.get(k) ?? 0n;
  }
  async balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
    return this.balances.get(this.key(token, owner)) ?? 0n;
  }
  async nativeBalance(): Promise<bigint> {
    return this.native;
  }
  async sendSettle(call: SettleCall, gas: bigint, maxFee: bigint, _prio?: bigint, beforeBroadcast?: (hash: Hex) => Promise<void>): Promise<Hex> {
    const hash = `0x${String(this.sent.length + 1).padStart(64, '0')}` as Hex;
    if (beforeBroadcast) await beforeBroadcast(hash); // the hash is recorded BEFORE the broadcast
    this.sent.push({ call, gas, maxFee });
    return hash;
  }
  /** When set, every receipt wait and lookup FAILS (an RPC outage): the outcome is unknown. */
  receiptError: Error | null = null;
  /** When true, the node knows no receipt for any hash: waits time out and lookups answer null. */
  unmined = false;
  async getReceipt(hash: Hex): Promise<Receipt | null> {
    if (this.receiptError) throw this.receiptError;
    if (this.unmined) return null;
    return this.waitReceipt(hash);
  }
  async waitReceipt(hash: Hex): Promise<Receipt> {
    if (this.receiptError) throw this.receiptError;
    if (this.unmined) throw new Error('timeout');
    const idx = Number(BigInt(hash)) - 1;
    const entry = this.sent[idx];
    return { status: this.receiptStatus, logs: entry ? this.logsFor(entry.call) : [], gasUsed: this.gas, effectiveGasPrice: this.baseFee + this.tip };
  }
  async readSettlerConfig() {
    return { usdc: '', operator: '', feeRecipient: '', permit2Proxy: '', pvt: '', maxFee: 50_000n };
  }
  async sendRaw(to: `0x${string}`, data: Hex, value: bigint): Promise<Hex> {
    this.raw.push({ to, data, value });
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === 'approve') {
        this.pendingApproval = { key: this.key(to, this.operator, call.args[0]), amount: call.args[1], readsLeft: this.approvalLagReads };
      }
    } catch {
      // not an ERC-20 call (the swap)
    }
    return `0x${'f'.repeat(63)}${this.raw.length % 10}` as Hex;
  }
}

export class FakeSolanaChain implements SolanaChain {
  feePayer: string;
  price: SolPrice = { price: 120_00000000n, conf: 1n, expo: -8, publishTime: Math.floor(Date.now() / 1000) };
  simulateError: Error | null = null;
  confirmOutcome: ConfirmOutcome | 'throw' = 'confirmed';
  sent: string[] = [];
  own: string[] = [];
  sweeps: Array<{ to: string; amount: bigint }> = [];
  balanceLamports = 10n ** 9n;
  usdc = 0n;
  revenueAtaExists = true;
  readonly rpcUrl = 'http://fake';
  constructor(feePayer: string, readonly keypair: KeyPairSigner) {
    this.feePayer = feePayer;
  }
  async simulate(): Promise<void> {
    if (this.simulateError) throw this.simulateError;
  }
  /** Status the cluster reports per signature (default: unknown → not_found). */
  statuses = new Map<string, SignatureStatus>();
  signed = 0;
  async sign(tx: string): Promise<{ signature: string; signed: string }> {
    this.signed += 1;
    return { signature: `sig${this.signed}`, signed: tx };
  }
  async send(signed: string): Promise<void> {
    this.sent.push(signed);
  }
  async signatureStatus(sig: string): Promise<SignatureStatus> {
    return this.statuses.get(sig) ?? 'not_found';
  }
  async confirm(): Promise<ConfirmOutcome> {
    if (this.confirmOutcome === 'throw') throw new Error('timeout');
    return this.confirmOutcome;
  }
  async solUsd(): Promise<SolPrice> {
    return this.price;
  }
  async lamports(): Promise<bigint> {
    return this.balanceLamports;
  }
  async tokenBalance(): Promise<bigint> {
    return this.usdc;
  }
  async signAndSendOwn(tx: string): Promise<string> {
    this.own.push(tx);
    return `own${this.own.length}`;
  }
  async sendUsdc(to: string, amount: bigint): Promise<string> {
    this.sweeps.push({ to, amount });
    this.usdc -= amount;
    return `sweep${this.sweeps.length}`;
  }
  async ataExists(): Promise<boolean> {
    return this.revenueAtaExists;
  }
  async ensureOwnUsdcAccount(): Promise<{ created: boolean; signature: string | null }> {
    return { created: false, signature: null };
  }
}

export function recordingWitness(ok: boolean | 'refused' = true): { reporter: WitnessReporter; reports: WitnessReport[] } {
  const reports: WitnessReport[] = [];
  return {
    reports,
    reporter: async (r) => {
      reports.push(r);
      return ok === 'refused' ? 'refused' : ok ? 'reported' : 'retry';
    },
  };
}

export function seller(chain: 'base' | 'solana', address: string, extra: Partial<SellerRecord> = {}): SellerRecord {
  return {
    seller_id: `${chain}:${chain === 'base' ? address.toLowerCase() : address}`,
    chain,
    network: chain === 'base' ? 'eip155:8453' : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    address: chain === 'base' ? address.toLowerCase() : address,
    display_name: 'Test Seller',
    description: '',
    resource_urls: [],
    require_presentation: null,
    pvt_prices: [],
    status: 'active',
    registered_at_ms: 1,
    updated_at_ms: 1,
    ...extra,
  };
}

export const noFetch = async (): Promise<Response> => {
  throw new Error('network disabled in unit tests');
};
