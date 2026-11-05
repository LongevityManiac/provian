/**
 * ChatHomeScreen: provider picker for the Chat tab.
 *
 * M6 gates the picker behind a persisted consent value. The first time a
 * user taps the Chat tab, ChatCaptureConsentScreen renders inline. Accept
 * persists `true` and shows the picker; Decline persists `false` and
 * shows the Declined state with a link to Settings. The consent row in
 * Settings can flip either decision at any time; this screen re-reads
 * the value on focus so toggles take effect on next tab visit.
 *
 * See design notes docs/PHASE_2C_DESIGN_NOTES.md §5.M6.
 */

import React, { useCallback, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    StatusBar,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { PROVIDER_CATALOG, ENABLED_PROVIDERS } from '../../core/capture/catalog';
import { getProvider } from '../../core/capture/ProviderCatalog';
import type { IoniconsName } from '../../types/icons';
import {
    getMobileChatConsent,
    setMobileChatConsent,
    chatHomeGate,
    type MobileChatConsent,
} from '../../core/capture/mobileChatConsent';
import ChatCaptureConsentScreen from './ChatCaptureConsentScreen';

interface ProviderPresentation {
    id: string;
    title: string;
    subtitle: string;
    icon: IoniconsName;
    accent: string;
}

const PRESENTATIONS: Record<string, ProviderPresentation> = {
    claude: {
        id: 'claude',
        title: 'Claude',
        subtitle: 'claude.ai',
        icon: 'chatbubble-ellipses-outline',
        accent: '#D4A373',
    },
    chatgpt: {
        id: 'chatgpt',
        title: 'ChatGPT',
        subtitle: 'chatgpt.com',
        icon: 'chatbubbles-outline',
        accent: '#10A37F',
    },
    gemini: {
        id: 'gemini',
        title: 'Gemini',
        subtitle: 'gemini.google.com',
        icon: 'sparkles-outline',
        accent: '#4285F4',
    },
    perplexity: {
        id: 'perplexity',
        title: 'Perplexity',
        subtitle: 'perplexity.ai',
        icon: 'search-outline',
        accent: '#20B8A6',
    },
    grok: {
        id: 'grok',
        title: 'Grok',
        subtitle: 'grok.com',
        icon: 'flash-outline',
        accent: '#9AA3B2',
    },
    venice: {
        id: 'venice',
        title: 'Venice',
        subtitle: 'venice.ai',
        icon: 'boat-outline',
        accent: '#C8102E',
    },
};

type Nav = NativeStackNavigationProp<AppParamList>;

const ChatHomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<Nav>();
    const [consent, setConsent] = useState<MobileChatConsent | 'loading'>('loading');

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            getMobileChatConsent().then(value => {
                if (!cancelled) setConsent(value);
            });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const handleAccept = useCallback(async () => {
        await setMobileChatConsent(true);
        setConsent(true);
    }, []);

    const handleDecline = useCallback(async () => {
        await setMobileChatConsent(false);
        setConsent(false);
    }, []);

    const goToSettings = useCallback(() => {
        navigation.navigate('Settings');
    }, [navigation]);

    const gate = chatHomeGate(consent);

    if (gate === 'loading') {
        return (
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={styles.root}>
                <SafeAreaView style={styles.safe} edges={['top']}>
                    <View style={styles.loader}>
                        <ActivityIndicator color={COLORS.primary} size="small" />
                    </View>
                </SafeAreaView>
            </LinearGradient>
        );
    }

    if (gate === 'decision') {
        return (
            <ChatCaptureConsentScreen
                onAccept={handleAccept}
                onDecline={handleDecline}
            />
        );
    }

    if (gate === 'declined') {
        return (
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={styles.root}>
                <StatusBar barStyle="light-content" />
                <SafeAreaView style={styles.safe} edges={['top']}>
                    <View style={styles.header}>
                        <Text style={styles.title}>{t('chatHome.title')}</Text>
                        <Text style={styles.subtitle}>
                            {t('chatHome.captureOff')}
                        </Text>
                    </View>
                    <View style={styles.declinedBody}>
                        <View style={styles.declinedIconWrap}>
                            <Ionicons
                                name="chatbubbles-outline"
                                size={36}
                                color={COLORS.textTertiary}
                            />
                        </View>
                        <Text style={styles.declinedTitle}>
                            {t('chatHome.declinedTitle')}
                        </Text>
                        <Text style={styles.declinedCopy}>
                            {t('chatHome.declinedCopy')}
                        </Text>
                        <TouchableOpacity
                            style={styles.declinedButton}
                            onPress={goToSettings}
                            accessibilityRole="button"
                            accessibilityLabel={t('chatHome.enableInSettingsLabel')}
                        >
                            <Text style={styles.declinedButtonText}>
                                {t('chatHome.enableInSettings')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </LinearGradient>
        );
    }

    // gate === 'picker'
    const providers = ENABLED_PROVIDERS
        .map(id => {
            const entry = getProvider(id, PROVIDER_CATALOG);
            const presentation = PRESENTATIONS[id];
            if (!entry || !presentation) return null;
            return { entry, presentation };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

    return (
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={styles.root}>
            <StatusBar barStyle="light-content" />
            <SafeAreaView style={styles.safe} edges={['top']}>
                <View style={styles.header}>
                    <Text style={styles.title}>{t('chatHome.title')}</Text>
                    <Text style={styles.subtitle}>
                        {t('chatHome.pickerSubtitle')}
                    </Text>
                </View>

                <ScrollView
                    contentContainerStyle={styles.list}
                    showsVerticalScrollIndicator={false}
                >
                    {providers.map(({ entry, presentation }) => (
                        <TouchableOpacity
                            key={presentation.id}
                            style={styles.card}
                            activeOpacity={0.85}
                            onPress={() =>
                                navigation.navigate('ChatWebView', { providerId: entry.provider })
                            }
                            accessibilityRole="button"
                            accessibilityLabel={t('chatHome.openProvider', { name: presentation.title })}
                        >
                            <View
                                style={[
                                    styles.iconBadge,
                                    { backgroundColor: `${presentation.accent}20` },
                                ]}
                            >
                                <Ionicons
                                    name={presentation.icon}
                                    size={24}
                                    color={presentation.accent}
                                />
                            </View>
                            <View style={styles.cardBody}>
                                <Text style={styles.cardTitle}>{presentation.title}</Text>
                                <Text style={styles.cardSubtitle}>{presentation.subtitle}</Text>
                            </View>
                            <Ionicons
                                name="chevron-forward"
                                size={20}
                                color={COLORS.textTertiary}
                            />
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            </SafeAreaView>
        </LinearGradient>
    );
};

const styles = StyleSheet.create({
    root: {
        flex: 1,
    },
    safe: {
        flex: 1,
    },
    loader: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    header: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.l,
        paddingBottom: SPACING.m,
    },
    title: {
        color: COLORS.text,
        fontSize: 32,
        fontWeight: '700',
        letterSpacing: -0.5,
    },
    subtitle: {
        color: COLORS.textSecondary,
        fontSize: 15,
        marginTop: SPACING.xs,
    },
    list: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.xxxl * 2,
    },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderRadius: 20,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
    },
    iconBadge: {
        width: 48,
        height: 48,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    cardBody: {
        flex: 1,
    },
    cardTitle: {
        color: COLORS.text,
        fontSize: 17,
        fontWeight: '600',
    },
    cardSubtitle: {
        color: COLORS.textSecondary,
        fontSize: 13,
        marginTop: 2,
    },
    declinedBody: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SPACING.l,
    },
    declinedIconWrap: {
        width: 72,
        height: 72,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    declinedTitle: {
        color: COLORS.text,
        fontSize: 20,
        fontWeight: '600',
        textAlign: 'center',
    },
    declinedCopy: {
        color: COLORS.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
        marginTop: SPACING.m,
        marginBottom: SPACING.l,
    },
    declinedButton: {
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        backgroundColor: COLORS.primary,
    },
    declinedButtonText: {
        color: COLORS.white,
        fontSize: 15,
        fontWeight: '600',
    },
});

export default ChatHomeScreen;
