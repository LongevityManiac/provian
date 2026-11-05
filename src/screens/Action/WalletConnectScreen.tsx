import { errorDisplayCopy } from '../../i18n/displayCopy';
import i18next from 'i18next';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Alert,
    Modal,
    ScrollView,
    ActivityIndicator,
    Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import WalletConnectService, {
    WCSession,
    WCRequest,
    WCTransactionDetails,
} from '../../core/walletconnect/WalletConnectService';
import { decodeTypedData } from '../../core/walletconnect/decodeTypedData';
import type { DecodedCall } from '../../core/walletconnect/decodeCalldata';
import { makeFailClosedVerdict, type WalletConnectVerdict } from '../../core/walletconnect/WalletConnectGovernance';
import { STRONG_CONFIRM_COOLING_SECONDS, STRONG_CONFIRM_PHRASE } from '../../core/walletconnect/strongConfirmation';
import { useWalletStore } from '../../store/walletStore';
import { ethers } from 'ethers';
import { CameraView, useCameraPermissions } from 'expo-camera';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ScreenState = 'idle' | 'connecting' | 'proposal' | 'error';

// Cooling-off window (seconds) required by a hard_confirm governance verdict,
// in addition to the typed "I UNDERSTAND" confirmation and biometric. "Slow is
// smooth, smooth is safe" — friction proportional to risk.
const COOLING_SECONDS = STRONG_CONFIRM_COOLING_SECONDS;
const UNDERSTAND_PHRASE = STRONG_CONFIRM_PHRASE;

