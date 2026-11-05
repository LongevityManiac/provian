import type { RecoverableWalletTransaction } from '../security/ActionWallet';
import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { translate } from '../../i18n/translate';
import '@walletconnect/react-native-compat';
import { Core } from '@walletconnect/core';
import { Web3Wallet, Web3WalletTypes, IWeb3Wallet } from '@walletconnect/web3wallet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ethers } from 'ethers';
import SeedManager from '../wallet/SeedManager';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import { getChainById, getActiveChains, getRpcUrls } from '../chains/evm/config';
import { decodeTransactionCall, DecodedCall } from './decodeCalldata';
import { decodeTypedData, isKnownNonSpendTypedData, DecodedPermit } from './decodeTypedData';
import {
    evaluateWalletConnectTransaction,
    evaluateWalletConnectPermit,
    makeFailClosedVerdict,
    makeUnknownTypedDataVerdict,
    WalletConnectVerdict,
    WalletConnectPolicyError,
} from './WalletConnectGovernance';
import { WalletConnectGovernanceSettings, DEFAULT_WC_GOVERNANCE_SETTINGS } from './governanceSettings';
import {
    assertNotProvianReserved,
    checkProvianReserved,
    ProvianReservedMessageError,
    PROVIAN_RESERVED_USER_MESSAGE,
} from './provianReserved';
import { recordDailyCryptoSpendUsd } from '../crypto-governance/DailyCryptoSpendTracker';
import { useWalletStore } from '../../store/walletStore';
import { BiometricAuthError } from '../security/requireBiometric';
import { englishErrorMessage } from './englishErrorMessage';
import {
    StrongConfirmationRequiredError,
    strongConfirmationSatisfied,
    type StrongConfirmation,
} from './strongConfirmation';

/**
 * WalletConnect Project ID
 *
 * SECURITY NOTE: G-1 Exception
 * ============================
 * The WalletConnect Project ID must be included client-side because the
 * WalletConnect SDK initializes a WebSocket connection directly from the client.
 * This is acceptable because:
 *
 * 1. WalletConnect Cloud restricts project IDs by:
 *    - Bundle ID (iOS) / Package Name (Android)
 *    - Allowed origins for web
 *
 * 2. The project ID only grants access to the relay infrastructure, not to
 *    user data or signing capabilities.
 *
 * 3. All signing operations still require user approval within the app.
 *
 * REQUIRED CONFIGURATION:
 * - Go to https://cloud.walletconnect.com
 * - Project Settings -> Allowlist
 * - Add your iOS Bundle ID and Android Package Name
 * - This prevents unauthorized apps from using your project ID
 */
const PROJECT_ID = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

/**
 * The only JSON-RPC methods Provian accepts over WalletConnect.
 *
 * [Security: "Unknown = Block, not warn"] We deliberately exclude `eth_sign`
 * (signs an opaque 32-byte hash with no human-readable context — the classic
 * blind-signing phishing vector) and `eth_signTransaction` (not implemented).
 * Anything outside this set is rejected the moment it arrives, before the user
 * is ever prompted. This list is the single source of truth for both the
 * session namespace we advertise and the runtime request guard.
 */
const SUPPORTED_METHODS = [
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
] as const;

export interface WCSession {
    topic: string;
    peerMeta: {
        name: string;
        description?: string;
        url: string;
        icons: string[];
    };
    chains: string[];
    accounts: string[];
    expiry: number;
}

export interface WCRequest {
    id: number;
    topic: string;
    method: string;
    params: unknown[];
    chainId: string;
    peerMeta: {
        name: string;
        url: string;
        icons: string[];
    };
}

/** Minimal EIP-712 typed-data shape (ethers-compatible) for the sign paths. */
interface WCTypedData {
    domain: ethers.TypedDataDomain;
    types: Record<string, ethers.TypedDataField[]>;
    message: Record<string, unknown>;
    /** dApp-supplied EIP-712 primary type (used only for display / PE enrichment). */
    primaryType?: string;
}

/** Parsed transaction details for UI display */
export interface WCTransactionDetails {
    to: string;
    from: string;
    value: string;         // Human-readable ETH amount
    valueWei: string;      // Raw wei value
    data: string;
    gasLimit?: string;
    chainId: number;
    chainName: string;
    /** Decoded ERC-20 / ERC-721 action for the signing UI + PE enrichment. */
    decoded?: DecodedCall;
}

type EventType = 'session_proposal' | 'session_request' | 'session_delete' | 'session_update';
type EventHandler = (...args: unknown[]) => void;

// ── Permit (gasless approval / transfer) display helpers, shared by the
// governed and biometric-only typed-data paths so the PE intent text stays
// consistent. ────────────────────────────────────────────────────────────────
function permitSymbol(permit: DecodedPermit): string {
    return permit.tokenSymbol || (permit.kind === 'permit2_batch' ? 'multiple' : 'token');
}
function permitAmount(permit: DecodedPermit): string {
    return permit.isUnlimited
        ? 'unlimited'
        : (permit.amountFormatted || (permit.tokenKnown ? permit.amountRaw : 'unknown') || '0');
}
function describePermitIntent(permit: DecodedPermit, dappName: string): string {
    const via = `via ${dappName}`;
    const amount = permitAmount(permit);
    const symbol = permitSymbol(permit);
    if (permit.kind === 'permit2_batch') {
        const verb = permit.isTransfer ? 'transfer authorization' : 'approval';
        return `WalletConnect: Permit2 batch ${verb} of ${permit.batchCount} tokens to ${permit.spender} ${via}`;
    }
    if (permit.isTransfer) {
        const label = permit.kind === 'eip3009_transfer' ? 'gasless transfer' : 'Permit2 transfer';
        return `WalletConnect: authorize ${label} of ${amount} ${symbol} to ${permit.spender} ${via}`;
    }
    if (permit.isRevoke) {
        return `WalletConnect: revoke ${symbol} allowance for ${permit.spender} ${via}`;
    }
    const label = permit.kind === 'erc2612_permit' || permit.kind === 'dai_permit' ? 'permit' : 'Permit2';
    return `WalletConnect: ${label} approve ${permit.spender} to spend ${amount} ${symbol} ${via}`;
}

/**
 * WalletConnect v2 Service - Real Web3Wallet Integration
 *
 * Signs using SeedManager-derived secp256k1 keys (BIP-44 m/44'/60'/0'/0/0).
 * Supports personal_sign, eth_signTypedData(_v4), and eth_sendTransaction.
 *
 * All signing operations create Provenance Envelopes for the hash chain.
 */
class WalletConnectService {
    private static instance: WalletConnectService;
    private web3wallet: IWeb3Wallet | null = null;
    private sessions: Map<string, WCSession> = new Map();
    private recoveryOperations = new Map<number, { request: WCRequest; operationId: string }>();
    private pendingRequests: Map<number, WCRequest> = new Map();
    /** When the service first computed a strong (hard_confirm) verdict for a request: the cooling-off starts there. */
    private strongShownAtMs: Map<number, number> = new Map();
    private eventHandlers: Map<EventType, EventHandler[]> = new Map();
    private initialized = false;
    private pendingProposal: Web3WalletTypes.SessionProposal | null = null;

