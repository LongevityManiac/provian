vi.mock('../../security/ActionWallet', async () => ({ ActionWallet: (await import('ethers')).ethers.Wallet }));
/**
 * WALLETCONNECT v2 SERVICE - INTEGRATION TESTS
 *
 * Covers 8 test areas:
 * 1. Pairing URI generation and validation
 * 2. Session proposal accept/reject lifecycle
 * 3. Request signing routed to correct chain's signer
 * 4. Multi-chain session proposals
 * 5. EIP-155 chain ID enforcement
 * 6. Disconnect and session cleanup
 * 7. Expired sessions and rejected pairings
 * 8. Network interruption recovery mid-session
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WCRequest } from '../WalletConnectService';

// =============================================================================
// vi.hoisted() - these run BEFORE vi.mock hoisting, so they can be referenced
// in mock factories
// =============================================================================

// Set env var FIRST - vi.hoisted runs before module imports
vi.hoisted(() => {
    process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = 'test-project-id';
});

const {
    mockCorePairingPair,
    mockApproveSession,
    mockRejectSession,
    mockDisconnectSession,
    mockRespondSessionRequest,
    mockGetActiveSessions,
    mockWeb3WalletOn,
    mockSignMessage,
    mockSignTypedData,
    mockSigningKeySign,
    mockSendTransaction,
    capturedHandlers,
} = vi.hoisted(() => {
    type Handler = (...args: unknown[]) => Promise<void>;
    const captured: {
        sessionProposal: Handler | null;
        sessionRequest: Handler | null;
        sessionDelete: Handler | null;
    } = { sessionProposal: null, sessionRequest: null, sessionDelete: null };

    return {
        mockCorePairingPair: vi.fn().mockResolvedValue(undefined),
        mockApproveSession: vi.fn(),
        mockRejectSession: vi.fn().mockResolvedValue(undefined),
        mockDisconnectSession: vi.fn().mockResolvedValue(undefined),
        mockRespondSessionRequest: vi.fn().mockResolvedValue(undefined),
        mockGetActiveSessions: vi.fn().mockReturnValue({}),
        mockWeb3WalletOn: vi.fn().mockImplementation((event: string, handler: Handler) => {
            if (event === 'session_proposal') captured.sessionProposal = handler;
            if (event === 'session_request') captured.sessionRequest = handler;
            if (event === 'session_delete') captured.sessionDelete = handler;
        }),
        mockSignMessage: vi.fn().mockResolvedValue('0xmocksignature_personal'),
        mockSignTypedData: vi.fn().mockResolvedValue('0xmocksignature_typed'),
        mockSigningKeySign: vi.fn().mockReturnValue({ serialized: '0xmocksignature_ethsign' }),
        // [Audit #7] The service now awaits the receipt and checks status, so the
        // resolved TransactionResponse must expose wait() → a confirmed receipt.
        mockSendTransaction: vi.fn().mockResolvedValue({
            hash: '0xtxhash123',
            wait: vi.fn().mockResolvedValue({ status: 1, hash: '0xtxhash123' }),
        }),
        capturedHandlers: captured,
    };
});

// Governance + store mocks (the service routes signing through these now). The
// governance wrapper itself is unit-tested for real lanes in
// WalletConnectGovernance.test.ts; here we drive controlled verdicts to assert
// the SERVICE enforces them (deny PE, no broadcast on block).
const {
    mockEvaluateWalletConnectTransaction,
    mockEvaluateWalletConnectPermit,
} = vi.hoisted(() => ({
    mockEvaluateWalletConnectTransaction: vi.fn(),
    mockEvaluateWalletConnectPermit: vi.fn(),
}));

// Daily on-chain spend accumulator (WS5 + Pass-2 #29). The service records into
// it after a successful send (tx hash) AND a successful permit sign (signature).
// Mocked so we can assert the WRITE happens; must resolve a promise because the
// service chains `.catch()` on the result.
const { mockRecordDailyCryptoSpendUsd } = vi.hoisted(() => ({
    mockRecordDailyCryptoSpendUsd: vi.fn(() => Promise.resolve()),
}));

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('@walletconnect/react-native-compat', () => ({}));

vi.mock('../../store/walletStore', () => ({
    useWalletStore: {
        getState: () => ({
            walletConnectGovernance: {
                requireApprovalConfirm: true,
                unlimitedApprovalPolicy: 'block',
                unknownContractPolicy: 'hard_confirm',
                perTransactionLimitUsd: 0,
                dailyLimitUsd: 0,
            },
        }),
    },
}));

vi.mock('../WalletConnectGovernance', () => {
    class WalletConnectPolicyError extends Error {
        verdict: unknown;
        constructor(message: string, verdict: unknown) {
            super(message);
            this.name = 'WalletConnectPolicyError';
            this.verdict = verdict;
        }
    }
    return {
        evaluateWalletConnectTransaction: mockEvaluateWalletConnectTransaction,
        evaluateWalletConnectPermit: mockEvaluateWalletConnectPermit,
        makeFailClosedVerdict: (category: string) => ({
            lane: 'block', allowed: false, requiresStrongConfirm: false,
            riskScore: 90, riskCategory: 'high', category,
            reasons: ['Could not verify this request — blocked for safety. Try again.'],
            denyReason: 'Could not verify this request — blocked for safety. Try again.',
        }),
        // [H3] Unverifiable typed data is always hard_confirm (the real builder's lane).
        makeUnknownTypedDataVerdict: () => ({
            lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
            riskScore: 80, riskCategory: 'high', category: 'unknown',
            reasons: ['Could not verify what this signature authorizes.'],
        }),
        WalletConnectPolicyError,
    };
});

vi.mock('../../crypto-governance/DailyCryptoSpendTracker', () => ({
    recordDailyCryptoSpendUsd: mockRecordDailyCryptoSpendUsd,
    getDailyCryptoSpentUsd: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn().mockResolvedValue('mock-hash'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));

vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({
    default: {
        createEnvelope: vi.fn().mockResolvedValue({ envelope_id: 'test-pe' }),
    },
}));

vi.mock('../../wallet/SeedManager', () => ({
    default: {
        getEVMPrivateKey: vi.fn().mockResolvedValue(
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
        ),
        // [Drift B fix] Production WalletConnectService awaits this before
        // signing (Group 1 / M-2). Default resolves so signing flows
        // proceed; tests that need rejection can mockRejectedValueOnce.
        requireBiometricSession: vi.fn().mockResolvedValue(undefined),
    },
}));

// [Audit #35] The service imports BiometricAuthError for the respondRequestError
// mapping. Mock it to supply just the class (avoids loading expo-local-
// authentication) so `error instanceof BiometricAuthError` matches the same
// class the test constructs.
vi.mock('../../security/requireBiometric', () => {
    class BiometricAuthError extends Error {
        readonly code = 'BIOMETRIC_AUTH_FAILED';
        readonly authError: string | undefined;
        constructor(authError?: string) {
            super(authError ?? 'Biometric authentication failed.');
            this.name = 'BiometricAuthError';
            this.authError = authError;
        }
    }
    return { BiometricAuthError, requireBiometric: vi.fn().mockResolvedValue(true) };
});

vi.mock('../../chains/evm/config', async (importOriginal) => ({
    // the reserved-message guard reads the REAL Provian contract set.
    PROVIAN_BASE_CONTRACTS: (await importOriginal<typeof import('../../chains/evm/config')>()).PROVIAN_BASE_CONTRACTS,
    getActiveChains: vi.fn().mockReturnValue([
        { chainId: 8453, name: 'Base', shortName: 'base', symbol: 'ETH', decimals: 18, rpcUrl: 'https://mainnet.base.org', explorerUrl: '', isTestnet: false },
        { chainId: 42161, name: 'Arbitrum One', shortName: 'arbitrum', symbol: 'ETH', decimals: 18, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorerUrl: '', isTestnet: false },
    ]),
    getChainById: vi.fn().mockImplementation((id: number) => {
        const chains: Record<number, { chainId: number; name: string; rpcUrl: string }> = {
            1: { chainId: 1, name: 'Ethereum', rpcUrl: 'https://eth.llamarpc.com' },
            8453: { chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org' },
            42161: { chainId: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc' },
        };
        return chains[id];
    }),
    getRpcUrls: vi.fn().mockReturnValue({
        8453: 'https://mainnet.base.org',
        42161: 'https://arb1.arbitrum.io/rpc',
    }),
    // Used by decodeCalldata.resolveToken (imported transitively via the service).
    TOKEN_ADDRESSES: {
        8453: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH: '0x4200000000000000000000000000000000000006' },
        42161: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
    },
}));

vi.mock('ethers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ethers')>();
    const formatEther = (wei: string | bigint) => {
        const val = typeof wei === 'string' ? BigInt(wei) : wei;
        return (Number(val) / 1e18).toString();
    };
    const isHexString = (value: unknown) =>
        typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
    const toUtf8String = (hex: string) =>
        Buffer.from(hex.slice(2), 'hex').toString('utf-8');
    const getBytes = (hex: string) => new Uint8Array(Buffer.from(hex.slice(2), 'hex'));

    class MockWallet {
        address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
        signingKey = { sign: mockSigningKeySign };
        provider: unknown;
        constructor(_pk: string, provider?: unknown) { this.provider = provider; }
        signMessage = mockSignMessage;
        signTypedData = mockSignTypedData;
        sendTransaction = mockSendTransaction;
    }

    class MockJsonRpcProvider {
        url: string;
        constructor(url: string) { this.url = url; }
    }

    return {
        ethers: { id: actual.ethers.id, toQuantity: actual.ethers.toQuantity, formatEther, isHexString, toUtf8String, getBytes, Wallet: MockWallet, JsonRpcProvider: MockJsonRpcProvider },
    };
});

vi.mock('@walletconnect/core', () => ({
    Core: class MockCore {
        projectId: string;
        pairing = { pair: mockCorePairingPair };
        constructor(opts: { projectId: string }) { this.projectId = opts.projectId; }
    },
}));

vi.mock('@walletconnect/web3wallet', () => ({
    Web3Wallet: {
        init: vi.fn().mockResolvedValue({
            on: mockWeb3WalletOn,
            approveSession: mockApproveSession,
            rejectSession: mockRejectSession,
            disconnectSession: mockDisconnectSession,
            respondSessionRequest: mockRespondSessionRequest,
            getActiveSessions: mockGetActiveSessions,
            core: { pairing: { pair: mockCorePairingPair } },
            engine: {
                signClient: {
                    session: {
                        get: vi.fn().mockReturnValue({
                            peer: {
                                metadata: {
                                    name: 'Test dApp',
                                    url: 'https://test-dapp.com',
                                    icons: ['https://test-dapp.com/icon.png'],
                                },
                            },
                        }),
                    },
                },
            },
        }),
    },
}));

// Env var is set in vi.hoisted() above - before module import.

// =============================================================================
// IMPORT SERVICE (after all mocks)
// =============================================================================

import WalletConnectService from '../WalletConnectService';
import ProvenanceEnvelopeManager from '../../provenance/ProvenanceEnvelopeManager';
import { ProvianReservedMessageError, PROVIAN_RESERVED_USER_MESSAGE } from '../provianReserved';
import { ALLOWED_VECTORS, RESERVED_VECTORS } from './provianReservedVectors';

// =============================================================================
// HELPERS
// =============================================================================

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const GOV_SPENDER = '0x2222222222222222222222222222222222222222';
const GOV_UNKNOWN_TOKEN = '0x1234567890123456789012345678901234567890';

// Default "allow" verdicts so the existing (non-governance) tests pass unchanged.
const ALLOW_TX_VERDICT = {
    lane: 'auto_approve', allowed: true, requiresStrongConfirm: false,
    riskScore: 15, riskCategory: 'low', category: 'token_transfer', reasons: [],
};
const ALLOW_PERMIT_VERDICT = {
    lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
    riskScore: 70, riskCategory: 'high', category: 'token_approval', reasons: [],
};

/** Reset singleton private state so each test starts fresh. */
function resetServiceState(): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const svc = WalletConnectService as any;
    svc.web3wallet = null;
    svc.sessions = new Map();
    svc.pendingRequests = new Map();
    svc.strongShownAtMs = new Map();
    svc.recoveryOperations = new Map();
    svc.eventHandlers = new Map();
    svc.initialized = false;
    svc.pendingProposal = null;
    /* eslint-enable */
}

