/**
 * SOLANA ECONOMIC READS — two independently operated JSON-RPC legs, the Solana counterpart of
 * `economic-discovery.ts`.
 *
 * WHO ANSWERS. `SOLANA_RPC_URL` (primary) and `SOLANA_RPC_URL_SECONDARY`, each bound to an operator
 * id. A host on the pinned list resolves to its operator and a declared id must agree with it; an
 * unrecognized host needs its operator declared (`SOLANA_RPC_OPERATOR_ID` /
 * `SOLANA_RPC_SECONDARY_OPERATOR_ID`). The two legs may not share a host or an operator: two
 * hostnames can be one operator, so independence is the operator binding, never the hostname.
 * Both URLs are required — nothing falls back to a default endpoint. A URL can carry an API key, so
 * no error message ever names one (hosts only).
 *
 * THE EVIDENCE READ (`readAgreedSolanaTransaction`). `getTransaction` at `finalized`, jsonParsed,
 * on both legs at once. Each leg's reply is PROJECTED to exactly the fields the chain-record
 * derivation reads (slot, block time, version, `meta.err`, fee, lamport balances, token balances,
 * signers, and the transfer instructions with their parsed fields), and only a byte-identical pair
 * of projections is ever returned. A provider's own annotations (`transactionIndex`, log lines,
 * compute units, `uiAmountString`, an extra key it adds) are outside the projection, so they never
 * split the legs; a difference in any projected field is a disagreement. On disagreement both legs
 * are re-polled together, bounded, then `solana_discovery_rpc_disagreement:<label>` throws — a
 * disagreed answer is never accepted. A leg that fails propagates at once (no retry here). Both legs
 * answering null is "not finalized / unknown" (null); one null against one transaction is a
 * disagreement.
 *
 * THE POINTER READS (signature lists, token accounts, the finalized slot). Discovery only finds
 * signatures to verify; nothing it returns is evidence. Each leg is read on its own and the lane
 * takes the UNION of what the two report, so neither operator alone can hide a transaction (an
 * omission is covered by the other leg), and nothing either reports can mint before both legs agree
 * on the whole transaction above. A failed leg propagates, so a cursor never advances past a range
 * one leg could not be read for. The finalized slot is the LOWER of the two legs' answers.
 */

import crypto from 'crypto';

import { allSettledOrThrow } from '../net/map-bounded';
import { isSolanaAddress, isSolanaSignature } from '../external-address/solana-keys';

// =============================================================================
// CONFIGURATION
// =============================================================================

export const SOLANA_RPC_ENV = 'SOLANA_RPC_URL';
export const SOLANA_RPC_SECONDARY_ENV = 'SOLANA_RPC_URL_SECONDARY';
export const SOLANA_RPC_OPERATOR_ENV = 'SOLANA_RPC_OPERATOR_ID';
export const SOLANA_RPC_SECONDARY_OPERATOR_ENV = 'SOLANA_RPC_SECONDARY_OPERATOR_ID';

/** Hosts whose operator is known. A declared operator id for one of these must match. */
export const SOLANA_KNOWN_OPERATOR_HOST_SUFFIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['alchemy.com', 'alchemy'],
  ['helius-rpc.com', 'helius'],
  ['quiknode.pro', 'quicknode'],
  ['quicknode.com', 'quicknode'],
  ['publicnode.com', 'allnodes'],
  ['mainnet-beta.solana.com', 'solana-foundation'],
  ['drpc.org', 'drpc'],
  ['rpcpool.com', 'triton'],
  ['ankr.com', 'ankr'],
] as const);

/** The highest transaction version the projection reads (jsonParsed shape is the same for 0 and 1). */
export const SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION = 1;
const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(['legacy', '0', '1']);
const RPC_TIMEOUT_MS = 15_000;

type Env = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

export interface SolanaVerifierIdentity {
  readonly primaryOperatorId: string;
  readonly secondaryOperatorId: string;
}

function normalizeOperatorId(value: string | undefined, envName: string): string | null {
  if (value === undefined || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error(`[solana-rpc] ${envName} is not a valid RPC operator id`);
  }
  return normalized;
}

function hostOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('[solana-rpc] Solana RPC URL is invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error(`[solana-rpc] Solana RPC host ${parsed.hostname} must use https`);
  return parsed.hostname.toLowerCase();
}

function knownOperatorForHost(host: string): string | null {
  for (const [suffix, operatorId] of SOLANA_KNOWN_OPERATOR_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return operatorId;
  }
  return null;
}