    private constructor() {}

    static getInstance(): WalletConnectService {
        if (!WalletConnectService.instance) {
            WalletConnectService.instance = new WalletConnectService();
        }
        return WalletConnectService.instance;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        if (!PROJECT_ID) {
            throw new Error(
                'WalletConnect Project ID not configured. ' +
                'Set EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID in your environment.'
            );
        }

        try {
            const core = new Core({
                projectId: PROJECT_ID,
            });

            this.web3wallet = await Web3Wallet.init({
                core: core as unknown as Web3WalletTypes.Options['core'],
                metadata: {
                    name: 'Provian Wallet',
                    description: translate('legal.brandTagline', 'The Trust Layer for the Intelligence Economy'),
                    url: 'https://provian.ai',
                    icons: ['https://provian.ai/logos/provian-256.png'],
                },
            });

            this.setupEventListeners();
            await this.loadPersistedSessions();
            this.initialized = true;
            console.log('[WalletConnect] Initialized successfully');
        } catch (error) {
            console.error('[WalletConnect] Failed to initialize:', error);
            throw error;
        }
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    private setupEventListeners(): void {
        if (!this.web3wallet) return;

        this.web3wallet.on('session_proposal', async (proposal) => {
            console.log('[WalletConnect] Session proposal received:', proposal.id);
            this.pendingProposal = proposal;
            this.emit('session_proposal', proposal);
        });

        this.web3wallet.on('session_request', async (event) => {
            console.log('[WalletConnect] Session request:', event.params.request.method);
            const request = this.eventToRequest(event);

            // [Security: "Unknown = Block, not warn"] Reject any method outside
            // SUPPORTED_METHODS (notably eth_sign) at the door, before the user
            // is ever prompted. Never store it or surface it to the UI.
            if (!(SUPPORTED_METHODS as readonly string[]).includes(request.method)) {
                console.warn('[WalletConnect] Rejecting unsupported method:', request.method);
                try {
                    await this.web3wallet!.respondSessionRequest({
                        topic: request.topic,
                        response: {
                            id: request.id,
                            jsonrpc: '2.0',
                            error: { code: 4001, message: `Method not supported: ${request.method}` },
                        },
                    });
                } catch (e) {
                    console.error('[WalletConnect] Failed to reject unsupported method:', e);
                }
                return;
            }

            // [] No external dApp may obtain a wallet-key signature over a
            // Provian relay-auth or recovery message (recovery typed data, promise /
            // presentation / proof-of-control / link-consent text, the hire salt,
            // the human-wallet registration proof). Refused at the door with 4001,
            // before the user is ever prompted, and sealed as a denied PE.
            const reserved = checkProvianReserved(request.method, request.params);
            if (reserved.reserved) {
                console.warn('[WalletConnect] Rejecting Provian-reserved signing request:', reserved.reason);
                await this.recordDeniedPE('approve', request, `provian_reserved_message:${reserved.reason}`, 100)
                    .catch((e) => console.error('[WalletConnect] Failed to record reserved-message deny PE:', e));
                try {
                    await this.web3wallet!.respondSessionRequest({
                        topic: request.topic,
                        response: {
                            id: request.id,
                            jsonrpc: '2.0',
                            error: { code: 4001, message: PROVIAN_RESERVED_USER_MESSAGE },
                        },
                    });
                } catch (e) {
                    console.error('[WalletConnect] Failed to reject Provian-reserved request:', e);
                }
                return;
            }

            this.pendingRequests.set(request.id, request);
            this.emit('session_request', request);
        });

        this.web3wallet.on('session_delete', async (event) => {
            console.log('[WalletConnect] Session deleted:', event.topic);
            this.sessions.delete(event.topic);
            await this.persistSessions();
            this.emit('session_delete', event.topic);
        });
    }

    // =========================================================================
    // Event system
    // =========================================================================

    on(event: EventType, handler: EventHandler): () => void {
        const handlers = this.eventHandlers.get(event) || [];
        handlers.push(handler);
        this.eventHandlers.set(event, handlers);

        return () => {
            const list = this.eventHandlers.get(event) || [];
            const idx = list.indexOf(handler);
            if (idx > -1) list.splice(idx, 1);
        };
    }

    private emit(event: EventType, ...args: unknown[]): void {
        const handlers = this.eventHandlers.get(event) || [];
        handlers.forEach(handler => {
            try { handler(...args); } catch (e) { console.error('[WalletConnect] Handler error:', e); }
        });
    }

    // =========================================================================
    // Pairing
    // =========================================================================

    async pair(uri: string): Promise<void> {
        if (!this.web3wallet) {
            await this.initialize();
        }
        if (!uri.startsWith('wc:')) {
            throw new Error('Invalid WalletConnect URI. Must start with "wc:"');
        }
        try {
            await this.web3wallet!.core.pairing.pair({ uri });
            console.log('[WalletConnect] Pairing initiated');
        } catch (error) {
            console.error('[WalletConnect] Pairing failed:', error);
            throw error;
        }
    }

    // =========================================================================
    // Session management
    // =========================================================================

    getPendingProposal(): Web3WalletTypes.SessionProposal | null {
        return this.pendingProposal;
    }

    async approveSession(proposalId: number, address: string, biometricAction?: BiometricAction): Promise<WCSession> {
        if (!this.web3wallet) throw new Error('WalletConnect not initialized');

        // Build supported chains from active EVM config
        const activeChains = getActiveChains();
        const accounts = activeChains.map(c => `eip155:${c.chainId}:${address}`);
        // Also include Ethereum mainnet (chain 1) since many dApps request it
        if (!activeChains.find(c => c.chainId === 1)) {
            accounts.push(`eip155:1:${address}`);
        }

        const namespaces = {
            eip155: {
                accounts,
                methods: [...SUPPORTED_METHODS],
                events: ['chainChanged', 'accountsChanged'],
            },
        };

        const session = await this.web3wallet.approveSession({
            id: proposalId,
            namespaces,
        });

        const wcSession: WCSession = {
            topic: session.topic,
            peerMeta: {
                name: session.peer.metadata.name,
                description: session.peer.metadata.description,
                url: session.peer.metadata.url,
                icons: session.peer.metadata.icons,
            },
            chains: Object.keys(session.namespaces).flatMap(
                ns => session.namespaces[ns].accounts.map(
                    a => a.split(':').slice(0, 2).join(':')
                )
            ),
            accounts: Object.values(session.namespaces).flatMap(ns => ns.accounts),
            expiry: session.expiry,
        };

        this.sessions.set(session.topic, wcSession);
        this.pendingProposal = null;
        await this.persistSessions();

        // Provenance Envelope for dApp connection
        await ProvenanceEnvelopeManager.createEnvelope({
            actionType: 'approve',
            intentText: `WalletConnect: connected to ${wcSession.peerMeta.name}`,
            assetSymbol: 'N/A',
            amount: '0',
            chainId: 1,
            riskScore: 5,
            riskCategory: 'low',
            policyDecision: 'allow',
            originBinding: wcSession.peerMeta.url,
        }, biometricAction);

        return wcSession;
    }

    async rejectSession(proposalId: number): Promise<void> {
        if (!this.web3wallet) throw new Error('WalletConnect not initialized');

        await this.web3wallet.rejectSession({
            id: proposalId,
            reason: {
                code: 4001,
                message: 'User rejected the session',
            },
        });
        this.pendingProposal = null;
    }

    async disconnectSession(topic: string): Promise<void> {
        if (!this.web3wallet) throw new Error('WalletConnect not initialized');

        try {
            await this.web3wallet.disconnectSession({
                topic,
                reason: {
                    code: 6000,
                    message: 'User disconnected',
                },
            });
        } catch (error) {
            // Session may already be deleted on the relay side
            console.warn('[WalletConnect] Disconnect error (may be stale):', error);
        }

        this.sessions.delete(topic);
        await this.persistSessions();
    }

    getSessions(): WCSession[] {
        return Array.from(this.sessions.values());
    }

    getPendingRequests(): WCRequest[] {
        return Array.from(this.pendingRequests.values());
    }

    getPendingRequest(id: number): WCRequest | undefined {
        return this.pendingRequests.get(id);
    }

    // =========================================================================
    // Request handling - signing via SeedManager (secp256k1 / BIP-44)
    // =========================================================================

    /**
     * Read the owner's WalletConnect governance settings from the wallet store.
     * Defensive: falls back to the safe defaults if the store is unavailable or
     * not yet hydrated (the defaults are MORE restrictive, never less).
     */
    private getGovernanceSettings(): WalletConnectGovernanceSettings {
        try {
            return useWalletStore.getState().walletConnectGovernance || DEFAULT_WC_GOVERNANCE_SETTINGS;
        } catch {
            return DEFAULT_WC_GOVERNANCE_SETTINGS;
        }
    }

    /**
     * Pre-evaluate a pending request through the governance pipeline so the
     * approval modal can render the correct friction control BEFORE the user
     * acts. Returns null for biometric-only paths (personal_sign, non-permit /
     * revoke typed data), which carry no spend authority. The execution-time
     * re-check in handleSendTransaction / handlePermitSign is authoritative.
     */
    async evaluateRequestGovernance(request: WCRequest, biometricAction?: BiometricAction): Promise<WalletConnectVerdict | null> {
        const verdict = await this.computeRequestGovernance(request, biometricAction);
        // The cooling-off for THIS request starts the first time the service shows it a strong verdict.
        if (verdict?.requiresStrongConfirm && !this.strongShownAtMs.has(request.id)) {
            this.strongShownAtMs.set(request.id, Date.now());
        }
        return verdict;
    }

    /**
     * [H3, fix run 2026-10-24] The execution-time verdict for THIS request decides whether the strong
     * confirmation is required; the screen's copy of a verdict never does. Refused unless the
     * confirmation names this request, carries the phrase, and the cooling-off has elapsed.
     */
    private assertStrongConfirmation(
        request: WCRequest,
        verdict: Pick<WalletConnectVerdict, 'requiresStrongConfirm'>,
        confirmation: StrongConfirmation | undefined,
    ): void {
        if (!strongConfirmationSatisfied({
            requestId: request.id,
            verdict,
            confirmation,
            strongShownAtMs: this.strongShownAtMs.get(request.id),
            nowMs: Date.now(),
        })) {
            throw new StrongConfirmationRequiredError();
        }
    }

    private async computeRequestGovernance(request: WCRequest, biometricAction?: BiometricAction): Promise<WalletConnectVerdict | null> {
        const settings = this.getGovernanceSettings();

        if (request.method === 'eth_sendTransaction') {
            try {
                const txParams = request.params[0] as Record<string, string>;
                const chainIdNum = parseInt(request.chainId.split(':')[1] || '1');
                const chain = getChainById(chainIdNum);
                return await evaluateWalletConnectTransaction(
                    {
                        to: txParams?.to || '',
                        value: txParams?.value || '0',
                        data: txParams?.data || '0x',
                        chainId: chainIdNum,
                        chainShortName: chain?.shortName,
                        dappName: request.peerMeta.name,
                    },
                    settings, biometricAction
                );
            } catch {
                // [Security Invariant #7] Could not evaluate → fail closed (block),
                // never a silent downgrade to the biometric-only path.
                return makeFailClosedVerdict('unknown');
            }
        }

        if (request.method === 'eth_signTypedData' || request.method === 'eth_signTypedData_v4') {
            let permit: DecodedPermit | null = null;
            let sessionChainId = 1;
            let typedData: unknown;
            try {
                const [, typedDataString] = request.params as string[];
                typedData = typeof typedDataString === 'string'
                    ? JSON.parse(typedDataString)
                    : typedDataString;
                sessionChainId = parseInt(request.chainId.split(':')[1] || '1');
                permit = decodeTypedData(typedData, sessionChainId);
            } catch {
                // Could not even parse the typed data → unclassifiable. [Invariant
                // #7] Fail closed to the governed hard_confirm path, never the
                // biometric-only branch.
                return makeUnknownTypedDataVerdict();
            }

            if (permit && !permit.isRevoke) {
                // A recognized spend-authority permit (incl. EIP-3009) MUST be
                // governed — if its evaluation errors, fail closed (block), never
                // biometric-only.
                try {
                    const chain = getChainById(sessionChainId);
                    return await evaluateWalletConnectPermit(
                        permit,
                        { chainId: sessionChainId, chainShortName: chain?.shortName, dappName: request.peerMeta.name },
                        settings, biometricAction
                    );
                } catch {
                    return makeFailClosedVerdict(permit.isTransfer ? 'token_transfer' : 'token_approval');
                }
            }

            // A protective revoke (DAI allowed=false) or an allowlisted, structurally
            // verified non-spend shape (SIWE-style login) carries no spend authority
            // and stays biometric-only (null → no governance banner).
            if ((permit && permit.isRevoke) || isKnownNonSpendTypedData(typedData)) {
                return null;
            }

            // [F16] Everything else is UNRECOGNIZED typed data. An EIP-712 signature
            // can move funds, so it must never land on the least-restrictive path.
            // Fail closed to hard_confirm + a "could not verify" banner.
            return makeUnknownTypedDataVerdict();
        }

        return null;
    }

    /**
     * Record a Provenance Envelope for a governance-DENIED signing attempt
     * (policy block). [Security Invariant #5] A consequential
     * action — even a denied one — is never skipped from the hash chain.
     */
    private async recordDeniedPE(
        actionType: 'send' | 'approve',
        request: WCRequest,
        reason: string,
        riskScore: number,
        verdict?: WalletConnectVerdict,
        effect?: { assetSymbol?: string; counterparty?: string }, biometricAction?: BiometricAction,
    ): Promise<void> {
        const chainIdNum = parseInt(request.chainId.split(':')[1] || '1');
        await ProvenanceEnvelopeManager.createEnvelope({
            actionType,
            intentText: `WalletConnect: DENIED ${actionType} via ${request.peerMeta.name} — ${reason}`,
            assetSymbol: effect?.assetSymbol || 'N/A',
            amount: '0',
            chainId: chainIdNum,
            counterparty: effect?.counterparty,
            riskScore: Math.min(100, Math.max(riskScore, 80)),
            riskCategory: 'high',
            policyDecision: 'block',
            authorizationDecision: 'deny',
            authorizationStage: 'execution',
            authorizationMerchant: request.peerMeta.name,
            authorizationReasonCodes: verdict?.reasons?.length ? verdict.reasons : [reason],
            authorizationPurpose: JSON.stringify({
                source: 'walletconnect',
                denied: true,
                frictionLane: verdict?.lane || 'block',
                reason,
            }),
            originBinding: request.peerMeta.url,
        }, biometricAction);
    }

    /**
     * Record a Provenance Envelope when a request was AUTHORIZED (governance
     * allowed + biometric passed) but the signing/broadcast step then failed
     * (RPC error, insufficient funds, nonce, user-cancelled signer, etc.).
     *
     * [Security Invariant #5] The allow PE recorded the authorization decision;
     * this appends the execution OUTCOME so the hash chain never shows an
     * "authorized" with no corresponding result. This is NOT a policy deny —
     * governance allowed it — so policyDecision stays 'allow' and the failure is
     * carried in the reason codes + purpose. Recording is best-effort and must
     * never mask the original signing error (callers swallow its rejection).
     */
    private async recordExecutionFailurePE(
        actionType: 'send' | 'approve',
        request: WCRequest,
        error: unknown,
        effect?: { assetSymbol?: string; amount?: string; counterparty?: string; riskScore?: number; riskCategory?: 'low' | 'medium' | 'high' }, biometricAction?: BiometricAction,
    ): Promise<void> {
        const chainIdNum = parseInt(request.chainId.split(':')[1] || '1');
        const message = englishErrorMessage(error, String(error));
        await ProvenanceEnvelopeManager.createEnvelope({
            actionType,
            intentText: `WalletConnect: ${actionType} authorized but execution FAILED via ${request.peerMeta.name} — ${message}`,
            assetSymbol: effect?.assetSymbol || 'N/A',
            amount: effect?.amount || '0',
            chainId: chainIdNum,
            counterparty: effect?.counterparty,
            riskScore: effect?.riskScore ?? 50,
            riskCategory: effect?.riskCategory ?? 'medium',
            policyDecision: 'allow',
            authorizationDecision: 'allow',
            authorizationStage: 'execution',
            authorizationMerchant: request.peerMeta.name,
            authorizationReasonCodes: ['execution_failed'],
            authorizationPurpose: JSON.stringify({
                source: 'walletconnect',
                executionFailed: true,
                error: message,
            }),
            originBinding: request.peerMeta.url,
        }, biometricAction);
    }

    /**
     * Parse a transaction request into human-readable details for UI display.
     */
    parseTransactionDetails(request: WCRequest): WCTransactionDetails | null {
        if (request.method !== 'eth_sendTransaction') return null;

        const txParams = request.params[0] as Record<string, string>;
        const chainIdNum = parseInt(request.chainId.split(':')[1] || '1');
        const chain = getChainById(chainIdNum);

        return {
            to: txParams.to || '',
            from: txParams.from || '',
            value: txParams.value
                ? ethers.formatEther(txParams.value)
                : '0',
            valueWei: txParams.value || '0x0',
            data: txParams.data || '0x',
            gasLimit: txParams.gas || txParams.gasLimit,
            chainId: chainIdNum,
            chainName: chain?.name || `Chain ${chainIdNum}`,
            decoded: decodeTransactionCall(txParams.to || '', txParams.data || '0x', chainIdNum),
        };
    }

    /**
     * Sign a personal_sign or eth_signTypedData request.
     * Uses SeedManager.getEVMPrivateKey() for proper secp256k1 signing.
     *
     * [Group 1 / M-2 / H-1] All WalletConnect sign methods go through a
     * fresh biometric session prompt. This closes the cross-domain replay
     * surface where a malicious dApp could request a signature of an
     * arbitrary message that the relay credential recovery path would
     * also accept. Industry norm for crypto wallets.
     *
     * [CLAUDE.md pitfall #13] Gasless approval / transfer-authorization
     * signatures (EIP-2612 `permit`, DAI `permit`, Uniswap Permit2) grant the
     * SAME spend authority an on-chain approve/transfer carries — they are now
     * routed through the crypto-spending governance pipeline (policy →
     * friction lane), in addition to biometric. personal_sign and
     * non-permit / revoke typed data carry no spend authority and stay on the
     * biometric-only path.
     */
    async handleSignRequest(request: WCRequest, biometricAction?: BiometricAction, confirmation?: StrongConfirmation): Promise<string> {
        const { method, params } = request;

        // [] Backstop to the session_request door: never sign a
        // Provian-reserved message, whatever path the request arrived by.
        try {
            assertNotProvianReserved(method, params);
        } catch (e) {
            const reason = e instanceof ProvianReservedMessageError ? e.reason : 'guard_error';
            await this.recordDeniedPE('approve', request, `provian_reserved_message:${reason}`, 100, undefined, undefined, biometricAction).catch(() => { });
            throw e;
        }

        if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v4') {
            const [, typedDataString] = params as string[];
            const typedData = typeof typedDataString === 'string'
                ? JSON.parse(typedDataString)
                : typedDataString;
            const sessionChainId = parseInt(request.chainId.split(':')[1] || '1');

            // Detect gasless spend-authority signatures. A revoke (DAI allowed=false)
            // reduces risk and is NOT governed — the owner should
            // always be able to protect themselves.
            const permit = decodeTypedData(typedData, sessionChainId);
            if (permit && !permit.isRevoke) {
                // Recognized spend authority (EIP-2612 / DAI / Permit2 / EIP-3009) →
                // governed path (policy → friction → biometric).
                return this.handlePermitSign(request, typedData, permit, sessionChainId, biometricAction, confirmation);
            }
            if ((permit && permit.isRevoke) || isKnownNonSpendTypedData(typedData)) {
                // A protective revoke, or an allowlisted (structurally verified)
                // non-spend shape — no spend authority, biometric-only.
                return this.handlePlainTypedDataSign(request, typedData, permit, sessionChainId, biometricAction);
            }
            // [F16] Unrecognized typed data — an EIP-712 signature can move funds
            // (EIP-3009, Seaport/order signing, meta-tx). [Invariant #7] It must NOT
            // reach the least-restrictive biometric-only branch; fail closed to the
            // governed hard_confirm path.
            return this.handleUnknownTypedDataSign(request, typedData, sessionChainId, biometricAction, confirmation);
        }

        return await withBiometricAction(translate('biometricPrompts.signRequestFrom', `Sign request from ${request.peerMeta.name}`, { dapp: request.peerMeta.name }), async (biometricAction) => {
            if (method === 'personal_sign') {
                assertBiometricAction(biometricAction);
                const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
                const wallet = new ActionWallet(privateKey, biometricAction);
                const [message] = params as string[];

                await ProvenanceEnvelopeManager.createEnvelope({
                    actionType: 'approve',
                    intentText: `WalletConnect: sign message for ${request.peerMeta.name}`,
                    assetSymbol: 'N/A',
                    amount: '0',
                    chainId: parseInt(request.chainId.split(':')[1] || '1'),
                    riskScore: 10,
                    riskCategory: 'low',
                    policyDecision: 'allow',
                    originBinding: request.peerMeta.url,
                }, biometricAction);

                // personal_sign params: [message, address]; message may be hex.
                // Per EIP-191 the RAW BYTES must be signed. Decoding hex to a UTF-8
                // string and re-encoding only round-trips for valid-UTF-8 text; for
                // binary/digest payloads (nonces, 32-byte hashes) it throws or
                // produces a different byte string, yielding a signature the dApp
                // rejects. ethers.Wallet.signMessage accepts a Uint8Array and
                // applies the EIP-191 prefix/hash over the exact bytes (review #6).
                const messageArg = ethers.isHexString(message)
                    ? ethers.getBytes(message)
                    : message;
                try {
                    return await wallet.signMessage(messageArg);
                } catch (e) {
                    await this.recordExecutionFailurePE('approve', request, e, { riskScore: 10, riskCategory: 'low' }, biometricAction).catch(() => { });
                    throw e;
                }
            }

            throw new Error(`Unsupported signing method: ${method}`);

        }, biometricAction);
    }

