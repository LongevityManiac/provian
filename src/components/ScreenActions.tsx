import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, View, type PressableProps, type StyleProp, type TouchableOpacityProps, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import ProvianIcon, { type ProvianIconName } from './ProvianIcon';

type Ionicon = keyof typeof Ionicons.glyphMap;

export const ActionPressable = React.forwardRef<React.ComponentRef<typeof Pressable>, PressableProps>(function ActionPressable(props, ref) {
    return <Pressable accessibilityRole={props.onPress ? 'button' : undefined} {...props} ref={ref} />;
});

export const ActionTouchable = React.forwardRef<React.ComponentRef<typeof TouchableOpacity>, TouchableOpacityProps>(function ActionTouchable(props, ref) {
    return <TouchableOpacity accessibilityRole={props.onPress ? 'button' : undefined} activeOpacity={0.75} {...props} ref={ref} />;
});

interface ButtonProps {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    style?: StyleProp<ViewStyle>;
    icon?: ProvianIconName;
    stockIcon?: Ionicon;
    accessibilityLabel?: string;
    testID?: string;
    stacked?: boolean;
}

function Button({ label, onPress, disabled, busy, style, icon, stockIcon, accessibilityLabel, testID, stacked, filled }: ButtonProps & { filled: boolean }) {
    const foreground = filled ? COLORS.onPrimary : COLORS.primaryLight;
    return (
        <ActionPressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} testID={testID}
            accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy}
            onPress={onPress} style={({ pressed }) => [styles.button, stacked && styles.stacked,
                filled ? styles.primary : styles.secondary, (pressed || disabled) && styles.dimmed, style]}>
            {busy ? <ActivityIndicator size="small" color={foreground} /> : <>
                {icon && <ProvianIcon name={icon} size={22} color={foreground} />}
                {stockIcon && <Ionicons name={stockIcon} size={20} color={foreground} />}
            </>}
            <Text style={[styles.buttonLabel, stacked && styles.stackedLabel, { color: foreground }]}>{label}</Text>
        </ActionPressable>
    );
}

export function PrimaryAction(props: ButtonProps) { return <Button {...props} filled />; }
export function SecondaryAction(props: ButtonProps) { return <Button {...props} filled={false} />; }

export function ChoiceChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
    return <ActionPressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
        style={[styles.chip, selected && styles.chipSelected]}>
        <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </ActionPressable>;
}

export function DestinationRow({ label, detail, icon, stockIcon, onPress, chevron = true, leading, end, busy, testID }: {
    label: string; detail?: string; icon?: ProvianIconName; stockIcon?: Ionicon;
    onPress?: () => void; chevron?: boolean; leading?: React.ReactNode; end?: React.ReactNode; busy?: boolean; testID?: string;
}) {
    const content = (
        <>
            {leading}
            {icon && <ProvianIcon name={icon} size={26} color={COLORS.primaryLight} />}
            {stockIcon && <Ionicons name={stockIcon} size={22} color={COLORS.primaryLight} />}
            <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{label}</Text>
                {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            </View>
            {end}
            {busy ? <ActivityIndicator size="small" color={COLORS.textMuted} />
                : onPress && chevron && <Ionicons name="chevron-forward" size={17} color={COLORS.textTertiary} />}
        </>
    );
    return onPress
        ? <ActionPressable accessibilityRole="button" testID={testID} onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.dimmed]}>{content}</ActionPressable>
        : <View style={styles.row} testID={testID} accessibilityState={{ busy }}>{content}</View>;
}

export const actionStyles = StyleSheet.create({
    onPrimary: { color: COLORS.onPrimary },
    money: { fontVariant: ['tabular-nums'] },
    sectionTitle: { color: COLORS.text, fontSize: 19, fontWeight: '700' },
    body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 22 },
});

const styles = StyleSheet.create({
    button: {
        minHeight: 48, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.m, paddingHorizontal: SPACING.l,
        flexDirection: 'row', gap: SPACING.xs, justifyContent: 'center', alignItems: 'center',
    },
    primary: { backgroundColor: COLORS.primary },
    stacked: { flexDirection: 'column', paddingHorizontal: SPACING.xs, minHeight: 68 },
    stackedLabel: { fontSize: 13 },
    secondary: { borderColor: COLORS.border, borderWidth: 1 },
    buttonLabel: { flexShrink: 1, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: SPACING.s + 2, borderRadius: BORDER_RADIUS.round },
    chipSelected: { backgroundColor: COLORS.primaryMuted },
    chipLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
    chipLabelSelected: { color: COLORS.primaryLight },
    dimmed: { opacity: 0.7 },
    row: {
        flexDirection: 'row', alignItems: 'center', minHeight: 54, paddingVertical: SPACING.s,
        gap: SPACING.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text },
    detail: { fontSize: 13, lineHeight: 18, marginTop: 3, color: COLORS.textSecondary },
});
