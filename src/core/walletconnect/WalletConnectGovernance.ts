import type { BiometricAction } from '../security/biometricAction';
/**
 * WalletConnectGovernance — route the HUMAN WalletConnect signing path through
 * the crypto-spending governance pipeline (CLAUDE.md pitfall #13). Since
 * this is the pipeline's only caller: there is no agent-initiated device
 * signing.
 *
 * Until now the WalletConnect path gated only on a biometric session and wrote
 * a hardcoded `policyDecision: 'allow'` PE. The decoders (decodeCalldata /
 * decodeTypedData) already extract the *economic effect* of a request; this
 * module maps that effect onto `evaluateCryptoTransaction()` so the owner's own
 * transactions and gasless approvals get policy spend-limits, friction lanes,
 * biometric stays IN ADDITION, never replaced.
 *
 * WHOSE POLICY? WalletConnect is the wallet owner's own wallet. So we run a
 * synthetic **wallet-owner self-policy** a SpendingPolicy that is deliberately
 * NOT registered with SpendingPolicyManager (so it accrues no usage state), with neutral category/merchant/schedule
 * controls and very high base limits. The *real* owner controls live in the
 * crypto-spending controls derived from the owner's WalletConnectGovernanceSettings.
 *
 * SECURITY POSTURE (defaults, owner-tunable in Settings):
 * - Token approvals always require hard_confirm (requireApprovalConfirm).
 * - UNLIMITED approvals / permits are BLOCKED by default (top drain vector).
 * - UNKNOWN / undecodable contract calls require hard_confirm (the human is the
 * authority and can proceed, but never silently). This maps
 * "Unknown = Block" to the strongest human confirmation rather than a hard
 * block that would make novel dApps unusable.
 * - Friction lanes ONLY escalate, never de-escalate (Security Invariant #12).
 *
 * USD CAPS — HONEST SCOPE: the governance pipeline is USD-denominated, but the
 * device has no price oracle. We can only derive a reliable USD figure for
 * pegged stablecoins (USDC/USDT/DAI/USDC.e). For every other token and for
 * native value we pass amount 0, so the per-tx / daily USD caps apply to
 * stablecoin-denominated value and to unlimited approvals (forced block); other
 * assets are governed by classification + approval rules + biometric, not the
 * USD cap. Caps are disabled (0) by default so the owner is never surprised.
 */

import { FrictionLane, SpendingPolicy } from '../crypto-governance/types';
import { AgentSpendRequest, AgentSpendActionType } from '../crypto-governance/spendRequest';
import {
    evaluateCryptoTransaction,
    CryptoSpendingControls,
    CryptoGovernanceResult,
} from '../crypto-governance/CryptoSpendingGovernance';
import {
    CryptoTransactionInput,
    CryptoTransactionCategory,
} from '../crypto-governance/CryptoTransactionClassifier';
import { decodeTransactionCall, DecodedCall } from './decodeCalldata';
import { DecodedPermit } from './decodeTypedData';
import type { WalletConnectGovernanceSettings } from './governanceSettings';

// Re-export the owner settings shape + defaults (canonical home is
// ./governanceSettings, kept dependency-free for walletStore).
export type { WalletConnectGovernanceSettings } from './governanceSettings';
export { DEFAULT_WC_GOVERNANCE_SETTINGS } from './governanceSettings';

// ============================================================================
// VERDICT
// ============================================================================

/**
 * Thrown by the WalletConnectService at execution time when governance denies a
 * signing request (policy block). Carries the verdict so the UI can render a
 * precise deny reason instead of a generic error.
 */
export class WalletConnectPolicyError extends Error {
    readonly verdict: WalletConnectVerdict;
    constructor(message: string, verdict: WalletConnectVerdict) {
        super(message);
        this.name = 'WalletConnectPolicyError';
        this.verdict = verdict;
    }
}

export interface WalletConnectVerdict {
    /** Final friction lane after governance + escalation. */
    lane: FrictionLane;
    /** false ⇔ lane === 'block'. */
    allowed: boolean;
    /** true when the modal must demand the strong "I UNDERSTAND" + cooling confirm. */
    requiresStrongConfirm: boolean;
    /** 0–100 risk score for the Provenance Envelope. */
    riskScore: number;
    /** Coarse risk category for the Provenance Envelope. */
    riskCategory: 'low' | 'medium' | 'high';
    /** Transaction classification (for the PE + UI). */
    category: CryptoTransactionCategory;
    /** Human-readable reasons / warnings. */
    reasons: string[];
    /** Primary reason shown when blocked. */
    denyReason?: string;
    /**
     * USD value the governance priced for this request (stablecoins only; 0 for
     * unpriced/unlimited). WS5: the execution path records this into the daily
     * spend accumulator after a successful send so the daily cap accumulates.
     */
    amountUsd: number;
}

