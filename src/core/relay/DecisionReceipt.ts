import type { BiometricAction } from '../security/biometricAction';
/**
 * Decision Receipt - Signed Proof of Authorization Decision
 * ==========================================================
 *
 * When a wallet user approves or denies a relay request, this module creates
 * a cryptographically signed receipt that agents can independently verify.
 *
 * KEY DISTINCTION FROM AUTHORIZATION TOKENS:
 * - Authorization tokens are runtime-only (WeakSet-backed, cannot leave memory)
 * - Decision receipts are serializable proofs for remote verification
 * - Receipts do NOT grant execution rights - they only prove a decision was made
 *
 * CANONICAL FORMAT:
 * The request hash uses a deterministic JSON format with sorted keys to ensure
 * the same input always produces the same hash, regardless of key ordering.
 *
 * SIGNATURE:
 * Uses the wallet's existing signing key (ethers/secp256k1) which is already
 * stored in SecureStore. Verification dispatches via KeyManager.verifySignature
 * (handles P-256 hardware signatures and secp256k1 dev fallback).
 */

import * as Crypto from 'expo-crypto';
import KeyManager from '../security/KeyManager';

// ============================================================================
// Types
// ============================================================================

/** Payload fields used to compute the canonical request hash */
export interface RequestPayload {
  agentId: string;
  actionType: string;
  amount: number;
  currency: string;
  merchant: string;
  purpose: string;
  metadata?: Record<string, unknown>;
}

/** The signed decision receipt */
export interface DecisionReceipt {
  /** Version for future compatibility */
  version: '1.0';

  /** Unique request identifier from the relay */
  requestId: string;

  /** Wallet that made the decision */
  walletId: string;

  /** The authorization decision */
  decision: 'ALLOW' | 'DENY';

  /** ISO timestamp when decision was made */
  decidedAt: string;

  /** SHA-256 hash of the canonical request payload */
  requestHash: string;

  /** Optional reason codes explaining the decision */
  reasonCodes?: string[];

  /** Optional human-readable notes */
  notes?: string;

  /** Wallet's secp256k1 signature over the receipt payload */
  signature: string;

  /** Wallet's public key for verification */
  signerPublicKey: string;

  /** Wallet's address (derived from public key) */
  signerAddress: string;
}

/** Receipt without signature (for signing) */
export type UnsignedReceipt = Omit<DecisionReceipt, 'signature'>;

/** Verification result */
export interface VerificationResult {
  valid: boolean;
  error?: string;
  recoveredAddress?: string;
}

/**
 * [M-40] Thrown by parseReceipt when the input cannot be deserialized
 * (malformed JSON or missing required fields). Distinct from verification
 * failure: this fires before any signature check.
 */
export class DecisionReceiptParseError extends Error {
  readonly code = 'DECISION_RECEIPT_PARSE_FAILED';
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'DecisionReceiptParseError';
    this.cause = cause;
  }
}

/**
 * [M-41] Thrown by canonicalization when a value cannot be deterministically
 * serialized (Symbol, function, BigInt). Receipts must be reproducible bit
 * for bit; ambiguous values are rejected at the source so callers convert
 * them explicitly rather than relying on engine defaults.
 */
export class DecisionReceiptInvalidValueError extends Error {
  readonly code = 'DECISION_RECEIPT_INVALID_VALUE';
  readonly valueType: string;

  constructor(message: string, valueType: string) {
    super(message);
    this.name = 'DecisionReceiptInvalidValueError';
    this.valueType = valueType;
  }
}

// ============================================================================
// Canonical Hashing
// ============================================================================

/**
 * Recursively sorts object keys for deterministic JSON serialization.
 * Arrays maintain their order; objects have keys sorted alphabetically.
 *
 * [M-41] Edge type handling for deterministic output:
 *   - null            preserved as null
 *   - Date            converted to ISO string via toISOString()
 *   - undefined (obj) the key is skipped entirely
 *   - undefined (arr) coerced to null (matches JSON.stringify default
 *                     and avoids changing array length)
 *   - Symbol          throws DecisionReceiptInvalidValueError
 *   - function        throws DecisionReceiptInvalidValueError
 *   - BigInt          throws DecisionReceiptInvalidValueError (callers
 *                     must convert explicitly; we will not guess)
 */