function resolveOperator(host: string, declaredValue: string | undefined, envName: string): string {
  const known = knownOperatorForHost(host);
  const declared = normalizeOperatorId(declaredValue, envName);
  if (known && declared && known !== declared) {
    throw new Error(`[solana-rpc] ${envName}=${declared} conflicts with the pinned operator ${known} for ${host}`);
  }
  if (known) return known;
  if (declared) return declared;
  throw new Error(`[solana-rpc] ${envName} is required for unrecognized Solana RPC host ${host}`);
}

/**
 * The validated pair of Solana endpoints and their operators. Throws (never defaults) when either
 * URL is missing, not https, the two share a host, or the two resolve to one operator.
 */
export function solanaVerifierEndpointConfig(env: Env = process.env): {
  readonly primaryUrl: string;
  readonly secondaryUrl: string;
  readonly identity: SolanaVerifierIdentity;
} {
  const primaryUrl = env[SOLANA_RPC_ENV]?.trim();
  const secondaryUrl = env[SOLANA_RPC_SECONDARY_ENV]?.trim();
  if (!primaryUrl) throw new Error(`[solana-rpc] ${SOLANA_RPC_ENV} is not set; the primary Solana leg is required`);
  if (!secondaryUrl) {
    throw new Error(`[solana-rpc] ${SOLANA_RPC_SECONDARY_ENV} is not set; the secondary Solana leg is required`);
  }
  const primaryHost = hostOf(primaryUrl);
  const secondaryHost = hostOf(secondaryUrl);
  if (primaryHost === secondaryHost) {
    throw new Error(`[solana-rpc] Solana RPC legs cannot share the same host ${primaryHost}`);
  }
  const primaryOperatorId = resolveOperator(primaryHost, env[SOLANA_RPC_OPERATOR_ENV], SOLANA_RPC_OPERATOR_ENV);
  const secondaryOperatorId = resolveOperator(
    secondaryHost, env[SOLANA_RPC_SECONDARY_OPERATOR_ENV], SOLANA_RPC_SECONDARY_OPERATOR_ENV,
  );
  if (primaryOperatorId === secondaryOperatorId) {
    throw new Error(
      `[solana-rpc] Solana RPC operators must be independent; both legs are operated by ${primaryOperatorId}`,
    );
  }
  return { primaryUrl, secondaryUrl, identity: { primaryOperatorId, secondaryOperatorId } };
}

// =============================================================================
// LEGS
// =============================================================================

/** One operator-bound leg. `send` returns the JSON-RPC `result` (which may be null) or throws. */
export interface SolanaRpcLeg {
  readonly operatorId: string;
  readonly send: (method: string, params: readonly unknown[]) => Promise<unknown>;
}

export type SolanaRpcLegs = readonly [SolanaRpcLeg, SolanaRpcLeg];

function jsonRpcLeg(url: string, operatorId: string, fetchImpl: typeof fetch): SolanaRpcLeg {
  let id = 0;
  return Object.freeze({
    operatorId,
    send: async (method: string, params: readonly unknown[]): Promise<unknown> => {
      id += 1;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch {
        throw new Error(`solana_rpc_leg_failed:${operatorId}:${method}:transport`);
      }
      let body: { result?: unknown; error?: { code?: unknown } };
      try {
        body = await res.json() as typeof body;
      } catch {
        throw new Error(`solana_rpc_leg_failed:${operatorId}:${method}:http_${res.status}`);
      }
      if (!res.ok) throw new Error(`solana_rpc_leg_failed:${operatorId}:${method}:http_${res.status}`);
      if (body && typeof body === 'object' && body.error !== undefined) {
        const code = typeof body.error?.code === 'number' ? body.error.code : 'unknown';
        throw new Error(`solana_rpc_leg_failed:${operatorId}:${method}:rpc_${code}`);
      }
      if (!body || typeof body !== 'object' || !('result' in body)) {
        throw new Error(`solana_rpc_leg_failed:${operatorId}:${method}:no_result`);
      }
      return body.result;
    },
  });
}

/** The two production legs, from the validated configuration. */
export function buildSolanaRpcLegs(env: Env = process.env, fetchImpl: typeof fetch = fetch): SolanaRpcLegs {
  const { primaryUrl, secondaryUrl, identity } = solanaVerifierEndpointConfig(env);
  return Object.freeze([
    jsonRpcLeg(primaryUrl, identity.primaryOperatorId, fetchImpl),
    jsonRpcLeg(secondaryUrl, identity.secondaryOperatorId, fetchImpl),
  ]) as SolanaRpcLegs;
}