interface ProposalInfo {
    id: number;
    name: string;
    description?: string;
    url: string;
    icons: string[];
    chains: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

const WalletConnectScreen = ({ navigation }: { navigation: { goBack: () => void } }) => {
    const { t } = useTranslation();
    const [uri, setUri] = useState('');
    const [screenState, setScreenState] = useState<ScreenState>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [proposal, setProposal] = useState<ProposalInfo | null>(null);
    const [sessions, setSessions] = useState<WCSession[]>([]);
    const [pendingRequest, setPendingRequest] = useState<WCRequest | null>(null);
    const [txDetails, setTxDetails] = useState<WCTransactionDetails | null>(null);
    const [verdict, setVerdict] = useState<WalletConnectVerdict | null>(null);
    const [verdictLoading, setVerdictLoading] = useState(false);
    const [understandText, setUnderstandText] = useState('');
    const [coolingRemaining, setCoolingRemaining] = useState(0);
    const [processing, setProcessing] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const [showScanner, setShowScanner] = useState(false);
    const scanLockRef = useRef(false);
    // [H3] The request the modal is showing. A governance verdict is applied only to the request it
    // was computed for, so a slower result for an earlier request can never replace this one's.
    const shownRequestIdRef = useRef<number | null>(null);

    const walletAddress = useWalletStore(s => s.address);

    // ─────────────────────────────────────────────────────────────────────
    // Initialize service and subscribe to events
    // ─────────────────────────────────────────────────────────────────────

    useEffect(() => {
        let unsubProposal: (() => void) | null = null;
        let unsubRequest: (() => void) | null = null;
        let unsubDelete: (() => void) | null = null;

        const setup = async () => {
            try {
                await WalletConnectService.initialize();
                setSessions(WalletConnectService.getSessions());
            } catch (err) {
                console.warn('[WalletConnectScreen] Init warning:', err);
            }

            const presentProposal = (rawProposal: unknown) => {
                const p = rawProposal as { id: number; params: { proposer: { metadata: { name: string; description?: string; url: string; icons: string[] } }; requiredNamespaces?: Record<string, { chains?: string[] }> } };
                setProposal({
                    id: p.id,
                    name: p.params.proposer.metadata.name,
                    description: p.params.proposer.metadata.description,
                    url: p.params.proposer.metadata.url,
                    icons: p.params.proposer.metadata.icons,
                    chains: p.params.requiredNamespaces?.eip155?.chains || ['eip155:1'],
                });
                setScreenState('proposal');
            };
            unsubProposal = WalletConnectService.on('session_proposal', presentProposal);

            const presentRequest = (req: unknown) => {
                const request = req as WCRequest;
                shownRequestIdRef.current = request.id;
                setPendingRequest(request);
                setVerdict(null);
                setVerdictLoading(true);
                setUnderstandText('');
                setCoolingRemaining(0);
                if (request.method === 'eth_sendTransaction') {
                    setTxDetails(WalletConnectService.parseTransactionDetails(request));
                } else {
                    setTxDetails(null);
                }
                // Pre-evaluate through the governance pipeline so the modal renders
                // the right friction control (block / strong-confirm / biometric).
                // Approve stays disabled until this resolves so a fast tap can't
                // skip the strong-confirm gate before the verdict is known.
                const stillShown = () => shownRequestIdRef.current === request.id;
                WalletConnectService.evaluateRequestGovernance(request)
                    .then((v) => { if (stillShown()) setVerdict(v); })
                    // Fail closed: an unexpected pre-check error blocks (never a
                    // silent downgrade to the biometric-only path). #7 Unknown=Block.
                    .catch(() => { if (stillShown()) setVerdict(makeFailClosedVerdict('unknown')); })
                    .finally(() => { if (stillShown()) setVerdictLoading(false); });
            };
            unsubRequest = WalletConnectService.on('session_request', presentRequest);

            unsubDelete = WalletConnectService.on('session_delete', () => {
                setSessions(WalletConnectService.getSessions());
            });

            // A proposal or request that arrived while this screen was not mounted is still
            // queued in the service; until 2026-10-17 it sat there unseen until the dApp sent
            // another. Present the oldest queued request (one at a time), else a queued proposal.
            const queued = WalletConnectService.getPendingRequests();
            if (queued.length > 0) {
                presentRequest(queued[0]);
            } else {
                const queuedProposal = WalletConnectService.getPendingProposal();
                if (queuedProposal) presentProposal(queuedProposal);
            }
        };

        setup();

        return () => {
            unsubProposal?.();
            unsubRequest?.();
            unsubDelete?.();
        };
    }, []);

    // Cooling-off countdown for hard_confirm (strong) governance verdicts.
    useEffect(() => {
        if (!pendingRequest || !verdict?.requiresStrongConfirm) {
            setCoolingRemaining(0);
            return;
        }
        setCoolingRemaining(COOLING_SECONDS);
        const interval = setInterval(() => {
            setCoolingRemaining((s) => {
                if (s <= 1) {
                    clearInterval(interval);
                    return 0;
                }
                return s - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [pendingRequest, verdict?.requiresStrongConfirm]);

    // ─────────────────────────────────────────────────────────────────────
    // Pairing
    // ─────────────────────────────────────────────────────────────────────

    const connectWithUri = useCallback(async (rawUri: string) => {
        const trimmed = rawUri.trim();
        if (!trimmed) {
            Alert.alert(t('walletConnect.noUri'), t('walletConnect.noUriMsg'));
            return;
        }
        if (!trimmed.startsWith('wc:')) {
            Alert.alert(t('walletConnect.invalidUri'), t('walletConnect.invalidUriMsg'));
            return;
        }

        setScreenState('connecting');
        setErrorMessage('');

        try {
            await WalletConnectService.pair(trimmed);
            // The session_proposal event will fire and update the UI
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : t('walletConnect.connectionFailed');
            setErrorMessage(msg);
            setScreenState('error');
        }
    }, [t]);

    const handleConnect = useCallback(() => connectWithUri(uri), [uri, connectWithUri]);

    // ─────────────────────────────────────────────────────────────────────
    // QR scanning (pair by camera instead of paste)
    // ─────────────────────────────────────────────────────────────────────

    const openScanner = useCallback(async () => {
        if (!permission?.granted) {
            const result = await requestPermission();
            if (!result.granted) {
                Alert.alert(t('walletConnect.cameraDeniedTitle'), t('walletConnect.cameraDenied'));
                return;
            }
        }
        scanLockRef.current = false;
        setShowScanner(true);
    }, [permission, requestPermission, t]);

    const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
        // Lock prevents the camera firing the same code dozens of times.
        if (scanLockRef.current) return;
        // Ignore anything that isn't a WalletConnect URI; keep scanning.
        if (!data || !data.startsWith('wc:')) return;
        scanLockRef.current = true;
        setShowScanner(false);
        setUri(data);
        connectWithUri(data);
    }, [connectWithUri]);

    // ─────────────────────────────────────────────────────────────────────
    // Session proposal approve / reject
    // ─────────────────────────────────────────────────────────────────────

    const handleApproveSession = useCallback(async () => {
        if (!proposal) return;
        setProcessing(true);

        try {
            await WalletConnectService.approveSession(proposal.id, walletAddress);
            setSessions(WalletConnectService.getSessions());
            setProposal(null);
            setScreenState('idle');
            setUri('');
            Alert.alert(t('walletConnect.connected'), t('walletConnect.sessionEstablished', { name: proposal.name }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : t('walletConnect.approvalFailed');
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(msg));
        } finally {
            setProcessing(false);
        }
    }, [proposal, walletAddress]);

    const handleRejectSession = useCallback(async () => {
        if (!proposal) return;
        try {
            await WalletConnectService.rejectSession(proposal.id);
        } catch (error) {
            console.warn('[WalletConnectScreen] Reject error:', error);
        }
        setProposal(null);
        setScreenState('idle');
    }, [proposal]);

    // ─────────────────────────────────────────────────────────────────────
    // Request approve / reject
    // ─────────────────────────────────────────────────────────────────────

    const resetRequestState = useCallback(() => {
        shownRequestIdRef.current = null;
        setPendingRequest(null);
        setTxDetails(null);
        setVerdict(null);
        setVerdictLoading(false);
        setUnderstandText('');
        setCoolingRemaining(0);
    }, []);

    const handleApproveRequest = useCallback(async () => {
        if (!pendingRequest) return;
        // Governance gating (defense-in-depth; the modal also disables the button).
        // The service re-checks at execution and enforces biometric regardless.
        if (verdictLoading) return;
        if (verdict?.lane === 'block') return;
        if (verdict?.requiresStrongConfirm) {
            if (understandText.trim().toUpperCase() !== UNDERSTAND_PHRASE || coolingRemaining > 0) return;
        }
        setProcessing(true);

        try {
            // The service re-evaluates this request and enforces the strong confirmation itself; the
            // typed text travels with the id it was typed for.
            const result = await WalletConnectService.approveRequest(pendingRequest.id, undefined, {
                requestId: pendingRequest.id,
                phrase: understandText,
            });
            const method = pendingRequest.method;
            resetRequestState();

            if (method === 'eth_sendTransaction') {
                Alert.alert(t('walletConnect.transactionSent'), t('walletConnect.txHash', { hash: `${result.slice(0, 10)}...${result.slice(-8)}` }));
            }
        } catch (error: unknown) {
            // [Pass-2 #30] The service has already sent a JSON-RPC error to the
            // dApp and dropped the pending request, so this request is fully
            // resolved. Close the modal (a second Approve tap would otherwise hit
            // a now-deleted request and throw "Request not found") and surface the
            // reason to the user.
            const msg = error instanceof Error ? error.message : t('walletConnect.requestFailed');
            resetRequestState();
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(msg));
        } finally {
            setProcessing(false);
        }
    }, [pendingRequest, verdict, verdictLoading, understandText, coolingRemaining, resetRequestState, t]);

    const handleRejectRequest = useCallback(async () => {
        if (!pendingRequest) return;
        try {
            await WalletConnectService.rejectRequest(pendingRequest.id);
        } catch (error) {
            console.warn('[WalletConnectScreen] Reject request error:', error);
        }
        resetRequestState();
    }, [pendingRequest, resetRequestState]);

    // ─────────────────────────────────────────────────────────────────────
    // Session disconnect
    // ─────────────────────────────────────────────────────────────────────

    const handleDisconnect = useCallback(async (topic: string, name: string) => {
        Alert.alert(
            t('walletConnect.disconnect'),
            t('walletConnect.disconnectConfirm', { name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('walletConnect.disconnect'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await WalletConnectService.disconnectSession(topic);
                            setSessions(WalletConnectService.getSessions());
                        } catch (error) {
                            console.warn('[WalletConnectScreen] Disconnect error:', error);
                            // Remove from local state even if relay fails
                            setSessions(WalletConnectService.getSessions());
                        }
                    },
                },
            ]
        );
    }, []);

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    const getMethodLabel = (method: string): string => {
        switch (method) {
            case 'personal_sign': return t('walletConnect.signMessage');
            case 'eth_signTypedData':
            case 'eth_signTypedData_v4': return t('walletConnect.signTypedData');
            case 'eth_sendTransaction': return t('walletConnect.sendTransaction');
            case 'eth_signTransaction': return t('walletConnect.signTransaction');
            default: return method;
        }
    };

    const getMethodRiskColor = (method: string): string => {
        switch (method) {
            case 'personal_sign': return COLORS.primary;
            case 'eth_signTypedData':
            case 'eth_signTypedData_v4': return COLORS.warning;
            case 'eth_sendTransaction': return COLORS.warning;
            default: return COLORS.textSecondary;
        }
    };

    const formatSignMessage = (request: WCRequest): string => {
        try {
            // Typed-data methods carry the address in params[0] and the EIP-712
            // payload in params[1]; show the actual message, not the address.
            if (request.method === 'eth_signTypedData' || request.method === 'eth_signTypedData_v4') {
                const td = request.params[1];
                const obj = typeof td === 'string' ? JSON.parse(td) : td;
                const body = obj && typeof obj === 'object' && 'message' in obj
                    ? (obj as { message: unknown }).message
                    : obj;
                const pretty = JSON.stringify(body, null, 2);
                return pretty.length > 600 ? pretty.slice(0, 600) + '…' : pretty;
            }
            const message = request.params[0] as string;
            if (ethers.isHexString(message)) {
                const decoded = ethers.toUtf8String(message);
                // Limit display length
                return decoded.length > 300 ? decoded.slice(0, 300) + '...' : decoded;
            }
            return typeof message === 'string'
                ? (message.length > 300 ? message.slice(0, 300) + '...' : message)
                : JSON.stringify(message).slice(0, 300);
        } catch {
            return t('walletConnect.cannotDecode');
        }
    };

    const shortAddr = (a?: string): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

    // One-line description of an inner call unwrapped from a router / multicall
    // wrapper. Mirrors the top-level banner semantics (unknown token → never
    // assert a fungible amount; unlimited → emphasised).
    const describeInnerCall = (c: DecodedCall): string => {
        const party = shortAddr(c.counterparty);
        const symbol = c.tokenKnown ? c.tokenSymbol : t('walletConnect.unverifiedToken');
        const amount = c.amountFormatted || c.amountRaw || '?';
        if (c.kind === 'erc20_approve') {
            return c.isUnlimitedApproval
                ? t('walletConnect.innerApproveUnlimited', { spender: party, symbol })
                : t('walletConnect.innerApprove', { spender: party, amount, symbol });
        }
        if (c.kind === 'erc721_approve_all') {
            return c.isUnlimitedApproval
                ? t('walletConnect.innerApproveAll', { operator: party })
                : t('walletConnect.innerRevokeAll', { operator: party });
        }
        // erc20_transfer
        return t('walletConnect.innerTransfer', { amount, symbol, recipient: party });
    };

    // Render a human-readable banner for the decoded ERC-20 / ERC-721 action,
    // so the user sees a token transfer or (especially) an approval instead of
    // just "0 ETH". Approvals are emphasised; unlimited approvals are red.
    const renderDecodedBanner = (decoded: WCTransactionDetails['decoded']) => {
        if (!decoded || decoded.kind === 'native_transfer') return null;

        if (decoded.kind === 'erc20_approve') {
            // Unknown token: we can't verify the contract, its decimals, or even
            // whether the uint is an ERC-20 amount vs an ERC-721 tokenId. Warn,
            // and never assert a fungible amount.
            if (!decoded.tokenKnown) {
                return (
                    <View style={[styles.decodedBanner, styles.decodedWarn]}>
                        <Ionicons name="warning" size={18} color={COLORS.warning} />
                        <View style={styles.decodedTextWrap}>
                            <Text style={styles.decodedTitle}>
                                {t('walletConnect.approveUnverified', { spender: shortAddr(decoded.counterparty) })}
                            </Text>
                            <Text style={styles.decodedSub}>{t('walletConnect.unknownTokenCaution')}</Text>
                        </View>
                    </View>
                );
            }
            const danger = !!decoded.isUnlimitedApproval;
            const symbol = decoded.tokenSymbol;
            const amount = decoded.amountFormatted || decoded.amountRaw;
            return (
                <View style={[styles.decodedBanner, danger ? styles.decodedDanger : styles.decodedWarn]}>
                    <Ionicons name="warning" size={18} color={danger ? COLORS.error : COLORS.warning} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>
                            {danger
                                ? t('walletConnect.decodedApproveUnlimited', { spender: shortAddr(decoded.counterparty), symbol })
                                : decoded.isIncrease
                                    ? t('walletConnect.decodedIncrease', { spender: shortAddr(decoded.counterparty), amount, symbol })
                                    : t('walletConnect.decodedApprove', { spender: shortAddr(decoded.counterparty), amount, symbol })}
                        </Text>
                        <Text style={styles.decodedSub}>
                            {danger
                                ? t('walletConnect.unlimitedDanger', { symbol })
                                : t('walletConnect.approvalDanger', { symbol })}
                        </Text>
                    </View>
                </View>
            );
        }

        if (decoded.kind === 'erc721_approve_all') {
            // approved=false is a REVOCATION (the user protecting themselves) —
            // never label it as a collection-wide grant.
            if (!decoded.isUnlimitedApproval) {
                return (
                    <View style={[styles.decodedBanner, styles.decodedInfo]}>
                        <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} />
                        <View style={styles.decodedTextWrap}>
                            <Text style={styles.decodedTitle}>
                                {t('walletConnect.decodedRevokeAll', { operator: shortAddr(decoded.counterparty) })}
                            </Text>
                        </View>
                    </View>
                );
            }
            return (
                <View style={[styles.decodedBanner, styles.decodedDanger]}>
                    <Ionicons name="warning" size={18} color={COLORS.error} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>
                            {t('walletConnect.decodedApproveAll', { operator: shortAddr(decoded.counterparty) })}
                        </Text>
                        <Text style={styles.decodedSub}>{t('walletConnect.approveAllDanger')}</Text>
                    </View>
                </View>
            );
        }

        if (decoded.kind === 'erc20_transfer') {
            if (!decoded.tokenKnown) {
                return (
                    <View style={[styles.decodedBanner, styles.decodedWarn]}>
                        <Ionicons name="help-circle" size={18} color={COLORS.warning} />
                        <View style={styles.decodedTextWrap}>
                            <Text style={styles.decodedTitle}>{t('walletConnect.unknownTokenCaution')}</Text>
                        </View>
                    </View>
                );
            }
            return (
                <View style={[styles.decodedBanner, styles.decodedInfo]}>
                    <Ionicons name="arrow-up-circle" size={18} color={COLORS.primary} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>
                            {t('walletConnect.decodedSendTo', { amount: decoded.amountFormatted || decoded.amountRaw, symbol: decoded.tokenSymbol, recipient: shortAddr(decoded.counterparty) })}
                        </Text>
                    </View>
                </View>
            );
        }

        // wrapped_calls — a router / multicall wrapper we unwrapped one level.
        // Show each inner action; emphasise (red) if any is an unlimited approval.
        if (decoded.kind === 'wrapped_calls') {
            const inner = decoded.innerCalls || [];
            const danger = decoded.riskLevel === 'high' || !!decoded.isUnlimitedApproval;
            const title =
                decoded.wrapper === 'universal_router'
                    ? t('walletConnect.wrappedRouterTitle', { count: inner.length })
                    : t('walletConnect.wrappedBatchTitle', { count: inner.length });
            return (
                <View style={[styles.decodedBanner, danger ? styles.decodedDanger : styles.decodedWarn]}>
                    <Ionicons name="warning" size={18} color={danger ? COLORS.error : COLORS.warning} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>{title}</Text>
                        {inner.map((c, i) => (
                            <Text key={i} style={styles.decodedSub}>{`• ${describeInnerCall(c)}`}</Text>
                        ))}
                        <Text style={styles.decodedSub}>{t('walletConnect.wrappedCaution')}</Text>
                    </View>
                </View>
            );
        }

        // contract_call — undecodable calldata
        return (
            <View style={[styles.decodedBanner, styles.decodedWarn]}>
                <Ionicons name="alert-circle" size={18} color={COLORS.warning} />
                <View style={styles.decodedTextWrap}>
                    <Text style={styles.decodedTitle}>{t('walletConnect.undecodableCaution')}</Text>
                </View>
            </View>
        );
    };

    // Detect and surface gasless approval signatures (EIP-2612 permit / Permit2)
    // on the typed-data sign path — a signature here grants spend authority with
    // no on-chain transaction, so it would otherwise read as a benign blob.
    const renderPermitBanner = (request: WCRequest | null) => {
        if (!request) return null;
        if (request.method !== 'eth_signTypedData' && request.method !== 'eth_signTypedData_v4') return null;

        const sessionChainId = parseInt((request.chainId || '').split(':')[1] || '1', 10);
        let permit: ReturnType<typeof decodeTypedData> = null;
        try {
            const td = request.params[1];
            const obj = typeof td === 'string' ? JSON.parse(td) : td;
            permit = decodeTypedData(obj, sessionChainId);
        } catch {
            permit = null;
        }
        if (!permit) return null;

        const spender = shortAddr(permit.spender);

        // DAI allowed=false — a protective revocation, not a grant.
        if (permit.isRevoke) {
            return (
                <View style={[styles.decodedBanner, styles.decodedInfo]}>
                    <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>{t('walletConnect.permitRevoke', { spender, symbol: permit.tokenSymbol })}</Text>
                    </View>
                </View>
            );
        }

        const danger = permit.riskLevel === 'high';
        const bannerStyle = [styles.decodedBanner, danger ? styles.decodedDanger : styles.decodedWarn];
        const iconColor = danger ? COLORS.error : COLORS.warning;

        // Batch (Permit2 PermitBatch / PermitBatchTransferFrom) — show every item.
        if (permit.kind === 'permit2_batch') {
            return (
                <View style={bannerStyle}>
                    <Ionicons name="warning" size={18} color={iconColor} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>
                            {permit.isTransfer
                                ? t('walletConnect.permitBatchTransfer', { count: permit.batchCount, spender })
                                : t('walletConnect.permitBatch', { count: permit.batchCount, spender })}
                        </Text>
                        {(permit.items || []).map((it, i) => (
                            <Text key={i} style={styles.decodedSub}>
                                {`• ${it.isUnlimited ? t('walletConnect.unlimited') : (it.amountFormatted || it.amountRaw || '?')} ${it.tokenKnown ? it.tokenSymbol : t('walletConnect.unverifiedToken')}`}
                            </Text>
                        ))}
                        <Text style={styles.decodedSub}>{t('walletConnect.permitDanger')}</Text>
                    </View>
                </View>
            );
        }

        // Unknown token (single) → strong caution (most-restrictive null-state).
        if (!permit.tokenKnown) {
            return (
                <View style={bannerStyle}>
                    <Ionicons name="warning" size={18} color={iconColor} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>{t('walletConnect.permitUnverified', { spender })}</Text>
                        <Text style={styles.decodedSub}>{t('walletConnect.unknownTokenCaution')}</Text>
                    </View>
                </View>
            );
        }

        const symbol = permit.tokenSymbol;
        const amount = permit.amountFormatted || permit.amountRaw;
        let title: string;
        if (permit.isTransfer) {
            title = permit.isUnlimited
                ? t('walletConnect.permitTransferUnlimited', { spender, symbol })
                : t('walletConnect.permitTransfer', { spender, amount, symbol });
        } else if (permit.isUnlimited) {
            title = t('walletConnect.permitUnlimited', { spender, symbol });
        } else {
            title = t('walletConnect.permit', { spender, amount, symbol });
        }
        return (
            <View style={bannerStyle}>
                <Ionicons name="warning" size={18} color={iconColor} />
                <View style={styles.decodedTextWrap}>
                    <Text style={styles.decodedTitle}>{title}</Text>
                    <Text style={styles.decodedSub}>{t('walletConnect.permitDanger')}</Text>
                </View>
            </View>
        );
    };

    // Render the governance verdict: a hard block (Approve disabled + reason),
    // a strong-confirm gate (typed "I UNDERSTAND" + cooling countdown), or a
    // mild soft-confirm note. auto_approve / biometric-only verdicts render nothing.
    const renderGovernanceBanner = () => {
        if (!verdict) return null;

        if (verdict.lane === 'block') {
            return (
                <View style={[styles.decodedBanner, styles.decodedDanger]}>
                    <Ionicons name="hand-left" size={18} color={COLORS.error} />
                    <View style={styles.decodedTextWrap}>
                        <Text style={styles.decodedTitle}>{t('walletConnect.policyBlockedTitle')}</Text>
                        <Text style={styles.decodedSub}>{verdict.denyReason || t('walletConnect.policyBlockedGeneric')}</Text>
                    </View>
                </View>
            );
        }

        if (verdict.requiresStrongConfirm) {
            return (
                <View style={styles.governanceWrap}>
                    <View style={[styles.decodedBanner, styles.decodedDanger]}>
                        <Ionicons name="warning" size={18} color={COLORS.error} />
                        <View style={styles.decodedTextWrap}>
                            <Text style={styles.decodedTitle}>{t('walletConnect.strongConfirmTitle')}</Text>
                            {(verdict.reasons.length > 0 ? verdict.reasons : [t('walletConnect.strongConfirmGeneric')]).map((r, i) => (
                                <Text key={i} style={styles.decodedSub}>{`• ${r}`}</Text>
                            ))}
                        </View>
                    </View>
                    <Text style={styles.understandLabel}>{t('walletConnect.typeToConfirm', { phrase: UNDERSTAND_PHRASE })}</Text>
                    <TextInput
                        style={styles.understandInput}
                        value={understandText}
                        onChangeText={setUnderstandText}
                        placeholder={UNDERSTAND_PHRASE}
                        placeholderTextColor={COLORS.textMuted}
                        autoCapitalize="characters"
                        autoCorrect={false}
                    />
                </View>
            );
        }

        if (verdict.lane === 'soft_confirm' && verdict.reasons.length > 0) {
            return (
                <View style={[styles.decodedBanner, styles.decodedWarn]}>
                    <Ionicons name="information-circle" size={18} color={COLORS.warning} />
                    <View style={styles.decodedTextWrap}>
                        {verdict.reasons.map((r, i) => (
                            <Text key={i} style={styles.decodedSub}>{`• ${r}`}</Text>
                        ))}
                    </View>
                </View>
            );
        }

        return null;
    };

    const isBlocked = verdict?.lane === 'block';
    const needsStrong = !!verdict?.requiresStrongConfirm;
    const strongSatisfied = understandText.trim().toUpperCase() === UNDERSTAND_PHRASE && coolingRemaining === 0;
    // Keep Approve disabled until the governance pre-check resolves, so a fast
    // tap can't bypass the strong-confirm gate before the verdict is known.
    const approveDisabled = processing || verdictLoading || isBlocked || (needsStrong && !strongSatisfied);

    const approveLabel = (): string => {
        if (isBlocked) return t('walletConnect.blocked');
        if (needsStrong && coolingRemaining > 0) return t('walletConnect.coolingDown', { seconds: coolingRemaining });
        return pendingRequest?.method === 'eth_sendTransaction' ? t('dashboard.send') : t('walletConnect.sign');
    };

    // ─────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.background}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()}>
                    <Ionicons name="close" size={24} color={COLORS.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{t('walletConnect.headerTitle')}</Text>
                <View style={{ width: 24 }} />
            </View>

            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                {/* Connect Section */}
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Ionicons name="link-outline" size={20} color={COLORS.primary} />
                        <Text style={styles.cardTitle}>{t('walletConnect.connectToDapp')}</Text>
                    </View>

                    <TouchableOpacity style={styles.scanButton} onPress={openScanner} activeOpacity={0.85}>
                        <Ionicons name="qr-code-outline" size={20} color="#FFFFFF" />
                        <Text style={styles.scanButtonText}>{t('walletConnect.scan')}</Text>
                    </TouchableOpacity>

                    <View style={styles.orRow}>
                        <View style={styles.orLine} />
                        <Text style={styles.orText}>{t('walletConnect.or')}</Text>
                        <View style={styles.orLine} />
                    </View>

                    <Text style={styles.label}>{t('walletConnect.pasteUri')}</Text>
                    <TextInput
                        style={styles.input}
                        placeholder={t('walletConnect.uriPlaceholder')}
                        placeholderTextColor={COLORS.textMuted}
                        value={uri}
                        onChangeText={(text) => {
                            setUri(text);
                            if (screenState === 'error') setScreenState('idle');
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline={false}
                    />

                    {screenState === 'error' && (
                        <View style={styles.errorBanner}>
                            <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                            <Text style={styles.errorText}>{errorDisplayCopy(errorMessage)}</Text>
                        </View>
                    )}

                    <TouchableOpacity
                        style={[
                            styles.connectButton,
                            (screenState === 'connecting' || !uri.trim()) && styles.buttonDisabled,
                        ]}
                        onPress={handleConnect}
                        disabled={screenState === 'connecting' || !uri.trim()}
                    >
                        {screenState === 'connecting' ? (
                            <ActivityIndicator color="#FFF" size="small" />
                        ) : (
                            <Text style={styles.connectButtonText}>{t('walletConnect.connect')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Active Sessions */}
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Ionicons name="globe-outline" size={20} color={COLORS.primary} />
                        <Text style={styles.cardTitle}>{t('walletConnect.activeSessions')}</Text>
                        <Text style={styles.badge}>{sessions.length}</Text>
                    </View>

                    {sessions.length === 0 ? (
                        <Text style={styles.emptyText}>{t('walletConnect.noActiveSessions')}</Text>
                    ) : (
                        sessions.map((session) => (
                            <View key={session.topic} style={styles.sessionRow}>
                                <View style={styles.sessionIconContainer}>
                                    {session.peerMeta.icons[0] ? (
                                        <Image
                                            source={{ uri: session.peerMeta.icons[0] }}
                                            style={styles.sessionIcon}
                                        />
                                    ) : (
                                        <Ionicons name="globe-outline" size={24} color={COLORS.primary} />
                                    )}
                                </View>
                                <View style={styles.sessionInfo}>
                                    <Text style={styles.sessionName} numberOfLines={1}>
                                        {session.peerMeta.name}
                                    </Text>
                                    <Text style={styles.sessionUrl} numberOfLines={1}>
                                        {session.peerMeta.url}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.disconnectButton}
                                    onPress={() => handleDisconnect(session.topic, session.peerMeta.name)}
                                >
                                    <Ionicons name="close-circle-outline" size={22} color={COLORS.error} />
                                </TouchableOpacity>
                            </View>
                        ))
                    )}
                </View>

                {/* Info */}
                <View style={styles.infoRow}>
                    <Ionicons name="shield-checkmark-outline" size={16} color={COLORS.textMuted} />
                    <Text style={styles.infoText}>
                        {t('walletConnect.securityNote')}
                    </Text>
                </View>
            </KeyboardSafeScrollView>

            {/* ─── Session Proposal Modal ─── */}
            {/* [Audit #43] onRequestClose handles the Android hardware Back button.
                Without it, Back is swallowed and the pending proposal can only be
                dismissed via the on-screen buttons; wiring it to handleRejectSession
                sends the dApp a JSON-RPC 4001 rejection (mirrors the QR modal). */}
            <Modal
                visible={screenState === 'proposal' && !!proposal}
                transparent
                animationType="slide"
                onRequestClose={handleRejectSession}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        {proposal?.icons[0] ? (
                            <Image
                                source={{ uri: proposal.icons[0] }}
                                style={styles.proposalIcon}
                            />
                        ) : (
                            <View style={styles.proposalIconPlaceholder}>
                                <Ionicons name="globe-outline" size={40} color={COLORS.primary} />
                            </View>
                        )}

                        <Text style={styles.modalTitle}>{t('walletConnect.connectionRequest')}</Text>
                        <Text style={styles.modalDappName}>{proposal?.name}</Text>
                        {proposal?.description ? (
                            <Text style={styles.modalDescription}>{proposal.description}</Text>
                        ) : null}
                        <Text style={styles.modalUrl}>{proposal?.url}</Text>

                        {proposal?.chains && proposal.chains.length > 0 && (
                            <View style={styles.chainsContainer}>
                                <Text style={styles.chainsLabel}>{t('walletConnect.requestedChains')}</Text>
                                <View style={styles.chainsList}>
                                    {proposal.chains.map((chain) => (
                                        <View key={chain} style={styles.chainChip}>
                                            <Text style={styles.chainChipText}>{chain}</Text>
                                        </View>
                                    ))}
                                </View>
                            </View>
                        )}

                        <View style={styles.permissionsContainer}>
                            <Text style={styles.chainsLabel}>{t('walletConnect.permissions')}</Text>
                            <Text style={styles.permissionItem}>{t('walletConnect.permViewAddress')}</Text>
                            <Text style={styles.permissionItem}>{t('walletConnect.permRequestTx')}</Text>
                            <Text style={styles.permissionItem}>{t('walletConnect.permRequestMsg')}</Text>
                        </View>

                        <View style={styles.modalActions}>
                            <TouchableOpacity
                                style={[styles.modalButton, styles.rejectButton]}
                                onPress={handleRejectSession}
                                disabled={processing}
                            >
                                <Text style={styles.rejectText}>{t('common.reject')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.modalButton, styles.approveButton]}
                                onPress={handleApproveSession}
                                disabled={processing}
                            >
                                {processing ? (
                                    <ActivityIndicator color="#FFF" size="small" />
                                ) : (
                                    <Text style={styles.approveText}>{t('common.approve')}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* ─── Request Modal ─── */}
            {/* [Audit #43] Android hardware Back rejects the pending signing request
                (JSON-RPC 4001 to the dApp + local reset) instead of being swallowed,
                which previously left the modal wedged and the dApp orphaned. */}
            <Modal
                visible={!!pendingRequest}
                transparent
                animationType="slide"
                onRequestClose={handleRejectRequest}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={[
                            styles.methodBadge,
                            { backgroundColor: getMethodRiskColor(pendingRequest?.method || '') + '20' },
                        ]}>
                            <Ionicons
                                name={pendingRequest?.method === 'eth_sendTransaction' ? 'arrow-up-circle' : 'create-outline'}
                                size={28}
                                color={getMethodRiskColor(pendingRequest?.method || '')}
                            />
                        </View>

                        <Text style={styles.modalTitle}>
                            {getMethodLabel(pendingRequest?.method || '')}
                        </Text>
                        <Text style={styles.modalDappName}>{pendingRequest?.peerMeta.name}</Text>
                        <Text style={styles.modalUrl}>{pendingRequest?.peerMeta.url}</Text>

                        {/* Gasless approval (permit / Permit2) banner */}
                        {renderPermitBanner(pendingRequest)}

                        {/* Transaction details */}
                        {txDetails && (
                            <View style={styles.txDetailsContainer}>
                                {renderDecodedBanner(txDetails.decoded)}
                                <View style={styles.txRow}>
                                    <Text style={styles.txLabel}>{t('walletConnect.toLabel')}</Text>
                                    <Text style={styles.txValue} numberOfLines={1}>
                                        {txDetails.to
                                            ? `${txDetails.to.slice(0, 10)}...${txDetails.to.slice(-8)}`
                                            : i18next.t('ui.walletConnect.contractCreation')}
                                    </Text>
                                </View>
                                <View style={styles.txRow}>
                                    <Text style={styles.txLabel}>{t('walletConnect.valueLabel')}</Text>
                                    <Text style={[
                                        styles.txValue,
                                        parseFloat(txDetails.value) > 0 && styles.txValueHighlight,
                                    ]}>
                                        {txDetails.value} ETH
                                    </Text>
                                </View>
                                <View style={styles.txRow}>
                                    <Text style={styles.txLabel}>{t('contacts.networkLabel')}</Text>
                                    <Text style={styles.txValue}>{txDetails.chainName}</Text>
                                </View>
                                {txDetails.data !== '0x' && (
                                    <View style={styles.txRow}>
                                        <Text style={styles.txLabel}>{t('walletConnect.dataLabel')}</Text>
                                        <Text style={styles.txValueMono} numberOfLines={1}>
                                            {txDetails.data.slice(0, 20)}...
                                        </Text>
                                    </View>
                                )}
                            </View>
                        )}

                        {/* Sign message details */}
                        {pendingRequest && !txDetails && (
                            <ScrollView style={styles.messageContainer}>
                                <Text style={styles.messageText}>
                                    {formatSignMessage(pendingRequest)}
                                </Text>
                            </ScrollView>
                        )}

                        {/* Governance verdict: block / strong-confirm / soft note */}
                        {renderGovernanceBanner()}

                        <View style={styles.modalActions}>
                            <TouchableOpacity
                                style={[styles.modalButton, styles.rejectButton]}
                                onPress={handleRejectRequest}
                                disabled={processing}
                            >
                                <Text style={styles.rejectText}>{t('common.reject')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.modalButton, styles.approveButton, approveDisabled && styles.buttonDisabled]}
                                onPress={handleApproveRequest}
                                disabled={approveDisabled}
                            >
                                {processing ? (
                                    <ActivityIndicator color="#FFF" size="small" />
                                ) : (
                                    <Text style={styles.approveText}>{approveLabel()}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* ─── QR Scanner Modal ─── */}
            <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
                <View style={styles.scannerContainer}>
                    <CameraView
                        style={StyleSheet.absoluteFill}
                        facing="back"
                        onBarcodeScanned={handleBarcodeScanned}
                        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    />
                    <SafeAreaView style={styles.scannerOverlay}>
                        <View style={styles.scannerHeader}>
                            <TouchableOpacity
                                style={styles.scannerClose}
                                onPress={() => setShowScanner(false)}
                            >
                                <Ionicons name="close" size={26} color="#FFFFFF" />
                            </TouchableOpacity>
                            <Text style={styles.scannerTitle}>{t('walletConnect.scan')}</Text>
                            <View style={{ width: 26 }} />
                        </View>
                        <View style={styles.scannerFrame} />
                        <Text style={styles.scannerHint}>{t('walletConnect.scanInstructions')}</Text>
                    </SafeAreaView>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.l,
        flexGrow: 1,
        gap: SPACING.l,
    },

    // Card
    card: {
        backgroundColor: COLORS.glass,
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.m,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        flex: 1,
    },
    badge: {
        backgroundColor: COLORS.primaryMuted,
        color: COLORS.primary,
        fontSize: 12,
        fontWeight: '600',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.round,
        overflow: 'hidden',
    },

    // Input
    label: {
        color: COLORS.textMuted,
        marginBottom: SPACING.xs,
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 2,
    },
    input: {
        backgroundColor: COLORS.surfaceHighlight,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        color: COLORS.text,
        borderWidth: 1,
        borderColor: COLORS.border,
        fontSize: 14,
        fontFamily: 'monospace',
    },

    // Connect button
    connectButton: {
        marginTop: SPACING.m,
        backgroundColor: COLORS.primary,
        paddingVertical: 14,
        borderRadius: BORDER_RADIUS.round,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: COLORS.primary,
        shadowOpacity: 0.3,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    connectButtonText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 16,
    },
    buttonDisabled: {
        opacity: 0.5,
    },

    // Error
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginTop: SPACING.s,
        padding: SPACING.s,
        backgroundColor: COLORS.errorMuted,
        borderRadius: BORDER_RADIUS.m,
    },
    errorText: {
        color: COLORS.error,
        fontSize: 13,
        flex: 1,
    },

    // Sessions
    emptyText: {
        color: COLORS.textMuted,
        fontStyle: 'italic',
        fontSize: 14,
    },
    sessionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        borderTopWidth: 1,
        borderTopColor: COLORS.borderLight,
        gap: SPACING.s,
    },
    sessionIconContainer: {
        width: 40,
        height: 40,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    sessionIcon: {
        width: 40,
        height: 40,
        borderRadius: BORDER_RADIUS.m,
    },
    sessionInfo: {
        flex: 1,
    },
    sessionName: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.text,
    },
    sessionUrl: {
        fontSize: 12,
        color: COLORS.textMuted,
        marginTop: 2,
    },
    disconnectButton: {
        padding: SPACING.xs,
    },

    // Info
    infoRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        paddingHorizontal: SPACING.xs,
    },
    infoText: {
        fontSize: 12,
        color: COLORS.textMuted,
        flex: 1,
        lineHeight: 18,
    },

    // ─── Modals ───
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.85)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: COLORS.surface,
        borderTopLeftRadius: BORDER_RADIUS.xl,
        borderTopRightRadius: BORDER_RADIUS.xl,
        padding: SPACING.xl,
        paddingBottom: SPACING.xxl,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        borderBottomWidth: 0,
        maxHeight: '85%',
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: COLORS.text,
        marginTop: SPACING.m,
    },
    modalDappName: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.primary,
        marginTop: SPACING.xs,
    },
    modalDescription: {
        fontSize: 14,
        color: COLORS.textSecondary,
        textAlign: 'center',
        marginTop: SPACING.xs,
    },
    modalUrl: {
        fontSize: 13,
        color: COLORS.textMuted,
        marginTop: SPACING.xs,
        marginBottom: SPACING.m,
    },
    modalActions: {
        flexDirection: 'row',
        gap: SPACING.m,
        width: '100%',
        marginTop: SPACING.l,
    },
    modalButton: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: BORDER_RADIUS.round,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rejectButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: COLORS.error,
    },
    approveButton: {
        backgroundColor: COLORS.primary,
        shadowColor: COLORS.primary,
        shadowOpacity: 0.3,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    rejectText: {
        color: COLORS.error,
        fontWeight: 'bold',
        fontSize: 15,
    },
    approveText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 15,
    },

    // Proposal
    proposalIcon: {
        width: 64,
        height: 64,
        borderRadius: BORDER_RADIUS.l,
    },
    proposalIconPlaceholder: {
        width: 64,
        height: 64,
        borderRadius: BORDER_RADIUS.l,
        backgroundColor: COLORS.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chainsContainer: {
        width: '100%',
        marginBottom: SPACING.s,
    },
    chainsLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: COLORS.textMuted,
        letterSpacing: 2,
        marginBottom: SPACING.xs,
    },
    chainsList: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.xs,
    },
    chainChip: {
        backgroundColor: COLORS.primaryMuted,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: BORDER_RADIUS.round,
    },
    chainChipText: {
        fontSize: 12,
        fontWeight: '500',
        color: COLORS.primary,
    },
    permissionsContainer: {
        width: '100%',
    },
    permissionItem: {
        fontSize: 14,
        color: COLORS.textSecondary,
        paddingVertical: 4,
        paddingLeft: SPACING.s,
    },

    // Request - method badge
    methodBadge: {
        width: 56,
        height: 56,
        borderRadius: BORDER_RADIUS.round,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // Transaction details
    txDetailsContainer: {
        width: '100%',
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        gap: SPACING.s,
    },
    txRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    txLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: COLORS.textMuted,
        letterSpacing: 1.5,
    },
    txValue: {
        fontSize: 14,
        color: COLORS.text,
        fontWeight: '500',
        maxWidth: '65%',
        textAlign: 'right',
    },
    txValueHighlight: {
        color: COLORS.warning,
        fontWeight: '700',
    },
    txValueMono: {
        fontSize: 12,
        color: COLORS.textMuted,
        fontFamily: 'monospace',
        maxWidth: '65%',
        textAlign: 'right',
    },

    // Sign message
    messageContainer: {
        width: '100%',
        maxHeight: 150,
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
    },
    messageText: {
        fontSize: 13,
        color: COLORS.textSecondary,
        fontFamily: 'monospace',
        lineHeight: 20,
    },

    // Warning
    warningBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        width: '100%',
        marginTop: SPACING.s,
        padding: SPACING.s,
        backgroundColor: COLORS.errorMuted,
        borderRadius: BORDER_RADIUS.m,
    },
    warningText: {
        color: COLORS.error,
        fontSize: 12,
        flex: 1,
        lineHeight: 16,
    },

    // Decoded transaction banner (token transfer / approval)
    decodedBanner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        padding: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        marginBottom: SPACING.s,
    },
    decodedTextWrap: {
        flex: 1,
    },
    decodedTitle: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '700',
    },
    decodedSub: {
        color: COLORS.textMuted,
        fontSize: 12,
        marginTop: 2,
        lineHeight: 16,
    },
    decodedDanger: {
        backgroundColor: COLORS.errorMuted,
        borderColor: COLORS.error,
    },
    decodedWarn: {
        backgroundColor: COLORS.warningMuted,
        borderColor: COLORS.warning,
    },
    decodedInfo: {
        backgroundColor: COLORS.primaryMuted,
        borderColor: COLORS.primary,
    },

    // Governance strong-confirm gate
    governanceWrap: {
        width: '100%',
    },
    understandLabel: {
        color: COLORS.textMuted,
        fontSize: 12,
        fontWeight: '600',
        marginBottom: SPACING.xs,
    },
    understandInput: {
        width: '100%',
        backgroundColor: COLORS.surfaceHighlight,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        color: COLORS.text,
        borderWidth: 1,
        borderColor: COLORS.error,
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: 1,
    },

    // Scan button + "or" divider
    scanButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        backgroundColor: COLORS.primary,
        paddingVertical: 14,
        borderRadius: BORDER_RADIUS.round,
        shadowColor: COLORS.primary,
        shadowOpacity: 0.3,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    scanButtonText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 16,
    },
    orRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginVertical: SPACING.m,
    },
    orLine: {
        flex: 1,
        height: 1,
        backgroundColor: COLORS.borderLight,
    },
    orText: {
        color: COLORS.textMuted,
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 1,
    },

    // QR scanner modal
    scannerContainer: {
        flex: 1,
        backgroundColor: '#000000',
    },
    scannerOverlay: {
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
    },
    scannerHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.m,
    },
    scannerClose: {
        width: 40,
        height: 40,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    scannerTitle: {
        color: '#FFFFFF',
        fontSize: 17,
        fontWeight: '600',
    },
    scannerFrame: {
        width: 240,
        height: 240,
        marginTop: '30%',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 3,
        borderColor: '#FFFFFF',
        backgroundColor: 'transparent',
    },
    scannerHint: {
        color: '#FFFFFF',
        fontSize: 14,
        textAlign: 'center',
        marginTop: SPACING.l,
        paddingHorizontal: SPACING.xl,
    },
});

export default WalletConnectScreen;
