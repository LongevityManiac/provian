/**
 * Same-owner (self-dealing) detection for financial-action PEs.
 *
 * WHY THIS EXISTS. `monetary-accounting.ts` already implements the economic
 * consequence: when `beneficialOwnershipPolicy === 'record_only_if_self_shared_or_churn'`
 * and `selfReferencing || sharedBeneficialOwnership`, the record is sealed
 * `record_only` with reason `self_or_shared_beneficial_ownership`. 90 of the 254
 * action-policy rows carry that policy. What did NOT exist was any producer for
 * those two inputs: `economicSelfReferencing` and `economicSharedBeneficialOwnership`
 * appeared exactly twice each in the entire tree — a type declaration and a read —
 * so both evaluated `undefined === true` -> false on every PE ever recorded. The
 * guard was armed and could not fire. This module is the missing producer.
 *
 * WHAT COUNTS AS THE SAME OWNER. An address is same-owner when it resolves to the
 * same owning identity as the actor, through any of three registries:
 * 1. `native_wallet_address_index_v1` the canonical native-address index. It
 * carries `owner_type` ('agent' | 'human') AND `owner_id`, so it resolves
 * BOTH agent-owned and human-owned wallets, and it is what makes the
 * multi-agent-per-human case decidable rather than assumed.
 * 2. `proven_addresses` an external EOA an agent proved control of. Doc id IS
 * the lowercase address. One address per agent by protocol rule.
 * 3. `agent_wallet_address_retirements_v1` an address rotated away from. A
 * rotated-away address is STILL the same owner; omitting it would make key
 * rotation a self-dealing laundering step.
 *
 * FAIL-CLOSED (Security Invariant #7, "Unknown = Block, Not Warn"). A registry
 * read that THROWS is not evidence of absence. Returning `selfReferencing:false`
 * on an infrastructure error would mint a payment we failed to check — precisely
 * the farming case this exists to stop. So errors surface as `unresolvable:true`
 * and the caller routes to `pending_review`, never to a mint and never to a
 * silent deny. Absence of a record after a SUCCESSFUL read is genuine absence and
 * is not self-dealing.
 *
 * UNUSABLE IS UNKNOWN, NOT ABSENCE (-a). A registry that ANSWERS with a
 * document the fence cannot use — a native-index row failing the canonical
 * shape (owner_id absent, wallet_id unreadable,...), a proven/retired row with
 * no readable wallet or agent id, an `agent_wallets` doc that a registry row
 * names but which does not exist, a registration row whose `wallet_id` is
 * unreadable — is NOT evidence that the address belongs to someone else. Before
 * -a each of those RETURNED as if the registry had said "not ours", and the
 * verdict fell through to `distinct_owner` with the fence OFF. They now surface
 * as `unresolvable:true` with reason `ownership_registry_unusable:*` (a reason
 * distinct from the throw path's `ownership_registry_unavailable:*`, so the two
 * failure classes stay tellable apart in logs), and route to the same
 * recoverable `pending_review` hold. The absent-`agent_wallets` shape is
 * reachable in production (an orphaned index row whose wallet doc was deleted
 * took the outbound watcher down from 2026-08-13 — see `outbound-usdc-watcher.ts`).
 *
 * The raw-document classifiers below are exported precisely so each violating
 * shape is CONSTRUCTIBLE at the detection boundary (`Record<string, unknown> |
 * null`), while every call site keeps the narrow `AddressOwnership` /
 * `ResolvedParty` types. A guard whose violating input cannot be built cannot be
 * tested (CLAUDE.md, "the unreachable branch").
 */

import type { Firestore } from 'firebase-admin/firestore';