function assertIndependent(legs: SolanaRpcLegs): void {
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('solana_discovery_operators_not_independent');
}

// =============================================================================
// AGREEMENT
// =============================================================================

export interface SolanaDisagreementRetry {
  /** Total attempts, the first included. */
  readonly attempts: number;
  /** Pause between attempts, milliseconds. */
  readonly delayMs: number;
}

const DEFAULT_RETRY: SolanaDisagreementRetry = Object.freeze({ attempts: 4, delayMs: 400 });

export interface SolanaReadOptions {
  /** Test-only: bound / pace the both-legs re-poll. */
  readonly disagreementRetry?: Partial<SolanaDisagreementRetry>;
}

function retryOf(options: SolanaReadOptions): SolanaDisagreementRetry {
  const attempts = options.disagreementRetry?.attempts ?? DEFAULT_RETRY.attempts;
  const delayMs = options.disagreementRetry?.delayMs ?? DEFAULT_RETRY.delayMs;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('solana_discovery_retry_config_invalid');
  }
  return { attempts, delayMs };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Read `method` on both legs, project each reply, and return the projection only when the two are
 * byte-identical. Bounded both-legs re-poll on mismatch; a leg (or projection) that throws
 * propagates. Both legs settle before anything is thrown, so no read runs on after this returns.
 */
async function agreedProjection<T>(
  legs: SolanaRpcLegs,
  method: string,
  params: readonly unknown[],
  project: (raw: unknown) => T,
  label: string,
  retry: SolanaDisagreementRetry,
): Promise<T> {
  assertIndependent(legs);
  for (let attempt = 1; ; attempt += 1) {
    const [left, right] = await allSettledOrThrow<[unknown, unknown]>([
      legs[0].send(method, params),
      legs[1].send(method, params),
    ]);
    const a = project(left);
    const b = project(right);
    if (canonicalJson(a) === canonicalJson(b)) return a;
    if (attempt >= retry.attempts) throw new Error(`solana_discovery_rpc_disagreement:${label}`);
    if (retry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
  }
}

// =============================================================================
// THE TRANSACTION PROJECTION
// =============================================================================

export const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_TOKEN_PROGRAMS: ReadonlySet<string> = new Set([SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]);

/** The System and SPL instruction types whose parsed fields are projected (all others: type only). */
const SYSTEM_TRANSFER_TYPES: ReadonlySet<string> = new Set(['transfer']);
const TOKEN_TRANSFER_TYPES: ReadonlySet<string> = new Set(['transfer', 'transferChecked', 'transferCheckedWithFee']);

export interface SolanaProjectedTransferInfo {
  readonly source: string;
  readonly destination: string;
  /** The signing authority (`authority` or `multisigAuthority`); null for a System transfer. */
  readonly authority: string | null;
  /** `transferChecked*` names the mint; a plain `transfer` does not (null). */
  readonly mint: string | null;
  /** Atomic amount as a decimal string (lamports for System, base units for SPL). */
  readonly amount: string;
}

export interface SolanaProjectedInstruction {
  readonly programId: string;
  /** The parsed instruction type, or null when the provider did not parse it. */
  readonly type: string | null;
  /** Only for a System `transfer` and an SPL `transfer` / `transferChecked*`. */
  readonly transfer: SolanaProjectedTransferInfo | null;
}

export interface SolanaProjectedOuterInstruction extends SolanaProjectedInstruction {
  /** Inner (CPI) instructions this instruction ran, in execution order. */
  readonly inner: readonly SolanaProjectedInstruction[];
}

export interface SolanaProjectedTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  /** The token account's owner, or null when the provider did not report one. */
  readonly owner: string | null;
  readonly amount: string;
}

export interface SolanaProjectedTransaction {
  readonly signature: string;
  readonly slot: number;
  /** null when the cluster has no block time for the slot. */
  readonly blockTimeMs: number | null;
  readonly version: 'legacy' | '0' | '1';
  /** `meta.err` canonicalized (null = succeeded). */
  readonly err: string | null;
  /** Lamports; null when not a safe integer (never guessed). */
  readonly fee: string | null;
  readonly accountKeys: ReadonlyArray<{ readonly pubkey: string; readonly signer: boolean; readonly writable: boolean }>;
  /** Lamports per account index; null where the provider's number is not a safe integer. */
  readonly preLamports: ReadonlyArray<string | null>;
  readonly postLamports: ReadonlyArray<string | null>;
  readonly preTokenBalances: readonly SolanaProjectedTokenBalance[];
  readonly postTokenBalances: readonly SolanaProjectedTokenBalance[];
  readonly instructions: readonly SolanaProjectedOuterInstruction[];
}

