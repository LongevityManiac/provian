/**
 * Agent Bank - Promise Business Logic
 *
 * On-chain reputation-backed IOUs. The PE chain is the credit history.
 * Default is reputational - no collateral seizure, just negative PEs.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import {
  SAFETY_LIMITS,
  parsePvtWei,
  type AgentBankDeps,
  type CreatePromiseRequest,
  type Currency,
  type PromiseDocument,
  type BorrowerSnapshot,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { ValidationError, NotFoundError, ForbiddenError, RateLimitError } from './errors';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import { verifyEvmPromiseFunding, verifyEvmPromiseSettlement, verifyEvmPromiseDefault } from '../onchain/tx-verifier';
import { isPvtPrincipalEnabledForChain } from './pvt-principal-config';
import { updateWalletStats } from './wallet-stats';
import {
  assertSupportedAgentBankChain,
  promiseUsdcAddressForChain,
  promiseV3AddressForChain,
  requireAddressOrThrow,
  type AgentBankChain,
} from './chain-registry';

import { generatePE } from './pe-utils';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the promise contract address for a given currency and chain.
 * USDC routes to V2 (`PROMISE_CONTRACT_ADDRESS_<CHAIN>` or legacy
 * `PROMISE_CONTRACT_ADDRESS`). PVT routes to V3 (`PROMISE_V3_CONTRACT_ADDRESS_<CHAIN>`
 * or legacy `PROMISE_V3_CONTRACT_ADDRESS`, only when ENABLE_PVT_PRINCIPAL=true).
 *
 * Wave J-bis: chain-aware resolver. Single-chain deployments keep working
 * via the legacy single-valued env var fallback in chain-registry.
 */
export function resolvePromiseContractAddress(currency: Currency, chain: AgentBankChain): string {
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(chain)) {
      throw new ValidationError(`PVT-principal promises are not enabled for chain '${chain}' on this relay`);
    }
    return requireAddressOrThrow(promiseV3AddressForChain(chain), 'PROMISE_V3', chain);
  }
  return requireAddressOrThrow(promiseUsdcAddressForChain(chain), 'PROMISE', chain);
}

async function getBorrowerSnapshot(
  deps: AgentBankDeps,
  wallet: AgentWalletDocument,
): Promise<BorrowerSnapshot> {
  // Count promise history
  const [issued, settled, defaulted] = await Promise.all([
    deps.db.collection('promises')
      .where('borrower_wallet_id', '==', wallet.id)
      .get()
      .then(s => s.size),
    deps.db.collection('promises')
      .where('borrower_wallet_id', '==', wallet.id)
      .where('status', '==', 'settled')
      .get()
      .then(s => s.size),
    deps.db.collection('promises')
      .where('borrower_wallet_id', '==', wallet.id)
      .where('status', '==', 'defaulted')
      .get()
      .then(s => s.size),
  ]);

  return {
    economic_activity_usd: wallet.economic_activity_usd,
    economic_activity_pvt: wallet.economic_activity_pvt ?? '0',
    promises_issued: issued,
    promises_settled: settled,
    promises_defaulted: defaulted,
  };
}

// ---------------------------------------------------------------------------
// Promise operations
// ---------------------------------------------------------------------------

