/**
 * Agent Bank - Escrow Business Logic
 *
 * Handles escrow creation, funding verification, completion, disputes,
 * and resolution. All fund movements happen on-chain via the ProvianEscrow
 * contract. This module manages Firestore metadata and PE generation.
 */

import admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import {
  SAFETY_LIMITS,
  parsePvtWei,
  type AgentBankDeps,
  type CreateEscrowRequest,
  type Currency,
  type EscrowDocument,
  type EscrowDisputeSettleResult,
  type EscrowSettleResult,
} from './types';
import { resolveEscrowParty, type EscrowParty } from './escrow-party';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import { ValidationError, NotFoundError, ForbiddenError, RateLimitError } from './errors';
import { generatePE } from './pe-utils';
import { generatePEOnce } from './pe-once';
import {
  mirrorEscrowDisputeToLinkedJobs,
  settleLinkedJobsForEscrow,
  settlementReceipt,
} from './job-settlement';
import { verifyTransfer, verifyOnchainEscrowFunding } from '../onchain/tx-verifier';
import { isPvtPrincipalEnabledForChain, PREDECESSOR_ESCROW_V4_BASE } from './pvt-principal-config';
import {
  assertSupportedAgentBankChain,
  escrowUsdcAddressForChain,
  escrowV4AddressForChain,
  requireAddressOrThrow,
  type AgentBankChain,
} from './chain-registry';

/**
 * Resolve the escrow contract address for a given currency and chain.
 * USDC routes to the V3 contract per-chain (`ESCROW_CONTRACT_ADDRESS_<CHAIN>`
 * or legacy `ESCROW_CONTRACT_ADDRESS`). PVT routes to the V4 contract
 * per-chain (`ESCROW_V4_CONTRACT_ADDRESS_<CHAIN>` or legacy
 * `ESCROW_V4_CONTRACT_ADDRESS`, and only when ENABLE_PVT_PRINCIPAL=true).
 *
 * Wave J-bis: chain-aware resolver. Single-chain deployments keep working
 * via the legacy single-valued env var fallback in chain-registry.
 */
export function resolveEscrowContractAddress(currency: Currency, chain: AgentBankChain): string {
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(chain)) {
      throw new ValidationError(`PVT-principal escrows are not enabled for chain '${chain}' on this relay`);
    }
    return requireAddressOrThrow(escrowV4AddressForChain(chain), 'ESCROW_V4', chain);
  }
  return requireAddressOrThrow(escrowUsdcAddressForChain(chain), 'ESCROW', chain);
}

/**
 * D-486 — the contract an EXISTING escrow's on-chain struct lives on. The migration carried every
 * escrow it could onto the successor EscrowV4 and left the rest on the predecessor (a Disputed USDC
 * escrow: its principal can leave a non-custodial escrow only to its own parties), pinning
 * `escrow_contract_address` on those documents. Only two values are honored: the chain's configured
 * escrow, or — on Base — the recorded D-486 predecessor EscrowV4. Any other pin refuses (Unknown =
 * Block): a document can never steer a funding check, a release, or a keeper call to an address the
 * relay does not already name.
 */
export function resolveEscrowContractForDocument(
  escrow: Pick<EscrowDocument, 'escrow_id' | 'currency' | 'chain' | 'escrow_contract_address'>,
): string {
  const chain = escrow.chain as AgentBankChain;
  const configured = resolveEscrowContractAddress(escrow.currency ?? 'usdc', chain);
  const pinned = escrow.escrow_contract_address;
  if (pinned === undefined) return configured;
  if (typeof pinned === 'string') {
    if (pinned.toLowerCase() === configured.toLowerCase()) return configured;
    if (chain === 'base' && pinned.toLowerCase() === PREDECESSOR_ESCROW_V4_BASE.toLowerCase()) {
      return PREDECESSOR_ESCROW_V4_BASE;
    }
  }
  throw new ValidationError(`Escrow ${escrow.escrow_id} is pinned to an unrecognized escrow contract`);
}

// =========================================================================
// Escrow operations
// =========================================================================

// P1-5: Per-wallet creation rate limit - max 50 escrows per wallet per 24h.
// Prevents DoS via thousands of minimum-value escrow creations.
const CREATION_RATE_LIMIT = 50;
const CREATION_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function checkCreationRateLimit(
  deps: AgentBankDeps,
  collection: string,
  walletIdField: string,
  walletId: string,
): Promise<void> {
  const windowStart = new Date(Date.now() - CREATION_RATE_WINDOW_MS);
  const snap = await deps.db.collection(collection)
    .where(walletIdField, '==', walletId)
    .where('created_at', '>=', windowStart.getTime())
    .count()
    .get();
  const count = snap.data().count;
  if (count >= CREATION_RATE_LIMIT) {
    throw new RateLimitError(`Rate limit exceeded: max ${CREATION_RATE_LIMIT} creations per 24 hours`);
  }
}

