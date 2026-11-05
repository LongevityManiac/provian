import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * The person's PE Archive (PE Archive human-path run, 2026-10-07): what they paid for and what it
 * holds. Space used and left, every purchase with its Base transaction, every archived day (their
 * own, and their linked agents' days sealed to them too), and "Pull back" on any day — brought to
 * this phone once and checked intact up to the day's anchored root (`PhoneArchiveKeeper.verifyDay`).
 * Buying happens in `ArchivePurchaseSheet`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { storeOfThisBuild } from '../../config/distribution';
import { paidCopy } from '../../core/store/paidCopy';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import ArchivePurchaseSheet from '../../components/ArchivePurchaseSheet';
import ArchiveStorePurchaseSheet from '../../components/ArchiveStorePurchaseSheet';
import { resumeStorePurchases } from '../../core/store/storeRuntime';
import relayService, { type ArchivePaymentView, type ArchiveView } from '../../services/RelayAPIService';
import type { AppParamList } from '../../navigation/types';
import { baseTxUrl, readPendingPurchase, shortHash } from '../../core/meter/archivePurchase';
import type { ArchivedDayView, DayIntegrity, PhoneArchiveKeeper } from '../../core/meter/phoneArchive';

const GB = 1_000_000_000;

function gb(bytes: number): string {
    const v = bytes / GB;
    return v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2);
}

