/**
 * An agent wallet's ADDRESS LINEAGE, proven from sealed history.
 *
 * A key rotation (rotate-key and recovery-rekey both run
 * `executeKeyRotationTransition`) moves the wallet to a new Base address. It
 * re-creates the native address index row for the new address with
 * `created_at_ms` = the rotation time, re-points the agent registration index
 * (whose `created_at_ms` stays the BIRTH time) and leaves the birth PE bound to
 * the birth address. Every reader that bound the address index to the birth
 * anchors by equality therefore rejected every rotated agent — the inbound USDC
 * watcher excluded Atlas every cycle as
 * `watched_address_enumeration_invalid:agent_registration_index:<wallet>`.
 *
 * This module is the one rotation-aware binding those readers share. It mirrors
 * `computeEffectiveRecoveryIdentity` (registration-recovery-integrity.ts): the
 * current address is anchored at the last rotation, and the rotation is proven
 * by the sealed lineage — exactly N rotation_history entries validated by the
 * shared `validateRotationHistoryEvidenceCore`, each bound to its sealed
 * `agent_key_rotated` PE (same id, same hash, same old→new cut, same time, same
 * H+1 fence). PE METER : those PEs are point-read as identity acts
 * (`readAgentAddressLineagePes`) — the birth PE the registration index pins and
 * each rotation PE its history entry pins — never by walking the agent's chain.
 * An un-rotated wallet resolves to its birth binding unchanged. An address row
 * anchored at neither birth nor a proven rotation is never accepted.
 *
 * `resolveAgentAddressLineage` is pure: every Firestore read is the caller's
 * (`readAgentAddressLineagePes`, `readAgentRotationHistoryRaw`). Throws
 * `AgentAddressLineageError` with a stable reason; nothing here writes.
 */

import {
  readIdentityPe,
  type CanonicalAgentStoredPe,
} from './canonical-agent-pe-chain';
import {
  ROTATION_HISTORY_SUBCOLLECTION,
  validateRotationHistoryEvidenceCore,
  type RotationHistoryEvidenceEntry,
} from './rotation-history-evidence';
import {
  createNativeWalletRegistrationFence,
  parseNativeWalletRegistrationFence,
  type NativeWalletRegistrationFence,
} from '../pvt/native-wallet-registration';
import type { Firestore } from 'firebase-admin/firestore';
import { rethrowWatchReadError } from '../pvt/watch-read-error';

const ADDRESS = /^0x[0-9a-f]{40}$/;

export const AGENT_KEY_ROTATED_PE_ACTION_TYPE = 'agent_key_rotated' as const;
export const AGENT_WALLET_CREATED_PE_ACTION_TYPE = 'agent_wallet_created' as const;

export class AgentAddressLineageError extends Error {
  constructor(readonly reason: string) {
    super(`agent_address_lineage:${reason}`);
    this.name = 'AgentAddressLineageError';
  }
}

function fail(reason: string): never {
  throw new AgentAddressLineageError(reason);
}

/** One address the wallet has held, with the block window it was the wallet's
 * economic identity for. */
export interface AgentAddressLineageSegment {
  /** 0 = birth address; i = the address installed by rotation i. */
  readonly index: number;
  readonly address: string;
  /** When this address became the wallet's identity: birth created_at for the
   * birth address, the rotation's rotated_at for a rotated one. This is the
   * `created_at_ms` its native address index row carried while it was live. */
  readonly anchorMs: number;
  /** The H+1 fence this address was admitted under. For a rotated address it is
   * sealed in its rotation PE. For the birth address of a ROTATED wallet it is
   * null: the rotation overwrote the wallet's fence and no sealed record of the
   * birth fence survives (the caller must recover it from independent evidence
   * or refuse). For the current address it equals the wallet's live fence. */
  readonly fence: NativeWalletRegistrationFence | null;
  /** Last block this address was the wallet's identity: the NEXT rotation's
   * observed head H (the new address is eligible from H+1). null for the
   * current address. */
  readonly retiredAfterBlock: number | null;
  /** The sealed PE that installed this address (birth PE or rotation PE). */
  readonly installedByPeId: string;
  /** The sealed rotation PE that retired it; null for the current address. */
  readonly retiredByPeId: string | null;
}

export interface AgentAddressLineage {
  readonly walletId: string;
  readonly agentId: string;
  readonly birthAddress: string;
  readonly birthCreatedAtMs: number;
  readonly birthPe: CanonicalAgentStoredPe;
  readonly currentAddress: string;
  /** created_at_ms the CURRENT address's native index row must carry. */
  readonly currentAddressAnchorMs: number;
  readonly currentFence: NativeWalletRegistrationFence;
  readonly rotationCount: number;
  readonly rotationEntries: readonly RotationHistoryEvidenceEntry[];
  /** Oldest first; the last segment is the current address. */
  readonly segments: readonly AgentAddressLineageSegment[];
}