/**
 * [H3] The confirmed flow: the service showed this request a strong verdict long enough ago for the
 * cooling-off to have elapsed, and the owner typed the phrase for THIS request.
 */
function confirmedFor(id: number): { requestId: number; phrase: string } {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    (WalletConnectService as any).strongShownAtMs.set(id, Date.now() - 60_000);
    return { requestId: id, phrase: 'I UNDERSTAND' };
}

function makeSessionProposal(id: number) {
    return {
        id,
        params: {
            proposer: {
                metadata: {
                    name: 'Test dApp',
                    description: 'A test decentralized app',
                    url: 'https://test-dapp.com',
                    icons: ['https://test-dapp.com/icon.png'],
                },
            },
            requiredNamespaces: {
                eip155: {
                    chains: ['eip155:8453'],
                    methods: ['personal_sign', 'eth_sendTransaction'],
                    events: ['chainChanged', 'accountsChanged'],
                },
            },
        },
    };
}

function makeSessionRequestEvent(
    id: number,
    topic: string,
    method: string,
    params: unknown[],
    chainId = 'eip155:8453'
) {
    return {
        id,
        topic,
        params: { request: { method, params }, chainId },
    };
}

function mockApprovedSessionResult(topic: string, accounts: string[]) {
    return {
        topic,
        peer: {
            metadata: {
                name: 'Test dApp',
                description: 'A test decentralized app',
                url: 'https://test-dapp.com',
                icons: ['https://test-dapp.com/icon.png'],
            },
        },
        namespaces: {
            eip155: {
                accounts,
                methods: ['personal_sign', 'eth_sendTransaction'],
                events: ['chainChanged', 'accountsChanged'],
            },
        },
        expiry: Math.floor(Date.now() / 1000) + 86400,
    };
}

async function initWithSession(topic: string, accounts?: string[]) {
    await WalletConnectService.initialize();
    const accts = accounts || [`eip155:8453:${TEST_ADDRESS}`];
    mockApproveSession.mockResolvedValue(mockApprovedSessionResult(topic, accts));
    return WalletConnectService.approveSession(Date.now(), TEST_ADDRESS);
}

// =============================================================================
// TESTS
// =============================================================================

