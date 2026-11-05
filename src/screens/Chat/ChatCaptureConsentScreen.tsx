/**
 * ChatCaptureConsentScreen: consent gate shown on first use of the Chat
 * tab. Rendered inline by ChatHomeScreen when the persisted consent
 * value is `null`. Accept / Decline persist via `setMobileChatConsent`.
 *
 * M6 shipped the single-page wrapper consent: Accept persists `true`
 * for the wrapper capture path, Decline persists `false`. The parent
 * (ChatHomeScreen) owns that persistence.
 *
 * M7 added an Android-only second page (UsageStats consent for AI apps
 * outside the wrapper). It was REMOVED : Android
 * out-of-app capture is not live, so no build shows consent for it. Accept
 * goes straight to `onAccept` on every platform.
 *
 * Mirrors the desktop consent text from
 * `provian-agent-sdk/src/scripts/llm-session-consent.ts`, adapted for the
 * mobile WebView surface. See design notes docs/PHASE_2C_DESIGN_NOTES.md
 * §5.M6 and §5.M7.
 */

import React from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';

export interface ChatCaptureConsentScreenProps {
    onAccept: () => void;
    onDecline: () => void;
}

// Vertical space the floating tab bar occupies above the bottom safe area
// (FloatingTabBar: ~68px bar + 12px float offset). The action bar adds this
// as bottom margin so its buttons sit above the tab bar rather than behind it.
const FLOATING_TAB_BAR_CLEARANCE = 90;

const READS_ITEM_KEYS: string[] = [
    'chatCaptureConsent.readsProvider',
    'chatCaptureConsent.readsTimes',
    'chatCaptureConsent.readsTurns',
    'chatCaptureConsent.readsAttachments',
    'chatCaptureConsent.readsKeyboard',
];

const NEVER_ITEM_KEYS: string[] = [
    'chatCaptureConsent.neverContent',
    'chatCaptureConsent.neverReplies',
    'chatCaptureConsent.neverPages',
    'chatCaptureConsent.neverTyping',
];

const ChatCaptureConsentScreen: React.FC<ChatCaptureConsentScreenProps> = ({
    onAccept,
    onDecline,
}) => {
    const { t } = useTranslation();

    return (
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={styles.root}>
            <StatusBar barStyle="light-content" />
            <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
                <ScrollView
                    contentContainerStyle={styles.content}
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.iconWrap}>
                        <Ionicons
                            name="chatbubbles-outline"
                            size={40}
                            color={COLORS.primary}
                        />
                    </View>

                    <Text style={styles.title}>{t('chatCaptureConsent.title')}</Text>
                    <Text style={styles.lead}>
                        {t('chatCaptureConsent.lead')}
                    </Text>

                    <Section
                        heading={t('chatCaptureConsent.whatReads')}
                        accent={COLORS.primary}
                        icon="eye-outline"
                        items={READS_ITEM_KEYS.map((k) => t(k))}
                    />
                    <Section
                        heading={t('chatCaptureConsent.whatNeverReads')}
                        accent={COLORS.textTertiary}
                        icon="eye-off-outline"
                        items={NEVER_ITEM_KEYS.map((k) => t(k))}
                    />

                    <Text style={styles.optOut}>
                        {t('chatCaptureConsent.optOut')}
                    </Text>
                </ScrollView>

                <View style={styles.actions}>
                    <TouchableOpacity
                        style={[styles.button, styles.declineButton]}
                        onPress={onDecline}
                        accessibilityRole="button"
                        accessibilityLabel={t('chatCaptureConsent.declineLabel')}
                    >
                        <Text style={styles.declineText}>{t('chatCaptureConsent.decline')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.button, styles.acceptButton]}
                        onPress={onAccept}
                        accessibilityRole="button"
                        accessibilityLabel={t('chatCaptureConsent.acceptLabel')}
                    >
                        <Text style={styles.acceptText}>{t('chatCaptureConsent.accept')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        </LinearGradient>
    );
};

interface SectionProps {
    heading: string;
    icon: keyof typeof Ionicons.glyphMap;
    accent: string;
    items: string[];
}

const Section: React.FC<SectionProps> = ({ heading, icon, accent, items }) => (
    <View style={styles.section}>
        <View style={styles.sectionHeadingRow}>
            <Ionicons name={icon} size={18} color={accent} />
            <Text style={[styles.sectionHeading, { color: accent }]}>{heading}</Text>
        </View>
        {items.map((item, idx) => (
            <View key={idx} style={styles.itemRow}>
                <View style={[styles.bullet, { backgroundColor: accent }]} />
                <Text style={styles.itemText}>{item}</Text>
            </View>
        ))}
    </View>
);

const styles = StyleSheet.create({
    root: { flex: 1 },
    safe: { flex: 1 },
    content: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.l,
        paddingBottom: SPACING.m,
    },
    iconWrap: {
        alignSelf: 'center',
        width: 72,
        height: 72,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: COLORS.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    title: {
        color: COLORS.text,
        fontSize: 26,
        fontWeight: '700',
        letterSpacing: -0.4,
        textAlign: 'center',
    },
    lead: {
        color: COLORS.textSecondary,
        fontSize: 15,
        lineHeight: 22,
        marginTop: SPACING.m,
        marginBottom: SPACING.l,
    },
    section: {
        backgroundColor: COLORS.surface,
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
    },
    sectionHeadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.s,
    },
    sectionHeading: {
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.5,
        marginLeft: SPACING.s,
        textTransform: 'uppercase',
    },
    itemRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginTop: SPACING.xs,
    },
    bullet: {
        width: 6,
        height: 6,
        borderRadius: 3,
        marginTop: 8,
        marginRight: SPACING.s,
    },
    itemText: {
        flex: 1,
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 20,
    },
    optOut: {
        color: COLORS.textTertiary,
        fontSize: 13,
        lineHeight: 18,
        fontStyle: 'italic',
        marginTop: SPACING.s,
        marginBottom: SPACING.l,
    },
    actions: {
        flexDirection: 'row',
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        gap: SPACING.s,
        // This screen renders inside the Chat tab, whose tab bar floats
        // (position: absolute) ~80px above the bottom safe area. Without
        // this clearance the Accept / Decline buttons render behind the
        // tab bar and can't be tapped. See TabNavigator FloatingTabBar.
        marginBottom: FLOATING_TAB_BAR_CLEARANCE,
    },
    button: {
        flex: 1,
        flexBasis: 0,
        // Both buttons carry the same 1pt border so their boxes match exactly.
        borderWidth: 1,
        paddingVertical: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
        justifyContent: 'center',
    },
    declineButton: {
        backgroundColor: 'transparent',
        borderColor: COLORS.border,
    },
    acceptButton: {
        backgroundColor: COLORS.primary,
        borderColor: COLORS.primary,
    },
    declineText: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
    },
    acceptText: {
        color: COLORS.white,
        fontSize: 16,
        fontWeight: '700',
        textAlign: 'center',
    },
});

export default ChatCaptureConsentScreen;
