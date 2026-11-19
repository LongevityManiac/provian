import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import ProvianIcon, { type ProvianIconName } from './ProvianIcon';

type Ionicon = keyof typeof Ionicons.glyphMap;

export function PrimaryAction({ label, onPress, disabled, style }: {
    label: string; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
    return (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
            onPress={onPress} style={({ pressed }) => [styles.primary, (pressed || disabled) && styles.dimmed, style]}>
            <Text style={styles.primaryLabel}>{label}</Text>
        </Pressable>
    );
}

export function DestinationRow({ label, detail, icon, stockIcon, onPress, chevron = true }: {
    label: string; detail?: string; icon?: ProvianIconName; stockIcon?: Ionicon;
    onPress?: () => void; chevron?: boolean;
}) {
    const content = (
        <>
            {icon && <ProvianIcon name={icon} size={26} color={COLORS.primaryLight} />}
            {stockIcon && <Ionicons name={stockIcon} size={22} color={COLORS.primaryLight} />}
            <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{label}</Text>
                {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            </View>
            {onPress && chevron && <Ionicons name="chevron-forward" size={17} color={COLORS.textTertiary} />}
        </>
    );
    return onPress
        ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.dimmed]}>{content}</Pressable>
        : <View style={styles.row}>{content}</View>;
}

export const actionStyles = StyleSheet.create({
    money: { fontVariant: ['tabular-nums'] },
    sectionTitle: { color: COLORS.text, fontSize: 19, fontWeight: '700' },
    body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 22 },
});

const styles = StyleSheet.create({
    primary: {
        minHeight: 48, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.m, paddingHorizontal: SPACING.l,
        backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center',
    },
    primaryLabel: { color: COLORS.background, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    dimmed: { opacity: 0.7 },
    row: {
        flexDirection: 'row', alignItems: 'center', minHeight: 54, paddingVertical: SPACING.s,
        gap: SPACING.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text },
    detail: { fontSize: 13, lineHeight: 18, marginTop: 3, color: COLORS.textSecondary },
});
