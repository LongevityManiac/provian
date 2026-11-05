import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import ProxyConfig from '../../services/ProxyConfig';
import { VERIFIED_TOKENS } from '../../data/verified-tokens';
import { PVT9_TOKEN } from '../chains/evm/config';
import {
    PVT_MIGRATION_DISTRIBUTOR,
    PREDECESSOR_PVT9_KERNEL_FOR_HISTORY,
    isPreMigrationPredecessorBlock,
} from './pvtHistoricalKernels';
import { isPvtMigrationReceipt, isPvtMintTransfer } from './pvtMintClassifier';
import { mergeTransactionLists } from './mergeTransactionLists';
// EVM (Base/Arb/Op) history via Alchemy; Solana history via Solana RPC
// (fetchSolanaTransactions). Bitcoin/Tron not supported.

/**
 * Format an EVM gas fee (gasUsed × gasPrice) as a 6-decimal display string.
 * Uses BigInt arithmetic to avoid precision loss on large gas amounts.
 * Returns '0.000000' on parse failure rather than throwing - display only.
 */
function formatEVMGasFee(gasUsed: string | number, gasPrice: string | number): string {
    try {
        const wei = BigInt(gasUsed.toString()) * BigInt(gasPrice.toString());
        const formatted = ethers.formatEther(wei);
        // Round to 6 decimals via fixed-point on the wei value to keep BigInt precision.
        const num = Number(formatted);
        return num.toFixed(6);
    } catch {
        return '0.000000';
    }
}

// 'earned' = an incoming PVT mint (issuance from the zero address by the PVT9
// kernel); a first-class type so it reads as an earning, not a mystery receive.
export type TransactionType = 'sent' | 'received' | 'swap' | 'agent' | 'stake' | 'unstake' | 'approve' | 'earned';
export type TransactionStatus = 'pending' | 'confirmed' | 'failed';
export type ChainType = 'Base' | 'Arbitrum' | 'Optimism' | 'Solana';

export interface Transaction {
    id: string;
    hash: string;
    type: TransactionType;
    status: TransactionStatus;
    chain: ChainType;
    from: string;
    to: string;
    amount: string;
    symbol: string;
    usdValue?: number;
    fee?: string;
    feeSymbol?: string;
    timestamp: number;
    blockNumber?: number;
    confirmations?: number;
    // [Spam filter] Token contract address for ERC-20/721 transfers; absent
    // for native ETH transfers. Used by isVerifiedToken() to filter spam
    // airdrops by checking the address against VERIFIED_TOKENS.
    contractAddress?: string;
    // [Spam filter] Whether this token's contract is in the verified-tokens
    // allowlist for its chain. Computed at parse time so consumers can
    // render badges or filter without re-checking the registry.
    isVerifiedToken?: boolean;
    // Agent transaction fields
    agentId?: string;
    agentPurpose?: string;
    provenanceEnvelopeId?: string;
    // an incoming live-PVT transfer from the migration distributor — the 1:1 carry of
    // a predecessor balance, rendered as a migration receipt rather than a plain "Received".
    isMigrationReceipt?: boolean;
    // a transfer on the RETIRED kernel. Verified (and shown by default) only at or
    // before the migration snapshot block; always labelled as retired, pre-migration PVT.
    isRetiredPvt?: boolean;
    // Swap fields
    swapFromSymbol?: string;
    swapToSymbol?: string;
    swapFromAmount?: string;
    swapToAmount?: string;
}

interface PaginatedResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor?: string;
}

const STORAGE_KEY = 'transaction_history';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// [Spam filter] Lowercased contract addresses for every verified ERC-20
// across every supported chain in src/data/verified-tokens.ts. Built once
// at module load. Used by isVerifiedTokenTx() to decide whether a tx
// involves a known-legitimate token (USDC, USDT, ETH, WETH, PVT, DAI, ...)
// vs. an unknown contract (likely spam airdrop or scam token).
//
// Note: this set is global across chains. A USDC contract address that's
// valid on Base would also pass on Ethereum, etc. That's a non-issue
// because contract addresses are globally unique per deployment, and the
// risk we're filtering against is "user receives an airdrop from an
// unknown contract" - which is a per-tx check, not a per-chain check.
//
// the LIVE PVT token is added HERE, for the history view only. Base's allowlist
// carried only USDC and WETH, so the default verified-only history silently dropped every PVT
// row — earnings and the migration receipt. It does not go into VERIFIED_TOKENS:
// `PVT9_TOKEN` stays outside every active token mapping by the check:wp2 app boundary.
//
// The RETIRED kernel is deliberately NOT in this set. It is no longer PVT, and its
// `_transfer` has no hold check, so a post-migration transfer of retired PVT must never read as
// genuine. It is verified per row, by block, in `isVerifiedContractAt` below.
const VERIFIED_ADDRESSES: Set<string> = (() => {
    const set = new Set<string>();
    for (const chainTokens of Object.values(VERIFIED_TOKENS)) {
        for (const token of Object.values(chainTokens as Record<string, { address: string }>)) {
            if (token?.address) set.add(token.address.toLowerCase());
        }
    }
    set.add(PVT9_TOKEN.address.toLowerCase());
    return set;
})();

const RETIRED_PVT_KERNEL = PREDECESSOR_PVT9_KERNEL_FOR_HISTORY.toLowerCase();

function isRetiredPvtContract(contractAddress: string | undefined): boolean {
    return !!contractAddress && contractAddress.toLowerCase() === RETIRED_PVT_KERNEL;
}

/**
 * The one verification rule for an ERC-20 contract in history. A transfer on the retired
 * kernel is verified only as pre-migration history — at or before the snapshot block,
 * failing closed on an unknown block. Everything else is the allowlist.
 */
function isVerifiedContractAt(contractAddress: string, blockNumber: number | undefined): boolean {
    if (isRetiredPvtContract(contractAddress)) return isPreMigrationPredecessorBlock(blockNumber);
    return VERIFIED_ADDRESSES.has(contractAddress.toLowerCase());
}

