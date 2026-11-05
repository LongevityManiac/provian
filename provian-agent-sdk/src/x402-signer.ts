import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * Agent-side x402 signer.
 *
 * The agent wallet is self-sovereign: it holds its OWN USDC on Base and signs
 * its OWN EIP-3009 `transferWithAuthorization` with its OWN secp256k1 key - the
 * same key `createAgentWallet` generates and `keystore.ts` persists. There is no
 * Provian gate here: no AAG, no budget, no kill switch, no relay round-trip, no
 * phone. "Agent's money, agent's rules." (Whoever funds the wallet just sends
 * USDC to its address.)
 *
 * This module is the pure crypto + protocol layer for x402:
 *   - EIP-712 hashing of the ERC-3009 TransferWithAuthorization struct, built
 *     from the in-house `keccak256` + `@noble/curves` secp256k1 - no ethers/viem.
 *   - The x402 wire types (PaymentRequired / PaymentRequirement / PaymentPayload).
 *   - 402 decode + compatible-requirement selection.
 *   - An optional read-only USDC `balanceOf` helper (NOT a gate).
 *
 * The 402 -> sign -> retry fetch loop and optional PE recording live on
 * `ProvianClient.wrapFetchWithX402`, which calls into this module.
 *
 * SECURITY: the EIP-712 domain `name`/`version` are pinned here per network and
 * must match the on-chain USDC contract byte-for-byte, or the signature is
 * silently rejected. They are NEVER read from the (attacker-controlled) 402
 * response - a hostile facilitator must not get to choose the domain we sign
 * under.
 */

import { randomBytes } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from './keccak256';
import { deriveAddressFromPrivateKey } from './wallet';
import { getToken, type SupportedChain } from './evm-allowlist';
import { ProvianError } from './errors';

// =============================================================================
// x402 PROTOCOL TYPES (V2) - reference: https://github.com/coinbase/x402
// =============================================================================

/** A single accepted payment option from a 402 response. */
export interface PaymentRequirement {
  /** Only the 'exact' scheme (EIP-3009) is supported. */
  scheme: 'exact';
  /** CAIP-2 network identifier, e.g. "eip155:8453" (Base mainnet). */
  network: string;
  /** Amount in atomic units (USDC has 6 decimals), e.g. "10000" = $0.01. */
  amount: string;
  /** Token contract address (must be the USDC on `network`). */
  asset: string;
  /** Recipient address (0x...). */
  payTo: string;
  /** Max seconds the server will wait for payment (clamped to 300). */
  maxTimeoutSeconds?: number;
  /** Opaque extension data. NOT trusted to set the EIP-712 domain. */
  extra?: Record<string, unknown>;
}

/** Decoded from the 402 (base64 PAYMENT-REQUIRED header or JSON body). */
export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  /**
   * The wire field per the x402 spec and every live seller (x402.org,
   * Bazaar-indexed services): `accepts`. LIVE-VERIFY 2026-07-08 found the SDK
   * reading only `accepted` — a key no real 402 carries — so wrapFetchWithX402
   * threw X402_NO_COMPATIBLE_OPTION against every live endpoint.
   */
  accepts?: PaymentRequirement | PaymentRequirement[];
  /** Legacy alias kept for back-compat with early fixtures/servers. */
  accepted?: PaymentRequirement | PaymentRequirement[];
}

/** ERC-3009 transferWithAuthorization parameters. */
export interface ERC3009Authorization {
  /** The agent's own funded EOA (the signer). */
  from: string;
  /** payTo from the requirement. */
  to: string;
  /** Amount in atomic units. */
  value: string;
  /** Unix seconds; "0" = valid immediately. */
  validAfter: string;
  /** Unix seconds; now + min(maxTimeoutSeconds, 300). */
  validBefore: string;
  /** Random 32-byte hex nonce (0x + 64 hex). */
  nonce: string;
}

/**
 * Base64-encoded into the PAYMENT-SIGNATURE header on the paid retry.
 * v2 wire shape per the official x402 client (@x402/core PaymentPayloadV2Schema,
 * verified against npm 2.17.0 during LIVE-VERIFY 2026-07-08): the CHOSEN
 * requirement is echoed back under `accepted` (scheme/network ride inside it);
 * there is no top-level scheme/network. The prior SDK shape
 * ({x402Version, scheme, network, payload} under an X-PAYMENT header — both
 * v1-isms) was silently re-402'd by every live v2 seller.
 */
export interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: { signature: string; authorization: ERC3009Authorization };
}

/** Decoded from the settlement receipt header on a 200 response. */
export interface PaymentResponse {
  success: boolean;
  payer: string;
  transaction: string;
  network: string;
}