export interface AgentAddressLineageInput {
  readonly walletId: string;
  readonly agentId: string;
  /** The live `agent_wallets/{walletId}` document. */
  readonly wallet: Record<string, unknown>;
  /** The agent registration index row (birth anchor + birth PE binding); only
   * `created_at_ms`, `pe_id` and `pe_hash` are read. */
  readonly registrationIndex: Readonly<Record<string, unknown>>;
  /** Raw `agent_wallets/{walletId}/rotation_history` documents ([] if none). */
  readonly rotationHistory: readonly (Record<string, unknown> | undefined)[];
  /** The identity PEs the registration index and rotation history pin, by pe id
   * (`readAgentAddressLineagePes`). A pinned PE that is absent, or whose hash
   * differs from the pin, is not proven. */
  readonly identityPes: IdentityPeLookup;
  readonly now: number;
}

/** Validated identity PEs keyed by pe id. */
export type IdentityPeLookup = ReadonlyMap<string, CanonicalAgentStoredPe>;

/** rotation_count as a wallet carries it; absent is an un-rotated legacy doc. */
export function agentWalletRotationCount(wallet: Record<string, unknown>): number {
  const raw = wallet.rotation_count;
  if (raw === undefined) return 0;
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) fail('wallet_rotation_count');
  return raw as number;
}

function lowerAddress(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) fail(reason);
  return (value as string).toLowerCase();
}

function inChain(
  identityPes: IdentityPeLookup,
  peId: unknown,
  peHash: unknown,
  reason: string,
): CanonicalAgentStoredPe {
  if (typeof peId !== 'string' || typeof peHash !== 'string') fail(reason);
  const pe = identityPes.get(peId as string);
  if (!pe || pe.id !== peId || pe.hash !== peHash) fail(reason);
  return pe;
}

/**
 * Point-read the identity PEs a wallet's address lineage rests on: the birth PE
 * the registration index pins and the rotation PE each rotation_history entry
 * pins. Bounded by the wallet's rotation count (never by its PE history). A PE
 * that is missing or fails validation is simply absent from the lookup, so
 * `resolveAgentAddressLineage` refuses it under its own stable reason
 * (`birth_pe_not_in_chain` / `rotation_pe_not_in_chain`).
 */
export async function readAgentAddressLineagePes(
  db: Firestore,
  params: {
    readonly agentId: string;
    readonly walletId: string;
    readonly registrationIndex: Readonly<Record<string, unknown>>;
    readonly rotationHistory: readonly (Record<string, unknown> | undefined)[];
    readonly maxTimestampMs?: number;
  },
): Promise<IdentityPeLookup> {
  const pins: { peId: string; peHash: string }[] = [];
  const pin = (peId: unknown, peHash: unknown): void => {
    if (typeof peId === 'string' && typeof peHash === 'string') pins.push({ peId, peHash });
  };
  pin(params.registrationIndex.pe_id, params.registrationIndex.pe_hash);
  for (const entry of params.rotationHistory) pin(entry?.pe_id, entry?.pe_hash);
  const lookup = new Map<string, CanonicalAgentStoredPe>();
  await Promise.all(pins.map(async ({ peId, peHash }) => {
    try {
      const pe = await readIdentityPe(db, {
        peId,
        peHash,
        agentId: params.agentId,
        walletId: params.walletId,
        maxTimestampMs: params.maxTimestampMs,
      });
      lookup.set(peId, pe);
    } catch (error) {
      // A failed READ under a watcher's strictReads is a hold, never an absent PE.
      rethrowWatchReadError(error);
      // absent → refused by resolveAgentAddressLineage under its own reason
    }
  }));
  return lookup;
}

function rotationFence(pe: CanonicalAgentStoredPe): NativeWalletRegistrationFence {
  const observed = pe.metadata.observed_head_block;
  if (!Number.isSafeInteger(observed) || (observed as number) < 0) fail('rotation_pe_fence');
  let fence: NativeWalletRegistrationFence;
  try {
    fence = createNativeWalletRegistrationFence(observed as number);
  } catch {
    return fail('rotation_pe_fence');
  }
  if (pe.metadata.eligibility_start_block !== fence.eligibility_start_block) {
    fail('rotation_pe_fence');
  }
  return fence;
}

/**
 * Resolve and prove the wallet's address lineage. Birth binding: the
 * registration index's birth PE is a validated identity PE, is the
 * `agent_wallet_created` PE, and its timestamp equals both the index's and the
 * wallet's `created_at`. Rotation binding (rotation_count > 0): the shared
 * rotation_history validator binds birth → current in exactly N contiguous
 * entries ending at `last_rotated_at`, and every entry is its own sealed
 * `agent_key_rotated` PE whose metadata carries the same cut and a strictly
 * advancing H+1 fence, the last of which is the wallet's live fence.
 */