    /**
     * Governed typed-data sign path: gasless approvals / transfer authorizations
     * that grant spend authority. Governance first, then biometric (IN
     * ADDITION), then signature.
     */
    private async handlePermitSign(
        request: WCRequest,
        typedData: WCTypedData,
        permit: DecodedPermit,
        chainId: number, biometricAction?: BiometricAction,
        confirmation?: StrongConfirmation,
    ): Promise<string> {
        const chain = getChainById(chainId);
        const verdict = await evaluateWalletConnectPermit(
            permit,
            { chainId, chainShortName: chain?.shortName, dappName: request.peerMeta.name },
            this.getGovernanceSettings(), biometricAction
        );

        if (!verdict.allowed) {
            // [Security Invariant #5] Record the denied attempt; never skip the PE.
            await this.recordDeniedPE('approve', request, verdict.denyReason || 'Blocked by your WalletConnect security policy.', verdict.riskScore, verdict, {
                assetSymbol: permitSymbol(permit),
                counterparty: permit.spender,
            }, biometricAction);
            throw new WalletConnectPolicyError(
                verdict.denyReason || 'This signature is blocked by your WalletConnect security policy.',
                verdict,
            );
        }
        this.assertStrongConfirmation(request, verdict, confirmation);

        // [Group 1 / M-2] Biometric session, IN ADDITION to governance.
        return await withBiometricAction(translate('biometricPrompts.signRequestFrom', `Sign request from ${request.peerMeta.name}`, { dapp: request.peerMeta.name }), async (biometricAction) => {
            assertBiometricAction(biometricAction);
            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction);

            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'approve',
                intentText: describePermitIntent(permit, request.peerMeta.name),
                assetSymbol: permitSymbol(permit),
                amount: permitAmount(permit),
                chainId,
                counterparty: permit.spender,
                riskScore: verdict.riskScore,
                riskCategory: verdict.riskCategory,
                policyDecision: 'allow',
                authorizationDecision: 'allow',
                authorizationStage: 'execution',
                authorizationMerchant: request.peerMeta.name,
                authorizationReasonCodes: verdict.reasons,
                authorizationPurpose: JSON.stringify({
                    source: 'walletconnect',
                    frictionLane: verdict.lane,
                    category: verdict.category,
                    reasons: verdict.reasons,
                }),
                originBinding: request.peerMeta.url,
            }, biometricAction);

