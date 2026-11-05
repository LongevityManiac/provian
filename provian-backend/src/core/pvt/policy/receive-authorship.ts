/**
 * Receive authorship detection — the unsolicited-inbound-transfer gate.
 *
 * WHY THIS EXISTS. `receive` is the only financial PE type whose triggering
 * act belongs to someone OTHER than the wallet holder. Every other financial
 * PE (send, swap, onramp, x402, escrow/job settlement) fires on the holder's
 * OWN key-signed act, so its counterparty is inherently something the holder
 * chose. A `receive` fires on a STRANGER's transfer: nothing about the
 * transfer itself proves the recipient did anything. Left ungated this is
 * both mint-farmable (self-dust from a fresh address, gas-only cost, full
 * standard-lane weight, and the only count on `receive` is the per-actor
 * daily ceiling — see `activity-mint-limits.ts`) and
 * reputation-writable by a third party, since an unsolicited `receive` would
 * otherwise feed the public financial-activity summary
 * (`core/public-record/financial-activity.ts`) exactly like a real one.
 *
 * WHAT COUNTS AS AUTHORED. The recipient must have done SOMETHING that ties
 * them to this specific counterparty address:
 * 1. A prior OUTBOUND `send` or `x402_payment` PE from this wallet TO this
 * counterparty (`provenance_envelopes`, `counterparty_address` +
 * `user_id`, filtered in-app by `action_type` see note below on why
 * `action_type` isn't part of the query filter itself).
 * 2. An escrow (any status, open or historical) between this wallet and
 * this counterparty (`escrows.depositor_address`/`recipient_address`).
 * 3. An agent-job-board relationship (poster or assignee) with this
 * counterparty (`jobs.poster_address`/`assigned_address`). Accepted
 * HUMAN jobs are covered by (2): `acceptApplicant`
 * (`core/commons/human-jobs.ts`) always creates the matching escrow at
 * acceptance time, so there is no separate `commons_human_jobs` check —
 * a job that hasn't been accepted yet has no bidirectional relationship
 * to check in the first place.
 * Two things this deliberately does NOT check, both confirmed absent from
 * this codebase by an explicit audit, not assumed:
 * - A wallet's own saved local contacts (`AddressHistoryService`, mobile
 * app, `AsyncStorage`-only) are NEVER synced to the backend — there is
 * no route, collection, or field anywhere that receives a user's
 * contact list. This module has no way to see them.
 * - No "payment request" / invoice surface exists anywhere in this
 * codebase (backend or mobile) to check against.
 *
 * QUERY SHAPE. Each check uses ONLY single-field equality `where()` calls,
 * matching this codebase's existing precedent (`getWalletEscrows`,
 * `getMyJobs`) of running parallel single-field queries and cross-checking
 * the other side in application code, rather than a compound multi-field
 * equality query. This needs NO new Firestore composite index — every
 * filter here is covered by Firestore's automatic single-field indexing,
 * except the `provenance_envelopes` check, which reuses the EXISTING
 * composite index on (`counterparty_address`, `user_id`, `created_at`) —
 * ordered by `created_at` DESCENDING, so the most-recent-first scan window
 * is well-defined rather than resting on Firestore's unspecified default
 * ordering. `action_type` is filtered in application code rather than in
 * the query for the same reason: adding it to the query itself would need a
 * new composite index this change doesn't require. (The escrow/job checks
 * have no supporting composite index for `_address` + `created_at`, so they
 * are NOT ordered — see BOUNDED SCAN below.)
 *
 * BOUNDED SCAN. Each query is capped (`RELATIONSHIP_SCAN_LIMIT`) — this runs
 * in async backend watcher processing, not a user-facing hot path, so a
 * generous bound is cheap. The `provenance_envelopes` check orders
 * most-recent-first (see QUERY SHAPE), so a wallet with more prior activity
 * with one counterparty than the window only risks missing an OLD
 * relationship, not a systematically-excluded class of one. The escrow/job
 * checks are unordered — deploying a supporting composite index for them
 * was judged not worth doing for collections whose per-wallet volume is
 * naturally far smaller than PE history. A wallet with more than
 * `RELATIONSHIP_SCAN_LIMIT` docs of one kind where the one qualifying row
 * falls outside the window is a narrow, documented edge case whose failure
 * direction is SAFE either way (an authored relationship is missed, sealing
 * an otherwise-eligible receive record_only — never the reverse).
 *
 * KNOWN LIMITATION — self-seeded relationships via an unregistered address.
 * The "prior outbound" check accepts ANY `send`/`x402_payment` PE to the
 * counterparty, regardless of that PE's own mint disposition. A wallet can
 * therefore manufacture "authorship" cheaply: send once (any amount, even
 * dust; the send need not even mint) to a fresh address it also controls,
 * then receive from that address indefinitely. `detectSameOwnerTransfer`
 * (`same-owner-detection.ts`) cannot catch this because it only resolves
 * addresses that are REGISTERED Provian wallets — a bare, off-platform EOA
 * is invisible to every registry it reads, by construction. Closing this
 * fully would require either extending same-owner detection to arbitrary
 * unregistered addresses (not possible in general — there is no on-chain
 * way to prove non-ownership of an EOA) or changing `receive`'s mint-cap
 * shape in `activity-mint-limits.ts` (since no financial type carries a
 * per-counterparty count; the per-actor daily ceiling bounds it) — both are explicitly out of this change's
 * scope ("unsolicited inbound transfers only — nothing else in the earning
 * system changes"). What this DOES close: a genuine stranger's unsolicited
 * transfer, with no seed transaction from the recipient at all, can no
 * longer mint or write reputation — the prior zero-cost version of that
 * attack. The residual requires the attacker to pay for and control a seed
 * transaction FROM the wallet being farmed, which is a real, non-zero cost
 * increase, not full closure.
 *
 * FAIL-CLOSED (Security Invariant #7, "Unknown = Block, Not Warn"), mirrored
 * exactly from `same-owner-detection.ts`. A query that THROWS is not
 * evidence of absence. Returning `authored: false` on an infrastructure
 * error would strip mint eligibility from a genuinely authored relationship
 * and because the resulting disposition is TERMINAL and prospective-only
 * (see `pvt-accrual.ts`'s `resolveOperationalDisposition`), that mistake
 * could never self-heal. So a read failure surfaces as `unresolvable: true`
 * and the caller routes to `pending_review`, never straight to a permanent
 * `record_only` seal. Absence of a match after every check reads
 * successfully is genuine absence, not evidence of failure.
 *
 * EXTERNAL-PROVEN WALLETS. A wallet funded on a proven EXTERNAL address
 * (`wallet.address` at the call site is that external address, not the
 * agent's native one) would otherwise never match an escrow/job it holds
 * under its NATIVE address, since `escrows`/`jobs` store the party's native
 * `agent_wallets.address`. This resolves the native address too (via the
 * agent registration index, mirroring `same-owner-detection.ts`'s
 * `resolveActor`) and checks escrow/job relationships against BOTH
 * addresses. The prior-outbound-PE check needs no such fallback: it keys
 * on `economicActorId` (the agent id), which identifies the same agent
 * regardless of which address funds landed on.
 *
 * CONTRACT-MEDIATED ESCROW/JOB PAYOUTS. An escrow release does not transfer
 * peer-to-peer: `completeEscrow` moves USDC/PVT OUT OF the escrow CONTRACT
 * (funding routes `expectedTo: escrowContractAddress` `escrow.ts`), so the
 * inbound watcher stamps the transfer's `counterpartyAddress` as the
 * CONTRACT's own address, never the other party's wallet. Job payouts settle
 * through the same mechanism (`acceptApplicant` calls `createEscrow`). The
 * two-sided check above therefore can never match an escrow/job payout — its
 * `counterparty` never equals a value stored in `escrows`/`jobs`. Because the
 * universe of escrow contract addresses is small, fixed, and
 * protocol-controlled (config, not user input — `chain-registry.ts`), the
 * fix is: when the observed counterparty IS a configured escrow contract
 * address, funds could only have left it via a genuine, code-enforced
 * release, so the authorship bar relaxes to "this wallet is a party to ANY
 * escrow or job" rather than requiring a match against this specific
 * counterparty (there is no peer counterparty to match — the contract
 * mediated). This does not apply to `send`/`x402_payment`'s "prior outbound"
 * check, which never involves the escrow contract.
 */