// =============================================================================
// NETWORK TABLE (Base-only) - self-contained; mirrors the mobile X402Config +
// TOKEN_ADDRESSES (src/core/chains/evm/config.ts). USDC = 6 decimals.
// =============================================================================

export interface X402NetworkParams {
  chainId: number;
  /** Canonical USDC address on this chain, lowercased. */
  usdcAddress: string;
  /** EIP-712 domain.name of the USDC contract. */
  usdcDomainName: string;
  /** EIP-712 domain.version of the USDC contract. */
  usdcDomainVersion: string;
}

/**
 * x402 is scoped to Base mainnet + Base Sepolia. The domain name differs:
 * Base mainnet native USDC reports 'USD Coin'; Base Sepolia's Circle test USDC
 * reports 'USDC' - a mismatch silently invalidates the signature.
 */
export const X402_NETWORKS: Readonly<Record<string, X402NetworkParams>> = {
  'eip155:8453': {
    chainId: 8453,
    usdcAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
  },
  'eip155:84532': {
    chainId: 84532,
    usdcAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
  },
};

export function getX402Network(caip2: string): X402NetworkParams | null {
  return X402_NETWORKS[caip2] ?? null;
}

/** USDC uses 6 decimal places on all supported chains. */
export const USDC_DECIMALS = 6;

/** Default payment validity window (seconds); also the hard clamp. */
export const X402_MAX_TIMEOUT_SECONDS = 300;

// =============================================================================
// EIP-712 ENCODING (keccak256 + ABI 32-byte words; no ethers/viem)
// =============================================================================

const EIP712_DOMAIN_TYPEHASH = keccak256(
  Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)', 'utf8'),
);

const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
  Buffer.from(
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
    'utf8',
  ),
);

const UINT256_MAX = (1n << 256n) - 1n;

/** Left-pad a 20-byte address into a 32-byte EIP-712/ABI word. */
function addressWord(addr: string): Buffer {
  const clean = addr.startsWith('0x') ? addr.slice(2) : addr;
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`x402 signer: invalid address ${addr}`);
  }
  const word = Buffer.alloc(32);
  Buffer.from(clean, 'hex').copy(word, 12);
  return word;
}

/** Encode a non-negative integer into a 32-byte big-endian word. */
function uint256Word(value: string | number | bigint): Buffer {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new Error('x402 signer: uint256 cannot be negative');
  if (v > UINT256_MAX) throw new Error('x402 signer: uint256 overflow');
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
}

/** A bytes32 value is encoded as its raw 32 bytes (not hashed). */
function bytes32Word(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`x402 signer: invalid bytes32 ${hex}`);
  }
  return Buffer.from(clean, 'hex');
}

function domainSeparator(net: X402NetworkParams): Buffer {
  return keccak256(
    Buffer.concat([
      EIP712_DOMAIN_TYPEHASH,
      keccak256(Buffer.from(net.usdcDomainName, 'utf8')),
      keccak256(Buffer.from(net.usdcDomainVersion, 'utf8')),
      uint256Word(net.chainId),
      addressWord(net.usdcAddress),
    ]),
  );
}

function hashAuthorization(auth: ERC3009Authorization): Buffer {
  return keccak256(
    Buffer.concat([
      TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
      addressWord(auth.from),
      addressWord(auth.to),
      uint256Word(auth.value),
      uint256Word(auth.validAfter),
      uint256Word(auth.validBefore),
      bytes32Word(auth.nonce),
    ]),
  );
}

/**
 * The EIP-712 signing digest: keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct).
 * Exported for byte-exact test vectors.
 */
export function eip712Digest(net: X402NetworkParams, auth: ERC3009Authorization): Buffer {
  return keccak256(
    Buffer.concat([Buffer.from([0x19, 0x01]), domainSeparator(net), hashAuthorization(auth)]),
  );
}

// =============================================================================
// SIGNING
// =============================================================================

export interface SignedX402Authorization {
  authorization: ERC3009Authorization;
  /** 0x + 130 hex (r ‖ s ‖ v), v = 27/28. */
  signature: string;
}

/** The agent's own funded EVM wallet used to sign x402 payments. */
export interface X402Wallet {
  /** Raw secp256k1 private key hex (with or without 0x). */
  privateKeyHex: string;
  /** That key's EVM address (the EIP-3009 `from`). */
  address: string;
}