export async function createEscrow(
  deps: AgentBankDeps,
  body: CreateEscrowRequest,
): Promise<EscrowDocument> {
  // P1-5: Per-wallet rate limit on escrow creation
  await checkCreationRateLimit(deps, 'escrows', 'depositor_wallet_id', body.depositor_wallet_id);

  // --- Currency routing (Workstream 2). Default to 'usdc' for back-compat. ---
  const currency: Currency = body.currency ?? 'usdc';
  if (currency !== 'usdc' && currency !== 'pvt') {
    throw new ValidationError(`currency must be 'usdc' or 'pvt' (got ${String(currency)})`);
  }

  // PVT requests rejected unless ENABLE_PVT_PRINCIPAL=true. The check inside
  // resolveEscrowContractAddress() will throw the same error on the funding
  // path, but we want to fail at create time too so the caller doesn't end
  // up with an orphaned 'created' escrow they can never fund.
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(body.chain ?? 'base')) {
      throw new ValidationError(`PVT-principal escrows are not enabled for chain '${body.chain ?? 'base'}' on this relay`);
    }
  }

  // --- Validate currency-specific amount ---
  let amountUsdc: number = 0;
  let amountPvtWei: bigint = 0n;
  let feeUsdc = 0;
  let netToRecipientUsdc = 0;
  let feePvtWei: bigint = 0n;
  let netToRecipientPvtWei: bigint = 0n;

  if (currency === 'usdc') {
    if (body.amount_usdc === undefined) {
      throw new ValidationError('amount_usdc is required when currency is usdc');
    }
    // Pass-3 #2: the range check below uses only <= / >, which COERCE a string
    // ('50' <= 0 is false, '50' > MAX is false; 'abc' → NaN comparisons are both
    // false) so a string amount slips through, persists a corrupt escrow, and
    // then permanently fails funding (Number.isFinite('50') is false in the
    // verifier) AFTER real USDC has locked on-chain. Reject any non-number /
    // non-finite amount at the trust boundary BEFORE it is persisted. The route
    // does `req.body as CreateEscrowRequest` with no runtime type check, so this
    // is the only place the type is actually enforced.
    if (typeof body.amount_usdc !== 'number' || !Number.isFinite(body.amount_usdc)) {
      throw new ValidationError('amount_usdc must be a finite number');
    }
    if (body.amount_usdc <= 0 || body.amount_usdc > SAFETY_LIMITS.MAX_ESCROW_AMOUNT_USD) {
      throw new ValidationError(`amount_usdc must be between 0 and ${SAFETY_LIMITS.MAX_ESCROW_AMOUNT_USD}`);
    }
    amountUsdc = body.amount_usdc;
    feeUsdc = Math.round(amountUsdc * 0.005 * 1_000_000) / 1_000_000;
    netToRecipientUsdc = Math.round((amountUsdc - feeUsdc) * 1_000_000) / 1_000_000;
  } else {
    // PVT - amount_pvt is BigInt-as-string (18 decimals).
    if (body.amount_pvt === undefined) {
      throw new ValidationError('amount_pvt is required when currency is pvt');
    }
    try {
      amountPvtWei = parsePvtWei(body.amount_pvt);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    // Phase 1 launch limit mirrors USDC's $10K cap. Convert with a 1:1
    // sanity rate (1 PVT == $1) until governance sets policy. This is a
    // soft API-layer guardrail on launch, not a contract-layer constraint.
    const maxPvtWei = BigInt(SAFETY_LIMITS.MAX_ESCROW_AMOUNT_USD) * (10n ** 18n);
    if (amountPvtWei > maxPvtWei) {
      throw new ValidationError(
        `amount_pvt must be ≤ ${SAFETY_LIMITS.MAX_ESCROW_AMOUNT_USD} PVT (atomic ≤ ${maxPvtWei.toString()})`,
      );
    }
    // 0.5% fee in PVT atomic units. 1000 = bps denominator * 2 since 5/1000 = 0.5%.
    feePvtWei = (amountPvtWei * 5n) / 1000n;
    netToRecipientPvtWei = amountPvtWei - feePvtWei;
  }

  // --- Validate non-amount inputs ---
  // Same trust-boundary defect the amount_usdc guard above documents (Pass-3 #2):
  // the range checks below use only <= / >, which COERCE a missing/non-number
  // value to a false comparison (undefined <= 0 is false, undefined > MAX is
  // false; NaN comparisons are both false). A missing or non-finite hours field
  // therefore slips through, and `now + undefined * 3600000` = NaN is persisted
  // as auto_release_at / deadline — a corrupt escrow doc whose serializer then
  // throws `RangeError: Invalid time value` (a 500, AFTER the doc + escrow_created
  // PE were written). Reject any non-number / non-finite hours at the boundary
  // BEFORE anything is persisted, exactly as amount_usdc does.
  if (typeof body.auto_release_hours !== 'number' || !Number.isFinite(body.auto_release_hours)) {
    throw new ValidationError('auto_release_hours must be a finite number');
  }
  if (body.auto_release_hours <= 0 || body.auto_release_hours > SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS) {
    throw new ValidationError(`auto_release_hours must be between 1 and ${SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS}`);
  }
  if (typeof body.deadline_hours !== 'number' || !Number.isFinite(body.deadline_hours)) {
    throw new ValidationError('deadline_hours must be a finite number');
  }
  if (body.deadline_hours <= 0 || body.deadline_hours > SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS) {
    throw new ValidationError(`deadline_hours must be between 1 and ${SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS}`);
  }
  if (!body.description || body.description.length > 1000) {
    throw new ValidationError('description is required (max 1000 chars)');
  }
  if (!body.deliverables || body.deliverables.length > 1000) {
    throw new ValidationError('deliverables is required (max 1000 chars)');
  }
  // Wave J-bis: accept any chain in SUPPORTED_AGENT_BANK_CHAINS (Base/Arb/Op).
  // The relay must have per-chain env vars set for the requested chain or the
  // funding-verification step will throw via requireAddressOrThrow.
  assertSupportedAgentBankChain(body.chain);

  // C2 (Pass-2 WS3): resolve + VALIDATE the per-chain escrow contract address
  // BEFORE any Firestore/PE write. The funding target must exist on this relay
  // or the escrow can never be funded. Resolving here fails fast with a
  // ValidationError (→ 400) and leaves NO orphaned escrow doc / escrow_created
  // PE behind. The previous order wrote the doc + PE first and only threw at the
  // route's later address resolve, stranding an unfundable escrow the agent
  // could never get a funding address for. Throws on a missing per-chain env.
  resolveEscrowContractAddress(currency, body.chain);

  // --- Look up both wallets (agent OR human; D-329) ---
  const depositor = await resolveEscrowParty(deps, body.depositor_wallet_id, 'Depositor');
  const recipient = await resolveEscrowParty(deps, body.recipient_wallet_id, 'Recipient');

  if (body.depositor_wallet_id === body.recipient_wallet_id) {
    throw new ValidationError('Depositor and recipient must be different wallets');
  }

  // --- Build doc + store ---
  const now = Date.now();
  const escrowId = `esc_${uuidv4()}`;
  const deadline = now + body.deadline_hours * 60 * 60 * 1000;
  const autoReleaseAt = now + body.auto_release_hours * 60 * 60 * 1000;

  const doc: EscrowDocument = {
    escrow_id: escrowId,
    depositor_wallet_id: body.depositor_wallet_id,
    depositor_address: depositor.address,
    recipient_wallet_id: body.recipient_wallet_id,
    recipient_address: recipient.address,
    currency,
    amount_usdc: amountUsdc,
    fee_usdc: feeUsdc,
    net_to_recipient_usdc: netToRecipientUsdc,
    description: body.description,
    deliverables: body.deliverables,
    chain: body.chain,
    deadline,
    auto_release_at: autoReleaseAt,
    status: 'created',
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };
  if (currency === 'pvt') {
    doc.amount_pvt = amountPvtWei.toString();
    doc.fee_pvt = feePvtWei.toString();
    doc.net_to_recipient_pvt = netToRecipientPvtWei.toString();
  }

  // --- Generate the escrow_created PE for the depositor ---
  const peMetadata: Record<string, unknown> = {
    escrow_id: escrowId,
    recipient_wallet_id: body.recipient_wallet_id,
    currency,
    description: body.description,
    auto_release_hours: body.auto_release_hours,
  };
  if (currency === 'usdc') {
    peMetadata.amount_usdc = amountUsdc;
    peMetadata.fee_usdc = feeUsdc;
  } else {
    peMetadata.amount_pvt = amountPvtWei.toString();
    peMetadata.fee_pvt = feePvtWei.toString();
  }

  const { peId } = await generatePE(deps, {
    walletId: body.depositor_wallet_id,
    agentId: depositor.agentId,
    actorAddress: depositor.address,
    actionType: 'escrow_created',
    metadata: peMetadata,
    counterpartyAddress: recipient.address,
  });

  // C2: write the escrow doc ONCE, with pe_ids already populated. generatePE
  // does not read the escrows collection, so creating the PE first is safe and
  // means the escrow doc is never visible without its creation PE (no set→update
  // window where pe_ids is transiently empty).
  doc.pe_ids = [peId];
  await deps.db.collection('escrows').doc(escrowId).set(doc);

  return doc;
}

