import { useTranslation } from 'react-i18next';
import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    GestureResponderEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

/**
 * A small, themed bottom-sheet modal for short "What's this?" explanations.
 *
 * Deliberately generic: it shows a title + body of explanatory copy and a
 * single close affordance. It is NOT a confirmation dialog and takes no
 * actions — callers own the `visible` state and pass already-translated copy.
 *
 * Mirrors the transparent bottom-sheet pattern used by ProfileAvatarPicker so
 * the app keeps one modal look, and uses the design system in theme.ts (no
 * third-party UI libraries).
 */
export interface InfoModalProps {
    visible: boolean;
    onClose: () => void;
    title: string;
    body: string;
}

export const InfoModal: React.FC<InfoModalProps> = ({ visible, onClose, title, body }) => {
    const { t } = useTranslation();
    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={true}
            onRequestClose={onClose}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
            >
                {/* Inner press is swallowed so tapping the sheet does not close it. */}
                <TouchableOpacity style={styles.sheet} activeOpacity={1} onPress={() => {}}>
                    <View style={styles.header}>
                        <Text style={styles.title}>{title}</Text>
                        <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                            <Ionicons name="close" size={24} color={COLORS.text} />
                        </TouchableOpacity>
                    </View>
                    <ScrollView contentContainerStyle={styles.bodyContainer}>
                        <Text style={styles.body}>{body}</Text>
                    </ScrollView>
                </TouchableOpacity>
            </TouchableOpacity>
        </Modal>
    );
};

/**
 * A small tappable (i) trigger to place next to a label. Stops propagation so
 * it can sit inside a card that is itself pressable (e.g. the dashboard hero,
 * which navigates on press) without triggering that outer press.
 */
export interface InfoButtonProps {
    onPress: () => void;
    color?: string;
    size?: number;
    accessibilityLabel?: string;
}

export const InfoButton: React.FC<InfoButtonProps> = ({
    onPress,
    color = COLORS.textTertiary,
    size = 15,
    accessibilityLabel,
}) => {
    const { t } = useTranslation();
    const handlePress = (e: GestureResponderEvent) => {
        e.stopPropagation();
        onPress();
    };
    return (
        <TouchableOpacity
            onPress={handlePress}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? t('envelope.whatIsThis')}
            style={styles.infoButton}
        >
            <Ionicons name="information-circle-outline" size={size} color={color} />
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        maxHeight: '70%',
        backgroundColor: 'rgba(18,21,26,0.96)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderBottomWidth: 0,
        paddingBottom: SPACING.xl,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.l,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    title: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        flexShrink: 1,
        marginRight: SPACING.m,
    },
    bodyContainer: {
        padding: SPACING.l,
    },
    body: {
        fontSize: 15,
        lineHeight: 22,
        color: COLORS.textSecondary,
    },
    infoButton: {
        marginLeft: SPACING.xs,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
