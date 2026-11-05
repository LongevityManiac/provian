/**
 * Solana JSON-RPC client.
 *
 * Routes through the relay's Alchemy proxy (authenticated, keyed, rate-limited)
 * exactly like EVM history, with a pinned public-cluster RPC as a fail-safe
 * fallback so read/broadcast still works if the proxy is unavailable (or before
 * the backend proxy allowlist ships). No private key ever transits this module —
 * transactions arrive here already signed.
 *
 * Only the JSON-RPC methods the wallet needs (balances, blockhash, fee, send,
 * history) are implemented. Objects (PublicKey/Transaction) are built with
 * @solana/web3.js elsewhere; this module only speaks the wire protocol.
 */

import ProxyConfig from '../../../services/ProxyConfig';
import { apiFetch } from '../../network/apiFetch';
import { getActiveSolanaCluster } from './config';

interface JsonRpcResponse<T> {
    jsonrpc: '2.0';
    id: number | string;
    result?: T;
    error?: { code: number; message: string };
}

export interface LatestBlockhash {
    blockhash: string;
    lastValidBlockHeight: number;
}

export interface SplTokenBalance {
    /** Atomic amount as a decimal string. */
    amount: string;
    decimals: number;
    /** UI amount as a string (already scaled by decimals). */
    uiAmountString: string;
}

export interface SignatureInfo {
    signature: string;
    slot: number;
    err: unknown | null;
    blockTime: number | null;
}

let rpcId = 0;