/**
 * Returns true if a Transaction involves a verified token or native currency.
 * Native ETH transfers (no contractAddress) are always considered verified.
 * ERC-20 transfers are checked by `isVerifiedContractAt`.
 */
function isVerifiedTokenTx(tx: Transaction): boolean {
    if (!tx.contractAddress) return true; // native currency
    // Solana SPL mints are base58 (case-sensitive) and are not in the EVM
    // allowlist. The Solana parser only ever emits the canonical USDC mint and
    // stamps isVerifiedToken; trust that flag rather than the EVM allowlist.
    if (tx.chain === 'Solana') return tx.isVerifiedToken === true;
    return isVerifiedContractAt(tx.contractAddress, tx.blockNumber);
}

// EVM chain to proxy network identifier (used by backend explorer proxy).
// NOTE: this is now legacy - the explorer proxy uses Etherscan v1 endpoints
// which were deprecated in early 2025 and now return errors. Kept here only
// in case some other call site references it. The active path uses the
// Alchemy mapping below via alchemy_getAssetTransfers.
const CHAIN_TO_NETWORK: Partial<Record<ChainType, string>> = {
    Base: 'base',
    Arbitrum: 'arbitrum',
    Optimism: 'optimism',
};

// EVM chain to Alchemy network identifier (matches ALCHEMY_NETWORKS in the
// backend proxy). The proxy expects this exact string in the path.
const CHAIN_TO_ALCHEMY_NETWORK: Partial<Record<ChainType, string>> = {
    Base: 'base-mainnet',
    Arbitrum: 'arb-mainnet',
    Optimism: 'opt-mainnet',
};

// Non-EVM APIs removed (Bitcoin, Tron)

// [Fix 1B] Native gas token symbol per chain (for fee display)
const CHAIN_NATIVE_SYMBOLS: Record<ChainType, string> = {
    Base: 'ETH',
    Arbitrum: 'ETH',
    Optimism: 'ETH',
    Solana: 'SOL',
};

// Canonical WETH contract addresses per EVM chain. Used to detect ETH unwraps
// in swap transactions (Withdrawal events from these contracts indicate the
// user received native ETH after a token-for-ETH swap).
const WETH_ADDRESSES: Partial<Record<ChainType, string>> = {
    Base: '0x4200000000000000000000000000000000000006',
    Optimism: '0x4200000000000000000000000000000000000006',
    Arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};

// Event topic hashes - keccak256 of the signature.
const TOPIC_WETH_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const TOPIC_ERC20_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

// Window for the approval-event scan: the last APPROVAL_LOG_BLOCK_WINDOW blocks
// in ONE eth_getLogs call. At Base's ~2s block time that is roughly the last
// ~5h (longer on slower chains) — NOT 24h; a genuine multi-day/full-history
// view would need a wider window plus backward pagination (deliberately not done
// here, to keep per-scan cost minimal). The scan requires Alchemy Pay-As-You-Go
// (the Free tier's 10-block eth_getLogs cap makes any window impossible), so it
// is gated behind isApprovalScanEnabled() (EXPO_PUBLIC_ALCHEMY_PAYG). PAYG is
// active and the flag is on.
const APPROVAL_LOG_BLOCK_WINDOW = 9_000;

/**
 * Is the Alchemy approval scan enabled? Alchemy Pay-As-You-Go is active and
 * permanent for Provian, so this DEFAULTS ON: the scan runs and the "monitoring
 * off" banner stays hidden unless someone explicitly sets
 * EXPO_PUBLIC_ALCHEMY_PAYG=false (e.g. to fall back to the free tier).
 *
 * Defaulting on also makes the feature independent of per-build env inlining —
 * `eas.json` env only reaches `eas build`, while a local iOS Xcode Archive reads
 * `.env`. If a build path fails to inline the flag, we still get monitoring
 * rather than a false "off" banner. A failed scan (e.g. no PAYG) is caught by
 * fetchRecentApprovalLogs and returns [] — never fatal.
 */
export function isApprovalScanEnabled(): boolean {
    // @ts-ignore - process.env may have this via Expo's bundling
    return process.env.EXPO_PUBLIC_ALCHEMY_PAYG !== 'false';
}

class TransactionHistoryService {
    private static instance: TransactionHistoryService;
    private cache: Map<string, { data: Transaction[]; timestamp: number }> = new Map();
    private lastFetch: Map<string, number> = new Map();

    private constructor() {}

    static getInstance(): TransactionHistoryService {
        if (!TransactionHistoryService.instance) {
            TransactionHistoryService.instance = new TransactionHistoryService();
        }
        return TransactionHistoryService.instance;
    }

    /**
     * Get transactions for multiple addresses across chains.
     * [Fix 1C] Now accepts a map of chain→address since each chain uses different address formats.
     *
     * @param addresses - Map of chain type to address (e.g., { Base: '0x...', Arbitrum: '0x...' })
     *                    A single address can be used for Base, Arbitrum, Optimism.
     * @param options - Filtering and pagination options
     */
    async getTransactions(
        addresses: Record<ChainType, string> | string,
        options: {
            chains?: ChainType[];
            types?: TransactionType[];
            page?: number;
            limit?: number;
            filterVerified?: boolean;
        } = {}
    ): Promise<PaginatedResult<Transaction>> {
        const { chains, types, page = 1, limit = 20, filterVerified = true } = options;

        // [Fix 1C] Normalize input: support both old single-address (for backwards compat) and new map format
        const addressMap: Partial<Record<ChainType, string>> = typeof addresses === 'string'
            ? { Base: addresses, Arbitrum: addresses, Optimism: addresses }
            : addresses;

        // Use primary address (first available) for cache key
        const primaryAddress = Object.values(addressMap)[0] || '';

        // Load cached transactions
        let transactions = await this.loadCachedTransactions(primaryAddress);

        // Check if we need to refresh from APIs
        const shouldRefresh = this.shouldRefreshCache(primaryAddress);
        if (shouldRefresh) {
            const chainsToFetch = chains || ['Base', 'Arbitrum', 'Optimism', 'Solana'];
            await this.fetchFromChains(addressMap, chainsToFetch as ChainType[]);
            transactions = await this.loadCachedTransactions(primaryAddress);
        }

        // Apply filters
        let filtered = transactions;
        if (chains && chains.length > 0) {
            filtered = filtered.filter(tx => chains.includes(tx.chain));
        }
        if (types && types.length > 0) {
            // A PVT mint ('earned') belongs to the 'received' family, so the
            // Received filter still surfaces it; otherwise match type exactly.
            filtered = filtered.filter(tx =>
                types.includes(tx.type) ||
                (tx.type === 'earned' && types.includes('received')),
            );
        }
        if (filterVerified) {
            filtered = filtered.filter(isVerifiedTokenTx);
        }

        // Sort by timestamp descending
        filtered.sort((a, b) => b.timestamp - a.timestamp);

        // Paginate
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const items = filtered.slice(startIndex, endIndex);
        const hasMore = endIndex < filtered.length;

        return {
            items,
            hasMore,
            nextCursor: hasMore ? String(page + 1) : undefined,
        };
    }

