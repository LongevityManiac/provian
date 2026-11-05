/**
 * ParticipationCard - Prominent PE/PVT participation summary
 *
 * Leads with the honest, understandable measure — the Provenance Envelope count.
 * When a non-final PVT settlement projection actually
 * exists it takes the headline slot instead, colour-coded PLATINUM (the design
 * system's ASSET colour — a PVT amount is the asset; "platinum owns the
 * asset, amber owns the moment") because it is real money-in-waiting. There is
 * deliberately NO abstract "record points" number: it read as a money-like
 * "0.0" and confused users into thinking they had earned nothing.
 *
 * On a failed fetch (loadError) the card says so rather than rendering a
 * confidently-wrong zero.
 *
 * Rendered on the Wallet dashboard.
 */

import React, { useRef, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS } from '../constants/theme';
import type { PVTAccrual } from '../services/RelayAPIService';
import { InfoModal, InfoButton } from './InfoModal';

interface ParticipationCardProps {
    pvtAccrual: PVTAccrual | null;
    /** True when the accrual fetch FAILED (network/rate-limit/auth) — distinct
     * from a genuine empty record. Renders a "couldn't load" state instead of a
     * confidently-wrong zero. */
    loadError?: boolean;
    onPress?: () => void;
    onRetry?: () => void;
}