// ============================================================================
// SYNTHETIC WALLET-OWNER POLICY
// ============================================================================

const MAX = Number.MAX_SAFE_INTEGER;

/**
 * Stablecoins we treat as ≈ $1 for USD-cap purposes. Anything else is
 * unpriceable on-device and contributes 0 to the USD cap checks.
 */
const STABLE_USD_SYMBOLS = new Set(['USDC', 'USDC.e', 'USDT', 'DAI']);

const LANE_ORDER: FrictionLane[] = ['auto_approve', 'soft_confirm', 'hard_confirm', 'block'];

/**
 * The wallet-owner self-policy. Deliberately NOT registered with
 * SpendingPolicyManager (id is unique to this module) so it accrues no
 * usage and getCurrentUsage/getRemainingLimits resolve to zero. Base limits are
 * effectively unbounded — the owner's real caps live in the crypto controls.
 * Friction thresholds keep ordinary owner transfers at biometric-only and let
 * the crypto-classification layer drive the dangerous-pattern escalations.
 */
const OWNER_POLICY: SpendingPolicy = {
    id: 'walletconnect-owner-self-policy',
    agentId: 'wallet-owner',
    name: 'WalletConnect Owner Self-Policy',
    limits: { perTransaction: MAX, daily: MAX, weekly: MAX, monthly: MAX },
    categories: { allowed: [], blocked: [], mode: 'blocklist' },
    merchants: { allowlist: [], blocklist: [], mode: 'any' },
    rails: { allowedCredentialIds: [] },
    schedule: {
        activeHours: { start: 0, end: 23 },
        activeDays: [0, 1, 2, 3, 4, 5, 6],
        timezone: 'UTC',
    },
    // Ordinary owner value stays biometric-only (soft_confirm/auto_approve);
    // only very large stablecoin-denominated transfers cross into hard_confirm.
    // Approvals / unknown / unlimited escalate via the crypto layer regardless.
    friction: { autoApproveBelow: 1000, softConfirmBelow: 10000 },
    capabilities: {
        canCreatePromises: false,
        canSpendFiat: false,
        canSpendCrypto: true,
        allowedActionTypes: ['transfer', 'approve', 'swap', 'sign', 'other'],
        canCommunicate: false,
        canCommit: false,
        canShareData: false,
    },
    cardAccessMode: 'provian_holds',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
};

/**
 * Derive the crypto-spending controls for the owner from their settings.
 */
function deriveOwnerControls(settings: WalletConnectGovernanceSettings): CryptoSpendingControls {
    const perTx = settings.perTransactionLimitUsd > 0 ? settings.perTransactionLimitUsd : MAX;
    return {
        perTransactionLimit: perTx,
        dailyOnChainLimit: settings.dailyLimitUsd > 0 ? settings.dailyLimitUsd : 0, // 0 = disabled
        allowedChains: [],
        contractAllowlist: [],
        contractBlocklist: [],
        // 'hard_confirm' for unknown ⇒ allow with hard_confirm; 'block' ⇒ hard block.
        allowUnknownContracts: settings.unknownContractPolicy === 'hard_confirm',
        maxApprovalAmount: perTx,
        requireApprovalConfirm: settings.requireApprovalConfirm,
        // PM contracts are Polygon-only and not broadcastable on Provian's chains,
        // so this never triggers here; use the engine default.
        predictionMarket: undefined,
        highFrictionCategories: ['prediction_market', 'bridge', 'contract_deploy'],
        blockedCategories: [],
    };
}

// ============================================================================
// AMOUNT DERIVATION
// ============================================================================

/**
 * Best-effort USD figure for the cap checks. Only pegged stablecoins are
 * priceable on-device; everything else is 0 (the caps simply don't bind).
 */
