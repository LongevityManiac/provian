/**
 * Agent Bank - Capital Pool Business Logic
 *
 * Collective funding pools for shared resources. Smart contract holds
 * all contributions. Admin can ONLY execute (to target) or refund
 * (pro-rata to original contributors).
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import {
  SAFETY_LIMITS,
  parsePvtWei,
  type AgentBankDeps,
  type CreatePoolRequest,
  type Currency,
  type PoolDocument,
  type PoolContribution,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { ValidationError, NotFoundError, ForbiddenError } from './errors';
import {
  verifyEvmContractCall,
  verifyEvmPoolContribution,
  verifyEvmPoolWithdrawal,
  recoverPoolIdFromContributionTx,
} from '../onchain/tx-verifier';
import { isPvtPrincipalEnabledForChain } from './pvt-principal-config';
import { updateWalletStats } from './wallet-stats';
import {
  assertSupportedAgentBankChain,
  chainIdForName,
  poolUsdcAddressForChain,
  poolV3AddressForChain,
  requireAddressOrThrow,
  type AgentBankChain,
} from './chain-registry';

import { generatePE } from './pe-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the pool contract address for a given currency and chain.
 * USDC routes to V2 (`POOL_V2_CONTRACT_ADDRESS_<CHAIN>` or legacy
 * `POOL_V2_CONTRACT_ADDRESS` / `POOL_CONTRACT_ADDRESS`). PVT routes to V3
 * (`POOL_V3_CONTRACT_ADDRESS_<CHAIN>` or legacy `POOL_V3_CONTRACT_ADDRESS`,
 * only when ENABLE_PVT_PRINCIPAL=true).
 *
 * Wave J-bis: chain-aware resolver. Single-chain deployments keep working
 * via the legacy single-valued env var fallback in chain-registry.
 */
export function resolvePoolContractAddress(currency: Currency, chain: AgentBankChain): string {
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(chain)) {
      throw new ValidationError(`PVT-principal pools are not enabled for chain '${chain}' on this relay`);
    }
    return requireAddressOrThrow(poolV3AddressForChain(chain), 'POOL_V3', chain);
  }
  return requireAddressOrThrow(poolUsdcAddressForChain(chain), 'POOL', chain);
}

// ---------------------------------------------------------------------------
// Pool operations
// ---------------------------------------------------------------------------