export interface SignX402PaymentArgs {
  privateKeyHex: string;
  fromAddress: string;
  requirement: PaymentRequirement;
  /**
   * Hard per-payment ceiling in USDC atomic units (6 decimals). REQUIRED — the
   * agent's x402 key is self-sovereign and ungoverned (no AAG/budget/kill
   * switch/relay/phone), so this SDK-local ceiling is the ONLY thing between a
   * hostile 402 and the wallet's whole balance. It is the x402 analogue of the
   * evm-signer's allowlist / UNLIMITED_APPROVE_BLOCKED guard — a local safety
   * boundary on the ungoverned key, NOT governance. There is no unlimited
   * default: a call with no ceiling is refused before signing.
   */
  maxAmountAtomic: bigint;
  /** Injectable for deterministic tests; defaults to Math.floor(Date.now()/1000). */
  nowSeconds?: number;
  /** Injectable 32-byte nonce for deterministic tests; defaults to randomBytes(32). */
  nonce?: Buffer;
}

/**
 * Build and sign the ERC-3009 authorization for one exact-scheme USDC payment
 * with the agent's own key. Throws on any incompatibility (wrong scheme,
 * unsupported network, asset that is not the network's USDC, bad payTo/amount,
 * or a key that does not match `fromAddress`).
 */
