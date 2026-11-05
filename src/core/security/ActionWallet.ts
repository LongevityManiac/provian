import { Wallet, Transaction, keccak256, verifyAuthorization, type Provider, type TransactionRequest, type TransactionResponse, type TypedDataDomain, type TypedDataField } from 'ethers';
import * as Crypto from 'expo-crypto';
import { secureNonceStore } from './secureNonceStore';
import { sendChainOperation, readChainOperation, resolveCanonicalNonceConsumption } from './chainNonce';
import type { SignedNonceAttempt } from './canonicalNonce';
import { assertBiometricAction, type BiometricAction } from './biometricAction';

/** An EVM signer whose approval cannot survive an asynchronous preparation or a later action. */
export class ActionWallet extends Wallet {
    constructor(privateKey: string, private readonly action: BiometricAction, provider: Provider | null = null, private readonly operationId?: string) {
        super(privateKey, provider);
        assertBiometricAction(action);
    }

    override connect(provider: Provider | null): ActionWallet {
        assertBiometricAction(this.action);
        return new ActionWallet(this.privateKey, this.action, provider, this.operationId);
    }

    override async signMessage(message: string | Uint8Array): Promise<string> {
        assertBiometricAction(this.action);
        const signed = await super.signMessage(message);
        assertBiometricAction(this.action);
        return signed;
    }

    override async signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
        assertBiometricAction(this.action);
        const signed = await super.signTypedData(domain, types, value);
        assertBiometricAction(this.action);
        return signed;
    }

    override async signTransaction(tx: TransactionRequest): Promise<string> {
        assertBiometricAction(this.action);
        const signed = await super.signTransaction(tx);
        assertBiometricAction(this.action);
        return signed;
    }

    async recoverOperation(id: string): Promise<TransactionResponse> {
        assertBiometricAction(this.action);
        const provider = this.provider;
        if (!provider) throw new Error('nonce_provider_missing');
        const chainId = (await provider.getNetwork()).chainId;
        assertBiometricAction(this.action);
        const doc = await readChainOperation(secureNonceStore(), `${chainId}_${this.address.toLowerCase()}`, id);
        const index = await secureNonceStore().transact(`${chainId}_${this.address.toLowerCase()}`, current => { if (!current) throw new Error('chain_operation_not_found'); return current; });
        const attempt = doc.attempts[0] ?? index.attempts.find(a => a.intent === id);
        if (!attempt) throw new Error('nonce_operation_has_no_signed_transaction');
        const decoded = Transaction.from(attempt.raw);
        return this.coordinate({ to: decoded.to, data: decoded.data, value: decoded.value }, id, true);
    }
    override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
        return this.coordinate(tx, this.operationId ?? Crypto.randomUUID(), this.operationId !== undefined);
    }
    private async coordinate(tx: TransactionRequest, id: string, resume: boolean): Promise<TransactionResponse> {
        assertBiometricAction(this.action);
        const provider = this.provider;
        if (!provider) throw new Error('Cannot send a transaction without a provider');
        const chainId = (await provider.getNetwork()).chainId;
        assertBiometricAction(this.action);
        const call = await this.populateCall(tx);
        const intent = `${String(call.to).toLowerCase()}:${BigInt(call.value ?? 0)}:${String(call.data ?? '0x').toLowerCase()}`;
        let response: TransactionResponse | null = null;
        const attempt = await sendChainOperation({
            store: secureNonceStore(), now: Date.now, uuid: Crypto.randomUUID,
            nonce: () => provider.getTransactionCount(this.address, 'latest'),
            resolveConsumption: (saved) => resolveCanonicalNonceConsumption({
                head: () => provider.getBlockNumber(),
                count: height => provider.getTransactionCount(this.address, height),
                block: async (height, full) => {
                    const block = await provider.getBlock(height, full);
                    if (!block || !block.hash) return null;
                    return { number: block.number, hash: block.hash, transactions: full ? block.prefetchedTransactions.map(tx => ({
                        hash: tx.hash, from: tx.from, nonce: tx.nonce,
                        authorizations: tx.authorizationList?.filter(a => a.chainId === 0n || a.chainId === chainId).map(a => ({ authority: verifyAuthorization(a, a.signature), nonce: Number(a.nonce) })) ?? [],
                    })) : [] };
                },
            }, this.address, saved.nonce, saved.hash),
            included: async (hash) => {
                const receipt = await provider.getTransactionReceipt(hash);
                return receipt !== null && (await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash;
            },
            validate: (saved: SignedNonceAttempt) => {
                const decoded = Transaction.from(saved.raw);
                if (decoded.hash !== saved.hash || decoded.from?.toLowerCase() !== this.address.toLowerCase()
                    || decoded.chainId !== chainId || decoded.nonce !== saved.nonce
                    || `${decoded.to?.toLowerCase()}:${decoded.value}:${decoded.data}` !== intent) throw new Error('nonce_attempt_binding_invalid');
            },
            assertApproved: () => assertBiometricAction(this.action),
            broadcast: async (saved) => {
                assertBiometricAction(this.action);
                response = await provider.broadcastTransaction(saved.raw);
                if (response.hash !== saved.hash) throw new Error('nonce_broadcast_hash_mismatch');
            },
        }, `${chainId}_${this.address.toLowerCase()}`, id, intent, async (nonce) => {
            assertBiometricAction(this.action);
            const populated = await super.populateTransaction({ ...tx, nonce });
            const raw = await this.signTransaction(populated);
            return { nonce, raw, hash: keccak256(raw) };
        }, { nonce: tx.nonce === null ? undefined : tx.nonce, resume });
        const result = response as TransactionResponse | null;
        const recovered = result ?? await provider.getTransaction(attempt.hash);
        if (!recovered) throw new Error(`nonce_broadcast_uncertain:${attempt.hash}`);
        Object.defineProperty(recovered, 'operationId', { value: id, configurable: true });
        return recovered;
    }
}

export interface RecoverableWalletTransaction {
    readonly operationId: string; readonly chainId: number; readonly hash: string;
    readonly to: string; readonly value: string; readonly data: string;
    readonly nonce: number; readonly maxFeeWei: string;
    readonly gasLimit: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string;
}
/** Public transaction summary only; signed recovery bytes stay in encrypted local storage. */
export async function listWalletRecoveryTransactions(address: string, provider: Provider): Promise<RecoverableWalletTransaction[]> {
    const chainId = (await provider.getNetwork()).chainId;
    const key = `${chainId}_${address.toLowerCase()}`;
    const journal = await secureNonceStore().transact(key, current => current ?? {
        version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 });
    const rows: RecoverableWalletTransaction[] = [];
    for (const attempt of journal.attempts) {
        const saved = await readChainOperation(secureNonceStore(), key, attempt.intent);
        if ((await provider.getTransactionReceipt(attempt.hash)) && saved.operation?.state === 'submitted') continue;
        const tx = Transaction.from(attempt.raw);
        if (tx.hash !== attempt.hash || tx.chainId !== chainId || tx.from?.toLowerCase() !== address.toLowerCase()) throw new Error('nonce_attempt_binding_invalid');
        rows.push({ operationId: attempt.intent, chainId: Number(chainId), hash: attempt.hash, to: tx.to ?? '',
            value: tx.value.toString(), data: tx.data, nonce: tx.nonce,
            gasLimit: tx.gasLimit.toString(), maxFeePerGas: (tx.maxFeePerGas ?? tx.gasPrice ?? 0n).toString(),
            maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(),
            maxFeeWei: (tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)).toString() });
    }
    return rows;
}