    private shouldRefreshCache(address: string): boolean {
        const lastFetch = this.lastFetch.get(address);
        if (!lastFetch) return true;
        return Date.now() - lastFetch > CACHE_DURATION;
    }

    /**
     * [Fix 1C] Updated to accept address map and pass correct address per chain.
     * [Fix 1F] Added in-flight tracking to prevent duplicate concurrent fetches.
     */
    private inFlightFetches: Map<string, Promise<void>> = new Map();

    private async fetchFromChains(
        addressMap: Partial<Record<ChainType, string>>,
        chains: ChainType[]
    ): Promise<void> {
        const primaryAddress = Object.values(addressMap)[0] || '';
        const cacheKey = `fetch_${primaryAddress}`;

        // [Fix 1F] Check for in-flight fetch and share the promise
        const existingFetch = this.inFlightFetches.get(cacheKey);
        if (existingFetch) {
            return existingFetch;
        }

        const fetchPromise = (async () => {
            try {
                // [Fix 1C] Pass correct address for each chain
                const fetchPromises = chains.map(chain => {
                    const chainAddress = addressMap[chain];
                    if (!chainAddress) {
                        // Skip chains without configured address
                        return Promise.resolve([]);
                    }
                    return this.fetchFromChain(chainAddress, chain);
                });

                const results = await Promise.allSettled(fetchPromises);

                const allTransactions: Transaction[] = [];
                results.forEach((result, index) => {
                    if (result.status === 'fulfilled' && result.value) {
                        allTransactions.push(...result.value);
                    } else {
                        console.log(`[TransactionHistory] Failed to fetch from ${chains[index]}`);
                    }
                });

                // Merge with existing cache
                const existing = await this.loadCachedTransactions(primaryAddress);
                const merged = this.mergeTransactions(existing, allTransactions);
                await this.saveCachedTransactions(primaryAddress, merged);
                this.lastFetch.set(primaryAddress, Date.now());
            } finally {
                // [Fix 1F] Clean up in-flight tracking
                this.inFlightFetches.delete(cacheKey);
            }
        })();

        this.inFlightFetches.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    private async fetchFromChain(address: string, chain: ChainType): Promise<Transaction[]> {
        try {
            switch (chain) {
                case 'Base':
                case 'Arbitrum':
                case 'Optimism':
                    return await this.fetchEVMTransactions(address, chain);
                case 'Solana':
                    return await this.fetchSolanaTransactions(address);
                default:
                    return [];
            }
        } catch (error) {
            console.error(`[TransactionHistory] Error fetching ${chain}:`, error);
            return [];
        }
    }

    /**
     * Fetch Solana transaction history (native SOL + USDC-SPL transfers) for an
     * address. Reads recent signatures then the parsed transactions via Solana
     * RPC, and normalizes each into the common Transaction shape. Only SOL and
     * the canonical USDC mint are surfaced; other SPL activity is skipped to
     * avoid airdrop-spam noise (parity with the EVM verified-token filter).
     */
    private async fetchSolanaTransactions(address: string): Promise<Transaction[]> {
        const { default: solanaRpc } = await import('../chains/solana/SolanaRpc');
        const { getSolanaUsdcMint, SOL_DECIMALS, SOLANA_USDC_DECIMALS } =
            await import('../chains/solana/config');
        const usdcMint = getSolanaUsdcMint();

        const sigs = await solanaRpc.getSignaturesForAddress(address, 20);
        if (sigs.length === 0) return [];

        const parsed = await Promise.allSettled(
            sigs.map(s =>
                solanaRpc.getParsedTransaction(s.signature).then(p => ({ sig: s, parsed: p })),
            ),
        );

        const out: Transaction[] = [];
        for (const r of parsed) {
            if (r.status !== 'fulfilled' || !r.value.parsed) continue;
            const tx = this.normalizeSolanaTransaction(
                r.value.sig,
                r.value.parsed,
                address,
                usdcMint,
                SOL_DECIMALS,
                SOLANA_USDC_DECIMALS,
            );
            if (tx) out.push(tx);
        }
        return out;
    }

    private normalizeSolanaTransaction(
        sig: { signature: string; slot: number; blockTime: number | null; err: unknown | null },
        tx: import('../chains/solana/SolanaRpc').SolanaParsedTx,
        user: string,
        usdcMint: string,
        solDecimals: number,
        usdcDecimals: number,
    ): Transaction | null {
        const meta = tx.meta;
        if (!meta) return null;
        const status: TransactionStatus = meta.err ? 'failed' : 'confirmed';
        const feeLamports = BigInt(meta.fee ?? 0);
        const timestamp = (sig.blockTime ?? tx.blockTime ?? 0) * 1000;

        const accountKeys = tx.transaction.message.accountKeys.map(k =>
            typeof k === 'string' ? k : k.pubkey,
        );
        const userIdx = accountKeys.indexOf(user);

        // ── USDC (SPL) delta, owner-based ──
        const ownerUsdc = (
            entries: import('../chains/solana/SolanaRpc').TokenBalanceEntry[] | undefined,
            owner: string,
        ): bigint => {
            let sum = 0n;
            for (const e of entries ?? []) {
                if (e.owner === owner && e.mint === usdcMint) sum += BigInt(e.uiTokenAmount.amount);
            }
            return sum;
        };
        const usdcDelta =
            ownerUsdc(meta.postTokenBalances, user) - ownerUsdc(meta.preTokenBalances, user);

        if (usdcDelta !== 0n) {
            const received = usdcDelta > 0n;
            const amountAtomic = received ? usdcDelta : -usdcDelta;
            const counterparty = this.findUsdcCounterparty(meta, user, usdcMint, received);
            return {
                id: sig.signature,
                hash: sig.signature,
                type: received ? 'received' : 'sent',
                status,
                chain: 'Solana',
                from: received ? counterparty ?? '' : user,
                to: received ? user : counterparty ?? '',
                amount: ethers.formatUnits(amountAtomic, usdcDecimals),
                symbol: 'USDC',
                contractAddress: usdcMint,
                isVerifiedToken: true,
                fee: ethers.formatUnits(feeLamports, solDecimals),
                feeSymbol: 'SOL',
                timestamp,
                blockNumber: sig.slot,
            };
        }

        // ── Native SOL delta ──
        const solDelta =
            userIdx >= 0
                ? BigInt(meta.postBalances[userIdx] ?? 0) - BigInt(meta.preBalances[userIdx] ?? 0)
                : 0n;
        // A change of only the fee (fee payer interacting with a program, no
        // transfer) is not a send — skip it to avoid noise.
        if (solDelta === 0n || (solDelta < 0n && -solDelta <= feeLamports && userIdx === 0)) {
            return null;
        }
        const received = solDelta > 0n;
        let amountAtomic = received ? solDelta : -solDelta;
        // For a send, the fee payer's delta includes the fee; back it out.
        if (!received && userIdx === 0) {
            amountAtomic = amountAtomic - feeLamports;
            if (amountAtomic < 0n) amountAtomic = 0n;
        }
        const counterparty = this.findSystemCounterparty(tx, user, received);
        return {
            id: sig.signature,
            hash: sig.signature,
            type: received ? 'received' : 'sent',
            status,
            chain: 'Solana',
            from: received ? counterparty ?? '' : user,
            to: received ? user : counterparty ?? '',
            amount: ethers.formatUnits(amountAtomic, solDecimals),
            symbol: 'SOL',
            fee: ethers.formatUnits(feeLamports, solDecimals),
            feeSymbol: 'SOL',
            timestamp,
            blockNumber: sig.slot,
        };
    }

    /** Find the USDC counterparty owner (opposite-sign delta) for display. */
    private findUsdcCounterparty(
        meta: NonNullable<import('../chains/solana/SolanaRpc').SolanaParsedTx['meta']>,
        user: string,
        usdcMint: string,
        userReceived: boolean,
    ): string | undefined {
        const deltas = new Map<string, bigint>();
        const add = (
            entries: import('../chains/solana/SolanaRpc').TokenBalanceEntry[] | undefined,
            sign: bigint,
        ) => {
            for (const e of entries ?? []) {
                if (e.mint !== usdcMint || !e.owner || e.owner === user) continue;
                deltas.set(e.owner, (deltas.get(e.owner) ?? 0n) + sign * BigInt(e.uiTokenAmount.amount));
            }
        };
        add(meta.postTokenBalances, 1n);
        add(meta.preTokenBalances, -1n);
        // If the user received, the counterparty's delta is negative, and vice-versa.
        for (const [owner, d] of deltas) {
            if (userReceived ? d < 0n : d > 0n) return owner;
        }
        return undefined;
    }

    /** Find the SystemProgram transfer counterparty (owner-level addresses). */
    private findSystemCounterparty(
        tx: import('../chains/solana/SolanaRpc').SolanaParsedTx,
        user: string,
        userReceived: boolean,
    ): string | undefined {
        for (const ix of tx.transaction.message.instructions) {
            if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                const info = ix.parsed.info as { source?: string; destination?: string } | undefined;
                if (!info) continue;
                if (userReceived && info.destination === user) return info.source;
                if (!userReceived && info.source === user) return info.destination;
            }
        }
        return undefined;
    }