export function signX402Payment(args: SignX402PaymentArgs): SignedX402Authorization {
  const { privateKeyHex, fromAddress, requirement } = args;

  if (requirement.scheme !== 'exact') {
    throw new Error(`x402 signer: unsupported scheme ${requirement.scheme}`);
  }
  const net = getX402Network(requirement.network);
  if (!net) {
    throw new Error(`x402 signer: unsupported network ${requirement.network}`);
  }
  if (typeof requirement.asset !== 'string' || requirement.asset.toLowerCase() !== net.usdcAddress) {
    throw new Error(`x402 signer: asset is not USDC on ${requirement.network}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(requirement.payTo)) {
    throw new Error('x402 signer: payTo is not a valid 0x address');
  }
  let value: bigint;
  try {
    value = BigInt(requirement.amount);
  } catch {
    throw new Error('x402 signer: amount is not a valid integer');
  }
  if (value <= 0n) throw new Error('x402 signer: amount must be positive');

  // Per-payment ceiling — enforced BEFORE any signing. The ceiling is required
  // (no unlimited default): a missing/negative ceiling is a hard refusal, so no
  // path can sign an uncapped payment with the ungoverned key.
  if (args.maxAmountAtomic === undefined || args.maxAmountAtomic === null) {
    throw new ProvianError(
      'x402 signer: a per-payment ceiling (maxAmountAtomic) is required — the ungoverned x402 key must never sign an uncapped amount',
      'X402_CEILING_REQUIRED',
    );
  }
  if (args.maxAmountAtomic <= 0n) {
    throw new ProvianError('x402 signer: maxAmountAtomic must be a positive integer', 'X402_CEILING_REQUIRED');
  }
  if (value > args.maxAmountAtomic) {
    throw new ProvianError(
      `x402 signer: payment amount ${value} exceeds the per-payment ceiling ${args.maxAmountAtomic} (USDC atomic units)`,
      'X402_AMOUNT_EXCEEDS_CAP',
    );
  }

  const cleanKey = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  if (cleanKey.length !== 64) {
    throw new Error('x402 signer: privateKeyHex must be 32 bytes (64 hex chars)');
  }
  // Defensive: the key must control `fromAddress`, else we would sign a spend
  // that names someone else's EOA (the on-chain transfer would simply fail, but
  // catching it here is clearer than a silent settlement failure).
  const derived = deriveAddressFromPrivateKey(cleanKey);
  if (derived.toLowerCase() !== fromAddress.toLowerCase()) {
    throw new Error('x402 signer: fromAddress does not match the signing key');
  }

  const nonceBuf = args.nonce ?? randomBytes(32);
  if (nonceBuf.length !== 32) throw new Error('x402 signer: nonce must be 32 bytes');

  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const timeout = Math.min(requirement.maxTimeoutSeconds ?? X402_MAX_TIMEOUT_SECONDS, X402_MAX_TIMEOUT_SECONDS);

  const authorization: ERC3009Authorization = {
    from: fromAddress,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: '0',
    validBefore: String(nowSeconds + timeout),
    nonce: `0x${nonceBuf.toString('hex')}`,
  };

  const digest = eip712Digest(net, authorization);
  const sig = secp256k1.sign(digest, cleanKey);
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (27 + (sig.recovery ?? 0)).toString(16).padStart(2, '0');

  return { authorization, signature: `0x${r}${s}${v}` };
}

/** Base64-encode the PaymentPayload for the PAYMENT-SIGNATURE retry header (v2). */
export function buildPaymentHeader(signed: SignedX402Authorization, requirement: PaymentRequirement): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: { signature: signed.signature, authorization: signed.authorization },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// =============================================================================
// 402 DECODE + SELECT (lifted from the mobile handler, governance-free)
// =============================================================================

/** Validate the shape of a decoded PaymentRequired object. */
export function assertPaymentRequiredShape(parsed: unknown): PaymentRequired {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('x402: invalid payment requirements format');
  }
  const pr = parsed as Record<string, unknown>;
  if (pr.x402Version !== 2) {
    throw new Error(`x402: unsupported protocol version ${String(pr.x402Version)} (only 2 supported)`);
  }
  if (!pr.resource || typeof pr.resource !== 'object') {
    throw new Error('x402: missing resource information in payment requirements');
  }
  if (!pr.accepts && !pr.accepted) {
    throw new Error('x402: no accepted payment methods in payment requirements');
  }
  return parsed as PaymentRequired;
}

/**
 * Decode PaymentRequired from a 402 Response: base64 PAYMENT-REQUIRED header
 * first (some servers use it), else the JSON body.
 */
export async function decodePaymentRequired(response: Response): Promise<PaymentRequired> {
  const header = response.headers.get('PAYMENT-REQUIRED') || response.headers.get('payment-required');
  let parsed: unknown;
  if (header) {
    try {
      parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      throw new Error('x402: could not decode the PAYMENT-REQUIRED header');
    }
  } else {
    try {
      parsed = await response.clone().json();
    } catch {
      throw new Error('x402: 402 response had no readable payment requirements');
    }
  }
  return assertPaymentRequiredShape(parsed);
}

/**
 * Pick the first accepted requirement we can pay: scheme 'exact', a supported
 * Base network, and an asset that matches that network's USDC. Validates the
 * requirement shape before touching string methods so a hostile 402 throws a
 * clean error rather than a TypeError.
 */
export function selectCompatibleRequirement(pr: PaymentRequired): PaymentRequirement {
  // Wire field first (`accepts` — the spec + every live seller), legacy
  // `accepted` alias as fallback.
  const source = pr.accepts ?? pr.accepted;
  const accepted = Array.isArray(source) ? source : [source];
  for (const req of accepted) {
    if (!req || typeof req.network !== 'string' || typeof req.asset !== 'string') continue;
    if (req.scheme !== 'exact') continue;
    const net = getX402Network(req.network);
    if (!net) continue;
    if (req.asset.toLowerCase() !== net.usdcAddress) continue;
    return req;
  }
  throw new Error(
    "x402: none of the server's accepted options are supported (USDC via the exact/EIP-3009 scheme on Base)",
  );
}

/**
 * Money terms a caller already knows for one payment (e.g. Provian's own $1 payout fee or $5 PE
 * Archive GB): the CAIP-2 Base network, the recipient and the exact amount in USDC atomic units.
 */
export interface X402PinnedPayment {
  readonly network: string;
  readonly payTo: string;
  readonly amountAtomic: bigint | string;
}

/** Normalized pinned terms (lowercased recipient, decimal amount string). */
export interface ParsedPinnedPayment {
  readonly network: string;
  readonly payTo: string;
  readonly amount: string;
}

/** Validate pinned terms up front: a supported Base network, a 0x recipient, a positive integer amount. */
export function parsePinnedPayment(pin: X402PinnedPayment): ParsedPinnedPayment {
  if (!pin || typeof pin.network !== 'string' || !getX402Network(pin.network)) {
    throw new Error('x402: pinnedPayment.network is not a supported Base network');
  }
  if (typeof pin.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pin.payTo)) {
    throw new Error('x402: pinnedPayment.payTo is not a valid 0x address');
  }
  let amount: bigint;
  try {
    amount = typeof pin.amountAtomic === 'bigint' ? pin.amountAtomic : BigInt(pin.amountAtomic);
  } catch {
    throw new Error('x402: pinnedPayment.amountAtomic is not an integer');
  }
  if (amount <= 0n) throw new Error('x402: pinnedPayment.amountAtomic must be positive');
  return { network: pin.network, payTo: pin.payTo.toLowerCase(), amount: amount.toString() };
}

/**
 * Pick the accepted requirement that names exactly the pinned terms: scheme 'exact', the pinned
 * network, that network's USDC, the pinned recipient and the pinned amount. Anything else (another
 * recipient, amount, token or chain, including a testnet) is refused, so a hostile or mistaken 402
 * can never redirect a payment whose terms the caller already knows.
 */
export function selectPinnedRequirement(pr: PaymentRequired, pin: ParsedPinnedPayment): PaymentRequirement {
  const source = pr.accepts ?? pr.accepted;
  const accepted = Array.isArray(source) ? source : [source];
  const net = getX402Network(pin.network);
  for (const req of accepted) {
    if (!req || !net) continue;
    if (req.scheme !== 'exact' || req.network !== pin.network) continue;
    if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== net.usdcAddress) continue;
    if (typeof req.payTo !== 'string' || req.payTo.toLowerCase() !== pin.payTo) continue;
    let amount: bigint;
    try {
      amount = BigInt(req.amount);
    } catch {
      continue;
    }
    if (amount.toString() !== pin.amount) continue;
    return req;
  }
  throw new Error(
    `x402: the server's payment terms are not the pinned ones (${pin.amount} USDC atomic units to ${pin.payTo} on ${pin.network}); refusing to sign`,
  );
}

/** Decode the settlement receipt from a 200 response, best-effort. */
export function decodePaymentResponse(response: Response): PaymentResponse | null {
  const header =
    response.headers.get('X-PAYMENT-RESPONSE') ||
    response.headers.get('PAYMENT-RESPONSE') ||
    response.headers.get('payment-response');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentResponse;
  } catch {
    return null;
  }
}

