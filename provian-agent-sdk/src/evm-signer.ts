import { guardedFetch } from './guarded-fetch';
/**
 * Agent EVM transaction signer (slice 1).
 *
 * Lets the agent's self-sovereign wallet sign and BROADCAST real EVM
 * transactions - native value sends and ERC-20 transfers - from its own funded
 * EOA. This is distinct from x402-signer.ts, which only signs an off-chain
 * EIP-3009 authorization a facilitator broadcasts. x402-signer.ts stays
 * hand-rolled (zero runtime deps); THIS module uses viem for tx assembly
 * (RLP / EIP-1559 / nonce / gas / eth_sendRawTransaction) and per-chain gas
 * models (incl. Arbitrum) because that is exactly where hand-rolled bugs would
 * cost real funds.
 *
 * KEY HANDLING - key-per-call, exactly like signX402Payment({ privateKeyHex }).
 * The signer takes the raw key as a parameter and never retains it. Obtain it
 * via `withDecryptedKey(keystore, passphrase, fn)` (keystore.ts), which confines
 * the decrypted key to the callback. There is no long-lived key-holding object.
 *
 * GUARDRAIL - the agent's own spending is ungoverned (no AAG / kill switch /
 * friction on its own money), so this module's allowlist IS the safety boundary:
 * - `transferToken` moves only allowlisted tokens (PVT/USDC/USDT), and routes
 * the call to the pinned token contract.
 * - `sendTransaction` BLOCKS a non-allowlisted `to` target by default. The
 * only way past is an explicit `allowUnlistedTarget: true` that the CALLER
 * sets - never derive it from an argument an attacker could influence.
 *
 * PE REPORTING - after a successful broadcast, pass `reportPE` to record a
 * Provenance Envelope (best-effort; it never gates or fails the transfer).
 * Canonical wiring is `reportPE: (r) => institutions.recordTransfer(r)` (CommonsInstitutions),
 * which POSTs to the VERIFIED endpoint POST /v1/agent/wallet/:id/transfer/record:
 * the relay re-checks the tx on-chain (verifyTransfer asserts from+to+amount for
 * ERC-20; native now verifies from+to+value on-chain too) and records a verified PE,
 * deduped by tx_hash. The signer therefore does NOT stamp a verification claim
 * in its own metadata - the recording endpoint is the authority. there
 * is no self-asserted fallback — an agent's own report of its transfer is never
 * a PE; the chain is the witness.
 */
import {
  createPublicClient,
  http,
  encodeFunctionData,
  isAddress,
  getAddress,
  keccak256,
  type Hex,
  type Transport,
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvianError } from './errors';
import { randomUUID } from 'node:crypto';
import { fileNonceStore } from './nonce-file-store';
import { type NonceJournalStore, type SignedNonceAttempt } from './canonical-nonce';
import { Transaction } from 'ethers';
import { sendChainOperation, readChainOperation, resolveCanonicalNonceConsumption, ChainNonceError } from './chain-nonce';
import {
  CHAIN_IDS,
  VIEM_CHAINS,
  getToken,
  isAllowlistedTarget,
  isSupportedChain,
  allowlistedTargets,
  type SupportedChain,
  type AllowlistedToken,
} from './evm-allowlist';

export class EvmSignerError extends ProvianError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'EvmSignerError';
  }
}

/**
 * The agent's own funded EOA. Mirrors x402-signer.ts's X402Wallet: the raw key
 * is supplied per call and never stored by this module.
 */
export interface EvmWallet {
  /** Raw secp256k1 private key hex (with or without 0x). */
  privateKeyHex: string;
  /** That key's EVM address (validated against the key before signing). */
  address: string;
}

/** Shape of the self-asserted PE this module hands to a reporter. */
export interface PETransferReport {
  actionType: string;
  description: string;
  success: boolean;
  metadata: Record<string, unknown>;
}

/**
 * A best-effort PE reporter. Canonically `(r) => institutions.recordTransfer(r)` so the
 * relay re-verifies the tx on-chain before recording (the chain is the
 * witness; there is no self-asserted report path). Never trusted to gate the
 * broadcast: thrown errors and rejections are swallowed.
 */
export type PEReporter = (report: PETransferReport) => Promise<unknown> | unknown;