export async function createPool(
  deps: AgentBankDeps,
  body: CreatePoolRequest,
): Promise<PoolDocument> {
  // --- Currency routing ---
  const currency: Currency = body.currency ?? 'usdc';
  if (currency !== 'usdc' && currency !== 'pvt') {
    throw new ValidationError(`currency must be 'usdc' or 'pvt' (got ${String(currency)})`);
  }
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(body.chain ?? 'base')) {
      throw new ValidationError(`PVT-principal pools are not enabled for chain '${body.chain ?? 'base'}' on this relay`);
    }
  }

  // --- Currency-specific threshold validation + fee calculation ---
  let thresholdUsdc = 0;
  let feeUsdc = 0;
  let netToTargetUsdc = 0;
  let thresholdPvtWei: bigint = 0n;
  let feePvtWei: bigint = 0n;
  let netToTargetPvtWei: bigint = 0n;

  if (currency === 'usdc') {
    if (body.threshold_usdc === undefined) {
      throw new ValidationError('threshold_usdc is required when currency is usdc');
    }
    // F39 (guard extension): reject a non-number / non-finite threshold
    // BEFORE the range check (`undefined <= 0` / `"50" <= 0` coerce to false), so
    // a string/NaN threshold can never persist.
    if (typeof body.threshold_usdc !== 'number' || !Number.isFinite(body.threshold_usdc)) {
      throw new ValidationError('threshold_usdc must be a finite number');
    }
    if (body.threshold_usdc <= 0 || body.threshold_usdc > SAFETY_LIMITS.MAX_POOL_THRESHOLD_USD) {
      throw new ValidationError(`threshold_usdc must be between 0 and ${SAFETY_LIMITS.MAX_POOL_THRESHOLD_USD}`);
    }
    thresholdUsdc = body.threshold_usdc;
    feeUsdc = Math.round(thresholdUsdc * 0.005 * 1_000_000) / 1_000_000;
    netToTargetUsdc = Math.round((thresholdUsdc - feeUsdc) * 1_000_000) / 1_000_000;
  } else {
    if (body.threshold_pvt === undefined) {
      throw new ValidationError('threshold_pvt is required when currency is pvt');
    }
    try {
      thresholdPvtWei = parsePvtWei(body.threshold_pvt);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    const maxPvtWei = BigInt(SAFETY_LIMITS.MAX_POOL_THRESHOLD_USD) * (10n ** 18n);
    if (thresholdPvtWei > maxPvtWei) {
      throw new ValidationError(
        `threshold_pvt must be ≤ ${SAFETY_LIMITS.MAX_POOL_THRESHOLD_USD} PVT (atomic ≤ ${maxPvtWei.toString()})`,
      );
    }
    // 0.5% fee in PVT atomic units.
    feePvtWei = (thresholdPvtWei * 5n) / 1000n;
    netToTargetPvtWei = thresholdPvtWei - feePvtWei;
  }

  // F39 (guard extension): reject non-finite deadline_hours before the
  // range check and before `now + body.deadline_hours * …` (a NaN deadline the
  // scheduler never expires).
  if (typeof body.deadline_hours !== 'number' || !Number.isFinite(body.deadline_hours)) {
    throw new ValidationError('deadline_hours must be a finite number');
  }
  if (body.deadline_hours <= 0 || body.deadline_hours > SAFETY_LIMITS.MAX_POOL_DEADLINE_HOURS) {
    throw new ValidationError(`deadline_hours must be between 1 and ${SAFETY_LIMITS.MAX_POOL_DEADLINE_HOURS}`);
  }
  if (!body.target_address || !/^0x[a-fA-F0-9]{40}$/.test(body.target_address)) {
    throw new ValidationError('target_address must be a valid EVM address');
  }
  if (!body.target_description || body.target_description.length > 1000) {
    throw new ValidationError('target_description is required (max 1000 chars)');
  }
  // F39 (guard extension): max_contributors must be a positive integer.
  // A bare `< 2 || > MAX` coerces `"abc"`/undefined to false, so a non-numeric
  // value persists and the `existingContributors >= pool.max_contributors` cap
  // is then always false (unbounded contributors).
  if (typeof body.max_contributors !== 'number' || !Number.isInteger(body.max_contributors)) {
    throw new ValidationError('max_contributors must be an integer');
  }
  if (body.max_contributors < 2 || body.max_contributors > SAFETY_LIMITS.MAX_POOL_CONTRIBUTORS) {
    throw new ValidationError(`max_contributors must be between 2 and ${SAFETY_LIMITS.MAX_POOL_CONTRIBUTORS}`);
  }
  // Wave J-bis: accept any chain in SUPPORTED_AGENT_BANK_CHAINS (Base/Arb/Op).
  assertSupportedAgentBankChain(body.chain);

  // --- Look up creator ---
  const creatorDoc = await deps.db.collection('agent_wallets').doc(body.creator_wallet_id).get();
  if (!creatorDoc.exists) throw new NotFoundError('Creator wallet not found');
  const creator = creatorDoc.data() as AgentWalletDocument;

  const now = Date.now();
  const poolId = `pool_${uuidv4()}`;
  const deadline = now + body.deadline_hours * 60 * 60 * 1000;

  const doc: PoolDocument = {
    pool_id: poolId,
    creator_wallet_id: body.creator_wallet_id,
    creator_address: creator.address,
    target_address: body.target_address,
    target_description: body.target_description,
    currency,
    threshold_usdc: thresholdUsdc,
    fee_usdc: feeUsdc,
    net_to_target_usdc: netToTargetUsdc,
    total_contributed_usdc: 0,
    max_contributors: body.max_contributors,
    chain: body.chain,
    deadline,
    status: 'open',
    contributions: {},
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };
  if (currency === 'pvt') {
    doc.threshold_pvt = thresholdPvtWei.toString();
    doc.fee_pvt = feePvtWei.toString();
    doc.net_to_target_pvt = netToTargetPvtWei.toString();
    doc.total_contributed_pvt = '0';
  }

  await deps.db.collection('pools').doc(poolId).set(doc);

  // PE for creator
  const peMetadata: Record<string, unknown> = {
    pool_id: poolId,
    target_address: body.target_address,
    currency,
    deadline_hours: body.deadline_hours,
    target_description: body.target_description,
  };
  if (currency === 'pvt') {
    peMetadata.threshold_pvt = thresholdPvtWei.toString();
  } else {
    peMetadata.threshold_usdc = thresholdUsdc;
  }

  const { peId } = await generatePE(deps, {
    walletId: body.creator_wallet_id,
    agentId: creator.agent_id,
    actorAddress: creator.address,
    actionType: 'pool_created',
    metadata: peMetadata,
  });

  doc.pe_ids = [peId];
  await deps.db.collection('pools').doc(poolId).update({ pe_ids: [peId] });

  return doc;
}

