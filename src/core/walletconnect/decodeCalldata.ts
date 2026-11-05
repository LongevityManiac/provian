/**
 * decodeCalldata — decode the ERC-20 / ERC-721 calls that carry value or
 * grant spend authority, so the WalletConnect signing screen can show the
 * user *what they are actually signing* instead of "0 ETH + raw hex".
 *
 * This is a DISPLAY + provenance decoder for the human WalletConnect path.
 * It deliberately does NOT make policy decisions and is separate from the
 * agent governance pipeline (CryptoSpendingGovernance): the agent on-chain
 * path is governed; the WalletConnect path is a human-approved, biometric-
 * gated action. The decoder only enriches what the human sees and the proof
 * carried by the Provenance Envelope.
 *
 * Safety posture ("Unknown = Block, not warn"):
 *  - For an unknown token we never assume decimals — a wrong decimals value
 *    mis-scales the amount by orders of magnitude, the exact mistake a
 *    malicious token exploits. We surface a caution instead of a clean count.
 *  - "Unlimited" is decimals-aware for known tokens (a drain-all approval of a
 *    6-decimal stablecoin sits far below the absolute 2^200 ceiling).
 *  - approve(address,uint256) shares its selector between ERC-20 (amount) and
 *    ERC-721 (tokenId); for unknown contracts we cannot tell them apart, so we
 *    never infer an "unlimited" amount there.
 *  - Undecodable / malformed calldata surfaces as a caution, never a silent
 *    "0 ETH" native transfer.
 *
 * NOT covered (separate surfaces, by design): EIP-2612 `permit` / Uniswap
 * Permit2 gasless approvals ride the eth_signTypedData path, not calldata —
 * see the scope note in WalletConnectService.handleSignRequest.
 *
 * WRAPPER UNWRAPPING (shallow, one level): the most common dApp transactions
 * are not a bare approve/transfer but a router or batch wrapper that carries
 * one inside it. We unwrap exactly ONE level of the top wrappers — Uniswap
 * Universal Router `execute`, and `multicall(bytes[])` — so a wrapped
 * approve/transfer is surfaced to the signer instead of a generic "can't
 * decode" caution. Recursion is bounded to one level (Security posture: a
 * nested wrapper, an unknown wrapper, or a wrapper whose inner calls carry no
 * spend authority all stay a cautioned `contract_call` — Unknown = warn). We
 * never simulate; we only read what is literally encoded in the calldata.
 */
import { ethers } from 'ethers';
import { TOKEN_ADDRESSES } from '../chains/evm/config';

// Minimal ABI for value-bearing / authority-granting calls. Mirrors the
// AgentExecutionGate ERC20_IFACE convention. Constructed lazily so that
// merely importing this module does not require a real ethers.Interface
// (some sibling unit tests mock ethers); the Interface is only built on the
// first actual decode.
let _callIface: ethers.Interface | null = null;
function getCallIface(): ethers.Interface {
    if (!_callIface) {
        _callIface = new ethers.Interface([
            'function transfer(address to, uint256 amount)',
            'function approve(address spender, uint256 amount)',
            'function increaseAllowance(address spender, uint256 addedValue)',
            'function transferFrom(address from, address to, uint256 amount)',
            'function setApprovalForAll(address operator, bool approved)',
        ]);
    }
    return _callIface;
}

const SELECTORS = {
    transfer: '0xa9059cbb',
    approve: '0x095ea7b3',
    increaseAllowance: '0x39509351',
    transferFrom: '0x23b872dd',
    setApprovalForAll: '0xa22cb465',
} as const;

// Top wrapper selectors we unwrap one level (see WRAPPER UNWRAPPING note above).
// Hardcoded (not derived from an Interface) so importing this module never
// builds an ethers.Interface — the wrapper Interface is lazily built on first
// decode, mirroring getCallIface(). The selectors are cross-checked by the
// real-ethers tests, which encode via the same signatures.
const WRAPPER_SELECTORS = {
    // Uniswap Universal Router execute(bytes commands, bytes[] inputs[, uint256 deadline]).
    // The deadline overload (0x3593564c) is the one production UR sends.
    universalRouterExecute: '0x24856bc3',
    universalRouterExecuteDeadline: '0x3593564c',
    // Multicall: multicall(bytes[]) and the deadline-prefixed multicall(uint256,bytes[])
    multicall: '0xac9650d8',
    multicallDeadline: '0x5ae401dc',
} as const;