/** Optional transport / fee / reporter knobs shared by every signer method. */
export interface SignerOpts {
  /** Persist this ID with the action before invoking it; use the same ID to resume. */
  operationId?: string;
  /** Local signed-operation recovery store; the chain coordinates nonce conflicts. */
  nonceJournalStore?: NonceJournalStore;
  /** JSON-RPC URL for the chain. Required unless `transport` is supplied. */
  rpcUrl?: string;
  /** Pre-built viem transport (used by tests to inject a mock; overrides rpcUrl). */
  transport?: Transport;
  /** Best-effort PE reporter invoked after a successful broadcast. */
  reportPE?: PEReporter;
  /** Override the nonce (else viem fetches eth_getTransactionCount). */
  nonce?: number;
  /** Override the gas limit (else viem calls eth_estimateGas). */
  gas?: bigint;
  /** Override EIP-1559 max fee (else viem estimates from the chain). */
  maxFeePerGas?: bigint;
  /** Override EIP-1559 priority fee (else viem estimates from the chain). */
  maxPriorityFeePerGas?: bigint;
  /**
   * Wait for the tx to be MINED (one confirmation) before the method resolves.
   * Default FALSE - by default the signer returns on BROADCAST (the tx is in
   * the mempool), NOT on confirmation. Set true when you need the function to
   * resolve only after inclusion.
   *
   * When true, the receipt STATUS is inspected: a tx that mined but REVERTED
   * (moved nothing) rejects with EvmSignerError code 'TX_REVERTED' BEFORE the
   * method returns, so no `success:true` self-asserted PE is emitted for a
   * transfer that did not happen (audit Pass-3 #8/#27). A reverted tx still
   * mines, so waiting is the only way the signer can observe this - the default
   * broadcast-only path cannot know the on-chain outcome and defers the
   * authoritative check to the relay's on-chain re-verification
   * (CommonsInstitutions.recordTransfer, which is fail-closed).
   */
  waitForReceipt?: boolean;
}

export interface SendTransactionParams extends SignerOpts {
  to: string;
  /** 0x-prefixed calldata. Omit / '0x' for a pure value transfer. */
  data?: string;
  /** Wei. Accepts bigint or a non-negative integer string. */
  value?: bigint | string;
  chain: SupportedChain;
  /**
   * Opt out of the allowlist guard for a non-allowlisted `to`. CALLER-set only.
   * Document at the call site WHY a raw target is being signed for.
   */
  allowUnlistedTarget?: boolean;
  /**
   * Opt out of the unlimited-approve guard, allowing an effectively-unbounded
   * ERC-20 approve(spender, ~MAX_UINT256). CALLER-set only (never derive from an
   * argument) - unlimited approve is the canonical drain footgun, so this is the
   * caller's explicit responsibility.
   */
  allowUnlimitedApprove?: boolean;
}

export interface TransferTokenParams extends SignerOpts {
  token: AllowlistedToken;
  to: string;
  /** Atomic units (NOT human units): bigint or a non-negative integer string. */
  amount: bigint | string;
  chain: SupportedChain;
}

export interface TransferNativeParams extends SignerOpts {
  to: string;
  /** Wei. Accepts bigint or a non-negative integer string. */
  amount: bigint | string;
  chain: SupportedChain;
}

export interface EvmSendResult {
  /** Stable local recovery identity; resuming this ID never creates another payment. */
  operationId?: string;
  /** 0x-prefixed transaction hash returned by eth_sendRawTransaction. */
  hash: string;
  chain: SupportedChain;
  chainId: number;
  /** Checksummed `to` of the on-chain tx (the token contract for transferToken). */
  to: string;
  /** Wei value of the tx, as a decimal string. */
  value: string;
  /** Calldata, or '0x' for a pure value transfer. */
  data: string;
}

export interface TokenTransferResult extends EvmSendResult {
  token: AllowlistedToken;
  tokenAddress: string;
  /** Checksummed recipient (the ERC-20 `transfer` to-arg, NOT the tx `to`). */
  recipient: string;
  /** Transferred amount in atomic units, as a decimal string. */
  amountAtomic: string;
}

// ---------------------------------------------------------------------------
// Encoding (pure, byte-exact testable)
// ---------------------------------------------------------------------------

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Encode ERC-20 `transfer(address,uint256)` calldata (selector 0xa9059cbb).
 * Pure; exported so callers and tests can assert the exact bytes.
 */