function sortObjectKeys(obj: unknown): unknown {
  // null is preserved (typeof null === 'object', so check first).
  if (obj === null) return null;

  const t = typeof obj;

  if (t === 'symbol') {
    throw new DecisionReceiptInvalidValueError(
      'Symbol values cannot be deterministically serialized in a decision receipt',
      'symbol',
    );
  }
  if (t === 'function') {
    throw new DecisionReceiptInvalidValueError(
      'Function values cannot be deterministically serialized in a decision receipt',
      'function',
    );
  }
  if (t === 'bigint') {
    throw new DecisionReceiptInvalidValueError(
      'BigInt values cannot be deterministically serialized; convert to string before building the receipt',
      'bigint',
    );
  }

  // Primitives (string, number, boolean) pass through.
  if (t !== 'object') return obj;

  // Date is an object but not a plain object: serialize as ISO string.
  if (obj instanceof Date) return obj.toISOString();

  if (Array.isArray(obj)) {
    return obj.map((item) => (item === undefined ? null : sortObjectKeys(item)));
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();

  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    // undefined skips the key entirely (do not emit "key":undefined).
    if (value === undefined) continue;
    sorted[key] = sortObjectKeys(value);
  }

  return sorted;
}

/**
 * Builds a canonical JSON string from the request payload.
 * Keys are sorted alphabetically at all levels for determinism.
 */
export function buildCanonicalPayload(payload: RequestPayload): string {
  const canonical = {
    agentId: payload.agentId,
    actionType: payload.actionType,
    amount: payload.amount,
    currency: payload.currency,
    merchant: payload.merchant,
    purpose: payload.purpose,
    metadata: payload.metadata ?? {},
  };

  const sorted = sortObjectKeys(canonical);
  return JSON.stringify(sorted);
}

/**
 * Computes SHA-256 hash of the canonical request payload.
 * This binds the receipt to the exact request parameters.
 */
export async function buildRequestHash(payload: RequestPayload): Promise<string> {
  const canonical = buildCanonicalPayload(payload);
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonical
  );
  return hash;
}

// ============================================================================
// Receipt Building
// ============================================================================

export interface BuildReceiptParams {
  requestId: string;
  walletId: string;
  decision: 'ALLOW' | 'DENY';
  requestPayload: RequestPayload;
  reasonCodes?: string[];
  notes?: string;
}

/**
 * Builds a signed decision receipt.
 *
 * @throws Error if wallet key is not available or signing fails
 */
export async function buildAndSignReceipt(params: BuildReceiptParams, biometricAction?: BiometricAction): Promise<DecisionReceipt> {
  // 1. Get wallet signing info
  const [publicKey, address] = await Promise.all([
    KeyManager.getPublicKey(),
    KeyManager.getAddress(),
  ]);

  if (!publicKey || !address) {
    throw new Error('Wallet not initialized - cannot sign receipt');
  }

  // 2. Compute request hash
  const requestHash = await buildRequestHash(params.requestPayload);

  // 3. Build unsigned receipt
  const unsignedReceipt: UnsignedReceipt = {
    version: '1.0',
    requestId: params.requestId,
    walletId: params.walletId,
    decision: params.decision,
    decidedAt: new Date().toISOString(),
    requestHash,
    reasonCodes: params.reasonCodes,
    notes: params.notes,
    signerPublicKey: publicKey,
    signerAddress: address,
  };

  // 4. Build canonical message for signing (excluding signature field)
  const message = buildReceiptMessage(unsignedReceipt);

  // 5. Sign the message
  const signature = await KeyManager.signPayload(message, biometricAction);

  // 6. Return complete receipt
  return {
    ...unsignedReceipt,
    signature,
  };
}

/**
 * Builds the message that gets signed.
 * Uses a deterministic format that can be reconstructed for verification.
 */
