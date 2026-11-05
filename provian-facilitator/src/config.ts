/**
 * Environment → configuration. Fail closed: a chain whose key, RPC or settler is missing is simply
 * not offered (it never appears in /supported and /verify + /settle refuse it). A key whose address
 * is not the PINNED gas wallet is refused outright — a misconfigured secret must never make some
 * other wallet the fee payer.
 *
 * Secrets (`FACILITATOR_BASE_GAS_KEY`, `FACILITATOR_SOLANA_GAS_KEY`, `FACILITATOR_RELAY_SECRET`,
 * `ZEROX_API_KEY`) are never logged, never echoed in an error, never returned by any route.
 */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { isAddress, getAddress } from 'viem';
import { BASE_GAS_WALLET, SOLANA_GAS_WALLET } from './constants.js';

export interface BaseChainConfig {
  readonly rpcUrl: string;
  readonly account: PrivateKeyAccount;
  readonly settler: `0x${string}`;
  /** Max accepted Chainlink answer age. */
  readonly priceMaxAgeSeconds: number;
}

export interface SolanaChainConfig {
  readonly rpcUrl: string;
  /** 64-byte secret+public key (Solana CLI JSON array). */
  readonly keypairBytes: Uint8Array;
  readonly priceMaxAgeSeconds: number;
}

export interface RefillConfig {
  /** Base: refill when ETH balance is below this (wei). */
  readonly baseGasFloorWei: bigint;
  /** Base: USDC (atomic) kept in the gas wallet as working buffer; only surplus above it sweeps. */
  readonly baseUsdcBuffer: bigint;
  /** Base: the most USDC (atomic) one refill may swap into ETH. */
  readonly baseRefillMaxUsdc: bigint;
  /** Base: the smallest swap (USDC atomic); default $1, never below 1. */
  readonly baseMinSwapUsdc: bigint;
  readonly solanaGasFloorLamports: bigint;
  readonly solanaUsdcBuffer: bigint;
  readonly solanaRefillMaxUsdc: bigint;
  readonly solanaMinSwapUsdc: bigint;
  readonly zeroxApiKey: string | null;
  readonly jupiterApiKey: string | null;
}

export interface FacilitatorConfig {
  readonly port: number;
  readonly relayUrl: string;
  readonly relaySecret: string | null;
  readonly firestoreProjectId: string;
  /** Unset = `(default)`. */
  readonly firestoreDatabaseId: string | null;
  readonly base: BaseChainConfig | null;
  readonly solana: SolanaChainConfig | null;
  readonly refill: RefillConfig;
  /** Why a chain is not offered (no secret values, only which variable is missing/invalid). */
  readonly disabledReasons: Record<'base' | 'solana', string | null>;
}

type Env = Record<string, string | undefined>;

function nonEmpty(env: Env, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function bigintEnv(env: Env, key: string, fallback: bigint): bigint {
  const v = nonEmpty(env, key);
  if (v === null) return fallback;
  if (!/^\d{1,40}$/.test(v)) throw new Error(`${key} must be a non-negative integer`);
  return BigInt(v);
}

/** A swap minimum is never zero: a zero would swap dust that costs more gas than it buys. */
function positiveBigintEnv(env: Env, key: string, fallback: bigint): bigint {
  const v = bigintEnv(env, key, fallback);
  if (v < 1n) throw new Error(`${key} must be at least 1`);
  return v;
}

function intEnv(env: Env, key: string, fallback: number): number {
  const v = nonEmpty(env, key);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

/** Parse a Solana CLI keypair (JSON array of 64 bytes). Throws a message that never contains the bytes. */
export function parseSolanaKeypair(raw: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FACILITATOR_SOLANA_GAS_KEY is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error('FACILITATOR_SOLANA_GAS_KEY must be a JSON array of 64 bytes');
  }
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b: unknown = parsed[i];
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new Error('FACILITATOR_SOLANA_GAS_KEY must be a JSON array of 64 bytes');
    }
    bytes[i] = b;
  }
  return bytes;
}

function parseBaseKey(raw: string): PrivateKeyAccount {
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('FACILITATOR_BASE_GAS_KEY must be a 32-byte hex private key');
  return privateKeyToAccount(hex as `0x${string}`);
}

/**
 * Load the configuration. `solanaAddressOf` derives the base58 address of a 64-byte keypair
 * (injected so this module stays synchronous; server.ts passes the @solana/kit derivation).
 */
