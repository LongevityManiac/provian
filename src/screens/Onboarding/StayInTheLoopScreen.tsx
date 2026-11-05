import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * StayInTheLoopScreen - optional, skippable community-email opt-in.
 *
 * Shown once after AttestationScreen completes onboarding (and reachable
 * later from Settings with { fromSettings: true }). It NEVER gates the
 * wallet: subscribe success, skip, and any network failure all continue to
 * MainTabs (or back to Settings).
 *
 * Privacy contract (mirrors the backend route): the email is sent through an
 * identity-free endpoint and stored with no wallet/user/device fields — it
 * is a community mailing list, not an account attribute. The copy says
 * exactly that and no more.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ActivityIndicator,
    TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import relayService from '../../services/RelayAPIService';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import BackButton from '../../components/BackButton';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const StayInTheLoopScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const fromSettings = route?.params?.fromSettings === true;

    const [email, setEmail] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [subscribed, setSubscribed] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const proceed = () => {
        if (fromSettings) {
            navigation.goBack();
        } else {
            navigation.replace('MainTabs');
        }
    };

    const handleSubscribe = async () => {
        const trimmed = email.trim();
        if (!EMAIL_SHAPE.test(trimmed) || trimmed.length > MAX_EMAIL_LENGTH) {
            setError(t('stayInTheLoop.invalidEmail'));
            return;
        }
        setError(null);
        setSubmitting(true);
        const ok = await relayService.subscribeCommunityUpdates(
            trimmed,
            fromSettings ? 'settings' : 'onboarding',
        );
        setSubmitting(false);
        if (ok) {
            setSubscribed(true);
            setTimeout(proceed, 1200);
        } else {
            // Opt-in must never strand the user: surface the failure once and
            // leave both retry and skip available.
            setError(t('stayInTheLoop.subscribeFailed'));
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            {fromSettings && (
                <View style={styles.navBar}>
                    <BackButton onPress={() => navigation.goBack()} />
                </View>
            )}
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                {subscribed ? (
                    <>
                        <View style={styles.iconContainer}>
                            <Ionicons name="checkmark-circle" size={48} color="#4CC38A" />
                        </View>
                        <Text style={styles.title}>{t('stayInTheLoop.successTitle')}</Text>
                        <Text style={styles.subtitle}>{t('stayInTheLoop.successSubtitle')}</Text>
                    </>
                ) : (
                    <>
                        <View style={styles.iconContainer}>
                            <Ionicons name="mail-unread-outline" size={44} color="#4A8EE8" />
                        </View>
                        <Text style={styles.title}>{t('stayInTheLoop.title')}</Text>
                        <Text style={styles.subtitle}>{t('stayInTheLoop.subtitle')}</Text>

                        {error && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="warning" size={16} color={COLORS.errorLight} />
                                <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                            </View>
                        )}

                        <TextInput
                            style={styles.emailInput}
                            value={email}
                            onChangeText={setEmail}
                            placeholder={t('stayInTheLoop.placeholder')}
                            placeholderTextColor="#6B7280"
                            keyboardType="email-address"
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            maxLength={MAX_EMAIL_LENGTH}
                            editable={!submitting}
                        />

                        <Text style={styles.privacyNote}>{t('stayInTheLoop.privacyNote')}</Text>

                        <TouchableOpacity
                            style={[styles.primaryButton, (submitting || email.trim().length === 0) && styles.buttonDisabled]}
                            onPress={handleSubscribe}
                            disabled={submitting || email.trim().length === 0}
                            activeOpacity={0.8}
                        >
                            <LinearGradient colors={GRADIENTS.primary} style={styles.buttonGradient}>
                                {submitting ? (
                                    <ActivityIndicator size="small" color="white" />
                                ) : (
                                    <Text style={styles.buttonText}>{t('stayInTheLoop.subscribeCta')}</Text>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>

                        {!fromSettings && (
                            <TouchableOpacity style={styles.secondaryButton} onPress={proceed} disabled={submitting}>
                                <Text style={styles.secondaryButtonText}>{t('stayInTheLoop.skipCta')}</Text>
                            </TouchableOpacity>
                        )}
                    </>
                )}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    content: {
        flexGrow: 1,
        paddingHorizontal: SPACING.l,
        justifyContent: 'center',
    },
    iconContainer: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(74,142,232,0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        alignSelf: 'center',
        marginBottom: SPACING.l,
    },
    title: {
        fontSize: 26,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
    },
    subtitle: {
        fontSize: 15,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: SPACING.xl,
        paddingHorizontal: SPACING.s,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,107,107,0.1)',
        borderRadius: 12,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        gap: SPACING.s,
    },
    errorText: {
        color: COLORS.errorLight,
        fontSize: 14,
        flex: 1,
    },
    emailInput: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.15)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        fontSize: 16,
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
    },
    privacyNote: {
        fontSize: 13,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 19,
        marginBottom: SPACING.l,
        paddingHorizontal: SPACING.s,
    },
    primaryButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    buttonGradient: {
        paddingVertical: 16,
        alignItems: 'center',
        borderRadius: 28,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        color: 'white',
    },
    buttonDisabled: {
        opacity: 0.5,
        shadowOpacity: 0,
    },
    secondaryButton: {
        marginTop: SPACING.m,
        paddingVertical: 14,
        alignItems: 'center',
    },
    secondaryButtonText: {
        fontSize: 15,
        color: '#8B929E',
        fontWeight: '500',
    },
});

export default StayInTheLoopScreen;