// Universal Router command bytes (Commands.sol). The high bit (0x80) is the
// "allow revert" flag; the command type is the low 6 bits. We only decode the
// commands that grant spend authority or move tokens — swaps, wraps and sweeps
// move tokens the user already approved and carry no NEW authority, so they are
// intentionally skipped (a swap-only execute() stays a cautioned contract_call).
const UR_COMMAND_MASK = 0x3f;
const UR_CMD = {
    PERMIT2_TRANSFER_FROM: 0x02, // (address token, address recipient, uint160 amount)
    TRANSFER: 0x05,              // (address token, address recipient, uint256 value)
    PERMIT2_PERMIT: 0x0a,        // (PermitSingle permitSingle, bytes signature)
} as const;

let _wrapperIface: ethers.Interface | null = null;
function getWrapperIface(): ethers.Interface {
    if (!_wrapperIface) {
        _wrapperIface = new ethers.Interface([
            'function execute(bytes commands, bytes[] inputs)',
            'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
            'function multicall(bytes[] data)',
            'function multicall(uint256 deadline, bytes[] data)',
        ]);
    }
    return _wrapperIface;
}

// Absolute base-unit ceiling for an "effectively unlimited" approval, used
// when token decimals are unknown. 2^200 dwarfs any real base-unit amount.
// (The string `data.includes('ffff…')` hacks elsewhere in the codebase are
// fragile and are not reused here.)
const UNLIMITED_THRESHOLD = 2n ** 200n;

// Decimals for Provian-supported tokens. The address source of truth is
// TOKEN_ADDRESSES; decimals are stable per symbol (stablecoins 6, rest 18).
const SYMBOL_DECIMALS: Record<string, number> = {
    USDC: 6,
    'USDC.e': 6,
    USDT: 6,
    DAI: 18,
    WETH: 18,
};

export interface ResolvedToken {
    symbol?: string;
    decimals?: number;
    known: boolean;
}

/**
 * Resolve a token contract address to its symbol + decimals by reverse-
 * indexing the canonical TOKEN_ADDRESSES table. Returns { known: false }
 * for any address we do not recognise on that chain.
 *
 * NOTE: this reverse-indexes the static TOKEN_ADDRESSES table (the single
 * source of truth for token addresses). A token contract that has rotated but
 * not yet been updated in that table will surface as an unknown-token caution —
 * fail-safe over-caution by design (we never assume decimals for an address we
 * can't verify).
 */
export function resolveToken(address: string, chainId: number): ResolvedToken {
    const table = TOKEN_ADDRESSES[chainId];
    if (table && address) {
        const lower = address.toLowerCase();
        for (const symbol of Object.keys(table)) {
            if (table[symbol].toLowerCase() === lower) {
                return { symbol, decimals: SYMBOL_DECIMALS[symbol], known: true };
            }
        }
    }
    return { known: false };
}

// Effectively-unlimited for a KNOWN (fungible, decimals-known) token: either
// the absolute 2^200 ceiling, or >= 1e12 whole tokens — which dwarfs any real
// token supply and catches drain-all approvals on 6-decimal stablecoins that
// sit far below 2^200 in base units. Only applied to known tokens.
// Exported so the typed-data permit decoder (decodeTypedData.ts) reuses the
// exact same test rather than forking it.
export function isEffectivelyUnlimited(amount: bigint, decimals: number): boolean {
    return amount >= UNLIMITED_THRESHOLD || amount >= 10n ** BigInt(decimals + 12);
}

export type DecodedCallKind =
    | 'native_transfer'
    | 'erc20_transfer'
    | 'erc20_approve'
    | 'erc721_approve_all'
    | 'wrapped_calls'
    | 'contract_call';

/** Which top wrapper an inner call was unwrapped from (for display + PE text). */
export type WrapperKind = 'universal_router' | 'multicall';

