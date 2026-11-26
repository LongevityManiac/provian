/** Draws the app's alerts in a browser (see webAlert.ts). */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, StyleSheet, ScrollView } from 'react-native';
import { ActionTouchable } from '../../components/ScreenActions';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { dismissWebAlert, pressWebAlert, subscribeWebAlerts, type WebAlert } from './webAlert';

export default function WebAlertHost(): React.ReactElement | null {
    const [alert, setAlert] = useState<WebAlert | null>(null);
    useEffect(() => subscribeWebAlerts(setAlert), []);
    if (!alert) return null;
    return (
        <Modal visible transparent animationType="fade" onRequestClose={() => dismissWebAlert(alert.id)}>
            <View style={styles.backdrop}>
                <View style={styles.card} accessibilityRole="alert">
                    {!!alert.title && <Text style={styles.title}>{alert.title}</Text>}
                    {!!alert.message && (
                        <ScrollView style={styles.messageBox}><Text style={styles.message}>{alert.message}</Text></ScrollView>
                    )}
                    <View style={styles.buttons}>
                        {alert.buttons.map((button, index) => (
                            <ActionTouchable
                                key={`${alert.id}-${index}`}
                                style={[styles.button, button.style === 'cancel' ? styles.cancel : button.style === 'destructive' ? styles.destructive : styles.primary]}
                                onPress={() => pressWebAlert(alert.id, index)}
                            >
                                <Text style={[styles.buttonText, button.style === 'cancel' ? styles.cancelText : styles.primaryText]}>{button.text ?? 'OK'}</Text>
                            </ActionTouchable>
                        ))}
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(5, 8, 14, 0.78)', alignItems: 'center', justifyContent: 'center', padding: SPACING.m },
    card: { width: '100%', maxWidth: 440, backgroundColor: COLORS.surfaceElevated, borderRadius: BORDER_RADIUS.l, padding: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 18, fontFamily: 'Inter_600SemiBold', marginBottom: SPACING.s },
    messageBox: { maxHeight: 320, marginBottom: SPACING.m },
    message: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22 },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: SPACING.s },
    button: { borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s, paddingHorizontal: SPACING.m, minWidth: 96, alignItems: 'center' },
    primary: { backgroundColor: COLORS.primary },
    destructive: { backgroundColor: COLORS.error },
    cancel: { backgroundColor: COLORS.surfaceHighlight },
    buttonText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    primaryText: { color: COLORS.onPrimary },
    cancelText: { color: COLORS.chrome },
});