export async function verifyFunding(
  deps: AgentBankDeps,
  escrowId: string,
  txHash: string,
): Promise<EscrowDocument> {
  const docRef = deps.db.collection('escrows').doc(escrowId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Escrow not found');

  const doc = snapshot.data() as EscrowDocument;

  // Pass-3 N1 repair: a prior verifyFunding flipped status → 'funded' (USDC/PVT
  // is locked on-chain, fund_lock set) but crashed BEFORE the escrow_funded PE +
  // depositor stat ran (they run AFTER the txn so an RPC/Firestore failure there
  // can't unwind the on-chain-funded escrow). The old code then threw
  // "expected created" forever, permanently losing that PE + stat. Now a re-POST
  // /fund on a 'funded' escrow re-runs ONLY the missing side-effects (idempotent
  // via funding_pe_id / funding_stats_credited markers) instead of throwing.
  if (doc.status === 'funded') {
    const repairedPeId = await emitFundingSideEffects(deps, docRef, doc, Date.now());
    return {
      ...doc,
      pe_ids: repairedPeId && !doc.pe_ids.includes(repairedPeId) ? [...doc.pe_ids, repairedPeId] : doc.pe_ids,
    };
  }
  if (doc.status !== 'created') {
    throw new ValidationError(`Escrow status is ${doc.status}, expected created`);
  }

  // Default 'usdc' for legacy docs that predate the currency field (backfill
  // migration writes 'usdc' but defensive in-code default keeps the path
  // safe if a migration is mid-run).
  const currency = doc.currency ?? 'usdc';

  // Phase 2.9 - Theme 3: never trust caller-asserted txHash. Verify the
  // depositor actually moved the expected amount in the escrow's currency
  // into the V3 (USDC) or V4 (PVT) escrow contract.
  // Wave J-bis: chain-aware - resolveEscrowContractAddress reads the
  // per-chain env var; verifyTransfer dispatches to the right RPC provider.
  const docChain = doc.chain as AgentBankChain;
  assertSupportedAgentBankChain(docChain);
  const escrowContractAddress = resolveEscrowContractForDocument({ ...doc, currency, chain: docChain });

  // The on-chain verify happens BEFORE the transaction so we don't hold the
  // Firestore txn open across an external RPC call. Two concurrent verify
  // requests will both pass this check (the chain doesn't disprove either
  // request) - the transaction below is what serializes them.
  const verification = await verifyTransfer({
    chain: docChain,
    txHash,
    expectedFrom: doc.depositor_address,
    expectedTo: escrowContractAddress,
    currency,
    ...(currency === 'pvt'
      ? { expectedAmountPvtWei: BigInt(doc.amount_pvt ?? '0') }
      : { expectedAmountUsdc: doc.amount_usdc }),
  });
  if (!verification.ok) {
    throw new ValidationError(`On-chain funding verification failed: ${verification.reason}`);
  }

  // Pass-2 WS3 #2/#11/#36: the transfer above proves the depositor moved
  // `amount` into the escrow CONTRACT, but NOT that the on-chain escrow STRUCT
  // pays our recipient or releases on our timeline. A depositor can createEscrow
  // off-relay with recipient=self, fund it (passing the transfer check above),
  // and have release pay themselves while we credit the worker + emit a verified
  // escrow_completed PE. Bind the funding to the on-chain struct: select the
  // EscrowFunded event by amount (not positionally — #36), then require the
  // struct recipient == our recipient (#2) and recover autoReleaseAt (#11).
  const onchain = await verifyOnchainEscrowFunding({
    chain: docChain,
    fundTxHash: txHash,
    escrowContractAddress,
    expectedRecipient: doc.recipient_address,
    currency,
    ...(currency === 'pvt'
      ? { expectedAmountPvtWei: BigInt(doc.amount_pvt ?? '0') }
      : { expectedAmountUsdc: doc.amount_usdc }),
  });
  if (!onchain.ok) {
    throw new ValidationError(`On-chain escrow verification failed: ${onchain.reason}`);
  }

  // #11: reconcile the depositor-chosen on-chain autoReleaseAt with the relay's
  // Firestore gate. The on-chain autoReleaseAt is unbounded + unverified; if it
  // is LATER than the agreed auto_release_at, the backend's permissionless
  // auto-release reverts (AutoReleaseNotReached) on every scheduler tick after
  // the Firestore gate elapses → the worker auto-payout is stranded. Reject that
  // mismatch. Otherwise PERSIST the on-chain value as the authoritative gate so
  // settle() never fires a release the chain will revert (it also tightens the
  // dispute window to the on-chain release time).
  const onchainAutoReleaseMs = (onchain.autoReleaseAtSeconds ?? 0n) * 1000n;
  if (onchainAutoReleaseMs > BigInt(doc.auto_release_at)) {
    throw new ValidationError(
      'On-chain autoReleaseAt is later than the agreed auto_release_at; refusing to fund ' +
        '(the worker auto-payout would be stranded past the agreed terms).',
    );
  }
  const reconciledAutoReleaseAt = Number(onchainAutoReleaseMs);

  // #2: bind this funding to exactly ONE escrow. ok==true guarantees an id; the
  // guard is defensive so the unique key below can never be `null`.
  const onchainEscrowId = onchain.onchainEscrowId;
  if (!onchainEscrowId) {
    throw new ValidationError('On-chain escrow verification did not yield an escrow id');
  }
  // The on-chain bytes32 id is the unique anchor for a funding: a depositor can
  // legitimately batch-fund several distinct escrows in one tx (distinct ids),
  // but the SAME on-chain escrow must never credit two Firestore escrows — that
  // would double-credit wallet stats + emit duplicate verified escrow_completed
  // PEs from a single real fund movement (settle() releases the chain escrow
  // once, then re-reads 'already_released' for the replay).
  const fundLockRef = deps.db.collection('escrow_fund_locks').doc(`${docChain}:${onchainEscrowId}`);

  // B-2 (audit 2026-05-11): wrap the status transition in a Firestore
  // transaction so two concurrent verifyFunding calls with the same
  // txHash can't both flip status=funded → both emit duplicate
  // escrow_funded PEs → both double-credit wallet stats. Mirrors the
  // pattern in promises.ts:fundPromise. The fund-lock create below makes the
  // same guarantee ACROSS escrows that target the same on-chain funding.
  const now = Date.now();
  let freshDoc!: EscrowDocument;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Escrow not found');
    freshDoc = fresh.data() as EscrowDocument;
    // Re-check status inside the transaction. The first concurrent
    // request sees 'created' and writes 'funded'; the second sees
    // 'funded' (the first txn's write) and throws.
    if (freshDoc.status !== 'created') {
      throw new ValidationError(`Escrow status is ${freshDoc.status}, expected created`);
    }
    // #2: refuse if this on-chain funding is already bound to another escrow.
    const lock = await tx.get(fundLockRef);
    if (lock.exists) {
      throw new ValidationError('This on-chain escrow funding is already bound to another escrow');
    }
    tx.set(fundLockRef, {
      escrow_id: escrowId,
      chain: docChain,
      onchain_escrow_id: onchainEscrowId,
      fund_tx_hash: txHash,
      created_at: now,
    });
    tx.update(docRef, {
      status: 'funded',
      funded_at: now,
      fund_tx_hash: txHash,
      fund_block_number: verification.blockNumber ?? null,
      // #2/#36: pin the verified on-chain bytes32 id so settle() never has to
      // re-recover (and re-guess) it; #11: gate on the on-chain release time.
      onchain_escrow_id: onchainEscrowId,
      auto_release_at: reconciledAutoReleaseAt,
      updated_at: now,
    });
  });

  // The transaction serializes the status flip. Side-effects (escrow_funded PE +
  // depositor stat) run AFTER the txn closes so an RPC failure here doesn't unwind
  // the on-chain-funded escrow back to 'created'. Pass-3 N1: those side-effects are
  // now DURABLE/RETRYABLE — emitFundingSideEffects is idempotent (funding_pe_id /
  // funding_stats_credited markers), so a failure here leaves the escrow 'funded'
  // and a later re-POST /fund (the repair branch above) completes them rather than
  // losing the PE + stat forever.
  const fundedDoc: EscrowDocument = {
    ...freshDoc,
    status: 'funded',
    funded_at: now,
    fund_tx_hash: txHash,
    onchain_escrow_id: onchainEscrowId,
    auto_release_at: reconciledAutoReleaseAt,
  };
  const peId = await emitFundingSideEffects(deps, docRef, fundedDoc, now);

  return {
    ...fundedDoc,
    pe_ids: peId ? [...freshDoc.pe_ids, peId] : freshDoc.pe_ids,
  };
}

