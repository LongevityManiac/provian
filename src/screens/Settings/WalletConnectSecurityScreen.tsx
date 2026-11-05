import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Switch,
    TextInput,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

/**
 * WalletConnectSecurityScreen — owner-tunable controls for the human
 * WalletConnect governance pipeline. The mandatory block lane and Face
 * ID are enforced unconditionally and are NOT configurable here.
 */
const WalletConnectSecurityScreen = ({ navigation }: { navigation: { goBack: () => void } }) => {
    const { t } = useTranslation();
    const gov = useWalletStore(s => s.walletConnectGovernance);
    const setGov = useWalletStore(s => s.setWalletConnectGovernance);

    // Local string state for the numeric caps so the field can be cleared while typing.
    const [perTxText, setPerTxText] = useState(gov.perTransactionLimitUsd ? String(gov.perTransactionLimitUsd) : '');
    const [dailyText, setDailyText] = useState(gov.dailyLimitUsd ? String(gov.dailyLimitUsd) : '');

    const commitCap = (raw: string, key: 'perTransactionLimitUsd' | 'dailyLimitUsd') => {
        const n = Math.max(0, Math.floor(Number(raw)));
        setGov({ [key]: Number.isFinite(n) ? n : 0 });
    };

    const PolicyChoice = ({
        value,
        onChange,
    }: {
        value: 'block' | 'hard_confirm';
        onChange: (v: 'block' | 'hard_confirm') => void;
    }) => (
        <View style={styles.segment}>
            {(['block', 'hard_confirm'] as const).map((opt) => {
                const selected = value === opt;
                return (
                    <TouchableOpacity
                        key={opt}
                        style={[styles.segmentButton, selected && styles.segmentButtonActive]}
                        onPress={() => onChange(opt)}
                        activeOpacity={0.85}
                    >
                        <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                            {opt === 'block' ? t('walletConnect.security.optionBlock') : t('walletConnect.security.optionHardConfirm')}
                        </Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.background} style={StyleSheet.absoluteFill} />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('walletConnect.security.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <Text style={styles.subtitle}>{t('walletConnect.security.subtitle')}</Text>

                {/* Approvals */}
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('walletConnect.security.approvalsTitle')}</Text>
                    <View style={styles.row}>
                        <View style={styles.rowText}>
                            <Text style={styles.rowLabel}>{t('walletConnect.security.requireApprovalConfirm')}</Text>
                            <Text style={styles.rowHint}>{t('walletConnect.security.requireApprovalConfirmHint')}</Text>
                        </View>
                        <Switch
                            value={gov.requireApprovalConfirm}
                            onValueChange={(v) => setGov({ requireApprovalConfirm: v })}
                            trackColor={{ true: COLORS.primary, false: COLORS.border }}
                        />
                    </View>

                    <View style={styles.divider} />

                    <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>{t('walletConnect.security.unlimitedTitle')}</Text>
                        <Text style={styles.rowHint}>{t('walletConnect.security.unlimitedHint')}</Text>
                    </View>
                    <PolicyChoice
                        value={gov.unlimitedApprovalPolicy}
                        onChange={(v) => setGov({ unlimitedApprovalPolicy: v })}
                    />
                </View>

                {/* Unknown contracts */}
                <View style={styles.card}>
                    <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>{t('walletConnect.security.unknownTitle')}</Text>
                        <Text style={styles.rowHint}>{t('walletConnect.security.unknownHint')}</Text>
                    </View>
                    <PolicyChoice
                        value={gov.unknownContractPolicy}
                        onChange={(v) => setGov({ unknownContractPolicy: v })}
                    />
                </View>

                {/* Caps */}
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('walletConnect.security.capsTitle')}</Text>
                    <Text style={styles.rowHint}>{t('walletConnect.security.capsHint')}</Text>

                    <View style={styles.capRow}>
                        <Text style={styles.rowLabel}>{t('walletConnect.security.perTxLimit')}</Text>
                        <TextInput
                            style={styles.capInput}
                            value={perTxText}
                            onChangeText={setPerTxText}
                            onBlur={() => commitCap(perTxText, 'perTransactionLimitUsd')}
                            keyboardType="number-pad"
                            placeholder={t('walletConnect.security.capPlaceholder')}
                            placeholderTextColor={COLORS.textMuted}
                        />
                    </View>
                    <View style={styles.capRow}>
                        <Text style={styles.rowLabel}>{t('walletConnect.security.dailyLimit')}</Text>
                        <TextInput
                            style={styles.capInput}
                            value={dailyText}
                            onChangeText={setDailyText}
                            onBlur={() => commitCap(dailyText, 'dailyLimitUsd')}
                            keyboardType="number-pad"
                            placeholder={t('walletConnect.security.capPlaceholder')}
                            placeholderTextColor={COLORS.textMuted}
                        />
                    </View>
                </View>

                <View style={styles.footerRow}>
                    <Ionicons name="shield-checkmark-outline" size={16} color={COLORS.textMuted} />
                    <Text style={styles.footerText}>{t('walletConnect.security.footer')}</Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
    content: { padding: SPACING.l, gap: SPACING.l, paddingBottom: SPACING.xxxl },
    subtitle: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
    card: {
        backgroundColor: COLORS.glass,
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        gap: SPACING.m,
    },
    cardTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.m },
    rowText: { flex: 1, gap: 2 },
    rowLabel: { fontSize: 15, fontWeight: '600', color: COLORS.text },
    rowHint: { fontSize: 12, color: COLORS.textMuted, lineHeight: 16 },
    divider: { height: 1, backgroundColor: COLORS.borderLight },
    segment: {
        flexDirection: 'row',
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        padding: 3,
        gap: 3,
    },
    segmentButton: {
        flex: 1,
        paddingVertical: 8,
        borderRadius: BORDER_RADIUS.s,
        alignItems: 'center',
    },
    segmentButtonActive: { backgroundColor: COLORS.primary },
    segmentText: { fontSize: 13, fontWeight: '600', color: COLORS.textSecondary },
    segmentTextActive: { color: '#FFFFFF' },
    capRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.m },
    capInput: {
        minWidth: 100,
        backgroundColor: COLORS.surfaceHighlight,
        paddingVertical: 8,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        color: COLORS.text,
        borderWidth: 1,
        borderColor: COLORS.border,
        fontSize: 15,
        textAlign: 'right',
    },
    footerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, paddingHorizontal: SPACING.xs },
    footerText: { fontSize: 12, color: COLORS.textMuted, flex: 1, lineHeight: 18 },
});

export default WalletConnectSecurityScreen;