import { hasOutboundPair, normalizeCounterparty, OUTBOUND_RELATIONSHIP_ACTION_TYPES } from '../../meter/counterparty-pairs';
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../native-wallet-registration';
import {
  SUPPORTED_AGENT_BANK_CHAINS,
  escrowUsdcAddressForChain,
  escrowV4AddressForChain,
} from '../../agent-bank/chain-registry';

/**
 * -b: prefix case-insensitive, result always lowercased (sibling of the
 * same widen in `same-owner-detection.ts`). A `0X` form must not read as
 * "no counterparty" on this gate that sealed an authored receive record_only.
 */
const EVM_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;

const RELATIONSHIP_SCAN_LIMIT = 200;



/**
 * Every currently-configured escrow contract address, across every
 * supported chain and currency (USDC V3 + PVT V4), lowercased. These
 * resolvers read env/config and return `undefined` rather than throw when a
 * chain/currency isn't configured, so this never needs a try/catch of its
 * own — an empty set (nothing configured) is a valid, safe result.
 */
function knownEscrowContractAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const chain of SUPPORTED_AGENT_BANK_CHAINS) {
    const usdc = escrowUsdcAddressForChain(chain);
    const pvt = escrowV4AddressForChain(chain);
    if (usdc) addresses.add(usdc.toLowerCase());
    if (pvt) addresses.add(pvt.toLowerCase());
  }
  return addresses;
}