const ParticipationCard = ({ pvtAccrual, loadError, onPress, onRetry }: ParticipationCardProps) => {
    const { t } = useTranslation();
    const pulseAnim = useRef(new Animated.Value(1)).current;
    const [infoVisible, setInfoVisible] = useState(false);

    useEffect(() => {
        if (pvtAccrual && pvtAccrual.totalPEs > 0) {
            // Pulse once on mount: scale 1 → 1.05 → 1. The former animated
            // border glow was retired with the rest of "Shield Glow" — calm is
            // the brand, so the card moves once and then holds still.
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1.05,
                    duration: 600,
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: 600,
                    useNativeDriver: true,
                }),
            ]).start();
        }
    }, [pvtAccrual, pulseAnim]);

    const currentProjection = pvtAccrual?.currentSettlementProjection;
    const showsProjection = currentProjection?.available === true;
    // A non-final PVT projection is real money-in-waiting and earns the PLATINUM
    // ASSET colour (statValueMoney below; platinum-owns-the-asset). When
    // there's no projection we DON'T invent a pseudo-number:
    // we lead with the honest, understandable count of Provenance Envelopes. The
    // old "sealed record points (not PVT)" figure — an internal weighted tally
    // shown as a money-like "0.0" — was the single most confusing thing here.
    const projectionValue = showsProjection ? parseFloat(currentProjection.totalPVT) : 0;
    const peCount = pvtAccrual?.totalPEs ?? 0;
    const weeklyPEs = pvtAccrual?.weeklyPEs ?? 0;
    const isLoadError = loadError === true;
    const isLoading = pvtAccrual === null && !isLoadError;
    const retry = isLoadError ? onRetry : undefined;

    const fmt = (n: number): string =>
        n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();

    return (
        <View style={styles.container}>
        <TouchableOpacity
            style={{ flex: 1 }}
            onPress={retry ?? onPress}
            activeOpacity={0.8}
            disabled={!retry && !onPress}
        >
            {isLoadError ? (
                // The record couldn't be fetched (network / rate-limit / auth).
                // Never render this as a confident zero — that reads as "you have
                // nothing" when the truth is "we couldn't load it".
                <View style={styles.errorRow}>
                    <Ionicons name="cloud-offline-outline" size={18} color={COLORS.textTertiary} />
                    <Text style={styles.errorText}>{t('dashboard.participationLoadError')}</Text>
                </View>
            ) : (
            /* Main stats row */
            <View style={styles.statsRow}>
                {/* Primary: the honest lead. A non-final PVT projection when one
                    exists (platinum — a PVT amount is the ASSET), otherwise the
                    Provenance Envelope count. */}
                <View style={styles.statBlock}>
                    {isLoading ? (
                        <View style={styles.skeleton} />
                    ) : (
                        <Animated.Text
                            style={[
                                styles.statValue,
                                showsProjection ? styles.statValueMoney : styles.statValueRecord,
                                { transform: [{ scale: pulseAnim }] },
                            ]}
                        >
                            {showsProjection ? fmt(projectionValue) : fmt(peCount)}
                        </Animated.Text>
                    )}
                    <View style={styles.statLabelRow}>
                        <Text style={styles.statLabel}>
                            {showsProjection
                                ? t('dashboard.pvtProjectionNonFinal')
                                : t('dashboard.participationActions')}
                        </Text>
                        {showsProjection && (
                            <InfoButton onPress={() => setInfoVisible(true)} />
                        )}
                    </View>
                </View>

                {/* Divider */}
                <View style={styles.divider} />

                {/* Secondary: the PE count alongside a projection, else this-week
                    activity so the second slot stays meaningful (not a repeat). */}
                <View style={styles.statBlock}>
                    {isLoading ? (
                        <View style={styles.skeleton} />
                    ) : (
                        <Text style={[styles.statValue, styles.statValueRecord]}>
                            {showsProjection ? fmt(peCount) : fmt(weeklyPEs)}
                        </Text>
                    )}
                    <Text style={styles.statLabel}>
                        {showsProjection
                            ? t('dashboard.participationActions')
                            : t('provenanceDashboard.thisWeek')}
                    </Text>
                </View>
            </View>
            )}

            {/* Bottom row: navigation affordance into the PE chain viewer. The
                per-envelope attestation tier is shown there, next to each PE
                where it has context — not collapsed into a single most-recent
                summary badge here, which misrepresented a mixed chain. */}
            <View style={styles.bottomRow}>
                {(retry || onPress) && (
                    <View style={styles.viewChainLink}>
                        <Text style={styles.viewChainText}>{retry ? t('common.tryAgain') : t('dashboard.viewChain')}</Text>
                        <Ionicons name={retry ? 'refresh' : 'chevron-forward'} size={14} color={COLORS.primary} />
                    </View>
                )}
            </View>
        </TouchableOpacity>
        <InfoModal
            visible={infoVisible}
            onClose={() => setInfoVisible(false)}
            title={t('pvtProjectionInfo.title')}
            body={t('pvtProjectionInfo.body')}
        />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        borderRadius: 22,
        padding: SPACING.l,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
        backgroundColor: 'rgba(17,24,39,0.85)',
        overflow: 'hidden',
        ...SHADOWS.small,
    },
    statsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    statBlock: {
        flex: 1,
        alignItems: 'center',
    },
    // Weight caps at 600 by design — hierarchy comes from size and spacing.
    statValue: {
        fontSize: 36,
        fontWeight: '600',
        marginBottom: 4,
        letterSpacing: -0.5,
    },
    // A PVT amount is the ASSET → platinum (theme.ts: PLATINUM OWNS THE ASSET,
    // AMBER OWNS THE MOMENT). The amber moment lives on the abundance tiles.
    statValueMoney: {
        color: COLORS.platinum,
    },
    statValueRecord: {
        color: COLORS.text,
    },
    statLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    statLabel: {
        fontSize: 12,
        color: COLORS.textTertiary,
        fontWeight: '500',
        letterSpacing: 0.5,
        textAlign: 'center',
    },
    divider: {
        width: 1,
        height: 48,
        backgroundColor: COLORS.glassBorder,
        marginHorizontal: SPACING.m,
    },
    skeleton: {
        width: 72,
        height: 36,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.surfaceHighlight,
        marginBottom: 4,
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.m,
        marginBottom: SPACING.m,
    },
    errorText: {
        fontSize: 13,
        color: COLORS.textTertiary,
        fontWeight: '500',
    },
    bottomRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
    },
    viewChainLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    viewChainText: {
        fontSize: 13,
        color: COLORS.primary,
        fontWeight: '600',
    },
});

export default ParticipationCard;
