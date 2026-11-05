/**
 * OwnProfileScreen — Trust Layer §2.3, the actor's OWN reputation profile.
 *
 * Renders this wallet's full LIVE vocabulary (GET /v1/wallet/vocabulary) grouped
 * by the §2.5 sections — Continuity / Work / Coupling / Consumption / Money /
 * Standing / Accountability / Composition / Presentations / Actor. This is the
 * same numeric read a reputation presentation would disclose, shown here as the
 * actor's self view. Standing is ALWAYS shown and prominent — adverse facts
 * (disputes, slashes, invalidations, open bond claims) are surfaced in red and
 * can never be hidden.
 *
 * A COUNTERPARTY's Commons profile is a different surface and keeps its
 * 2026-08-19 rule (presentations-produced count + network volume; never
 * individual handshakes) — this screen does not touch it.
 *
 * Metadata only: flat numeric facts, no content, no identifiers beyond the
 * vocabulary itself.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';

/** Vocabulary groups, in the §2.5 ruling's order (standing pulled to the front). */
const GROUP_ORDER = [
    'standing', 'continuity', 'work', 'coupling', 'consumption', 'money',
    'accountability', 'composition', 'presentations', 'actor',
] as const;

interface FactGroup {
    group: string;
    fields: { field: string; leaf: string; value: number }[];
}