export function resolveAgentAddressLineage(input: AgentAddressLineageInput): AgentAddressLineage {
  const { wallet, walletId, agentId, identityPes } = input;
  if (wallet.id !== walletId || wallet.agent_id !== agentId) fail('wallet_identity');
  const currentAddress = lowerAddress(wallet.address, 'wallet_address');
  let currentFence: NativeWalletRegistrationFence;
  try {
    currentFence = parseNativeWalletRegistrationFence(wallet.native_watcher_registration);
  } catch {
    return fail('wallet_fence');
  }

  const birthPe = inChain(
    identityPes,
    input.registrationIndex.pe_id,
    input.registrationIndex.pe_hash,
    'birth_pe_not_in_chain',
  );
  const birthCreatedAtMs = input.registrationIndex.created_at_ms;
  // The birth PE opens the agent's chain (prev_hash = genesis): the binding a whole-chain walk's
  // `expectedBirthPeId` used to give, now carried by the point-read identity act itself.
  if (birthPe.action_type !== AGENT_WALLET_CREATED_PE_ACTION_TYPE
    || birthPe.prev_hash !== '0x0000'
    || !Number.isSafeInteger(birthCreatedAtMs)
    || birthPe.timestamp !== birthCreatedAtMs
    || wallet.created_at !== birthCreatedAtMs) {
    fail('birth_binding');
  }
  const birthAddress = lowerAddress(birthPe.actor_address, 'birth_address');
  const rotationCount = agentWalletRotationCount(wallet);

  if (rotationCount === 0) {
    if (wallet.last_rotated_at !== undefined && wallet.last_rotated_at !== null) {
      fail('unrotated_last_rotated_at');
    }
    if (input.rotationHistory.length !== 0) fail('unrotated_rotation_history');
    if (currentAddress !== birthAddress) fail('unrotated_address');
    return {
      walletId,
      agentId,
      birthAddress,
      birthCreatedAtMs: birthCreatedAtMs as number,
      birthPe,
      currentAddress,
      currentAddressAnchorMs: birthCreatedAtMs as number,
      currentFence,
      rotationCount: 0,
      rotationEntries: [],
      segments: [{
        index: 0,
        address: birthAddress,
        anchorMs: birthCreatedAtMs as number,
        fence: currentFence,
        retiredAfterBlock: null,
        installedByPeId: birthPe.id,
        retiredByPeId: null,
      }],
    };
  }

  const lastRotatedAt = wallet.last_rotated_at;
  if (!Number.isSafeInteger(lastRotatedAt) || (lastRotatedAt as number) < 0) {
    fail('wallet_last_rotated_at');
  }
  const entries = validateRotationHistoryEvidenceCore(input.rotationHistory, {
    birthAddress,
    currentAddress,
    rotationCount,
    lastRotatedAt: lastRotatedAt as number,
    now: input.now,
  }, fail);
  if (entries[0].rotated_at <= (birthCreatedAtMs as number)) fail('rotation_before_birth');

  const fences: NativeWalletRegistrationFence[] = [];
  const rotationPeIds: string[] = [];
  entries.forEach((entry, index) => {
    const pe = inChain(identityPes, entry.pe_id, entry.pe_hash, 'rotation_pe_not_in_chain');
    if (pe.action_type !== AGENT_KEY_ROTATED_PE_ACTION_TYPE
      || pe.timestamp !== entry.rotated_at
      || pe.actor_address.toLowerCase() !== entry.new_address
      || pe.metadata.old_address !== entry.old_address
      || pe.metadata.new_address !== entry.new_address
      || pe.metadata.rotation_count !== entry.rotation_count) {
      fail('rotation_pe_binding');
    }
    const fence = rotationFence(pe);
    if (index > 0 && fence.observed_head_block <= fences[index - 1].observed_head_block) {
      fail('rotation_fence_order');
    }
    fences.push(fence);
    rotationPeIds.push(pe.id);
  });
  const terminalFence = fences[fences.length - 1];
  if (terminalFence.observed_head_block !== currentFence.observed_head_block
    || terminalFence.eligibility_start_block !== currentFence.eligibility_start_block) {
    fail('rotation_terminal_fence');
  }

  const segments: AgentAddressLineageSegment[] = [{
    index: 0,
    address: birthAddress,
    anchorMs: birthCreatedAtMs as number,
    fence: null,
    retiredAfterBlock: fences[0].observed_head_block,
    installedByPeId: birthPe.id,
    retiredByPeId: rotationPeIds[0],
  }];
  entries.forEach((entry, index) => {
    const next = index + 1 < entries.length ? index + 1 : null;
    segments.push({
      index: index + 1,
      address: entry.new_address,
      anchorMs: entry.rotated_at,
      fence: fences[index],
      retiredAfterBlock: next === null ? null : fences[next].observed_head_block,
      installedByPeId: rotationPeIds[index],
      retiredByPeId: next === null ? null : rotationPeIds[next],
    });
  });
  return {
    walletId,
    agentId,
    birthAddress,
    birthCreatedAtMs: birthCreatedAtMs as number,
    birthPe,
    currentAddress,
    currentAddressAnchorMs: lastRotatedAt as number,
    currentFence,
    rotationCount,
    rotationEntries: entries,
    segments,
  };
}

/** Raw rotation_history documents for one wallet (read only when rotated). */
export async function readAgentRotationHistoryRaw(
  db: Firestore,
  walletId: string,
): Promise<Record<string, unknown>[]> {
  const snap = await db.collection('agent_wallets').doc(walletId)
    .collection(ROTATION_HISTORY_SUBCOLLECTION).get();
  return snap.docs.map((doc) => doc.data() as Record<string, unknown>);
}