function deriveGovernanceAmountUsd(
    tokenSymbol: string | undefined,
    tokenKnown: boolean,
    amountFormatted: string | undefined,
): number {
    if (!tokenKnown || !tokenSymbol || !amountFormatted) return 0;
    if (!STABLE_USD_SYMBOLS.has(tokenSymbol)) return 0;
    const n = Number(amountFormatted);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// ============================================================================
// VERDICT HELPERS
// ============================================================================

const LANE_SCORE: Record<FrictionLane, number> = {
    auto_approve: 15,
    soft_confirm: 40,
    hard_confirm: 70,
    block: 95,
};

function riskCategoryFor(lane: FrictionLane): 'low' | 'medium' | 'high' {
    if (lane === 'auto_approve') return 'low';
    if (lane === 'soft_confirm') return 'medium';
    return 'high';
}

function buildVerdict(lane: FrictionLane, category: CryptoTransactionCategory, reasons: string[], baseRisk: number): WalletConnectVerdict {
    const dedup = Array.from(new Set(reasons.filter(Boolean)));
    return {
        lane,
        allowed: lane !== 'block',
        requiresStrongConfirm: lane === 'hard_confirm',
        riskScore: Math.min(100, Math.max(LANE_SCORE[lane], Math.round(baseRisk))),
        riskCategory: riskCategoryFor(lane),
        category,
        reasons: dedup,
        denyReason: lane === 'block' ? (dedup[0] || 'Blocked by your WalletConnect security policy') : undefined,
        amountUsd: 0,
    };
}

function mapResultToVerdict(result: CryptoGovernanceResult): WalletConnectVerdict {
    const reasons = [
        ...result.allViolations.map(v => v.message),
        ...result.allWarnings,
    ];
    return buildVerdict(result.finalLane, result.classification.category, reasons, result.policyEvaluation.riskScore);
}

/**
 * Escalate a verdict to (at least) `target`. Escalation-only — a lower target
 * is a no-op (Security Invariant #12).
 */
function escalate(verdict: WalletConnectVerdict, target: FrictionLane, reason: string): WalletConnectVerdict {
    if (LANE_ORDER.indexOf(target) <= LANE_ORDER.indexOf(verdict.lane)) {
        // Not an escalation, but still surface the reason if it's new.
        if (reason && !verdict.reasons.includes(reason)) verdict.reasons.push(reason);
        return verdict;
    }
    const escalated = buildVerdict(target, verdict.category, [reason, ...verdict.reasons], verdict.riskScore);
    // [Pass-2 #29] Escalating the LANE must not discard the priced USD value:
    // buildVerdict defaults amountUsd to 0, but the caller already priced this
    // request. Dropping it would make WalletConnectService.handlePermitSign record
    // 0 into the daily on-chain accumulator, silently UNDER-COUNTING the daily cap
    // for any stablecoin permit that escalates (signature transfer, chain mismatch,
    // high risk). Carry it forward.
    escalated.amountUsd = verdict.amountUsd;
    return escalated;
}

/**
 * Fail-closed verdict for when governance evaluation itself cannot complete
 * (unexpected error). [Security Invariant #7] "Unknown = Block": if the system
 * cannot verify or explain an action, the answer is DENY — never a silent
 * downgrade to a lower-friction path.
 */
export function makeFailClosedVerdict(category: CryptoTransactionCategory): WalletConnectVerdict {
    return buildVerdict('block', category, ['Could not verify this request — blocked for safety. Try again.'], 90);
}

/**
 * Verdict for UNRECOGNIZED typed data — a signature whose EIP-712 struct is
 * neither a decodable spend permit nor an allowlisted non-spend shape. An
 * EIP-712 signature can move funds (EIP-3009 transferWithAuthorization, Seaport /
 * order signing, meta-transactions), so it MUST NOT land on the least-restrictive
 * biometric-only branch (Security Invariant #7 inverted). Per the F16 ruling this
 * fails closed to the strongest HUMAN confirmation (hard_confirm) with an honest
 * "could not verify what this signature authorizes" banner, rather than a hard
 * block that would make novel dApps unusable — the human remains the authority
 * but is never allowed to approve it silently. The biometric-gated signature
 * in handleUnknownTypedDataSign is the execution-time gate.
 */
export function makeUnknownTypedDataVerdict(): WalletConnectVerdict {
    return buildVerdict(
        'hard_confirm',
        'unknown',
        ['Could not verify what this signature authorizes. A typed-data signature can move funds — approve only if you fully trust this dApp.'],
        80,
    );
}

function ownerRequest(
    actionType: AgentSpendActionType,
    dappName: string,
    amountUsd: number,
    counterparty: string | undefined,
    purpose: string,
): AgentSpendRequest {
    return {
        agentId: 'wallet-owner',
        actionType,
        merchant: dappName || 'WalletConnect dApp',
        amount: amountUsd,
        currency: 'USD',
        purpose,
        counterparty,
    };
}

// ============================================================================
// PUBLIC API — eth_sendTransaction
// ============================================================================

export interface WalletConnectTxGovernanceInput {
    to: string;
    value: string;
    data: string;
    chainId: number;
    chainShortName?: string;
    dappName: string;
    /** Optional pre-decoded call (so the caller can reuse a single decode). */
    decoded?: DecodedCall;
}

/**
 * Evaluate an eth_sendTransaction against the wallet-owner governance pipeline.
 */
export async function evaluateWalletConnectTransaction(
    input: WalletConnectTxGovernanceInput,
    settings: WalletConnectGovernanceSettings, biometricAction?: BiometricAction,
): Promise<WalletConnectVerdict> {
    const decoded = input.decoded ?? decodeTransactionCall(input.to || '', input.data || '0x', input.chainId);

    // A wrapped router / multicall call grants spend authority through its inner
    // calls. Treat "any inner approval" as an approval and "any inner unlimited
    // approval" as unlimited, so the gate enforces the same risk the decoded
    // banner displays (a wrapped unlimited approval blocks just like a direct
    // one). buildWrapped() rolls the unlimited flag up onto decoded.isUnlimitedApproval.
    const innerCalls = decoded.kind === 'wrapped_calls' ? decoded.innerCalls || [] : [];
    const innerApprove = innerCalls.some(
        c => c.kind === 'erc20_approve' || c.kind === 'erc721_approve_all',
    );

    const isApprove =
        decoded.kind === 'erc20_approve' || decoded.kind === 'erc721_approve_all' || innerApprove;
    const isUnlimited =
        (decoded.kind === 'erc20_approve' ||
            decoded.kind === 'erc721_approve_all' ||
            decoded.kind === 'wrapped_calls') && !!decoded.isUnlimitedApproval;

    // Unlimited grants are unpriceable by design; let the unlimited rule govern.
    const amountUsd = isUnlimited
        ? 0
        : deriveGovernanceAmountUsd(decoded.tokenSymbol, decoded.tokenKnown, decoded.amountFormatted);

    const controls = deriveOwnerControls(settings);
    const txInput: CryptoTransactionInput = {
        to: input.to || null,
        value: input.value || '0',
        data: input.data || '0x',
        chain: input.chainShortName || String(input.chainId),
        chainId: input.chainId,
    };
    const req = ownerRequest(
        isApprove ? 'approve' : 'transfer',
        input.dappName,
        amountUsd,
        decoded.counterparty || input.to,
        `WalletConnect eth_sendTransaction (${decoded.kind})`,
    );

    const result = await evaluateCryptoTransaction(req, OWNER_POLICY, txInput, controls, biometricAction);
    let verdict = mapResultToVerdict(result);
    verdict.amountUsd = amountUsd;

    // The engine classifies off the OUTER wrapper selector (unknown), so a
    // wrapped call lands in 'unknown'. Re-label it by its strongest inner effect
    // so the PE + UI reflect what was actually authorized (the lane already
    // reflects the unknown-contract escalation; only the category is refined).
    if (decoded.kind === 'wrapped_calls') {
        verdict.category = classifyKind(decoded);
    }

    // UNLIMITED approval / setApprovalForAll(true): apply the owner's unlimited policy.
    if (isUnlimited) {
        verdict = applyUnlimitedRule(verdict, settings);
    }

    return verdict;
}

// ============================================================================
// PUBLIC API — permit / Permit2 typed data (gasless approval / transfer auth)
// ============================================================================

export interface WalletConnectPermitGovernanceInput {
    chainId: number;
    chainShortName?: string;
    dappName: string;
}

/**
 * Evaluate a gasless approval / transfer-authorization signature (EIP-2612
 * permit, DAI permit, Permit2) against the wallet-owner governance pipeline.
 * A permit grants the SAME spend authority an on-chain approve carries, so we
 * route it through the identical pipeline by synthesizing the equivalent
 * approve/transfer call for classification.
 *
 * Callers should NOT pass a `isRevoke` permit here — a revocation reduces risk
 * and stays on the biometric-only path.
 */
export async function evaluateWalletConnectPermit(
    permit: DecodedPermit,
    ctx: WalletConnectPermitGovernanceInput,
    settings: WalletConnectGovernanceSettings, biometricAction?: BiometricAction,
): Promise<WalletConnectVerdict> {
    const amountUsd = permit.isUnlimited
        ? 0
        : deriveGovernanceAmountUsd(permit.tokenSymbol, permit.tokenKnown, permit.amountFormatted);

    const controls = deriveOwnerControls(settings);

    // Synthesize the equivalent on-chain call so the classifier categorizes it
    // as token_approval / token_transfer. `to` must be non-null (a null `to`
    // would classify as contract_deploy); fall back to the spender for batch
    // shapes that carry no single token address.
    const synthTo = permit.tokenAddress || permit.spender || '0x0000000000000000000000000000000000000001';
    const synthSelector = permit.isTransfer ? '0xa9059cbb' : '0x095ea7b3'; // transfer | approve
    const synthData = synthSelector + '0'.repeat(128);

    const txInput: CryptoTransactionInput = {
        to: synthTo,
        value: '0',
        data: synthData,
        chain: ctx.chainShortName || String(ctx.chainId),
        chainId: ctx.chainId,
    };
    const req = ownerRequest(
        permit.isTransfer ? 'transfer' : 'approve',
        ctx.dappName,
        amountUsd,
        permit.spender,
        `WalletConnect ${permit.kind}${permit.isTransfer ? ' (signature transfer)' : ''}`,
    );

    const result = await evaluateCryptoTransaction(req, OWNER_POLICY, txInput, controls, biometricAction);
    let verdict = mapResultToVerdict(result);
    verdict.amountUsd = amountUsd;

    // Unverified token is the most-restrictive null-state on the human path.
    if (!permit.tokenKnown) {
        verdict = escalate(verdict, 'hard_confirm', 'Unverified token contract — the amount cannot be confirmed.');
    }

    // A signature transfer (PermitTransferFrom) is an immediate spend authorized
    // off-chain — higher stakes than a bounded approval. Require strong confirm.
    if (permit.isTransfer) {
        verdict = escalate(verdict, 'hard_confirm', 'Gasless signature transfer authorizes an immediate spend.');
    }

    // [Pass-2 #37] The decoder flags a chain mismatch when the EIP-712
    // domain.chainId the user actually signs over differs from the authoritative
    // WalletConnect session chain. The token shown (resolved on the session chain)
    // can then diverge from the chain the signature is replayable on, so this is
    // never allowed to be a silent biometric-only sign — escalate. (Escalation
    // only goes UP — Security Invariant #12.)
    if (permit.chainMismatch) {
        verdict = escalate(verdict, 'hard_confirm', 'Signing chain differs from the dApp session chain — the token shown may not be the one this signature can spend.');
    }

    // [Pass-2 #37] Honor the decoder's overall high-risk rating (unverified token,
    // unlimited amount, signature transfer, or chain mismatch). Any permit it
    // rated 'high' must be AT LEAST hard_confirm — never auto-/soft-confirm.
    // Escalation only (#12); a stronger lane already set above stands.
    if (permit.riskLevel === 'high') {
        verdict = escalate(verdict, 'hard_confirm', 'This gasless approval was rated high risk.');
    }

    // UNLIMITED permit: apply the owner's unlimited policy.
    if (permit.isUnlimited) {
        verdict = applyUnlimitedRule(verdict, settings);
    }

    return verdict;
}

// ============================================================================
// SHARED RULES
// ============================================================================

function applyUnlimitedRule(verdict: WalletConnectVerdict, settings: WalletConnectGovernanceSettings): WalletConnectVerdict {
    if (settings.unlimitedApprovalPolicy === 'block') {
        const blocked = buildVerdict('block', verdict.category, ['Unlimited approvals are blocked by your WalletConnect security policy.', ...verdict.reasons], 100);
        // [Pass-2 #29] Preserve the priced USD across the rebuild (unlimited is
        // typically 0, but never silently drop a non-zero value).
        blocked.amountUsd = verdict.amountUsd;
        return blocked;
    }
    return escalate(verdict, 'hard_confirm', 'Unlimited approval — grants open-ended access to your tokens.');
}

function classifyKind(decoded: DecodedCall): CryptoTransactionCategory {
    switch (decoded.kind) {
        case 'erc20_transfer':
            return 'token_transfer';
        case 'erc20_approve':
        case 'erc721_approve_all':
            return 'token_approval';
        case 'native_transfer':
            return 'token_transfer';
        case 'wrapped_calls': {
            // Categorize a wrapper by its strongest inner effect: any inner
            // approval ⇒ token_approval, else any inner transfer ⇒ token_transfer.
            const inner = decoded.innerCalls || [];
            if (inner.some(c => c.kind === 'erc20_approve' || c.kind === 'erc721_approve_all')) return 'token_approval';
            if (inner.some(c => c.kind === 'erc20_transfer')) return 'token_transfer';
            return 'unknown';
        }
        default:
            return 'unknown';
    }
}