/**
 * Pass-3 N1: idempotent FUNDING side-effects (the escrow_funded PE + the depositor
 * funding stat). Split out + marker-guarded so a failure between the status-flip
 * txn and these writes doesn't lose them: the escrow stays 'funded' and a re-POST
 * /fund re-runs only the missing pieces. Returns the escrow_funded PE id (existing
 * or freshly emitted), or undefined if it could not be resolved.
 */
async function emitFundingSideEffects(
  deps: AgentBankDeps,
  docRef: FirebaseFirestore.DocumentReference,
  doc: EscrowDocument,
  now: number,
): Promise<string | undefined> {
  const currency = doc.currency ?? 'usdc';

  // 1) escrow_funded PE — emit once, guarded by the funding_pe_id marker.
  let peId = doc.funding_pe_id;
  if (!peId) {
    const depositor = await resolveEscrowParty(deps, doc.depositor_wallet_id, 'Depositor');
    const res = await generatePE(deps, {
      walletId: doc.depositor_wallet_id,
      agentId: depositor.agentId,
      actorAddress: depositor.address,
      actionType: 'escrow_funded',
      metadata: {
        escrow_id: doc.escrow_id,
        currency,
        ...(currency === 'pvt' ? { amount_pvt: doc.amount_pvt } : { amount_usdc: doc.amount_usdc }),
        tx_hash: doc.fund_tx_hash,
      },
    });
    peId = res.peId;
    // arrayUnion so a concurrent createEscrow / completion append doesn't clobber
    // pe_ids via the read-mutate-write hazard.
    await docRef.update({
      pe_ids: admin.firestore.FieldValue.arrayUnion(peId),
      funding_pe_id: peId,
      updated_at: now,
    });
  }

  // 2) Depositor funding stat — credited + marked atomically (crash/retry safe).
  const fundingCredit: WalletStatCredit = currency === 'pvt'
    ? { walletId: doc.depositor_wallet_id, currency: 'pvt', amount: BigInt(doc.amount_pvt ?? '0') }
    : { walletId: doc.depositor_wallet_id, currency: 'usdc', amount: doc.amount_usdc };
  await creditWalletStatsAtomic(deps, docRef, now, 'funding_stats_credited', [fundingCredit]);

  return peId;
}