    /**
     * Fetch EVM transactions including both native transfers and ERC-20 token transfers.
     * Routes through backend proxy which holds the API keys.
     */
    private async fetchEVMTransactions(address: string, chain: ChainType): Promise<Transaction[]> {
        const alchemyNetwork = CHAIN_TO_ALCHEMY_NETWORK[chain];
        if (!alchemyNetwork) return [];

        // [Etherscan migration] Switched from the deprecated Etherscan v1
        // explorer proxy (`/api/proxy/explorer/...`) to Alchemy's
        // alchemy_getAssetTransfers via the existing JSON-RPC proxy.
        //
        // Why: Etherscan v1 was deprecated early 2025 and now returns
        // "deprecated V1 endpoint" errors. The v2 multichain replacement
        // does not include Base on the free tier. Alchemy's free tier
        // covers Base/Arbitrum/Optimism/Ethereum and returns
        // pre-decoded transfer data in a single call.
        //
        // Known limitation: Alchemy does not track `internal` transfers on
        // Base/Arbitrum/Optimism (only Ethereum + Polygon). That means ETH
        // received from a contract execution (e.g., the ETH side of a
        // USDC→ETH swap that goes through a router) won't appear in the
        // transfer list. The user's balance still reflects the receipt;
        // the line item just doesn't show. Acceptable trade-off for the
        // free indexer; can be supplemented with eth_getLogs on
        // WETH.Withdrawal events later if needed.

        const transactions: Transaction[] = [];

        try {
            // Two parallel calls: one for transfers OUT, one for transfers IN.
            // Alchemy doesn't have a single "all transfers for this address" call.
            const baseParams = {
                fromBlock: '0x0',
                toBlock: 'latest',
                category: ['external', 'erc20', 'erc721', 'erc1155'],
                order: 'desc' as const,
                maxCount: '0x32', // 50 results per direction
                withMetadata: true,
                excludeZeroValue: true,
            };

            const [outResp, inResp, latestBlockResp] = await Promise.all([
                this.alchemyRpc(alchemyNetwork, 'alchemy_getAssetTransfers', [{
                    ...baseParams,
                    fromAddress: address,
                }]),
                this.alchemyRpc(alchemyNetwork, 'alchemy_getAssetTransfers', [{
                    ...baseParams,
                    toAddress: address,
                }]),
                // Used as the upper bound for the recent-Approval scan below.
                this.alchemyRpc(alchemyNetwork, 'eth_blockNumber', []),
            ]);

            const outTransfers = outResp?.result?.transfers ?? [];
            const inTransfers = inResp?.result?.transfers ?? [];

            // Dedupe by (hash, log index, asset). Same hash can appear in both
            // directions for swaps where the user's wallet both sends and
            // receives within the same tx.
            const seen = new Set<string>();
            for (const t of [...outTransfers, ...inTransfers]) {
                const key = `${t.hash}:${t.uniqueId ?? ''}:${t.asset ?? ''}:${t.from?.toLowerCase()}:${t.to?.toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                transactions.push(this.normalizeAlchemyTransfer(t, chain, address));
            }

            // [Nice-to-have #1] Internal ETH receipts from swap unwraps.
            // For each unique outgoing tx hash where the user sent an ERC-20,
            // fetch the receipt and look for a WETH.Withdrawal event from the
            // chain's canonical WETH contract. If found, the user received that
            // amount of native ETH as the swap output. Adds a synthetic
            // 'received ETH' entry that wouldn't otherwise appear because
            // Alchemy doesn't track internal transfers on Base/Arb/Op.
            const wethSupplements = await this.fetchWethUnwrapReceipts(
                alchemyNetwork,
                chain,
                outTransfers,
                address,
            );
            transactions.push(...wethSupplements);

            // [Nice-to-have #2] Approval events. The asset-transfer endpoint
            // is "transfers only" by design - approve() calls don't move
            // tokens and so don't appear. Query Approval events directly via
            // eth_getLogs over a recent block window so the user can see
            // their token approvals in the activity history.
            const latestBlockHex = latestBlockResp?.result;
            if (latestBlockHex) {
                const approvals = await this.fetchRecentApprovalLogs(
                    alchemyNetwork,
                    chain,
                    address,
                    latestBlockHex,
                );
                transactions.push(...approvals);
            }

            // Merge swap pairs: any tx hash with both a sent and a received
            // entry (including WETH-unwrap synthetic receives) is a DEX swap.
            // Collapse them into a single 'swap' Transaction so the user sees
            // "5.00 USDC → 0.0024 ETH" instead of separate Sent/Received rows.
            const merged = this.mergeSwapPairs(transactions);

            // Sort newest first
            merged.sort((a, b) => b.timestamp - a.timestamp);

            return merged;
        } catch (error) {
            console.error(`[TransactionHistory] EVM fetch error for ${chain}:`, error);
            return transactions;
        }
    }

    /**
     * Group transfers by tx hash; if a hash has both an outgoing and an
     * incoming entry, merge them into a single swap entry. Approval entries
     * and unmatched transfers are passed through unchanged.
     */
    private mergeSwapPairs(transactions: Transaction[]): Transaction[] {
        const byHash = new Map<string, Transaction[]>();
        const passthrough: Transaction[] = [];
        for (const tx of transactions) {
            // Approvals share no hash with anything; keep them out of the merge.
            if (tx.type === 'approve' || !tx.hash) {
                passthrough.push(tx);
                continue;
            }
            const group = byHash.get(tx.hash) ?? [];
            group.push(tx);
            byHash.set(tx.hash, group);
        }

        const out: Transaction[] = [...passthrough];
        for (const [, group] of byHash) {
            const sent = group.find(t => t.type === 'sent');
            const received = group.find(t => t.type === 'received');
            // Require the two legs to be DIFFERENT assets before calling it a
            // swap. A tx that sends token A and refunds token A in the same hash
            // (fee-on-transfer dust, failed-router fallback) is not a DEX swap
            // and should not be mislabeled as "A -> A" (review #37).
            if (sent && received && group.length >= 2 && sent.symbol !== received.symbol) {
                out.push({
                    ...sent,
                    type: 'swap',
                    swapFromSymbol: sent.symbol,
                    swapFromAmount: sent.amount,
                    swapToSymbol: received.symbol,
                    swapToAmount: received.amount,
                    // Display amount/symbol on the swap row defaults to the
                    // outgoing leg so existing list renderers don't break.
                });
            } else {
                out.push(...group);
            }
        }
        return out;
    }

    /**
     * [Nice-to-have #1] For each unique outgoing tx hash where the user sent
     * an ERC-20, fetch the receipt and look for a WETH.Withdrawal event from
     * the chain's canonical WETH contract. Each match becomes a synthetic
     * "received ETH" Transaction so the user can see the ETH side of a
     * token-for-ETH swap.
     *
     * Heuristic: in a single-router swap (USDC → WETH → unwrap → ETH → user),
     * the Withdrawal.wad equals the ETH the user receives. For multi-hop
     * swaps where multiple intermediate routers unwrap, this can over-count
     * by a small amount, but the error is small and the alternative
     * (per-tx debug_traceTransaction) is heavy and not on Alchemy free tier.
     */
    private async fetchWethUnwrapReceipts(
        alchemyNetwork: string,
        chain: ChainType,
        outTransfers: any[],
        userAddress: string,
    ): Promise<Transaction[]> {
        const wethAddr = WETH_ADDRESSES[chain]?.toLowerCase();
        if (!wethAddr) return [];

        // Only ERC-20 outputs are swap candidates (a native ETH outgoing
        // wouldn't unwrap WETH on receipt).
        const swapHashes = new Set<string>();
        for (const t of outTransfers) {
            if (t.category === 'erc20' && t.hash) swapHashes.add(t.hash);
        }
        if (swapHashes.size === 0) return [];

        // Fetch all receipts in parallel - typically a small list (<10).
        const receipts = await Promise.all(
            Array.from(swapHashes).map(hash =>
                this.alchemyRpc(alchemyNetwork, 'eth_getTransactionReceipt', [hash]),
            ),
        );

        const out: Transaction[] = [];
        for (const resp of receipts) {
            const receipt = resp?.result;
            if (!receipt || !Array.isArray(receipt.logs)) continue;

            // Sum all WETH.Withdrawal events in this tx - there can be more
            // than one in multi-hop swaps. Each event's `wad` is in the data
            // field as a 32-byte hex int.
            let totalWei = 0n;
            for (const log of receipt.logs) {
                if (
                    log.address?.toLowerCase() === wethAddr &&
                    log.topics?.[0]?.toLowerCase() === TOPIC_WETH_WITHDRAWAL
                ) {
                    try {
                        totalWei += BigInt(log.data);
                    } catch { /* skip malformed */ }
                }
            }
            if (totalWei === 0n) continue;

            const ethAmount = parseFloat(ethers.formatEther(totalWei));
            if (!Number.isFinite(ethAmount) || ethAmount <= 0) continue;

            // Resolve the timestamp from the block. We don't have it on the
            // receipt directly - fetch the block by number for the timestamp.
            const blockNumberHex = receipt.blockNumber;
            const blockResp = await this.alchemyRpc(alchemyNetwork, 'eth_getBlockByNumber', [blockNumberHex, false]);
            const blockTsHex = blockResp?.result?.timestamp;
            const timestamp = blockTsHex ? parseInt(blockTsHex, 16) * 1000 : Date.now();

            // The `from` address for display: prefer the actual router that
            // called withdraw() on WETH (the indexed src field of the
            // Withdrawal event in topic1). Falls back to the receipt's `to`
            // (the address the user submitted the tx to), which is normally
            // the same router or aggregator. Setting this to a real address
            // (rather than a literal string like "Swap") makes the activity
            // entry clean to render and lets users tap through to the
            // counterparty in any future explorer view.
            let routerAddress = receipt.to as string;
            for (const log of receipt.logs) {
                if (
                    log.address?.toLowerCase() === wethAddr &&
                    log.topics?.[0]?.toLowerCase() === TOPIC_WETH_WITHDRAWAL &&
                    log.topics?.[1]
                ) {
                    routerAddress = '0x' + log.topics[1].slice(-40);
                    break;
                }
            }

            console.log(`[TransactionHistory] WETH unwrap: tx ${receipt.transactionHash.slice(0, 10)}… → ${ethAmount.toFixed(6)} ${CHAIN_NATIVE_SYMBOLS[chain]} on ${chain}`);

            out.push({
                id: `${chain}-${receipt.transactionHash}-weth-unwrap`,
                hash: receipt.transactionHash,
                type: 'received',
                status: 'confirmed',
                chain,
                from: routerAddress,
                to: userAddress,
                amount: ethAmount.toFixed(8),
                symbol: CHAIN_NATIVE_SYMBOLS[chain],
                fee: undefined,
                feeSymbol: CHAIN_NATIVE_SYMBOLS[chain],
                timestamp,
                blockNumber: blockNumberHex ? parseInt(blockNumberHex, 16) : undefined,
            });
        }
        return out;
    }

    /**
     * [Nice-to-have #2] Fetch ERC-20 Approval events emitted by ANY contract
     * where the indexed `owner` topic matches the user's address. Adds each
     * match to the transaction history as a synthetic 'approve' entry.
     *
     * Limited to a recent block window (~24h on Base) to keep the call within
     * Alchemy free-tier eth_getLogs constraints (10k blocks per call). The
     * approve() flow is rare enough that a 24h window covers most user-visible
     * activity; older approvals can still be revoked from a dedicated security
     * screen if/when one is built.
     */
    private async fetchRecentApprovalLogs(
        alchemyNetwork: string,
        chain: ChainType,
        userAddress: string,
        latestBlockHex: string,
    ): Promise<Transaction[]> {
        // Feature-gated: requires Alchemy Pay-As-You-Go plan. On Free tier
        // Alchemy caps eth_getLogs at 10 blocks per call (downgraded from
        // 10,000 in early 2026) which makes any useful scan impossible.
        // Return empty silently - the dashboard renders a distinct "scanning
        // disabled" card when isApprovalScanEnabled() is false, instead of
        // a misleading "no approvals found" empty state.
        if (!isApprovalScanEnabled()) {
            return [];
        }

        try {
            const latest = parseInt(latestBlockHex, 16);
            if (!Number.isFinite(latest) || latest <= 0) return [];

            const fromBlock = Math.max(0, latest - APPROVAL_LOG_BLOCK_WINDOW);
            // ERC-20 Approval has owner as topic1 and spender as topic2.
            // Pad the user address to 32 bytes for the topic filter.
            const ownerTopic = '0x' + userAddress.toLowerCase().replace('0x', '').padStart(64, '0');

            const resp = await this.alchemyRpc(alchemyNetwork, 'eth_getLogs', [{
                fromBlock: '0x' + fromBlock.toString(16),
                toBlock: latestBlockHex,
                topics: [TOPIC_ERC20_APPROVAL, ownerTopic],
            }]);

            const logs: any[] = resp?.result ?? [];
            if (logs.length === 0) return [];

            // Resolve unique block timestamps with a single batch - same block
            // can host multiple approvals.
            const uniqueBlocks = Array.from(new Set(logs.map(l => l.blockNumber).filter(Boolean)));
            const blockResps = await Promise.all(
                uniqueBlocks.map(bn => this.alchemyRpc(alchemyNetwork, 'eth_getBlockByNumber', [bn, false])),
            );
            const blockTs = new Map<string, number>();
            uniqueBlocks.forEach((bn, i) => {
                const ts = blockResps[i]?.result?.timestamp;
                if (ts) blockTs.set(bn, parseInt(ts, 16) * 1000);
            });

            const out: Transaction[] = [];
            for (const log of logs) {
                const tokenContract = (log.address || '').toLowerCase();
                const spenderTopic = log.topics?.[2] || '';
                const spender = '0x' + spenderTopic.slice(-40);
                let amountWei = 0n;
                try { amountWei = BigInt(log.data); } catch { /* skip */ }

                const isUnlimited = amountWei > BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') / 2n;

                out.push({
                    id: `${chain}-${log.transactionHash}-approve-${log.logIndex}`,
                    hash: log.transactionHash,
                    type: 'approve',
                    status: 'confirmed',
                    chain,
                    from: userAddress,
                    to: spender,
                    amount: isUnlimited ? 'Unlimited' : amountWei.toString(),
                    // We don't know the symbol for an arbitrary ERC-20 from the
                    // log alone - would need a second call to token.symbol().
                    // Leaving this generic; UI can resolve later if needed.
                    symbol: tokenContract.slice(0, 8) + '…',
                    contractAddress: tokenContract,
                    isVerifiedToken: isVerifiedContractAt(
                        tokenContract,
                        log.blockNumber ? parseInt(log.blockNumber, 16) : undefined,
                    ),
                    fee: undefined,
                    feeSymbol: CHAIN_NATIVE_SYMBOLS[chain],
                    timestamp: blockTs.get(log.blockNumber) ?? Date.now(),
                    blockNumber: log.blockNumber ? parseInt(log.blockNumber, 16) : undefined,
                });
            }
            return out;
        } catch (err) {
            console.warn(`[TransactionHistory] Approval log fetch failed for ${chain}:`, err);
            return [];
        }
    }

    /**
     * POST a JSON-RPC call to Alchemy via the backend proxy.
     */
    private async alchemyRpc(network: string, method: string, params: unknown[]): Promise<any> {
        const url = await ProxyConfig.getAlchemyRpcUrl(network as any);
        const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
        const headers = await ProxyConfig.getProxyHeaders('POST', new URL(url).pathname, body, 'alchemy');
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body,
        });
        if (!res.ok) {
            console.warn(`[TransactionHistory] Alchemy proxy returned ${res.status} for ${method} on ${network}`);
            return null;
        }
        const data = await res.json();
        if (data?.error) {
            console.warn(`[TransactionHistory] Alchemy ${method} error on ${network}:`, data.error);
            return null;
        }
        return data;
    }

    /**
     * Convert an Alchemy AssetTransfer to the wallet's normalized Transaction
     * shape. Alchemy already pre-decodes value/asset for ERC-20 and native
     * transfers, so the conversion is mostly field-renaming + filling in the
     * sent/received direction relative to the user's address.
     */
    private normalizeAlchemyTransfer(t: any, chain: ChainType, userAddress: string): Transaction {
        const isReceived = (t.to ?? '').toLowerCase() === userAddress.toLowerCase();
        // Alchemy returns blockTimestamp as ISO 8601 string in metadata.blockTimestamp
        const isoTs = t.metadata?.blockTimestamp;
        const timestampMs = isoTs ? new Date(isoTs).getTime() : Date.now();
        // Native ETH ('external' category) returns asset='ETH' and value as a JS number.
        // ERC-20 returns asset=token symbol and value as a number (already decimal-adjusted).
        // ERC-721/1155 returns value=null and erc721TokenId / erc1155Metadata for the id.
        const value = typeof t.value === 'number' ? t.value : (t.value ? Number(t.value) : 0);
        const symbol: string = t.asset || CHAIN_NATIVE_SYMBOLS[chain];
        const blockNumber = t.blockNum ? parseInt(t.blockNum, 16) : undefined;

        // [Spam filter] ERC-20/721 transfers carry the token's contract
        // address in t.rawContract.address. Native (external) transfers do
        // not. Preserve it on the Transaction so the verified-token filter
        // and any UI badges have it available.
        const contractAddress: string | undefined = t.rawContract?.address || undefined;
        const verified = contractAddress
            ? isVerifiedContractAt(contractAddress, blockNumber)
            : true; // native currency is always "verified"

        // A PVT earning arrives on-chain as an incoming ERC-20 transfer FROM the
        // zero address (a mint) emitted by the PVT9 kernel. Surface it as
        // 'earned' rather than a generic "Received from 0x0000…". (Spoof-resistant:
        // matched on the pinned PVT9 contract address, not the 'PVT' symbol.)
        // a mint on the retired kernel is still this wallet's earning history.
        const isPvtMint = [PVT9_TOKEN.address, PREDECESSOR_PVT9_KERNEL_FOR_HISTORY].some((pvtAddress) =>
            isPvtMintTransfer({ isReceived, from: t.from, contractAddress, pvtAddress }));
        const type: TransactionType = isPvtMint ? 'earned' : isReceived ? 'received' : 'sent';
        const isMigrationReceipt = isPvtMigrationReceipt({
            isReceived,
            from: t.from,
            contractAddress,
            distributorAddress: PVT_MIGRATION_DISTRIBUTOR,
            pvtAddress: PVT9_TOKEN.address,
        });

        return {
            id: `${chain}-${t.hash}-${t.uniqueId ?? `${t.from}-${t.to}-${t.asset}`}`,
            hash: t.hash,
            type,
            // Alchemy only returns successful transfers, so status is always confirmed.
            status: 'confirmed',
            chain,
            from: t.from || 'Unknown',
            to: t.to || 'Unknown',
            amount: Number.isFinite(value) ? value.toFixed(Math.min(8, 18)) : '0',
            symbol,
            contractAddress,
            isVerifiedToken: verified,
            isMigrationReceipt,
            isRetiredPvt: isRetiredPvtContract(contractAddress),
            // Gas info is not part of getAssetTransfers; would need a separate
            // eth_getTransactionReceipt call. Omitted for now to keep the
            // history fetch fast - clicking through to a block explorer link
            // gives users the full receipt.
            fee: undefined,
            feeSymbol: CHAIN_NATIVE_SYMBOLS[chain],
            timestamp: timestampMs,
            blockNumber,
        };
    }

    /**
     * [Fix 1A] Normalize ERC-20 token transaction from Etherscan tokentx API.
     */
    private normalizeERC20Transaction(tx: any, chain: ChainType, userAddress: string): Transaction {
        const isReceived = tx.to.toLowerCase() === userAddress.toLowerCase();
        const decimals = parseInt(tx.tokenDecimal) || 18;
        const value = parseFloat(tx.value) / Math.pow(10, decimals);

        return {
            id: `${chain}-token-${tx.hash}-${tx.tokenSymbol}`,
            hash: tx.hash,
            type: isReceived ? 'received' : 'sent',
            status: tx.txreceipt_status === '1' ? 'confirmed' : tx.txreceipt_status === '0' ? 'failed' : 'pending',
            chain,
            from: tx.from,
            to: tx.to,
            amount: value.toFixed(Math.min(decimals, 8)),
            symbol: tx.tokenSymbol || 'UNKNOWN',  // [Fix 1B] Use actual token symbol from API
            fee: formatEVMGasFee(tx.gasUsed, tx.gasPrice),
            feeSymbol: CHAIN_NATIVE_SYMBOLS[chain],  // [Fix 1B] Use chain-specific gas token
            timestamp: parseInt(tx.timeStamp) * 1000,
            blockNumber: parseInt(tx.blockNumber),
            confirmations: parseInt(tx.confirmations),
        };
    }

    /**
     * [Fix 1B] Updated to use chain-specific native symbol.
     */
    private normalizeEVMTransaction(tx: any, chain: ChainType, userAddress: string): Transaction {
        const isReceived = tx.to.toLowerCase() === userAddress.toLowerCase();
        const value = parseFloat(tx.value) / 1e18;
        const nativeSymbol = CHAIN_NATIVE_SYMBOLS[chain];

        return {
            id: `${chain}-${tx.hash}`,
            hash: tx.hash,
            type: isReceived ? 'received' : 'sent',
            status: tx.txreceipt_status === '1' ? 'confirmed' : tx.txreceipt_status === '0' ? 'failed' : 'pending',
            chain,
            from: tx.from,
            to: tx.to,
            amount: value.toFixed(6),
            symbol: nativeSymbol,  // [Fix 1B] Chain-specific symbol
            fee: formatEVMGasFee(tx.gasUsed, tx.gasPrice),
            feeSymbol: nativeSymbol,  // [Fix 1B] Chain-specific fee symbol
            timestamp: parseInt(tx.timeStamp) * 1000,
            blockNumber: parseInt(tx.blockNumber),
            confirmations: parseInt(tx.confirmations),
        };
    }

    // Solana history is handled by fetchSolanaTransactions (above). Bitcoin and
    // Tron are not supported.

    private mergeTransactions(existing: Transaction[], incoming: Transaction[]): Transaction[] {
        return mergeTransactionLists(existing, incoming);
    }

    private async loadCachedTransactions(address: string): Promise<Transaction[]> {
        try {
            const key = `${STORAGE_KEY}_${address}`;
            const cached = await AsyncStorage.getItem(key);
            return cached ? JSON.parse(cached) : [];
        } catch (error) {
            console.error('[TransactionHistory] Cache load error:', error);
            return [];
        }
    }

    private async saveCachedTransactions(address: string, transactions: Transaction[]): Promise<void> {
        try {
            const key = `${STORAGE_KEY}_${address}`;
            await AsyncStorage.setItem(key, JSON.stringify(transactions));
        } catch (error) {
            console.error('[TransactionHistory] Cache save error:', error);
        }
    }

    /**
     * Surface a just-sent transfer before the indexer returns it. `cacheOwner` is the address the
     * history is READ under (the wallet's primary EVM address): a Solana send is FROM the Solana
     * address, and a row cached under that key was never read — the send stayed invisible until the
     * indexer caught up (2026-10-17 bug check).
     */
    async addLocalTransaction(transaction: Omit<Transaction, 'id'>, cacheOwner?: string): Promise<Transaction> {
        const tx: Transaction = {
            ...transaction,
            id: `local-${uuidv4()}`,
        };

        const address = cacheOwner && cacheOwner.length > 0 ? cacheOwner : transaction.from;
        const existing = await this.loadCachedTransactions(address);
        existing.unshift(tx);
        await this.saveCachedTransactions(address, existing);

        return tx;
    }

    /**
     * [Fix 1E] Optimized to search only relevant chain's cache if address is known.
     * Falls back to iterating all caches only if necessary.
     */
    async getTransactionByHash(
        hash: string,
        chain: ChainType,
        address?: string
    ): Promise<Transaction | null> {
        // If address is provided, search only that cache
        if (address) {
            const transactions = await this.loadCachedTransactions(address);
            const found = transactions.find(tx => tx.hash === hash && tx.chain === chain);
            if (found) return found;
        }

        // Fall back to searching all caches (but only ones with our prefix)
        const keys = await AsyncStorage.getAllKeys();
        const txKeys = keys.filter(key => key.startsWith(STORAGE_KEY));

        for (const key of txKeys) {
            const data = await AsyncStorage.getItem(key);
            if (data) {
                const parsed: Transaction[] = JSON.parse(data);
                const found = parsed.find(tx => tx.hash === hash && tx.chain === chain);
                if (found) return found;
            }
        }
        return null;
    }

    async refreshTransactions(addresses: Record<ChainType, string> | string): Promise<void> {
        const primaryAddress = typeof addresses === 'string' ? addresses : (Object.values(addresses)[0] || '');
        this.lastFetch.delete(primaryAddress);
        await this.getTransactions(addresses, { page: 1, limit: 20 });
    }

    getExplorerUrl(hash: string, chain: ChainType): string {
        const explorers: Record<ChainType, string> = {
            Base: `https://basescan.org/tx/${hash}`,
            Arbitrum: `https://arbiscan.io/tx/${hash}`,
            Optimism: `https://optimistic.etherscan.io/tx/${hash}`,
            Solana: `https://solscan.io/tx/${hash}`,
        };
        return explorers[chain];
    }
}

export { mergeTransactionLists, isLocalTransactionRow } from './mergeTransactionLists';

export default TransactionHistoryService.getInstance();
