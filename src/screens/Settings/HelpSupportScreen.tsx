import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { isGenesisWindowOpen } from '../Onboarding/genesisWindow';
import { HELP_FAQ } from './helpFaq.generated';

interface FAQItem {
    question: string;
    answer: string;
}

interface FAQCategory {
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    items: FAQItem[];
}

/** Icon per FAQ section key; a section without one shows the help icon. */
const SECTION_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    gettingStarted: 'rocket',
    pvtAndProvenance: 'shield-checkmark',
    aiAgents: 'hardware-chip',
    promises: 'document-text',
    theCommons: 'globe',
    securityAndRecovery: 'lock-closed',
    walletAndAssets: 'wallet',
    dataAndAccount: 'person',
};

/**
 * The FAQ, in the order and wording of docs/help/faq.md (generated into HELP_FAQ and en.json by
 * scripts/generate-help-faq.mjs). The Genesis grant sentences ride the same window as every other
 * Genesis surface (genesisWindow.ts): they come down on their own at the close.
 */
const useFaqData = (): FAQCategory[] => {
    const { t } = useTranslation();
    const genesisOpen = isGenesisWindowOpen();
    return HELP_FAQ.map((section) => ({
        title: t(section.titleKey),
        icon: SECTION_ICONS[section.key] ?? 'help-circle',
        items: section.items.map((item) => ({
            question: t(item.questionKey),
            answer: t(genesisOpen && item.genesisAnswerKey ? item.genesisAnswerKey : item.answerKey),
        })),
    }));
};

const HelpSupportScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    const ALL_FAQ_DATA = useFaqData();
    const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

    const handleOpenManual = async () => {
        // The canonical published Manual in the Library.
        const url = 'https://provian.ai/library/manual/';
        try {
            if (await Linking.canOpenURL(url)) {
                await Linking.openURL(url);
                return;
            }
        } catch {
            // fall through to surfacing the URL so the user can still reach it
        }
        Alert.alert(t('help.manual'), url, [{ text: t('common.ok') }]);
    };

    const handleContactSupport = async () => {
        const url = 'mailto:hello@provian.ai?subject=Provian%20Support';
        const canOpen = await Linking.canOpenURL(url);
        if (canOpen) {
            Linking.openURL(url);
        } else {
            Alert.alert(t('help.contactSupport'), t('help.contactSupportMsg'), [{ text: t('common.ok') }]);
        }
    };

    const handleReportBug = async () => {
        const url = 'mailto:hello@provian.ai?subject=Bug%20Report%20-%20Provian';
        const canOpen = await Linking.canOpenURL(url);
        if (canOpen) {
            Linking.openURL(url);
        } else {
            Alert.alert(t('help.reportBug'), t('help.reportBugMsg'), [{ text: t('common.ok') }]);
        }
    };

    const handleSuggestFeature = async () => {
        const url = 'mailto:hello@provian.ai?subject=Feature%20Suggestion%20-%20Provian&body=Hi%20Provian%20team%2C%0A%0AI%20have%20a%20suggestion%20for%20the%20app%3A%0A%0A';
        const canOpen = await Linking.canOpenURL(url);
        if (canOpen) {
            Linking.openURL(url);
        } else {
            Alert.alert(t('help.suggestFeature'), t('help.suggestFeatureMsg'), [{ text: t('common.ok') }]);
        }
    };

    const SupportItem = ({ icon, title, description, onPress, iconColor }: any) => (
        <TouchableOpacity style={styles.supportCard} onPress={onPress}>
            <View style={[styles.iconContainer, { backgroundColor: iconColor ? `${iconColor}12` : 'rgba(74,142,232,0.08)' }]}>
                <Ionicons name={icon} size={24} color={iconColor || '#4A8EE8'} />
            </View>
            <View style={styles.supportInfo}>
                <Text style={styles.supportTitle}>{title}</Text>
                <Text style={styles.supportDescription}>{description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
    );

    const FAQCategoryCard = ({ category }: { category: FAQCategory }) => {
        const isExpanded = expandedCategory === category.title;

        return (
            <View style={styles.faqCategoryCard}>
                <TouchableOpacity
                    style={styles.faqCategoryHeader}
                    onPress={() => setExpandedCategory(isExpanded ? null : category.title)}
                >
                    <View style={styles.faqCategoryLeft}>
                        <Ionicons name={category.icon} size={20} color="#4A8EE8" />
                        <Text style={styles.faqCategoryTitle}>{category.title}</Text>
                    </View>
                    <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={20}
                        color="#9CA3AF"
                    />
                </TouchableOpacity>

                {isExpanded && (
                    <View style={styles.faqItemsContainer}>
                        {category.items.map((item, index) => (
                            <View
                                key={index}
                                style={[
                                    styles.faqItem,
                                    index < category.items.length - 1 && styles.faqItemBorder
                                ]}
                            >
                                <Text style={styles.faqQuestion}>{item.question}</Text>
                                <Text style={styles.faqAnswer}>{item.answer}</Text>
                            </View>
                        ))}
                    </View>
                )}
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('help.headerTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.welcomeCard}>
                    <Ionicons name="help-circle" size={48} color="#4A8EE8" />
                    <Text style={styles.welcomeTitle}>{t('help.welcomeTitle')}</Text>
                    <Text style={styles.welcomeSubtitle}>
                        {t('help.welcomeSubtitle')}
                    </Text>
                </View>

                <Text style={styles.sectionHeader}>{t('help.getHelp')}</Text>

                <SupportItem
                    icon="information-circle"
                    title={t('help.aboutProvian')}
                    description={t('help.learnHow')}
                    onPress={() => navigation.navigate('Vision')}
                    iconColor="#6BA3F0"
                />

                <SupportItem
                    icon="book"
                    title={t('help.manual')}
                    description={t('help.manualDesc')}
                    onPress={handleOpenManual}
                    iconColor="#9B87F5"
                />

                <SupportItem
                    icon="shield-checkmark-outline"
                    title={t('help.networkConstitution')}
                    description={t('help.networkConstitutionDesc')}
                    onPress={() => navigation.navigate('NetworkConstitution')}
                    iconColor={COLORS.primary}
                />

                <SupportItem
                    icon="mail"
                    title={t('help.contactSupport')}
                    description={t('help.emailSupport')}
                    onPress={handleContactSupport}
                />

                <SupportItem
                    icon="bug"
                    title={t('help.reportBug')}
                    description={t('help.reportBugDesc')}
                    onPress={handleReportBug}
                    iconColor="#F2555A"
                />

                <SupportItem
                    icon="bulb"
                    title={t('help.suggestFeature')}
                    description={t('help.suggestFeatureDesc')}
                    onPress={handleSuggestFeature}
                    iconColor="#4CC38A"
                />

                <Text style={styles.sectionHeader}>{t('help.commonQuestions')}</Text>

                {ALL_FAQ_DATA.map((category, index) => (
                    <FAQCategoryCard key={index} category={category} />
                ))}

                <View style={styles.footerCard}>
                    <Text style={styles.footerText}>
                        {t('help.cantFind')}
                    </Text>
                    <TouchableOpacity onPress={handleContactSupport}>
                        <Text style={styles.footerLink}>{t('help.contactUsAt')}</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xl * 2,
    },
    welcomeCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.xl,
        borderRadius: 22,
        marginBottom: SPACING.xl,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    welcomeTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: COLORS.text,
        marginTop: SPACING.m,
    },
    welcomeSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.s,
        lineHeight: 20,
    },
    sectionHeader: {
        color: '#9CA3AF',
        fontSize: 11,
        fontWeight: '600',
        marginTop: SPACING.l,
        marginBottom: SPACING.m,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    supportCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    iconContainer: {
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    supportInfo: {
        flex: 1,
    },
    supportTitle: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 2,
    },
    supportDescription: {
        color: '#8B929E',
        fontSize: 13,
    },
    faqCategoryCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    faqCategoryHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    faqCategoryLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    faqCategoryTitle: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
    },
    faqItemsContainer: {
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    faqItem: {
        padding: SPACING.m,
    },
    faqItemBorder: {
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    faqQuestion: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '600',
        marginBottom: SPACING.xs,
    },
    faqAnswer: {
        color: '#8B929E',
        fontSize: 14,
        lineHeight: 20,
    },
    footerCard: {
        marginTop: SPACING.xl,
        alignItems: 'center',
        paddingVertical: SPACING.l,
    },
    footerText: {
        color: '#8B929E',
        fontSize: 14,
        marginBottom: SPACING.xs,
    },
    footerLink: {
        color: '#4A8EE8',
        fontSize: 14,
        fontWeight: '600',
    },
});

export default HelpSupportScreen;