export interface ReceiveAuthorshipVerdict {
  readonly authored: boolean;
  /** True when a query FAILED. Caller must not seal record_only on this. */
  readonly unresolvable: boolean;
  /** Human-readable basis for the verdict; safe to log (identifiers only). */
  readonly reason: string;
}

export interface ReceiveAuthorshipInput {
  /** The PE's economic actor id (`user_id` on `provenance_envelopes`). */
  readonly economicActorId: string | null;
  /** The wallet's own on-chain address (matches `actor_address` / escrow &
   *  job `_address` fields). */
  readonly walletAddress: string | null;
  /** The counterparty address from the inbound transfer. */
  readonly counterpartyAddress: string | null;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return EVM_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
}

async function hasPriorOutboundPe(
  db: Firestore,
  economicActorId: string,
  counterparty: string,
): Promise<boolean> {
  // PE METER: the per-pair record the meter writes with every outbound act. Pre-meter outbound
  // PEs are still found in their envelopes until the migration folds them into pairs.
  if (await hasOutboundPair(db, economicActorId, counterparty)) return true;
  const snap = await db.collection('provenance_envelopes')
    .where('counterparty_address', '==', counterparty)
    .where('user_id', '==', economicActorId)
    .orderBy('created_at', 'desc')
    .limit(RELATIONSHIP_SCAN_LIMIT)
    .get();
  return snap.docs.some((doc) => {
    const actionType = doc.get('action_type');
    return typeof actionType === 'string' && OUTBOUND_RELATIONSHIP_ACTION_TYPES.has(actionType);
  });
}

/**
 * Resolve an economic actor's NATIVE registered wallet address (as opposed
 * to whatever proven-external address happens to be attached to the inbound
 * transfer). Mirrors `same-owner-detection.ts`'s `resolveActor`: agent id →
 * native registration index → `agent_wallets.address`. Returns null on any
 * miss (unregistered actor, human actor with no agent wallet, etc.) — the
 * caller treats that as "no additional address to check," never as failure.
 */
async function resolveNativeAddress(
  db: Firestore,
  economicActorId: string,
): Promise<string | null> {
  const indexSnap = await db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
    .doc(nativeAgentRegistrationIndexId(economicActorId))
    .get();
  if (!indexSnap.exists) return null;
  const walletId = indexSnap.get('wallet_id');
  if (typeof walletId !== 'string' || walletId.length === 0) return null;
  const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
  if (!walletSnap.exists) return null;
  return normalizeAddress(walletSnap.get('address'));
}

/** Two parallel single-field queries + in-app cross-check of the other
 *  side — the same shape `getWalletEscrows`/`getMyJobs` already use. */
async function hasTwoSidedAddressRelationship(
  db: Firestore,
  collectionName: string,
  sideAField: string,
  sideBField: string,
  myAddress: string,
  counterparty: string,
): Promise<boolean> {
  const matchesOther = (doc: QueryDocumentSnapshot, otherField: string): boolean =>
    doc.get(otherField) === counterparty;
  const [asSideA, asSideB] = await Promise.all([
    db.collection(collectionName).where(sideAField, '==', myAddress).limit(RELATIONSHIP_SCAN_LIMIT).get(),
    db.collection(collectionName).where(sideBField, '==', myAddress).limit(RELATIONSHIP_SCAN_LIMIT).get(),
  ]);
  return asSideA.docs.some((d) => matchesOther(d, sideBField))
    || asSideB.docs.some((d) => matchesOther(d, sideAField));
}

/**
 * Is `myAddress` a party (either side) of ANY doc in this collection — no
 * counterparty match required. Used ONLY for the contract-mediated case: see
 * CONTRACT-MEDIATED ESCROW/JOB PAYOUTS in the module header for why matching
 * a specific counterparty is the wrong check when the observed counterparty
 * is the escrow contract itself, not a peer.
 */