export function encodeErc20Transfer(to: string, amountAtomic: bigint): Hex {
  if (!isAddress(to, { strict: false })) {
    throw new EvmSignerError(`invalid recipient address: ${to}`, 'INVALID_ADDRESS');
  }
  if (amountAtomic < 0n) {
    throw new EvmSignerError('amount must be non-negative', 'INVALID_AMOUNT');
  }
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [getAddress(to), amountAtomic],
  });
}

/** `burn(uint256)` ABI (selector 0x42966c68) — the PVT9 kernel's holder burn. */
const ERC20_BURN_ABI = [{
  type: 'function', name: 'burn', stateMutability: 'nonpayable',
  inputs: [{ name: 'amount', type: 'uint256' }], outputs: [],
}] as const;

/**
 * Encode `burn(uint256)` calldata (selector 0x42966c68) — the PVT holder-burn the
 * agent broadcasts to its OWN PVT balance (Transfer(holder, 0x0, amount)) as the
 * demand side of burn-to-present. Pure; exported for callers and tests.
 */
export function encodeErc20Burn(amountAtomic: bigint): Hex {
  if (amountAtomic <= 0n) {
    throw new EvmSignerError('burn amount must be a positive integer', 'INVALID_AMOUNT');
  }
  return encodeFunctionData({ abi: ERC20_BURN_ABI, functionName: 'burn', args: [amountAtomic] });
}

/** ERC-20 / EIP-2612 spend-granting selectors (keccak256(sig)[:4]). */
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256)
const ERC20_INCREASE_ALLOWANCE_SELECTOR = '0x39509351'; // increaseAllowance(address,uint256)
const EIP2612_PERMIT_SELECTOR = '0xd505accf'; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)

/**
 * Ceiling above which a spend grant is treated as effectively UNLIMITED.
 * 2^96 atomic units (~7.9e10 whole 18-decimal tokens, ~7.9e22 6-decimal ones)
 * dwarfs the supply of every allowlisted token and every grant the SDK itself
 * builds (the bond flow's grossed-up deposit is ~773 PVT), while catching the
 * "unlimited" values dapps actually request — MAX_UINT256 and the uint160 /
 * uint128 maxima (Permit2 style) — which the earlier 2^200 ceiling let through
 * as "bounded" (2026-10-17 bug check). A legitimately larger grant on a
 * high-supply token is the caller's explicit `allowUnlimitedApprove:true`.
 */
const MAX_BOUNDED_APPROVE = 2n ** 96n;

/**
 * If `data` grants ERC-20 spend authority — approve, increaseAllowance, or
 * EIP-2612 permit — return the granted amount (the value word) and which method;
 * else null. Pure: inspects only the 4-byte selector and the relevant 32-byte
 * word. The allowlist gates WHICH contract, not WHICH method, so all three
 * spend-granting shapes must be checked, not just approve — otherwise an agent
 * could grant unbounded spend via `increaseAllowance(spender, MAX)` or a gasless
 * `permit(.., MAX, ..)` and bypass the approve-only guard.
 */
function decodeSpendGrantAmount(
  data: string | undefined,
): { method: 'approve' | 'increaseAllowance' | 'permit'; amount: bigint } | null {
  if (!data) return null;
  const hex = data.toLowerCase();
  try {
    // approve(spender, amount) / increaseAllowance(spender, addedValue):
    // 0x + selector(8) + spender(64) + amount(64). Amount is word #2.
    if (hex.startsWith(ERC20_APPROVE_SELECTOR) && hex.length >= 138) {
      return { method: 'approve', amount: BigInt('0x' + hex.slice(74, 138)) };
    }
    if (hex.startsWith(ERC20_INCREASE_ALLOWANCE_SELECTOR) && hex.length >= 138) {
      return { method: 'increaseAllowance', amount: BigInt('0x' + hex.slice(74, 138)) };
    }
    // permit(owner, spender, value, deadline, v, r, s):
    // 0x + selector(8) + owner(64) + spender(64) + value(64) + ... Value is word #3.
    if (hex.startsWith(EIP2612_PERMIT_SELECTOR) && hex.length >= 202) {
      return { method: 'permit', amount: BigInt('0x' + hex.slice(138, 202)) };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePrivateKey(hex: string): Hex {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== 64 || !/^[0-9a-f]+$/.test(clean)) {
    throw new EvmSignerError('privateKeyHex must be 32 bytes (64 hex chars)', 'INVALID_KEY');
  }
  return `0x${clean}`;
}

function coerceAmount(value: bigint | string, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new EvmSignerError(`${field} must be non-negative`, 'INVALID_AMOUNT');
    return value;
  }
  if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) {
      throw new EvmSignerError(
        `${field} must be a non-negative integer string in atomic units (no decimals, no 0x)`,
        'INVALID_AMOUNT',
      );
    }
    return BigInt(value);
  }
  throw new EvmSignerError(`${field} must be a bigint or integer string`, 'INVALID_AMOUNT');
}