import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  nativeAgentRegistrationIndexId,
  parseCanonicalNativeAddressIndex,
} from '../native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../../external-address/link';
import { AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../../agent-wallet/key-rotation-transition';

/** Which registry produced a resolution. Recorded so a verdict is explainable. */
export type OwnershipSource =
  | 'native_address_index'
  | 'proven_external_address'
  | 'person_proven_external_address'
  | 'retired_address';

export interface AddressOwnership {
  readonly ownerType: 'agent' | 'human' | null;
  readonly ownerId: string | null;
  readonly walletId: string | null;
  readonly source: OwnershipSource;
}

export interface SameOwnerVerdict {
  readonly selfReferencing: boolean;
  readonly sharedBeneficialOwnership: boolean;
  /** True when a registry read FAILED. Caller must not mint on an unresolved check. */
  readonly unresolvable: boolean;
  /** Human-readable basis for the verdict; safe to log (identifiers only). */
  readonly reason: string;
}

export interface SameOwnerInput {
  /**
   * The PE's `economicActorId`. For agent PEs this is the **agent_id**
   * (`generatePE` sets `userId: params.agentId`), NOT a wallet id and NOT the
   * owning human. For human PEs it is the user_id. Both shapes are resolved
   * below rather than assumed —.
   */
  readonly economicActorId: string | null;
  /**
   * Optional pre-resolved acting wallet id. Almost no caller has one; when
   * absent the actor is resolved from `economicActorId` through the agent
   * registration index.
   */
  readonly actingWalletId?: string | null;
  /** Counterparty address from the financial PE. Null on non-financial actions. */
  readonly counterpartyAddress?: string | null;
}

/** An identity reduced to the two things a same-owner test can compare. */
interface ResolvedParty {
  readonly walletId: string | null;
  /**
   * The HUMAN this party's value ultimately accrues to, when one is resolvable.
   * For an agent wallet that is `agent_wallets/{wallet_id}.linked_human_user_id`;
   * for a human wallet it is the user_id itself. Null when unlinked.
   */
  readonly beneficialOwnerId: string | null;
}

/**
 * -b: prefix case-insensitive. Addresses reach this fence from chain logs
 * and stored `wallet.address` fields (lowercase `0x`), but a `0X` form must
 * NOT read as "no counterparty" that skipped the fence entirely. The result
 * is always lowercased, which every registry lookup below depends on.
 */
const EVM_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;

/** A registry read threw. Infrastructure failure, not evidence. */
class RegistryUnavailable extends Error {}
/** A registry answered with a document the fence cannot use. Unknown, not absence. */
class RegistryUnusable extends Error {}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return EVM_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Can this fence ASK the registries about `value`? True only for the exact
 * shape `normalizeAddress` accepts (`0x` + 20 bytes of hex, prefix case-
 * insensitive). `detectSameOwner-
 * Transfer` answers a NON-address (a wallet id persisted as `poster_address`)
 * with `no_counterparty_address` / `unresolvable:false`, which the completion
 * family's callers read as "distinct owner". Those callers — the record-time
 * fence, the completion verifier, and the record-path estimate — bind to THIS
 * predicate so "unresolvable" means the same thing at every seam.
 */
export function isResolvableCounterpartyAddress(value: unknown): value is string {
  return typeof value === 'string' && normalizeAddress(value) !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// =============================================================================
// RAW-DOCUMENT BOUNDARY (widened input type — -a)
// =============================================================================

/**
 * The outcome of reading one registry document. `absent` is a SUCCESSFUL read
 * that found nothing; `unusable` is a successful read that found a document
 * the fence cannot act on. They are different answers and the caller treats
 * them differently: absence may fall through to the next registry, unusable
 * never does.
 */
export type RegistryRead<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'unusable'; readonly reason: string };

/** The raw shape a Firestore snapshot yields: the data, or null when it does not exist. */
export type RawRegistryDocument = Record<string, unknown> | null | undefined;

/**
 * Classify a `native_wallet_address_index_v1` row. Binds to the SAME canonical
 * parser both USDC watchers enumerate the index with, so "usable to the fence"
 * and "usable to the watchers" cannot drift apart (and this module never
 * re-declares the schema it reads).
 */
export function classifyNativeIndexRow(raw: RawRegistryDocument): RegistryRead<AddressOwnership> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  try {
    const row = parseCanonicalNativeAddressIndex(raw, 'same_owner_fence');
    return {
      kind: 'resolved',
      value: {
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        walletId: row.wallet_id,
        source: 'native_address_index',
      },
    };
  } catch (error) {
    return { kind: 'unusable', reason: `native_address_index:${(error as Error).message}` };
  }
}

