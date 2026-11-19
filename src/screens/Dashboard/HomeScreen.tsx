import OnRampReconciler from '../../core/onramp/OnRampReconciler';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Image, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { AppParamList, TabParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { ActionPressable, actionStyles, DestinationRow, PrimaryAction } from '../../components/ScreenActions';
import ProvianIcon from '../../components/ProvianIcon';
import { AppMenu } from '../../components/AppMenu';
import TokenIcon from '../../components/TokenIcon';
import BalanceService from '../../core/wallet/BalanceService';
import { cachedPvtAsset } from '../../core/wallet/pvtBalanceDisplay';
import { getPhoneMeter } from '../../core/meter/phoneMeterRuntime';
import { localHistoryEntries } from '../../core/meter/peHistoryView';
import { useWalletStore } from '../../store/walletStore';
import { isTestnet } from '../../core/shared/environment';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import { displayBalance } from '../../utils/displayBalance';
import { formatUsd, portfolioTotal, totalAgeLabel } from '../../utils/fiatDisplay';
import { timeAgo } from '../../utils/timeAgo';
import type { PVTHistoryEntry } from '../../services/RelayAPIService';
import { HomeAttentionRows } from '../Attention/AttentionCenterScreen';
import { getWaitingPairing } from '../Agent/ComputerPairingScreen';
import { hasPendingAgentSetup } from '../Agent/ConnectAgentScreen';

type StackNav = NativeStackNavigationProp<AppParamList>;
type TabNav = BottomTabNavigationProp<TabParamList>;
const starterKey = (wallet: string) => `provian.home.starter.${wallet.toLowerCase()}`;

export default function HomeScreen() {
    const { t } = useTranslation();
    const tab = useNavigation<TabNav>();
    const route = useRoute<RouteProp<TabParamList, 'WalletTab'>>();
    const stack = tab.getParent<StackNav>()!;
    const address = useWalletStore(state => state.address);
    const lastPvt = useWalletStore(state => state.lastConfirmedPvt);
    const pvtStatus = useWalletStore(state => state.pvtBalanceStatus);
    const locked = useWalletStore(state => state.isLockdownActive);
    const userName = useWalletStore(state => state.userName);
    const [money, setMoney] = useState<{ wallet: string; total: ReturnType<typeof portfolioTotal> } | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [starter, setStarter] = useState(false);
    const [starterY, setStarterY] = useState<number>();
    const scroll = useRef<ScrollView>(null);
    const starterPreference = useRef(0);
    const [resumable, setResumable] = useState<'computer' | 'agent' | null>(null);
    const [proofs, setProofs] = useState<PVTHistoryEntry[]>([]);
    const [now, setNow] = useState(Date.now);
    const [proofMoment, setProofMoment] = useState(false);
    const pulse = useRef(new Animated.Value(1)).current;
    const lastSeen = useRef<{ wallet: string; proof: string; balance: number } | undefined>(undefined);
    const pvt = cachedPvtAsset(lastPvt, address, !isTestnet());
    const fiat = money?.wallet === address ? money.total : null;

    useEffect(() => {
        if (!pvt || pvtStatus !== 'fresh' || !proofs[0]) return;
        const next = { wallet: address, proof: proofs[0].peId, balance: Number(pvt.balance) };
        const prior = lastSeen.current;
        lastSeen.current = next;
        if (!prior || prior.wallet !== address || next.proof === prior.proof || next.balance <= prior.balance) return;
        let active = true;
        setProofMoment(true);
        void AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
            if (!active || reduced) return;
            Animated.sequence([
                Animated.timing(pulse, { toValue: 1.04, duration: 130, useNativeDriver: true }),
                Animated.timing(pulse, { toValue: 1, duration: 210, useNativeDriver: true }),
            ]).start();
        }).catch(() => {});
        const timer = setTimeout(() => setProofMoment(false), 1500);
        return () => { active = false; clearTimeout(timer); pulse.stopAnimation(); pulse.setValue(1); setProofMoment(false); };
    }, [address, proofs, pulse, pvt?.balance, pvtStatus]);

    const refreshBalance = useCallback(async () => {
        if (!address) return;
        try {
            const result = await BalanceService.fetchAllBalancesDetailed(address, undefined, true);
            if (useWalletStore.getState().address !== address) return;
            if (result.assetChainsConfirmed) setMoney({
                wallet: address, total: portfolioTotal(result.assets),
            });
        } finally {
            setNow(Date.now());
        }
    }, [address]);

    const refreshContext = useCallback(async () => {
        if (!address) return;
        const meter = getPhoneMeter();
        const [recent, waiting, agentSetup] = await Promise.all([
            meter.start().then(() => localHistoryEntries(meter.store)).catch(() => []),
            getWaitingPairing(address).catch(() => null),
            hasPendingAgentSetup(address),
        ]);
        if (useWalletStore.getState().address !== address) return;
        setProofs(recent.slice(0, 3));
        setResumable(waiting ? 'computer' : agentSetup ? 'agent' : null);
    }, [address]);

    const starterRequest = route.params?.starterRequest;
    useEffect(() => {
        if (!address) return;
        const preference = ++starterPreference.current;
        let current = true;
        void AsyncStorage.getItem(starterKey(address)).then(value => {
            if (current && preference === starterPreference.current) setStarter(value !== 'dismissed');
        }).catch(() => {});
        return () => { current = false; };
    }, [address]);

    useEffect(() => {
        if (!address || starterRequest === undefined) return;
        starterPreference.current++;
        setStarter(true);
        void AsyncStorage.removeItem(starterKey(address)).catch(() => {});
    }, [address, starterRequest]);

    useEffect(() => {
        if (starterRequest === undefined || !starter || starterY === undefined) return;
        scroll.current?.scrollTo({ y: Math.max(0, starterY - SPACING.s), animated: true });
        tab.setParams({ starterRequest: undefined });
    }, [starter, starterY, starterRequest, tab]);

    useFocusEffect(useCallback(() => {
        void refreshBalance().catch(() => {});
        // Let the confirmed balance request enter the network before loading the proof trail.
        const contextTimer = setTimeout(() => {
            void refreshContext();
            if (address) void OnRampReconciler.reconcile(address).catch(() => {});
        }, 250);
        const ageTimer = setInterval(() => setNow(Date.now()), 30_000);
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active') {
                void refreshBalance().catch(() => {});
                void refreshContext();
            }
        });
        return () => {
            clearTimeout(contextTimer);
            clearInterval(ageTimer);
            subscription.remove();
        };
    }, [address, refreshBalance, refreshContext]));

    const dismissStarter = () => {
        starterPreference.current++;
        setStarter(false);
        setStarterY(undefined);
        void AsyncStorage.setItem(starterKey(address), 'dismissed').catch(() => {});
    };

    return (
        <SafeAreaView style={styles.safe} edges={['top']}>
            <View style={styles.header}>
                <View style={styles.headerTitle}>
                    <Text style={styles.title}>{t('overhaul.home')}</Text>
                    {!!userName && <Text style={styles.muted} numberOfLines={1}>{userName}</Text>}
                </View>
                {locked && <ActionPressable onPress={() => stack.navigate('Lockdown')} accessibilityRole="button">
                    <Text style={styles.warning}>{t('dashboard.lockdownBadge')}</Text>
                </ActionPressable>}
                <AppMenu />
            </View>
            <ScrollView ref={scroll} contentContainerStyle={styles.content} refreshControl={
                <RefreshControl refreshing={refreshing} tintColor={COLORS.primary}
                    onRefresh={() => {
                        setRefreshing(true);
                        void Promise.allSettled([refreshBalance(), refreshContext()]).then(() => setRefreshing(false));
                    }} />
            }>
                <View style={styles.balanceCard}>
                    <View style={styles.balanceTop}>
                        <Text style={styles.muted}>{t('overhaul.confirmedPvt')}</Text>
                        <ActionPressable accessibilityRole="button" onPress={() => stack.navigate('Recourse')} style={styles.inline}>
                            <Ionicons name="shield-checkmark-outline" size={17} color={COLORS.primaryLight} />
                            <Text style={styles.link}>{t('recourse.title')}</Text>
                        </ActionPressable>
                    </View>
                    {pvt && lastPvt ? (
                        <>
                            <View style={styles.balanceLine}>
                                <TokenIcon symbol="PVT" size={29} />
                                <Animated.Text style={[styles.pvt, actionStyles.money, { transform: [{ scale: pulse }] },
                                    proofMoment && styles.warning]} numberOfLines={1} adjustsFontSizeToFit
                                    testID="home-confirmed-pvt">{displayBalance(pvt.balance)} PVT</Animated.Text>
                                {proofMoment && <ProvianIcon name="proof" size={22} color={COLORS.warning} />}
                            </View>
                            <Text style={styles.muted} testID="home-balance-age">
                                {t('overhaul.confirmedAgo', { age: timeAgo(lastPvt.confirmedAt, t, now) })}
                                {pvtStatus === 'outdated' ? ` · ${t('dashboard.balanceOutdated')}` : ''}
                            </Text>
                        </>
                    ) : <Text style={styles.checking}>{t(pvtStatus === 'outdated' ? 'dashboard.balanceLoadFailed' : 'overhaul.checkingBalance')}</Text>}
                    <View style={styles.moneyLine}>
                        <Text style={styles.muted}>{t('dashboard.totalBalance')}</Text>
                        <Text style={[styles.fiat, actionStyles.money]}>{fiat ? formatUsd(fiat.value) : '—'}</Text>
                    </View>
                    {!!fiat && !!totalAgeLabel(fiat, t) && <Text style={styles.muted}>{totalAgeLabel(fiat, t)}</Text>}
                    <View style={styles.quickActions}>
                        <PrimaryAction icon="send" label={t('dashboard.send')} onPress={() => stack.navigate('Send')} style={styles.send} />
                        <ActionPressable accessibilityRole="button" style={styles.receive} onPress={() => stack.navigate('Receive')}>
                            <ProvianIcon name="receive" size={22} color={COLORS.primaryLight} />
                            <Text style={styles.link}>{t('dashboard.receive')}</Text>
                        </ActionPressable>
                    </View>
                    <DestinationRow label={t('overhaul.assetsAndHistory')} stockIcon="wallet-outline" onPress={() => stack.navigate('Dashboard')} />
                </View>

                {starter && <View style={styles.starter} onLayout={event => setStarterY(event.nativeEvent.layout.y)}>
                    <Image source={require('../../../assets/images/vision-builders.png')} style={styles.photo} accessibilityIgnoresInvertColors />
                    <View style={styles.starterBody}>
                        <View style={styles.balanceTop}>
                            <Text style={[actionStyles.sectionTitle, styles.starterTitle]}>{t('overhaul.firstTask')}</Text>
                            <ActionPressable accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={10} onPress={dismissStarter}>
                                <Ionicons name="close" size={22} color={COLORS.textSecondary} />
                            </ActionPressable>
                        </View>
                        <DestinationRow label={t('overhaul.chatWithAi')} icon="chat" onPress={() => tab.navigate('ChatTab')} />
                        <DestinationRow label={t('connectAgent.deviceTitle')} detail={t('overhaul.connectComputerDetail')}
                            icon="computer" onPress={() => stack.navigate('ComputerPairing')} />
                        <DestinationRow label={t('overhaul.connectCodeHosting')} detail={t('overhaul.connectCodeHostingDetail')}
                            stockIcon="git-branch-outline" onPress={() => stack.navigate('ConnectAgent', { mode: 'codeHost' })} />
                        <DestinationRow label={t('overhaul.linkMyAgent')} icon="agent" onPress={() => stack.navigate('ConnectAgent', { mode: 'agent' })} />
                        <DestinationRow label={t('overhaul.exploreCommons')} icon="commons" onPress={() => tab.navigate('CommonsTab')} />
                        <DestinationRow label={t('overhaul.linkMyWallet')} stockIcon="wallet-outline" onPress={() => stack.navigate('ProveOwnWallet')} />
                        <DestinationRow label={t('overhaul.readVision')} stockIcon="compass-outline" onPress={() => stack.navigate('Vision')} />
                    </View>
                </View>}

                <HomeAttentionRows />

                {proofs.length > 0 && <View style={styles.section}>
                    <View style={styles.balanceTop}>
                        <Text style={actionStyles.sectionTitle}>{t('overhaul.recentWork')}</Text>
                        <ActionPressable accessibilityRole="button" hitSlop={8} onPress={() => tab.navigate('AgentsTab')}>
                            <Text style={styles.link}>{t('dashboard.seeAll')}</Text>
                        </ActionPressable>
                    </View>
                    {proofs.map(proof => <DestinationRow key={proof.peId} icon="proof"
                        label={getActionTypeDisplay(proof.actionType).label} detail={timeAgo(proof.timestamp, t, now)}
                        onPress={() => stack.navigate('EnvelopeDetail', { envelopeId: proof.peId })} />)}
                </View>}

                {resumable && <View style={styles.section}>
                    <Text style={actionStyles.sectionTitle}>{t('common.continue')}</Text>
                    <DestinationRow label={t(resumable === 'computer' ? 'overhaul.connectComputer' : 'overhaul.linkMyAgent')}
                        icon={resumable} onPress={() => resumable === 'computer'
                            ? stack.navigate('ComputerPairing')
                            : stack.navigate('ConnectAgent', { mode: 'agent' })} />
                </View>}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, paddingHorizontal: SPACING.l, paddingBottom: SPACING.m },
    headerTitle: { flex: 1 },
    title: { color: COLORS.text, fontSize: 32, fontWeight: '700' },
    content: { paddingHorizontal: SPACING.l, paddingBottom: 134, gap: SPACING.l },
    balanceCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.xl, padding: SPACING.m },
    balanceTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.s },
    balanceLine: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.s },
    inline: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: SPACING.xs },
    pvt: { color: COLORS.platinum, flexShrink: 1, fontSize: 36, fontWeight: '700' },
    checking: { color: COLORS.text, fontSize: 21, marginVertical: SPACING.m },
    muted: { color: COLORS.textSecondary, fontSize: 13 },
    link: { color: COLORS.primaryLight, fontSize: 15, fontWeight: '700' },
    warning: { color: COLORS.warning, fontWeight: '600' },
    moneyLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: SPACING.l },
    fiat: { color: COLORS.text, fontSize: 21, fontWeight: '700' },
    quickActions: { flexDirection: 'row', gap: SPACING.m, marginTop: SPACING.m, marginBottom: SPACING.xs },
    send: { flex: 1 },
    receive: { flex: 1, flexDirection: 'row', gap: 7, minHeight: 48, alignItems: 'center', justifyContent: 'center',
        borderColor: COLORS.border, borderWidth: 1, borderRadius: BORDER_RADIUS.l },
    section: { gap: SPACING.xs },
    starter: { overflow: 'hidden', borderRadius: BORDER_RADIUS.xl, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
    photo: { width: '100%', height: 112 },
    starterBody: { padding: SPACING.m },
    starterTitle: { flex: 1 },
});