export default function OwnProfileScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation();

    const [facts, setFacts] = useState<Record<string, number> | null>(null);
    const [standingPrefix, setStandingPrefix] = useState('standing.');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadError, setLoadError] = useState(false);

    const load = useCallback(async () => {
        const v = await RelayAPIService.getVocabulary();
        if (v) {
            setFacts(v.facts);
            setStandingPrefix(v.standingPrefix);
            setLoadError(false);
        } else {
            setLoadError(true);
        }
    }, []);

    useEffect(() => {
        (async () => {
            await load();
            setLoading(false);
        })();
    }, [load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const groups = useMemo<FactGroup[]>(() => {
        const byGroup = new Map<string, { field: string; leaf: string; value: number }[]>();
        for (const field of Object.keys(facts ?? {}).sort()) {
            const dot = field.indexOf('.');
            const g = dot >= 0 ? field.slice(0, dot) : field;
            const leaf = dot >= 0 ? field.slice(dot + 1) : field;
            const list = byGroup.get(g) ?? [];
            list.push({ field, leaf, value: (facts ?? {})[field] });
            byGroup.set(g, list);
        }
        const ordered = [
            ...GROUP_ORDER.filter((g) => byGroup.has(g)),
            ...[...byGroup.keys()].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g)),
        ];
        return ordered.map((g) => ({ group: g, fields: byGroup.get(g) ?? [] }));
    }, [facts]);

    const groupLabel = useCallback((group: string): string => {
        const key = `trustLayer.ownProfile.group.${group}`;
        const translated = t(key);
        // Fall back to the raw group name if a group we didn't localize appears.
        return translated === key ? group : translated;
    }, [t]);

    const isStanding = useCallback((field: string) => field.startsWith(standingPrefix), [standingPrefix]);

    const renderStandingGroup = (fields: FactGroup['fields']) => {
        const adverse = fields.filter((f) => f.value > 0);
        return (
            <View style={[styles.card, styles.standingCard]}>
                <View style={styles.standingHeader}>
                    <Ionicons name="shield-half" size={16} color={COLORS.platinum} />
                    <Text style={styles.standingTitle}>{groupLabel('standing')}</Text>
                </View>
                <Text style={styles.standingHint}>{t('trustLayer.ownProfile.standingAlways')}</Text>
                {adverse.length === 0 ? (
                    <View style={styles.factRow}>
                        <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
                        <Text style={styles.factOk}>{t('trustLayer.ownProfile.adverseClean')}</Text>
                    </View>
                ) : null}
                {fields.map((f) => {
                    const isAdverse = f.value > 0 && (f.leaf.includes('adverse') || f.leaf.includes('invalidation') || f.leaf.includes('claim') || f.leaf.includes('slash') || f.leaf.includes('dispute'));
                    return (
                        <View key={f.field} style={styles.factRow}>
                            {isAdverse && <Ionicons name="alert-circle" size={16} color={COLORS.error} />}
                            <Text style={styles.factLabel}>{f.leaf}</Text>
                            <Text style={[styles.factValue, isAdverse && { color: COLORS.error }]}>{f.value}</Text>
                        </View>
                    );
                })}
            </View>
        );
    };

    if (loading) {
        return (
            <SafeAreaView style={styles.safe} edges={['top']}>
                <Header t={t} onBack={() => navigation.goBack()} />
                <View style={styles.center}><ActivityIndicator color={COLORS.platinum} /></View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.safe} edges={['top']}>
            <Header t={t} onBack={() => navigation.goBack()} />
            <ScrollView
                contentContainerStyle={styles.body}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.platinum} />}
            >
                <Text style={styles.lede}>{t('trustLayer.ownProfile.subtitle')}</Text>

                {loadError ? (
                    <View style={styles.center}>
                        <Text style={styles.errorText}>{t('trustLayer.ownProfile.loadError')}</Text>
                        <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); void load().finally(() => setLoading(false)); }}>
                            <Text style={styles.retryText}>{t('common.tryAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : groups.length === 0 ? (
                    <Text style={styles.empty}>{t('trustLayer.ownProfile.empty')}</Text>
                ) : (
                    groups.map((g) => (
                        g.group === 'standing'
                            ? <View key={g.group}>{renderStandingGroup(g.fields)}</View>
                            : (
                                <View key={g.group} style={styles.card}>
                                    <Text style={styles.groupTitle}>{groupLabel(g.group)}</Text>
                                    {g.fields.map((f) => (
                                        <View key={f.field} style={styles.factRow}>
                                            <Text style={styles.factLabel}>{f.leaf}</Text>
                                            <Text style={styles.factValue}>{f.value}</Text>
                                        </View>
                                    ))}
                                </View>
                            )
                    ))
                )}

                {/* Present this reputation to a counterparty (burn-to-present). */}
                {!loadError && (
                    <TouchableOpacity
                        style={styles.presentBtn}
                        onPress={() => navigation.navigate('HumanPresentment' as never)}
                        activeOpacity={0.8}
                    >
                        <Ionicons name="shield-checkmark" size={18} color={COLORS.black} />
                        <Text style={styles.presentBtnText}>{t('trustLayer.ownProfile.presentCta')}</Text>
                    </TouchableOpacity>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function Header({ t, onBack }: { t: (k: string) => string; onBack: () => void }): React.ReactElement {
    return (
        <View style={styles.header}>
            <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="chevron-back" size={26} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('trustLayer.ownProfile.title')}</Text>
            <View style={{ width: 26 }} />
        </View>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
    headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
    body: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
    center: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xxl },
    lede: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 21, marginBottom: SPACING.l },
    empty: { color: COLORS.textMuted, fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
    errorText: { color: COLORS.textSecondary, fontSize: 14, marginBottom: SPACING.m },
    retryBtn: { paddingHorizontal: SPACING.l, paddingVertical: SPACING.s, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border },
    retryText: { color: COLORS.platinum, fontSize: 14, fontWeight: '600' },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)', borderRadius: BORDER_RADIUS.l, padding: SPACING.l,
        borderWidth: 1, borderColor: 'rgba(200,205,214,0.08)', marginBottom: SPACING.m,
    },
    standingCard: { borderColor: COLORS.platinumMuted },
    standingHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
    standingTitle: { color: COLORS.platinum, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
    standingHint: { color: COLORS.textMuted, fontSize: 12, lineHeight: 17, marginTop: SPACING.xs, marginBottom: SPACING.s },
    groupTitle: { color: COLORS.platinum, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.s },
    factRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingVertical: SPACING.xs },
    factLabel: { flex: 1, color: COLORS.textSecondary, fontSize: 13 },
    factValue: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
    factOk: { color: COLORS.success, fontSize: 13 },
    presentBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.s,
        backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.m, marginTop: SPACING.m,
    },
    presentBtnText: { color: COLORS.black, fontSize: 15, fontWeight: '700' },
});