export async function completeEscrow(
  deps: AgentBankDeps,
  escrowId: string,
  callerWalletId: string,
): Promise<EscrowDocument> {
  const docRef = deps.db.collection('escrows').doc(escrowId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Escrow not found');

  const doc = snapshot.data() as EscrowDocument;
  if (doc.depositor_wallet_id !== callerWalletId) {
    throw new ForbiddenError('Only the depositor can complete the escrow');
  }

  // Pass-3 #17 repair: a prior completion flipped status → 'completed' (backed by a
  // real on-chain release) but crashed BEFORE crediting wallet stats / emitting the
  // escrow_completed PEs. The stats_credited marker is now set AFTER those
  // side-effects, so this state is recoverable: re-run only the missing pieces
  // (idempotent) rather than throwing "expected funded", which used to permanently
  // strand the credit + PEs and silently understate trust discount / bond standing.
  if (doc.status === 'completed') {
    // WP7: a crash between the completion flip and the linked-job advancement
    // leaves the job un-advanced — retry it here (guarded + idempotent by the
    // settlement tx hash, so a fully-settled job is a no-op).
    await settleLinkedJobsForEscrow(
      deps,
      doc,
      'completed',
      settlementReceipt(doc.release_tx_hash),
      Date.now(),
    );
    if ((doc.completion_pe_ids?.length ?? 0) > 0 && doc.stats_credited) {
      return doc; // fully settled — nothing to repair
    }
    // Re-run the idempotent side-effects. The wallet-stat credit and the PE
    // emission each have their own atomic single-winner claim (stats_credited /
    // completion_pe_claimed), so two concurrent repair calls can neither
    // double-credit nor duplicate the completion PEs.
    const repairPeIds = await creditEscrowCompletion(deps, docRef, doc, Date.now());
    return { ...doc, pe_ids: [...doc.pe_ids, ...repairPeIds] };
  }

  if (doc.status !== 'funded') {
    throw new ValidationError(`Escrow status is ${doc.status}, expected funded`);
  }

  // WS1: completion must reflect a REAL on-chain release, not just a
  // Firestore status flip. Either the depositor already released on-chain
  // with their own key (SDK bank.releaseEscrow), or — once auto-release has
  // elapsed — the backend gas-only EOA releases permissionlessly. The relay
  // cannot sign as the depositor, so a pre-timeout completion with no
  // depositor release is refused rather than falsely marked paid.
  const settle: EscrowSettleResult = deps.escrowChain
    ? await deps.escrowChain.settle(doc)
    : { status: 'unconfigured' };

  switch (settle.status) {
    case 'released':
    case 'already_released':
      break; // funds are on-chain with the recipient; safe to record.
    case 'pending_pre_timeout':
      throw new ValidationError(
        'Escrow funds are not yet released on-chain. The depositor must release it on-chain first ' +
          '(SDK bank.releaseEscrow), or wait for auto-release — the relay cannot sign as the depositor before auto-release.',
      );
    case 'unconfigured':
      throw new ValidationError(
        'On-chain escrow release is temporarily unavailable (release signer unconfigured). ' +
          'Retry shortly, or release on-chain via SDK bank.releaseEscrow.',
      );
    case 'unrecoverable_id':
      throw new ValidationError(
        'Could not resolve the on-chain escrow id from the funding transaction; cannot confirm release.',
      );
    default:
      throw new ValidationError(`On-chain escrow release failed: ${settle.reason ?? 'unknown'}`);
  }

  const now = Date.now();

  // WS1 idempotency: atomically claim the funded->completed transition. The
  // status flip serializes concurrent settlers (auto-release scheduler or a
  // second completeEscrow) — only the caller that flips funded→completed runs the
  // credit + PE side-effects below; the rest return the already-completed doc.
  // Pass-3 #17: the stats_credited marker is NO LONGER set here — it is set AFTER
  // the credit/PE side-effects (in creditEscrowCompletion) so a crash between this
  // flip and the credit leaves stats_credited unset and the repair branch at the
  // top of completeEscrow re-runs the credit rather than permanently suppressing it.
  let claimed = false;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) return;
    const f = fresh.data() as EscrowDocument;
    if (f.status !== 'funded') return;
    tx.update(docRef, {
      status: 'completed',
      completed_at: now,
      updated_at: now,
      // Record the verified on-chain release so the Firestore "completed"
      // state is backed by a real fund movement.
      ...(settle.txHash ? { release_tx_hash: settle.txHash } : {}),
      ...(settle.onchainId ? { onchain_escrow_id: settle.onchainId } : {}),
    });
    claimed = true;
  });
  if (!claimed) {
    const current = (await docRef.get()).data() as EscrowDocument;
    return current;
  }

  // WP7: advance any linked job-board / Commons human-job documents through
  // the ONE receipt-gated settlement path (evaluateInstitutionTransition —
  // guarded, idempotent by the settlement tx hash, fail-closed: a missing
  // receipt hash leaves the job un-advanced for retry rather than recording an
  // evidence-free economic transition). The receipt is the confirmed on-chain
  // release this completion just recorded ('released' carries the fresh tx
  // hash; 'already_released' carries the recovered one, else the previously
  // recorded release_tx_hash). Mirrors the auto-release scheduler so the
  // manual and time-released paths produce the same end state.
  await settleLinkedJobsForEscrow(
    deps,
    doc,
    'completed',
    settlementReceipt(settle.txHash ?? doc.release_tx_hash),
    now,
  );

  const peIds = await creditEscrowCompletion(deps, docRef, doc, now);

  return {
    ...doc,
    status: 'completed',
    completed_at: now,
    ...(settle.txHash ? { release_tx_hash: settle.txHash } : {}),
    ...(settle.onchainId ? { onchain_escrow_id: settle.onchainId } : {}),
    pe_ids: [...doc.pe_ids, ...peIds],
  };
}

/**
 * Pass-3 #17: credit BOTH parties' wallet stats for a settled escrow AND set the
 * `stats_credited` idempotency marker in ONE Firestore transaction, so the credit
 * and its claim are atomic. This is:
 *   - crash-safe: a crash can neither SUPPRESS the credit (the pre-fix bug set
 *     stats_credited BEFORE the credit, so any crash/timeout in the credit
 *     permanently skipped a never-performed credit) nor double it; and
 *   - concurrency-safe: the auto-release scheduler and a depositor completeEscrow
 *     (or two overlapping cron ticks) can race — the first txn to set
 *     stats_credited wins; the loser reads it set and no-ops.
 *
 * `extraUpdate` lets a caller fold an additional escrow-doc update (e.g. the
 * auto-release scheduler's status→completed flip + settle metadata) into the SAME
 * atomic txn, so the escrow is only marked completed WHEN it is actually credited
 * (a crash leaves status='funded' → the next scheduler tick re-settles + retries).
 *
 * Mirrors updateWalletStats' USDC/PVT routing but transactionally (that helper is
 * single-doc and non-atomic w.r.t. the escrow marker). Returns true iff this call
 * performed the credit (false = already credited).
 */
interface WalletStatCredit {
  walletId: string;
  currency: Currency;
  amount: number | bigint; // USDC: number (USD float). PVT: bigint (18-decimal wei).
}

/**
 * Pass-3 #17 / N1: apply one or more wallet-stat credits AND set an idempotency
 * marker on the escrow doc in ONE Firestore transaction, so the credits and their
 * claim are atomic (crash-safe: never suppress a never-performed credit, never
 * double it; concurrency-safe: the first txn to set the marker wins). Optionally
 * folds `extraUpdate` (e.g. the auto-release scheduler's status→completed flip)
 * into the same txn so the escrow is marked completed only WHEN it is credited.
 * Mirrors updateWalletStats' USDC/PVT routing transactionally. Returns true iff
 * this call performed the credits (false = the marker was already set).
 */
async function creditWalletStatsAtomic(
  deps: AgentBankDeps,
  docRef: FirebaseFirestore.DocumentReference,
  now: number,
  markerField: 'stats_credited' | 'funding_stats_credited',
  credits: WalletStatCredit[],
  extraUpdate?: Record<string, unknown>,
): Promise<boolean> {
  const { increment } = admin.firestore.FieldValue;
  const walletRefs = credits.map((c) => deps.db.collection('agent_wallets').doc(c.walletId));

  let credited = false;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) return;
    if ((fresh.data() as Record<string, unknown>)[markerField]) return; // already credited — idempotent no-op

    // Firestore requires all reads before writes. PVT credits need the current
    // per-wallet economic_activity_pvt (BigInt-as-string; increment() is number-only).
    const snaps = await Promise.all(walletRefs.map((r) => tx.get(r)));
    credits.forEach((c, i) => {
      const ref = walletRefs[i];
      // D-329: a HUMAN escrow party has no `agent_wallets` doc. Agent-reputation
      // stats (pe_count, economic_activity_*) do not apply to humans, and a
      // `tx.update` on a nonexistent doc throws and would abort the whole
      // completion/funding txn. Skip the credit for a missing (human) wallet —
      // the on-chain settlement to the human's address is unaffected.
      if (!snaps[i].exists) {
        return;
      }
      // D-446: the stored agent_wallets.pe_count tally is deleted; PE counts are
      // read live from pe_history. Only the economic-activity totals are credited.
      if (c.currency === 'pvt') {
        const v = snaps[i].exists ? (snaps[i].data() as { economic_activity_pvt?: string }).economic_activity_pvt : '0';
        const prev = v && /^[0-9]+$/.test(v) ? BigInt(v) : 0n;
        tx.update(ref, {
          economic_activity_pvt: (prev + (c.amount as bigint)).toString(),
          updated_at: now,
        });
      } else {
        tx.update(ref, {
          economic_activity_usd: increment(c.amount as number),
          updated_at: now,
        });
      }
    });
    tx.update(docRef, { [markerField]: true, ...(extraUpdate ?? {}), updated_at: now });
    credited = true;
  });
  return credited;
}