export interface DecodedCall {
    kind: DecodedCallKind;
    selector: string;
    tokenAddress?: string;
    tokenSymbol?: string;
    tokenKnown: boolean;
    /** recipient (transfer) or spender/operator (approve) — checksummed by ethers */
    counterparty?: string;
    /** transferFrom source address (whose tokens move); set only for transferFrom */
    from?: string;
    /** raw integer amount in base units (set for value calls) */
    amountRaw?: string;
    /** human-readable amount; ONLY set when token decimals are known */
    amountFormatted?: string;
    /** approve/increaseAllowance: amount is effectively unlimited (known tokens only) */
    isUnlimitedApproval?: boolean;
    /** true for increaseAllowance (a delta), false for approve (an absolute set) */
    isIncrease?: boolean;
    /** wrapped_calls only: which wrapper carried the inner calls */
    wrapper?: WrapperKind;
    /** wrapped_calls only: the shallow-decoded inner value/authority calls */
    innerCalls?: DecodedCall[];
    riskLevel: 'low' | 'medium' | 'high';
}

export function formatAmount(amount: bigint, token: ResolvedToken): { amountRaw: string; amountFormatted?: string } {
    const amountRaw = amount.toString();
    if (token.known && typeof token.decimals === 'number') {
        // Trim a trailing ".0" for nicer display; keep real fractional values.
        const human = ethers.formatUnits(amount, token.decimals).replace(/\.0$/, '');
        return { amountRaw, amountFormatted: human };
    }
    return { amountRaw };
}

function buildTransfer(
    selector: string,
    tokenAddress: string,
    recipient: string,
    amount: bigint,
    token: ResolvedToken,
    from?: string,
): DecodedCall {
    return {
        kind: 'erc20_transfer',
        selector,
        tokenAddress,
        tokenSymbol: token.symbol,
        tokenKnown: token.known,
        counterparty: recipient,
        ...(from !== undefined ? { from } : {}),
        ...formatAmount(amount, token),
        riskLevel: token.known ? 'low' : 'medium',
    };
}

function buildApprove(
    selector: string,
    spender: string,
    amount: bigint,
    to: string,
    token: ResolvedToken,
    isIncrease: boolean,
): DecodedCall {
    const isUnlimited =
        token.known && typeof token.decimals === 'number'
            ? isEffectivelyUnlimited(amount, token.decimals)
            : false;
    return {
        kind: 'erc20_approve',
        selector,
        tokenAddress: to,
        tokenSymbol: token.symbol,
        tokenKnown: token.known,
        counterparty: spender,
        ...formatAmount(amount, token),
        isUnlimitedApproval: isUnlimited,
        isIncrease,
        riskLevel: isUnlimited ? 'high' : 'medium',
    };
}

/**
 * Decode an eth_sendTransaction's (to, data) into a human-meaningful action.
 * Never throws: an undecodable call returns kind 'contract_call' so the UI
 * warns rather than silently showing "0 ETH".
 */