export class SolanaRpc {
    /**
     * Issue a JSON-RPC call. Tries the relay proxy first; on any failure falls
     * back to the pinned public cluster RPC. Throws if BOTH fail, or if the RPC
     * returns an `error` object (fail closed — a null/garbage result is never
     * treated as success).
     */
    private async call<T>(method: string, params: unknown[]): Promise<T> {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: ++rpcId,
            method,
            params,
        });

        // 1) Relay proxy (primary).
        try {
            const cluster = getActiveSolanaCluster();
            const res = await ProxyConfig.proxyFetch(
                'alchemy',
                `rpc/${cluster.alchemyNetwork}`,
                { method: 'POST', body },
            );
            if (res.ok) {
                const json = (await res.json()) as JsonRpcResponse<T>;
                if (json.error) {
                    throw new Error(`Solana RPC error ${json.error.code}: ${json.error.message}`);
                }
                return json.result as T;
            }
            // Non-OK proxy response: fall through to public RPC.
        } catch {
            // Proxy path failed (network / not-configured): fall through.
        }

        // 2) Pinned public cluster RPC (fallback).
        const cluster = getActiveSolanaCluster();
        const res = await apiFetch(cluster.fallbackRpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        if (!res.ok) {
            throw new Error(`Solana RPC HTTP ${res.status} (${method})`);
        }
        const json = (await res.json()) as JsonRpcResponse<T>;
        if (json.error) {
            throw new Error(`Solana RPC error ${json.error.code}: ${json.error.message}`);
        }
        if (json.result === undefined) {
            throw new Error(`Solana RPC empty result (${method})`);
        }
        return json.result;
    }

    /** Native SOL balance in lamports. */
    async getBalanceLamports(address: string): Promise<number> {
        const result = await this.call<{ value: number }>('getBalance', [
            address,
            { commitment: 'confirmed' },
        ]);
        return result.value ?? 0;
    }

    /**
     * SPL token balance for (owner, mint). Returns null if the owner holds no
     * token account for the mint. Sums across accounts (normally exactly one
     * associated token account).
     */
    async getSplTokenBalance(owner: string, mint: string): Promise<SplTokenBalance | null> {
        const result = await this.call<{
            value: Array<{
                account: {
                    data: {
                        parsed: {
                            info: { tokenAmount: { amount: string; decimals: number; uiAmountString: string } };
                        };
                    };
                };
            }>;
        }>('getTokenAccountsByOwner', [
            owner,
            { mint },
            { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]);

        const accounts = result?.value ?? [];
        if (accounts.length === 0) {
            return null;
        }
        let total = 0n;
        let decimals = 0;
        for (const acct of accounts) {
            const ta = acct.account.data.parsed.info.tokenAmount;
            total += BigInt(ta.amount);
            decimals = ta.decimals;
        }
        const uiAmountString = formatAtomic(total, decimals);
        return { amount: total.toString(), decimals, uiAmountString };
    }

    /**
     * A token mint as the RPC parses it: the program that owns it and, for Token-2022, its
     * extensions by name. Null when the account does not exist.
     */
    async getMintParsed(mint: string): Promise<{ owner: string; extensions: Array<{ extension: string; state?: Record<string, unknown> }> } | null> {
        const result = await this.call<{
            value: {
                owner: string;
                data: { parsed?: { type?: string; info?: { extensions?: Array<{ extension: string; state?: Record<string, unknown> }> } } } | [string, string];
            } | null;
        }>('getAccountInfo', [mint, { commitment: 'confirmed', encoding: 'jsonParsed' }]);
        const v = result?.value;
        if (!v) return null;
        const parsed = Array.isArray(v.data) ? undefined : v.data.parsed;
        if (parsed?.type !== 'mint') throw new Error('Not a Solana token mint');
        return { owner: v.owner, extensions: parsed.info?.extensions ?? [] };
    }

    /**
     * [] An account's owner and raw data, read from the pinned public cluster RPC ONLY —
     * never through the relay. The swap signing guard resolves a transaction's address lookup
     * tables with this, so the relay that served the transaction is not also the witness of what
     * the transaction's accounts are. Null when the account does not exist; throws on any RPC
     * failure (the caller refuses to sign).
     */
    async getAccountInfoDirect(address: string): Promise<{ owner: string; data: string } | null> {
        const cluster = getActiveSolanaCluster();
        const res = await apiFetch(cluster.fallbackRpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: ++rpcId,
                method: 'getAccountInfo',
                params: [address, { commitment: 'confirmed', encoding: 'base64' }],
            }),
        });
        if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status} (getAccountInfo)`);
        const json = (await res.json()) as JsonRpcResponse<{ value: { owner: string; data: [string, string] } | null }>;
        if (json.error) throw new Error(`Solana RPC error ${json.error.code}: ${json.error.message}`);
        const v = json.result?.value;
        if (v === undefined) throw new Error('Solana RPC empty result (getAccountInfo)');
        if (v === null) return null;
        if (typeof v.owner !== 'string' || !Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string') {
            throw new Error('Solana RPC returned a malformed account');
        }
        return { owner: v.owner, data: v.data[0] };
    }

    /** Lamports an account of `size` bytes must hold to be rent-exempt. */
    async getMinimumBalanceForRentExemption(size: number): Promise<number> {
        const v = await this.call<number>('getMinimumBalanceForRentExemption', [size, { commitment: 'confirmed' }]);
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
            throw new Error('Solana RPC returned an invalid rent-exempt minimum');
        }
        return v;
    }

    /**
     * Whether an account exists on-chain (non-null owner). Used to decide
     * whether a recipient's associated token account must be created as part of
     * an SPL transfer. On RPC failure returns null (unknown) so the caller can
     * fail closed rather than assume existence.
     */
    async accountExists(address: string): Promise<boolean | null> {
        try {
            const result = await this.call<{ value: unknown | null }>('getAccountInfo', [
                address,
                { commitment: 'confirmed', encoding: 'base64' },
            ]);
            return result?.value != null;
        } catch {
            return null;
        }
    }

    /** Recent blockhash for building a transaction. */
    async getLatestBlockhash(): Promise<LatestBlockhash> {
        const result = await this.call<{ value: LatestBlockhash }>('getLatestBlockhash', [
            { commitment: 'confirmed' },
        ]);
        return result.value;
    }

    /**
     * Fee (in lamports) for a base64-encoded compiled message. Returns null if
     * the RPC cannot price it (caller applies a conservative static estimate).
     */
    async getFeeForMessage(base64Message: string): Promise<number | null> {
        try {
            const result = await this.call<{ value: number | null }>('getFeeForMessage', [
                base64Message,
                { commitment: 'confirmed' },
            ]);
            return result?.value ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Broadcast a signed transaction (base64-encoded, fully signed). Returns the
     * transaction signature. `skipPreflight` is false so the cluster rejects an
     * invalid tx up front (fail closed) rather than landing a doomed tx.
     */
    async sendRawTransaction(base64SignedTx: string): Promise<string> {
        return this.call<string>('sendTransaction', [
            base64SignedTx,
            { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 },
        ]);
    }

    /** Confirmed signatures for an address (most recent first). */
    async getSignaturesForAddress(address: string, limit = 25): Promise<SignatureInfo[]> {
        return this.call<SignatureInfo[]>('getSignaturesForAddress', [
            address,
            { limit, commitment: 'confirmed' },
        ]);
    }

    /** Parsed transaction by signature (jsonParsed, v0-aware). */
    async getParsedTransaction(signature: string): Promise<SolanaParsedTx | null> {
        return this.call<SolanaParsedTx | null>('getTransaction', [
            signature,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]);
    }
}

/** Minimal shape of a jsonParsed transaction we read for history. */
export interface SolanaParsedTx {
    slot: number;
    blockTime: number | null;
    meta: {
        err: unknown | null;
        fee: number;
        preBalances: number[];
        postBalances: number[];
        preTokenBalances?: Array<TokenBalanceEntry>;
        postTokenBalances?: Array<TokenBalanceEntry>;
    } | null;
    transaction: {
        message: {
            accountKeys: Array<{ pubkey: string } | string>;
            instructions: Array<ParsedInstruction>;
        };
        signatures: string[];
    };
}

export interface TokenBalanceEntry {
    accountIndex: number;
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string; decimals: number; uiAmountString: string };
}

export interface ParsedInstruction {
    program?: string;
    programId?: string;
    parsed?: {
        type?: string;
        info?: Record<string, unknown>;
    };
}

/** Format an atomic BigInt amount to a decimal UI string. */
export function formatAtomic(atomic: bigint, decimals: number): string {
    if (decimals === 0) return atomic.toString();
    const negative = atomic < 0n;
    const abs = negative ? -atomic : atomic;
    const s = abs.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals);
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    const out = frac.length > 0 ? `${whole}.${frac}` : whole;
    return negative ? `-${out}` : out;
}

const solanaRpc = new SolanaRpc();
export default solanaRpc;