/** An agreed transaction: the projection plus who agreed on it and its hash. */
export interface SolanaAgreedTransaction extends SolanaProjectedTransaction {
  readonly providerOperatorIds: readonly [string, string];
  readonly evidenceHash: string;
}

const ATOMIC = /^[0-9]{1,40}$/;

function fail(label: string): never {
  throw new Error(`solana_transaction_projection_invalid:${label}`);
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}

function base58Field(value: unknown, label: string): string {
  if (!isSolanaAddress(value)) fail(label);
  return value;
}

function lamportsOf(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(label);
  return Number.isSafeInteger(value) ? String(value) : null;
}

function projectTokenBalances(raw: unknown, label: string): SolanaProjectedTokenBalance[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail(label);
  return raw.map((entry, i) => {
    const row = obj(entry, `${label}[${i}]`);
    const amount = obj(row.uiTokenAmount, `${label}[${i}].uiTokenAmount`).amount;
    if (!Number.isSafeInteger(row.accountIndex) || (row.accountIndex as number) < 0) fail(`${label}[${i}].accountIndex`);
    if (typeof amount !== 'string' || !ATOMIC.test(amount)) fail(`${label}[${i}].amount`);
    return {
      accountIndex: row.accountIndex as number,
      mint: base58Field(row.mint, `${label}[${i}].mint`),
      owner: row.owner === undefined || row.owner === null ? null : base58Field(row.owner, `${label}[${i}].owner`),
      amount: BigInt(amount).toString(),
    };
  });
}

function projectTransferInfo(programId: string, type: string, info: Record<string, unknown>): SolanaProjectedTransferInfo | null {
  if (programId === SOLANA_SYSTEM_PROGRAM && SYSTEM_TRANSFER_TYPES.has(type)) {
    const lamports = info.lamports;
    if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) fail('system_transfer.lamports');
    return {
      source: base58Field(info.source, 'system_transfer.source'),
      destination: base58Field(info.destination, 'system_transfer.destination'),
      authority: null,
      mint: null,
      amount: String(lamports),
    };
  }
  if (SOLANA_TOKEN_PROGRAMS.has(programId) && TOKEN_TRANSFER_TYPES.has(type)) {
    const authorityRaw = info.authority ?? info.multisigAuthority;
    let amount: unknown;
    if (type === 'transfer') {
      amount = info.amount;
    } else {
      amount = obj(info.tokenAmount, 'token_transfer.tokenAmount').amount;
    }
    if (typeof amount !== 'string' || !ATOMIC.test(amount)) fail('token_transfer.amount');
    return {
      source: base58Field(info.source, 'token_transfer.source'),
      destination: base58Field(info.destination, 'token_transfer.destination'),
      authority: authorityRaw === undefined ? null : base58Field(authorityRaw, 'token_transfer.authority'),
      mint: type === 'transfer' ? null : base58Field(info.mint, 'token_transfer.mint'),
      amount: BigInt(amount).toString(),
    };
  }
  return null;
}

function projectInstruction(raw: unknown, label: string): SolanaProjectedInstruction {
  const ix = obj(raw, label);
  if (typeof ix.programId !== 'string' || !isSolanaAddress(ix.programId)) fail(`${label}.programId`);
  const programId = ix.programId;
  const parsed = ix.parsed;
  if (parsed === undefined || parsed === null || typeof parsed === 'string') {
    // Unparsed (raw data) or a string-parsed program (memo): the type is all the derivation reads.
    return { programId, type: null, transfer: null };
  }
  const p = obj(parsed, `${label}.parsed`);
  const type = typeof p.type === 'string' ? p.type : null;
  if (type === null) return { programId, type: null, transfer: null };
  const info = p.info === undefined ? {} : obj(p.info, `${label}.parsed.info`);
  return { programId, type, transfer: projectTransferInfo(programId, type, info) };
}

/**
 * Project ONE leg's jsonParsed `getTransaction` reply (non-null) to the fields the derivation
 * reads. Throws on anything malformed (a leg whose reply cannot be read is a failed leg). Pure.
 */
