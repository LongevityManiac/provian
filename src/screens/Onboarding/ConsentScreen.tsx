/**
 * ConsentScreen, pre-wallet-creation consent gate and the app's only acceptance step.
 * User must acknowledge three items before wallet creation begins: non-custody,
 * the as-is / irreversibility / no-liability terms, and the Terms and Privacy Policy.
 * Restoring a wallet passes through the same three (route param `next` names the restore
 * method to continue to; see navigation/restoreConsent). After an unlock, when the Terms of Service
 * or Privacy Policy changed since this install accepted them, the same three are shown again in
 * review mode (route param `review`): accepting records the current versions and opens the app.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import { useTranslation } from 'react-i18next';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { restoreNextOf } from '../../navigation/restoreConsent';

const ConsentScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const { acceptTos } = useWalletStore();
    const restoreNext = restoreNextOf(route?.params?.next);
    const review = route?.params?.review === true && !restoreNext;
    const [checks, setChecks] = useState([false, false, false]);

    const toggle = (index: number) => {
        setChecks(prev => prev.map((v, i) => (i === index ? !v : v)));
    };

    const allChecked = checks.every(Boolean);

    const items = [
        t('consentScreen.itemNonCustodial'),
        t('consentScreen.itemAsIs'),
        t('consentScreen.itemAgreeTerms'),
    ];

    const itemIcons: Array<'shield' | 'alert-circle' | 'document-text'> = [
        'shield',
        'alert-circle',
        'document-text',
    ];

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header */}
            <View style={styles.header}>
                {review ? <View style={styles.headerSpacer} /> : <BackButton onPress={() => navigation.goBack()} />}
            </View>

            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.iconContainer}>
                    <Ionicons name="document-text" size={44} color="#4A8EE8" />
                </View>

                <Text style={styles.title}>{t(review ? 'consentScreen.titleReview' : restoreNext ? 'consentScreen.titleRestore' : 'consentScreen.title')}</Text>
                <Text style={styles.subtitle}>
                    {t(review ? 'consentScreen.subtitleReview' : 'consentScreen.subtitle')}
                </Text>

                <View style={styles.checklistCard}>
                    <Text style={styles.sectionHeader}>{t('consentScreen.acknowledgementsHeader')}</Text>
                    {items.map((item, index) => (
                        <TouchableOpacity
                            key={index}
                            style={styles.checkRow}
                            onPress={() => toggle(index)}
                            activeOpacity={0.7}
                        >
                            <View style={[
                                styles.checkbox,
                                checks[index] && styles.checkboxChecked,
                            ]}>
                                {checks[index] && (
                                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                                )}
                            </View>
                            <View style={styles.checkContent}>
                                <View style={[styles.checkIconBg, { backgroundColor: checks[index] ? 'rgba(0,230,118,0.14)' : 'rgba(74,142,232,0.14)' }]}>
                                    <Ionicons
                                        name={itemIcons[index]}
                                        size={16}
                                        color={checks[index] ? '#4CC38A' : '#4A8EE8'}
                                    />
                                </View>
                                <Text style={styles.checkLabel}>{item}</Text>
                            </View>
                        </TouchableOpacity>
                    ))}

                    {/* Constitution and Terms links */}
                    <View style={styles.linksContainer}>
                        <TouchableOpacity
                            style={styles.termsLink}
                            onPress={() => navigation.navigate('NetworkConstitution')}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="document-text-outline" size={16} color="#4A8EE8" />
                            <Text style={styles.termsLinkText}>{t('consentScreen.linkConstitution')}</Text>
                            <Ionicons name="open-outline" size={14} color="#4A8EE8" style={styles.termsLinkChevron} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.termsLink}
                            onPress={() => navigation.navigate('TermsOfService')}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="reader-outline" size={16} color="#4A8EE8" />
                            <Text style={styles.termsLinkText}>{t('consentScreen.linkTerms')}</Text>
                            <Ionicons name="open-outline" size={14} color="#4A8EE8" style={styles.termsLinkChevron} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.termsLink}
                            onPress={() => navigation.navigate('PrivacyPolicy')}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="lock-closed-outline" size={16} color="#4A8EE8" />
                            <Text style={styles.termsLinkText}>{t('consentScreen.linkPrivacy')}</Text>
                            <Ionicons name="open-outline" size={14} color="#4A8EE8" style={styles.termsLinkChevron} />
                        </TouchableOpacity>
                    </View>
                </View>
            </ScrollView>

            {/* Fixed CTA */}
            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.ctaButton, !allChecked && styles.ctaDisabled]}
                    onPress={() => {
                        // Persist acceptance of the legal service terms. The
                        // Network Constitution is offered as reading
                        // (link above) and is not required to continue.
                        acceptTos();
                        if (review) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
                        else if (restoreNext) navigation.replace(restoreNext);
                        else navigation.navigate('BiometricSetup');
                    }}
                    disabled={!allChecked}
                    activeOpacity={0.8}
                >
                    <LinearGradient
                        colors={allChecked ? GRADIENTS.primary : ['#1E2D3D', '#1E2D3D']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.ctaGradient}
                    >
                        <Ionicons
                            name="rocket"
                            size={20}
                            color={allChecked ? '#FFFFFF' : '#9CA3AF'}
                            style={{ marginRight: 8 }}
                        />
                        <Text style={[styles.ctaText, !allChecked && styles.ctaTextDisabled]}>
                            {t(review ? 'consentScreen.ctaAccept' : restoreNext ? 'consentScreen.ctaRestoreWallet' : 'consentScreen.ctaCreateWallet')}
                        </Text>
                        <Ionicons
                            name="arrow-forward"
                            size={20}
                            color={allChecked ? '#FFFFFF' : '#9CA3AF'}
                            style={{ marginLeft: 8 }}
                        />
                    </LinearGradient>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    headerSpacer: {
        height: BACK_BUTTON_SIZE,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.m,
    },
    iconContainer: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        marginBottom: SPACING.l,
        marginTop: SPACING.l,
    },
    title: {
        fontSize: 26,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.m,
    },
    subtitle: {
        fontSize: 15,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: SPACING.xl,
    },
    sectionHeader: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.l,
    },
    checklistCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    checkRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: SPACING.l,
    },
    checkbox: {
        width: 26,
        height: 26,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: 'rgba(42,48,56,1)',
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        marginTop: 1,
    },
    checkboxChecked: {
        backgroundColor: '#4A8EE8',
        borderColor: '#4A8EE8',
    },
    checkContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    checkIconBg: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.s,
    },
    checkLabel: {
        flex: 1,
        fontSize: 15,
        color: COLORS.text,
        lineHeight: 22,
        paddingTop: 3,
    },
    linksContainer: {
        marginTop: SPACING.s,
        paddingTop: SPACING.m,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    termsLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: SPACING.s,
    },
    termsLinkText: {
        flex: 1,
        fontSize: 14,
        color: '#4A8EE8',
        fontWeight: '500',
    },
    termsLinkChevron: {
        marginLeft: SPACING.s,
    },
    footer: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.l,
        paddingTop: SPACING.s,
    },
    ctaButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    ctaDisabled: {
        opacity: 0.6,
        shadowOpacity: 0,
    },
    ctaGradient: {
        paddingVertical: 16,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        borderRadius: 28,
    },
    ctaText: {
        fontSize: 16,
        fontWeight: '600',
        color: 'white',
    },
    ctaTextDisabled: {
        color: '#9CA3AF',
    },
});

export default ConsentScreen;