export function decodeTransactionCall(to: string, data: string, chainId: number, _depth: number = 0): DecodedCall {
    const raw = (data || '0x').toLowerCase();

    // Only truly-empty calldata is a plain native-value transfer.
    if (raw === '0x') {
        return { kind: 'native_transfer', selector: '0x', tokenKnown: false, riskLevel: 'low' };
    }

    const token = resolveToken(to, chainId);

    // Non-empty but shorter than a full 4-byte selector → malformed calldata.
    // Surface as a caution, never as a silent native transfer.
    if (raw.length < 10) {
        return { kind: 'contract_call', selector: raw, tokenAddress: to, tokenKnown: token.known, riskLevel: 'medium' };
    }

    const selector = raw.slice(0, 10);

    try {
        if (selector === SELECTORS.transfer) {
            const d = getCallIface().decodeFunctionData('transfer', data);
            return buildTransfer(selector, to, d[0] as string, d[1] as bigint, token);
        }
        if (selector === SELECTORS.transferFrom) {
            const d = getCallIface().decodeFunctionData('transferFrom', data);
            // counterparty = recipient (2nd arg); from = source whose tokens move (1st arg)
            return buildTransfer(selector, to, d[1] as string, d[2] as bigint, token, d[0] as string);
        }
        if (selector === SELECTORS.approve) {
            const d = getCallIface().decodeFunctionData('approve', data);
            return buildApprove(selector, d[0] as string, d[1] as bigint, to, token, false);
        }
        if (selector === SELECTORS.increaseAllowance) {
            const d = getCallIface().decodeFunctionData('increaseAllowance', data);
            return buildApprove(selector, d[0] as string, d[1] as bigint, to, token, true);
        }
        if (selector === SELECTORS.setApprovalForAll) {
            const d = getCallIface().decodeFunctionData('setApprovalForAll', data);
            const approved = d[1] as boolean;
            return {
                kind: 'erc721_approve_all',
                selector,
                tokenAddress: to,
                tokenSymbol: token.symbol,
                tokenKnown: token.known,
                counterparty: d[0] as string,
                isUnlimitedApproval: approved,
                riskLevel: approved ? 'high' : 'low',
            };
        }
    } catch {
        // Any decode failure falls through to the wrapper / contract_call paths below.
    }

    // Shallow wrapper unwrapping (one level only). Only attempted at the top
    // level: a nested wrapper inside a wrapper stays a cautioned contract_call,
    // bounding recursion (Unknown = warn). Returns null when nothing decodable
    // (no inner spend-authority call) is found inside.
    if (_depth === 0) {
        const wrapped = decodeWrapper(selector, to, data, chainId, _depth);
        if (wrapped) return wrapped;
    }

    // Unknown selector or decode failure → undecodable call. Surfaced as a
    // caution (Unknown = Block/warn), never as a silent "0 ETH".
    return { kind: 'contract_call', selector, tokenAddress: to, tokenKnown: token.known, riskLevel: 'medium' };
}

// ============================================================================
// SHALLOW WRAPPER UNWRAPPING (one level)
// ============================================================================

const RISK_ORDER: Record<DecodedCall['riskLevel'], number> = { low: 0, medium: 1, high: 2 };

/** The most severe riskLevel across a set of inner calls (defaults to medium). */
function maxInnerRisk(calls: DecodedCall[]): DecodedCall['riskLevel'] {
    return calls.reduce<DecodedCall['riskLevel']>(
        (acc, c) => (RISK_ORDER[c.riskLevel] > RISK_ORDER[acc] ? c.riskLevel : acc),
        'medium',
    );
}

/** Inner kinds we consider a meaningful unwrap (value moved or authority granted). */
function isMeaningfulInner(c: DecodedCall): boolean {
    return c.kind === 'erc20_transfer' || c.kind === 'erc20_approve' || c.kind === 'erc721_approve_all';
}

/**
 * Assemble a wrapped_calls DecodedCall from the inner calls found inside a
 * wrapper. The wrapper itself is never a known token, so tokenKnown is false.
 * isUnlimitedApproval rolls up "any inner call is an unlimited approval" so the
 * UI banner and the WalletConnect governance pipeline can escalate without
 * re-walking innerCalls.
 */
function buildWrapped(
    selector: string,
    to: string,
    wrapper: WrapperKind,
    inner: DecodedCall[],
): DecodedCall {
    const anyUnlimited = inner.some(
        c => (c.kind === 'erc20_approve' || c.kind === 'erc721_approve_all') && !!c.isUnlimitedApproval,
    );
    return {
        kind: 'wrapped_calls',
        selector,
        tokenAddress: to,
        tokenKnown: false,
        wrapper,
        innerCalls: inner,
        isUnlimitedApproval: anyUnlimited,
        riskLevel: maxInnerRisk(inner),
    };
}

/** Dispatch a known wrapper selector to its decoder. Returns null otherwise. */
function decodeWrapper(selector: string, to: string, data: string, chainId: number, depth: number): DecodedCall | null {
    switch (selector) {
        case WRAPPER_SELECTORS.universalRouterExecute:
            return decodeUniversalRouter(selector, to, data, chainId, false);
        case WRAPPER_SELECTORS.universalRouterExecuteDeadline:
            return decodeUniversalRouter(selector, to, data, chainId, true);
        case WRAPPER_SELECTORS.multicall:
            return decodeMulticall(selector, to, data, chainId, false, depth);
        case WRAPPER_SELECTORS.multicallDeadline:
            return decodeMulticall(selector, to, data, chainId, true, depth);
        default:
            return null;
    }
}