/**
 * Pass-3 #17: credit BOTH escrow parties' wallet stats + set `stats_credited`
 * atomically. `extraUpdate` lets the auto-release scheduler fold its
 * status→completed flip into the same txn (so a crash leaves status='funded' →
 * the next tick re-settles + retries). Returns true iff it credited this call.
 */
export async function creditEscrowStatsOnce(
  deps: AgentBankDeps,
  docRef: FirebaseFirestore.DocumentReference,
  doc: EscrowDocument,
  now: number,
  extraUpdate?: Record<string, unknown>,
): Promise<boolean> {
  const currency = doc.currency ?? 'usdc';
  const credits: WalletStatCredit[] = currency === 'pvt'
    ? [
        { walletId: doc.depositor_wallet_id, currency: 'pvt', amount: BigInt(doc.amount_pvt ?? '0') },
        { walletId: doc.recipient_wallet_id, currency: 'pvt', amount: BigInt(doc.net_to_recipient_pvt ?? '0') },
      ]
    : [
        { walletId: doc.depositor_wallet_id, currency: 'usdc', amount: doc.amount_usdc },
        { walletId: doc.recipient_wallet_id, currency: 'usdc', amount: doc.net_to_recipient_usdc },
      ];
  return creditWalletStatsAtomic(deps, docRef, now, 'stats_credited', credits, extraUpdate);
}

/**
 * Pass-3 review: atomic single-winner claim for escrow_completed PE emission.
 * Transactionally sets `completion_pe_claimed` iff the PEs have neither been
 * emitted (`completion_pe_ids`) nor already claimed. Exactly one concurrent
 * caller (scheduler tick, completeEscrow, or a double-clicked repair) wins and
 * emits; the rest get false and skip — preventing duplicate escrow_completed PEs
 * in the append-only chain. Returns true iff THIS call won the claim.
 */
export async function claimCompletionEmission(
  deps: AgentBankDeps,
  docRef: FirebaseFirestore.DocumentReference,
  now: number,
): Promise<boolean> {
  let claimed = false;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) return;
    const f = fresh.data() as EscrowDocument;
    if ((f.completion_pe_ids?.length ?? 0) > 0 || f.completion_pe_claimed) return;
    tx.update(docRef, { completion_pe_claimed: true, updated_at: now });
    claimed = true;
  });
  return claimed;
}

/**
 * Pass-3 #17 + review: idempotent escrow-completion side-effects (escrow_completed
 * PEs + both parties' wallet-stat credits + the completion corroboration signal),
 * split out so they run AFTER the status-flip claim txn AND can be safely re-run by
 * the completeEscrow repair branch after a crash.
 *
 * Single-winner / crash-safety design:
 *   - The wallet-stat credit + its `stats_credited` marker are ATOMIC
 *     (creditEscrowStatsOnce) — the single-winner gate for the MONEY. A crash
 *     before it leaves the credit un-suppressed (a later call re-runs it).
 *   - The escrow_completed PEs are emitted under a SEPARATE atomic single-winner
 *     claim (claimCompletionEmission → completion_pe_claimed), independent of the
 *     credit, so exactly one caller emits even across a scheduler-vs-completeEscrow
 *     race OR two concurrent completeEscrow repair calls. Each leg is individually
 *     recoverable: a later call re-runs whichever of {credit, emission} is unclaimed.
 *
 * Returns the escrow_completed PE ids emitted this call (empty if none emitted).
 */
async function creditEscrowCompletion(
  deps: AgentBankDeps,
  docRef: FirebaseFirestore.DocumentReference,
  doc: EscrowDocument,
  now: number,
): Promise<string[]> {
  const escrowId = doc.escrow_id;
  const completionCurrency = doc.currency ?? 'usdc';

  // 1) Wallet stats — credited + marked atomically (single-winner for the MONEY).
  await creditEscrowStatsOnce(deps, docRef, doc, now);

  // 2) escrow_completed PEs — emit once via a SEPARATE atomic single-winner claim
  //    (completion_pe_claimed), independent of the credit. This is what prevents
  //    two concurrent settlers (scheduler / completeEscrow / double-clicked repair)
  //    from BOTH appending duplicate completion PEs to the append-only chain: the
  //    first to win the claim emits; every other caller reads the claim/marker and
  //    skips. Both the credit and the emission are individually recoverable — a
  //    later call re-runs whichever leg is still unclaimed.
  let peIds: string[] = [];
  if (await claimCompletionEmission(deps, docRef, now)) {
    const [depositor, recipient] = await Promise.all([
      resolveEscrowParty(deps, doc.depositor_wallet_id, 'Depositor'),
      resolveEscrowParty(deps, doc.recipient_wallet_id, 'Recipient'),
    ]);

    const completionMeta = (role: 'depositor' | 'recipient'): Record<string, unknown> => {
      const m: Record<string, unknown> = {
        escrow_id: escrowId,
        currency: completionCurrency,
        role,
      };
      if (completionCurrency === 'pvt') {
        m.amount_pvt = doc.amount_pvt;
        m.net_to_recipient_pvt = doc.net_to_recipient_pvt;
        m.fee_pvt = doc.fee_pvt;
      } else {
        m.amount_usdc = doc.amount_usdc;
        m.net_to_recipient_usdc = doc.net_to_recipient_usdc;
        m.fee_usdc = doc.fee_usdc;
      }
      return m;
    };

    const { peId: depositorPeId } = await generatePE(deps, {
      walletId: doc.depositor_wallet_id,
      agentId: depositor.agentId,
      actorAddress: depositor.address,
      actionType: 'escrow_completed',
      metadata: completionMeta('depositor'),
      counterpartyAddress: recipient.address,
    });
    const { peId: recipientPeId } = await generatePE(deps, {
      walletId: doc.recipient_wallet_id,
      agentId: recipient.agentId,
      actorAddress: recipient.address,
      actionType: 'escrow_completed',
      metadata: completionMeta('recipient'),
      counterpartyAddress: depositor.address,
    });
    peIds = [depositorPeId, recipientPeId];
    // completion_pe_ids is set once (only the atomic credit winner / a repair with
    // the marker still absent reaches here), so a plain set is correct; pe_ids
    // accumulates across create/fund/complete so it stays arrayUnion.
    await docRef.update({
      pe_ids: admin.firestore.FieldValue.arrayUnion(...peIds),
      completion_pe_ids: peIds,
      updated_at: now,
    });
    emitCompletionCorroboration(deps, doc, depositor, now);
  }

  return peIds;
}