describe('WalletConnectService', () => {
    beforeEach(async () => {
        // Reset call history but preserve mock implementations
        vi.clearAllMocks();

        // Restore critical mock return values that clearAllMocks wiped
        mockCorePairingPair.mockResolvedValue(undefined);
        mockRejectSession.mockResolvedValue(undefined);
        mockDisconnectSession.mockResolvedValue(undefined);
        mockRespondSessionRequest.mockResolvedValue(undefined);
        mockGetActiveSessions.mockReturnValue({});
        mockSignMessage.mockResolvedValue('0xmocksignature_personal');
        mockSignTypedData.mockResolvedValue('0xmocksignature_typed');
        mockSigningKeySign.mockReturnValue({ serialized: '0xmocksignature_ethsign' });
        mockSendTransaction.mockResolvedValue({
            hash: '0xtxhash123',
            wait: vi.fn().mockResolvedValue({ status: 1, hash: '0xtxhash123' }),
        });

        // Re-wire the Web3Wallet.init mock (clearAllMocks wipes it)
        const { Web3Wallet } = await import('@walletconnect/web3wallet');
        vi.mocked(Web3Wallet.init).mockResolvedValue({
            on: mockWeb3WalletOn,
            approveSession: mockApproveSession,
            rejectSession: mockRejectSession,
            disconnectSession: mockDisconnectSession,
            respondSessionRequest: mockRespondSessionRequest,
            getActiveSessions: mockGetActiveSessions,
            core: { pairing: { pair: mockCorePairingPair } },
            engine: {
                signClient: {
                    session: {
                        get: vi.fn().mockReturnValue({
                            peer: {
                                metadata: {
                                    name: 'Test dApp',
                                    url: 'https://test-dapp.com',
                                    icons: ['https://test-dapp.com/icon.png'],
                                },
                            },
                        }),
                    },
                },
            },
        } as never);

        // Restore SeedManager mock
        const SeedManager = (await import('../../wallet/SeedManager')).default;
        vi.mocked(SeedManager.getEVMPrivateKey).mockResolvedValue(
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
        );

        // Restore ProvenanceEnvelopeManager mock
        const PEM = (await import('../../provenance/ProvenanceEnvelopeManager')).default;
        vi.mocked(PEM.createEnvelope).mockResolvedValue({ envelope_id: 'test-pe' } as never);

        // Restore governance mocks (clearAllMocks wiped them).
        mockEvaluateWalletConnectTransaction.mockResolvedValue(ALLOW_TX_VERDICT as never);
        mockEvaluateWalletConnectPermit.mockResolvedValue(ALLOW_PERMIT_VERDICT as never);
        // Tracker write mock must keep returning a promise (the service chains
        // `.catch()` on it). clearAllMocks resets call history only.
        mockRecordDailyCryptoSpendUsd.mockImplementation(() => Promise.resolve());

        // Restore evm config mocks
        const evmConfig = await import('../../chains/evm/config');
        vi.mocked(evmConfig.getActiveChains).mockReturnValue([
            { chainId: 8453, name: 'Base', shortName: 'base', symbol: 'ETH', decimals: 18, rpcUrl: 'https://mainnet.base.org', explorerUrl: '', isTestnet: false },
            { chainId: 42161, name: 'Arbitrum One', shortName: 'arbitrum', symbol: 'ETH', decimals: 18, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorerUrl: '', isTestnet: false },
        ]);
        vi.mocked(evmConfig.getRpcUrls).mockReturnValue({
            8453: 'https://mainnet.base.org',
            42161: 'https://arb1.arbitrum.io/rpc',
        });

        resetServiceState();
        capturedHandlers.sessionProposal = null;
        capturedHandlers.sessionRequest = null;
        capturedHandlers.sessionDelete = null;
    });

    // =========================================================================
    // 1. Pairing URI validation
    // =========================================================================
    describe('1. Pairing URI validation', () => {
        it('rejects URIs that do not start with "wc:"', async () => {
            await WalletConnectService.initialize();
            await expect(WalletConnectService.pair('https://example.com')).rejects.toThrow(
                'Invalid WalletConnect URI. Must start with "wc:"'
            );
            expect(mockCorePairingPair).not.toHaveBeenCalled();
        });

        it('rejects empty string URI', async () => {
            await WalletConnectService.initialize();
            await expect(WalletConnectService.pair('')).rejects.toThrow(
                'Invalid WalletConnect URI'
            );
        });

        it('rejects URI with uppercase "WC:" prefix (case-sensitive)', async () => {
            await WalletConnectService.initialize();
            await expect(WalletConnectService.pair('WC:abc123@2')).rejects.toThrow(
                'Invalid WalletConnect URI'
            );
        });

        it('accepts valid wc: URI and calls core.pairing.pair', async () => {
            await WalletConnectService.initialize();
            const validUri = 'wc:a1b2c3d4@2?relay-protocol=irn&symKey=abc123';
            await WalletConnectService.pair(validUri);
            expect(mockCorePairingPair).toHaveBeenCalledWith({ uri: validUri });
        });

        it('auto-initializes when pair() is called before initialize()', async () => {
            expect(WalletConnectService.isInitialized()).toBe(false);
            await WalletConnectService.pair('wc:deadbeef@2?relay-protocol=irn&symKey=xyz');
            expect(WalletConnectService.isInitialized()).toBe(true);
        });

        it('propagates SDK pairing errors', async () => {
            await WalletConnectService.initialize();
            mockCorePairingPair.mockRejectedValueOnce(new Error('Pairing expired'));
            await expect(WalletConnectService.pair('wc:expired@2')).rejects.toThrow(
                'Pairing expired'
            );
        });

        it('initialize is idempotent - second call is a no-op', async () => {
            await WalletConnectService.initialize();
            await WalletConnectService.initialize();
            expect(WalletConnectService.isInitialized()).toBe(true);
        });
    });

    // =========================================================================
    // 2. Session proposal accept/reject lifecycle
    // =========================================================================
    describe('2. Session proposal accept/reject lifecycle', () => {
        const PROPOSAL_ID = 1001;
        const SESSION_TOPIC = 'topic_abc';

        beforeEach(async () => {
            await WalletConnectService.initialize();
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult(SESSION_TOPIC, [
                    `eip155:8453:${TEST_ADDRESS}`,
                    `eip155:42161:${TEST_ADDRESS}`,
                    `eip155:1:${TEST_ADDRESS}`,
                ])
            );
        });

        it('approveSession stores session and clears pending proposal', async () => {
            capturedHandlers.sessionProposal?.(makeSessionProposal(PROPOSAL_ID));
            expect(WalletConnectService.getPendingProposal()).not.toBeNull();

            const session = await WalletConnectService.approveSession(PROPOSAL_ID, TEST_ADDRESS);
            expect(session.topic).toBe(SESSION_TOPIC);
            expect(session.peerMeta.name).toBe('Test dApp');
            expect(session.peerMeta.url).toBe('https://test-dapp.com');

            expect(WalletConnectService.getSessions()).toHaveLength(1);
            expect(WalletConnectService.getPendingProposal()).toBeNull();
        });

        it('approveSession creates a Provenance Envelope', async () => {
            await WalletConnectService.approveSession(PROPOSAL_ID, TEST_ADDRESS);
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'approve',
                    originBinding: 'https://test-dapp.com',
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('approveSession passes correct namespaces with accounts for all active chains + ETH mainnet', async () => {
            await WalletConnectService.approveSession(PROPOSAL_ID, TEST_ADDRESS);
            expect(mockApproveSession).toHaveBeenCalledWith({
                id: PROPOSAL_ID,
                namespaces: {
                    eip155: {
                        accounts: expect.arrayContaining([
                            `eip155:8453:${TEST_ADDRESS}`,
                            `eip155:42161:${TEST_ADDRESS}`,
                            `eip155:1:${TEST_ADDRESS}`,
                        ]),
                        methods: expect.arrayContaining([
                            'personal_sign',
                            'eth_sendTransaction',
                            'eth_signTypedData_v4',
                        ]),
                        events: ['chainChanged', 'accountsChanged'],
                    },
                },
            });
            // [Security] eth_sign and eth_signTransaction must never be advertised.
            const advertised = (mockApproveSession.mock.calls[0][0] as { namespaces: { eip155: { methods: string[] } } })
                .namespaces.eip155.methods;
            expect(advertised).not.toContain('eth_sign');
            expect(advertised).not.toContain('eth_signTransaction');
        });

        it('rejectSession sends code 4001 and clears pending proposal', async () => {
            capturedHandlers.sessionProposal?.(makeSessionProposal(PROPOSAL_ID));
            await WalletConnectService.rejectSession(PROPOSAL_ID);

            expect(mockRejectSession).toHaveBeenCalledWith({
                id: PROPOSAL_ID,
                reason: { code: 4001, message: 'User rejected the session' },
            });
            expect(WalletConnectService.getPendingProposal()).toBeNull();
        });

        it('emits session_proposal event when proposal arrives', async () => {
            const handler = vi.fn();
            WalletConnectService.on('session_proposal', handler);
            capturedHandlers.sessionProposal?.(makeSessionProposal(PROPOSAL_ID));
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('approveSession throws if not initialized', async () => {
            resetServiceState();
            await expect(
                WalletConnectService.approveSession(PROPOSAL_ID, TEST_ADDRESS)
            ).rejects.toThrow('not initialized');
        });

        it('rejectSession throws if not initialized', async () => {
            resetServiceState();
            await expect(
                WalletConnectService.rejectSession(PROPOSAL_ID)
            ).rejects.toThrow('not initialized');
        });
    });

    // =========================================================================
    // 3. Request signing routes through ethers.Wallet
    // =========================================================================
    describe('3. Request signing routes through ethers.Wallet', () => {
        const SESSION_TOPIC = 'topic_sign';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignMessage.mockClear();
            mockSignTypedData.mockClear();
            mockSigningKeySign.mockClear();
            mockSendTransaction.mockClear();
        });

        it('personal_sign: signs the RAW BYTES of a hex message (EIP-191), not a re-encoded string', async () => {
            // (a message naming Provian is now refused at the door — see §14.)
            const hexMsg = '0x' + Buffer.from('Hello Base').toString('hex');
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(201, SESSION_TOPIC, 'personal_sign', [hexMsg, TEST_ADDRESS])
            );

            const result = await WalletConnectService.approveRequest(201);
            // review #6: a hex payload must be signed as raw bytes. Re-decoding to
            // a UTF-8 string and re-encoding breaks binary/digest payloads.
            expect(mockSignMessage).toHaveBeenCalledWith(
                new Uint8Array(Buffer.from('Hello Base')),
            );
            expect(result).toBe('0xmocksignature_personal');
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 201, jsonrpc: '2.0', result: '0xmocksignature_personal' },
            });
            expect(WalletConnectService.getPendingRequest(201)).toBeUndefined();
        });

        it('a failed signature tells the dApp and records the PE in English, not the screen language', async () => {
            const english = 'A live biometric action is required to access wallet secrets.';
            const failure = Object.assign(new Error('Se requiere una acción biométrica activa.'), { englishMessage: english });
            mockSignMessage.mockRejectedValueOnce(failure);
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(209, SESSION_TOPIC, 'personal_sign', ['Hello plain text', TEST_ADDRESS])
            );
            await expect(WalletConnectService.approveRequest(209)).rejects.toBe(failure);
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 209, jsonrpc: '2.0', error: { code: -32000, message: english } },
            });
            const envelope = vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mock.calls
                .map(([input]) => input)
                .find((input) => String(input.intentText).includes('execution FAILED'));
            expect(envelope?.intentText).toContain(english);
            expect(envelope?.intentText).not.toContain('Se requiere');
            expect(String(envelope?.authorizationPurpose)).toContain(english);
        });

        it('personal_sign: handles non-hex plain text message', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(202, SESSION_TOPIC, 'personal_sign', ['Hello plain text', TEST_ADDRESS])
            );
            await WalletConnectService.approveRequest(202);
            expect(mockSignMessage).toHaveBeenCalledWith('Hello plain text');
        });

        it('personal_sign: signs a binary (non-UTF-8) 32-byte digest as raw bytes', async () => {
            // A 32-byte digest that is not valid UTF-8 - the exact case the old
            // toUtf8String() path corrupted or threw on (review #6).
            const digest = new Uint8Array(32);
            for (let i = 0; i < 32; i++) digest[i] = (i * 7 + 0x80) & 0xff;
            const hexDigest = '0x' + Buffer.from(digest).toString('hex');
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(203, SESSION_TOPIC, 'personal_sign', [hexDigest, TEST_ADDRESS])
            );
            await WalletConnectService.approveRequest(203);
            expect(mockSignMessage).toHaveBeenCalledWith(new Uint8Array(digest));
        });

        it('eth_signTypedData_v4: parses JSON and strips EIP712Domain from types', async () => {
            const typedData = JSON.stringify({
                types: {
                    EIP712Domain: [{ name: 'name', type: 'string' }],
                    Mail: [{ name: 'content', type: 'string' }],
                },
                domain: { name: 'TestApp' },
                message: { content: 'hello' },
            });

            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(203, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, typedData])
            );

            const result = await WalletConnectService.approveRequest(203, undefined, confirmedFor(203));
            expect(mockSignTypedData).toHaveBeenCalledWith(
                { name: 'TestApp' },
                { Mail: [{ name: 'content', type: 'string' }] },
                { content: 'hello' }
            );
            expect(result).toBe('0xmocksignature_typed');
        });

        it('eth_signTypedData (v3 alias): same code path', async () => {
            const typedData = JSON.stringify({
                types: { EIP712Domain: [], Simple: [{ name: 'val', type: 'uint256' }] },
                domain: {},
                message: { val: '42' },
            });
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(209, SESSION_TOPIC, 'eth_signTypedData', [TEST_ADDRESS, typedData])
            );
            await WalletConnectService.approveRequest(209, undefined, confirmedFor(209));
            expect(mockSignTypedData).toHaveBeenCalled();
        });

        it('eth_sign: rejected at the door — never signed or surfaced', async () => {
            const hash = '0xdeadbeef00000000000000000000000000000000000000000000000000000000';
            await capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(204, SESSION_TOPIC, 'eth_sign', [TEST_ADDRESS, hash])
            );
            // [Security: Unknown = Block] eth_sign is auto-rejected before any prompt.
            expect(WalletConnectService.getPendingRequest(204)).toBeUndefined();
            expect(mockSigningKeySign).not.toHaveBeenCalled();
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: {
                    id: 204,
                    jsonrpc: '2.0',
                    error: { code: 4001, message: 'Method not supported: eth_sign' },
                },
            });
        });

        it('eth_sendTransaction: sends tx and returns hash', async () => {
            const txParams = {
                from: TEST_ADDRESS,
                to: '0x1234567890123456789012345678901234567890',
                value: '0xDE0B6B3A7640000',
                data: '0x',
                gas: '0x5208',
            };
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(205, SESSION_TOPIC, 'eth_sendTransaction', [txParams])
            );
            const result = await WalletConnectService.approveRequest(205);
            expect(mockSendTransaction).toHaveBeenCalled();
            expect(result).toBe('0xtxhash123');
        });

        it('eth_sendTransaction creates PE with counterparty and amount', async () => {
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
            const txParams = { from: TEST_ADDRESS, to: '0xRecipientAddr', value: '0xDE0B6B3A7640000', data: '0x' };
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(206, SESSION_TOPIC, 'eth_sendTransaction', [txParams])
            );
            await WalletConnectService.approveRequest(206);
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'send',
                    counterparty: '0xRecipientAddr',
                    assetSymbol: 'ETH',
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('rejectRequest sends error response and cleans up', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(207, SESSION_TOPIC, 'personal_sign', ['0xab', TEST_ADDRESS])
            );
            await WalletConnectService.rejectRequest(207, 'User said no');
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 207, jsonrpc: '2.0', error: { code: 4001, message: 'User said no' } },
            });
            expect(WalletConnectService.getPendingRequest(207)).toBeUndefined();
        });

        it('rejectRequest uses default message when none provided', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(210, SESSION_TOPIC, 'personal_sign', ['msg', TEST_ADDRESS])
            );
            await WalletConnectService.rejectRequest(210);
            expect(mockRespondSessionRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    response: expect.objectContaining({
                        error: expect.objectContaining({ message: 'User rejected the request' }),
                    }),
                })
            );
        });

        it('unsupported method is rejected at the door — never stored', async () => {
            await capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(208, SESSION_TOPIC, 'eth_getBalance', [TEST_ADDRESS, 'latest'])
            );
            expect(WalletConnectService.getPendingRequest(208)).toBeUndefined();
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: {
                    id: 208,
                    jsonrpc: '2.0',
                    error: { code: 4001, message: 'Method not supported: eth_getBalance' },
                },
            });
        });

        it('approveRequest throws for non-existent request ID', async () => {
            await expect(WalletConnectService.approveRequest(99999)).rejects.toThrow('Request not found');
        });

        it('rejectRequest throws for non-existent request ID', async () => {
            await expect(WalletConnectService.rejectRequest(99999)).rejects.toThrow('Request not found');
        });
    });

    // =========================================================================
    // 4. Multi-chain session proposals
    // =========================================================================
    describe('4. Multi-chain session proposals', () => {
        beforeEach(async () => {
            await WalletConnectService.initialize();
        });

        it('dApp requesting Base + Arbitrum gets both chains in approved namespaces', async () => {
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_multi', [
                    `eip155:8453:${TEST_ADDRESS}`,
                    `eip155:42161:${TEST_ADDRESS}`,
                    `eip155:1:${TEST_ADDRESS}`,
                ])
            );
            const session = await WalletConnectService.approveSession(300, TEST_ADDRESS);
            expect(session.chains).toContain('eip155:8453');
            expect(session.chains).toContain('eip155:42161');
            expect(session.chains).toContain('eip155:1');
        });

        it('accounts include address for every active chain + ETH mainnet', async () => {
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_multi2', [
                    `eip155:8453:${TEST_ADDRESS}`,
                    `eip155:42161:${TEST_ADDRESS}`,
                    `eip155:1:${TEST_ADDRESS}`,
                ])
            );
            const session = await WalletConnectService.approveSession(301, TEST_ADDRESS);
            expect(session.accounts).toHaveLength(3);
            expect(session.accounts).toContain(`eip155:8453:${TEST_ADDRESS}`);
            expect(session.accounts).toContain(`eip155:42161:${TEST_ADDRESS}`);
            expect(session.accounts).toContain(`eip155:1:${TEST_ADDRESS}`);
        });

        it('does not duplicate ETH mainnet if already in active chains', async () => {
            const evmConfig = await import('../../chains/evm/config');
            vi.mocked(evmConfig.getActiveChains).mockReturnValueOnce([
                { chainId: 1, name: 'Ethereum', shortName: 'eth', symbol: 'ETH', decimals: 18, rpcUrl: 'https://eth.llamarpc.com', explorerUrl: '', isTestnet: false },
                { chainId: 8453, name: 'Base', shortName: 'base', symbol: 'ETH', decimals: 18, rpcUrl: 'https://mainnet.base.org', explorerUrl: '', isTestnet: false },
            ]);
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_nodup', [`eip155:1:${TEST_ADDRESS}`, `eip155:8453:${TEST_ADDRESS}`])
            );
            await WalletConnectService.approveSession(302, TEST_ADDRESS);
            const call = mockApproveSession.mock.calls[0][0];
            const eth1Accounts = (call.namespaces.eip155.accounts as string[]).filter(
                (a: string) => a.startsWith('eip155:1:')
            );
            expect(eth1Accounts.length).toBe(1);
        });

        it('session chains array is derived from namespace accounts', async () => {
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_extract', [
                    `eip155:8453:${TEST_ADDRESS}`,
                    `eip155:42161:${TEST_ADDRESS}`,
                ])
            );
            const session = await WalletConnectService.approveSession(303, TEST_ADDRESS);
            expect(session.chains).toEqual(expect.arrayContaining(['eip155:8453', 'eip155:42161']));
        });
    });

    // =========================================================================
    // 5. EIP-155 chain ID enforcement
    // =========================================================================
    describe('5. EIP-155 chain ID enforcement', () => {
        const SESSION_TOPIC = 'topic_chain_enforce';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
        });

        it('request chainId is captured from the session_request event', () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(401, SESSION_TOPIC, 'personal_sign', ['0xab', TEST_ADDRESS], 'eip155:42161')
            );
            expect(WalletConnectService.getPendingRequest(401)?.chainId).toBe('eip155:42161');
        });

        it('transaction uses the chain ID from the request for PE recording', async () => {
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(402, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }], 'eip155:8453')
            );
            await WalletConnectService.approveRequest(402);
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ chainId: 8453 }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('transaction for unsupported chain throws a clear, actionable error', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(403, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }], 'eip155:999999')
            );
            await expect(WalletConnectService.approveRequest(403)).rejects.toThrow('Provian sends transactions on');
        });

        it('signing requests record the correct chainId in the PE', async () => {
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(404, SESSION_TOPIC, 'personal_sign', ['hello', TEST_ADDRESS], 'eip155:42161')
            );
            await WalletConnectService.approveRequest(404);
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ chainId: 42161 }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('parseTransactionDetails returns correct chainName for known chains', () => {
            const request: WCRequest = {
                id: 405, topic: SESSION_TOPIC, method: 'eth_sendTransaction',
                params: [{ from: TEST_ADDRESS, to: '0xR', value: '0xDE0B6B3A7640000', data: '0x' }],
                chainId: 'eip155:8453',
                peerMeta: { name: 'Test', url: 'https://test.com', icons: [] },
            };
            const details = WalletConnectService.parseTransactionDetails(request);
            expect(details?.chainId).toBe(8453);
            expect(details?.chainName).toBe('Base');
        });

        it('parseTransactionDetails returns fallback name for unknown chain', () => {
            const request: WCRequest = {
                id: 406, topic: SESSION_TOPIC, method: 'eth_sendTransaction',
                params: [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }],
                chainId: 'eip155:31337',
                peerMeta: { name: 'Test', url: 'https://test.com', icons: [] },
            };
            expect(WalletConnectService.parseTransactionDetails(request)?.chainName).toBe('Chain 31337');
        });

        it('parseTransactionDetails returns null for non-transaction methods', () => {
            const request: WCRequest = {
                id: 407, topic: SESSION_TOPIC, method: 'personal_sign',
                params: ['0xab', TEST_ADDRESS], chainId: 'eip155:8453',
                peerMeta: { name: 'Test', url: 'https://test.com', icons: [] },
            };
            expect(WalletConnectService.parseTransactionDetails(request)).toBeNull();
        });

        it('parseTransactionDetails handles missing value', () => {
            const request: WCRequest = {
                id: 408, topic: SESSION_TOPIC, method: 'eth_sendTransaction',
                params: [{ from: TEST_ADDRESS, to: '0xR', data: '0x' }],
                chainId: 'eip155:8453',
                peerMeta: { name: 'Test', url: 'https://test.com', icons: [] },
            };
            const details = WalletConnectService.parseTransactionDetails(request);
            expect(details?.value).toBe('0');
            expect(details?.valueWei).toBe('0x0');
        });
    });

    // =========================================================================
    // 6. Disconnect and session cleanup
    // =========================================================================
    describe('6. Disconnect and session cleanup', () => {
        const SESSION_TOPIC = 'topic_disconnect';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
        });

        it('disconnectSession removes session from active list', async () => {
            expect(WalletConnectService.getSessions()).toHaveLength(1);
            await WalletConnectService.disconnectSession(SESSION_TOPIC);
            expect(WalletConnectService.getSessions()).toHaveLength(0);
        });

        it('disconnectSession calls SDK disconnectSession with code 6000', async () => {
            await WalletConnectService.disconnectSession(SESSION_TOPIC);
            expect(mockDisconnectSession).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                reason: { code: 6000, message: 'User disconnected' },
            });
        });

        it('disconnectSession still removes local session even if SDK throws', async () => {
            mockDisconnectSession.mockRejectedValueOnce(new Error('Session already expired'));
            await WalletConnectService.disconnectSession(SESSION_TOPIC);
            expect(WalletConnectService.getSessions()).toHaveLength(0);
        });

        it('session_delete event from SDK removes session and emits event', async () => {
            const handler = vi.fn();
            WalletConnectService.on('session_delete', handler);
            expect(WalletConnectService.getSessions()).toHaveLength(1);

            await capturedHandlers.sessionDelete?.({ topic: SESSION_TOPIC });
            expect(WalletConnectService.getSessions()).toHaveLength(0);
            expect(handler).toHaveBeenCalledWith(SESSION_TOPIC);
        });

        it('disconnecting a non-existent topic does not throw', async () => {
            await expect(
                WalletConnectService.disconnectSession('nonexistent_topic')
            ).resolves.not.toThrow();
        });

        it('event unsubscribe function works correctly', async () => {
            const handler = vi.fn();
            const unsub = WalletConnectService.on('session_delete', handler);

            await capturedHandlers.sessionDelete?.({ topic: SESSION_TOPIC });
            expect(handler).toHaveBeenCalledTimes(1);

            unsub();
            await capturedHandlers.sessionDelete?.({ topic: 'any' });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('multiple sessions can coexist and be disconnected independently', async () => {
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_2', [`eip155:8453:${TEST_ADDRESS}`])
            );
            await WalletConnectService.approveSession(601, TEST_ADDRESS);
            expect(WalletConnectService.getSessions()).toHaveLength(2);

            await WalletConnectService.disconnectSession(SESSION_TOPIC);
            const remaining = WalletConnectService.getSessions();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].topic).toBe('topic_2');
        });
    });

    // =========================================================================
    // 7. Expired sessions and rejected pairings
    // =========================================================================
    describe('7. Expired sessions and rejected pairings', () => {
        beforeEach(async () => {
            await WalletConnectService.initialize();
        });

        it('pairing timeout (SDK error) propagates as thrown error', async () => {
            mockCorePairingPair.mockRejectedValueOnce(new Error('Pairing timeout'));
            await expect(WalletConnectService.pair('wc:timeout@2')).rejects.toThrow('Pairing timeout');
        });

        it('session proposal rejected by user does not create a session', async () => {
            capturedHandlers.sessionProposal?.(makeSessionProposal(701));
            await WalletConnectService.rejectSession(701);
            expect(WalletConnectService.getSessions()).toHaveLength(0);
            expect(WalletConnectService.getPendingProposal()).toBeNull();
        });

        it('session expiry event from SDK removes the session', async () => {
            mockApproveSession.mockResolvedValue(
                mockApprovedSessionResult('topic_expiry', [`eip155:8453:${TEST_ADDRESS}`])
            );
            await WalletConnectService.approveSession(702, TEST_ADDRESS);
            expect(WalletConnectService.getSessions()).toHaveLength(1);

            await capturedHandlers.sessionDelete?.({ topic: 'topic_expiry' });
            expect(WalletConnectService.getSessions()).toHaveLength(0);
        });

        it('loadPersistedSessions syncs with SDK active sessions on init', async () => {
            resetServiceState();
            mockGetActiveSessions.mockReturnValue({
                'persisted_topic': {
                    peer: {
                        metadata: { name: 'Persisted dApp', description: 'Still active', url: 'https://persisted.com', icons: [] },
                    },
                    namespaces: { eip155: { accounts: [`eip155:8453:${TEST_ADDRESS}`] } },
                    expiry: Math.floor(Date.now() / 1000) + 86400,
                },
            });

            await WalletConnectService.initialize();
            const sessions = WalletConnectService.getSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0].topic).toBe('persisted_topic');
            expect(sessions[0].peerMeta.name).toBe('Persisted dApp');
        });

        it('handler errors are caught and do not crash the service', () => {
            const badHandler = vi.fn(() => { throw new Error('Handler exploded'); });
            const goodHandler = vi.fn();

            WalletConnectService.on('session_proposal', badHandler);
            WalletConnectService.on('session_proposal', goodHandler);

            capturedHandlers.sessionProposal?.(makeSessionProposal(703));
            expect(badHandler).toHaveBeenCalled();
            expect(goodHandler).toHaveBeenCalled();
        });

        it('rejected pairing does not leave stale state', async () => {
            mockCorePairingPair.mockRejectedValueOnce(new Error('No matching key'));
            await WalletConnectService.pair('wc:badpairing@2').catch(() => {});
            expect(WalletConnectService.isInitialized()).toBe(true);
            expect(WalletConnectService.getSessions()).toHaveLength(0);
        });
    });

    // =========================================================================
    // 8. Network interruption recovery
    // =========================================================================
    describe('8. Network interruption recovery', () => {
        const SESSION_TOPIC = 'topic_resilient';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignMessage.mockClear();
            mockSendTransaction.mockClear();
        });

        it('session state is maintained in local map regardless of transport state', () => {
            const sessions = WalletConnectService.getSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0].topic).toBe(SESSION_TOPIC);
        });

        it('getSessions returns stored sessions after simulated reconnection', () => {
            expect(WalletConnectService.getSessions()).toHaveLength(1);
            expect(WalletConnectService.getSessions()[0].peerMeta.name).toBe('Test dApp');
        });

        it('new requests can be processed after re-establishing connection', async () => {
            const hexMsg = '0x' + Buffer.from('post-reconnect').toString('hex');
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(801, SESSION_TOPIC, 'personal_sign', [hexMsg, TEST_ADDRESS])
            );
            const result = await WalletConnectService.approveRequest(801);
            expect(result).toBe('0xmocksignature_personal');
            expect(mockSignMessage).toHaveBeenCalled();
        });

        it('disconnectSession handles already-disconnected error gracefully', async () => {
            mockDisconnectSession.mockRejectedValueOnce(
                new Error('No matching key. session topic: topic_resilient')
            );
            await WalletConnectService.disconnectSession(SESSION_TOPIC);
            expect(WalletConnectService.getSessions()).toHaveLength(0);
        });

        it('multiple pending requests can accumulate and be processed independently', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(810, SESSION_TOPIC, 'personal_sign', ['msg1', TEST_ADDRESS])
            );
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(811, SESSION_TOPIC, 'personal_sign', ['msg2', TEST_ADDRESS])
            );
            expect(WalletConnectService.getPendingRequests()).toHaveLength(2);

            await WalletConnectService.approveRequest(810);
            expect(WalletConnectService.getPendingRequests()).toHaveLength(1);

            await WalletConnectService.rejectRequest(811);
            expect(WalletConnectService.getPendingRequests()).toHaveLength(0);
        });

        it('transaction gas parameters (EIP-1559) are forwarded correctly', async () => {
            const txParams = {
                from: TEST_ADDRESS, to: '0xRecipient', value: '0x0', data: '0xdeadbeef',
                gas: '0x7530', maxFeePerGas: '0x3B9ACA00', maxPriorityFeePerGas: '0x77359400',
            };
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(812, SESSION_TOPIC, 'eth_sendTransaction', [txParams])
            );
            await WalletConnectService.approveRequest(812);
            expect(mockSendTransaction).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: '0xRecipient',
                    data: '0xdeadbeef',
                    chainId: 8453,
                    gasLimit: BigInt('0x7530'),
                    maxFeePerGas: BigInt('0x3B9ACA00'),
                    maxPriorityFeePerGas: BigInt('0x77359400'),
                })
            );
        });

        it('transaction with legacy gasPrice is forwarded', async () => {
            const txParams = {
                from: TEST_ADDRESS, to: '0xRecipient', value: '0x0', data: '0x',
                gasLimit: '0x5208', gasPrice: '0x4A817C800',
            };
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(813, SESSION_TOPIC, 'eth_sendTransaction', [txParams])
            );
            await WalletConnectService.approveRequest(813);
            expect(mockSendTransaction).toHaveBeenCalledWith(
                expect.objectContaining({
                    gasLimit: BigInt('0x5208'),
                    gasPrice: BigInt('0x4A817C800'),
                })
            );
        });

        it('session_request event emits to registered handlers', () => {
            const handler = vi.fn();
            WalletConnectService.on('session_request', handler);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(814, SESSION_TOPIC, 'personal_sign', ['msg', TEST_ADDRESS])
            );
            expect(handler).toHaveBeenCalledTimes(1);
            const emitted = handler.mock.calls[0][0] as WCRequest;
            expect(emitted.id).toBe(814);
            expect(emitted.method).toBe('personal_sign');
        });
    });

    // =========================================================================
    // 9. Crypto governance enforcement (CLAUDE.md pitfall #13)
    // =========================================================================
    describe('9. Crypto governance enforcement', () => {
        const SESSION_TOPIC = 'topic_gov';

        // EIP-2612 permit on an UNKNOWN token contract — decodeTypedData treats
        // it as a (non-revoke) spend-authority permit WITHOUT calling ethers
        // formatUnits (which the partial ethers mock lacks), so the service
        // routes it to the governed permit path.
        const permitTypedData = JSON.stringify({
            primaryType: 'Permit',
            domain: { chainId: 8453, verifyingContract: GOV_UNKNOWN_TOKEN, name: 'X' },
            types: {
                Permit: [
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            message: { owner: TEST_ADDRESS, spender: GOV_SPENDER, value: '1000', nonce: '0', deadline: '99999999' },
        });

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSendTransaction.mockClear();
            mockSignTypedData.mockClear();
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
        });

        it('eth_sendTransaction: governance block → throws, records deny PE, no broadcast', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval',
                reasons: ['Unlimited approvals are blocked by your WalletConnect security policy.'],
                denyReason: 'Unlimited approvals are blocked by your WalletConnect security policy.',
            } as never);

            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(901, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(901)).rejects.toThrow(/blocked/i);
            expect(mockSendTransaction).not.toHaveBeenCalled();
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ policyDecision: 'block', authorizationDecision: 'deny', authorizationStage: 'execution' }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('eth_sendTransaction: allowed → records execution-stage PE with the governance risk + broadcasts', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({
                lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
                riskScore: 70, riskCategory: 'high', category: 'token_approval', reasons: ['Token approval requires explicit approval'],
            } as never);

            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(903, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            const result = await WalletConnectService.approveRequest(903, undefined, confirmedFor(903));
            expect(result).toBe('0xtxhash123');
            expect(mockSendTransaction).toHaveBeenCalled();
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'send', policyDecision: 'allow', authorizationStage: 'execution',
                    riskCategory: 'high', riskScore: 70,
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('evaluateRequestGovernance pre-check surfaces the verdict for the modal', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({
                lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
                riskScore: 70, riskCategory: 'high', category: 'token_approval', reasons: [],
            } as never);
            const request: WCRequest = {
                id: 904, topic: SESSION_TOPIC, method: 'eth_sendTransaction',
                params: [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }],
                chainId: 'eip155:8453', peerMeta: { name: 'X', url: 'https://x.com', icons: [] },
            };
            const verdict = await WalletConnectService.evaluateRequestGovernance(request);
            expect(verdict?.lane).toBe('hard_confirm');
            expect(verdict?.requiresStrongConfirm).toBe(true);
        });

        it('eth_sendTransaction: records an execution-failure PE if broadcast throws, then re-throws', async () => {
            mockSendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(908, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(908)).rejects.toThrow('insufficient funds');
            // The allow PE (decision) AND the execution-failure PE (outcome) are both recorded.
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({
                    policyDecision: 'allow',
                    authorizationStage: 'execution',
                    authorizationReasonCodes: expect.arrayContaining(['execution_failed']),
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('pre-check fails CLOSED (block) when governance evaluation errors (#7 Unknown=Block)', async () => {
            mockEvaluateWalletConnectTransaction.mockRejectedValueOnce(new Error('governance boom'));
            const request: WCRequest = {
                id: 907, topic: SESSION_TOPIC, method: 'eth_sendTransaction',
                params: [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }],
                chainId: 'eip155:8453', peerMeta: { name: 'X', url: 'https://x.com', icons: [] },
            };
            const verdict = await WalletConnectService.evaluateRequestGovernance(request);
            expect(verdict?.lane).toBe('block');
            expect(verdict?.allowed).toBe(false);
        });

        it('permit signing routes through governance — block denies the signature', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval', reasons: ['blocked'], denyReason: 'This signature is blocked',
            } as never);

            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(905, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, permitTypedData])
            );
            await expect(WalletConnectService.approveRequest(905)).rejects.toThrow(/blocked/i);
            expect(mockEvaluateWalletConnectPermit).toHaveBeenCalled();
            expect(mockSignTypedData).not.toHaveBeenCalled();
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ policyDecision: 'block', authorizationDecision: 'deny' }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('permit signing routes through governance — allowed permit signs and records an allow PE', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
                riskScore: 70, riskCategory: 'high', category: 'token_approval', reasons: [],
            } as never);

            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(906, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, permitTypedData])
            );
            const result = await WalletConnectService.approveRequest(906, undefined, confirmedFor(906));
            expect(result).toBe('0xmocksignature_typed');
            expect(mockSignTypedData).toHaveBeenCalled();
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'approve', policyDecision: 'allow', authorizationStage: 'execution' }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });
    });

    // =========================================================================
    // 9b. [F16] EIP-3009 routes to the GOVERNED path; unrecognized typed data
    //     fails CLOSED — never the biometric-only plain path.
    //
    // The F16 defect: an EIP-3009 `TransferWithAuthorization` (a signature that
    // moves the owner\'s tokens — the exact shape this repo\'s x402 signer produces)
    // fell through to handlePlainTypedDataSign, which signs with biometric ONLY,
    // skipping the kill switch + spend governance. handlePlainTypedDataSign never
    // calls evaluateWalletConnectPermit, so "the permit evaluator ran" is the
    // observable proof that an EIP-3009 payload did NOT reach the plain path.
    // =========================================================================
    describe('9b. EIP-3009 + unrecognized typed data route fail-closed [F16]', () => {
        const SESSION_TOPIC = 'topic_f16';

        // EIP-3009 on an UNKNOWN token (unknown avoids the formatUnits the partial
        // ethers mock lacks — same reason section 9 uses GOV_UNKNOWN_TOKEN). Decodes
        // to kind 'eip3009_transfer', isTransfer, NOT a revoke → governed permit path.
        const eip3009TypedData = JSON.stringify({
            primaryType: 'TransferWithAuthorization',
            domain: { chainId: 8453, verifyingContract: GOV_UNKNOWN_TOKEN, name: 'USD Coin', version: '2' },
            types: {
                TransferWithAuthorization: [
                    { name: 'from', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' },
                ],
            },
            message: { from: TEST_ADDRESS, to: GOV_SPENDER, value: '1000000', validAfter: '0', validBefore: '1900000000', nonce: '0x' + '11'.repeat(32) },
        });

        // A structurally UNRECOGNIZED EIP-712 struct: not a decodable permit, not an
        // allowlisted non-spend shape. Must fail closed to handleUnknownTypedDataSign.
        const unknownTypedData = JSON.stringify({
            primaryType: 'Order',
            domain: { chainId: 8453, verifyingContract: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca', name: 'Seaport' },
            types: { Order: [{ name: 'offerer', type: 'address' }, { name: 'amount', type: 'uint256' }] },
            message: { offerer: TEST_ADDRESS, amount: '1000000' },
        });

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignTypedData.mockClear();
            mockEvaluateWalletConnectPermit.mockClear();
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
        });

        it('an EIP-3009 payload reaches the GOVERNED permit evaluator — a block denies the signature', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_transfer',
                reasons: ['blocked'], denyReason: 'This transfer authorization is blocked',
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(920, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, eip3009TypedData])
            );
            await expect(WalletConnectService.approveRequest(920)).rejects.toThrow(/blocked/i);
            // The governed permit path ran (the plain path NEVER calls this) …
            expect(mockEvaluateWalletConnectPermit).toHaveBeenCalled();
            // … and no signature was produced.
            expect(mockSignTypedData).not.toHaveBeenCalled();
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ policyDecision: 'block', authorizationDecision: 'deny' }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        it('unrecognized typed data fails CLOSED: sealed high/80 + fail-closed reason codes, NOT the plain path\'s 15/low', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(922, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, unknownTypedData])
            );
            const sig = await WalletConnectService.approveRequest(922, undefined, confirmedFor(922));
            expect(sig).toBe('0xmocksignature_typed');
            // Not a permit → the permit evaluator is not consulted …
            expect(mockEvaluateWalletConnectPermit).not.toHaveBeenCalled();
            // … but it is recorded HONESTLY as unverifiable high-risk (the fail-closed
            // handleUnknownTypedDataSign PE), never the old plain-path 15/low/allow.
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({
                    riskScore: 80,
                    riskCategory: 'high',
                    authorizationReasonCodes: expect.arrayContaining(['unverified_typed_data', 'could_not_classify_signature']),
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
        });

        // RED control: a genuine REVOKE (DAI allowed=false) is the ONE non-spend
        // typed-data that legitimately stays on the biometric-only plain path — so
        // the permit evaluator must NOT run for it. This proves the governed-path
        // assertions above actually discriminate (they are not green for every input).
        it('RED — a protective revoke stays biometric-only (permit evaluator NOT consulted)', async () => {
            const daiRevoke = JSON.stringify({
                primaryType: 'Permit',
                domain: { chainId: 8453, verifyingContract: GOV_UNKNOWN_TOKEN, name: 'Dai Stablecoin', version: '1' },
                types: {
                    Permit: [
                        { name: 'holder', type: 'address' },
                        { name: 'spender', type: 'address' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'expiry', type: 'uint256' },
                        { name: 'allowed', type: 'bool' },
                    ],
                },
                message: { holder: TEST_ADDRESS, spender: GOV_SPENDER, nonce: '0', expiry: '1900000000', allowed: false },
            });
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(924, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, daiRevoke])
            );
            const sig = await WalletConnectService.approveRequest(924);
            expect(sig).toBe('0xmocksignature_typed');
            expect(mockEvaluateWalletConnectPermit).not.toHaveBeenCalled();
            expect(mockSignTypedData).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 10. Execution-time denial reaches the dApp (Pass-2 #30)
    //
    // A denied / kill-switched / failed sign must send a JSON-RPC error to the
    // dApp (so it is not orphaned until its own timeout) AND drop the pending
    // entry, then re-throw so the screen can surface the reason.
    // =========================================================================
    describe('10. Execution-time denial reaches the dApp (#30)', () => {
        const SESSION_TOPIC = 'topic_30';

        const permit30 = JSON.stringify({
            primaryType: 'Permit',
            domain: { chainId: 8453, verifyingContract: GOV_UNKNOWN_TOKEN, name: 'X' },
            types: {
                Permit: [
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            message: { owner: TEST_ADDRESS, spender: GOV_SPENDER, value: '1000', nonce: '0', deadline: '99999999' },
        });

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSendTransaction.mockClear();
            mockSignTypedData.mockClear();
            mockRespondSessionRequest.mockClear();
        });

        it('governance block at execution → JSON-RPC 4001 to the dApp + clears pending', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval',
                reasons: ['blocked'], denyReason: 'Blocked by your WalletConnect security policy.',
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1002, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(1002)).rejects.toThrow(/blocked/i);
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 1002, jsonrpc: '2.0', error: expect.objectContaining({ code: 4001 }) },
            });
            expect(WalletConnectService.getPendingRequest(1002)).toBeUndefined();
        });

        it('broadcast failure → JSON-RPC -32000 to the dApp + clears pending, then re-throws', async () => {
            mockSendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1003, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(1003)).rejects.toThrow('insufficient funds');
            // An internal failure (not a policy deny) maps to the JSON-RPC server-error code.
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 1003, jsonrpc: '2.0', error: expect.objectContaining({ code: -32000, message: 'insufficient funds' }) },
            });
            expect(WalletConnectService.getPendingRequest(1003)).toBeUndefined();
        });

        it('permit governance block at execution → JSON-RPC 4001 to the dApp + clears pending, no signature', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval',
                reasons: ['blocked'], denyReason: 'This signature is blocked', amountUsd: 0,
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1004, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, permit30])
            );
            await expect(WalletConnectService.approveRequest(1004)).rejects.toThrow(/blocked/i);
            expect(mockSignTypedData).not.toHaveBeenCalled();
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 1004, jsonrpc: '2.0', error: expect.objectContaining({ code: 4001 }) },
            });
            expect(WalletConnectService.getPendingRequest(1004)).toBeUndefined();
        });
    });

    // =========================================================================
    // 11. Gasless permit spend is recorded into the daily cap (Pass-2 #29)
    // =========================================================================
    describe('11. Permit spend records into the daily accumulator (#29)', () => {
        const SESSION_TOPIC = 'topic_29';

        const permit29 = JSON.stringify({
            primaryType: 'Permit',
            domain: { chainId: 8453, verifyingContract: GOV_UNKNOWN_TOKEN, name: 'X' },
            types: {
                Permit: [
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            message: { owner: TEST_ADDRESS, spender: GOV_SPENDER, value: '1000', nonce: '0', deadline: '99999999' },
        });

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignTypedData.mockClear();
            mockRecordDailyCryptoSpendUsd.mockClear();
        });

        it('a signed permit records its authorized USD, deduped by the deterministic signature', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'hard_confirm', allowed: true, requiresStrongConfirm: true,
                riskScore: 70, riskCategory: 'high', category: 'token_approval', reasons: [], amountUsd: 40,
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1101, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, permit29])
            );
            const sig = await WalletConnectService.approveRequest(1101, undefined, confirmedFor(1101));
            expect(sig).toBe('0xmocksignature_typed');
            // The daily on-chain cap now binds on gasless spend authority too.
            expect(mockRecordDailyCryptoSpendUsd).toHaveBeenCalledWith('wallet-owner', '0xmocksignature_typed', 40);
        });

        it('a BLOCKED permit records nothing (no spend authority was granted)', async () => {
            mockEvaluateWalletConnectPermit.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval',
                reasons: ['blocked'], denyReason: 'blocked', amountUsd: 40,
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1102, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, permit29])
            );
            await expect(WalletConnectService.approveRequest(1102)).rejects.toThrow(/blocked/i);
            expect(mockRecordDailyCryptoSpendUsd).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 12. Exactly one respondSessionRequest per request — error XOR result (#30)
    //     The #30 fix is correct only BY CONSTRUCTION: approveRequest's catch
    //     re-throws (so the success-path respond is unreachable once an error
    //     fired) and the inner handlers never respond themselves. These guards
    //     PIN that invariant directly, so a future refactor that drops the
    //     re-throw or moves/duplicates the success respond cannot silently
    //     double-respond to the dApp (an error AND a result for the same JSON-RPC
    //     id) or send the wrong one. The §10/§11 tests assert WHICH response is
    //     sent; these assert that EXACTLY ONE is.
    // =========================================================================
    describe('12. Exactly one respondSessionRequest per request — error XOR result (#30)', () => {
        const SESSION_TOPIC = 'topic_xor';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSendTransaction.mockClear();
            mockRespondSessionRequest.mockClear();
        });

        it('execution-time deny → EXACTLY ONE response, the error (never also a result)', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({
                lane: 'block', allowed: false, requiresStrongConfirm: false,
                riskScore: 95, riskCategory: 'high', category: 'token_approval',
                reasons: ['blocked'], denyReason: 'Blocked by your WalletConnect security policy.',
            } as never);
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1201, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(1201)).rejects.toThrow(/blocked/i);
            // One response total — not zero (orphaned dApp) and not two (error + result).
            expect(mockRespondSessionRequest).toHaveBeenCalledTimes(1);
            const sent = mockRespondSessionRequest.mock.calls[0][0] as { response: Record<string, unknown> };
            expect(sent.response).toHaveProperty('error');
            expect(sent.response).not.toHaveProperty('result');
        });

        it('successful approve → EXACTLY ONE response, the result (never also an error)', async () => {
            // Defaults: ALLOW_TX_VERDICT (auto_approve), kill switch off, sendTransaction → 0xtxhash123.
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1202, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            const hash = await WalletConnectService.approveRequest(1202);
            expect(hash).toBe('0xtxhash123');
            expect(mockRespondSessionRequest).toHaveBeenCalledTimes(1);
            const sent = mockRespondSessionRequest.mock.calls[0][0] as { response: Record<string, unknown> };
            expect(sent.response).toMatchObject({ id: 1202, result: '0xtxhash123' });
            expect(sent.response).not.toHaveProperty('error');
        });
    });

    // =========================================================================
    // 13. #7 receipt-revert must not report success; #35 biometric-cancel → 4001
    // =========================================================================
    describe('13. Receipt-revert (#7) + biometric-cancel mapping (#35)', () => {
        const SESSION_TOPIC = 'topic_13';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSendTransaction.mockClear();
            mockRespondSessionRequest.mockClear();
            mockRecordDailyCryptoSpendUsd.mockClear();
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
        });

        it('eth_sendTransaction: mined-but-REVERTED (status 0) → throws, failure PE, no daily-cap credit, dApp -32000 (#7)', async () => {
            // Broadcast resolves (mempool accepted) but the receipt reverts.
            mockSendTransaction.mockResolvedValueOnce({
                hash: '0xreverted',
                wait: vi.fn().mockResolvedValue({ status: 0, hash: '0xreverted' }),
            });
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1301, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(1301)).rejects.toThrow(/reverted/i);

            // The execution-failure PE (outcome) is sealed; the daily on-chain cap
            // is NOT credited for a tx that moved zero value.
            expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(
                expect.objectContaining({ authorizationReasonCodes: expect.arrayContaining(['execution_failed']) }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value))
            );
            expect(mockRecordDailyCryptoSpendUsd).not.toHaveBeenCalled();
            // A revert is an execution fault, not a user rejection → -32000.
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 1301, jsonrpc: '2.0', error: expect.objectContaining({ code: -32000 }) },
            });
            expect(WalletConnectService.getPendingRequest(1301)).toBeUndefined();
        });

        it('eth_sendTransaction: CONFIRMED (status 1) → returns hash AND credits the daily cap (regression guard)', async () => {
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1302, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            const hash = await WalletConnectService.approveRequest(1302);
            expect(hash).toBe('0xtxhash123');
            // Credited AFTER the receipt confirms (not on bare broadcast).
            expect(mockRecordDailyCryptoSpendUsd).toHaveBeenCalledWith('wallet-owner', '0xtxhash123', undefined);
        });

        it('eth_sendTransaction: biometric CANCEL → JSON-RPC 4001 (user rejected), never broadcast (#35)', async () => {
            const { BiometricAuthError } = await import('../../security/requireBiometric');
            const { requireBiometric } = await import('../../security/requireBiometric');
            vi.mocked(requireBiometric).mockRejectedValueOnce(
                new BiometricAuthError('user_cancel')
            );
            capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(1303, SESSION_TOPIC, 'eth_sendTransaction', [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }])
            );
            await expect(WalletConnectService.approveRequest(1303)).rejects.toBeInstanceOf(BiometricAuthError);
            // Biometric gates BEFORE broadcast.
            expect(mockSendTransaction).not.toHaveBeenCalled();
            // A cancel is a deliberate decline → 4001, not the -32000 server error.
            expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                topic: SESSION_TOPIC,
                response: { id: 1303, jsonrpc: '2.0', error: expect.objectContaining({ code: 4001 }) },
            });
            expect(WalletConnectService.getPendingRequest(1303)).toBeUndefined();
        });
    });

    // =========================================================================
    // 14. no dApp can obtain a signature over a Provian relay-auth or
    // recovery message. RED control: on the pre-guard service every reserved
    // vector below was stored, surfaced and SIGNED (personal_sign after
    // biometric; unknown typed data after hard_confirm).
    // =========================================================================
    describe('14. Provian-reserved messages are never signed ', () => {
        const SESSION_TOPIC = 'topic_reserved';

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignMessage.mockClear();
            mockSignTypedData.mockClear();
            mockRespondSessionRequest.mockClear();
            mockEvaluateWalletConnectPermit.mockClear();
            vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
        });

        it('has a non-empty reserved population', () => {
            expect(RESERVED_VECTORS.length).toBeGreaterThanOrEqual(25);
        });

        RESERVED_VECTORS.forEach((vector, index) => {
            const id = 14000 + index;

            it(`door: ${vector.name} → rejected 4001, never surfaced, deny PE`, async () => {
                const surfaced = vi.fn();
                const off = WalletConnectService.on('session_request', surfaced);
                await capturedHandlers.sessionRequest?.(
                    makeSessionRequestEvent(id, SESSION_TOPIC, vector.method, vector.params)
                );
                off();

                expect(surfaced).not.toHaveBeenCalled();
                expect(WalletConnectService.getPendingRequest(id)).toBeUndefined();
                expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                    topic: SESSION_TOPIC,
                    response: { id, jsonrpc: '2.0', error: { code: 4001, message: PROVIAN_RESERVED_USER_MESSAGE } },
                });
                expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(expect.objectContaining({
                    policyDecision: 'block',
                    authorizationDecision: 'deny',
                    intentText: expect.stringContaining('provian_reserved_message:'),
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
                await expect(WalletConnectService.approveRequest(id)).rejects.toThrow('Request not found');
                expect(mockSignMessage).not.toHaveBeenCalled();
                expect(mockSignTypedData).not.toHaveBeenCalled();
            });

            it(`backstop: ${vector.name} → handleSignRequest refuses even if it got past the door`, async () => {
                // Simulate a request that reached the pending map by any other path.
                /* eslint-disable @typescript-eslint/no-explicit-any */
                (WalletConnectService as any).pendingRequests.set(id, {
                    id, topic: SESSION_TOPIC, method: vector.method, params: vector.params, chainId: 'eip155:8453',
                    peerMeta: { name: 'Test dApp', url: 'https://test-dapp.com', icons: [] },
                });
                /* eslint-enable */
                await expect(WalletConnectService.approveRequest(id)).rejects.toBeInstanceOf(ProvianReservedMessageError);
                expect(mockSignMessage).not.toHaveBeenCalled();
                expect(mockSignTypedData).not.toHaveBeenCalled();
                expect(mockEvaluateWalletConnectPermit).not.toHaveBeenCalled();
                // The dApp hears a user-rejection (4001), not a wallet fault.
                expect(mockRespondSessionRequest).toHaveBeenCalledWith({
                    topic: SESSION_TOPIC,
                    response: { id, jsonrpc: '2.0', error: { code: 4001, message: PROVIAN_RESERVED_USER_MESSAGE } },
                });
                expect(ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledWith(expect.objectContaining({
                    policyDecision: 'block',
                    intentText: expect.stringContaining('provian_reserved_message:'),
                }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
            });
        });

        ALLOWED_VECTORS.forEach((vector, index) => {
            const id = 14500 + index;
            it(`positive control: ${vector.name} → reaches the normal path`, async () => {
                const surfaced = vi.fn();
                const off = WalletConnectService.on('session_request', surfaced);
                await capturedHandlers.sessionRequest?.(
                    makeSessionRequestEvent(id, SESSION_TOPIC, vector.method, vector.params)
                );
                off();
                expect(surfaced).toHaveBeenCalledTimes(1);
                expect(WalletConnectService.getPendingRequest(id)).toBeDefined();
            });
        });

        it('positive control: an ordinary SIWE message still signs', async () => {
            const siwe = ALLOWED_VECTORS.find((v) => v.name === 'SIWE (EIP-4361) login');
            expect(siwe).toBeDefined();
            await capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(14600, SESSION_TOPIC, siwe!.method, siwe!.params)
            );
            await expect(WalletConnectService.approveRequest(14600)).resolves.toBe('0xmocksignature_personal');
            expect(mockSignMessage).toHaveBeenCalledWith(siwe!.params[0]);
        });

        it('positive control: a Uniswap Permit2 signature still flows to the governed permit path and signs', async () => {
            const permit2 = ALLOWED_VECTORS.find((v) => v.name === 'Uniswap Permit2 PermitSingle');
            expect(permit2).toBeDefined();
            // Same Permit2 request on an UNKNOWN token, so decodeTypedData never calls
            // ethers.formatUnits (the partial ethers mock lacks it — see §9).
            const typed = JSON.parse(permit2!.params[1] as string) as { message: { details: { token: string } } };
            typed.message.details.token = GOV_UNKNOWN_TOKEN;
            await capturedHandlers.sessionRequest?.(
                makeSessionRequestEvent(14601, SESSION_TOPIC, permit2!.method, [permit2!.params[0], JSON.stringify(typed)])
            );
            await expect(WalletConnectService.approveRequest(14601, undefined, confirmedFor(14601))).resolves.toBe('0xmocksignature_typed');
            expect(mockEvaluateWalletConnectPermit).toHaveBeenCalledTimes(1);
            expect(mockSignTypedData).toHaveBeenCalledTimes(1);
        });
    });
    describe('15. [H3] the strong confirmation is enforced by the service, for the exact request', () => {
        const SESSION_TOPIC = 'topic_strong_confirm';
        const seaport = JSON.stringify({
            primaryType: 'Order',
            domain: { chainId: 8453, verifyingContract: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca', name: 'Seaport' },
            types: { Order: [{ name: 'offerer', type: 'address' }, { name: 'amount', type: 'uint256' }] },
            message: { offerer: TEST_ADDRESS, amount: '1000000' },
        });
        const harmlessTx = [{ from: TEST_ADDRESS, to: '0xR', value: '0x0', data: '0x' }];

        beforeEach(async () => {
            await initWithSession(SESSION_TOPIC);
            mockSignTypedData.mockClear();
            mockSendTransaction.mockClear();
        });

        it('the race: a slow low-risk verdict for an earlier request lands last; a plain tap on the high-risk request is refused, nothing is signed', async () => {
            // Request A (harmless send) evaluates SLOWLY to a low-risk verdict …
            let releaseA: (v: unknown) => void = () => {};
            mockEvaluateWalletConnectTransaction.mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve; }));
            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1501, SESSION_TOPIC, 'eth_sendTransaction', harmlessTx));
            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1502, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, seaport]));
            const reqA = WalletConnectService.getPendingRequest(1501)!;
            const reqB = WalletConnectService.getPendingRequest(1502)!;
            const slowA = WalletConnectService.evaluateRequestGovernance(reqA);
            // … while request B (unverifiable typed data) evaluates fast to hard_confirm.
            const verdictB = await WalletConnectService.evaluateRequestGovernance(reqB);
            expect(verdictB?.requiresStrongConfirm).toBe(true);
            releaseA(ALLOW_TX_VERDICT);
            const verdictA = await slowA;
            expect(verdictA?.requiresStrongConfirm).toBe(false);

            // The modal showed B with A's verdict; the owner taps Approve with no phrase.
            await expect(WalletConnectService.approveRequest(1502)).rejects.toThrow(/I UNDERSTAND/);
            expect(mockSignTypedData).not.toHaveBeenCalled();
            // The dApp is told the wallet declined (4001), and the request is resolved.
            expect(mockRespondSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                response: expect.objectContaining({ id: 1502, error: expect.objectContaining({ code: 4001 }) }),
            }));
            expect(WalletConnectService.getPendingRequest(1502)).toBeUndefined();
        });

        it('a confirmation typed for another request, or before the cooling-off, never satisfies this one', async () => {
            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1503, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, seaport]));
            const req = WalletConnectService.getPendingRequest(1503)!;
            await WalletConnectService.evaluateRequestGovernance(req);
            // Typed for request 1599 → refused.
            await expect(WalletConnectService.approveRequest(1503, undefined, { requestId: 1599, phrase: 'I UNDERSTAND' }))
                .rejects.toThrow(/I UNDERSTAND/);

            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1504, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, seaport]));
            await WalletConnectService.evaluateRequestGovernance(WalletConnectService.getPendingRequest(1504)!);
            // Right request and phrase, but the cooling-off has not elapsed → refused.
            await expect(WalletConnectService.approveRequest(1504, undefined, { requestId: 1504, phrase: 'I UNDERSTAND' }))
                .rejects.toThrow(/I UNDERSTAND/);

            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1505, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, seaport]));
            // Never shown a strong verdict by the service (no pre-evaluation) → refused.
            await expect(WalletConnectService.approveRequest(1505, undefined, { requestId: 1505, phrase: 'I UNDERSTAND' }))
                .rejects.toThrow(/I UNDERSTAND/);
            expect(mockSignTypedData).not.toHaveBeenCalled();
        });

        it('RED control: the confirmed request signs once its own cooling-off has elapsed', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            try {
                await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1506, SESSION_TOPIC, 'eth_signTypedData_v4', [TEST_ADDRESS, seaport]));
                await WalletConnectService.evaluateRequestGovernance(WalletConnectService.getPendingRequest(1506)!);
                vi.setSystemTime(Date.now() + 5_000);
                await expect(WalletConnectService.approveRequest(1506, undefined, { requestId: 1506, phrase: ' i understand ' }))
                    .resolves.toBe('0xmocksignature_typed');
                expect(mockSignTypedData).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it('a low-risk request still approves on a plain tap (the gate binds only strong verdicts)', async () => {
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce(ALLOW_TX_VERDICT as never);
            await capturedHandlers.sessionRequest?.(makeSessionRequestEvent(1507, SESSION_TOPIC, 'eth_sendTransaction', harmlessTx));
            await expect(WalletConnectService.approveRequest(1507)).resolves.toBe('0xtxhash123');
        });
    });
    describe('saved connected-app transaction recovery', () => {
        const saved = { operationId: 'wc_saved_1', chainId: 8453, hash: `0x${'12'.repeat(32)}`,
            to: GOV_SPENDER, value: '1', data: '0x', nonce: 7, gasLimit: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1', maxFeeWei: '42000' };
        function queue(): number {
            WalletConnectService.queueTransactionRecovery(saved);
            return WalletConnectService.getPendingRequests()[0].id;
        }
        it('re-evaluates policy and refuses a denied recovery before signing', async () => {
            const id = queue();
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({ ...ALLOW_TX_VERDICT, allowed: false, lane: 'block', denyReason: 'recovery denied' } as never);
            await expect(WalletConnectService.approveRequest(id)).rejects.toThrow('recovery denied');
            expect(mockSendTransaction).not.toHaveBeenCalled();
            expect(mockRespondSessionRequest).not.toHaveBeenCalled();
            expect(WalletConnectService.getPendingRequests()).toHaveLength(0);
        });
        it('requires the same strong confirmation for a risky recovery', async () => {
            const id = queue();
            mockEvaluateWalletConnectTransaction.mockResolvedValueOnce({ ...ALLOW_TX_VERDICT, requiresStrongConfirm: true, lane: 'hard_confirm' } as never);
            await expect(WalletConnectService.approveRequest(id)).rejects.toThrow();
            expect(mockSendTransaction).not.toHaveBeenCalled();
            expect(mockRespondSessionRequest).not.toHaveBeenCalled();
        });
        it('cancelled fresh biometric approval leaves the saved transaction unwired', async () => {
            const id = queue();
            const { requireBiometric, BiometricAuthError } = await import('../../security/requireBiometric');
            vi.mocked(requireBiometric).mockRejectedValueOnce(new BiometricAuthError('user_cancel'));
            await expect(WalletConnectService.approveRequest(id)).rejects.toThrow('user_cancel');
            expect(mockSendTransaction).not.toHaveBeenCalled();
            expect(mockRespondSessionRequest).not.toHaveBeenCalled();
        });
        it('approved recovery uses the existing review pipeline without replying to a remote session', async () => {
            const id = queue();
            await expect(WalletConnectService.approveRequest(id)).resolves.toBe('0xtxhash123');
            expect(mockEvaluateWalletConnectTransaction).toHaveBeenCalledTimes(1);
            expect(mockSendTransaction).toHaveBeenCalledTimes(1);
            expect(mockRespondSessionRequest).not.toHaveBeenCalled();
            expect(WalletConnectService.getPendingRequests()).toHaveLength(0);
        });
    });

});