// P1-5: Per-wallet creation rate limit - max 50 promises per wallet per 24h.
const CREATION_RATE_LIMIT = 50;
const CREATION_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createPromise(
  deps: AgentBankDeps,
  body: CreatePromiseRequest,
): Promise<PromiseDocument> {
  // P1-5: Per-wallet rate limit on promise creation
  const windowStart = new Date(Date.now() - CREATION_RATE_WINDOW_MS);
  const snap = await deps.db.collection('promises')
    .where('borrower_wallet_id', '==', body.borrower_wallet_id)
    .where('created_at', '>=', windowStart.getTime())
    .count()
    .get();
  if (snap.data().count >= CREATION_RATE_LIMIT) {
    throw new RateLimitError(`Rate limit exceeded: max ${CREATION_RATE_LIMIT} promise creations per 24 hours`);
  }

  // --- Currency routing ---
  const currency: Currency = body.currency ?? 'usdc';
  if (currency !== 'usdc' && currency !== 'pvt') {
    throw new ValidationError(`currency must be 'usdc' or 'pvt' (got ${String(currency)})`);
  }
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(body.chain ?? 'base')) {
      throw new ValidationError(`PVT-principal promises are not enabled for chain '${body.chain ?? 'base'}' on this relay`);
    }
  }

  // --- Currency-specific amount validation + fee calculation ---
  let principalUsdc = 0;
  let repayUsdc = 0;
  let feeUsdc = 0;
  let netToLenderUsdc = 0;
  let principalPvtWei: bigint = 0n;
  let repayPvtWei: bigint = 0n;
  let feePvtWei: bigint = 0n;
  let netToLenderPvtWei: bigint = 0n;

  if (currency === 'usdc') {
    if (body.principal_usdc === undefined || body.repay_usdc === undefined) {
      throw new ValidationError('principal_usdc and repay_usdc are required when currency is usdc');
    }
    // F39 (guard extension): the range checks below use only <= / > / <,
    // which COERCE a missing/non-number value to a false comparison
    // (`undefined <= 0` is false, `"9" < "10"` is false) — so a string or NaN
    // amount slips through and persists a marketplace listing whose fee math
    // coerces silently. Reject any non-number / non-finite amount at the boundary
    // BEFORE any comparison, exactly as escrow.ts does.
    if (typeof body.principal_usdc !== 'number' || !Number.isFinite(body.principal_usdc)) {
      throw new ValidationError('principal_usdc must be a finite number');
    }
    if (typeof body.repay_usdc !== 'number' || !Number.isFinite(body.repay_usdc)) {
      throw new ValidationError('repay_usdc must be a finite number');
    }
    if (body.principal_usdc <= 0 || body.principal_usdc > SAFETY_LIMITS.MAX_PROMISE_PRINCIPAL_USD) {
      throw new ValidationError(`principal_usdc must be between 0 and ${SAFETY_LIMITS.MAX_PROMISE_PRINCIPAL_USD}`);
    }
    if (body.repay_usdc < body.principal_usdc) {
      throw new ValidationError('repay_usdc must be >= principal_usdc');
    }
    principalUsdc = body.principal_usdc;
    repayUsdc = body.repay_usdc;
    feeUsdc = Math.round(repayUsdc * 0.0025 * 1_000_000) / 1_000_000;
    netToLenderUsdc = Math.round((repayUsdc - feeUsdc) * 1_000_000) / 1_000_000;
  } else {
    if (body.principal_pvt === undefined || body.repay_pvt === undefined) {
      throw new ValidationError('principal_pvt and repay_pvt are required when currency is pvt');
    }
    try {
      principalPvtWei = parsePvtWei(body.principal_pvt);
      repayPvtWei = parsePvtWei(body.repay_pvt);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    if (repayPvtWei < principalPvtWei) {
      throw new ValidationError('repay_pvt must be >= principal_pvt');
    }
    const maxPvtWei = BigInt(SAFETY_LIMITS.MAX_PROMISE_PRINCIPAL_USD) * (10n ** 18n);
    if (principalPvtWei > maxPvtWei) {
      throw new ValidationError(
        `principal_pvt must be ≤ ${SAFETY_LIMITS.MAX_PROMISE_PRINCIPAL_USD} PVT (atomic ≤ ${maxPvtWei.toString()})`,
      );
    }
    // 0.25% fee in PVT atomic units. 25/10000 = 0.0025.
    feePvtWei = (repayPvtWei * 25n) / 10000n;
    netToLenderPvtWei = repayPvtWei - feePvtWei;
  }

  // F39 (guard extension): reject non-finite deadline_hours before the
  // range check and before `now + body.deadline_hours * …` (which would persist a
  // NaN deadline the scheduler's `.where('deadline','<=',now)` can never match,
  // so a never-repaid promise is never defaulted).
  if (typeof body.deadline_hours !== 'number' || !Number.isFinite(body.deadline_hours)) {
    throw new ValidationError('deadline_hours must be a finite number');
  }
  if (body.deadline_hours <= 0 || body.deadline_hours > SAFETY_LIMITS.MAX_PROMISE_DEADLINE_HOURS) {
    throw new ValidationError(`deadline_hours must be between 1 and ${SAFETY_LIMITS.MAX_PROMISE_DEADLINE_HOURS}`);
  }
  if (!body.purpose || body.purpose.length > 1000) {
    throw new ValidationError('purpose is required (max 1000 chars)');
  }
  // Wave J-bis: accept any chain in SUPPORTED_AGENT_BANK_CHAINS (Base/Arb/Op).
  assertSupportedAgentBankChain(body.chain);

  // --- Look up borrower ---
  const borrowerDoc = await deps.db.collection('agent_wallets').doc(body.borrower_wallet_id).get();
  if (!borrowerDoc.exists) throw new NotFoundError('Borrower wallet not found');
  const borrower = borrowerDoc.data() as AgentWalletDocument;

  const now = Date.now();
  const promiseId = `prm_${uuidv4()}`;
  const deadline = now + body.deadline_hours * 60 * 60 * 1000;
  const borrowerSnapshot = await getBorrowerSnapshot(deps, borrower);

  const doc: PromiseDocument = {
    promise_id: promiseId,
    borrower_wallet_id: body.borrower_wallet_id,
    borrower_address: borrower.address,
    currency,
    principal_usdc: principalUsdc,
    repay_usdc: repayUsdc,
    fee_usdc: feeUsdc,
    net_to_lender_usdc: netToLenderUsdc,
    purpose: body.purpose,
    chain: body.chain,
    deadline,
    status: 'open',
    borrower_snapshot: borrowerSnapshot,
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };
  if (currency === 'pvt') {
    doc.principal_pvt = principalPvtWei.toString();
    doc.repay_pvt = repayPvtWei.toString();
    doc.fee_pvt = feePvtWei.toString();
    doc.net_to_lender_pvt = netToLenderPvtWei.toString();
  }

  await deps.db.collection('promises').doc(promiseId).set(doc);

  // PE for borrower
  const peMetadata: Record<string, unknown> = {
    promise_id: promiseId,
    currency,
    deadline_hours: body.deadline_hours,
    purpose: body.purpose,
  };
  if (currency === 'usdc') {
    peMetadata.principal_usdc = principalUsdc;
    peMetadata.repay_usdc = repayUsdc;
  } else {
    peMetadata.principal_pvt = principalPvtWei.toString();
    peMetadata.repay_pvt = repayPvtWei.toString();
  }

  const { peId } = await generatePE(deps, {
    walletId: body.borrower_wallet_id,
    agentId: borrower.agent_id,
    actorAddress: borrower.address,
    actionType: 'promise_created',
    metadata: peMetadata,
  });

  doc.pe_ids = [peId];
  await deps.db.collection('promises').doc(promiseId).update({ pe_ids: [peId] });

  return doc;
}

