import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction } from '../../core/security/biometricAction';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView, Modal, KeyboardAvoidingView, Platform, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../theme';
import * as Haptics from 'expo-haptics';
import PolicyEngine from '../../core/policy/PolicyEngine';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
// [F19] Kept for the first-party Emergency-Stop check only. The agent-initiated
// Send path (AgentSpendRequest / AgentAuthorizationResult / AgentAuthorizationToken)
// was DELETED — it was DEV-simulator scaffolding that executed an agent-attributed
// on-chain send through first-party TransactionService, bypassing
// evaluateCryptoTransaction and the shelved AGENT_CRYPTO_AUTHORITY guard.
import UserProtectionManager, { TransactionWarning } from '../../core/protection/UserProtectionManager';
import CoercionDetector from '../../core/security/CoercionDetector';
import RiskEngine from '../../core/risk/RiskEngine';
import { requireBiometric, BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import AddressHistoryService, { Contact, ChainType as ContactChainType } from '../../core/protection/AddressHistoryService';
// [F19] CoolingPeriod / UnderstandingTest were only used by the deleted
// agent-initiated Send friction steps.
import WarningScreen from '../../components/WarningScreen';

// Chain utilities
import { detectAddressChain, chainNameToType, getChainDisplayName, ChainType } from '../../core/chains/AddressValidator';
import {
    CHAINS,
    CHAIN_IDS,
    SOLANA_CHAIN_INFO,
    getChainIdFromAssetChain,
    getMultiChainToken,
    isMultiChainToken,
    getTokenChainsSortedByFee,
    formatFeeEstimate,
} from '../../core/chains/ChainConstants';

import { useWalletStore } from '../../store/walletStore';
import type { Asset } from '../../store/walletStore';
import TransactionService from '../../core/wallet/TransactionService';
import solanaTransactionService, {
    InsufficientSolForFeesError,
    isSolanaWalletAddress,
} from '../../core/chains/solana/SolanaTransactionService';
import TransactionHistoryService, { ChainType as HistoryChainType } from '../../core/history/TransactionHistoryService';
import {
    balanceRowForSend,
    formatSolAtLeast,
    formatSolHeld,
    getSendableAssets,
    isSolanaTokenSend,
    offersEvmNetworkPicker,
    resolveInitialSendAsset, defaultSendChainId } from './sendAssetSelection';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { assetUsdValue, formatUsd, hasKnownPrice } from '../../utils/fiatDisplay';
import { canonicalizeAmount, sendDecimalsOf } from '../../core/wallet/amountInput';

// [F19] REASON_CODE_LABEL_KEYS / formatReasonCode were only used to render the
// deleted agent-authorization reason codes; the surviving reason-code renderer
// lives in AgentAuthorizationScreen.

/** A network preflight that never answers must not hold the Continue run — and the in-flight guard — forever ( ). */
const PREFLIGHT_TIMEOUT_MS = 20_000;
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('preflight_timeout')), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
    });
}

const SendScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const { assets, address, solanaAddress, isOffline, queueTransaction, isLockdownActive } = useWalletStore();
    const { colors: themeColors } = useTheme();

    // Dark-mode only gradient
    const backgroundGradient = GRADIENTS.backgroundDiagonal;

    const sendableAssets = useMemo(() => getSendableAssets(assets), [assets]);

    const [selectedAsset, setSelectedAsset] = useState<Asset | null>(() =>
        resolveInitialSendAsset(assets));
    const [recipient, setRecipient] = useState('');
    // ONE address for every protection and for the send itself: the typed text without any
    // whitespace, so the self-send, policy, scam-list, lookalike and history checks judge exactly
    // the address that is paid (a padded scam address bypassed them all). The
    // text itself keeps its spaces — the same field is the contact-name search ("John S").
    const recipientAddress = useMemo(() => recipient.replace(/\s+/g, ''), [recipient]);
    // What Continue checked: the review and the send refuse anything else (an
    // edit or paste while the checks ran reached the send unchecked).
    const reviewedRef = React.useRef<{ recipient: string; amount: string; asset: string; chain: string; chainId: number } | null>(null);
    /** One Continue at a time ( ): a second run while the first waits on the network must not re-arm the review. */
    const continueInFlightRef = React.useRef(false);
    const [amount, setAmount] = useState('');
    const [step, setStep] = useState<'input' | 'warnings' | 'review' | 'processing' | 'success' | 'blocked'>('input');
    const [policyResult, setPolicyResult] = useState<any | null>(null);

    const [loading, setLoading] = useState(false);

    // Chain selection for multi-chain tokens
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null);

    // Address validation state
    const [addressError, setAddressError] = useState<string | null>(null);
    const [detectedAddressChain, setDetectedAddressChain] = useState<ChainType | null>(null);

    const [blockReason, setBlockReason] = useState<string>('');

    // Emergency Stop state

    // Warning state
    const [warnings, setWarnings] = useState<TransactionWarning[]>([]);
    const [currentWarningIndex, setCurrentWarningIndex] = useState(0);

    // Display state for review
    const [recipientDisplay, setRecipientDisplay] = useState<{ display: string; isContact: boolean; isNew: boolean } | null>(null);

    // Contact picker state
    const [favorites, setFavorites] = useState<Contact[]>([]);
    const [recentAddresses, setRecentAddresses] = useState<Contact[]>([]);
    const [showRecentDropdown, setShowRecentDropdown] = useState(false);
    const [contactSuggestions, setContactSuggestions] = useState<Contact[]>([]);
    const [selectedContactName, setSelectedContactName] = useState<string>('');

    // Save contact prompt state
    const [showSaveContactPrompt, setShowSaveContactPrompt] = useState(false);
    const [saveContactName, setSaveContactName] = useState('');


    // Check if selected asset is a multi-chain token
    const multiChainInfo = useMemo(() => {
        if (!selectedAsset) return undefined;
        return getMultiChainToken(selectedAsset.symbol);
    }, [selectedAsset?.symbol]);

    // Solana is a distinct address space, routed by chain name, not chainId.
    const isSolana = selectedAsset?.chain === 'Solana';

    // The network picker lists the EVM networks a symbol exists on. A Solana asset
    // (e.g. "USDC (Solana)") is its own asset on its own chain: it must never get
    // that picker, or the EVM default (Base) silently replaces it — the balance
    // check then read the Base USDC balance and blocked a valid Solana send.
    const isMultiChain = offersEvmNetworkPicker(selectedAsset, multiChainInfo?.chains.length ?? 0);

    // Get available chains sorted by fee (cheapest first)
    const availableChains = useMemo(() => {
        if (!multiChainInfo || !selectedAsset) return [];
        return getTokenChainsSortedByFee(selectedAsset.symbol);
    }, [selectedAsset?.symbol, multiChainInfo]);

    // Get current chain info
    const currentChainId = selectedChainId ?? (selectedAsset ? getChainIdFromAssetChain(selectedAsset.chain) : null) ?? 8453;
    const currentChainInfo = isSolana ? SOLANA_CHAIN_INFO : CHAINS[currentChainId];
    const currentFeeEstimate = useMemo(() => {
        if (multiChainInfo && selectedChainId) {
            const chainConfig = multiChainInfo.chains.find(c => c.chainId === selectedChainId);
            return chainConfig?.feeEstimateUsd ?? currentChainInfo?.avgFeeUsd ?? 0.45;
        }
        return currentChainInfo?.avgFeeUsd ?? 0.45;
    }, [multiChainInfo, selectedChainId, currentChainInfo]);

    // Coercion monitoring: start when SendScreen mounts, stop when it unmounts.
    // Detects rapid panic-tapping or device shaking during the send flow.
    useEffect(() => {
        CoercionDetector.startMonitoring();
        return () => CoercionDetector.stopMonitoring();
    }, []);

    // Auto-select cheapest chain when asset changes
    useEffect(() => {
        if (isMultiChain && availableChains.length > 0 && selectedAsset) {
            // The row the person tapped decides the starting network (2026-10-17); the picker
            // still offers the others.
            setSelectedChainId(defaultSendChainId(selectedAsset.chain, availableChains));
        } else {
            setSelectedChainId(null);
        }
    }, [selectedAsset?.symbol, selectedAsset?.chain, isMultiChain, availableChains]);

    // Validate address as user types
    useEffect(() => {
        if (!selectedAsset || !recipientAddress || recipientAddress.length < 10) {
            setAddressError(null);
            setDetectedAddressChain(null);
            return;
        }

        const detected = detectAddressChain(recipientAddress);
        setDetectedAddressChain(detected);

        // Get expected chain type based on selected asset/chain
        const expectedChainType = chainNameToType(currentChainInfo?.name ?? selectedAsset.chain);

        if (detected === 'unknown') {
            setAddressError(t('send.invalidAddressFormat'));
        } else if (detected !== expectedChainType) {
            // Chain mismatch - show helpful error
            const detectedName = getChainDisplayName(detected);

            setAddressError(t('send.chainMismatch', { chain: detectedName }));
        } else {
            setAddressError(null);
        }
    }, [recipient, selectedAsset, currentChainInfo, selectedChainId, t]);

    // Handle paste button - only access clipboard when user explicitly taps
    const handlePasteFromClipboard = async () => {
        try {
            const clipboardContent = await Clipboard.getStringAsync();
            if (clipboardContent && clipboardContent.length >= 20) {
                const detected = detectAddressChain(clipboardContent.trim());
                if (detected !== 'unknown') {
                    setRecipient(clipboardContent.trim());
                    setSelectedContactName('');
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } else {
                    Alert.alert(t('send.invalidAddress'), t('send.invalidAddressClipboard'));
                }
            } else {
                Alert.alert(t('send.nothingToPaste'), t('send.noAddressClipboard'));
            }
        } catch (error) {
            console.error('[SendScreen] Failed to read clipboard:', error);
            Alert.alert(t('common.errorTitle'), t('send.failedClipboard'));
        }
    };

    // Load favorites and recent addresses on mount
    useEffect(() => {
        const loadContacts = async () => {
            try {
                const [favs, recent] = await Promise.all([
                    AddressHistoryService.getFavorites(),
                    AddressHistoryService.getRecentAddresses(5),
                ]);
                setFavorites(favs);
                setRecentAddresses(recent);
                // Surface real recents on open (most recent first) instead of hiding them behind
                // the toggle — the human should see where they've actually sent without a tap.
                if (recent.length > 0) setShowRecentDropdown(true);
            } catch (error) {
                console.error('[SendScreen] Failed to load contacts:', error);
            }
        };
        loadContacts();
    }, []);

    // Handle prefilled address from navigation (e.g., from Contacts)
    useEffect(() => {
        const params = route?.params;
        if (params?.prefillAddress) {
            setRecipient(params.prefillAddress);
            setSelectedContactName(params.prefillName || '');
        }
    }, [route?.params?.prefillAddress]);

    // Search contacts as user types
    useEffect(() => {
        const searchContacts = async () => {
            if (recipient.length >= 3 && !selectedContactName) {
                const suggestions = await AddressHistoryService.searchContacts(recipient);
                setContactSuggestions(suggestions.slice(0, 3));
            } else {
                setContactSuggestions([]);
            }
        };
        searchContacts();
    }, [recipient, selectedContactName]);

    // USD value of the amount at the asset's last known price, or null when the
    // asset has no known price (shown as " ", never a fake $0.00).
    const getAmountUsdOrNull = (numeric?: number): number | null => {
        if (!selectedAsset || !hasKnownPrice(selectedAsset)) return null;
        const numAmount = numeric ?? (parseFloat(amount) || 0);
        return numAmount * selectedAsset.price;
    };
    // Numeric form for protection checks and history (unknown price → 0, the
    // behavior those checks always had when no price was available).
    const getAmountUsd = (numeric?: number): number => getAmountUsdOrNull(numeric) ?? 0;

    // Format address for display
    const formatAddress = (addr: string): string => {
        if (addr.length <= 12) return addr;
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    };

    /** "Needs X SOL for network fees (incl. account rent); this wallet holds Y SOL." */
    const solFeeMessage = (neededLamports: number, haveLamports: number, createsTokenAccount: boolean): string => {
        return t(createsTokenAccount ? 'send.needSolForFeesWithRent' : 'send.needSolForFees', {
            need: formatSolAtLeast(neededLamports),
            have: formatSolHeld(haveLamports),
        });
    };

    const handleContinue = async () => {
        if (continueInFlightRef.current) return;
        continueInFlightRef.current = true;
        try {
        // I-U-8: the early-return guard at line ~755 prevents selectedAsset
        // from ever being null at render time, but TS can't prove that
        // inside async closures. Explicit narrowing avoids 17 tsc errors
        // that previously blocked a clean baseline.
        if (!selectedAsset) {
            Alert.alert(t('send.noAsset'), t('send.selectAssetFirst'));
            return;
        }
        const asset = selectedAsset; // narrowed non-null
        if (!amount || !recipient) {
            Alert.alert(t('send.missingInfo'), t('send.enterRecipientAndAmount'));
            return;
        }

        // Chunk-J J-1: the typed amount in canonical form (2026-10-17: a locale comma, a
        // thousands separator or too many decimals used to reach the chain service as typed, and
        // the review showed parseFloat's reading of it).
        const sendDecimals = sendDecimalsOf(asset);
        const canonical = canonicalizeAmount(amount, sendDecimals);
        if (!canonical.ok) {
            Alert.alert(
                t('send.invalidAmount'),
                canonical.reason === 'too_many_decimals'
                    ? t('send.tooManyDecimals', { decimals: sendDecimals, symbol: asset.symbol })
                    : t('send.enterPositiveAmount'),
            );
            return;
        }
        if (canonical.value !== amount) setAmount(canonical.value);
        const numericAmount = parseFloat(canonical.value);
        // What THIS run checks (closure values, never live state): written to reviewedRef only when
        // this run opens the review ( — a second Continue could re-arm it before).
        const checked = { recipient: recipientAddress, amount: canonical.value, asset: asset.symbol, chain: asset.chain, chainId: currentChainId };
        reviewedRef.current = null;

        // Chunk-J J-2: Insufficient-balance pre-check. The policy layer does
        // not catch this, and chain services surface it as a cryptic node
        // error deep in the send flow.
        //
        // Re-derive the balance against the chain actually being sent on: for a
        // multi-chain token the user may have switched networks in the picker,
        // so the asset's home-chain balance is the wrong number to gate against
        // (review #2). And reserve an estimated gas fee for native ETH sends so
        // a full-balance send doesn't pass here and then fail in the node with
        // "insufficient funds for intrinsic transaction cost" (review #20).
        // A Solana asset has no chainId; its own row IS the balance being spent.
        const chainScopedAsset = balanceRowForSend(asset, assets, currentChainId);
        const balanceStr = chainScopedAsset.balance?.toString() ?? '0';
        const balanceNum = parseFloat(balanceStr.replace(/,/g, ''));

        // Native sends (ETH on EVM, SOL on Solana) must reserve gas out of the
        // same asset. SPL / ERC-20 sends pay gas in the native coin, not the
        // token, so no buffer applies to them.
        const isNativeSend =
            asset.symbol === 'ETH'
            || (asset.symbol === 'WETH' && !asset.tokenAddress)
            || (asset.symbol === 'SOL' && asset.chain === 'Solana');
        // A native SOL send is checked exactly, in lamports, below (fee + the rent-exempt minimum).
        const ethPrice = isNativeSend && asset.chain !== 'Solana' ? (chainScopedAsset.price || asset.price || 0) : 0;
        // currentFeeEstimate is a USD figure; convert to a native-coin buffer.
        const gasBufferEth = isNativeSend && ethPrice > 0 ? currentFeeEstimate / ethPrice : 0;
        const requiredBalance = numericAmount + gasBufferEth;
        if (Number.isFinite(balanceNum) && requiredBalance > balanceNum) {
            Alert.alert(
                t('send.insufficientBalance'),
                t('send.insufficientBalanceMsg', { balance: balanceStr, symbol: asset.symbol }),
            );
            return;
        }

        // Chunk-J J-3: Self-send detection. Users occasionally paste their
        // own receive address - ETH into ETH, USDC into USDC. These send fine
        // on-chain but waste fees. Warn explicitly and require confirmation.
        if (address && recipientAddress.toLowerCase() === address.toLowerCase()) {
            const confirmed = await new Promise<boolean>((resolve) => {
                Alert.alert(
                    t('send.sendingToYourself'),
                    t('send.sendingToYourselfMsg'),
                    [
                        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
                        { text: t('send.sendAnyway'), onPress: () => resolve(true) },
                    ],
                    { cancelable: false },
                );
            });
            if (!confirmed) return;
        }

        // Check for address validation errors
        if (addressError) {
            Alert.alert(t('send.addressMismatch'), addressError);
            return;
        }

        // A Solana token (SPL) send pays its network fee — and the rent to create the
        // recipient's token account when it has none — in SOL, never in the token.
        // Check that up front so a wallet with 0 SOL gets a clear answer, not a node error.
        // Runs after the address check, so a wrong address gets the address error, not this one.
        if (asset.chain === 'Solana' && !isSolanaWalletAddress(recipientAddress)) {
            // Base58 but off-curve (e.g. a token-account address copied from an explorer), or
            // too short for the live address check: say so, rather than a fee-check error.
            Alert.alert(t('send.invalidAddress'), t('send.notSolanaWalletAddress'));
            return;
        }
        if (asset.chain === 'Solana' && asset.symbol === 'SOL' && !asset.tokenAddress) {
            // A native SOL send must leave the wallet empty or rent-exempt after the fee; the
            // node otherwise rejected it after Face ID with a raw error (2026-10-17).
            try {
                const funding = await withTimeout(solanaTransactionService.solSendSolRequirement({
                    from: solanaAddress || '',
                    amount: canonical.value,
                }), PREFLIGHT_TIMEOUT_MS);
                if (!funding.sufficient) {
                    Alert.alert(
                        t('send.needSolForFeesTitle'),
                        t('send.needSolForNativeSend', {
                            amount: canonical.value,
                            need: formatSolAtLeast(funding.neededLamports),
                            have: formatSolHeld(funding.haveLamports),
                        }),
                    );
                    return;
                }
            } catch (fundErr) {
                console.warn('[Send] SOL fee preflight failed:', fundErr);
                Alert.alert(t('common.errorTitle'), t('send.solFeeCheckFailed'));
                return;
            }
        }
        if (isSolanaTokenSend(asset) && asset.tokenAddress) {
            try {
                const funding = await withTimeout(solanaTransactionService.splSendSolRequirement({
                    from: solanaAddress || '',
                    to: recipientAddress,
                    mint: asset.tokenAddress,
                }), PREFLIGHT_TIMEOUT_MS);
                if (!funding.sufficient) {
                    Alert.alert(t('send.needSolForFeesTitle'), solFeeMessage(funding.neededLamports, funding.haveLamports, funding.createsTokenAccount));
                    return;
                }
            } catch (fundErr) {
                console.warn('[Send] Solana fee preflight failed:', fundErr);
                Alert.alert(t('common.errorTitle'), t('send.solFeeCheckFailed'));
                return;
            }
        }

        setLoading(true);
        try {
            // 1. Run PolicyEngine for basic risk assessment
            const context = {
                amount: numericAmount, // the canonical amount — the one that is sent
                asset: asset.symbol,
                recipient: recipientAddress,
                chainId: currentChainId,
                isContractInteraction: recipientAddress.startsWith('0x') && recipientAddress.length === 42,
                isLockdownActive,
            };

            const result = await PolicyEngine.evaluate(context);
            setPolicyResult(result);

            // Check if policy blocks the transaction
            if (result.decision === 'block') {
                setBlockReason(result.reasons.join('. '));
                setStep('blocked');
                return;
            }

            // 2. Check for user protection warnings
            const protectionWarnings = await UserProtectionManager.checkForWarnings({
                action: 'send',
                amount: numericAmount, // the canonical amount — the one that is sent
                amountUsd: getAmountUsd(numericAmount),
                recipient: recipientAddress,
                assetSymbol: asset.symbol,
                networkId: currentChainId,
                userBalance: parseFloat(asset.balance.replace(/,/g, '')),
                userBalanceUsd: assetUsdValue(asset) ?? 0,
            });

            // 2b. Coercion check - panic tapping or shaking blocks the send.
            CoercionDetector.recordInteraction();
            const coercion = CoercionDetector.analyze();
            if (coercion.isCoerced) {
                protectionWarnings.unshift({
                    id: 'coercion_detected',
                    severity: 'critical',
                    title: t('send.unusualActivity'),
                    message: t('send.unusualActivityMsg'),
                    plainEnglish: t('send.coercionPlainEnglish', { triggers: coercion.triggers.join(' and ').toLowerCase() }),
                    consequences: t('send.coercionConsequences'),
                    recommendation: t('send.coercionRecommendation'),
                    canProceed: false,
                    requiresConfirmation: false,
                });
            }

            // 2c. RiskEngine - drainer + token impersonation + recipient reputation.
            // Surfaced as warnings so the user sees them in the same flow.
            try {
                const riskInput = {
                    tx: {
                        from: address || '',
                        to: recipientAddress,
                        data: '0x',
                        value: canonical.value,
                        chainId: currentChainId,
                        assetSymbol: asset.symbol,
                    },
                };
                const aggregated = await RiskEngine.calculateRiskScore(riskInput);
                for (const sig of aggregated.signals) {
                    if (sig.score < 50) continue; // skip low-signal noise
                    protectionWarnings.push({
                        id: `risk_${sig.source}`,
                        severity: sig.riskLevel === 'critical' ? 'critical' : sig.riskLevel === 'high' ? 'high' : 'medium',
                        title: t('send.safetyCheck'),
                        message: sig.details,
                        plainEnglish: sig.details,
                        consequences: t('send.riskConsequences'),
                        recommendation: t('send.riskRecommendation'),
                        canProceed: sig.riskLevel !== 'critical',
                        requiresConfirmation: true,
                    });
                }
            } catch {
                // Risk engine failure must not block the user - log only.
                console.warn('[SendScreen] RiskEngine failed, continuing with UPM warnings only');
            }

            // 3. Get recipient display info
            const displayInfo = await AddressHistoryService.formatAddressForDisplay(recipientAddress);
            setRecipientDisplay(displayInfo);

            // 4. Check if there are blocking warnings
            if (UserProtectionManager.hasBlockingWarnings(protectionWarnings)) {
                const blockingWarning = protectionWarnings.find(w => !w.canProceed);
                if (blockingWarning) {
                    setWarnings([blockingWarning]);
                    setCurrentWarningIndex(0);
                    reviewedRef.current = checked;
                    setStep('warnings');
                    return;
                }
            }

            // 5. Show ALL warnings - even low/medium informational ones.
            // Previously medium warnings (like "first-time send to new address")
            // were silently dropped, leaving users with no friction at all on
            // novel recipients. The WarningScreen handles severity styling and
            // a single "Continue" tap dismisses non-blocking warnings.
            if (protectionWarnings.length > 0) {
                setWarnings(protectionWarnings);
                setCurrentWarningIndex(0);
                reviewedRef.current = checked;
                setStep('warnings');
            } else {
                // No significant warnings - proceed to review
                reviewedRef.current = checked;
                setStep('review');
            }
        } catch (error: any) {
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(error.message));
        } finally {
            setLoading(false);
        }
        } finally {
            continueInFlightRef.current = false;
        }
    };

    // Handle warning acknowledgment
    const handleWarningProceed = () => {
        const nextIndex = currentWarningIndex + 1;
        if (nextIndex < warnings.length) {
            // More warnings to show
            setCurrentWarningIndex(nextIndex);
        } else {
            // All warnings acknowledged - proceed (the review was armed by the Continue run that
            // produced these warnings; the inputs were not on screen in between).
            setStep('review');
        }
    };

    const handleWarningGoBack = () => {
        setStep('input');
        setWarnings([]);
        setCurrentWarningIndex(0);
    };

    // Contact selection handlers
    const handleSelectContact = (contact: Contact) => {
        setRecipient(contact.address);
        setSelectedContactName(contact.name);
        setContactSuggestions([]);
        setShowRecentDropdown(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    };

    const handleOpenAddressBook = () => {
        navigation.navigate('Contacts');
    };

    const handleSaveNewContact = async () => {
        if (!saveContactName.trim()) {
            Alert.alert(t('common.errorTitle'), t('send.enterContactName'));
            return;
        }

        try {
            await AddressHistoryService.saveContact(recipientAddress, saveContactName.trim());
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setShowSaveContactPrompt(false);
            setSaveContactName('');
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('send.failedSaveContact'));
        }
    };

    // [F19] handleAgentAuthorization / handleHumanApproval DELETED with the
    // agent-initiated Send path — this screen is first-party only (the owner
    // operating their own wallet, gated by mandatory review + biometric). The
    // agent/human-WalletConnect governance pipeline lives elsewhere; per CLAUDE.md
    // pitfall #13 the first-party carve-out is deliberately NOT routed through it.

    const [txResult, setTxResult] = React.useState<{txHash: string; explorerUrl: string; walletDeployed: boolean} | null>(null);
    // [N3] True when the transfer confirmed on-chain but its Provenance Envelope
    // could not be created yet (createEnvelope threw). The PE is durably queued
    // for reconciliation; the success screen surfaces a "record pending" note so
    // we never present an unqualified clean success for a missing record.
    const [peDeferred, setPeDeferred] = React.useState(false);

    const handleConfirm = async () => {
        // Chunk-J J-4: Idempotent guard. `loading` also disables the step
        // transition at the render layer, but a rapid double-tap can fire
        // two handleConfirm calls before React commits state. Swallow the
        // second call unconditionally.
        if (loading || step === 'processing') {
            return;
        }
        if (!selectedAsset) {
            Alert.alert(t('common.errorTitle'), t('send.noAssetSelected'));
            return;
        }
        const asset = selectedAsset;
        if (!amount || !recipient) {
            Alert.alert(t('common.errorTitle'), t('send.fillAllFields'));
            return;
        }
        // The values Continue checked are the values sent: an edit or paste while the checks were
        // running, or after the review opened, goes back to the form .
        const reviewed = reviewedRef.current;
        if (!reviewed || reviewed.recipient !== recipientAddress || reviewed.amount !== amount
            || reviewed.asset !== asset.symbol || reviewed.chain !== asset.chain || reviewed.chainId !== currentChainId) {
            Alert.alert(t('common.errorTitle'), t('send.reviewAgain'));
            setStep('input');
            return;
        }

        // Chunk-J J-5: Biometric gate on the money path. Previously the
        // only biometric prompt in the send flow was the one the OS shows
        // when WalletLockScreen unlocked the app - a stolen-but-unlocked
        // phone could approve a send with no user-facing confirmation.
        // requireBiometric() uses disableDeviceFallback:true so a device
        // passcode cannot substitute for hardware biometric. The fallback
        // onboarding path is handled inside requireBiometric() itself.
        try {
            return await withBiometricAction(t('send.approveSendBiometric', { amount, symbol: asset.symbol }), async (biometricAction) => {


                setLoading(true);
                setStep('processing');

                try {
                    // 1. Offline Check
                    if (isOffline) {
                        queueTransaction({
                            type: 'send',
                            asset: asset.symbol,
                            amount,
                            recipient: recipientAddress,
                            timestamp: Date.now()
                        });
                        setLoading(false);
                        Alert.alert(t('offline.queuedSuccess'), t('offline.queuedDesc'), [
                            { text: t('common.ok'), onPress: () => navigation.goBack() }
                        ]);
                        return;
                    }

                    // 2. Policy Check
                    if (!policyResult || policyResult.decision === 'block') {
                        Alert.alert(t('policy.blocked'), t('policy.blockedByPolicy'));
                        setLoading(false);
                        setStep('review');
                        return;
                    }

                    // 3. Route to the correct chain service based on selectedChainId.
                    //    Each chain service handles key access (Secure Enclave or BIP-39 seed), signing, and broadcast.
                    let txHash: string;
                    let explorerUrl: string;

                    if (asset.chain === 'Solana') {
                        // ── Solana (SOL native + SPL tokens, e.g. USDC) ──
                        // SolanaTransactionService enforces the SAME money-safety bar
                        // (assertWalletEnabled + biometric-gated ed25519 key) as the EVM
                        // path; the on-screen requireBiometric above already fired.
                        const isNativeSol = asset.symbol === 'SOL' && !asset.tokenAddress;
                        if (isNativeSol) {
                            const solResult = await solanaTransactionService.sendSOL({
                                to: recipientAddress,
                                amount,
                            }, biometricAction);
                            txHash = solResult.txHash;
                            explorerUrl = solResult.explorerUrl;
                        } else {
                            if (!asset.tokenAddress) {
                                throw new Error(t('send.noTokenAddress', { symbol: asset.symbol, chainId: 'solana' }));
                            }
                            const splResult = await solanaTransactionService.sendSPL({
                                to: recipientAddress,
                                amount,
                                mint: asset.tokenAddress,
                                decimals: asset.decimals ?? 6,
                            }, biometricAction);
                            txHash = splResult.txHash;
                            explorerUrl = splResult.explorerUrl;
                        }
                    } else {
                        // ── EVM chains (Base, Arbitrum, Optimism) ──
                        const isNativeAsset = asset.symbol === 'ETH' || (asset.symbol === 'WETH' && !asset.tokenAddress);
                        if (isNativeAsset) {
                            const evmResult = await TransactionService.sendETH({
                                to: recipientAddress,
                                amount: amount,
                                chainId: currentChainId || 8453,
                            }, biometricAction);
                            txHash = evmResult.txHash;
                            explorerUrl = evmResult.explorerUrl;
                        } else {
                            // ERC-20 token transfer - resolve the token address on the
                            // ACTUAL chain being sent on (review #2). For a multi-chain
                            // token the user may have overridden the network, so
                            // asset.tokenAddress (the asset's home-chain address) must
                            // NOT be used unconditionally - that would build transfer()
                            // against the wrong contract on the selected chain. Prefer
                            // the multi-chain config entry for this chain, then the
                            // canonical table, and only fall back to asset.tokenAddress
                            // when the selected chain IS the asset's home chain.
                            const { getTokenAddresses } = await import('../../core/chains/evm/config');
                            const chainId = currentChainId || 8453;
                            const tokenAddr =
                                multiChainInfo?.chains.find((c) => c.chainId === chainId)?.address
                                || getTokenAddresses(chainId)[asset.symbol]
                                || (getChainIdFromAssetChain(asset.chain) === chainId ? asset.tokenAddress : undefined);
                            if (!tokenAddr) {
                                throw new Error(t('send.noTokenAddress', { symbol: asset.symbol, chainId }));
                            }
                            const tokenDecimals = asset.decimals ?? (asset.isStablecoin ? 6 : 18);
                            const evmResult = await TransactionService.sendERC20({
                                to: recipientAddress,
                                amount: amount,
                                tokenAddress: tokenAddr,
                                decimals: tokenDecimals,
                                chainId: currentChainId || 8453,
                            }, biometricAction);
                            txHash = evmResult.txHash;
                            explorerUrl = evmResult.explorerUrl;
                        }
                    }

                    setTxResult({ txHash, explorerUrl, walletDeployed: false });
                    console.log('[Send] ✅ Transaction confirmed:', txHash);

                    // Surface the just-sent tx immediately. The indexer (Alchemy) can
                    // take minutes to return it; without a local row the history is
                    // empty right after sending and a user may think it failed and
                    // re-send (#18). TransactionService already waited for the receipt,
                    // so this is a confirmed transfer.
                    try {
                        const histChain: HistoryChainType =
                            asset.chain === 'Solana' ? 'Solana'
                                : currentChainId === CHAIN_IDS.ARBITRUM ? 'Arbitrum'
                                    : currentChainId === CHAIN_IDS.OPTIMISM ? 'Optimism'
                                        : 'Base';
                        await TransactionHistoryService.addLocalTransaction({
                            hash: txHash,
                            type: 'sent',
                            status: 'confirmed',
                            chain: histChain,
                            from: (asset.chain === 'Solana' ? solanaAddress : address) || '',
                            to: recipientAddress,
                            amount,
                            symbol: asset.symbol,
                            usdValue: getAmountUsd(),
                            timestamp: Date.now(),
                        // Cached under the address the history is READ under (the primary EVM
                        // address), so a Solana send shows up at once too (2026-10-17).
                        }, address || undefined);
                    } catch (histErr) {
                        console.error('[Send] Local history insert failed (non-fatal):', histErr);
                    }

                    // 4. Create Provenance Envelope.
                    // [BUG FIX] PE creation is non-fatal - the on-chain transaction has
                    // already succeeded by this point, and a PE-creation failure
                    // (e.g. KeyManager.getAddress() returning null because the
                    // hardware key wasn't initialized on this device) must NOT roll
                    // back the success UI. Previously, a thrown PE error landed in
                    // the outer catch and showed the user "Transaction Failed: No
                    // wallet initialized" while the funds had actually moved.
                    // [N3] But it must NOT be silently swallowed either: the confirmed
                    // transfer would then have NO provenance record and no retry. On a
                    // throw we durably queue the create params (reconciled on foreground
                    // by retryDeferredEnvelopes) and surface a degraded "record pending"
                    // state instead of an unqualified clean success.
                    const peParams = {
                        actionType: 'send' as const,
                        intentText: `Send ${amount} ${asset.symbol} on ${currentChainInfo?.name ?? asset.chain} to ${recipientAddress}`,
                        assetSymbol: asset.symbol,
                        amount: amount,
                        chainId: currentChainId,
                        counterparty: recipientAddress,
                        riskScore: policyResult.riskScore,
                        riskCategory: policyResult.riskCategory,
                        policyDecision: policyResult.decision,
                        // the confirmed transaction. On Base, Arbitrum and Optimism the relay
                        // re-reads it from the chain and mints the send there; a Solana send
                        // is found by the relay's own Solana scan.
                        txHash,
                    };
                    try {
                        await ProvenanceEnvelopeManager.createEnvelope(peParams, biometricAction);
                    } catch (peErr) {
                        console.error('[Send] PE creation failed (tx confirmed) - deferring for reconciliation:', peErr);
                        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(peParams).catch((qErr) => {
                            console.error('[Send] Failed to queue deferred PE:', qErr);
                        });
                        setPeDeferred(true);
                    }

                    // 5. Record sent address (also non-fatal)
                    try {
                        await AddressHistoryService.recordSend(recipientAddress, getAmountUsd());
                    } catch (recErr) {
                        console.error('[Send] Address history write failed (non-fatal):', recErr);
                    }

                    setStep('success');

                } catch (error: any) {
                    console.error('[Send] ❌ Transaction failed:', error);
                    if (error instanceof InsufficientSolForFeesError) {
                        Alert.alert(t('send.needSolForFeesTitle'), errorDisplayCopy(solFeeMessage(error.neededLamports, error.haveLamports, error.createsTokenAccount)));
                        setStep('review');
                        return;
                    }
                    Alert.alert(
                        t('send.transactionFailed'),
                        errorDisplayCopy(error.message || t('send.transactionFailedFallback')),
                    );
                    setStep('review');
                } finally {
                    setLoading(false);
                }

            }, undefined);
        } catch (authErr) {
            if (authErr instanceof BiometricNotAvailableError) {
                Alert.alert(
                    t('biometric.biometricRequired'),
                    errorDisplayCopy(authErr.message || t('send.enableBiometricToSend')),
                );
            } else if (authErr instanceof BiometricAuthError) {
                // User cancelled or auth failed - no alert needed, just
                // stay on the review screen silently.
            } else {
                Alert.alert(t('send.sendCancelled'), t('send.biometricFailed'));
            }
            return;
        }
};


    if (!selectedAsset) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
                <LinearGradient colors={backgroundGradient} style={StyleSheet.absoluteFill} />
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                    <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('dashboard.send')}</Text>
                    <View style={{ width: BACK_BUTTON_SIZE }} />
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl }}>
                    <Ionicons name="wallet-outline" size={48} color={COLORS.textTertiary} />
                    <Text style={{ color: COLORS.textSecondary, fontSize: 16, marginTop: SPACING.m, textAlign: 'center' }}>{t('send.noAssetsAvailable')}</Text>
                    <TouchableOpacity style={{ marginTop: SPACING.l }} onPress={() => navigation.goBack()}>
                        <Text style={{ color: COLORS.primary, fontSize: 16 }}>{t('common.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
            >
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('dashboard.send')} {selectedAsset.symbol}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {step === 'input' && (
                    <>
                        <View style={styles.inputGroup}>
                            <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('send.selectAsset')}</Text>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.assetSelector}>
                                {sendableAssets.map((asset) => {
                                    const isSelected = selectedAsset.symbol === asset.symbol && selectedAsset.chain === asset.chain;
                                    const label = assets.filter(a => a.symbol === asset.symbol).length > 1
                                        ? `${asset.symbol} (${asset.chain})`
                                        : asset.symbol;
                                    return (
                                        <TouchableOpacity
                                            key={`${asset.symbol}-${asset.chain}`}
                                            style={[
                                                styles.assetOption,
                                                { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border },
                                                isSelected && { borderColor: themeColors.primary, backgroundColor: themeColors.primaryMuted }
                                            ]}
                                            onPress={() => setSelectedAsset(asset)}
                                        >
                                            <Text style={[
                                                styles.assetOptionText,
                                                { color: themeColors.chipText },
                                                isSelected && { color: themeColors.primary }
                                            ]}>{label}</Text>
                                            <Text style={[styles.assetOptionBalance, { color: themeColors.textSecondary }]}>{asset.balance}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>

                        <View style={styles.inputGroup}>
                            <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('swap.to')}</Text>

                            {/* Favorites chips */}
                            {favorites.length > 0 && (
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    style={styles.favoritesScroll}
                                    contentContainerStyle={styles.favoritesContainer}
                                >
                                    {favorites.map((contact) => (
                                        <TouchableOpacity
                                            key={contact.id}
                                            style={[
                                                styles.favoriteChip,
                                                { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border },
                                                selectedContactName === contact.name && { borderColor: themeColors.primary, backgroundColor: themeColors.primaryMuted }
                                            ]}
                                            onPress={() => handleSelectContact(contact)}
                                        >
                                            <Ionicons name="star" size={14} color={themeColors.warning} />
                                            <Text style={[
                                                styles.favoriteChipText,
                                                { color: themeColors.chipText },
                                                selectedContactName === contact.name && { color: themeColors.primary }
                                            ]}>
                                                {contact.name}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </ScrollView>
                            )}

                            {/* Address Book and Recent buttons */}
                            <View style={styles.contactButtonsRow}>
                                <TouchableOpacity
                                    style={[styles.contactButton, { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border }]}
                                    onPress={handleOpenAddressBook}
                                >
                                    <Ionicons name="book-outline" size={16} color={themeColors.accent} />
                                    <Text style={[styles.contactButtonText, { color: themeColors.accent }]}>{t('send.addressBook')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.contactButton, { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border }]}
                                    onPress={() => setShowRecentDropdown(!showRecentDropdown)}
                                >
                                    <Ionicons name="time-outline" size={16} color={themeColors.accent} />
                                    <Text style={[styles.contactButtonText, { color: themeColors.accent }]}>{t('send.recent')}</Text>
                                    <Ionicons
                                        name={showRecentDropdown ? 'chevron-up' : 'chevron-down'}
                                        size={14}
                                        color={themeColors.accent}
                                    />
                                </TouchableOpacity>
                            </View>

                            {/* Recent addresses dropdown */}
                            {showRecentDropdown && recentAddresses.length > 0 && (
                                <View style={styles.recentDropdown}>
                                    {recentAddresses.map((addr) => (
                                        <TouchableOpacity
                                            key={addr.id}
                                            style={styles.recentItem}
                                            onPress={() => handleSelectContact(addr)}
                                        >
                                            <View style={styles.recentItemLeft}>
                                                <Text style={styles.recentItemName}>
                                                    {addr.name || `${addr.address.slice(0, 8)}...${addr.address.slice(-6)}`}
                                                </Text>
                                                <Text style={styles.recentItemMeta}>
                                                    {addr.chain && AddressHistoryService.getChainShortName(addr.chain)}
                                                    {addr.lastSentAt && ` · ${AddressHistoryService.formatRelativeTime(addr.lastSentAt)}`}
                                                </Text>
                                            </View>
                                            <Ionicons name="arrow-forward" size={16} color={COLORS.textSecondary} />
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}

                            {/* Address input with selected contact display */}
                            {selectedContactName ? (
                                <View style={styles.selectedContactContainer}>
                                    <View style={styles.selectedContactInfo}>
                                        <Text style={styles.selectedContactName}>{selectedContactName}</Text>
                                        <Text style={styles.selectedContactAddress}>
                                            {recipientAddress.slice(0, 8)}...{recipientAddress.slice(-6)}
                                        </Text>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.clearContactButton}
                                        onPress={() => {
                                            setRecipient('');
                                            setSelectedContactName('');
                                        }}
                                    >
                                        <Ionicons name="close-circle" size={20} color={COLORS.textSecondary} />
                                    </TouchableOpacity>
                                </View>
                            ) : (
                                <View style={styles.addressInputRow}>
                                    <TextInput
                                        style={[
                                            styles.input,
                                            styles.addressInput,
                                            addressError && styles.inputError
                                        ]}
                                        placeholder="0x..."
                                        placeholderTextColor={COLORS.textSecondary}
                                        value={recipient}
                                        onChangeText={(text) => {
                                            setRecipient(text);
                                            setSelectedContactName('');
                                        }}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                    <TouchableOpacity
                                        style={styles.pasteButton}
                                        onPress={handlePasteFromClipboard}
                                    >
                                        <Ionicons name="clipboard-outline" size={18} color={COLORS.primary} />
                                        <Text style={styles.pasteButtonText}>{t('send.paste')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}

                            {/* Contact suggestions while typing */}
                            {contactSuggestions.length > 0 && !selectedContactName && (
                                <View style={styles.suggestionsContainer}>
                                    {contactSuggestions.map((contact) => (
                                        <TouchableOpacity
                                            key={contact.id}
                                            style={styles.suggestionItem}
                                            onPress={() => handleSelectContact(contact)}
                                        >
                                            <Ionicons name="person-circle-outline" size={20} color={COLORS.primary} />
                                            <Text style={styles.suggestionName}>{contact.name}</Text>
                                            <Text style={styles.suggestionAddress}>
                                                {contact.address.slice(0, 6)}...{contact.address.slice(-4)}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}

                            {addressError && (
                                <View style={styles.addressErrorContainer}>
                                    <Ionicons name="warning" size={16} color={COLORS.warning} />
                                    <Text style={styles.addressErrorText}>{addressError}</Text>
                                </View>
                            )}
                            {!addressError && detectedAddressChain && detectedAddressChain !== 'unknown' && !selectedContactName && (
                                <View style={styles.addressDetectedContainer}>
                                    <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
                                    <Text style={styles.addressDetectedText}>
                                        {t('send.addressDetected', { chain: getChainDisplayName(detectedAddressChain) })}
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Chain selector for multi-chain tokens */}
                        {isMultiChain && availableChains.length > 1 && (
                            <View style={styles.inputGroup}>
                                <Text style={styles.label}>{t('send.sendOnNetwork')}</Text>
                                <Text style={styles.chainSelectorHint}>
                                    {t('send.multiNetworkHint', { symbol: selectedAsset.symbol })}
                                </Text>
                                <View style={styles.chainGrid}>
                                    {availableChains.map((chainOption, index) => {
                                        const chainInfo = CHAINS[chainOption.chainId];
                                        const isSelected = selectedChainId === chainOption.chainId;
                                        const isRecommended = chainOption.isPreferred;
                                        const isCheapest = !isRecommended && index === 0;

                                        return (
                                            <TouchableOpacity
                                                key={chainOption.chainId}
                                                style={[
                                                    styles.chainGridItem,
                                                    isSelected && styles.chainGridItemSelected
                                                ]}
                                                onPress={() => setSelectedChainId(chainOption.chainId)}
                                            >
                                                <View style={styles.chainGridHeader}>
                                                    <Text style={[
                                                        styles.chainGridName,
                                                        isSelected && styles.chainGridNameSelected
                                                    ]}>
                                                        {chainInfo?.shortName ?? t('common.unknown')}
                                                    </Text>
                                                    {isRecommended && (
                                                        <View style={styles.recommendedBadge}>
                                                            <Text style={styles.recommendedBadgeText}>{t('send.best')}</Text>
                                                        </View>
                                                    )}
                                                    {isCheapest && (
                                                        <View style={styles.cheapestBadge}>
                                                            <Text style={styles.cheapestBadgeText}>{t('send.cheap')}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                                <Text style={[
                                                    styles.chainGridFee,
                                                    isSelected && styles.chainGridFeeSelected
                                                ]}>
                                                    {formatFeeEstimate(chainOption.feeEstimateUsd)}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </View>
                        )}

                        <View style={styles.inputGroup}>
                            <Text style={styles.label}>{t('send.amountWithSymbol', { symbol: selectedAsset.symbol })}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="0.00"
                                placeholderTextColor={COLORS.textSecondary}
                                keyboardType="numeric"
                                value={amount}
                                onChangeText={setAmount}
                            />
                            {amount && parseFloat(amount) > 0 && (
                                <Text style={styles.usdValue}>
                                    ≈ {formatUsd(getAmountUsdOrNull())} USD
                                </Text>
                            )}
                        </View>

                        <TouchableOpacity
                            style={[styles.buttonPrimary, loading && styles.buttonDisabled]}
                            onPress={handleContinue}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color="white" />
                            ) : (
                                <Text style={styles.buttonText}>{t('common.continue')}</Text>
                            )}
                        </TouchableOpacity>
                    </>
                )}

                {step === 'warnings' && warnings.length > 0 && (
                    <WarningScreen
                        warning={warnings[currentWarningIndex]}
                        onGoBack={handleWarningGoBack}
                        onProceed={warnings[currentWarningIndex].canProceed ? handleWarningProceed : undefined}
                    />
                )}

                {step === 'review' && policyResult && (
                    <ScrollView style={styles.reviewScroll} showsVerticalScrollIndicator={false}>
                        <View style={styles.reviewContainer}>
                            {/* Plain English Transaction Summary */}
                            <View style={styles.summaryCard}>
                                <Text style={styles.summaryTitle}>{t('send.transactionSummary')}</Text>

                                <View style={styles.summaryRow}>
                                    <Text style={styles.summaryLabel}>{t('send.youreSending')}</Text>
                                    <View style={styles.summaryValueContainer}>
                                        <Text style={styles.summaryValueLarge}>{amount} {selectedAsset.symbol}</Text>
                                        <Text style={styles.summaryValueUsd}>
                                            ≈ {formatUsd(getAmountUsdOrNull())}
                                        </Text>
                                    </View>
                                </View>

                                <View style={styles.summaryDivider} />

                                <View style={styles.summaryRow}>
                                    <Text style={styles.summaryLabel}>{t('swap.to')}</Text>
                                    <View style={styles.summaryValueContainer}>
                                        {recipientDisplay?.isContact ? (
                                            <>
                                                <Text style={styles.summaryValueLarge}>{recipientDisplay.display}</Text>
                                                <Text style={styles.summaryValueSmall}>{formatAddress(recipientAddress)}</Text>
                                            </>
                                        ) : (
                                            <>
                                                <Text style={styles.summaryValueLarge}>{formatAddress(recipientAddress)}</Text>
                                                {recipientDisplay?.isNew && (
                                                    <View style={styles.newAddressBadge}>
                                                        <Ionicons name="alert-circle" size={14} color={COLORS.warning} />
                                                        <Text style={styles.newAddressText}>{t('send.newAddress')}</Text>
                                                    </View>
                                                )}
                                            </>
                                        )}
                                    </View>
                                </View>

                                {/* A truncated "0x1234...5678" display is exactly what an
                                    address-poisoning lookalike is crafted to pass. The full,
                                    untruncated address must be visible here - the last point
                                    before biometric signing - so it is actually verifiable. */}
                                <View style={styles.fullAddressRow}>
                                    <Text style={styles.fullAddressLabel}>{t('send.fullAddress')}</Text>
                                    <Text style={styles.fullAddressValue} selectable>{recipientAddress}</Text>
                                    <Text style={styles.fullAddressHint}>{t('send.fullAddressHint')}</Text>
                                </View>

                                <View style={styles.summaryDivider} />

                                <View style={styles.summaryRow}>
                                    <Text style={styles.summaryLabel}>{t('provenanceDashboard.network')}</Text>
                                    <View style={styles.summaryValueContainer}>
                                        <Text style={styles.summaryValueSmall}>
                                            {currentChainInfo?.name ?? selectedAsset.chain}
                                        </Text>
                                    </View>
                                </View>

                                <View style={styles.summaryDivider} />

                                <View style={styles.summaryRow}>
                                    <Text style={styles.summaryLabel}>{t('send.networkFee')}</Text>
                                    <View style={styles.summaryValueContainer}>
                                        <Text style={styles.summaryValueSmall}>
                                            {formatFeeEstimate(currentFeeEstimate)}
                                        </Text>
                                    </View>
                                </View>

                                <View style={styles.summaryDivider} />

                                <View style={styles.summaryRow}>
                                    <Text style={styles.summaryLabelBold}>{t('send.total')}</Text>
                                    <View style={styles.summaryValueContainer}>
                                        <Text style={styles.summaryValueTotal}>
                                            {formatUsd(getAmountUsdOrNull() === null ? null : (getAmountUsdOrNull() as number) + currentFeeEstimate)}
                                        </Text>
                                    </View>
                                </View>
                            </View>

                            {/* Risk indicator - subtle for low risk */}
                            {policyResult.riskCategory !== 'low' && (
                                <View style={styles.riskCard}>
                                    <View style={styles.riskHeader}>
                                        <Ionicons
                                            name="information-circle"
                                            size={20}
                                            color={policyResult.riskCategory === 'high' ? COLORS.warning : COLORS.textSecondary}
                                        />
                                        <Text style={[styles.riskText, { color: policyResult.riskCategory === 'high' ? COLORS.warning : COLORS.textSecondary }]}>
                                            {policyResult.riskCategory === 'high' ? t('send.elevatedRisk') : t('send.note')}
                                        </Text>
                                    </View>
                                    {policyResult.reasons.map((reason: string, idx: number) => (
                                        <Text key={idx} style={styles.reasonText}>• {reason}</Text>
                                    ))}
                                </View>
                            )}

                            {/* Balance after transaction */}
                            <View style={styles.balanceAfterCard}>
                                <Ionicons name="wallet-outline" size={18} color={COLORS.textSecondary} />
                                <Text style={styles.balanceAfterText}>{t('send.balanceAfter', { amount: (parseFloat(selectedAsset.balance) - parseFloat(amount || '0')).toFixed(4), symbol: selectedAsset.symbol })}</Text>
                            </View>

                            {policyResult.decision === 'block' ? (
                                <View style={styles.blockedContainer}>
                                    <Text style={styles.blockedText}>{t('send.transactionBlockedByPolicy')}</Text>
                                    <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep('input')}>
                                        <Text style={styles.buttonTextSecondary}>{t('send.editTransaction')}</Text>
                                    </TouchableOpacity>
                                </View>
                            ) : (
                                <View style={styles.reviewButtons}>
                                    <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep('input')}>
                                        <Text style={styles.buttonTextSecondary}>{t('send.edit')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.buttonPrimaryFlex} onPress={handleConfirm}>
                                        <Ionicons name="finger-print" size={20} color="white" />
                                        <Text style={styles.buttonText}>{t('send.confirmSign')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    </ScrollView>
                )}

                {/* [F19] agent_auth / cooling / understanding step renders were
                    removed with the agent-initiated Send path. */}

                {step === 'blocked' && (
                    <View style={styles.blockedFullContainer}>
                        <Ionicons name="shield" size={80} color={COLORS.error} />
                        <Text style={styles.blockedFullTitle}>{t('send.transactionBlocked')}</Text>
                        <Text style={styles.blockedFullSubtitle}>
                            {t('send.transactionBlockedSafety')}
                        </Text>
                        {blockReason && (
                            <View style={styles.blockReasonBox}>
                                <Text style={styles.blockReasonTitle}>{t('send.reason')}</Text>
                                <Text style={styles.blockReasonText}>{blockReason}</Text>
                            </View>
                        )}
                        <TouchableOpacity style={styles.buttonSecondary} onPress={() => navigation.goBack()}>
                            <Text style={styles.buttonTextSecondary}>{t('common.goBack')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {step === 'processing' && (
                    <View style={styles.center}>
                        <ActivityIndicator size="large" color={COLORS.primary} />
                        <Text style={styles.statusText}>{t('send.signingTransaction')}</Text>
                        <Text style={styles.subText}>{t('send.signingSecurely')}</Text>
                    </View>
                )}

                {step === 'success' && (
                    <View style={styles.center}>
                        <Ionicons name="checkmark-circle" size={80} color={COLORS.success} />
                        <Text style={styles.successTitle}>{t('send.transactionSent')}</Text>
                        <Text style={styles.successAmount}>
                            {amount} {selectedAsset.symbol} → {recipientDisplay?.display || formatAddress(recipientAddress)}
                        </Text>
                        <Text style={styles.subText}>
                            {formatUsd(getAmountUsdOrNull())}
                        </Text>
                        {/* [N3] Degraded state: the transfer confirmed but its
                            provenance record is still pending reconciliation. */}
                        {peDeferred && (
                            <View style={styles.peDeferredNote}>
                                <Ionicons name="time-outline" size={16} color={COLORS.warning} />
                                <Text style={styles.peDeferredText}>{t('send.peDeferredNote')}</Text>
                            </View>
                        )}

                        {/* Save contact prompt for new addresses */}
                        {recipientDisplay?.isNew && !showSaveContactPrompt && (
                            <TouchableOpacity
                                style={styles.saveContactPromptButton}
                                onPress={() => setShowSaveContactPrompt(true)}
                            >
                                <Ionicons name="person-add-outline" size={20} color={COLORS.primary} />
                                <Text style={styles.saveContactPromptText}>{t('send.saveThisAddress')}</Text>
                            </TouchableOpacity>
                        )}

                        {showSaveContactPrompt && (
                            <View style={styles.saveContactForm}>
                                <Text style={styles.saveContactLabel}>{t('send.nameThisContact')}</Text>
                                <TextInput
                                    style={styles.saveContactInput}
                                    placeholder={t('send.contactPlaceholder')}
                                    placeholderTextColor={COLORS.textSecondary}
                                    value={saveContactName}
                                    onChangeText={setSaveContactName}
                                    autoFocus
                                />
                                <View style={styles.saveContactButtons}>
                                    <TouchableOpacity
                                        style={styles.saveContactSkip}
                                        onPress={() => {
                                            setShowSaveContactPrompt(false);
                                            setSaveContactName('');
                                        }}
                                    >
                                        <Text style={styles.saveContactSkipText}>{t('send.skip')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.saveContactSave}
                                        onPress={handleSaveNewContact}
                                    >
                                        <Ionicons name="checkmark" size={18} color="white" />
                                        <Text style={styles.saveContactSaveText}>{t('common.save')}</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        )}

                        <TouchableOpacity
                            style={[styles.buttonPrimary, { marginTop: SPACING.xl }]}
                            onPress={() => navigation.goBack()}
                        >
                            <Text style={styles.buttonText}>{t('common.done')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    content: {
        flexGrow: 1,
        padding: SPACING.l,
        paddingBottom: SPACING.xxl,
    },
    inputGroup: {
        marginBottom: SPACING.xl,
    },
    label: {
        color: '#8B929E',
        marginBottom: SPACING.s,
        fontSize: 14,
        letterSpacing: 0.3,
    },
    input: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        padding: SPACING.m,
        borderRadius: 14,
        color: COLORS.text,
        fontSize: 18,
        fontWeight: '600',
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    usdValue: {
        color: '#8B929E',
        fontSize: 14,
        marginTop: SPACING.xs,
        marginLeft: SPACING.s,
    },
    buttonPrimary: {
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        marginTop: SPACING.m,
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 8,
    },
    buttonPrimaryFlex: {
        flex: 1,
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: SPACING.s,
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 8,
    },
    buttonDisabled: {
        opacity: 0.5,
        shadowOpacity: 0,
    },
    buttonSecondary: {
        backgroundColor: 'transparent',
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.l,
        borderRadius: 28,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    buttonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: 'bold',
    },
    buttonTextSecondary: {
        color: COLORS.chromeMuted,
        fontSize: 16,
    },
    reviewScroll: {
        flex: 1,
    },
    reviewContainer: {
        flex: 1,
    },
    // Summary card styles
    summaryCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 18,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 6,
    },
    summaryTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.m,
    },
    summaryRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        paddingVertical: SPACING.s,
    },
    summaryLabel: {
        color: '#8B929E',
        fontSize: 14,
    },
    summaryLabelBold: {
        color: COLORS.chromeMuted,
        fontSize: 14,
        fontWeight: 'bold',
    },
    summaryValueContainer: {
        alignItems: 'flex-end',
        maxWidth: '60%',
    },
    summaryValueLarge: {
        color: COLORS.text,
        fontSize: 18,
        fontWeight: 'bold',
    },
    summaryValueSmall: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    summaryValueUsd: {
        color: '#8B929E',
        fontSize: 14,
        marginTop: 2,
    },
    summaryValueTotal: {
        color: '#4A8EE8',
        fontSize: 20,
        fontWeight: 'bold',
    },
    summaryDivider: {
        height: 1,
        backgroundColor: 'rgba(200,205,214,0.08)',
        marginVertical: SPACING.xs,
    },
    newAddressBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
        backgroundColor: 'rgba(255,179,0,0.15)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
    },
    newAddressText: {
        color: '#E8A838',
        fontSize: 12,
        fontWeight: '500',
    },
    fullAddressRow: {
        paddingVertical: SPACING.s,
    },
    fullAddressLabel: {
        color: '#8B929E',
        fontSize: 12,
    },
    fullAddressValue: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
        marginTop: 4,
        letterSpacing: 0.3,
    },
    fullAddressHint: {
        color: '#8B929E',
        fontSize: 11,
        marginTop: 4,
    },
    balanceAfterCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    balanceAfterText: {
        color: '#8B929E',
        fontSize: 13,
    },
    reviewButtons: {
        flexDirection: 'row',
        gap: SPACING.m,
        marginTop: SPACING.m,
    },
    riskCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    riskHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    riskText: {
        fontSize: 14,
        fontWeight: '600',
    },
    reasonText: {
        color: '#8B929E',
        fontSize: 13,
        marginBottom: SPACING.xs,
        marginLeft: SPACING.l,
    },
    blockedContainer: {
        alignItems: 'center',
    },
    blockedText: {
        color: COLORS.error,
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: SPACING.m,
    },
    center: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    statusText: {
        marginTop: SPACING.l,
        fontSize: 18,
        color: COLORS.chromeMuted,
        fontWeight: '600',
    },
    subText: {
        marginTop: SPACING.s,
        color: '#8B929E',
    },
    successTitle: {
        marginTop: SPACING.l,
        fontSize: 24,
        fontWeight: 'bold',
        color: '#4CC38A',
    },
    successAmount: {
        marginTop: SPACING.s,
        fontSize: 16,
        color: COLORS.text,
    },
    assetSelector: {
        marginBottom: SPACING.s,
    },
    assetOption: {
        padding: SPACING.m,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        backgroundColor: 'rgba(18,21,26,0.70)',
        marginRight: SPACING.s,
        minWidth: 100,
    },
    assetOptionSelected: {
        borderColor: '#4A8EE8',
        backgroundColor: 'rgba(74,142,232,0.15)',
    },
    assetOptionText: {
        color: '#8B929E',
        fontWeight: 'bold',
        marginBottom: 4,
    },
    assetOptionTextSelected: {
        color: '#4A8EE8',
    },
    assetOptionBalance: {
        color: COLORS.chromeMuted,
        fontSize: 12,
    },
    // Address validation styles
    inputError: {
        borderColor: '#E8A838',
    },
    addressErrorContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.s,
        backgroundColor: 'rgba(255,179,0,0.12)',
        padding: SPACING.s,
        borderRadius: BORDER_RADIUS.s,
    },
    addressErrorText: {
        color: '#E8A838',
        fontSize: 13,
        flex: 1,
    },
    addressDetectedContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.s,
    },
    addressDetectedText: {
        color: '#4CC38A',
        fontSize: 13,
    },
    // Chain selector styles - Grid layout
    chainSelectorHint: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: SPACING.xs,
        marginBottom: SPACING.s,
    },
    chainGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.s,
    },
    chainGridItem: {
        width: '31%',
        minWidth: 95,
        padding: SPACING.s,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
    },
    chainGridItemSelected: {
        borderColor: '#4A8EE8',
        backgroundColor: 'rgba(74,142,232,0.15)',
        borderWidth: 2,
    },
    chainGridHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        marginBottom: 2,
    },
    chainGridName: {
        color: '#8B929E',
        fontWeight: 'bold',
        fontSize: 13,
    },
    chainGridNameSelected: {
        color: '#4A8EE8',
    },
    chainGridFee: {
        color: '#8B929E',
        fontSize: 11,
    },
    chainGridFeeSelected: {
        color: '#6BA3F0',
    },
    cheapestBadge: {
        backgroundColor: 'rgba(0,230,118,0.15)',
        paddingHorizontal: SPACING.xs,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
    },
    cheapestBadgeText: {
        color: '#4CC38A',
        fontSize: 10,
        fontWeight: 'bold',
    },
    recommendedBadge: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingHorizontal: SPACING.xs,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
    },
    recommendedBadgeText: {
        color: '#4A8EE8',
        fontSize: 10,
        fontWeight: 'bold',
    },
    // Agent Authorization styles
    agentAuthContainer: {
        flex: 1,
    },
    agentBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,179,0,0.12)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: '#E8A838',
        gap: SPACING.s,
    },
    agentBannerText: {
        color: '#E8A838',
        fontSize: 16,
        fontWeight: 'bold',
    },
    agentBannerApproved: {
        backgroundColor: 'rgba(0,230,118,0.12)',
        borderColor: '#4CC38A',
    },
    agentBannerSubtext: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    agentRequestCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 18,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 6,
    },
    agentRequestTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.m,
    },
    agentRequestRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: SPACING.s,
    },
    agentRequestLabel: {
        color: '#8B929E',
        fontSize: 14,
    },
    agentRequestValue: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '600',
        maxWidth: '60%',
    },
    reasonCodesBox: {
        marginTop: SPACING.m,
        paddingTop: SPACING.m,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    reasonCodesTitle: {
        color: '#E8A838',
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: SPACING.s,
    },
    reasonCodeText: {
        color: '#8B929E',
        fontSize: 13,
        marginBottom: 4,
    },
    agentButtonRow: {
        flexDirection: 'row',
        gap: SPACING.m,
    },
    agentButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.m,
        borderRadius: 28,
        gap: SPACING.s,
    },
    agentButtonDeny: {
        backgroundColor: 'rgba(255,71,87,0.12)',
        borderWidth: 1,
        borderColor: COLORS.error,
    },
    agentButtonApprove: {
        backgroundColor: '#4A8EE8',
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 10,
        elevation: 6,
    },
    agentButtonDenyText: {
        color: COLORS.error,
        fontSize: 16,
        fontWeight: 'bold',
    },
    agentButtonApproveText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
    // Blocked screen styles
    blockedFullContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.l,
    },
    blockedFullTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.error,
        marginTop: SPACING.l,
    },
    blockedFullSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.l,
    },
    blockReasonBox: {
        backgroundColor: 'rgba(255,71,87,0.10)',
        padding: SPACING.m,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: COLORS.error,
        marginBottom: SPACING.l,
        width: '100%',
    },
    blockReasonTitle: {
        color: COLORS.error,
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: SPACING.xs,
    },
    blockReasonText: {
        color: COLORS.chromeMuted,
        fontSize: 14,
    },
    agentSuccessText: {
        color: '#6BA3F0',
        fontSize: 12,
        marginTop: SPACING.m,
    },
    // [N3] "record pending" degraded note on the success screen
    peDeferredNote: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
        paddingHorizontal: SPACING.m,
    },
    peDeferredText: {
        color: COLORS.warning,
        fontSize: 12,
        flexShrink: 1,
    },
    // Contact picker styles
    favoritesScroll: {
        marginBottom: SPACING.s,
    },
    favoritesContainer: {
        gap: SPACING.s,
        paddingRight: SPACING.m,
    },
    favoriteChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        backgroundColor: 'rgba(18,21,26,0.70)',
        paddingVertical: SPACING.xs,
        paddingHorizontal: SPACING.m,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    favoriteChipSelected: {
        borderColor: '#4A8EE8',
        backgroundColor: 'rgba(74,142,232,0.15)',
    },
    favoriteChipText: {
        color: COLORS.chromeMuted,
        fontSize: 14,
        fontWeight: '500',
    },
    favoriteChipTextSelected: {
        color: '#4A8EE8',
    },
    contactButtonsRow: {
        flexDirection: 'row',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    contactButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        backgroundColor: 'rgba(18,21,26,0.70)',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    contactButtonText: {
        color: '#4A8EE8',
        fontSize: 13,
        fontWeight: '500',
    },
    recentDropdown: {
        backgroundColor: 'rgba(18,21,26,0.90)',
        borderRadius: 14,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        overflow: 'hidden',
    },
    recentItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    recentItemLeft: {
        flex: 1,
    },
    recentItemName: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
    },
    recentItemMeta: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    selectedContactContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'rgba(74,142,232,0.15)',
        padding: SPACING.m,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#4A8EE8',
    },
    selectedContactInfo: {
        flex: 1,
    },
    selectedContactName: {
        color: '#4A8EE8',
        fontSize: 16,
        fontWeight: 'bold',
    },
    selectedContactAddress: {
        color: '#8B929E',
        fontSize: 12,
        fontFamily: 'monospace',
        marginTop: 2,
    },
    clearContactButton: {
        padding: SPACING.xs,
    },
    suggestionsContainer: {
        backgroundColor: 'rgba(18,21,26,0.90)',
        borderRadius: 14,
        marginTop: SPACING.xs,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        overflow: 'hidden',
    },
    suggestionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        padding: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    suggestionName: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
    },
    suggestionAddress: {
        color: '#8B929E',
        fontSize: 12,
        fontFamily: 'monospace',
        marginLeft: 'auto',
    },
    // Save contact prompt styles
    saveContactPromptButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: 16,
        marginTop: SPACING.l,
    },
    saveContactPromptText: {
        color: '#4A8EE8',
        fontSize: 14,
        fontWeight: '500',
    },
    saveContactForm: {
        width: '100%',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginTop: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    saveContactLabel: {
        color: '#8B929E',
        fontSize: 14,
        marginBottom: SPACING.s,
    },
    saveContactInput: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        padding: SPACING.m,
        borderRadius: 14,
        color: COLORS.text,
        fontSize: 16,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    saveContactButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: SPACING.m,
        marginTop: SPACING.m,
    },
    saveContactSkip: {
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
    },
    saveContactSkipText: {
        color: '#8B929E',
        fontSize: 14,
    },
    saveContactSave: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
        borderRadius: 28,
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 4,
    },
    saveContactSaveText: {
        color: 'white',
        fontSize: 14,
        fontWeight: '600',
    },
    // Address input with paste button
    addressInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    addressInput: {
        flex: 1,
    },
    pasteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        backgroundColor: 'rgba(18,21,26,0.60)',
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.m,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#4A8EE8',
    },
    pasteButtonText: {
        color: '#4A8EE8',
        fontSize: 14,
        fontWeight: '600',
    },
});

export default SendScreen;
