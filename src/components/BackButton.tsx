import React from 'react';
import { TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, BORDER_RADIUS } from '../constants/theme';

/** Width of the back button, for the matching right-hand spacer that keeps a header title centered. */
export const BACK_BUTTON_SIZE = 44;

/**
 * The app's one back button: a 44pt circle with a hairline border. Screens that
 * center a header title put a `BACK_BUTTON_SIZE`-wide spacer on the right.
 */
export default function BackButton({
    onPress,
    style,
    color = COLORS.text,
    accessibilityLabel,
}: {
    onPress: () => void;
    style?: StyleProp<ViewStyle>;
    color?: string;
    accessibilityLabel?: string;
}): React.JSX.Element {
    const { t } = useTranslation();
    return (
        <TouchableOpacity
            style={[styles.button, style]}
            onPress={onPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? t('common.back')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
            <Ionicons name="arrow-back" size={22} color={color} />
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    button: {
        width: BACK_BUTTON_SIZE,
        height: BACK_BUTTON_SIZE,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
});
