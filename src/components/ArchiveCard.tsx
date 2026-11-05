/**
 * ArchiveCard — the PE Archive in Settings → Storage (; rewritten for the PE Archive
 * human-path run, 2026-10-07).
 *
 * Short lines a person can scan: what the Archive is, that it is optional, what changes when it is
 * on, the price (and that each day a device uploads counts as at least 1 MB,), and — where it cannot be missed — that a purchase is permanent and non-refundable.
 * Buying happens on the Archive screen (`ArchiveScreen` + `ArchivePurchaseSheet`), which says what is
 * being bought and from which balance before Face ID, shows progress, and ends on an unmistakable
 * result. The money terms stay pinned on the device (`core/meter/archivePayment.ts`).
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { storeOfThisBuild } from '../config/distribution';
import { paidCopy } from '../core/store/paidCopy';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import relayService, { type ArchiveView } from '../services/RelayAPIService';
import type { AppParamList } from '../navigation/types';

const GB = 1_000_000_000;

function formatGb(bytes: number): string {
    const gb = bytes / GB;
    return gb >= 10 ? gb.toFixed(0) : gb.toFixed(gb >= 1 ? 1 : 2);
}

type Status = { kind: 'loading' } | { kind: 'ok'; view: ArchiveView } | { kind: 'error'; reason: string };

export function ArchiveCard(): React.ReactElement {
    const { t } = useTranslation();
    const store = storeOfThisBuild();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const [status, setStatus] = useState<Status>({ kind: 'loading' });

    useFocusEffect(useCallback(() => {
        let live = true;
        relayService.archiveStatus()
            .then((v) => { if (live) setStatus(v === null ? { kind: 'error', reason: 'status_unreadable' } : { kind: 'ok', view: v }); })
            .catch((e: unknown) => { if (live) setStatus({ kind: 'error', reason: e instanceof Error ? e.message : String(e) }); });
        return () => { live = false; };
    }, []));

    const view = status.kind === 'ok' ? status.view : null;
    const paid = view !== null && view.paidBytes > 0;
    const statusLine = view === null
        ? null
        : view.spaceExhausted
            ? paidCopy(t, 'peArchive.full', store)
            : view.on
                ? t('peArchive.onStatus', { used: formatGb(view.usedBytes), paid: formatGb(view.paidBytes) })
                : paid
                    ? t('peArchive.offStatus', { used: formatGb(view.usedBytes), paid: formatGb(view.paidBytes) })
                    : null;

    return (
        <View style={styles.card}>
            <View style={styles.head}>
                <Text style={styles.title}>{t('peArchive.title')}</Text>
                <Text style={styles.pill}>{t('peArchive.optional')}</Text>
            </View>
            <Text style={styles.line}>{t('peArchive.lineWhat')}</Text>
            <Text style={styles.line}>{t('peArchive.lineOptional')}</Text>
            <Text style={styles.line}>{t('peArchive.lineWhenOn')}</Text>
            <Text style={styles.line}>{paidCopy(t, 'peArchive.linePrice', store)}</Text>
            <Text style={styles.line}>{t('peArchive.lineMinimum')}</Text>
            <View style={styles.final}><Text style={styles.finalText}>{t('peArchive.lineFinal')}</Text></View>

            {statusLine !== null && <Text style={[styles.status, view?.spaceExhausted ? styles.warn : null]}>{statusLine}</Text>}
            {status.kind === 'error' && <Text style={styles.status}>{t('peArchive.statusUnreadable', { reason: status.reason })}</Text>}

            {!paid && (
                <>
                    <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('PeArchive', { buy: true })} accessibilityRole="button">
                        <Text style={styles.buttonText}>{paidCopy(t, 'peArchive.turnOn', store)}</Text>
                    </TouchableOpacity>
                    <Text style={styles.hint}>{paidCopy(t, 'peArchive.confirmComing', store)}</Text>
                </>
            )}
            <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => navigation.navigate('PeArchive', undefined)} accessibilityRole="button">
                <Text style={styles.buttonText}>{t('peArchive.open')} ›</Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        backgroundColor: COLORS.surface,
        borderColor: COLORS.borderLight,
    },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs },
    title: { fontSize: 15, fontWeight: '600', color: COLORS.text },
    pill: { fontSize: 12, color: COLORS.textSecondary, borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.s, paddingHorizontal: SPACING.s, paddingVertical: 2, overflow: 'hidden' },
    line: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginTop: SPACING.xs },
    final: { marginTop: SPACING.s, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.s, borderLeftWidth: 3, borderLeftColor: COLORS.secondary, backgroundColor: COLORS.secondaryMuted, borderRadius: BORDER_RADIUS.s },
    finalText: { fontSize: 13, fontWeight: '600', color: COLORS.text, lineHeight: 18 },
    status: { fontSize: 13, color: COLORS.textMuted, marginTop: SPACING.s, lineHeight: 18 },
    warn: { color: COLORS.text, fontWeight: '600' },
    hint: { fontSize: 12, color: COLORS.textSecondary, marginTop: SPACING.xs, lineHeight: 16 },
    button: {
        marginTop: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.surfaceHighlight,
        alignItems: 'center',
    },
    buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: COLORS.borderLight, marginTop: SPACING.s },
    buttonText: { fontSize: 13, fontWeight: '600', color: COLORS.text },
});

export default ArchiveCard;
