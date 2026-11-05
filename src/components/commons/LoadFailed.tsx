/**
 * LoadFailed — what a Commons list shows when it could not be loaded.
 *
 * A failed load is never shown as an empty list: "nothing here yet" and "could not reach Provian"
 * are different facts, and a person (or a reviewer) must be able to tell them apart and retry.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';

export function LoadFailed({ onRetry }: { readonly onRetry: () => void }): React.ReactElement {
    const { t } = useTranslation();
    return (
        <View style={styles.box} accessibilityRole="alert">
            <Ionicons name="cloud-offline-outline" size={32} color={COLORS.textTertiary} />
            <Text style={styles.title}>{t('commons.loadFailedTitle')}</Text>
            <Text style={styles.body}>{t('commons.loadFailedBody')}</Text>
            <TouchableOpacity style={styles.retry} onPress={onRetry} accessibilityRole="button">
                <Text style={styles.retryText}>{t('common.tryAgain')}</Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    box: { alignItems: 'center', paddingVertical: SPACING.xl, paddingHorizontal: SPACING.l },
    title: { fontSize: 16, fontWeight: '600', color: COLORS.text, marginTop: SPACING.s, textAlign: 'center' },
    body: { fontSize: 13, color: COLORS.textSecondary, marginTop: SPACING.xs, textAlign: 'center', lineHeight: 18 },
    retry: { marginTop: SPACING.m, paddingVertical: SPACING.s, paddingHorizontal: SPACING.l, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.borderLight },
    retryText: { fontSize: 14, fontWeight: '600', color: COLORS.text },
});

export default LoadFailed;