function resolveTransport(opts: SignerOpts): Transport {
  if (opts.transport) return opts.transport;
  if (opts.rpcUrl) return http(opts.rpcUrl, { fetchFn: guardedFetch });
  throw new EvmSignerError('rpcUrl or transport is required to broadcast', 'NO_TRANSPORT');
}

/**
 * Best-effort PE reporting after a successful BROADCAST. This path is NOT a
 * verification authority: the report it forwards is SELF-ASSERTED, and this
 * function must NEVER stamp a `verified: true` claim into the report metadata.
 * A `verified` PE is produced ONLY by the relay's on-chain re-verification path
 * (CommonsInstitutions.recordTransfer -> POST /v1/agent/wallet/:wallet_id/transfer/record),
 * which re-checks the tx on-chain before recording. Canonical verified-PE wiring
 * is therefore `reportPE: (r) => institutions.recordTransfer(r)` (removed the
 * self-asserted ProvianClient.reportAction fallback).
 * The report objects the callers build (see sendTransaction / transferToken /
 * transferNative below) deliberately omit any `verified` field for this reason.
 */
async function maybeReport(reportPE: PEReporter | undefined, report: PETransferReport): Promise<void> {
  if (!reportPE) return;
  try {
    await reportPE(report);
  } catch {
    // Best-effort, like x402's PE record: never gate or fail the broadcast.
  }
}

/**
 * Core broadcast path shared by all public methods. Validates the key controls
 * `wallet.address`, builds an EIP-1559 tx via viem, signs locally, and submits
 * eth_sendRawTransaction. Does NOT apply the allowlist guard or report a PE -
 * the public wrappers own those so each can use the right action_type + guard.
 *
 * The hash returned is from eth_sendRawTransaction - i.e. the tx is BROADCAST
 * (in the mempool), NOT mined/confirmed. When `opts.waitForReceipt` is true this
 * additionally blocks on one confirmation (a MINED receipt) before returning;
 * note that being mined does not mean the tx succeeded (a revert still mines).
 */