function buildReceiptMessage(receipt: UnsignedReceipt): string {
  // Create a canonical object with only the fields we sign
  const toSign = {
    version: receipt.version,
    requestId: receipt.requestId,
    walletId: receipt.walletId,
    decision: receipt.decision,
    decidedAt: receipt.decidedAt,
    requestHash: receipt.requestHash,
    reasonCodes: receipt.reasonCodes ?? [],
    notes: receipt.notes ?? '',
    signerAddress: receipt.signerAddress,
  };

  const sorted = sortObjectKeys(toSign);
  return JSON.stringify(sorted);
}

// ============================================================================
// Receipt Verification
// ============================================================================

/**
 * Verifies a decision receipt signature.
 *
 * This can be called by anyone (agent, relay, third party) who has the receipt
 * and wants to verify it was genuinely signed by the wallet.
 *
 * @param receipt - The complete signed receipt
 * @param expectedSignerAddress - Optional: verify the signer matches expected wallet
 */
export async function verifyReceipt(
  receipt: DecisionReceipt,
  expectedSignerAddress?: string
): Promise<VerificationResult> {
  try {
    // 1. Reconstruct the message that was signed
    const unsignedReceipt: UnsignedReceipt = {
      version: receipt.version,
      requestId: receipt.requestId,
      walletId: receipt.walletId,
      decision: receipt.decision,
      decidedAt: receipt.decidedAt,
      requestHash: receipt.requestHash,
      reasonCodes: receipt.reasonCodes,
      notes: receipt.notes,
      signerPublicKey: receipt.signerPublicKey,
      signerAddress: receipt.signerAddress,
    };

    const message = buildReceiptMessage(unsignedReceipt);

    // [Group 4 / H-3 / chunk-B C-7] Use KeyManager.verifySignature, which
    // dispatches on signature length: 64-byte r||s for P-256 hardware
    // signatures from the Secure Enclave, 65-byte r||s||v for secp256k1
    // dev fallback. Previous implementation called ethers.verifyMessage
    // directly, which only handles secp256k1 and rejected every receipt
    // signed by real iOS/Android hardware.
    const result = await KeyManager.verifySignature(
      message,
      receipt.signature,
      receipt.signerAddress,
    );

    if (!result.isValid) {
      return {
        valid: false,
        error: result.error || 'Signature does not match claimed signer address',
        recoveredAddress: result.recoveredAddress ?? undefined,
      };
    }

    const recoveredAddress = result.recoveredAddress ?? receipt.signerAddress;

    // If expected address provided, verify it matches
    if (expectedSignerAddress &&
        recoveredAddress.toLowerCase() !== expectedSignerAddress.toLowerCase()) {
      return {
        valid: false,
        error: 'Signer address does not match expected address',
        recoveredAddress,
      };
    }

    return {
      valid: true,
      recoveredAddress,
    };

  } catch (error) {
    return {
      valid: false,
      error: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Verifies that a receipt's requestHash matches the given payload.
 * Use this to ensure the receipt corresponds to the expected request.
 */
export async function verifyRequestHash(
  receipt: DecisionReceipt,
  payload: RequestPayload
): Promise<boolean> {
  const computedHash = await buildRequestHash(payload);
  return computedHash === receipt.requestHash;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Serialize a receipt to a compact JSON string for transmission.
 */
export function serializeReceipt(receipt: DecisionReceipt): string {
  return JSON.stringify(receipt);
}

/**
 * Parse a serialized receipt.
 *
 * [M-40] Throws DecisionReceiptParseError on malformed JSON or missing
 * required fields. Callers should catch this distinctly from
 * verification errors.
 */
export function parseReceipt(serialized: string): DecisionReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    throw new DecisionReceiptParseError(
      'Invalid receipt format: malformed JSON',
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !(parsed as { version?: unknown }).version ||
    !(parsed as { requestId?: unknown }).requestId ||
    !(parsed as { signature?: unknown }).signature
  ) {
    throw new DecisionReceiptParseError('Invalid receipt format: missing required fields');
  }

  return parsed as DecisionReceipt;
}

/**
 * Get the wallet's public key for sharing with agents.
 * Agents need this to verify receipts.
 */
export async function getReceiptSigningPublicKey(): Promise<string | null> {
  return KeyManager.getPublicKey();
}

/**
 * Get the wallet's address for sharing with agents.
 */
export async function getReceiptSignerAddress(): Promise<string | null> {
  return KeyManager.getAddress();
}
