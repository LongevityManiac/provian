/**
 * decodeTypedData — detect gasless approval / transfer-authorization signatures
 * (EIP-2612 `permit`, DAI-style `permit`, and Uniswap Permit2 PermitSingle /
 * PermitBatch / PermitTransferFrom / PermitBatchTransferFrom) carried over
 * eth_signTypedData, so the WalletConnect sign screen warns the user that a
 * *signature* here grants spend authority — the same risk an on-chain `approve`
 * carries, but otherwise invisible because no transaction is broadcast.
 *
 * Display + Provenance-Envelope enrichment only (the human, biometric-gated
 * WalletConnect path — see the scope note in WalletConnectService.handleSignRequest).
 * Token metadata + the decimals-aware "unlimited" test are REUSED from
 * decodeCalldata (resolveToken / formatAmount / isEffectivelyUnlimited) so this
 * does not fork that logic.
 *
 * Trust-integrity rules (so the displayed semantics provably match the signed
 * digest):
 *  - Permit2 shapes are accepted ONLY when domain.verifyingContract is the
 *    canonical Permit2 contract — otherwise an attacker contract could borrow
 *    the trusted "Permit2 / USDC" label.
 *  - Every shape is accepted ONLY when types[primaryType] (and nested structs)
 *    matches the canonical field list exactly (name + type + order) — a struct
 *    merely *named* `Permit` with extra/reordered fields produces a different
 *    EIP-712 digest and must not be shown as a standard permit.
 *  - Token resolution keys off the SESSION chainId (authoritative), never the
 *    attacker-controlled domain.chainId.
 *  - An unverifiable token is the most-restrictive null-state: high risk.
 */
import { resolveToken, formatAmount, isEffectivelyUnlimited, ResolvedToken } from './decodeCalldata';

// Uniswap Permit2 canonical contract (same address on every chain).
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Absolute base-unit ceiling — an amount this large is "unlimited" regardless
// of (untrusted) token decimals. Mirrors decodeCalldata's UNLIMITED_THRESHOLD.
const ABSOLUTE_UNLIMITED = 2n ** 200n;

interface Field { name?: string; type?: string }

interface TypedDataLike {
    primaryType?: string;
    domain?: { chainId?: number | string; verifyingContract?: string; name?: string };
    types?: Record<string, unknown>;
    message?: Record<string, unknown>;
}

export interface PermitItem {
    tokenSymbol?: string;
    tokenKnown: boolean;
    amountFormatted?: string;
    amountRaw?: string;
    isUnlimited: boolean;
}

export interface DecodedPermit {
    kind: 'erc2612_permit' | 'dai_permit' | 'permit2_single' | 'permit2_batch' | 'permit2_transfer' | 'eip3009_transfer';
    spender: string;
    tokenAddress?: string;
    tokenSymbol?: string;
    tokenKnown: boolean;
    amountRaw?: string;
    amountFormatted?: string;
    isUnlimited: boolean;
    /** true for a one-shot signature transfer (PermitTransferFrom) — higher stakes */
    isTransfer?: boolean;
    /** true for a DAI allowed=false revocation */
    isRevoke?: boolean;
    /** per-item summaries for batch shapes */
    items?: PermitItem[];
    batchCount?: number;
    /**
     * true when the EIP-712 domain.chainId the user is actually signing over
     * differs from the authoritative WalletConnect session chain. The displayed
     * token (resolved on the session chain) can then diverge from the chain the
     * signature is replayable on, so this is surfaced and risk-escalated.
     */
    chainMismatch?: boolean;
    riskLevel: 'medium' | 'high';
}