export async function fundPromise(
  deps: AgentBankDeps,
  promiseId: string,
  lenderWalletId: string,
  txHash: string,
): Promise<PromiseDocument> {
  const docRef = deps.db.collection('promises').doc(promiseId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Promise not found');

  const initialDoc = snapshot.data() as PromiseDocument;
  if (initialDoc.status !== 'open') {
    throw new ValidationError(`Promise status is ${initialDoc.status}, expected open`);
  }
  if (initialDoc.borrower_wallet_id === lenderWalletId) {
    throw new ValidationError('Cannot fund your own promise');
  }

  // no governance-score re-check at fund time — the governance signal is
  // deleted and no eligibility path reads it. Borrower standing is expressed
  // through the PE chain / standing facts, not a per-wallet score.

  const lenderDoc = await deps.db.collection('agent_wallets').doc(lenderWalletId).get();
  if (!lenderDoc.exists) throw new NotFoundError('Lender wallet not found');
  const lender = lenderDoc.data() as AgentWalletDocument;

  // Phase 2.9 - Theme 3: verify the lender actually moved the principal
  // into the promise contract before flipping status to funded. RPC
  // happens OUTSIDE the transaction. Workstream 2: route by currency.
  //
  // V2 (USDC) and V3 (PVT) promise contracts are addressed separately;
  // pulling principal from lender → borrower happens inside fundPromise()
  // on-chain regardless of currency, but the verifier needs to look at
  // the right token contract's Transfer log.
  const promiseCurrency = initialDoc.currency ?? 'usdc';
  const fundChain = (initialDoc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(fundChain);
  const promiseContractAddress = resolvePromiseContractAddress(promiseCurrency, fundChain);
  // / Stage 1a — THE BAR IS THE CONTRACT'S OWN EVENT, not a bare transfer.
  //
  // Both V2 (USDC) and V3 (PVT) call IERC20.transferFrom(lender → borrower)
  // inside fundPromise(), so the funding does produce a lender → borrower
  // Transfer log — which is exactly why the old `verifyTransfer` bar was
  // unsound: a plain `usdc.transfer(borrower, principal)` that never touches
  // the promise contract produces the SAME log. It passed, the row flipped to
  // `funded`, and a `promise_funded` PE was emitted for a promise that stayed
  // `Open` on chain with no lender of record and no settlement path. Pools
  // closed this gap in Pass-2 (`verifyEvmPoolContribution`) and escrow bound
  // its struct in WS3; promises were the one funding institution still on the
  // weaker bar. `verifyEvmPromiseFunding` requires the contract's own
  // PromiseFunded/PromiseFundedPVT event naming this lender for this principal,
  // AND the on-chain struct's borrower — and returns the canonical log identity
  // (`chainId:txHash:logIndex`) the funding landed at.
  const fundVerification = await verifyEvmPromiseFunding({
    chain: fundChain,
    fundTxHash: txHash,
    promiseContractAddress,
    expectedLender: lender.address,
    expectedBorrower: initialDoc.borrower_address,
    currency: promiseCurrency,
    ...(promiseCurrency === 'pvt'
      ? { expectedAmountPvtWei: BigInt(initialDoc.principal_pvt ?? '0') }
      : { expectedAmountUsdc: initialDoc.principal_usdc }),
  });
  if (!fundVerification.ok) {
    throw new ValidationError(`On-chain promise funding verification failed: ${fundVerification.reason}`);
  }

  // ok==true guarantees both; the guards are defensive so the unique key below
  // can never be `null` and the recorded identity is never half-present.
  const onchainPromiseId = fundVerification.onchainPromiseId;
  const fundLogIndex = fundVerification.logIndex;
  if (!onchainPromiseId || typeof fundLogIndex !== 'number') {
    throw new ValidationError('On-chain promise verification did not yield a canonical log identity');
  }
  // The on-chain bytes32 id is the unique anchor for a funding. A lender can
  // legitimately fund several distinct promises in one tx (distinct ids), but
  // the SAME on-chain promise must never credit two Firestore rows — that would
  // double-credit wallet stats and emit two pairs of promise_funded PEs from a
  // single real fund movement. Mirrors escrow's `escrow_fund_locks` (WS3 #2).
  const fundLockRef = deps.db
    .collection('promise_fund_locks')
    .doc(`${fundChain}:${onchainPromiseId}`);

  // Phase 2.13 - Theme 8: status transition runs in a Firestore transaction
  // so two concurrent fund attempts can't both succeed.
  const now = Date.now();
  let doc!: PromiseDocument;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Promise not found');
    doc = fresh.data() as PromiseDocument;
    if (doc.status !== 'open') {
      throw new ValidationError(`Promise status is ${doc.status}, expected open`);
    }
    const lock = await tx.get(fundLockRef);
    if (lock.exists) {
      throw new ValidationError('This on-chain promise funding is already bound to another promise');
    }
    tx.set(fundLockRef, {
      promise_id: promiseId,
      chain: fundChain,
      onchain_promise_id: onchainPromiseId,
      fund_tx_hash: txHash,
      fund_log_index: fundLogIndex,
      created_at: now,
    });
    tx.update(docRef, {
      status: 'funded',
      lender_wallet_id: lenderWalletId,
      lender_address: lender.address,
      funded_at: now,
      fund_tx_hash: txHash,
      fund_block_number: fundVerification.blockNumber ?? null,
      // The canonical log identity of the funding event, pinned so the
      // institution emitter and the promotion verifier never have to re-guess
      // WHICH log in the tx this row's evidence is.
      fund_log_index: fundLogIndex,
      onchain_promise_id: onchainPromiseId,
      updated_at: now,
    });
  });

  // PEs for both
  const borrowerDoc = await deps.db.collection('agent_wallets').doc(doc.borrower_wallet_id).get();
  const borrower = borrowerDoc.data() as AgentWalletDocument;

  const peIds: string[] = [];
  const fundCurrency = doc.currency ?? 'usdc';
  const metadata: Record<string, unknown> = {
    promise_id: promiseId,
    currency: fundCurrency,
    tx_hash: txHash,
    // The canonical log identity this funding was verified at. `tx_hash` alone
    // is not an identity — one tx can carry several PromiseFunded events.
    chain: fundChain,
    log_index: fundLogIndex,
    onchain_promise_id: onchainPromiseId,
  };
  if (fundCurrency === 'pvt') {
    metadata.principal_pvt = doc.principal_pvt;
  } else {
    metadata.principal_usdc = doc.principal_usdc;
  }

  const { peId: borrowerPeId } = await generatePE(deps, {
    walletId: doc.borrower_wallet_id,
    agentId: borrower.agent_id,
    actorAddress: borrower.address,
    actionType: 'promise_funded',
    metadata: { ...metadata, role: 'borrower' },
    counterpartyAddress: lender.address,
  });
  peIds.push(borrowerPeId);

  const { peId: lenderPeId } = await generatePE(deps, {
    walletId: lenderWalletId,
    agentId: lender.agent_id,
    actorAddress: lender.address,
    actionType: 'promise_funded',
    metadata: { ...metadata, role: 'lender' },
    counterpartyAddress: borrower.address,
  });
  peIds.push(lenderPeId);

  if (fundCurrency === 'pvt') {
    const principalWei = BigInt(doc.principal_pvt ?? '0');
    await Promise.all([
      updateWalletStats(deps, doc.borrower_wallet_id, 'pvt', principalWei),
      updateWalletStats(deps, lenderWalletId, 'pvt', principalWei),
    ]);
  } else {
    await Promise.all([
      updateWalletStats(deps, doc.borrower_wallet_id, 'usdc', doc.principal_usdc),
      updateWalletStats(deps, lenderWalletId, 'usdc', doc.principal_usdc),
    ]);
  }

  return {
    ...doc,
    status: 'funded',
    lender_wallet_id: lenderWalletId,
    lender_address: lender.address,
    funded_at: now,
    fund_tx_hash: txHash,
    fund_block_number: fundVerification.blockNumber ?? null,
    fund_log_index: fundLogIndex,
    onchain_promise_id: onchainPromiseId,
    pe_ids: [...doc.pe_ids, ...peIds],
  };
}