async function broadcast(
  wallet: EvmWallet,
  chain: SupportedChain,
  to: string,
  value: bigint,
  data: string | undefined,
  opts: SignerOpts,
): Promise<EvmSendResult> {
  const account = privateKeyToAccount(normalizePrivateKey(wallet.privateKeyHex));
  if (!isAddress(wallet.address, { strict: false })) {
    throw new EvmSignerError(`wallet.address is not a valid address: ${wallet.address}`, 'INVALID_ADDRESS');
  }
  if (getAddress(account.address) !== getAddress(wallet.address)) {
    throw new EvmSignerError(
      `wallet.address ${wallet.address} does not match the signing key (derives ${account.address})`,
      'ADDRESS_MISMATCH',
    );
  }

  const transport = resolveTransport(opts);
  // prepare the transaction with its independent reads IN PARALLEL — canonical nonce ownership, the
  // node's fee estimate (the same estimateFeesPerGas viem would call), and the gas estimate — and
  // hand viem a fully prepared request. viem otherwise runs them one after another, preceded by an
  // `eth_fillTransaction` attempt that public Base RPC refuses. Anything the caller set is used as
  // given; a reverting call still fails at the gas estimate, before anything is broadcast.
  const to_ = getAddress(to);
  const callData = data && data !== '0x' ? (data as Hex) : undefined;
  const reads = createPublicClient({ chain: VIEM_CHAINS[chain], transport });
  const operationId = opts.operationId ?? randomUUID();
  if (opts.operationId) {
    let saved;
    try { saved = await readChainOperation(opts.nonceJournalStore ?? fileNonceStore(), `${CHAIN_IDS[chain]}_${account.address.toLowerCase()}`, operationId); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'chain_operation_not_found') throw error; }
    if (saved && saved.operation?.call !== `${to_.toLowerCase()}:${value}:${callData ?? '0x'}`) throw new ChainNonceError('OPERATION_MISMATCH', operationId);
    if (saved?.attempts.length) return recoverEvmTransaction(wallet, chain, operationId, opts);
  }
  const [fees, gas] = await Promise.all([
    opts.maxFeePerGas !== undefined && opts.maxPriorityFeePerGas !== undefined
      ? Promise.resolve({ maxFeePerGas: opts.maxFeePerGas, maxPriorityFeePerGas: opts.maxPriorityFeePerGas })
      : reads.estimateFeesPerGas(),
    opts.gas !== undefined
      ? Promise.resolve(opts.gas)
      : reads.estimateGas({ account, prepare: false, to: to_, value, ...(callData ? { data: callData } : {}) }),
  ]);

  const prepared = {
    to: to_, value, ...(callData ? { data: callData } : {}),
    chainId: CHAIN_IDS[chain], type: 'eip1559' as const, gas,
    maxFeePerGas: opts.maxFeePerGas ?? fees.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas,
  };
  const attempt = await sendChainOperation(chainRuntime(wallet, chain, opts),
    `${CHAIN_IDS[chain]}_${account.address.toLowerCase()}`, operationId,
    `${to_.toLowerCase()}:${value}:${callData ?? '0x'}`, async (nonce) => {
      const raw = await account.signTransaction({ ...prepared, nonce });
      return { raw, hash: keccak256(raw), nonce };
    }, { nonce: opts.nonce, resume: opts.operationId !== undefined });
  const hash = attempt.hash as Hex;

  // Opt-in confirmation: by default the method resolves on BROADCAST (the hash
  // above). With waitForReceipt:true, block on one confirmation AND inspect the
  // status. A tx can MINE and still REVERT (viem resolves the receipt normally
  // for a reverted-but-mined tx), so reading status is the whole point of the
  // wait: a reverted transfer moved NOTHING. Reject here, BEFORE the public
  // wrapper reports its PE, so we never emit a success:true self-asserted PE for
  // a value transfer that did not happen (audit Pass-3 #8/#27).
  if (opts.waitForReceipt === true) {
    const publicClient = createPublicClient({ chain: VIEM_CHAINS[chain], transport });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') {
      throw new EvmSignerError(
        `transaction ${hash} was mined but REVERTED on-chain (block ${receipt.blockNumber}); no value was transferred`,
        'TX_REVERTED',
      );
    }
  }

  return {
    hash,
    operationId,
    chain,
    chainId: CHAIN_IDS[chain],
    to: getAddress(to),
    value: value.toString(),
    data: data && data !== '0x' ? data : '0x',
  };
}