/**
 * Contribute to a pool. The amount currency is dictated by the pool -
 * `amountUsdc` is required for USDC pools, `amountPvtWei` for PVT pools.
 * Sending the wrong field for the pool's currency throws ValidationError.
 */
export async function contribute(
  deps: AgentBankDeps,
  poolId: string,
  contributorWalletId: string,
  amount: { amountUsdc?: number; amountPvtWei?: bigint },
  txHash: string,
): Promise<PoolDocument> {
  const docRef = deps.db.collection('pools').doc(poolId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Pool not found');

  const initialDoc = snapshot.data() as PoolDocument;
  if (initialDoc.status !== 'open') {
    throw new ValidationError(`Pool status is ${initialDoc.status}, expected open`);
  }

  const poolCurrency = initialDoc.currency ?? 'usdc';

  // Currency-specific amount validation.
  let amountUsdc = 0;
  let amountPvtWei: bigint = 0n;
  if (poolCurrency === 'usdc') {
    if (amount.amountUsdc === undefined || amount.amountUsdc <= 0) {
      throw new ValidationError('amount_usdc must be > 0 for USDC pool');
    }
    amountUsdc = amount.amountUsdc;
  } else {
    if (amount.amountPvtWei === undefined || amount.amountPvtWei <= 0n) {
      throw new ValidationError('amount_pvt must be > 0 for PVT pool');
    }
    amountPvtWei = amount.amountPvtWei;
  }

  const contributorDoc = await deps.db.collection('agent_wallets').doc(contributorWalletId).get();
  if (!contributorDoc.exists) throw new NotFoundError('Contributor wallet not found');
  const contributor = contributorDoc.data() as AgentWalletDocument;

  // Phase 2.9 - Theme 3 + P4 entry-side: verify the contributor made a REAL
  // on-chain `contribute(poolId, amount)` — i.e. a PoolContribution event crediting
  // this contributor for this amount, emitted by the pool contract — NOT merely a
  // bare ERC-20 transfer into the contract (which moves funds the contract never
  // credits to contributorList, so they can't be withdrawn or refunded). This
  // recovers the on-chain bytes32 poolId, which we bind to the Firestore pool below
  // so every recorded contributor is a real on-chain contributor of the same pool.
  const contribChain = (initialDoc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(contribChain);
  const poolContractAddress = resolvePoolContractAddress(poolCurrency, contribChain);
  const contribVerification = await verifyEvmPoolContribution({
    chainId: chainIdForName(contribChain),
    txHash,
    poolContractAddress,
    expectedContributor: contributor.address,
    currency: poolCurrency,
    ...(poolCurrency === 'pvt'
      ? { expectedAmountPvtWei: amountPvtWei }
      : { expectedAmountUsdc: amountUsdc }),
  });
  if (!contribVerification.ok || !contribVerification.poolId) {
    throw new ValidationError(`On-chain pool contribution verification failed: ${contribVerification.reason ?? 'no_pool_id'}`);
  }
  const contributedOnchainPoolId = contribVerification.poolId;

  // Phase 2.13 - Theme 8: read-modify-write of pool totals must run inside
  // a Firestore transaction so concurrent contributions don't lose updates.
  const now = Date.now();
  let updatedDoc!: PoolDocument;
  let updatedContribution!: PoolContribution;

  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new NotFoundError('Pool not found');
    const pool = fresh.data() as PoolDocument;

    if (pool.status !== 'open') {
      throw new ValidationError(`Pool status is ${pool.status}, expected open`);
    }

    const existingContributors = Object.keys(pool.contributions).length;
    const isNewContributor = !pool.contributions[contributorWalletId];
    if (isNewContributor && existingContributors >= pool.max_contributors) {
      throw new ValidationError(`Pool has reached maximum of ${pool.max_contributors} contributors`);
    }

    const existingContribution = pool.contributions[contributorWalletId];

    // Bind (or enforce) the pool's on-chain poolId. The first real contributor
    // establishes it; every later contributor's on-chain `contribute` MUST target
    // the same poolId — otherwise it funded a DIFFERENT on-chain pool that
    // `refundPool(thisPoolId)` / `withdrawContribution(thisPoolId)` would never
    // return. Setting it inside the transaction closes the concurrent-first-contributor race.
    if (pool.onchain_pool_id && pool.onchain_pool_id !== contributedOnchainPoolId) {
      throw new ValidationError(
        `Contribution on-chain poolId ${contributedOnchainPoolId} does not match this pool's bound on-chain poolId ${pool.onchain_pool_id}`,
      );
    }
    const bindPoolId: Record<string, unknown> = pool.onchain_pool_id
      ? {}
      : { onchain_pool_id: contributedOnchainPoolId };
    const boundOnchainPoolId = pool.onchain_pool_id ?? contributedOnchainPoolId;

    if (poolCurrency === 'pvt') {
      const newTotalWei = BigInt(pool.total_contributed_pvt ?? '0') + amountPvtWei;
      const thresholdWei = BigInt(pool.threshold_pvt ?? '0');
      const newStatus = newTotalWei >= thresholdWei ? 'funded' : 'open';

      const existingPvt = BigInt(existingContribution?.amount_pvt ?? '0');
      updatedContribution = {
        address: contributor.address,
        amount_usdc: 0,
        amount_pvt: (existingPvt + amountPvtWei).toString(),
        contributed_at: now,
        tx_hash: txHash,
      };

      tx.update(docRef, {
        [`contributions.${contributorWalletId}`]: updatedContribution,
        total_contributed_pvt: newTotalWei.toString(),
        status: newStatus,
        ...bindPoolId,
        updated_at: now,
      });

      updatedDoc = {
        ...pool,
        onchain_pool_id: boundOnchainPoolId,
        contributions: { ...pool.contributions, [contributorWalletId]: updatedContribution },
        total_contributed_pvt: newTotalWei.toString(),
        status: newStatus as PoolDocument['status'],
      };
    } else {
      const newTotal = pool.total_contributed_usdc + amountUsdc;
      const newStatus = newTotal >= pool.threshold_usdc ? 'funded' : 'open';

      updatedContribution = {
        address: contributor.address,
        amount_usdc: (existingContribution?.amount_usdc || 0) + amountUsdc,
        contributed_at: now,
        tx_hash: txHash,
      };

      tx.update(docRef, {
        [`contributions.${contributorWalletId}`]: updatedContribution,
        total_contributed_usdc: newTotal,
        status: newStatus,
        ...bindPoolId,
        updated_at: now,
      });

      updatedDoc = {
        ...pool,
        onchain_pool_id: boundOnchainPoolId,
        contributions: { ...pool.contributions, [contributorWalletId]: updatedContribution },
        total_contributed_usdc: newTotal,
        status: newStatus as PoolDocument['status'],
      };
    }
  });

  // PE generation outside the transaction.
  const peMetadata: Record<string, unknown> = {
    pool_id: poolId,
    currency: poolCurrency,
    tx_hash: txHash,
  };
  if (poolCurrency === 'pvt') {
    peMetadata.amount_pvt = amountPvtWei.toString();
    peMetadata.total_contributed_pvt = updatedDoc.total_contributed_pvt;
  } else {
    peMetadata.amount_usdc = amountUsdc;
    peMetadata.total_contributed_usdc = updatedDoc.total_contributed_usdc;
  }

  const { peId } = await generatePE(deps, {
    walletId: contributorWalletId,
    agentId: contributor.agent_id,
    actorAddress: contributor.address,
    actionType: 'pool_contributed',
    metadata: peMetadata,
  });

  if (poolCurrency === 'pvt') {
    await updateWalletStats(deps, contributorWalletId, 'pvt', amountPvtWei);
  } else {
    await updateWalletStats(deps, contributorWalletId, 'usdc', amountUsdc);
  }

  return {
    ...updatedDoc,
    pe_ids: [...updatedDoc.pe_ids, peId],
  };
}