// =============================================================================
// AMOUNT HELPERS
// =============================================================================

/** Convert USDC atomic units to a human string, e.g. "10000" -> "0.01". */
export function usdcAtomicToHuman(atomicAmount: string): string {
  const raw = BigInt(atomicAmount);
  const divisor = BigInt(10 ** USDC_DECIMALS);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(USDC_DECIMALS, '0');
  const trimmed = fractionStr.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

// =============================================================================
// OPTIONAL READ-ONLY BALANCE (NOT a gate)
// =============================================================================

/** ERC-20 balanceOf(address) selector = keccak256("balanceOf(address)")[:4]. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/**
 * Read any ERC-20 `balanceOf(owner)` on a chain via a minimal JSON-RPC
 * `eth_call`. Atomic units (no decimals applied). The single primitive behind
 * both {@link getAgentUsdcBalance} and {@link getAgentPvtBalance}: an agent no
 * longer has to hand-roll a balanceOf eth_call to read its own holdings.
 */
export async function getErc20Balance(
  rpcUrl: string,
  tokenAddress: string,
  ownerAddress: string,
  fetchFn: typeof fetch = fetch,
): Promise<bigint> {
  fetchFn = guardedFetcher(fetchFn);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new Error(`balanceOf: invalid token address ${tokenAddress}`);
  }
  const data = BALANCE_OF_SELECTOR + addressWord(ownerAddress).toString('hex');
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: tokenAddress, data }, 'latest'],
    }),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error) throw new Error(`balanceOf RPC error: ${json.error.message ?? 'unknown'}`);
  if (!json.result || json.result === '0x') return 0n;
  return BigInt(json.result);
}

/**
 * Read the agent wallet's USDC balance on a network via a minimal JSON-RPC
 * `eth_call`. Optional pre-check / telemetry only - the x402 flow never gates
 * on it (an underfunded EOA simply yields a rejected on-chain settlement).
 */
export async function getAgentUsdcBalance(
  rpcUrl: string,
  address: string,
  caip2: string,
  fetchFn: typeof fetch = fetch,
): Promise<bigint> {
  fetchFn = guardedFetcher(fetchFn);
  const net = getX402Network(caip2);
  if (!net) throw new Error(`x402: unsupported network ${caip2}`);
  return getErc20Balance(rpcUrl, net.usdcAddress, address, fetchFn);
}

/**
 * Read the agent wallet's PVT balance (atomic 18-decimal units) via a minimal
 * JSON-RPC `eth_call` against the pinned PVT token for the chain. PVT is the
 * agent's earned/held on-chain currency; the address is resolved from the SDK's
 * own pinned allowlist ({@link getToken}), never from the relay or the caller,
 * so a read cannot be pointed at a spoofed token. Base holds the live PVT9
 * successor kernel; Arbitrum/Optimism resolve their pinned entries.
 * Format with 18 decimals for display (e.g. `Number(atomic) / 1e18`).
 */
export async function getAgentPvtBalance(
  rpcUrl: string,
  address: string,
  chain: SupportedChain = 'base',
  fetchFn: typeof fetch = fetch,
): Promise<bigint> {
  fetchFn = guardedFetcher(fetchFn);
  const token = getToken(chain, 'PVT');
  return getErc20Balance(rpcUrl, token.address, address, fetchFn);
}