/** Classify a `proven_addresses` row (doc id IS the lowercase address). */
export function classifyProvenAddressRow(raw: RawRegistryDocument): RegistryRead<AddressOwnership> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const ownerId = readString(raw.agent_id);
  const walletId = readString(raw.wallet_id);
  if (ownerId === null) return { kind: 'unusable', reason: 'proven_external_address:agent_id_unreadable' };
  if (walletId === null) return { kind: 'unusable', reason: 'proven_external_address:wallet_id_unreadable' };
  return {
    kind: 'resolved',
    value: { ownerType: 'agent', ownerId, walletId, source: 'proven_external_address' },
  };
}

/**
 * Classify a `human_proven_addresses` row (2026-10-01: a PERSON's proven
 * address; doc id IS the lowercase address). The owner IS the person, so a
 * transfer between their Provian wallet (or their linked agents) and it is
 * same-owner.
 */
export function classifyPersonProvenAddressRow(raw: RawRegistryDocument): RegistryRead<AddressOwnership> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const ownerId = readString(raw.user_id);
  const walletId = readString(raw.wallet_id);
  if (ownerId === null) return { kind: 'unusable', reason: 'person_proven_external_address:user_id_unreadable' };
  if (walletId === null) return { kind: 'unusable', reason: 'person_proven_external_address:wallet_id_unreadable' };
  return {
    kind: 'resolved',
    value: { ownerType: 'human', ownerId, walletId, source: 'person_proven_external_address' },
  };
}

/**
 * Classify an `agent_wallet_address_retirements_v1` tombstone. The writer
 * (`key-rotation-transition.ts`) emits snake_case; the camelCase aliases are
 * accepted for the pre-rotation-era shape.
 */
export function classifyRetiredAddressRow(raw: RawRegistryDocument): RegistryRead<AddressOwnership> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const ownerId = readString(raw.agentId) ?? readString(raw.agent_id);
  const walletId = readString(raw.walletId) ?? readString(raw.wallet_id);
  if (ownerId === null) return { kind: 'unusable', reason: 'retired_address:agent_id_unreadable' };
  if (walletId === null) return { kind: 'unusable', reason: 'retired_address:wallet_id_unreadable' };
  return {
    kind: 'resolved',
    value: { ownerType: 'agent', ownerId, walletId, source: 'retired_address' },
  };
}

/**
 * Classify the `agent_wallets` doc a registry row NAMED. Absence here is not
 * "no wallet" — a registry already asserted this wallet exists — so it is
 * unusable, never absent. `linked_human_user_id` is `string | null` by contract
 * (`AgentWalletDocument`); `null`/missing is a legitimate UNLINKED answer, any
 * other non-string shape is unusable.
 */
export function classifyAgentWalletDoc(
  raw: RawRegistryDocument,
  walletId: string,
): RegistryRead<{ readonly linkedHumanUserId: string | null }> {
  if (raw === null || raw === undefined) {
    return { kind: 'unusable', reason: `agent_wallets_missing:${walletId}` };
  }
  const linked = raw.linked_human_user_id;
  if (linked === null || linked === undefined) {
    return { kind: 'resolved', value: { linkedHumanUserId: null } };
  }
  const linkedId = readString(linked);
  if (linkedId === null) {
    return { kind: 'unusable', reason: `agent_wallets_linked_human_unreadable:${walletId}` };
  }
  return { kind: 'resolved', value: { linkedHumanUserId: linkedId } };
}

/**
 * Classify a `native_agent_registration_by_agent_v1` row. Absence IS a real
 * answer (the actor is a human acting directly, with no agent wallet); a row
 * whose `wallet_id` cannot be read is unusable.
 */
export function classifyRegistrationRow(
  raw: RawRegistryDocument,
): RegistryRead<{ readonly walletId: string }> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const walletId = readString(raw.wallet_id);
  if (walletId === null) {
    return { kind: 'unusable', reason: 'agent_registration_index:wallet_id_unreadable' };
  }
  return { kind: 'resolved', value: { walletId } };
}

/**
 * Snapshot -> raw document, or null when the document does not exist. The ONE
 * place the Firestore shape is reduced to the boundary type above.
 */