// Canonical EIP-712 type field lists (name, type) — order matters.
const CANON = {
    Permit2612: [['owner', 'address'], ['spender', 'address'], ['value', 'uint256'], ['nonce', 'uint256'], ['deadline', 'uint256']],
    PermitDAI: [['holder', 'address'], ['spender', 'address'], ['nonce', 'uint256'], ['expiry', 'uint256'], ['allowed', 'bool']],
    PermitDetails: [['token', 'address'], ['amount', 'uint160'], ['expiration', 'uint48'], ['nonce', 'uint48']],
    PermitSingle: [['details', 'PermitDetails'], ['spender', 'address'], ['sigDeadline', 'uint256']],
    PermitBatch: [['details', 'PermitDetails[]'], ['spender', 'address'], ['sigDeadline', 'uint256']],
    TokenPermissions: [['token', 'address'], ['amount', 'uint256']],
    PermitTransferFrom: [['permitted', 'TokenPermissions'], ['spender', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
    PermitBatchTransferFrom: [['permitted', 'TokenPermissions[]'], ['spender', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
    // EIP-3009 gasless value transfer authorization (USDC/EURC etc.). The signer
    // is `from`; the value moves to `to`. This is the exact shape this repo's own
    // x402 signer produces — a signature here authorizes an immediate spend of the
    // owner's tokens, so it MUST be governed like a Permit2 signature transfer.
    TransferWithAuthorization: [['from', 'address'], ['to', 'address'], ['value', 'uint256'], ['validAfter', 'uint256'], ['validBefore', 'uint256'], ['nonce', 'bytes32']],
    ReceiveWithAuthorization: [['from', 'address'], ['to', 'address'], ['value', 'uint256'], ['validAfter', 'uint256'], ['validBefore', 'uint256'], ['nonce', 'bytes32']],
} as const;

function typeMatches(types: Record<string, unknown> | undefined, name: string, expected: ReadonlyArray<readonly [string, string]>): boolean {
    const fields = types?.[name];
    if (!Array.isArray(fields) || fields.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        const f = fields[i] as Field;
        if (f?.name !== expected[i][0] || f?.type !== expected[i][1]) return false;
    }
    return true;
}

function toChainId(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
    return 0;
}

function toBigInt(v: unknown): bigint | null {
    try {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return BigInt(v);
        if (typeof v === 'string' && v.length > 0) return BigInt(v); // handles decimal AND 0x-hex
    } catch {
        // fall through
    }
    return null;
}

interface AmountInfo { amountRaw?: string; amountFormatted?: string; isUnlimited: boolean }

function describe(amount: bigint | null, token: ResolvedToken): AmountInfo {
    if (amount === null) return { isUnlimited: false };
    const fmt = formatAmount(amount, token);
    const isUnlimited =
        token.known && typeof token.decimals === 'number'
            ? isEffectivelyUnlimited(amount, token.decimals)
            : amount >= ABSOLUTE_UNLIMITED; // unknown token: only the decimals-independent ceiling
    return { ...fmt, isUnlimited };
}

interface PermitOpts { forceUnlimited?: boolean; isTransfer?: boolean; isRevoke?: boolean }

function single(
    kind: DecodedPermit['kind'],
    spender: string,
    tokenAddr: string,
    token: ResolvedToken,
    info: AmountInfo,
    opts: PermitOpts = {},
): DecodedPermit {
    const isUnlimited = !!opts.forceUnlimited || info.isUnlimited;
    // Unknown token, unlimited amount, or a one-shot transfer → high (most
    // restrictive). A bounded approval of a known token is medium.
    const riskLevel: 'medium' | 'high' =
        !token.known || isUnlimited || opts.isTransfer ? 'high' : 'medium';
    return {
        kind,
        spender,
        tokenAddress: tokenAddr,
        tokenSymbol: token.symbol,
        tokenKnown: token.known,
        amountRaw: info.amountRaw,
        amountFormatted: info.amountFormatted,
        isUnlimited,
        isTransfer: opts.isTransfer,
        isRevoke: opts.isRevoke,
        riskLevel,
    };
}

function batch(
    spender: string,
    rows: unknown[],
    chainId: number,
    isTransfer: boolean,
): DecodedPermit {
    const items: PermitItem[] = rows.map(r => {
        // A malformed/non-object row (the array is attacker-controlled JSON)
        // resolves to an unknown token → high risk, never a throw.
        const row = (r && typeof r === 'object' && !Array.isArray(r)) ? (r as Record<string, unknown>) : {};
        const token = resolveToken(String(row.token || ''), chainId);
        const info = describe(toBigInt(row.amount), token);
        return {
            tokenSymbol: token.symbol,
            tokenKnown: token.known,
            amountFormatted: info.amountFormatted,
            amountRaw: info.amountRaw,
            isUnlimited: info.isUnlimited,
        };
    });
    const anyUnlimited = items.some(i => i.isUnlimited);
    const anyUnverified = items.some(i => !i.tokenKnown);
    return {
        kind: 'permit2_batch',
        spender,
        tokenKnown: !anyUnverified,
        isUnlimited: anyUnlimited,
        isTransfer,
        items,
        batchCount: items.length,
        // Any unlimited grant, any unverified token, or a transfer authorization
        // → high. Only an all-known, all-bounded batch is medium.
        riskLevel: anyUnlimited || anyUnverified || isTransfer ? 'high' : 'medium',
    };
}

/**
 * Decode an eth_signTypedData(_v4) payload into a gasless-approval descriptor,
 * or null if it is not a recognised permit. Never throws.
 *
 * @param sessionChainId the authoritative WalletConnect session chainId; used
 *   for token resolution in preference to the attacker-controlled domain.chainId.
 */
export function decodeTypedData(typedData: unknown, sessionChainId?: number): DecodedPermit | null {
    const result = decodeTypedDataInner(typedData, sessionChainId);
    // Detect a chain mismatch: the user signs over domain.chainId, but tokens
    // are resolved (and displayed) on the session chain. If they differ the
    // displayed semantics can diverge from where the signature is replayable, so
    // flag it and escalate risk (review #34).
    if (result && sessionChainId && typedData && typeof typedData === 'object') {
        const domainChainId = toChainId((typedData as TypedDataLike).domain?.chainId);
        if (domainChainId && domainChainId !== sessionChainId) {
            result.chainMismatch = true;
            result.riskLevel = 'high';
        }
    }
    return result;
}

/**
 * Allowlist of typed-data shapes that provably carry NO spend authority and may
 * therefore stay on the biometric-only sign path (e.g. SIWE-style / EIP-712
 * login). Besides a decoded spend permit (governed) and a protective revoke,
 * this is the ONLY typed data WalletConnectService.handleSignRequest routes to
 * the biometric-only path; everything else is UNCLASSIFIABLE and fails closed to
 * the governed hard_confirm path (Security Invariant #7 — "Unknown = Block, not
 * warn", softened to the strongest human confirmation per the F16 ruling).
 *
 * A shape is admitted ONLY by exact canonical structure (name + type + order),
 * NEVER by primaryType name alone — the primaryType string is fully
 * attacker-controlled, so a bare-name match would let a spend struct borrow a
 * safe label. The registry is intentionally EMPTY today: real SIWE login is
 * EIP-4361 over `personal_sign` (which stays biometric-only on its own path),
 * and no widely-used, standardized EIP-712 typed-data login shape has a canonical
 * field list we can pin here. Add an entry only with its exact [name,type] field
 * list, mirroring CANON — never a name-only rule.
 */
const KNOWN_NON_SPEND_SHAPES: ReadonlyArray<{ primaryType: string; fields: ReadonlyArray<readonly [string, string]> }> = [];

/**
 * True iff `typedData` matches an allowlisted non-spend shape by exact canonical
 * structure. Used by the WalletConnect sign router to keep genuinely safe
 * (structurally verified) login/auth typed data on the biometric-only path while
 * every other unrecognized shape fails closed to the governed path. Never throws.
 */
export function isKnownNonSpendTypedData(typedData: unknown): boolean {
    if (!typedData || typeof typedData !== 'object') return false;
    const td = typedData as TypedDataLike;
    const primaryType = td.primaryType;
    if (!primaryType) return false;
    const types = td.types as Record<string, unknown> | undefined;
    for (const shape of KNOWN_NON_SPEND_SHAPES) {
        if (shape.primaryType === primaryType && typeMatches(types, primaryType, shape.fields)) {
            return true;
        }
    }
    return false;
}

function decodeTypedDataInner(typedData: unknown, sessionChainId?: number): DecodedPermit | null {
    if (!typedData || typeof typedData !== 'object') return null;
    const td = typedData as TypedDataLike;
    const primaryType = td.primaryType;
    const message = td.message;
    const types = td.types as Record<string, unknown> | undefined;
    if (!primaryType || !message || typeof message !== 'object') return null;

    // Resolve tokens on the session chain, never the dApp-supplied domain chain.
    const chainId = sessionChainId || toChainId(td.domain?.chainId);
    const verifyingContract = String(td.domain?.verifyingContract || '');
    const isPermit2 = verifyingContract.toLowerCase() === PERMIT2_ADDRESS.toLowerCase();

    // ── EIP-2612 value-style permit: token IS the verifyingContract ──
    if (primaryType === 'Permit' && typeMatches(types, 'Permit', CANON.Permit2612)) {
        const token = resolveToken(verifyingContract, chainId);
        return single('erc2612_permit', String(message.spender), verifyingContract, token, describe(toBigInt(message.value), token));
    }

    // ── DAI allowed-style permit: allowed=true grants an UNLIMITED allowance ──
    if (primaryType === 'Permit' && typeMatches(types, 'Permit', CANON.PermitDAI)) {
        const token = resolveToken(verifyingContract, chainId);
        // EIP-712 `bool` encoding is truthiness-based: any non-`false` value the
        // dApp supplies signs as `allowed=true` (an UNLIMITED allowance). Treat
        // ONLY a strict boolean `false` as a revoke; everything else fails closed
        // to the dangerous unlimited grant, so we can never show a grant as a
        // benign "revoke".
        const isRevoke = message.allowed === false;
        return single(
            'dai_permit',
            String(message.spender),
            verifyingContract,
            token,
            isRevoke ? { isUnlimited: false, amountRaw: '0', amountFormatted: '0' } : { isUnlimited: true },
            { forceUnlimited: !isRevoke, isRevoke },
        );
    }

    // ── EIP-3009 gasless transfer authorization: verifyingContract IS the token
    //    (USDC etc.), the signer is `from`, and the value moves to `to`. Grants an
    //    immediate one-shot transfer authorized purely by SIGNATURE — the shape
    //    this repo's x402 signer produces — so it is a high-stakes transfer, not a
    //    benign message. Token is resolved on the SESSION chain (never the
    //    attacker-controlled domain.chainId); an unresolved token → high risk. The
    //    displayed `spender` is the recipient (`to`). ──
    if ((primaryType === 'TransferWithAuthorization' && typeMatches(types, 'TransferWithAuthorization', CANON.TransferWithAuthorization))
        || (primaryType === 'ReceiveWithAuthorization' && typeMatches(types, 'ReceiveWithAuthorization', CANON.ReceiveWithAuthorization))) {
        const token = resolveToken(verifyingContract, chainId);
        return single(
            'eip3009_transfer',
            String(message.to || ''),
            verifyingContract,
            token,
            describe(toBigInt(message.value), token),
            { isTransfer: true },
        );
    }

    // ── Permit2: ONLY trusted when verifyingContract is the canonical Permit2 ──
    if (isPermit2) {
        if (primaryType === 'PermitSingle'
            && typeMatches(types, 'PermitSingle', CANON.PermitSingle)
            && typeMatches(types, 'PermitDetails', CANON.PermitDetails)
            && message.details && typeof message.details === 'object' && !Array.isArray(message.details)) {
            const details = message.details as Record<string, unknown>;
            const token = resolveToken(String(details.token || ''), chainId);
            return single('permit2_single', String(message.spender), String(details.token || ''), token, describe(toBigInt(details.amount), token));
        }
        if (primaryType === 'PermitBatch'
            && typeMatches(types, 'PermitBatch', CANON.PermitBatch)
            && typeMatches(types, 'PermitDetails', CANON.PermitDetails)
            && Array.isArray(message.details) && message.details.length > 0) {
            return batch(String(message.spender), message.details as unknown[], chainId, false);
        }
        if (primaryType === 'PermitTransferFrom'
            && typeMatches(types, 'PermitTransferFrom', CANON.PermitTransferFrom)
            && typeMatches(types, 'TokenPermissions', CANON.TokenPermissions)
            && message.permitted && typeof message.permitted === 'object' && !Array.isArray(message.permitted)) {
            const permitted = message.permitted as Record<string, unknown>;
            const token = resolveToken(String(permitted.token || ''), chainId);
            return single('permit2_transfer', String(message.spender), String(permitted.token || ''), token, describe(toBigInt(permitted.amount), token), { isTransfer: true });
        }
        if (primaryType === 'PermitBatchTransferFrom'
            && typeMatches(types, 'PermitBatchTransferFrom', CANON.PermitBatchTransferFrom)
            && typeMatches(types, 'TokenPermissions', CANON.TokenPermissions)
            && Array.isArray(message.permitted) && message.permitted.length > 0) {
            return batch(String(message.spender), message.permitted as unknown[], chainId, true);
        }
    }

    return null;
}