/**
 * Fire-and-forget completion corroboration signal (extracted so creditEscrowCompletion
 * emits it only on the PE-emitting branch — the credit winner / repair). escrow
 * completed without dispute confirms the escrow_created PE. Pass-2 #5: fetch the
 * REAL target PE hash (was hardcoded '' which the CorroborationManager falsy-guard
 * rejected). Mirror the github-webhook fetch-then-skip-if-absent pattern; a
 * genuinely-missing target is skipped, never a valid signal suppressed (#8).
 */
function emitCompletionCorroboration(
  deps: AgentBankDeps,
  doc: EscrowDocument,
  depositor: EscrowParty,
  now: number,
): void {
  const escrowId = doc.escrow_id;
  const completionCurrency = doc.currency ?? 'usdc';
  const creationPeId = doc.pe_ids[0]; // First PE is always escrow_created
  if (!creationPeId) return;
  void (async () => {
    const targetPeHash = await resolveTargetPeHash(deps, creationPeId);
    if (!targetPeHash) {
      console.warn(`[Escrow] Corroboration skipped: no resolvable hash for target PE ${creationPeId}`);
      return;
    }
    await emitBackendCorroboration(deps, {
      targetPeId: creationPeId,
      targetPeHash,
      signalType: 'escrow_completed',
      // 'system', not the caller: this is a relay-generated automated signal
      // grounded in the VERIFIED on-chain release (WS1), and the escrow_created
      // target is authored by the depositor — the same wallet that calls
      // completeEscrow. Attributing the caller would make it a self-corroboration
      // (an invalid signal under Inv #8); the honest attestor is the system that
      // verified the settlement (mirrors the webhook 'github_app' system actor).
      corroboratingParty: 'system',
      evidence: JSON.stringify({
        escrow_id: escrowId,
        currency: completionCurrency,
        ...(completionCurrency === 'pvt'
          ? { amount_pvt: doc.amount_pvt }
          : { amount_usdc: doc.amount_usdc }),
        completed_at: now,
      }),
      evidenceRef: escrowId,
      walletId: doc.depositor_wallet_id,
      agentId: depositor.agentId,
      actorAddress: depositor.address,
    });
  })().catch((err) => console.warn('[Escrow] Corroboration emit failed:', err));
}