export function loadConfig(env: Env, solanaAddressOf: (bytes: Uint8Array) => string): FacilitatorConfig {
  const disabledReasons: Record<'base' | 'solana', string | null> = { base: null, solana: null };

  let base: BaseChainConfig | null = null;
  const baseRpc = nonEmpty(env, 'BASE_RPC_URL');
  const baseKey = nonEmpty(env, 'FACILITATOR_BASE_GAS_KEY');
  const settler = nonEmpty(env, 'FACILITATOR_SETTLER_ADDRESS');
  if (!baseRpc) disabledReasons.base = 'BASE_RPC_URL unset';
  else if (!baseKey) disabledReasons.base = 'FACILITATOR_BASE_GAS_KEY unset';
  else if (!settler || !isAddress(settler)) disabledReasons.base = 'FACILITATOR_SETTLER_ADDRESS unset or invalid';
  else {
    const account = parseBaseKey(baseKey);
    if (getAddress(account.address) !== getAddress(BASE_GAS_WALLET)) {
      disabledReasons.base = 'FACILITATOR_BASE_GAS_KEY is not the pinned Base gas wallet';
    } else {
      base = {
        rpcUrl: baseRpc,
        account,
        settler: getAddress(settler),
        priceMaxAgeSeconds: intEnv(env, 'FACILITATOR_ETH_PRICE_MAX_AGE_SECONDS', 3600),
      };
    }
  }

  let solana: SolanaChainConfig | null = null;
  const solRpc = nonEmpty(env, 'SOLANA_RPC_URL');
  const solKey = nonEmpty(env, 'FACILITATOR_SOLANA_GAS_KEY');
  if (!solRpc) disabledReasons.solana = 'SOLANA_RPC_URL unset';
  else if (!solKey) disabledReasons.solana = 'FACILITATOR_SOLANA_GAS_KEY unset';
  else {
    const bytes = parseSolanaKeypair(solKey);
    if (solanaAddressOf(bytes) !== SOLANA_GAS_WALLET) {
      disabledReasons.solana = 'FACILITATOR_SOLANA_GAS_KEY is not the pinned Solana gas wallet';
    } else {
      solana = {
        rpcUrl: solRpc,
        keypairBytes: bytes,
        priceMaxAgeSeconds: intEnv(env, 'FACILITATOR_SOL_PRICE_MAX_AGE_SECONDS', 120),
      };
    }
  }

  return {
    port: intEnv(env, 'PORT', 8080),
    relayUrl: (nonEmpty(env, 'PROVIAN_RELAY_URL') ?? 'https://api.provian.ai').replace(/\/+$/, ''),
    relaySecret: nonEmpty(env, 'FACILITATOR_RELAY_SECRET'),
    firestoreProjectId: nonEmpty(env, 'GOOGLE_CLOUD_PROJECT') ?? 'provian-ai',
    firestoreDatabaseId: nonEmpty(env, 'FIRESTORE_DATABASE_ID'),
    base,
    solana,
    refill: {
      // ~$4 of ETH at $2,700: refill well before the $10 funding is spent.
      baseGasFloorWei: bigintEnv(env, 'FACILITATOR_BASE_GAS_FLOOR_WEI', 1_500_000_000_000_000n),
      baseUsdcBuffer: bigintEnv(env, 'FACILITATOR_BASE_USDC_BUFFER', 2_000_000n),
      baseRefillMaxUsdc: bigintEnv(env, 'FACILITATOR_BASE_REFILL_MAX_USDC', 5_000_000n),
      baseMinSwapUsdc: positiveBigintEnv(env, 'FACILITATOR_BASE_MIN_SWAP_USDC', 1_000_000n),
      // 0.02 SOL.
      solanaGasFloorLamports: bigintEnv(env, 'FACILITATOR_SOLANA_GAS_FLOOR_LAMPORTS', 20_000_000n),
      solanaUsdcBuffer: bigintEnv(env, 'FACILITATOR_SOLANA_USDC_BUFFER', 2_000_000n),
      solanaRefillMaxUsdc: bigintEnv(env, 'FACILITATOR_SOLANA_REFILL_MAX_USDC', 5_000_000n),
      solanaMinSwapUsdc: positiveBigintEnv(env, 'FACILITATOR_SOLANA_MIN_SWAP_USDC', 1_000_000n),
      zeroxApiKey: nonEmpty(env, 'ZEROX_API_KEY'),
      jupiterApiKey: nonEmpty(env, 'JUPITER_API_KEY'),
    },
    disabledReasons,
  };
}
