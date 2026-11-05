/**
 * DispositionChip — the ONE renderer for a PE's earning-disposition chip.
 *
 * Renders "Earns ~X PVT · pending" / "Pending" / "Record only" / "Minted ✓" from a
 * chip built by `buildEarningChip` / `chipForDisposition`. The amount, when the
 * chip carries one, is the eligible-only settlement projection — NEVER a
 * record-points sum, which is not PVT.
 *
 * Renders NOTHING for a null chip (unknown/legacy disposition), so a row with no
 * sealed mint_status makes no earning claim rather than an unfounded one.
 *
 * Two sizes, ONE component (never a second chip renderer that can drift
 * from this one): `row` for a compact list row, `detail` for a detail-page block.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SPACING, BORDER_RADIUS } from '../constants/theme';
import type { EarningChip } from '../utils/peDisposition';

export function DispositionChip({ chip, size = 'row' }: {
    chip: EarningChip | null;
    size?: 'row' | 'detail';
}) {
    if (!chip) return null;
    const isDetail = size === 'detail';
    const isComplianceHold = chip.explainerKey === 'pe.disposition.complianceHold.explainer';
    return (
        <View
            accessibilityLabel={chip.label}
            accessibilityHint={isComplianceHold ? chip.explainer : undefined}
            style={[
                isDetail ? styles.detailChip : styles.rowChip,
                { backgroundColor: chip.backgroundColor, borderColor: `${chip.color}55` },
            ]}
        >
            <Text
                style={[isDetail ? styles.detailChipText : styles.rowChipText, { color: chip.color }]}
                numberOfLines={1}
            >
                {chip.label}
            </Text>
            {isDetail && isComplianceHold && chip.explainer && (
                <Text style={styles.explainer}>{chip.explainer}</Text>
            )}
        </View>
    );
}

export default DispositionChip;

const styles = StyleSheet.create({
    rowChip: {
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        borderWidth: 1,
        flexShrink: 1,
    },
    rowChipText: {
        fontSize: 11,
        fontWeight: '600',
    },
    detailChip: {
        alignSelf: 'flex-start',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        marginBottom: SPACING.s,
    },
    detailChipText: {
        fontSize: 13,
        fontWeight: '700',
    },
    explainer: {
        fontSize: 13,
        lineHeight: 19,
        marginTop: SPACING.xs,
        color: '#9CA3AF',
    },
});
