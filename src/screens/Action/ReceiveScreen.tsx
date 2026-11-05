/**
 * ReceiveScreen - Multi-chain receive addresses + QR codes
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Share,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import WalletCreationService, { type StoredWalletState } from '../../core/wallet/WalletCreationService';

type ChainKey = 'evm' | 'solana';

const CHAIN_CONFIG: Record<ChainKey, {
    label: string;
    badge: string;
    color: string;
    noteKey: string;
}> = {
    evm: {
        label: 'EVM',
        badge: 'Base · Arbitrum · Optimism',
        color: '#0052FF',
        noteKey: 'receiveScreen.evmNote',
    },
    solana: {
        label: 'Solana',
        badge: 'Solana',
        color: '#14F195',
        noteKey: 'receiveScreen.solanaNote',
    },
};

const ReceiveScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    const [copied, setCopied] = useState(false);
    const [selectedChain, setSelectedChain] = useState<ChainKey>('evm');
    const [walletState, setWalletState] = useState<StoredWalletState | null>(null);

    const [addressError, setAddressError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const state = await WalletCreationService.getInstance().getStoredWallet();
                setAddressError(null);
                if (mounted) setWalletState(state);
            } catch (err) {
                console.warn('[ReceiveScreen] Failed to load stored wallet:', err);
                if (mounted) setAddressError(t('receiveScreen.errorLoadAddresses'));
            }
        })();
        return () => {
            mounted = false;
        };
    }, []);

    const solanaAvailable = !!walletState?.solanaAddress;

    const currentAddress = useMemo(() => {
        if (!walletState) return '';
        return (selectedChain === 'solana' ? walletState.solanaAddress : walletState.walletAddress) || '';
    }, [walletState, selectedChain]);

    /**
     * Chunk-J J-17: Encode the QR code using the standard URI scheme
     * for each chain. This lets any compliant wallet auto-detect the
     * chain when scanning:
     *  - EVM    → EIP-681 `ethereum:<address>` (no chain suffix - most
     *    wallets auto-detect)
     *  - Solana → Solana Pay `solana:<address>`
     *
     * The copy / share actions still use the bare address because
     * paste-targets don't always parse URIs.
     */
    const qrValue = useMemo(() => {
        if (!currentAddress) return '';
        return selectedChain === 'solana' ? `solana:${currentAddress}` : `ethereum:${currentAddress}`;
    }, [currentAddress, selectedChain]);

    const handleCopy = async () => {
        if (!currentAddress) return;
        await Clipboard.setStringAsync(currentAddress);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
    };

    const handleShare = async () => {
        if (!currentAddress) return;
        await Share.share({
            message: t('receiveScreen.shareMessage', { chain: CHAIN_CONFIG[selectedChain].label, address: currentAddress }),
        });
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()}>
                    <Ionicons name="close" size={24} color={themeColors.textPrimary} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('receiveScreen.headerTitle')}</Text>
                <View style={{ width: 24 }} />
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                {/* Chain selector: shown once the Solana address is available
                    (both are derived from the same seed). Falls back to the
                    single EVM badge for wallets not yet carrying a Solana
                    address. */}
                {solanaAvailable ? (
                    <View style={styles.selectorRow}>
                        {(['evm', 'solana'] as ChainKey[]).map((key) => {
                            const active = selectedChain === key;
                            return (
                                <TouchableOpacity
                                    key={key}
                                    style={[
                                        styles.chainPill,
                                        active && { borderColor: CHAIN_CONFIG[key].color, backgroundColor: 'rgba(18,21,26,0.85)' },
                                    ]}
                                    onPress={() => { setSelectedChain(key); setCopied(false); }}
                                    activeOpacity={0.8}
                                >
                                    <View style={[styles.chainDot, { backgroundColor: CHAIN_CONFIG[key].color }]} />
                                    <Text style={[styles.chainPillText, { color: active ? themeColors.textPrimary : themeColors.textSecondary }]}>
                                        {CHAIN_CONFIG[key].label}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                ) : null}

                <View style={styles.chainBadge}>
                    <View style={[styles.chainDot, { backgroundColor: CHAIN_CONFIG[selectedChain].color }]} />
                    <Text style={[styles.chainText, { color: themeColors.textSecondary }]}>
                        {CHAIN_CONFIG[selectedChain].badge}
                    </Text>
                </View>

                <View style={styles.qrContainer}>
                    <View style={styles.qrCard}>
                        {qrValue ? (
                            <QRCode
                                value={qrValue}
                                size={200}
                                backgroundColor="white"
                                color="#111827"
                            />
                        ) : (
                            <View style={styles.qrPlaceholder}>
                                <Ionicons name="qr-code-outline" size={80} color={themeColors.textMuted} />
                                <Text style={{ color: themeColors.textMuted, marginTop: 8 }}>{t('receiveScreen.noAddress')}</Text>
                            </View>
                        )}
                    </View>
                </View>

                <TouchableOpacity style={styles.addressCard} onPress={handleCopy} activeOpacity={0.7}>
                    <Text style={[styles.addressLabel, { color: themeColors.textSecondary }]}>
                        {t('receiveScreen.yourAddress', { chain: CHAIN_CONFIG[selectedChain].label })}
                    </Text>
                    <Text style={[styles.addressFull, { color: themeColors.textPrimary }]} selectable>
                        {currentAddress || t('receiveScreen.notAvailable')}
                    </Text>
                    <View style={styles.copyRow}>
                        <Ionicons
                            name={copied ? 'checkmark-circle' : 'copy-outline'}
                            size={16}
                            color={copied ? (COLORS.success || '#4CC38A') : themeColors.primary}
                        />
                        <Text style={[styles.copyText, { color: copied ? (COLORS.success || '#4CC38A') : themeColors.primary }]}>
                            {copied ? t('receiveScreen.copied') : t('receiveScreen.tapToCopy')}
                        </Text>
                    </View>
                </TouchableOpacity>

                {addressError ? (
                    <View style={[styles.infoCard, { borderColor: 'rgba(255,80,80,0.35)' }]}>
                        <Ionicons name="warning-outline" size={18} color={COLORS.error} />
                        <Text style={[styles.infoText, { color: themeColors.textSecondary }]}>
                            {addressError}
                        </Text>
                    </View>
                ) : null}

                <View style={styles.infoCard}>
                    <Ionicons name="information-circle-outline" size={18} color={themeColors.primary} />
                    <Text style={[styles.infoText, { color: themeColors.textSecondary }]}>
                        {t(CHAIN_CONFIG[selectedChain].noteKey)}
                    </Text>
                </View>

                <TouchableOpacity style={styles.shareButton} onPress={handleShare} activeOpacity={0.8}>
                    <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.shareGradient}>
                        <Ionicons name="share-outline" size={20} color="white" />
                        <Text style={styles.shareText}>{t('receiveScreen.shareAddress')}</Text>
                    </LinearGradient>
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    content: {
        paddingHorizontal: SPACING.l,
        alignItems: 'center',
        paddingBottom: 32,
    },
    selectorRow: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: SPACING.l,
        justifyContent: 'center',
    },
    chainPill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        backgroundColor: 'rgba(18,21,26,0.55)',
    },
    chainPillText: {
        fontSize: 13,
        fontWeight: '600',
    },
    chainBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: 20,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    chainDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: SPACING.s,
    },
    chainText: {
        fontSize: 13,
        fontWeight: '500',
    },
    qrContainer: {
        marginBottom: SPACING.xl,
    },
    qrCard: {
        backgroundColor: 'white',
        borderRadius: 18,
        padding: SPACING.l,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    qrPlaceholder: {
        width: 200,
        height: 200,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addressCard: {
        width: '100%',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.l,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    addressLabel: {
        fontSize: 13,
        marginBottom: 10,
    },
    addressFull: {
        fontSize: 15,
        lineHeight: 22,
        fontWeight: '600',
    },
    copyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 12,
        gap: 6,
    },
    copyText: {
        fontSize: 13,
        fontWeight: '600',
    },
    infoCard: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        backgroundColor: 'rgba(18,21,26,0.55)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    infoText: {
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
    },
    shareButton: {
        width: '100%',
    },
    shareGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 16,
        paddingVertical: 16,
    },
    shareText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '700',
    },
});

export default ReceiveScreen;