async function readRaw(
  db: Firestore,
  collection: string,
  docId: string,
  registry: string,
): Promise<RawRegistryDocument> {
  let snap;
  try {
    snap = await db.collection(collection).doc(docId).get();
  } catch (error) {
    throw new RegistryUnavailable(`${registry}:${String(error)}`);
  }
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

// =============================================================================
// RESOLUTION
// =============================================================================

/**
 * Resolve an address to its owning identity. Returns null when every registry
 * was read successfully and none knew the address. Throws RegistryUnavailable
 * when a read failed and RegistryUnusable when a registry answered with a
 * document the fence cannot use — absence, failure, and unusable are three
 * different answers and the caller treats them differently.
 */
export async function resolveAddressOwnership(
  db: Firestore,
  address: string,
): Promise<AddressOwnership | null> {
  const normalized = normalizeAddress(address);
  if (normalized === null) return null;

  // 1. Canonical native index. Carries owner_type + owner_id, so it is the only
  //    source that can distinguish two agents under one human from one agent.
  const native = classifyNativeIndexRow(await readRaw(
    db,
    NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
    nativeWalletAddressIndexId(normalized),
    'native_address_index',
  ));
  if (native.kind === 'unusable') throw new RegistryUnusable(native.reason);
  if (native.kind === 'resolved') return native.value;

  // 2. Proven external address. Doc id IS the lowercase address.
  const proven = classifyProvenAddressRow(await readRaw(
    db,
    PROVEN_ADDRESSES_COLLECTION,
    normalized,
    'proven_addresses',
  ));
  if (proven.kind === 'unusable') throw new RegistryUnusable(proven.reason);
  if (proven.kind === 'resolved') return proven.value;

  // 2b. A PERSON's proven external address (2026-10-01). Doc id IS the address.
  const personProven = classifyPersonProvenAddressRow(await readRaw(
    db,
    HUMAN_PROVEN_ADDRESSES_COLLECTION,
    normalized,
    'human_proven_addresses',
  ));
  if (personProven.kind === 'unusable') throw new RegistryUnusable(personProven.reason);
  if (personProven.kind === 'resolved') return personProven.value;

  // 3. Retired (rotated-away) address — same owner, older key.
  const retired = classifyRetiredAddressRow(await readRaw(
    db,
    AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
    normalized,
    'address_retirements',
  ));
  if (retired.kind === 'unusable') throw new RegistryUnusable(retired.reason);
  if (retired.kind === 'resolved') return retired.value;

  return null;
}

/**
 * The human an AGENT wallet's value accrues to, or null when unlinked. The
 * wallet doc must exist — a registry row named it — so absence is unusable.
 */
async function readAgentWalletBeneficialOwner(
  db: Firestore,
  walletId: string,
): Promise<string | null> {
  const wallet = classifyAgentWalletDoc(
    await readRaw(db, 'agent_wallets', walletId, 'agent_wallets'),
    walletId,
  );
  if (wallet.kind === 'unusable') throw new RegistryUnusable(wallet.reason);
  if (wallet.kind === 'absent') throw new RegistryUnusable(`agent_wallets_missing:${walletId}`);
  return wallet.value.linkedHumanUserId;
}

/**
 * The human a wallet's value accrues to, or null.
 *
 * the native index's `owner_id` is NOT the human for agent wallets — every
 * writer sets it to the **agent_id** (`routes/agent-wallet.ts`,
 * `key-rotation-transition.ts`), and only human wallets carry a user_id
 * (`genesis-ingress.ts`). Comparing `owner_id` across two agent wallets therefore
 * could never match, which is why the first version of this module did not fence
 * multi-agent-per-human despite claiming to. The beneficial owner has to be read
 * from the wallet document.
 *
 * -a: a HUMAN ownership with no `ownerId`, or an AGENT ownership with no
 * `walletId`, is an unusable registry answer — those fields are required by
 * every writer and by the canonical parser, so their absence here means the
 * resolution came from a shape the fence cannot trust. Unknown, not absence.
 */
async function resolveBeneficialOwner(
  db: Firestore,
  ownership: AddressOwnership | null,
): Promise<string | null> {
  if (ownership === null) return null;
  // A human wallet's owner IS the human.
  if (ownership.ownerType === 'human') {
    if (ownership.ownerId === null) {
      throw new RegistryUnusable(`${ownership.source}:human_owner_id_unreadable`);
    }
    return ownership.ownerId;
  }
  if (ownership.walletId === null) {
    throw new RegistryUnusable(`${ownership.source}:wallet_id_unreadable`);
  }
  return readAgentWalletBeneficialOwner(db, ownership.walletId);
}

/**
 * Resolve the acting party. `economicActorId` arrives as an agent_id on agent
 * PEs, so it is mapped through the agent registration index to a wallet id
 * before anything is compared —, where passing it straight into a
 * wallet-id comparison made `selfReferencing` structurally unreachable.
 */
async function resolveActor(
  db: Firestore,
  input: SameOwnerInput,
): Promise<ResolvedParty> {
  const actorId = readString(input.economicActorId);
  let walletId = readString(input.actingWalletId ?? null);
  if (walletId === null && actorId !== null) {
    const registration = classifyRegistrationRow(await readRaw(
      db,
      NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
      nativeAgentRegistrationIndexId(actorId),
      'agent_registration_index',
    ));
    if (registration.kind === 'unusable') throw new RegistryUnusable(registration.reason);
    if (registration.kind === 'resolved') walletId = registration.value.walletId;
  }
  if (walletId === null) {
    // No agent wallet: the actor is a human acting directly, so it is its own
    // beneficial owner.
    return { walletId: null, beneficialOwnerId: actorId };
  }
  const beneficial = await readAgentWalletBeneficialOwner(db, walletId);
  return { walletId, beneficialOwnerId: beneficial ?? actorId };
}

/**
 * Decide whether a financial PE moves value between addresses under one owner.
 *
 * `selfReferencing` means the SAME wallet on both sides (including a rotated-away
 * or proven-external address of that wallet). `sharedBeneficialOwnership` is the
 * wider case: different wallets whose value accrues to the SAME HUMAN — which is
 * how multi-agent-per-human and human-to-own-agent are caught.
 */
export async function detectSameOwnerTransfer(
  db: Firestore,
  input: SameOwnerInput,
): Promise<SameOwnerVerdict> {
  const counterparty = normalizeAddress(input.counterpartyAddress);
  if (counterparty === null) {
    return {
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      unresolvable: false,
      reason: 'no_counterparty_address',
    };
  }

  let ownership: AddressOwnership | null;
  let actor: ResolvedParty;
  let counterpartyBeneficialOwner: string | null;
  try {
    ownership = await resolveAddressOwnership(db, counterparty);
    actor = await resolveActor(db, input);
    counterpartyBeneficialOwner = await resolveBeneficialOwner(db, ownership);
  } catch (error) {
    // Read failed, or a registry answered with a document the fence cannot
    // use. Neither is evidence of absence — see the fail-closed notes above.
    // The two carry distinct reason prefixes so they stay tellable apart.
    const prefix = error instanceof RegistryUnusable
      ? 'ownership_registry_unusable'
      : 'ownership_registry_unavailable';
    return {
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      unresolvable: true,
      reason: `${prefix}:${(error as Error).message}`,
    };
  }

  if (ownership === null) {
    return {
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      unresolvable: false,
      reason: 'counterparty_unknown_to_registries',
    };
  }

  // Same WALLET on both sides — the narrow, unambiguous self-transfer.
  if (actor.walletId !== null && ownership.walletId === actor.walletId) {
    return {
      selfReferencing: true,
      sharedBeneficialOwnership: false,
      unresolvable: false,
      reason: `self_transfer:${ownership.source}:wallet=${actor.walletId}`,
    };
  }

  // Different wallets whose value accrues to the SAME HUMAN. This is the
  // multi-agent-per-human and human-to-own-agent fence. Both sides must resolve
  // to a beneficial owner; a null on either side is not a match, because
  // "unlinked" is not an identity two parties can share.
  if (actor.beneficialOwnerId !== null
    && counterpartyBeneficialOwner !== null
    && actor.beneficialOwnerId === counterpartyBeneficialOwner) {
    return {
      selfReferencing: false,
      sharedBeneficialOwnership: true,
      unresolvable: false,
      reason: `shared_beneficial_owner:${ownership.source}:human=${counterpartyBeneficialOwner}`,
    };
  }

  // Also catch the direct identity match, which covers a human acting on their
  // own human wallet and any path where the actor id IS the counterparty owner.
  if (actor.beneficialOwnerId !== null && ownership.ownerId === actor.beneficialOwnerId) {
    return {
      selfReferencing: false,
      sharedBeneficialOwnership: true,
      unresolvable: false,
      reason: `shared_owner:${ownership.source}:owner=${ownership.ownerId}`,
    };
  }

  return {
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    unresolvable: false,
    reason: `distinct_owner:${ownership.source}`,
  };
}