function chainRuntime(wallet: EvmWallet, chain: SupportedChain, opts: SignerOpts) {
  const reads = createPublicClient({ chain: VIEM_CHAINS[chain], transport: resolveTransport(opts) });
  const signer = getAddress(wallet.address);
  return {
    store: opts.nonceJournalStore ?? fileNonceStore(), now: Date.now, uuid: randomUUID,
    nonce: () => reads.getTransactionCount({ address: signer, blockTag: 'latest' }),
    resolveConsumption: (attempt: SignedNonceAttempt) => resolveCanonicalNonceConsumption({
      head: async () => Number(await reads.getBlockNumber()),
      count: height => reads.getTransactionCount({ address: signer, blockNumber: BigInt(height) }),
      block: async (height, full) => {
        if (!full) {
          const header = await reads.getBlock({ blockNumber: BigInt(height) });
          return header.hash && header.number !== null ? { number: Number(header.number), hash: header.hash, transactions: [] } : null;
        }
        const block = await reads.getBlock({ blockNumber: BigInt(height), includeTransactions: true });
        if (!block.hash || block.number === null) return null;
        return { number: Number(block.number), hash: block.hash, transactions: full ? await Promise.all(block.transactions.map(async tx => ({
          hash: tx.hash, from: tx.from, nonce: tx.nonce,
          authorizations: tx.authorizationList ? await Promise.all(tx.authorizationList.filter(a => BigInt(a.chainId) === 0n || BigInt(a.chainId) === BigInt(CHAIN_IDS[chain])).map(async a => ({
            authority: await recoverAuthorizationAddress({ authorization: a }), nonce: Number(a.nonce),
          }))) : [],
        }))) : [] };
      },
    }, signer, attempt.nonce, attempt.hash),
    included: async (hash: string) => {
      try { const receipt = await reads.getTransactionReceipt({ hash: hash as Hex });
        return (await reads.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash; }
      catch (error) {
        if (error instanceof Error && /TransactionReceiptNotFound|receipt.*not.*found/i.test(error.name + error.message)) return false;
        throw error;
      }
    },
    broadcast: async (a: SignedNonceAttempt) => {
      const hash = await reads.sendRawTransaction({ serializedTransaction: a.raw as Hex });
      if (hash.toLowerCase() !== a.hash.toLowerCase()) throw new Error('nonce_broadcast_hash_mismatch');
    },
    validate: (a: SignedNonceAttempt) => {
      const tx = Transaction.from(a.raw);
      if (tx.hash !== a.hash || tx.from?.toLowerCase() !== signer.toLowerCase()
        || tx.chainId !== BigInt(CHAIN_IDS[chain]) || tx.nonce !== a.nonce) throw new Error('nonce_attempt_binding_invalid');
    },
    assertApproved: () => undefined,
  };
}
/** Explicit recovery submits only the recorded signed bytes; it never signs a new nonce. */
export async function recoverEvmTransaction(wallet: EvmWallet, chain: SupportedChain, operationId: string, opts: SignerOpts): Promise<EvmSendResult> {
  const account = privateKeyToAccount(normalizePrivateKey(wallet.privateKeyHex));
  if (account.address.toLowerCase() !== wallet.address.toLowerCase()) throw new EvmSignerError('wallet key mismatch', 'ADDRESS_MISMATCH');
  const runtime = chainRuntime(wallet, chain, opts);
  const key = `${CHAIN_IDS[chain]}_${account.address.toLowerCase()}`;
  const doc = await readChainOperation(runtime.store, key, operationId);
  const index = await runtime.store.transact(key, current => { if (!current) throw new Error('chain_operation_not_found'); return current; });
  const saved = doc.attempts[0] ?? index.attempts.find(a => a.intent === operationId);
  if (!saved) throw new ChainNonceError('SUBMISSION_UNCERTAIN', operationId);
  runtime.validate(saved);
  const tx = Transaction.from(saved.raw);
  const call = `${tx.to!.toLowerCase()}:${tx.value}:${tx.data}`;
  const attempt = await sendChainOperation(runtime, key, operationId, call,
    async () => { throw new Error('recovery_cannot_sign_another_transaction'); }, { resume: true });
  if (opts.waitForReceipt) {
    const receipt = await createPublicClient({ chain: VIEM_CHAINS[chain], transport: resolveTransport(opts) }).waitForTransactionReceipt({ hash: attempt.hash as Hex });
    if (receipt.status === 'reverted') throw new EvmSignerError(`transaction ${attempt.hash} reverted`, 'TX_REVERTED');
  }
  return { operationId, hash: attempt.hash, chain, chainId: CHAIN_IDS[chain], to: tx.to!, value: tx.value.toString(), data: tx.data };
}
/** Inspect local recovery identities after a process restart; no key or RPC is needed. */
export async function listRecoverableEvmTransactions(address: string, chain: SupportedChain, opts: Pick<SignerOpts, 'nonceJournalStore'> = {}): Promise<{
  operationId: string; hash: string; nonce: number; to: string; value: string; data: string;
}[]> {
  if (!isAddress(address)) throw new EvmSignerError('invalid address', 'INVALID_ADDRESS');
  const store = opts.nonceJournalStore ?? fileNonceStore();
  const key = `${CHAIN_IDS[chain]}_${address.toLowerCase()}`;
  const index = await store.transact(key, current => current ?? { version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 });
  return index.attempts.map(a => {
    const tx = Transaction.from(a.raw);
    if (tx.hash !== a.hash || tx.chainId !== BigInt(CHAIN_IDS[chain]) || tx.from?.toLowerCase() !== address.toLowerCase()) throw new Error('nonce_attempt_binding_invalid');
    return { operationId: a.intent, hash: a.hash, nonce: tx.nonce, to: tx.to ?? '', value: tx.value.toString(), data: tx.data };
  });
}
export { ChainNonceError } from './chain-nonce';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Sign and broadcast a general EIP-1559 transaction from the agent's own EOA.
 *
 * RESULT SEMANTICS: the returned result means the tx was BROADCAST (accepted
 * into the mempool), NOT mined or confirmed. The `hash` is the
 * eth_sendRawTransaction hash; the tx may still be dropped, replaced, or revert
 * on-chain. To resolve only after confirmation, pass `waitForReceipt: true`
 * (default false, preserving broadcast-only behavior), or wait for the receipt
 * yourself with viem's `waitForTransactionReceipt` on a public client. The
 * best-effort `reportPE` likewise fires on broadcast and never verifies the tx.
 *
 * GUARDRAIL: `to` must be an allowlisted token/contract on `chain`, else this
 * throws TARGET_NOT_ALLOWLISTED. Pass `allowUnlistedTarget: true` (caller-set)
 * to sign for a raw target - the agent key is ungoverned, so this opt-out is
 * the deliberate escape hatch, not a default.
 *
 * SCOPE OF THE GUARD: the allowlist gates WHICH contract, NOT WHICH method.
 * An allowlisted target still permits ARBITRARY calldata, so treat a call to an
 * allowlisted token as FULL method authority over that token; use `transferToken`
 * when you only mean to transfer. The ONE exception is unbounded spend grants:
 * an effectively-unlimited approve / increaseAllowance / EIP-2612 permit is
 * rejected (UNLIMITED_APPROVE_BLOCKED) unless the caller sets
 * allowUnlimitedApprove. Gating beyond those three spend-granting selectors
 * (general per-method selector gating) is a deferred slice.
 */
export async function sendTransaction(
  wallet: EvmWallet,
  params: SendTransactionParams,
): Promise<EvmSendResult> {
  if (!isSupportedChain(params.chain)) {
    throw new EvmSignerError(`unsupported chain: ${String(params.chain)}`, 'UNSUPPORTED_CHAIN');
  }
  if (!isAddress(params.to, { strict: false })) {
    throw new EvmSignerError(`invalid 'to' address: ${params.to}`, 'INVALID_ADDRESS');
  }
  if (params.data !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(params.data)) {
    throw new EvmSignerError("'data' must be 0x-prefixed even-length hex", 'INVALID_DATA');
  }
  if (params.allowUnlistedTarget !== true && !isAllowlistedTarget(params.chain, params.to)) {
    throw new EvmSignerError(
      `target ${params.to} is not allowlisted on ${params.chain}. ` +
        `Allowlisted: [${allowlistedTargets(params.chain).join(', ')}]. ` +
        `Set allowUnlistedTarget:true to override - the agent key is ungoverned, so this is the caller's responsibility.`,
      'TARGET_NOT_ALLOWLISTED',
    );
  }

  // Unlimited spend-grant guard: the allowlist gates WHICH contract, not WHICH
  // method, so an allowlisted token (PVT/USDC) still permits a hand-built
  // approve / increaseAllowance / EIP-2612 permit granting MAX_UINT256 - the
  // canonical drain. Reject an effectively-unbounded grant by ANY of those three
  // methods unless the CALLER explicitly opts out (caller-set, like
  // allowUnlistedTarget). The bond flow's approve is a bounded grossed-up amount
  // well under the ceiling, so it passes cleanly. (Gating beyond these three
  // spend-granting selectors remains a deferred slice; this closes the
  // approve/increaseAllowance/permit asymmetry.)
  if (params.allowUnlimitedApprove !== true) {
    const grant = decodeSpendGrantAmount(params.data);
    if (grant !== null && grant.amount > MAX_BOUNDED_APPROVE) {
      throw new EvmSignerError(
        `refusing to sign an effectively-unlimited ERC-20 ${grant.method} (amount ${grant.amount} exceeds the bounded ceiling ${MAX_BOUNDED_APPROVE}). ` +
          `Grant only the amount you intend to spend, or set allowUnlimitedApprove:true to override - unlimited spend authority is the canonical drain footgun, so this is the caller's explicit responsibility.`,
        'UNLIMITED_APPROVE_BLOCKED',
      );
    }
  }

  const value = params.value !== undefined ? coerceAmount(params.value, 'value') : 0n;
  const result = await broadcast(wallet, params.chain, params.to, value, params.data, params);
  const hasData = !!params.data && params.data !== '0x';
  await maybeReport(params.reportPE, {
    actionType: 'agent_evm_transaction',
    description: `Agent EVM transaction to ${result.to} on ${result.chain} (value ${result.value} wei, ${hasData ? 'with calldata' : 'no calldata'}); tx ${result.hash}`,
    success: true,
    metadata: {
      tx_hash: result.hash,
      chain: result.chain,
      chain_id: result.chainId,
      to: result.to,
      value_wei: result.value,
      has_calldata: hasData,
      allow_unlisted_target: params.allowUnlistedTarget === true,
    },
  });
  return result;
}

/**
 * Transfer an allowlisted ERC-20 token (PVT/USDC/USDT) from the agent's EOA.
 * `amount` is ATOMIC units (use the token's decimals; this method does not
 * apply decimals). The tx `to` is the pinned token contract (allowlisted); the
 * recipient rides inside the `transfer` calldata.
 *
 * RESULT SEMANTICS: resolves on BROADCAST (mempool), NOT on confirmation -
 * the `hash` is the eth_sendRawTransaction hash. Pass `waitForReceipt: true`
 * (default false) to block until the tx is MINED, or wait for the receipt
 * yourself. `reportPE` is best-effort and never a verification authority.
 */
export async function transferToken(
  wallet: EvmWallet,
  params: TransferTokenParams,
): Promise<TokenTransferResult> {
  if (!isSupportedChain(params.chain)) {
    throw new EvmSignerError(`unsupported chain: ${String(params.chain)}`, 'UNSUPPORTED_CHAIN');
  }
  // Runtime allowlist check (the type system is the compile-time half).
  // Normalize getToken's bare Error into the module's EvmSignerError so the
  // whole signer surface rejects with one error type.
  let info: ReturnType<typeof getToken>;
  try {
    info = getToken(params.chain, params.token);
  } catch (err) {
    throw new EvmSignerError((err as Error).message, 'TOKEN_NOT_ALLOWLISTED');
  }
  if (!isAddress(params.to, { strict: false })) {
    throw new EvmSignerError(`invalid recipient address: ${params.to}`, 'INVALID_ADDRESS');
  }
  const amount = coerceAmount(params.amount, 'amount');
  const data = encodeErc20Transfer(params.to, amount);

  const base = await broadcast(wallet, params.chain, info.address, 0n, data, params);
  const result: TokenTransferResult = {
    ...base,
    token: params.token,
    tokenAddress: info.address,
    recipient: getAddress(params.to),
    amountAtomic: amount.toString(),
  };
  await maybeReport(params.reportPE, {
    actionType: 'agent_token_transfer',
    description: `Agent transferred ${result.amountAtomic} atomic units of ${result.token} to ${result.recipient} on ${result.chain}; tx ${result.hash}`,
    success: true,
    metadata: {
      tx_hash: result.hash,
      chain: result.chain,
      chain_id: result.chainId,
      token: result.token,
      token_address: result.tokenAddress,
      recipient: result.recipient,
      amount_atomic: result.amountAtomic,
      decimals: info.decimals,
    },
  });
  return result;
}

/**
 * Transfer native ETH from the agent's EOA to any address. A bare value send
 * carries no calldata, so it can only trigger a recipient contract's
 * receive/fallback (no method selection) - there is nothing for the
 * contract-target allowlist to gate, and the agent only sends its own ETH
 * outward. The recipient may therefore be any valid address.
 *
 * RESULT SEMANTICS: resolves on BROADCAST (mempool), NOT on confirmation -
 * the `hash` is the eth_sendRawTransaction hash. Pass `waitForReceipt: true`
 * (default false) to block until the tx is MINED, or wait for the receipt
 * yourself. `reportPE` is best-effort and never a verification authority.
 */
export async function transferNative(
  wallet: EvmWallet,
  params: TransferNativeParams,
): Promise<EvmSendResult> {
  if (!isSupportedChain(params.chain)) {
    throw new EvmSignerError(`unsupported chain: ${String(params.chain)}`, 'UNSUPPORTED_CHAIN');
  }
  if (!isAddress(params.to, { strict: false })) {
    throw new EvmSignerError(`invalid recipient address: ${params.to}`, 'INVALID_ADDRESS');
  }
  const amount = coerceAmount(params.amount, 'amount');

  const result = await broadcast(wallet, params.chain, params.to, amount, undefined, params);
  await maybeReport(params.reportPE, {
    actionType: 'agent_native_transfer',
    description: `Agent transferred ${result.value} wei of native ETH to ${result.to} on ${result.chain}; tx ${result.hash}`,
    success: true,
    metadata: {
      tx_hash: result.hash,
      chain: result.chain,
      chain_id: result.chainId,
      recipient: result.to,
      amount_wei: result.value,
    },
  });
  return result;
}