export async function executePool(
  deps: AgentBankDeps,
  poolId: string,
  callerWalletId: string,
  txHash: string,
  isAdmin: boolean = false,
): Promise<PoolDocument> {
  const docRef = deps.db.collection('pools').doc(poolId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Pool not found');

  const doc = snapshot.data() as PoolDocument;
  if (doc.status !== 'funded') {
    throw new ValidationError(`Pool status is ${doc.status}, expected funded`);
  }

  // Only creator or admin. Admin status is now passed explicitly via the
  // isAdmin flag instead of inferred from a magic callerWalletId. Prevents
  // a future internal wallet ID shape colliding with the previous
  // '_admin' sentinel from accidentally elevating to admin powers.
  if (!isAdmin && doc.creator_wallet_id !== callerWalletId) {
    throw new ForbiddenError('Only the creator or admin can execute the pool');
  }

  // Phase 2.9 - Theme 3: verify the execution tx targeted the right pool
  // contract (V2 for USDC, V3 for PVT) and succeeded.
  // Wave J-bis: chain-aware - derive chainId from doc.chain instead of
  // the legacy hardcoded 8453.
  const executeCurrency = doc.currency ?? 'usdc';
  const executeChain = (doc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(executeChain);
  const poolContractAddress = resolvePoolContractAddress(executeCurrency, executeChain);
  const execVerification = await verifyEvmContractCall({
    chainId: chainIdForName(executeChain),
    txHash,
    expectedContract: poolContractAddress,
  });
  if (!execVerification.ok) {
    throw new ValidationError(`On-chain pool execution verification failed: ${execVerification.reason}`);
  }

  const now = Date.now();
  await docRef.update({
    status: 'executed',
    executed_at: now,
    execute_tx_hash: txHash,
    execute_block_number: execVerification.blockNumber ?? null,
    updated_at: now,
  });

  // PEs for all contributors, currency-aware.
  const peIds: string[] = [];
  for (const [walletId, contribution] of Object.entries(doc.contributions)) {
    const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
    if (!walletDoc.exists) continue;
    const wallet = walletDoc.data() as AgentWalletDocument;

    const peMetadata: Record<string, unknown> = {
      pool_id: poolId,
      currency: executeCurrency,
      tx_hash: txHash,
    };
    if (executeCurrency === 'pvt') {
      peMetadata.contributed_pvt = contribution.amount_pvt ?? '0';
      peMetadata.threshold_pvt = doc.threshold_pvt;
      peMetadata.net_to_target_pvt = doc.net_to_target_pvt;
    } else {
      peMetadata.contributed_usdc = contribution.amount_usdc;
      peMetadata.threshold_usdc = doc.threshold_usdc;
      peMetadata.net_to_target_usdc = doc.net_to_target_usdc;
    }

    const { peId } = await generatePE(deps, {
      walletId,
      agentId: wallet.agent_id,
      actorAddress: wallet.address,
      actionType: 'pool_executed',
      metadata: peMetadata,
    });
    peIds.push(peId);

    if (executeCurrency === 'pvt') {
      const wei = BigInt(contribution.amount_pvt ?? '0');
      await updateWalletStats(deps, walletId, 'pvt', wei);
    } else {
      await updateWalletStats(deps, walletId, 'usdc', contribution.amount_usdc);
    }
  }

  return { ...doc, status: 'executed', executed_at: now, execute_tx_hash: txHash, pe_ids: [...doc.pe_ids, ...peIds] };
}

/**
 * Contributor withdraws their contribution from an Open pool (P4-01).
 *
 * The on-chain `ProvianPool.withdrawContribution(bytes32)` is `msg.sender`-bound —
 * only the contributor's OWN key can pull their funds, so (unlike the expiry
 * refund) NO backend keeper can do it on their behalf. The withdraw is therefore
 * agent-signed + backend-verified, the exact contribute/execute tx_hash model:
 * the caller broadcasts the on-chain withdrawal and passes its `txHash`; the relay
 * confirms the on-chain `PoolWithdrawal` event (contributor + amount, bound to the
 * pool's on-chain poolId when recoverable) BEFORE deleting the Firestore
 * contribution or emitting a `pool_withdrawn` PE. Fails closed (funds untouched in
 * Firestore, no PE) if the on-chain withdrawal cannot be verified — no PE ever
 * claims a withdrawal that didn't happen on-chain.
 */
export async function withdrawContribution(
  deps: AgentBankDeps,
  poolId: string,
  contributorWalletId: string,
  txHash: string,
): Promise<PoolDocument> {
  if (!txHash || typeof txHash !== 'string') {
    throw new ValidationError('tx_hash of the on-chain withdrawContribution is required');
  }

  const docRef = deps.db.collection('pools').doc(poolId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new NotFoundError('Pool not found');

  const doc = snapshot.data() as PoolDocument;
  if (doc.status !== 'open') {
    throw new ValidationError(`Pool status is ${doc.status}, expected open`);
  }

  const contribution = doc.contributions[contributorWalletId];
  if (!contribution) {
    throw new ValidationError('No contribution found for this wallet');
  }

  const withdrawCurrency = doc.currency ?? 'usdc';
  const withdrawChain = (doc.chain || 'base') as AgentBankChain;
  assertSupportedAgentBankChain(withdrawChain);
  const poolContractAddress = resolvePoolContractAddress(withdrawCurrency, withdrawChain);
  const chainId = chainIdForName(withdrawChain);

  // Bind the withdrawal to THIS pool's on-chain bytes32 poolId so a same-contract
  // withdrawal from a different pool for the same amount cannot satisfy this exit.
  // Prefer the pool's stored, entry-verified onchain_pool_id (authoritative); fall
  // back to recovering it from the contributor's own contribution tx for legacy
  // pools created before entry-side binding. When neither yields an id (legacy /
  // RPC), verification still requires the on-chain PoolWithdrawal event to match
  // this contributor + amount on this pool contract.
  const expectedPoolId =
    doc.onchain_pool_id ??
    (await recoverPoolIdFromContributionTx({
      chainId,
      poolContractAddress,
      txHash: contribution.tx_hash,
      expectedContributor: contribution.address,
    })) ??
    undefined;

  const withdrawVerification = await verifyEvmPoolWithdrawal({
    chainId,
    txHash,
    poolContractAddress,
    expectedContributor: contribution.address,
    currency: withdrawCurrency,
    ...(withdrawCurrency === 'pvt'
      ? { expectedAmountPvtWei: BigInt(contribution.amount_pvt ?? '0') }
      : { expectedAmountUsdc: contribution.amount_usdc }),
    ...(expectedPoolId ? { expectedPoolId } : {}),
  });
  if (!withdrawVerification.ok) {
    throw new ValidationError(`On-chain pool withdrawal verification failed: ${withdrawVerification.reason}`);
  }

  const contributorDoc = await deps.db.collection('agent_wallets').doc(contributorWalletId).get();
  if (!contributorDoc.exists) throw new NotFoundError('Contributor wallet not found');
  const contributor = contributorDoc.data() as AgentWalletDocument;

  const now = Date.now();
  const { FieldValue } = await import('firebase-admin/firestore');

  let updatedDoc: PoolDocument;
  if (withdrawCurrency === 'pvt') {
    const contribWei = BigInt(contribution.amount_pvt ?? '0');
    const totalWei = BigInt(doc.total_contributed_pvt ?? '0');
    const newTotalWei = totalWei - contribWei;
    await docRef.update({
      [`contributions.${contributorWalletId}`]: FieldValue.delete(),
      total_contributed_pvt: newTotalWei.toString(),
      updated_at: now,
    });
    const newContributions = { ...doc.contributions };
    delete newContributions[contributorWalletId];
    updatedDoc = {
      ...doc,
      contributions: newContributions,
      total_contributed_pvt: newTotalWei.toString(),
    };
  } else {
    await docRef.update({
      [`contributions.${contributorWalletId}`]: FieldValue.delete(),
      total_contributed_usdc: doc.total_contributed_usdc - contribution.amount_usdc,
      updated_at: now,
    });
    const newContributions = { ...doc.contributions };
    delete newContributions[contributorWalletId];
    updatedDoc = {
      ...doc,
      contributions: newContributions,
      total_contributed_usdc: doc.total_contributed_usdc - contribution.amount_usdc,
    };
  }

  // Emit a verified pool_withdrawn PE (on-chain confirmed above), currency-aware.
  const peMetadata: Record<string, unknown> = {
    pool_id: poolId,
    currency: withdrawCurrency,
    tx_hash: txHash,
    onchain_withdraw_confirmed: true,
  };
  if (withdrawCurrency === 'pvt') {
    peMetadata.withdrawn_pvt = contribution.amount_pvt ?? '0';
  } else {
    peMetadata.withdrawn_usdc = contribution.amount_usdc;
  }

  const { peId } = await generatePE(deps, {
    walletId: contributorWalletId,
    agentId: contributor.agent_id,
    actorAddress: contributor.address,
    actionType: 'pool_withdrawn',
    metadata: peMetadata,
  });

  return { ...updatedDoc, pe_ids: [...updatedDoc.pe_ids, peId] };
}

export async function getPool(
  deps: AgentBankDeps,
  poolId: string,
): Promise<PoolDocument> {
  const snapshot = await deps.db.collection('pools').doc(poolId).get();
  if (!snapshot.exists) throw new NotFoundError('Pool not found');
  return snapshot.data() as PoolDocument;
}

export async function getActivePools(
  deps: AgentBankDeps,
  limit: number = 50,
): Promise<PoolDocument[]> {
  const snapshot = await deps.db.collection('pools')
    .where('status', '==', 'open')
    .orderBy('created_at', 'desc')
    .limit(Math.min(limit, 100))
    .get();

  return snapshot.docs.map(d => d.data() as PoolDocument);
}

export async function getWalletPools(
  deps: AgentBankDeps,
  walletId: string,
  limit: number = 50,
): Promise<PoolDocument[]> {
  // Pools where the wallet is creator
  const asCreator = await deps.db.collection('pools')
    .where('creator_wallet_id', '==', walletId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  return asCreator.docs.map(d => d.data() as PoolDocument);
}
