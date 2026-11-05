/**
 * PeCustodyCard — where this person's PEs are kept (PE meter, ).
 *
 * The relay keeps only totals; the PEs themselves live on this phone and, encrypted, in the
 * person's own iCloud / Google Drive. This card says so plainly, shows how many PEs are held and
 * when the last backup landed, and offers "Back up now" / "Restore from backup". `compact` is the
 * one-line version for the Abundance dashboard.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import { getPhoneMeter, backUpMyPes, restoreMyPes } from '../core/meter/phoneMeterRuntime';
import type { PhoneMeterStatus } from '../core/meter/phoneMeter';
import { cloudPlaceLabel } from '../core/meter/cloudFiles';

function formatWhen(ms: number | null): string | null {
    return ms ? new Date(ms).toLocaleString() : null;
}

export function PeCustodyCard({ compact = false }: { compact?: boolean }): React.ReactElement {
    const { t } = useTranslation();
    const [status, setStatus] = useState<PhoneMeterStatus | null>(null);
    const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);

    const refresh = useCallback(async () => {
        try {
            const meter = getPhoneMeter();
            await meter.start();
            setStatus(await meter.status());
        } catch {
            setStatus(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const unsubscribe = getPhoneMeter().subscribe(() => { void refresh(); });
        return unsubscribe;
    }, [refresh]);

    const kind = status?.backup.cloud;
    const cloud = cloudPlaceLabel(kind === 'icloud' || kind === 'google_drive' ? kind : undefined);
    // A received PE dropped here (its day is in the agent's Archive) is a pointer, not a PE on this phone.
    const receivedHere = status ? status.receivedPes - status.receivedArchivedPes : 0;
    const total = status ? status.ownPes + status.otherDevicePes + receivedHere + status.legacyRecords : 0;
    const lastBackup = formatWhen(status?.backup.last_success_at_ms ?? null);

    const backupLine = (): string => {
        if (!status) return t('peCustody.backupUnknown');
        switch (status.backup.state) {
            case 'ok':
                return status.backup.pending_files > 0
                    ? t('peCustody.backupPending', { when: lastBackup ?? '—' })
                    : t('peCustody.backupOk', { when: lastBackup ?? '—' });
            case 'cloud_unavailable':
                return t('peCustody.backupCloudOff', { cloud });
            case 'waiting_for_unlock':
                return t('peCustody.backupWaitingUnlock');
            case 'failed':
                return t('peCustody.backupFailed');
            default:
                return t('peCustody.backupNever');
        }
    };

    const backUpNow = async (): Promise<void> => {
        setBusy('backup');
        try {
            const report = await backUpMyPes();
            if (report.state === 'cloud_unavailable') Alert.alert(t('peCustody.title'), t('peCustody.backupCloudOff', { cloud }));
            else if (report.state === 'ok') Alert.alert(t('peCustody.title'), t('peCustody.backupDone', { cloud }));
            else Alert.alert(t('peCustody.title'), t('peCustody.backupFailed'));
        } finally {
            setBusy(null);
            void refresh();
        }
    };

    const restore = async (): Promise<void> => {
        setBusy('restore');
        try {
            const report = await restoreMyPes();
            const restored = report.devices.reduce((n, d) => n + d.imported, 0) + report.received + report.legacy;
            Alert.alert(
                t('peCustody.title'),
                report.found ? t('peCustody.restoreDone', { count: restored, cloud }) : t('peCustody.restoreNothing', { cloud }),
            );
        } catch {
            Alert.alert(t('peCustody.title'), t('peCustody.restoreFailed', { cloud }));
        } finally {
            setBusy(null);
            void refresh();
        }
    };

    if (compact) {
        return (
            <View style={styles.compact}>
                <Text style={styles.compactText}>{t('peCustody.compact', { count: total, cloud })}</Text>
                <Text style={styles.compactSub}>{backupLine()}</Text>
            </View>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.title}>{t('peCustody.title')}</Text>
            <Text style={styles.body}>{t('peCustody.where', { cloud })}</Text>
            <View style={styles.row}>
                <Text style={styles.label}>{t('peCustody.onThisPhone')}</Text>
                <Text style={styles.value}>{t('peCustody.count', { count: total })}</Text>
            </View>
            {status && status.unsentPes > 0 && (
                <View style={styles.row}>
                    <Text style={styles.label}>{t('peCustody.waitingToSend')}</Text>
                    <Text style={styles.value}>{status.unsentPes}</Text>
                </View>
            )}
            {status && receivedHere > 0 && (
                <View style={styles.row}>
                    <Text style={styles.label}>{t('peCustody.fromAgents')}</Text>
                    <Text style={styles.value}>{receivedHere}</Text>
                </View>
            )}
            {status && status.receivedArchivedPes > 0 && (
                <View style={styles.row}>
                    <Text style={styles.label}>{t('peCustody.inArchive')}</Text>
                    <Text style={styles.value}>{status.receivedArchivedPes}</Text>
                </View>
            )}
            <View style={styles.stack}>
                <Text style={styles.label}>{t('peCustody.inCloud', { cloud })}</Text>
                <Text style={styles.status}>{backupLine()}</Text>
            </View>
            {status?.halt && (
                <Text style={styles.halt}>{t('peCustody.halted')}</Text>
            )}
            <Text style={styles.note}>{t('peCustody.keepNote')}</Text>
            <View style={styles.actions}>
                <TouchableOpacity style={styles.button} onPress={backUpNow} disabled={busy !== null} accessibilityRole="button">
                    {busy === 'backup' ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.buttonText}>{t('peCustody.backupNow')}</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={restore} disabled={busy !== null} accessibilityRole="button">
                    {busy === 'restore' ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.buttonText}>{t('peCustody.restore')}</Text>}
                </TouchableOpacity>
            </View>
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
    title: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: SPACING.xs },
    body: { fontSize: 13, color: COLORS.textSecondary, marginBottom: SPACING.s, lineHeight: 18 },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs },
    label: { fontSize: 13, color: COLORS.textSecondary, flexShrink: 1, marginRight: SPACING.s },
    // A count never wraps: a long label ("Kept in the PE Archive…") wraps instead (, found live: 150 read as "15" over "0").
    value: { fontSize: 13, fontWeight: '500', color: COLORS.text, flexShrink: 0, textAlign: 'right' },
    stack: { marginTop: SPACING.xs, marginBottom: SPACING.xs },
    status: { fontSize: 13, color: COLORS.textMuted, marginTop: 2, lineHeight: 18 },
    halt: { fontSize: 12, color: COLORS.warning, marginTop: SPACING.xs },
    note: { fontSize: 12, color: COLORS.textMuted, marginTop: SPACING.s, lineHeight: 17 },
    actions: { flexDirection: 'row', marginTop: SPACING.m },
    button: {
        flex: 1,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.surfaceHighlight,
        alignItems: 'center',
        marginRight: SPACING.s,
    },
    buttonSecondary: { marginRight: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: COLORS.borderLight },
    buttonText: { fontSize: 13, fontWeight: '600', color: COLORS.text },
    compact: { paddingVertical: SPACING.s },
    compactText: { fontSize: 12, color: COLORS.textSecondary },
    compactSub: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
});

export default PeCustodyCard;