export async function disputeEscrow(
  deps: AgentBankDeps,
  escrowId: string,
  callerWalletId: string,
  reason: string,
  evidence?: string,
): Promise<EscrowDocument> {
  const docRef = deps.db.collection('escrows').doc(escrowId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Escrow not found');

  const doc = snapshot.data() as EscrowDocument;
  if (doc.status !== 'funded') {
    throw new ValidationError(`Escrow status is ${doc.status}, expected funded`);
  }
  if (doc.depositor_wallet_id !== callerWalletId) {
    throw new ForbiddenError('Only the depositor can dispute');
  }
  if (Date.now() >= doc.auto_release_at) {
    throw new ValidationError('Cannot dispute after auto-release deadline');
  }

  const now = Date.now();

  // D-438 (Frank, 2026-09-14): the `escrow_disputed` PE is now CHAIN-WITNESSED.
  // The institution completion watcher observes the on-chain `EscrowDisputed`
  // event a depositor raises on the escrow contract (`disputeEscrow` is
  // `onlyDepositor`) and seals a verified PE at parity with escrow_resolved. The
  // relay dispute is a Firestore state flip only — app UX, the linked-job mirror,
  // and the counterparty notification — and no longer emits a self-reported draft
  // PE. That draft was the 09-04 Option-2 self-report (a depositor's unilateral
  // relay call minting with no independent verifier); its earning path is retired
  // in favour of the on-chain witness. No PE is emitted here.
  await docRef.update({
    status: 'disputed',
    disputed_at: now,
    dispute_reason: reason,
    dispute_evidence: evidence || null,
    updated_at: now,
  });

  // WP7: mirror the dispute onto any linked job documents (record-only — the
  // dispute lives on THIS escrow record; the mirror is fail-closed and never
  // affects the escrow's own dispute state).
  await mirrorEscrowDisputeToLinkedJobs(deps, escrowId, now);

  return { ...doc, status: 'disputed', disputed_at: now };
}

/**
 * D-513: the hire this escrow pays for. The lookup is the resolver's own, so EVERY caller seals the
 * hire on the rows — the hiring board's settle, the hourly sweep, and the admin route alike.
 */
export async function hireJobIdForEscrow(
  deps: AgentBankDeps,
  escrowId: string,
  given?: string,
): Promise<string | null> {
  if (typeof given === 'string' && given.length > 0) return given;
  for (const collection of ['commons_human_jobs', 'jobs']) {
    const snap = await deps.db.collection(collection).where('escrow_id', '==', escrowId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  return null;
}

export async function resolveDispute(
  deps: AgentBankDeps,
  escrowId: string,
  releaseToRecipient: boolean,
  resolutionReason: string,
  /**
   * D-513: the hire, when the caller already knows it. Otherwise the resolver looks it up
   * ({@link hireJobIdForEscrow}). The job id is sealed on both parties' rows
   * (`hire_job_id`); Standing counts the row of the party the chain did not pay as one lost hire
   * dispute. A non-hire escrow, and a dispute the Court decided, stay plain records.
   */
  context: { hireJobId?: string } = {},
): Promise<EscrowDocument> {
  const docRef = deps.db.collection('escrows').doc(escrowId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Escrow not found');

  const doc = snapshot.data() as EscrowDocument;
  if (doc.status !== 'disputed') {
    throw new ValidationError(`Escrow status is ${doc.status}, expected disputed`);
  }

  // Pass-3 #1 (CRITICAL): settle the dispute ON-CHAIN before recording anything.
  // The prior code flipped Firestore → 'resolved' + emitted escrow_resolved PEs
  // while the on-chain escrow stayed Disputed forever — the disputed principal
  // was locked with no relay/admin/depositor-callable exit, yet both parties were
  // told they'd been paid. Now the on-chain settlement (resolveDispute /
  // claimDisputeTimeout, or an observed Court/admin resolution) is REQUIRED and
  // fail-closed: we record ONLY on a confirmed terminal on-chain resolution.
  const settle: EscrowDisputeSettleResult = deps.escrowChain
    ? await deps.escrowChain.settleDispute(doc, releaseToRecipient)
    : { status: 'unconfigured' };

  switch (settle.status) {
    case 'resolved':
    case 'already_resolved':
      break; // funds moved on-chain (recipient on release, depositor on refund); safe to record.
    case 'pending_onchain':
      throw new ValidationError(
        'On-chain dispute resolution is not settled. release_to_recipient requires the escrow admin/court to ' +
          'resolve on-chain (or route through the Court panel); a depositor refund can also settle via the ' +
          'permissionless on-chain dispute-timeout once its window elapses. The relay will not mark this ' +
          'resolved until the funds actually move on-chain.',
      );
    case 'not_disputed_onchain':
      throw new ValidationError(
        'On-chain escrow is not in a disputed state (no on-chain dispute was filed, or it is already terminal); ' +
          'cannot resolve.',
      );
    case 'unconfigured':
      throw new ValidationError(
        'On-chain dispute resolution is temporarily unavailable (release signer unconfigured). Retry shortly.',
      );
    case 'unrecoverable_id':
      throw new ValidationError(
        'Could not resolve the on-chain escrow id from the funding transaction; cannot confirm resolution.',
      );
    default:
      throw new ValidationError(`On-chain dispute resolution failed: ${settle.reason ?? 'unknown'}`);
  }

  const now = Date.now();
  // Record the ACTUAL on-chain resolution direction, not the requested one — they
  // can diverge (e.g. a permissionless claimDisputeTimeout refunded the depositor
  // even though release was requested; or an out-of-band admin/Court resolution
  // paid the other party). settleDispute recovers it from the EscrowResolved event
  // on the observe path; on the driven path it equals the requested direction.
  const effectiveRelease = settle.resolvedReleaseToRecipient ?? releaseToRecipient;
  const resolution = effectiveRelease ? 'release_to_recipient' : 'refund_to_depositor';

  // PEs for both parties. N2: emit BEFORE the status flip so a generatePE failure
  // leaves the escrow 'disputed' and the (idempotent, on-chain-Resolved)
  // resolution can be retried — settleDispute returns already_resolved on the
  // retry. The old order flipped status → 'resolved' first, blocking that retry,
  // and never persisted the escrow_resolved pe_ids onto the doc at all.
  const [depositor, recipient] = await Promise.all([
    resolveEscrowParty(deps, doc.depositor_wallet_id, 'Depositor'),
    resolveEscrowParty(deps, doc.recipient_wallet_id, 'Recipient'),
  ]);

  const peIds: string[] = [];
  const resolvedCurrency = doc.currency ?? 'usdc';

  // A lost hire dispute is one decided by the escrow admin or the timeout refund. A dispute the
  // Court decided (its `Verdict` rides the resolving transaction, read from the chain) is counted by
  // that verdict on the loser and never a second time here. Unknown resolver = no hire mark.
  const hireJobId = settle.resolvedByCourt === false
    ? await hireJobIdForEscrow(deps, escrowId, context.hireJobId)
    : null;
  const hireMetadata = hireJobId !== null ? { hire_job_id: hireJobId } : {};

  // D-513: each party's row is sealed ONCE per escrow. This block runs before the status flip, so
  // a failure after the first row is retried from the top; without the lock that retry sealed the
  // first party's row a second time.
  const { peId: depositorPeId } = await generatePEOnce(deps, ['escrow_resolved', escrowId, 'depositor'], {
    walletId: doc.depositor_wallet_id,
    agentId: depositor.agentId,
    actorAddress: depositor.address,
    actionType: 'escrow_resolved',
    metadata: {
      escrow_id: escrowId,
      currency: resolvedCurrency,
      resolution,
      resolution_reason: resolutionReason,
      role: 'depositor',
      ...hireMetadata,
      ...(settle.txHash ? { resolution_tx_hash: settle.txHash } : {}),
    },
    counterpartyAddress: recipient.address,
  });
  peIds.push(depositorPeId);

  const { peId: recipientPeId } = await generatePEOnce(deps, ['escrow_resolved', escrowId, 'recipient'], {
    walletId: doc.recipient_wallet_id,
    agentId: recipient.agentId,
    actorAddress: recipient.address,
    actionType: 'escrow_resolved',
    metadata: {
      escrow_id: escrowId,
      currency: resolvedCurrency,
      resolution,
      resolution_reason: resolutionReason,
      role: 'recipient',
      ...hireMetadata,
      ...(settle.txHash ? { resolution_tx_hash: settle.txHash } : {}),
    },
    counterpartyAddress: depositor.address,
  });
  peIds.push(recipientPeId);

  // Atomic-ish: flip status + persist the resolution PEs (arrayUnion) + record the
  // on-chain resolution tx in a single update.
  await docRef.update({
    status: 'resolved',
    resolution,
    resolution_reason: resolutionReason,
    resolved_at: now,
    ...(settle.txHash ? { resolution_tx_hash: settle.txHash } : {}),
    ...(settle.onchainId ? { onchain_escrow_id: settle.onchainId } : {}),
    pe_ids: admin.firestore.FieldValue.arrayUnion(...peIds),
    updated_at: now,
  });

  // WP7: settle any linked job documents off the ACTUAL on-chain resolution
  // direction — released to the worker ⇒ 'completed'; refunded to the poster ⇒
  // 'refunded' (the worker was NOT paid, so the job must never read
  // 'completed'). Guarded + idempotent by the resolution tx hash; fail-closed
  // when the observe path could not recover a hash (job left for retry).
  await settleLinkedJobsForEscrow(
    deps,
    doc,
    effectiveRelease ? 'completed' : 'refunded',
    settlementReceipt(settle.txHash ?? doc.resolution_tx_hash),
    now,
  );

  return {
    ...doc,
    status: 'resolved',
    resolution,
    resolved_at: now,
    ...(settle.txHash ? { resolution_tx_hash: settle.txHash } : {}),
    pe_ids: [...doc.pe_ids, ...peIds],
  };
}

export async function getEscrow(
  deps: AgentBankDeps,
  escrowId: string,
): Promise<EscrowDocument> {
  const snapshot = await deps.db.collection('escrows').doc(escrowId).get();
  if (!snapshot.exists) throw new NotFoundError('Escrow not found');
  return snapshot.data() as EscrowDocument;
}

export async function getWalletEscrows(
  deps: AgentBankDeps,
  walletId: string,
  limit: number = 50,
): Promise<EscrowDocument[]> {
  // Query both as depositor and recipient
  const [asDepositor, asRecipient] = await Promise.all([
    deps.db.collection('escrows')
      .where('depositor_wallet_id', '==', walletId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get(),
    deps.db.collection('escrows')
      .where('recipient_wallet_id', '==', walletId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get(),
  ]);

  const all = [
    ...asDepositor.docs.map(d => d.data() as EscrowDocument),
    ...asRecipient.docs.map(d => d.data() as EscrowDocument),
  ];

  // Deduplicate and sort
  const seen = new Set<string>();
  const deduped = all.filter(e => {
    if (seen.has(e.escrow_id)) return false;
    seen.add(e.escrow_id);
    return true;
  });

  return deduped.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

// =========================================================================
// Error types - re-exported from shared module for backward compatibility
// =========================================================================

export { ValidationError, NotFoundError, ForbiddenError } from './errors';