export async function settlePromise(
  deps: AgentBankDeps,
  promiseId: string,
  callerWalletId: string,
  txHash: string,
): Promise<PromiseDocument> {
  const docRef = deps.db.collection('promises').doc(promiseId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Promise not found');

  const doc = snapshot.data() as PromiseDocument;
  // Settle accepts a `funded` promise OR a RELAY-OBSERVED default (addendum,
  //). The relay auto-marks a funded promise `defaulted` at its
  // deadline, but on chain it stays `Funded` and settleable, so a borrower who
  // actually repays on chain must not be stranded as a defaulter: a VERIFIED
  // on-chain PromiseSettled event (the strongest evidence there is) CURES the
  // unproven relay guess (→ settled). An on-chain-PROVEN default is terminal — its
  // on-chain promise is `Defaulted`, so a settle can't even emit and verification
  // would fail; we refuse it early here for a clear boundary.
  const isFundedForSettle = doc.status === 'funded';
  const isRelayObservedDefault = doc.status === 'defaulted' && doc.default_proof === 'relay_observed';
  if (!isFundedForSettle && !isRelayObservedDefault) {
    throw new ValidationError(`Promise status is ${doc.status}, expected funded`);
  }
  if (doc.borrower_wallet_id !== callerWalletId) {
    throw new ForbiddenError('Only the borrower can settle');
  }

  // / Stage 1a — THE SAME BAR ON THE EXIT LEG, for the same reason.
  //
  // The prior bar was a bare borrower → lender `Transfer` for the net amount.
  // Both V2 and V3 `settlePromise` do produce that Transfer (they call
  // transferFrom directly), which is exactly why it was not evidence: a plain
  // `usdc.transfer(lender, net)` produces the same log without ever calling the
  // contract. On chain the promise would stay `Funded` — still defaultable, its
  // fee never paid — while the relay marked the row `settled` and emitted a
  // `promise_settled` PE, a row whose policy disposition is `eligible`. That
  // put the weakest bar in the institution directly on the money path.
  // `verifyEvmPromiseSettlement` requires the contract's own PromiseSettled
  // event (whose emission proves the whole atomic call, fee leg included) and,
  // for rows funded after the id was pinned, that it is THIS promise.
  const settleCurrency = doc.currency ?? 'usdc';
  const settleChain = (doc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(settleChain);
  const settleContractAddress = resolvePromiseContractAddress(settleCurrency, settleChain);
  const settleVerification = await verifyEvmPromiseSettlement({
    chain: settleChain,
    settleTxHash: txHash,
    promiseContractAddress: settleContractAddress,
    expectedLender: doc.lender_address!,
    currency: settleCurrency,
    ...(doc.onchain_promise_id ? { expectedOnchainPromiseId: doc.onchain_promise_id } : {}),
    ...(settleCurrency === 'pvt'
      ? { expectedNetToLenderPvtWei: BigInt(doc.net_to_lender_pvt ?? '0') }
      : { expectedNetToLenderUsdc: doc.net_to_lender_usdc }),
  });
  if (!settleVerification.ok) {
    throw new ValidationError(`On-chain promise settlement verification failed: ${settleVerification.reason}`);
  }

  const now = Date.now();
  // Transactional flip (was a bare update): now that the sweep can concurrently
  // move a funded row to defaulted(relay_observed) and a lender can concurrently
  // prove it, re-check inside the tx. Settle wins over a fundable/relay-observed
  // state but must NEVER overwrite an on-chain-PROVEN default (terminal) — the
  // re-read refuses that case, closing the settle-vs-proven-default race.
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Promise not found');
    const freshDoc = fresh.data() as PromiseDocument;
    const freshOk = freshDoc.status === 'funded'
      || (freshDoc.status === 'defaulted' && freshDoc.default_proof === 'relay_observed');
    if (!freshOk) {
      throw new ValidationError(`Promise status is ${freshDoc.status}, expected funded`);
    }
    tx.update(docRef, {
      status: 'settled',
      settled_at: now,
      settle_tx_hash: txHash,
      settle_block_number: settleVerification.blockNumber ?? null,
      // The canonical log identity of the settlement event.
      settle_log_index: settleVerification.logIndex ?? null,
      updated_at: now,
    });
  });

  // PEs for both
  const [borrowerDoc, lenderDoc] = await Promise.all([
    deps.db.collection('agent_wallets').doc(doc.borrower_wallet_id).get(),
    deps.db.collection('agent_wallets').doc(doc.lender_wallet_id!).get(),
  ]);
  const borrower = borrowerDoc.data() as AgentWalletDocument;
  const lender = lenderDoc.data() as AgentWalletDocument;

  const peIds: string[] = [];
  const settledCurrency = doc.currency ?? 'usdc';
  const metadata: Record<string, unknown> = {
    promise_id: promiseId,
    currency: settledCurrency,
    tx_hash: txHash,
    // The canonical log identity this settlement was verified at.
    chain: settleChain,
    log_index: settleVerification.logIndex,
    onchain_promise_id: settleVerification.onchainPromiseId,
  };
  if (settledCurrency === 'pvt') {
    metadata.repay_pvt = doc.repay_pvt;
    metadata.net_to_lender_pvt = doc.net_to_lender_pvt;
    metadata.fee_pvt = doc.fee_pvt;
  } else {
    metadata.repay_usdc = doc.repay_usdc;
    metadata.net_to_lender_usdc = doc.net_to_lender_usdc;
    metadata.fee_usdc = doc.fee_usdc;
  }

  const { peId: borrowerPeId } = await generatePE(deps, {
    walletId: doc.borrower_wallet_id,
    agentId: borrower.agent_id,
    actorAddress: borrower.address,
    actionType: 'promise_settled',
    metadata: { ...metadata, role: 'borrower' },
    counterpartyAddress: lender.address,
  });
  peIds.push(borrowerPeId);

  const { peId: lenderPeId } = await generatePE(deps, {
    walletId: doc.lender_wallet_id!,
    agentId: lender.agent_id,
    actorAddress: lender.address,
    actionType: 'promise_settled',
    metadata: { ...metadata, role: 'lender' },
    counterpartyAddress: borrower.address,
  });
  peIds.push(lenderPeId);

  if (settledCurrency === 'pvt') {
    const repayWei = BigInt(doc.repay_pvt ?? '0');
    const netWei = BigInt(doc.net_to_lender_pvt ?? '0');
    await Promise.all([
      updateWalletStats(deps, doc.borrower_wallet_id, 'pvt', repayWei),
      updateWalletStats(deps, doc.lender_wallet_id!, 'pvt', netWei),
    ]);
  } else {
    await Promise.all([
      updateWalletStats(deps, doc.borrower_wallet_id, 'usdc', doc.repay_usdc),
      updateWalletStats(deps, doc.lender_wallet_id!, 'usdc', doc.net_to_lender_usdc),
    ]);
  }

  // Corroboration: promise settled confirms the promise_created PE.
  // Pass-2 #5: fetch the REAL target PE hash (was hardcoded '' which the
  // CorroborationManager falsy-guard rejected, so promise_fulfillment never
  // fired). Mirror the github-webhook fetch-then-skip-if-absent pattern; a
  // genuinely-missing target is skipped, never a valid signal suppressed (#8).
  const creationPeId = doc.pe_ids[0]; // First PE is always promise_created
  if (creationPeId) {
    void (async () => {
      const targetPeHash = await resolveTargetPeHash(deps, creationPeId);
      if (!targetPeHash) {
        console.warn(`[Promise] Corroboration skipped: no resolvable hash for target PE ${creationPeId}`);
        return;
      }
      await emitBackendCorroboration(deps, {
        targetPeId: creationPeId,
        targetPeHash,
        signalType: 'promise_fulfillment',
        // 'system', not the caller: relay-generated automated signal grounded in
        // the VERIFIED on-chain settlement (the PromiseSettled event above), and the
        // promise_created target is authored by the borrower — the settling
        // wallet. Attributing the caller would make it a self-corroboration
        // (invalid under Inv #8); the system that verified the settlement is the
        // honest attestor (mirrors the webhook 'github_app' system actor).
        corroboratingParty: 'system',
        evidence: JSON.stringify({
          promise_id: promiseId,
          currency: settledCurrency,
          ...(settledCurrency === 'pvt'
            ? { repay_pvt: doc.repay_pvt }
            : { repay_usdc: doc.repay_usdc }),
          settled_at: now,
          tx_hash: txHash,
        }),
        evidenceRef: promiseId,
        walletId: doc.borrower_wallet_id,
        agentId: borrower.agent_id,
        actorAddress: borrower.address,
      });
    })().catch((err) => console.warn('[Promise] Corroboration emit failed:', err));
  }

  return { ...doc, status: 'settled', settled_at: now, settle_tx_hash: txHash, pe_ids: [...doc.pe_ids, ...peIds] };
}

