/**
 * ChatWebViewScreen, web app. The phone app opens an AI chat site inside itself and records each
 * conversation as it happens. A browser page cannot look inside another site's tab, so the web
 * app records no chat: it says so, opens the site in a new tab if the person wants it, and points
 * to the phone app for chat capture. Everything else the person's work earns, it earns here too.
 */
import React from 'react';
import { View, Text, StyleSheet, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';

export default function ChatWebViewScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation<{ goBack(): void; navigate(name: string): void }>();
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /></View>
            <View style={styles.content}>
                <View style={styles.icon}><Ionicons name="phone-portrait-outline" size={40} color={COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{t('webApp.chat.title')}</Text>
                <Text style={styles.body}>{t('webApp.chat.body')}</Text>
                <ActionTouchable style={styles.primary} onPress={() => navigation.navigate('AddYourPhone')}>
                    <Text style={styles.primaryText}>{t('webApp.chat.getPhoneApp')}</Text>
                </ActionTouchable>
                <ActionTouchable style={styles.secondary} onPress={() => { void Linking.openURL('https://provian.ai/download'); }}>
                    <Text style={styles.secondaryText}>{t('webApp.chat.download')}</Text>
                </ActionTouchable>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { paddingHorizontal: SPACING.l, paddingTop: SPACING.s },
    content: { flex: 1, paddingHorizontal: SPACING.l, justifyContent: 'center', maxWidth: 520, width: '100%', alignSelf: 'center' },
    icon: { width: 80, height: 80, borderRadius: 40, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 24, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.xl },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center', marginBottom: SPACING.s },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    secondary: { paddingVertical: SPACING.m, alignItems: 'center' },
    secondaryText: { color: COLORS.primary, fontSize: 15 },
});