/**
 * multicall(bytes[]) / multicall(uint256 deadline, bytes[]): each element is a
 * full self-call calldata, so we recurse decodeTransactionCall once per element
 * (depth+1 disables further unwrapping — one level only). Keep only the
 * meaningful inner calls; if none decode, return null so the caller falls back
 * to the contract_call caution.
 */
function decodeMulticall(
    selector: string,
    to: string,
    data: string,
    chainId: number,
    hasDeadline: boolean,
    depth: number,
): DecodedCall | null {
    try {
        const sig = hasDeadline ? 'multicall(uint256,bytes[])' : 'multicall(bytes[])';
        const d = getWrapperIface().decodeFunctionData(sig, data);
        const elements = (hasDeadline ? d[1] : d[0]) as string[];
        const inner = elements
            .map(el => decodeTransactionCall(to, el, chainId, depth + 1))
            .filter(isMeaningfulInner);
        if (inner.length === 0) return null;
        return buildWrapped(selector, to, 'multicall', inner);
    } catch {
        return null;
    }
}

/**
 * Uniswap Universal Router execute(bytes commands, bytes[] inputs[, uint256]).
 * `commands` is a byte string where each byte selects a sub-action and
 * `inputs[i]` is its ABI-encoded argument tuple (NOT a selector-prefixed call,
 * so this can't recurse decodeTransactionCall). We map only the commands that
 * move tokens or grant spend authority (TRANSFER, PERMIT2_TRANSFER_FROM,
 * PERMIT2_PERMIT); swaps/wraps/sweeps carry no new authority and are skipped.
 * Returns null if no such command is present (a swap-only execute stays a
 * cautioned contract_call).
 */
function decodeUniversalRouter(
    selector: string,
    to: string,
    data: string,
    chainId: number,
    hasDeadline: boolean,
): DecodedCall | null {
    try {
        const sig = hasDeadline ? 'execute(bytes,bytes[],uint256)' : 'execute(bytes,bytes[])';
        const d = getWrapperIface().decodeFunctionData(sig, data);
        const commandBytes = ethers.getBytes(d[0] as string);
        const inputs = d[1] as string[];
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const inner: DecodedCall[] = [];

        for (let i = 0; i < commandBytes.length && i < inputs.length; i++) {
            const cmd = commandBytes[i] & UR_COMMAND_MASK;
            const input = inputs[i];
            try {
                if (cmd === UR_CMD.TRANSFER) {
                    const [tok, recipient, value] = coder.decode(['address', 'address', 'uint256'], input);
                    inner.push(buildTransfer(SELECTORS.transfer, tok as string, recipient as string, value as bigint, resolveToken(tok as string, chainId)));
                } else if (cmd === UR_CMD.PERMIT2_TRANSFER_FROM) {
                    const [tok, recipient, amount] = coder.decode(['address', 'address', 'uint160'], input);
                    inner.push(buildTransfer(SELECTORS.transfer, tok as string, recipient as string, amount as bigint, resolveToken(tok as string, chainId)));
                } else if (cmd === UR_CMD.PERMIT2_PERMIT) {
                    // PermitSingle: ((address token, uint160 amount, uint48 expiration, uint48 nonce), address spender, uint256 sigDeadline), bytes signature
                    const [permitSingle] = coder.decode(
                        ['tuple(tuple(address,uint160,uint48,uint48),address,uint256)', 'bytes'],
                        input,
                    );
                    const details = permitSingle[0] as [string, bigint, bigint, bigint];
                    const tok = details[0];
                    const amount = details[1];
                    const spender = permitSingle[1] as string;
                    inner.push(buildApprove(SELECTORS.approve, spender, amount, tok, resolveToken(tok, chainId), false));
                }
                // Other commands (swaps, WRAP_ETH, UNWRAP_WETH, SWEEP, PAY_PORTION)
                // carry no NEW spend authority — intentionally skipped.
            } catch {
                // An undecodable command input is skipped, not fatal.
            }
        }

        if (inner.length === 0) return null;
        return buildWrapped(selector, to, 'universal_router', inner);
    } catch {
        return null;
    }
}