/**
 * DEFAULT a funded promise. Lender-initiated, on-chain-proven exactly as
 * fund and settle are proven by theirs: the lender calls `markDefault` on the
 * promise contract (which the contract allows only for a Funded promise past its
 * deadline+grace, moving no tokens), then reports the tx here. We re-check the
 * on-chain `PromiseDefaulted`/`PromiseDefaultedPVT` event for THIS promise id and
 * these parties before flipping the row, so the row's `defaulted` status is never
 * ahead of the chain. The borrower's reputation snapshot (`promises_defaulted`,
 * counted from this collection) then reflects it.
 *
 * The relay ALSO enforces the deadline itself (defense in depth) so the refusal
 * "cannot default before deadline" is testable at the relay boundary, not only on
 * chain.
 */
export async function defaultPromise(
  deps: AgentBankDeps,
  promiseId: string,
  lenderWalletId: string,
  txHash: string,
): Promise<PromiseDocument> {
  const docRef = deps.db.collection('promises').doc(promiseId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Promise not found');

  const doc = snapshot.data() as PromiseDocument;
  // NEVER-REGRESS + idempotent : an already on-chain-PROVEN default
  // is terminal. Return it unchanged — no re-verify, no re-emit — so a second call
  // (even carrying a different tx) can neither downgrade the proof back to
  // relay-observed nor mint a second pair of promise_defaulted PEs.
  if (doc.status === 'defaulted' && doc.default_proof === 'onchain_proven') {
    return doc;
  }
  // The on-chain-proven default accepts a `funded` promise (fresh default) OR a
  // `relay_observed` default (the sweep auto-marked it at the deadline; a lender's
  // verified markDefault now UPGRADES it to proven). Any other status is invalid.
  const isFundedForDefault = doc.status === 'funded';
  const isRelayObservedDefault = doc.status === 'defaulted' && doc.default_proof === 'relay_observed';
  if (!isFundedForDefault && !isRelayObservedDefault) {
    throw new ValidationError(`Promise status is ${doc.status}, expected funded`);
  }
  if (doc.lender_wallet_id !== lenderWalletId) {
    throw new ForbiddenError('Only the lender can mark a promise defaulted');
  }
  // RED-controllable relay-level deadline guard: a promise cannot default before
  // its deadline. The on-chain markDefault also enforces this, but checking here
  // fails a premature default fast and gives the guarantee a testable boundary.
  if (Date.now() < doc.deadline) {
    throw new ValidationError('Promise deadline has not passed; cannot default yet');
  }
  // A funded promise always pinned its on-chain id at fund time. Without it we
  // cannot bind the on-chain default to THIS row — Unknown = Block.
  if (!doc.onchain_promise_id) {
    throw new ValidationError('Promise has no on-chain identity to verify a default against');
  }
  if (!doc.lender_address) {
    throw new ValidationError('Promise has no lender address of record');
  }

  const defaultCurrency = doc.currency ?? 'usdc';
  const defaultChain = (doc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(defaultChain);
  const defaultContractAddress = resolvePromiseContractAddress(defaultCurrency, defaultChain);
  const defaultVerification = await verifyEvmPromiseDefault({
    chain: defaultChain,
    defaultTxHash: txHash,
    promiseContractAddress: defaultContractAddress,
    currency: defaultCurrency,
    expectedOnchainPromiseId: doc.onchain_promise_id,
    expectedBorrower: doc.borrower_address,
    expectedLender: doc.lender_address,
  });
  if (!defaultVerification.ok) {
    throw new ValidationError(`On-chain promise default verification failed: ${defaultVerification.reason}`);
  }

  const now = Date.now();
  // Transactional status flip so two concurrent default attempts can't both write,
  // and so the sweep's relay-observed flip and this proof land single-writer.
  //   'fresh'          — funded → defaulted (proven), sets defaulted_at.
  //   'upgrade'        — relay_observed → onchain_proven, PRESERVES defaulted_at
  //                      (the earlier observation time) and stamps default_proven_at.
  //   'already_proven' — a concurrent default proved it first; abort WITHOUT
  //                      writing or emitting (never a second PE pair).
  // The outcome is RETURNED from the transaction (not mutated through the
  // closure) so its union type survives control-flow narrowing.
  const outcome = await deps.db.runTransaction<'fresh' | 'upgrade' | 'already_proven'>(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Promise not found');
    const freshDoc = fresh.data() as PromiseDocument;
    if (freshDoc.status === 'defaulted' && freshDoc.default_proof === 'onchain_proven') {
      return 'already_proven'; // no write
    }
    const freshFunded = freshDoc.status === 'funded';
    const freshRelayObserved = freshDoc.status === 'defaulted' && freshDoc.default_proof === 'relay_observed';
    if (!freshFunded && !freshRelayObserved) {
      throw new ValidationError(`Promise status is ${freshDoc.status}, expected funded`);
    }
    tx.update(docRef, {
      status: 'defaulted',
      // Preserve the earlier relay-observation time on an upgrade; set fresh otherwise.
      ...(freshRelayObserved ? { default_proven_at: now } : { defaulted_at: now }),
      default_proof: 'onchain_proven',
      default_tx_hash: txHash,
      default_block_number: defaultVerification.blockNumber ?? null,
      default_log_index: defaultVerification.logIndex ?? null,
      updated_at: now,
    });
    return freshRelayObserved ? 'upgrade' : 'fresh';
  });

  if (outcome === 'already_proven') {
    // A concurrent lender default won the race and already emitted the PE pair.
    // Return the current proven row unchanged — never regress, never double-emit.
    const current = await docRef.get();
    return current.data() as PromiseDocument;
  }

  // PEs for both parties (the borrower's carries the negative sentiment that
  // feeds reputation; the lender's records the counterpart). Emitted exactly once
  // at proof time — a relay-observed default seals NO PE, so neither 'fresh' nor
  // 'upgrade' can produce a duplicate.
  const [borrowerDoc, lenderDoc] = await Promise.all([
    deps.db.collection('agent_wallets').doc(doc.borrower_wallet_id).get(),
    deps.db.collection('agent_wallets').doc(doc.lender_wallet_id!).get(),
  ]);
  const borrower = borrowerDoc.data() as AgentWalletDocument;
  const lender = lenderDoc.data() as AgentWalletDocument;

  const metadata: Record<string, unknown> = {
    promise_id: promiseId,
    currency: defaultCurrency,
    tx_hash: txHash,
    chain: defaultChain,
    log_index: defaultVerification.logIndex,
    onchain_promise_id: doc.onchain_promise_id,
    sentiment: 'negative',
  };
  if (defaultCurrency === 'pvt') {
    metadata.principal_pvt = doc.principal_pvt;
    metadata.repay_pvt = doc.repay_pvt;
  } else {
    metadata.principal_usdc = doc.principal_usdc;
    metadata.repay_usdc = doc.repay_usdc;
  }

  const peIds: string[] = [];
  const { peId: borrowerPeId } = await generatePE(deps, {
    walletId: doc.borrower_wallet_id,
    agentId: borrower.agent_id,
    actorAddress: borrower.address,
    actionType: 'promise_defaulted',
    metadata: { ...metadata, role: 'borrower' },
    counterpartyAddress: lender.address,
  });
  peIds.push(borrowerPeId);

  const { peId: lenderPeId } = await generatePE(deps, {
    walletId: doc.lender_wallet_id!,
    agentId: lender.agent_id,
    actorAddress: lender.address,
    actionType: 'promise_defaulted',
    metadata: { ...metadata, role: 'lender' },
    counterpartyAddress: borrower.address,
  });
  peIds.push(lenderPeId);

  // Return the AUTHORITATIVE persisted row, not `...doc` (the pre-transaction read).
  // On the sweep-vs-upgrade race — the initial read was `funded` (no defaulted_at),
  // but the sweep committed a relay_observed flip during the on-chain verify RPC, so
  // the transaction upgraded a relay_observed row — the persisted row carries the
  // sweep's `defaulted_at`, which the stale `doc` lacks. Building the return from
  // `...doc` would leave `defaulted_at` undefined and make the route's
  // `new Date(promise.defaulted_at!)` throw a spurious 500 on a call that SUCCEEDED.
  // Re-reading (mirroring the already-proven branch) returns exactly what persisted;
  // the freshly-sealed PE ids are appended for the caller as the settle path does.
  const persisted = (await docRef.get()).data() as PromiseDocument;
  return { ...persisted, pe_ids: [...persisted.pe_ids, ...peIds] };
}

/**
 * CANCEL an unfunded promise. Borrower-initiated, only while the promise
 * is still `open` (no lender, no funds moved). Purely off-chain because nothing
 * moved on-chain for an open promise (its on-chain id is not pinned until funding),
 * so there is no on-chain event to prove — the borrower simply withdraws their own
 * unfunded offer. A funded promise can NEVER be cancelled (only settled/defaulted).
 *
 * NO PE is sealed: the `promise_created` PE already recorded the offer, and
 * cancelling an UNFUNDED offer moves no value, so it carries no mint or reputation
 * weight. (Adding a `promise_cancelled` PE action type would require a change to
 * the FROZEN action-policy matrix — out of scope here — and would earn nothing
 * regardless.) The withdrawal is surfaced by the outbox `promise_cancelled` event
 * the route enqueues.
 */
export async function cancelPromise(
  deps: AgentBankDeps,
  promiseId: string,
  borrowerWalletId: string,
): Promise<PromiseDocument> {
  const docRef = deps.db.collection('promises').doc(promiseId);
  const now = Date.now();
  let doc!: PromiseDocument;
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Promise not found');
    doc = fresh.data() as PromiseDocument;
    if (doc.status !== 'open') {
      throw new ValidationError(`Promise status is ${doc.status}, expected open`);
    }
    if (doc.borrower_wallet_id !== borrowerWalletId) {
      throw new ForbiddenError('Only the borrower can cancel their promise');
    }
    tx.update(docRef, { status: 'cancelled', cancelled_at: now, updated_at: now });
  });

  return { ...doc, status: 'cancelled', cancelled_at: now };
}