export function projectSolanaTransaction(raw: unknown): SolanaProjectedTransaction {
  const r = obj(raw, 'result');
  const meta = obj(r.meta, 'meta');
  const transaction = obj(r.transaction, 'transaction');
  const message = obj(transaction.message, 'message');
  if (!Number.isSafeInteger(r.slot) || (r.slot as number) <= 0) fail('slot');
  let blockTimeMs: number | null = null;
  if (r.blockTime !== null && r.blockTime !== undefined) {
    if (!Number.isSafeInteger(r.blockTime) || (r.blockTime as number) <= 0) fail('blockTime');
    blockTimeMs = (r.blockTime as number) * 1_000;
  }
  const version = r.version === undefined ? 'legacy' : String(r.version);
  if (!SUPPORTED_VERSIONS.has(version)) fail(`version:${version}`);
  if (!Array.isArray(transaction.signatures) || transaction.signatures.length === 0
    || !transaction.signatures.every((s) => isSolanaSignature(s))) {
    fail('signatures');
  }
  if (!Array.isArray(message.accountKeys) || message.accountKeys.length === 0) fail('accountKeys');
  const accountKeys = message.accountKeys.map((entry, i) => {
    const k = obj(entry, `accountKeys[${i}]`);
    if (typeof k.signer !== 'boolean' || typeof k.writable !== 'boolean') fail(`accountKeys[${i}].flags`);
    return { pubkey: base58Field(k.pubkey, `accountKeys[${i}].pubkey`), signer: k.signer, writable: k.writable };
  });
  const lamportsList = (value: unknown, label: string): Array<string | null> => {
    if (!Array.isArray(value) || value.length !== accountKeys.length) fail(label);
    return value.map((v, i) => lamportsOf(v, `${label}[${i}]`));
  };
  const preLamports = lamportsList(meta.preBalances, 'preBalances');
  const postLamports = lamportsList(meta.postBalances, 'postBalances');
  if (!Array.isArray(message.instructions)) fail('instructions');
  const innerByIndex = new Map<number, SolanaProjectedInstruction[]>();
  if (meta.innerInstructions !== undefined && meta.innerInstructions !== null) {
    if (!Array.isArray(meta.innerInstructions)) fail('innerInstructions');
    meta.innerInstructions.forEach((group, g) => {
      const entry = obj(group, `innerInstructions[${g}]`);
      if (!Number.isSafeInteger(entry.index) || (entry.index as number) < 0
        || (entry.index as number) >= (message.instructions as unknown[]).length
        || innerByIndex.has(entry.index as number)
        || !Array.isArray(entry.instructions)) {
        fail(`innerInstructions[${g}]`);
      }
      innerByIndex.set(entry.index as number, (entry.instructions as unknown[]).map((ix, j) =>
        projectInstruction(ix, `innerInstructions[${g}].instructions[${j}]`)));
    });
  }
  const instructions = (message.instructions as unknown[]).map((ix, i) => ({
    ...projectInstruction(ix, `instructions[${i}]`),
    inner: innerByIndex.get(i) ?? [],
  }));
  let fee: string | null = null;
  if (meta.fee !== undefined) fee = lamportsOf(meta.fee, 'fee');
  else fail('fee');
  return {
    signature: transaction.signatures[0] as string,
    slot: r.slot as number,
    blockTimeMs,
    version: version as SolanaProjectedTransaction['version'],
    err: meta.err === null || meta.err === undefined ? null : canonicalJson(meta.err),
    fee,
    accountKeys,
    preLamports,
    postLamports,
    preTokenBalances: projectTokenBalances(meta.preTokenBalances, 'preTokenBalances'),
    postTokenBalances: projectTokenBalances(meta.postTokenBalances, 'postTokenBalances'),
    instructions,
  };
}

export function hashSolanaTransactionEvidence(projection: SolanaProjectedTransaction): string {
  return `sha256:${crypto.createHash('sha256')
    .update(canonicalJson({ schema: 'solana-transaction-evidence/v1', ...projection }))
    .digest('hex')}`;
}

/**
 * The FINALIZED transaction `signature`, agreed by both legs on the projection, or null when both
 * legs say it is not finalized (or unknown). One leg null against the other's transaction is a
 * disagreement (re-polled, then thrown).
 */