function size(bytes: number): string {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function dayLabel(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function dateLabel(ms: number | null): string {
    return ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function keeper(): Promise<PhoneArchiveKeeper | null> {
    const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
    const meter = getPhoneMeter();
    await meter.start();
    return meter.archive;
}

type Load<T> = { kind: 'loading' } | { kind: 'ok'; value: T } | { kind: 'error'; reason: string };
type Check = { kind: 'pulling' } | { kind: 'done'; result: DayIntegrity };

export default function ArchiveScreen(): React.ReactElement {
    const { t } = useTranslation();
    const store = storeOfThisBuild();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const route = useRoute<RouteProp<AppParamList, 'PeArchive'>>();
    const [view, setView] = useState<Load<ArchiveView>>({ kind: 'loading' });
    const [payments, setPayments] = useState<Load<ArchivePaymentView[]>>({ kind: 'loading' });
    const [own, setOwn] = useState<Load<ArchivedDayView[]>>({ kind: 'loading' });
    const [linked, setLinked] = useState<Load<ArchivedDayView[]>>({ kind: 'loading' });
    const [wallet, setWallet] = useState<string | null>(null);
    const [checks, setChecks] = useState<Record<string, Check>>({});
    const [sheetOpen, setSheetOpen] = useState(false);
    const [action, setAction] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async (): Promise<void> => {
        await Promise.all([
            relayService.archiveStatus()
                .then((v) => setView(v === null ? { kind: 'error', reason: 'status_unreadable' } : { kind: 'ok', value: v }))
                .catch((e: unknown) => setView({ kind: 'error', reason: errorDisplayCopy(e instanceof Error ? e.message : String(e)) })),
            relayService.archivePayments()
                .then((p) => setPayments({ kind: 'ok', value: p }))
                .catch((e: unknown) => setPayments({ kind: 'error', reason: errorDisplayCopy(e instanceof Error ? e.message : String(e)) })),
            (async () => {
                const k = await keeper().catch(() => null);
                const status = k ? await k.readStatus() : null;
                if (k === null || status === null) {
                    setOwn({ kind: 'error', reason: k === null ? 'archive_keeper_unavailable' : 'status_unreadable' });
                    setLinked({ kind: 'error', reason: k === null ? 'archive_keeper_unavailable' : 'status_unreadable' });
                    return;
                }
                setWallet(status.wallet);
                const [o, l] = await Promise.all([k.archivedDays('own', status.wallet), k.archivedDays('linked', status.wallet)]);
                setOwn(o === null ? { kind: 'error', reason: 'days_unreadable' } : { kind: 'ok', value: [...o].reverse() });
                setLinked(l === null ? { kind: 'error', reason: 'days_unreadable' } : { kind: 'ok', value: [...l].reverse() });
            })(),
        ]);
    }, []);

    // A store purchase bought but not yet recorded (the app closed mid-purchase) is sent first.
    useFocusEffect(useCallback(() => { void resumeStorePurchases().then(load); }, [load]));

    useEffect(() => {
        void (async () => {
            // A purchase still pending for this wallet reopens the sheet, which follows it up (the
            // sheet itself refuses to start a new one while it is pending).
            const address = await import('../../core/wallet/SeedManager').then((m) => m.default.getEVMAddress()).catch(() => null);
            const pending = address === null ? null : await readPendingPurchase(AsyncStorage, address);
            if (pending !== null || route.params?.buy) setSheetOpen(true);
        })();
    }, [route.params?.buy]);

    const refresh = async (): Promise<void> => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    };

    const turn = async (on: boolean): Promise<void> => {
        setAction({ busy: true, message: null });
        try {
            const v = await relayService.setArchive(on);
            setView({ kind: 'ok', value: v });
            setAction({ busy: false, message: null });
        } catch (e) {
            setAction({ busy: false, message: t('peArchive.statusUnreadable', { reason: errorDisplayCopy(e instanceof Error ? e.message : String(e)) }) });
        }
    };

    const uploadHistory = async (): Promise<void> => {
        setAction({ busy: true, message: null });
        const k = await keeper().catch(() => null);
        const report = k ? await k.uploadHistory() : null;
        if (report === null || report.state === 'error') {
            setAction({ busy: false, message: t('peArchive.historyFailed', { reason: report?.detail ?? 'archive_keeper_unavailable' }) });
        } else {
            setAction({
                busy: false,
                message: report.uploaded_days > 0 ? t('peArchive.historyUploaded', { count: report.uploaded_days }) : t('peArchive.historyNothing'),
            });
        }
        void load();
    };

    const pullBack = async (day: ArchivedDayView): Promise<void> => {
        const key = `${day.wallet}/${day.day}`;
        setChecks((c) => ({ ...c, [key]: { kind: 'pulling' } }));
        const k = await keeper().catch(() => null);
        const result: DayIntegrity = k === null || wallet === null
            ? { ok: false, reason: 'archive_keeper_unavailable' }
            : await k.verifyDay(day, wallet).catch((e: unknown) => ({ ok: false as const, reason: errorDisplayCopy(e instanceof Error ? e.message : String(e)) }));
        setChecks((c) => ({ ...c, [key]: { kind: 'done', result } }));
    };

    const v = view.kind === 'ok' ? view.value : null;
    const canBuyMore = v !== null && v.paidBytes > 0 && (v.spaceExhausted || v.nextGbPurchasable);

    const dayRows = (load: Load<ArchivedDayView[]>, empty: string | null): React.ReactElement => {
        if (load.kind === 'loading') return <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />;
        if (load.kind === 'error') return <Text style={styles.warn}>{t('peArchive.loadFailed', { reason: load.reason })}</Text>;
        if (load.value.length === 0) return empty === null ? <></> : <Text style={styles.muted}>{empty}</Text>;
        return (
            <>
                {load.value.map((d) => {
                    const key = `${d.wallet}/${d.day}`;
                    const check = checks[key];
                    return (
                        <View key={key} style={styles.item}>
                            <View style={styles.itemHead}>
                                <Text style={styles.itemTitle}>{dayLabel(d.day)}</Text>
                                <Text style={[styles.chip, d.confirmed ? styles.chipOk : null]}>
                                    {d.rejectedReason !== null ? t('peArchive.dayRejected', { reason: d.rejectedReason }) : d.confirmed ? t('peArchive.dayChecked') : t('peArchive.dayChecking')}
                                </Text>
                            </View>
                            <Text style={styles.muted}>{t('peArchive.dayRow', { count: d.peCount, size: size(d.bytes) })}</Text>
                            {check?.kind === 'done' && (
                                <Text style={check.result.ok ? styles.ok : styles.warn}>
                                    {check.result.ok ? `✓ ${t('peArchive.intact', { count: check.result.peCount })}` : t('peArchive.notIntact', { reason: check.result.reason })}
                                </Text>
                            )}
                            <TouchableOpacity
                                style={[styles.smallButton, check?.kind === 'pulling' || !d.confirmed || d.rejectedReason !== null ? styles.disabled : null]}
                                disabled={check?.kind === 'pulling' || d.partShas.length === 0 || !d.confirmed || d.rejectedReason !== null}
                                onPress={() => { void pullBack(d); }}
                                accessibilityRole="button"
                            >
                                <Text style={styles.smallButtonText}>{check?.kind === 'pulling' ? t('peArchive.pulling') : t('peArchive.pullBack')}</Text>
                            </TouchableOpacity>
                        </View>
                    );
                })}
            </>
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('peArchive.screenTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>
            <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={COLORS.platinum} />}>
                <View style={styles.card}>
                    <View style={styles.itemHead}>
                        <Text style={styles.cardTitle}>{t('peArchive.sectionSpace')}</Text>
                        {v !== null && <Text style={[styles.chip, v.on ? styles.chipOk : null]}>{v.on ? t('peArchive.pillOn') : t('peArchive.pillOff')}</Text>}
                    </View>
                    {view.kind === 'loading' && <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />}
                    {view.kind === 'error' && <Text style={styles.warn}>{t('peArchive.statusUnreadable', { reason: view.reason })}</Text>}
                    {v !== null && v.paidBytes === 0 && <Text style={styles.muted}>{t('peArchive.spaceNone')}</Text>}
                    {v !== null && v.paidBytes > 0 && (
                        <>
                            <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.min(100, (v.usedBytes / v.paidBytes) * 100)}%` }]} /></View>
                            <Text style={styles.bodyText}>{t('peArchive.spaceLine', { used: gb(v.usedBytes), paid: gb(v.paidBytes), free: gb(Math.max(0, v.paidBytes - v.usedBytes)) })}</Text>
                            {v.spaceExhausted && <Text style={styles.warn}>{paidCopy(t, 'peArchive.full', store)}</Text>}
                        </>
                    )}
                    {v !== null && v.paidBytes === 0 && (
                        <>
                            <PrimaryButton label={paidCopy(t, 'peArchive.turnOn', store)} onPress={() => setSheetOpen(true)} />
                            <Text style={styles.muted}>{paidCopy(t, 'peArchive.confirmComing', store)}</Text>
                        </>
                    )}
                    {v !== null && v.paidBytes > 0 && (canBuyMore
                        ? (
                            <>
                                <PrimaryButton label={paidCopy(t, 'peArchive.buyAnother', store)} onPress={() => setSheetOpen(true)} />
                                <Text style={styles.muted}>{paidCopy(t, 'peArchive.confirmComing', store)}</Text>
                            </>
                        )
                        : <Text style={styles.muted}>{t('peArchive.nextGbLater')}</Text>)}
                    {v !== null && v.paidBytes > 0 && (
                        <View style={styles.actions}>
                            {v.on && <SecondaryButton label={t('peArchive.uploadHistory')} disabled={action.busy} onPress={() => { void uploadHistory(); }} />}
                            <SecondaryButton label={v.on ? t('peArchive.turnOff') : t('peArchive.turnBackOn')} disabled={action.busy} onPress={() => { void turn(!v.on); }} />
                        </View>
                    )}
                    {v !== null && v.on && <Text style={styles.muted}>{t('peArchive.turnOffHint')}</Text>}
                    {action.busy && <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />}
                    {action.message !== null && <Text style={styles.bodyText}>{action.message}</Text>}
                </View>

                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('peArchive.sectionPurchases')}</Text>
                    {payments.kind === 'loading' && <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />}
                    {payments.kind === 'error' && <Text style={styles.warn}>{t('peArchive.loadFailed', { reason: payments.reason })}</Text>}
                    {payments.kind === 'ok' && payments.value.length === 0 && <Text style={styles.muted}>{t('peArchive.purchasesEmpty')}</Text>}
                    {payments.kind === 'ok' && payments.value.map((p) => (
                        <View key={p.requestId} style={styles.item}>
                            <View style={styles.itemHead}>
                                <Text style={styles.itemTitle}>{t('peArchive.purchaseRow', { date: dateLabel(p.createdAtMs) })}</Text>
                                <Text style={[styles.chip, p.credited ? styles.chipOk : null]}>
                                    {p.credited ? t('peArchive.stateCharged') : p.state === 'charge_failed' ? t('peArchive.stateFailed') : t('peArchive.stateConfirming')}
                                </Text>
                            </View>
                            {p.chargeTxHash !== null && (
                                <TouchableOpacity onPress={() => { void Linking.openURL(baseTxUrl(p.chargeTxHash as string)); }} accessibilityRole="link">
                                    <Text style={styles.link}>{shortHash(p.chargeTxHash)} · {t('peArchive.viewTx')} ↗</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    ))}
                </View>

                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('peArchive.sectionDays')}</Text>
                    {dayRows(own, t('peArchive.daysEmpty'))}
                </View>

                {linked.kind === 'ok' && linked.value.length > 0 && (
                    <View style={styles.card}>
                        <Text style={styles.cardTitle}>{t('peArchive.sectionLinked')}</Text>
                        <Text style={styles.muted}>{t('peArchive.linkedHint')}</Text>
                        {dayRows(linked, null)}
                    </View>
                )}
            </ScrollView>
            {store === null ? (
                <ArchivePurchaseSheet
                    visible={sheetOpen}
                    onClose={(changed) => { setSheetOpen(false); if (changed) void load(); }}
                    onSwap={() => navigation.navigate('Swap')}
                />
            ) : (
                <ArchiveStorePurchaseSheet
                    visible={sheetOpen}
                    onClose={(changed) => { setSheetOpen(false); if (changed) void load(); }}
                />
            )}
        </SafeAreaView>
    );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }): React.ReactElement {
    return (
        <TouchableOpacity style={styles.primary} onPress={onPress} accessibilityRole="button">
            <Text style={styles.primaryText}>{label}</Text>
        </TouchableOpacity>
    );
}

function SecondaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }): React.ReactElement {
    return (
        <TouchableOpacity style={[styles.secondary, disabled ? styles.disabled : null]} onPress={onPress} disabled={disabled} accessibilityRole="button">
            <Text style={styles.secondaryText}>{label}</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.m, paddingVertical: SPACING.s },
    headerTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
    content: { padding: SPACING.m, paddingBottom: SPACING.xxl },
    card: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, borderWidth: 1, borderColor: COLORS.borderLight, padding: SPACING.m, marginBottom: SPACING.m },
    cardTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.s },
    bodyText: { fontSize: 14, color: COLORS.text, lineHeight: 20, marginTop: SPACING.s },
    muted: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginTop: SPACING.s },
    warn: { fontSize: 13, color: COLORS.accentLight, lineHeight: 18, marginTop: SPACING.s },
    ok: { fontSize: 13, color: COLORS.success, lineHeight: 18, marginTop: SPACING.s },
    link: { fontSize: 13, color: COLORS.primaryLight, marginTop: SPACING.xs },
    spinner: { marginVertical: SPACING.s },
    bar: { height: 8, borderRadius: 4, backgroundColor: COLORS.surfaceHighlight, overflow: 'hidden', marginTop: SPACING.s },
    barFill: { height: 8, backgroundColor: COLORS.platinumDeep },
    item: { paddingVertical: SPACING.s, borderTopWidth: 1, borderTopColor: COLORS.border, marginTop: SPACING.s },
    itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    itemTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text, flex: 1 },
    chip: { fontSize: 12, color: COLORS.textSecondary, borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.s, paddingHorizontal: SPACING.s, paddingVertical: 2, overflow: 'hidden' },
    chipOk: { color: COLORS.success, borderColor: COLORS.success },
    actions: { flexDirection: 'row', marginTop: SPACING.s },
    primary: { marginTop: SPACING.m, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center' },
    primaryText: { color: COLORS.white, fontWeight: '600', fontSize: 15 },
    secondary: { flex: 1, marginTop: SPACING.s, marginRight: SPACING.s, borderWidth: 1, borderColor: COLORS.borderLight, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s, alignItems: 'center' },
    secondaryText: { color: COLORS.text, fontWeight: '600', fontSize: 13 },
    smallButton: { alignSelf: 'flex-start', marginTop: SPACING.s, borderWidth: 1, borderColor: COLORS.borderLight, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.xs },
    smallButtonText: { color: COLORS.text, fontWeight: '600', fontSize: 13 },
    disabled: { opacity: 0.5 },
});