export async function getPromise(
  deps: AgentBankDeps,
  promiseId: string,
): Promise<PromiseDocument> {
  const snapshot = await deps.db.collection('promises').doc(promiseId).get();
  if (!snapshot.exists) throw new NotFoundError('Promise not found');
  return snapshot.data() as PromiseDocument;
}

/**
 * A promise document for marketplace responses. the borrower governance
 * join is gone — no marketplace filter or sort reads a governance signal — so a
 * marketplace promise is just the promise document.
 */
export type MarketplacePromise = PromiseDocument;

export async function getMarketplace(
  deps: AgentBankDeps,
  options: {
    max_amount?: number;
    sort?: string;
    page?: number;
    limit?: number;
  },
): Promise<{ promises: MarketplacePromise[]; total: number }> {
  const limit = Math.min(options.limit || 20, 100);
  const page = options.page || 1;

  const query = deps.db.collection('promises')
    .where('status', '==', 'open')
    .orderBy('created_at', 'desc');

  const snapshot = await query.get();
  let results: MarketplacePromise[] = snapshot.docs.map(d => d.data() as PromiseDocument);

  // Apply client-side filters (Firestore has limited query capabilities)
  if (options.max_amount !== undefined) {
    // Workstream 2: max_amount filters USDC promises by principal_usdc.
    // PVT promises bypass this filter (different currency dimension -
    // a PVT-amount filter belongs in a separate `max_amount_pvt` param,
    // deferred to Phase 2 of the marketplace).
    results = results.filter(p => (p.currency ?? 'usdc') !== 'usdc' || p.principal_usdc <= options.max_amount!);
  }

  // Sort
  if (options.sort === 'rate_asc') {
    // Implied APR sort. USDC and PVT use their respective fields; PVT promises
    // with zero/missing principal sort last to avoid divide-by-zero.
    const impliedRate = (p: PromiseDocument): number => {
      if ((p.currency ?? 'usdc') === 'pvt') {
        const principal = BigInt(p.principal_pvt ?? '0');
        if (principal === 0n) return Number.POSITIVE_INFINITY;
        const repay = BigInt(p.repay_pvt ?? '0');
        // (repay - principal) / principal as a float - fine since this is a
        // sort key, not a settlement amount, so float precision is acceptable.
        return Number(repay - principal) / Number(principal);
      }
      if (p.principal_usdc === 0) return Number.POSITIVE_INFINITY;
      return (p.repay_usdc - p.principal_usdc) / p.principal_usdc;
    };
    results.sort((a, b) => impliedRate(a) - impliedRate(b));
  }

  const total = results.length;
  const paginated = results.slice((page - 1) * limit, page * limit);

  return { promises: paginated, total };
}

export async function getWalletPromises(
  deps: AgentBankDeps,
  walletId: string,
  limit: number = 50,
): Promise<PromiseDocument[]> {
  const [asBorrower, asLender] = await Promise.all([
    deps.db.collection('promises')
      .where('borrower_wallet_id', '==', walletId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get(),
    deps.db.collection('promises')
      .where('lender_wallet_id', '==', walletId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get(),
  ]);

  const all = [
    ...asBorrower.docs.map(d => d.data() as PromiseDocument),
    ...asLender.docs.map(d => d.data() as PromiseDocument),
  ];

  const seen = new Set<string>();
  return all
    .filter(p => {
      if (seen.has(p.promise_id)) return false;
      seen.add(p.promise_id);
      return true;
    })
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}