export async function readAgreedSolanaTransaction(
  legs: SolanaRpcLegs,
  signature: string,
  options: SolanaReadOptions = {},
): Promise<SolanaAgreedTransaction | null> {
  if (!isSolanaSignature(signature)) throw new Error('solana_transaction_request_invalid');
  const projection = await agreedProjection(
    legs,
    'getTransaction',
    [signature, {
      encoding: 'jsonParsed',
      commitment: 'finalized',
      maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
    }],
    (raw) => (raw === null ? null : projectSolanaTransaction(raw)),
    'transaction',
    retryOf(options),
  );
  if (projection === null) return null;
  if (projection.signature !== signature) throw new Error('solana_transaction_signature_mismatch');
  return Object.freeze({
    ...projection,
    providerOperatorIds: [legs[0].operatorId, legs[1].operatorId] as const,
    evidenceHash: hashSolanaTransactionEvidence(projection),
  });
}

// =============================================================================
// POINTER READS (discovery)
// =============================================================================

/** One signature a leg reported for an address (a pointer; never evidence). */
export interface SolanaSignaturePointer {
  readonly signature: string;
  readonly slot: number;
  readonly blockTimeMs: number | null;
  /** The leg reported the transaction as succeeded (`err === null`). */
  readonly succeeded: boolean;
}

export const SOLANA_SIGNATURE_PAGE_MAX = 1_000;

/** One page of `getSignaturesForAddress` at `finalized` from ONE leg, newest first. */
export async function readSolanaSignaturesPage(
  leg: SolanaRpcLeg,
  address: string,
  page: { readonly before: string | null; readonly limit: number },
): Promise<SolanaSignaturePointer[]> {
  if (!isSolanaAddress(address)) throw new Error('solana_signatures_address_invalid');
  if (page.before !== null && !isSolanaSignature(page.before)) throw new Error('solana_signatures_before_invalid');
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > SOLANA_SIGNATURE_PAGE_MAX) {
    throw new Error('solana_signatures_limit_invalid');
  }
  const raw = await leg.send('getSignaturesForAddress', [address, {
    limit: page.limit,
    commitment: 'finalized',
    ...(page.before !== null ? { before: page.before } : {}),
  }]);
  if (!Array.isArray(raw)) throw new Error(`solana_signatures_invalid:${leg.operatorId}`);
  if (raw.length > page.limit) throw new Error(`solana_signatures_over_limit:${leg.operatorId}`);
  return raw.map((entry) => {
    const e = obj(entry, 'signature_entry');
    if (!isSolanaSignature(e.signature) || !Number.isSafeInteger(e.slot) || (e.slot as number) <= 0) {
      throw new Error(`solana_signatures_invalid:${leg.operatorId}`);
    }
    const bt = e.blockTime;
    const blockTimeMs = typeof bt === 'number' && Number.isSafeInteger(bt) && bt > 0 ? bt * 1_000 : null;
    return { signature: e.signature, slot: e.slot as number, blockTimeMs, succeeded: e.err === null || e.err === undefined };
  });
}

/** The finalized slot both legs have reached: the lower of their two answers. */
export async function readSolanaFinalizedSlotFloor(legs: SolanaRpcLegs): Promise<number> {
  assertIndependent(legs);
  const [a, b] = await allSettledOrThrow<[unknown, unknown]>([
    legs[0].send('getSlot', [{ commitment: 'finalized' }]),
    legs[1].send('getSlot', [{ commitment: 'finalized' }]),
  ]);
  for (const slot of [a, b]) {
    if (!Number.isSafeInteger(slot) || (slot as number) <= 0) throw new Error('solana_finalized_slot_invalid');
  }
  return Math.min(a as number, b as number);
}

/**
 * Every SPL token account (Token and Token-2022) `owner` holds, the UNION of both legs' answers,
 * sorted. A token receive into an existing account does not name the owner in the transaction, so
 * each of these accounts is scanned too.
 */
export async function readSolanaTokenAccountsUnion(legs: SolanaRpcLegs, owner: string): Promise<string[]> {
  if (!isSolanaAddress(owner)) throw new Error('solana_token_accounts_owner_invalid');
  assertIndependent(legs);
  const reads: Array<Promise<unknown>> = [];
  for (const programId of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) {
    for (const leg of legs) {
      reads.push(leg.send('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 0 } }]));
    }
  }
  const results = await allSettledOrThrow<unknown[]>(reads);
  const accounts = new Set<string>();
  for (const result of results) {
    const value = obj(result, 'token_accounts').value;
    if (!Array.isArray(value)) throw new Error('solana_token_accounts_invalid');
    for (const entry of value) {
      const pubkey = obj(entry, 'token_account').pubkey;
      if (!isSolanaAddress(pubkey)) throw new Error('solana_token_accounts_invalid');
      if (pubkey !== owner) accounts.add(pubkey);
    }
  }
  return [...accounts].sort();
}
