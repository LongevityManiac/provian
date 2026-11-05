/**
 * Immutable Base watcher fence captured while a native Provian wallet is
 * registered. The observed head is read from the two operator-bound verifier
 * legs; activity starts at the following block so activity at or before the
 * registration observation cannot earn.
 */

import crypto from 'crypto';

/**
 * Durable terminal marker for a retired address (doc id = the lowercased
 * address), written by the agent key rotation (`agent-wallet/key-rotation-
 * transition.ts`, which re-exports this). The old native address index is
 * DELETED in the same transaction; this tombstone is the append-only record that
 * the address was retired from an agent: it can never be re-registered, and no
 * one else can prove it as their outside wallet (one address, one owner).
 */
export const AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION =
  'agent_wallet_address_retirements_v1' as const;

export const NATIVE_WALLET_REGISTRATION_SCHEMA =
  'native-wallet-base-registration/v1' as const;
export const NATIVE_WALLET_REGISTRATION_CHAIN_ID = 8453 as const;
export const NATIVE_WALLET_ADDRESS_INDEX_COLLECTION =
  'native_wallet_address_index_v1' as const;
export const NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION =
  'native_agent_registration_by_agent_v1' as const;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function nativeWalletAddressIndexId(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('native_wallet_registration_address_invalid');
  }
  return `address_${sha256(address.toLowerCase())}`;
}

export function nativeAgentRegistrationIndexId(agentId: string): string {
  if (!agentId || agentId.length > 200) {
    throw new Error('native_agent_registration_id_invalid');
  }
  return `agent_${sha256(agentId)}`;
}

export interface NativeWalletRegistrationFence {
  readonly schema_version: typeof NATIVE_WALLET_REGISTRATION_SCHEMA;
  readonly chain_id: typeof NATIVE_WALLET_REGISTRATION_CHAIN_ID;
  readonly observed_head_block: number;
  readonly eligibility_start_block: number;
}

const EXACT_KEYS = Object.freeze([
  'chain_id',
  'eligibility_start_block',
  'observed_head_block',
  'schema_version',
] as const);

function exactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...EXACT_KEYS].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function createNativeWalletRegistrationFence(
  observedHeadBlock: number,
): NativeWalletRegistrationFence {
  if (!Number.isSafeInteger(observedHeadBlock)
    || observedHeadBlock < 0
    || observedHeadBlock >= Number.MAX_SAFE_INTEGER) {
    throw new Error('native_wallet_registration_head_invalid');
  }
  return Object.freeze({
    schema_version: NATIVE_WALLET_REGISTRATION_SCHEMA,
    chain_id: NATIVE_WALLET_REGISTRATION_CHAIN_ID,
    observed_head_block: observedHeadBlock,
    eligibility_start_block: observedHeadBlock + 1,
  });
}

export function parseNativeWalletRegistrationFence(
  value: unknown,
): NativeWalletRegistrationFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native_wallet_registration_fence_invalid');
  }
  const fence = value as Record<string, unknown>;
  if (!exactKeys(fence)
    || fence.schema_version !== NATIVE_WALLET_REGISTRATION_SCHEMA
    || fence.chain_id !== NATIVE_WALLET_REGISTRATION_CHAIN_ID
    || !Number.isSafeInteger(fence.observed_head_block)
    || (fence.observed_head_block as number) < 0
    || !Number.isSafeInteger(fence.eligibility_start_block)
    || fence.eligibility_start_block !== (fence.observed_head_block as number) + 1) {
    throw new Error('native_wallet_registration_fence_invalid');
  }
  return fence as unknown as NativeWalletRegistrationFence;
}

// =============================================================================
// CANONICAL NATIVE ADDRESS INDEX (`native_wallet_address_index_v1`)
// =============================================================================
//
// The authoritative address -> owner binding for every native Provian wallet.
// The same-owner fence (`same-owner-detection.ts`) and both USDC watchers read
// it. It lives HERE, in the module that already owns the collection constant, so
// the shape has ONE parser rather than a copy per reader (one source, no
// drift). `inbound-usdc-watcher.ts` (native RECEIVE admission) and the outbound
// native x402 admission (3d) both import this.

export const CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA =
  'native-wallet-address-index/v1' as const;

/** Exact key set of a `native_wallet_address_index_v1` document. */
export const NATIVE_ADDRESS_INDEX_KEYS = Object.freeze([
  'schema_version',
  'chain_id',
  'address',
  'wallet_id',
  'owner_type',
  'owner_id',
  'created_at_ms',
] as const);

export interface CanonicalNativeAddressIndex {
  readonly schema_version: typeof CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA;
  readonly chain_id: typeof NATIVE_WALLET_REGISTRATION_CHAIN_ID;
  readonly address: string;
  readonly wallet_id: string;
  readonly owner_type: 'agent' | 'human';
  readonly owner_id: string;
  readonly created_at_ms: number;
}

function exactKeyList(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function isCanonicalIndexAddress(value: unknown): value is string {
  // Lowercase form only: the index stores the address as its own lowercased
  // form, and the watchers compare against a lowercased log topic.
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
}

/**
 * Parse and validate one `native_wallet_address_index_v1` document. Throws
 * `watched_address_enumeration_invalid:native_address_index:<documentId>` on any
 * shape violation — a malformed authority record is never guessed past.
 */
export function parseCanonicalNativeAddressIndex(
  raw: Record<string, unknown> | undefined,
  documentId: string,
): CanonicalNativeAddressIndex {
  if (!raw
    || !exactKeyList(raw, NATIVE_ADDRESS_INDEX_KEYS)
    || raw.schema_version !== CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA
    || raw.chain_id !== NATIVE_WALLET_REGISTRATION_CHAIN_ID
    || !isCanonicalIndexAddress(raw.address)
    || typeof raw.wallet_id !== 'string' || raw.wallet_id.length === 0
    || (raw.owner_type !== 'agent' && raw.owner_type !== 'human')
    || typeof raw.owner_id !== 'string' || raw.owner_id.length === 0
    || !Number.isSafeInteger(raw.created_at_ms) || (raw.created_at_ms as number) < 0) {
    throw new Error(`watched_address_enumeration_invalid:native_address_index:${documentId}`);
  }
  return raw as unknown as CanonicalNativeAddressIndex;
}