            const types = { ...typedData.types };
            delete types.EIP712Domain;
            try {
                const signature = await wallet.signTypedData(typedData.domain, types, typedData.message);
                // [Pass-2 #29] Record the gasless permit's authorized USD into the
                // daily on-chain accumulator so the daily cap binds on spend authority
                // granted by SIGNATURE too — not only broadcast sends (which record on
                // the tx hash, line ~1016). A permit has no tx hash, so we dedupe by
                // the deterministic EIP-712 signature: re-signing the identical
                // authorization (same token/spender/amount/nonce/deadline/chain) yields
                // the identical signature and cannot double-count, while a distinct
                // permit yields a distinct signature and accrues separately. Scope
                // 'wallet-owner' matches ownerRequest().agentId, which the engine reads
                // on the next evaluation. Only priced stablecoin value
                // (verdict.amountUsd > 0) counts; recording is best-effort.
                recordDailyCryptoSpendUsd('wallet-owner', signature, verdict.amountUsd).catch(() => { });
                return signature;
            } catch (e) {
                await this.recordExecutionFailurePE('approve', request, e, {
                    assetSymbol: permitSymbol(permit), amount: permitAmount(permit), counterparty: permit.spender,
                    riskScore: verdict.riskScore, riskCategory: verdict.riskCategory,
                }, biometricAction).catch(() => { });
                throw e;
            }

        }, biometricAction);
    }

    /**
     * Biometric-only typed-data sign path: non-permit typed data and protective
     * revoke permits — no spend authority is granted, so no policy/friction
     * governance (matches the pre-existing behavior for these shapes).
     */
    private async handlePlainTypedDataSign(
        request: WCRequest,
        typedData: WCTypedData,
        permit: DecodedPermit | null,
        chainId: number, biometricAction?: BiometricAction,
    ): Promise<string> {
        return await withBiometricAction(translate('biometricPrompts.signRequestFrom', `Sign request from ${request.peerMeta.name}`, { dapp: request.peerMeta.name }), async (biometricAction) => {
            assertBiometricAction(biometricAction);
            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction);

            let tdRisk = 15;
            let tdCategory: 'low' | 'medium' | 'high' = 'low';
            let tdSymbol = 'N/A';
            let tdAmount = '0';
            let tdCounterparty: string | undefined;
            let tdIntent = `WalletConnect: sign typed data for ${request.peerMeta.name}`;
            if (permit) {
                // Only revoke permits reach here (spend-authority permits are governed above).
                const high = permit.riskLevel === 'high';
                tdRisk = high ? 75 : 55;
                tdCategory = high ? 'high' : 'medium';
                tdSymbol = permitSymbol(permit);
                tdAmount = permitAmount(permit);
                tdCounterparty = permit.spender;
                tdIntent = describePermitIntent(permit, request.peerMeta.name);
            }

            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'approve',
                intentText: tdIntent,
                assetSymbol: tdSymbol,
                amount: tdAmount,
                chainId,
                counterparty: tdCounterparty,
                riskScore: tdRisk,
                riskCategory: tdCategory,
                policyDecision: 'allow',
                originBinding: request.peerMeta.url,
            }, biometricAction);

            const types = { ...typedData.types };
            delete types.EIP712Domain;
            try {
                return await wallet.signTypedData(typedData.domain, types, typedData.message);
            } catch (e) {
                await this.recordExecutionFailurePE('approve', request, e, {
                    assetSymbol: tdSymbol, amount: tdAmount, counterparty: tdCounterparty,
                    riskScore: tdRisk, riskCategory: tdCategory,
                }, biometricAction).catch(() => { });
                throw e;
            }

        }, biometricAction);
    }

    /**
     * [F16] Governed sign path for UNRECOGNIZED typed data — an EIP-712 struct
     * that is neither a decodable spend permit nor an allowlisted non-spend shape.
     * An EIP-712 signature can move funds (EIP-3009 transferWithAuthorization,
     * Seaport / order signing, gasless meta-transactions), so it must NEVER land on
     * the biometric-only branch (Security Invariant #7 inverted). The sealed PE records the event honestly as high/unknown
     * — never the old 15/low/allow — before the biometric signature. The
     * hard_confirm friction (typed "I UNDERSTAND" + cooling) is enforced by the
     * approval modal off `evaluateRequestGovernance` → `makeUnknownTypedDataVerdict`.
     */
    private async handleUnknownTypedDataSign(
        request: WCRequest,
        typedData: WCTypedData,
        chainId: number, biometricAction?: BiometricAction,
        confirmation?: StrongConfirmation,
    ): Promise<string> {
        // Unverifiable typed data is always hard_confirm: the service enforces it here.
        this.assertStrongConfirmation(request, makeUnknownTypedDataVerdict(), confirmation);
        return await withBiometricAction(translate('biometricPrompts.signRequestFrom', `Sign request from ${request.peerMeta.name}`, { dapp: request.peerMeta.name }), async (biometricAction) => {
            assertBiometricAction(biometricAction);
            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction);

            // Record the event honestly: unverifiable typed data is high-risk/unknown,
            // not the low-risk "allow" the old plain path sealed. The human passed a
            // hard_confirm, so the authorization decision is 'allow', but the risk band
            // and reason codes state that Provian could not verify what was signed.
            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'approve',
                intentText: `WalletConnect: sign UNVERIFIED typed data (${typedData?.primaryType || 'unknown type'}) for ${request.peerMeta.name}`,
                assetSymbol: 'N/A',
                amount: '0',
                chainId,
                riskScore: 80,
                riskCategory: 'high',
                policyDecision: 'allow',
                authorizationDecision: 'allow',
                authorizationStage: 'execution',
                authorizationMerchant: request.peerMeta.name,
                authorizationReasonCodes: ['unverified_typed_data', 'could_not_classify_signature'],
                authorizationPurpose: JSON.stringify({
                    source: 'walletconnect',
                    unverifiedTypedData: true,
                    primaryType: typedData?.primaryType || null,
                    frictionLane: 'hard_confirm',
                }),
                originBinding: request.peerMeta.url,
            }, biometricAction);

            const types = { ...typedData.types };
            delete types.EIP712Domain;
            try {
                return await wallet.signTypedData(typedData.domain, types, typedData.message);
            } catch (e) {
                await this.recordExecutionFailurePE('approve', request, e, {
                    riskScore: 80, riskCategory: 'high',
                }, biometricAction).catch(() => { });
                throw e;
            }

        }, biometricAction);
    }

    /**
     * Handle eth_sendTransaction: sign and broadcast the transaction.
     * Returns the transaction hash.
     */
    async handleSendTransaction(request: WCRequest, biometricAction?: BiometricAction, confirmation?: StrongConfirmation): Promise<string> {
        if (request.method !== 'eth_sendTransaction') {
            throw new Error(`Expected eth_sendTransaction, got ${request.method}`);
        }

        const txParams = request.params[0] as Record<string, string>;
        const chainIdNum = parseInt(request.chainId.split(':')[1] || '1');
        const chain = getChainById(chainIdNum);
        const dappName = request.peerMeta.name;
        const decoded = decodeTransactionCall(txParams.to || '', txParams.data || '0x', chainIdNum);

        const rpcUrls = getRpcUrls();
        const rpcUrl = rpcUrls[chainIdNum] || chain?.rpcUrl;
        if (!rpcUrl) {
            // Provian is an L2-native wallet (Base / Arbitrum / Optimism). We
            // advertise ETH mainnet on connect so message-signing / sign-in
            // dApps work, but we do not broadcast transactions there. Fail with
            // a clear, actionable message rather than an opaque RPC error.
            const supported = getActiveChains().map(c => c.name).join(', ');
            throw new Error(
                `Provian sends transactions on ${supported} only. This dApp requested ` +
                `${chain?.name || `chain ${chainIdNum}`}; switch the dApp's network to a supported chain.`
            );
        }

        // [CLAUDE.md pitfall #13] Route through the crypto-spending governance
        // pipeline (policy spend-limits, friction lanes, escalation-only) before
        // SeedManager signs. Biometric stays IN ADDITION, below.
        const verdict = await evaluateWalletConnectTransaction(
            {
                to: txParams.to || '',
                value: txParams.value || '0',
                data: txParams.data || '0x',
                chainId: chainIdNum,
                chainShortName: chain?.shortName,
                dappName,
                decoded,
            },
            this.getGovernanceSettings(), biometricAction
        );
        if (!verdict.allowed) {
            // [Security Invariant #5] Record the denied attempt; never skip the PE.
            await this.recordDeniedPE('send', request, verdict.denyReason || 'Blocked by your WalletConnect security policy.', verdict.riskScore, verdict, {
                assetSymbol: decoded.tokenSymbol,
                counterparty: decoded.counterparty || txParams.to,
            }, biometricAction);
            throw new WalletConnectPolicyError(
                verdict.denyReason || 'This transaction is blocked by your WalletConnect security policy.',
                verdict,
            );
        }
        this.assertStrongConfirmation(request, verdict, confirmation);

        // [Group 1 / M-2] Biometric session, IN ADDITION to governance.
        return await withBiometricAction(translate('biometricPrompts.approveTransactionVia', `Approve transaction via ${dappName}`, { dapp: dappName }), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const wallet = new ActionWallet(privateKey, biometricAction, provider, this.recoveryOperation(request) ?? `wc_${ethers.id(`${request.topic}:${request.id}`).slice(2)}`);

            const valueEth = txParams.value
                ? ethers.formatEther(txParams.value)
                : '0';

            // Enrich the Provenance Envelope so it records what was actually
            // signed (an ERC-20 transfer/approval), not just "0 ETH". The
            // createEnvelope call always fires — only its field values change
            // based on the decoded call (Security Invariant #5: never skip a PE).
            // Never encode an untrusted magnitude in the sealed PE: for an unknown
            // token we don't know decimals, so record 'unknown' rather than a raw
            // base-unit integer that could be mis-read as a whole-token count.
            const tokenAmount = decoded.amountFormatted
                || (decoded.tokenKnown ? decoded.amountRaw : 'unknown')
                || '0';
            // A non-zero native value attached to a token call must not be lost.
            const valueSuffix = valueEth !== '0' ? ` (+ ${valueEth} ETH attached)` : '';

            let peAssetSymbol = 'ETH';
            let peAmount = valueEth;
            let peCounterparty = txParams.to;
            let peIntent = `WalletConnect: transaction via ${dappName}`;

            if (decoded.kind === 'erc20_transfer') {
                peAssetSymbol = decoded.tokenSymbol || 'token';
                peAmount = tokenAmount;
                peCounterparty = decoded.counterparty || txParams.to;
                peIntent = decoded.from
                    ? `WalletConnect: pull ${tokenAmount} ${peAssetSymbol} from ${decoded.from} to ${peCounterparty} via ${dappName}${valueSuffix}`
                    : `WalletConnect: send ${tokenAmount} ${peAssetSymbol} to ${peCounterparty} via ${dappName}${valueSuffix}`;
            } else if (decoded.kind === 'erc20_approve') {
                peAssetSymbol = decoded.tokenSymbol || 'token';
                peAmount = decoded.isUnlimitedApproval ? 'unlimited' : tokenAmount;
                peCounterparty = decoded.counterparty || txParams.to;
                const verb = decoded.isIncrease ? 'increase allowance for' : 'approve';
                peIntent = `WalletConnect: ${verb} ${peCounterparty} to spend ${peAmount} ${peAssetSymbol} via ${dappName}${valueSuffix}`;
            } else if (decoded.kind === 'erc721_approve_all') {
                peAssetSymbol = decoded.tokenSymbol || 'NFT';
                peAmount = decoded.isUnlimitedApproval ? 'all' : '0';
                peCounterparty = decoded.counterparty || txParams.to;
                const op = decoded.isUnlimitedApproval ? 'setApprovalForAll' : 'revoke approvalForAll';
                peIntent = `WalletConnect: ${op}(${peCounterparty}) via ${dappName}${valueSuffix}`;
            } else if (decoded.kind === 'wrapped_calls') {
                // Record what the router / multicall wrapper actually carries, not a
                // generic "transaction" (Security Invariant #5: the PE records what
                // was signed). Each inner call is summarised in the intent text.
                const parts = (decoded.innerCalls || []).map(c => {
                    const sym = c.tokenKnown ? (c.tokenSymbol || 'token') : 'token';
                    if (c.kind === 'erc20_approve') {
                        const amt = c.isUnlimitedApproval ? 'unlimited' : (c.amountFormatted || c.amountRaw || '');
                        const verb = c.isIncrease ? 'increase allowance for' : 'approve';
                        return `${verb} ${c.counterparty} to spend ${amt} ${sym}`.trim();
                    }
                    if (c.kind === 'erc721_approve_all') {
                        return `${c.isUnlimitedApproval ? 'setApprovalForAll' : 'revoke approvalForAll'}(${c.counterparty})`;
                    }
                    const amt = c.amountFormatted || (c.tokenKnown ? c.amountRaw : 'unknown') || '';
                    return `send ${amt} ${sym} to ${c.counterparty}`.trim();
                });
                const wrapperLabel = decoded.wrapper === 'universal_router' ? 'router' : 'batch';
                peIntent = `WalletConnect: ${wrapperLabel} call [${parts.join('; ')}] via ${dappName}${valueSuffix}`;
            } else if (decoded.kind === 'contract_call') {
                peIntent = `WalletConnect: contract call ${decoded.selector} via ${dappName}`;
            }

            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'send',
                intentText: peIntent,
                assetSymbol: peAssetSymbol,
                amount: peAmount,
                chainId: chainIdNum,
                counterparty: peCounterparty,
                riskScore: verdict.riskScore,
                riskCategory: verdict.riskCategory,
                policyDecision: 'allow',
                authorizationDecision: 'allow',
                authorizationStage: 'execution',
                authorizationMerchant: dappName,
                authorizationReasonCodes: verdict.reasons,
                authorizationPurpose: JSON.stringify({
                    source: 'walletconnect',
                    frictionLane: verdict.lane,
                    category: verdict.category,
                    reasons: verdict.reasons,
                }),
                originBinding: request.peerMeta.url,
            }, biometricAction);

            const tx: ethers.TransactionRequest = {
                to: txParams.to,
                data: txParams.data || '0x',
                value: txParams.value ? BigInt(txParams.value) : 0n,
                chainId: chainIdNum,
            };

            if (txParams.gas || txParams.gasLimit) {
                tx.gasLimit = BigInt(txParams.gas || txParams.gasLimit);
            }
            if (txParams.gasPrice) {
                tx.gasPrice = BigInt(txParams.gasPrice);
            }
            if (txParams.maxFeePerGas) {
                tx.maxFeePerGas = BigInt(txParams.maxFeePerGas);
            }
            if (txParams.maxPriorityFeePerGas) {
                tx.maxPriorityFeePerGas = BigInt(txParams.maxPriorityFeePerGas);
            }

            try {
                const txResponse = await wallet.sendTransaction(tx);
                // [Audit #7] Broadcast != confirmed. ethers v6 resolves sendTransaction
                // on mempool acceptance, so a tx that mines-but-REVERTS (insufficient
                // balance, slippage, failing router, OOG) would otherwise be reported
                // to the user + dApp as a confirmed send, seal no execution-failure PE,
                // and credit the daily crypto cap for a no-op. Await the receipt and
                // treat status 0 as a failure — mirrors SwapEngine / TransactionService.
                const receipt = await txResponse.wait();
                if (!receipt || receipt.status === 0) {
                    // The catch below records the execution-failure PE and rethrows so
                    // approveRequest notifies the dApp and the screen surfaces the revert.
                    throw new Error(`Transaction reverted on-chain. Tx: ${txResponse.hash}`);
                }
                // WS5: record the governed spend into the daily accumulator AFTER a
                // CONFIRMED (non-reverted) tx so the daily on-chain cap accumulates for
                // value that actually moved. Scope 'wallet-owner' matches
                // ownerRequest().agentId; the tx hash is the dedupe id. Only priced
                // stablecoin value (verdict.amountUsd > 0) counts. Best-effort.
                recordDailyCryptoSpendUsd('wallet-owner', txResponse.hash, verdict.amountUsd).catch(() => { });
                const confirmedHash = receipt.hash ?? txResponse.hash;
                // append the execution OUTCOME carrying the confirmed transaction
                // (the authorization PE above was sealed before the hash existed) —
                // the success counterpart of recordExecutionFailurePE. On Base the
                // relay re-reads the transaction from the chain and mints the human's
                // send or swap there. Non-fatal: the transaction already confirmed.
                await ProvenanceEnvelopeManager.createEnvelope({
                    actionType: 'send',
                    intentText: `WalletConnect: confirmed transaction ${confirmedHash} via ${dappName}`,
                    assetSymbol: peAssetSymbol,
                    amount: peAmount,
                    chainId: chainIdNum,
                    counterparty: peCounterparty,
                    riskScore: verdict.riskScore,
                    riskCategory: verdict.riskCategory,
                    policyDecision: 'allow',
                    authorizationDecision: 'allow',
                    authorizationStage: 'execution',
                    authorizationMerchant: dappName,
                    originBinding: request.peerMeta.url,
                    txHash: confirmedHash,
                }, biometricAction).catch((peErr) => {
                    console.warn('[WalletConnect] confirmed-transaction PE failed (tx confirmed):', peErr);
                });
                return confirmedHash;
            } catch (e) {
                // Authorized + biometric-passed, but broadcast failed OR the mined tx
                // reverted. Append the execution outcome so the chain never shows
                // authorize-without-result (Security Invariant #5).
                await this.recordExecutionFailurePE('send', request, e, {
                    assetSymbol: peAssetSymbol, amount: peAmount, counterparty: peCounterparty,
                    riskScore: verdict.riskScore, riskCategory: verdict.riskCategory,
                }, biometricAction).catch(() => { });
                throw e;
            }

        }, biometricAction);
    }

    /**
     * Approve a pending request by executing it.
     * For signing requests, signs and returns the result.
     * For transactions, broadcasts and returns the tx hash.
     */
    private recoveryOperation(request: WCRequest): string | undefined {
        const saved = this.recoveryOperations.get(request.id);
        return saved?.request === request ? saved.operationId : undefined;
    }

    /** Reuse the connected-app review, policy and strong-confirmation flow for saved bytes. */
    queueTransactionRecovery(saved: RecoverableWalletTransaction): void {
        let id = -Date.now();
        while (this.pendingRequests.has(id)) id--;
        const request: WCRequest = {
            id, topic: 'local_transaction_recovery', method: 'eth_sendTransaction',
            chainId: `eip155:${saved.chainId}`, peerMeta: { name: translate('walletRecovery.connectedApp', 'Connected-app transaction recovery'), url: 'provian:transaction-recovery', icons: [] },
            params: [{ to: saved.to, data: saved.data, value: ethers.toQuantity(BigInt(saved.value)),
                gas: ethers.toQuantity(BigInt(saved.gasLimit)), maxFeePerGas: ethers.toQuantity(BigInt(saved.maxFeePerGas)),
                maxPriorityFeePerGas: ethers.toQuantity(BigInt(saved.maxPriorityFeePerGas)) }],
        };
        this.recoveryOperations.set(id, { request, operationId: saved.operationId });
        this.pendingRequests.set(id, request);
        this.emit('session_request', request);
    }

    async approveRequest(requestId: number, biometricAction?: BiometricAction, confirmation?: StrongConfirmation): Promise<string> {
        const request = this.pendingRequests.get(requestId);
        if (!request) throw new Error('Request not found');
        if (!this.web3wallet && !this.recoveryOperation(request)) throw new Error('WalletConnect not initialized');

        let result: string;
        try {
            if (request.method === 'eth_sendTransaction') {
                result = await this.handleSendTransaction(request, biometricAction, confirmation);
            } else {
                result = await this.handleSignRequest(request, biometricAction, confirmation);
            }
        } catch (err) {
            // [Pass-2 #30] The handler threw at EXECUTION time — an execution-time
            // governance denial (governance is re-evaluated here at execution,
            // closing the pre-eval TOCTOU) or a signing/broadcast failure. Previously this propagated straight to
            // the screen, which only Alert.alert'd and never told the dApp, so the
            // dApp's request was ORPHANED until its own timeout. Send a JSON-RPC
            // error so the dApp resolves immediately, drop the pending entry, then
            // re-throw so the screen can still surface the reason to the user.
            await this.respondRequestError(request, err).catch((notifyErr) => {
                // The dApp couldn't be reached (e.g. relay down) — it will time
                // out as before. Log for observability; never mask `err`.
                console.warn('[WalletConnect] Failed to notify dApp of execution-time error:', notifyErr);
            });
            this.pendingRequests.delete(requestId);
            this.recoveryOperations.delete(requestId);
            this.strongShownAtMs.delete(requestId);
            throw err;
        }

        if (!this.recoveryOperation(request)) await this.web3wallet!.respondSessionRequest({
            topic: request.topic,
            response: {
                id: requestId,
                jsonrpc: '2.0',
                result,
            },
        });

        this.pendingRequests.delete(requestId);
        this.recoveryOperations.delete(requestId);
        this.strongShownAtMs.delete(requestId);
        return result;
    }

    /**
     * [Pass-2 #30] Send a JSON-RPC error to the dApp for a request that failed at
     * EXECUTION time (a governance denial, or a signing / broadcast
     * failure), so the dApp gets an immediate, explicit rejection instead of
     * hanging until its own timeout. A wallet-side USER REJECTION — a policy
     * denial (WalletConnectPolicyError) OR a cancelled biometric
     * prompt (BiometricAuthError) — maps to EIP-1193 `4001` (request rejected by
     * the wallet). [Audit #35] A biometric cancel previously fell through to
     * `-32000` (JSON-RPC server error), which a dApp misclassifies as a transient
     * wallet FAULT and may auto-retry; it is a deliberate decline, so it is 4001.
     * Any other failure (broadcast / mined-revert, RPC error) maps to the JSON-RPC
     * 2.0 server-error code `-32000`. Best-effort — the caller swallows any
     * rejection from here so it can never mask the original failure.
     */
    private async respondRequestError(request: WCRequest, error: unknown): Promise<void> {
        if (!this.web3wallet || this.recoveryOperation(request) !== undefined) return;
        const isUserRejection =
            error instanceof WalletConnectPolicyError
            || error instanceof StrongConfirmationRequiredError
            || error instanceof BiometricAuthError
            || error instanceof ProvianReservedMessageError;
        const code = isUserRejection ? 4001 : -32000;
        const message = englishErrorMessage(error, 'Request failed');
        await this.web3wallet!.respondSessionRequest({
            topic: request.topic,
            response: {
                id: request.id,
                jsonrpc: '2.0',
                error: { code, message },
            },
        });
    }

    async rejectRequest(requestId: number, message = 'User rejected the request'): Promise<void> {
        const request = this.pendingRequests.get(requestId);
        if (!request) throw new Error('Request not found');
        if (!this.web3wallet && !this.recoveryOperation(request)) throw new Error('WalletConnect not initialized');

        if (!this.recoveryOperation(request)) await this.web3wallet!.respondSessionRequest({
            topic: request.topic,
            response: {
                id: requestId,
                jsonrpc: '2.0',
                error: {
                    code: 4001,
                    message,
                },
            },
        });

        this.pendingRequests.delete(requestId);
        this.recoveryOperations.delete(requestId);
        this.strongShownAtMs.delete(requestId);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private eventToRequest(event: Web3WalletTypes.SessionRequest): WCRequest {
        const session = this.web3wallet?.engine.signClient.session.get(event.topic);
        return {
            id: event.id,
            topic: event.topic,
            method: event.params.request.method,
            params: event.params.request.params,
            chainId: event.params.chainId,
            peerMeta: {
                name: session?.peer.metadata.name || 'Unknown dApp',
                url: session?.peer.metadata.url || '',
                icons: session?.peer.metadata.icons || [],
            },
        };
    }

    private async loadPersistedSessions(): Promise<void> {
        try {
            // Sync with the SDK's active sessions
            if (this.web3wallet) {
                const activeSessions = this.web3wallet.getActiveSessions();
                for (const [topic, session] of Object.entries(activeSessions)) {
                    this.sessions.set(topic, {
                        topic,
                        peerMeta: {
                            name: session.peer.metadata.name,
                            description: session.peer.metadata.description,
                            url: session.peer.metadata.url,
                            icons: session.peer.metadata.icons,
                        },
                        chains: Object.values(session.namespaces).flatMap(
                            ns => ns.accounts.map(a => a.split(':').slice(0, 2).join(':'))
                        ),
                        accounts: Object.values(session.namespaces).flatMap(ns => ns.accounts),
                        expiry: session.expiry,
                    });
                }
            }
        } catch (error) {
            console.error('[WalletConnect] Failed to load sessions:', error);
        }
    }

    private async persistSessions(): Promise<void> {
        // The SDK persists sessions internally; we just keep our local map in sync.
        // No separate AsyncStorage needed.
    }
}

export default WalletConnectService.getInstance();