async function hasAnyPartyParticipation(
  db: Firestore,
  collectionName: string,
  sideAField: string,
  sideBField: string,
  myAddress: string,
): Promise<boolean> {
  const [asSideA, asSideB] = await Promise.all([
    db.collection(collectionName).where(sideAField, '==', myAddress).limit(1).get(),
    db.collection(collectionName).where(sideBField, '==', myAddress).limit(1).get(),
  ]);
  return !asSideA.empty || !asSideB.empty;
}

/**
 * Resolve whether a `receive` PE's counterparty is tied to a relationship
 * the RECIPIENT authored — never a fact about the sender. See module header
 * for what counts and why. Scoped to `receive` only by the caller (this
 * function has no opinion on action type); it must never be called for any
 * other PE type.
 */
export async function resolveReceiveAuthorship(
  db: Firestore,
  input: ReceiveAuthorshipInput,
): Promise<ReceiveAuthorshipVerdict> {
  // The counterparty may be a Solana address (a facilitator settlement with a non-Provian party);
  // it is keyed exactly as the pair store keys it. The wallet's own addresses stay EVM-only: they
  // are matched against escrow/job fields, which hold EVM addresses.
  const counterparty = normalizeCounterparty(input.counterpartyAddress);
  if (counterparty === null) {
    // No counterparty on the PE at all - nothing to bind authorship to.
    // Fail closed: this is the same "cannot prove authorship" outcome as an
    // unresolved stranger, not a pass.
    return { authored: false, unresolvable: false, reason: 'no_counterparty_address' };
  }
  const myAddress = normalizeAddress(input.walletAddress);
  const actorId = typeof input.economicActorId === 'string' && input.economicActorId.length > 0
    ? input.economicActorId
    : null;

  if (actorId === null && myAddress === null) {
    return { authored: false, unresolvable: false, reason: 'no_identity_to_check' };
  }

  try {
    // Resolve the native-address fallback FIRST, before starting any other
    // query. Pushing a query's promise into `checks` and only awaiting it
    // later (via the final `Promise.all`) is safe ONLY if nothing between
    // the push and that final await can throw — an earlier throw would
    // return from this try block with that pushed promise still pending and
    // un-awaited, which Node reports as an unhandled rejection (and, in this
    // codebase's Jest config, crashes the worker) rather than a caught
    // error. Resolving the native address up front, before `checks` exists,
    // means a throw here has nothing dangling to leave behind.
    const nativeAddress = actorId !== null ? await resolveNativeAddress(db, actorId) : null;

    // Escrow/job docs store a party's NATIVE registered address. A wallet
    // funded on a proven external address (myAddress here) needs its native
    // address resolved too, or it can never match its own escrow/job history
    // — see EXTERNAL-PROVEN WALLETS in the module header.
    const addressesToCheck = new Set<string>();
    if (myAddress !== null) addressesToCheck.add(myAddress);
    if (nativeAddress !== null) addressesToCheck.add(nativeAddress);

    // A counterparty that IS a configured escrow contract means the transfer
    // was contract-mediated (an escrow/job release or refund), not peer-to-
    // peer — see CONTRACT-MEDIATED ESCROW/JOB PAYOUTS in the module header.
    // Synchronous (env reads only), so calling it here adds no dangling-
    // promise risk regardless of where it sits relative to `checks`.
    const isEscrowContractCounterparty = knownEscrowContractAddresses().has(counterparty);

    const checks: Promise<boolean>[] = [];
    if (actorId !== null) {
      checks.push(hasPriorOutboundPe(db, actorId, counterparty));
    }
    for (const address of addressesToCheck) {
      if (isEscrowContractCounterparty) {
        checks.push(hasAnyPartyParticipation(db, 'escrows', 'depositor_address', 'recipient_address', address));
        checks.push(hasAnyPartyParticipation(db, 'jobs', 'poster_address', 'assigned_address', address));
      } else {
        checks.push(hasTwoSidedAddressRelationship(
          db, 'escrows', 'depositor_address', 'recipient_address', address, counterparty,
        ));
        checks.push(hasTwoSidedAddressRelationship(
          db, 'jobs', 'poster_address', 'assigned_address', address, counterparty,
        ));
      }
    }

    const results = await Promise.all(checks);
    if (results.some(Boolean)) {
      return { authored: true, unresolvable: false, reason: 'recipient_authored_relationship_found' };
    }
    return { authored: false, unresolvable: false, reason: 'no_recipient_authored_relationship' };
  } catch (error) {
    return {
      authored: false,
      unresolvable: true,
      reason: `receive_authorship_registry_unavailable:${(error as Error).message}`,
    };
  }
}
