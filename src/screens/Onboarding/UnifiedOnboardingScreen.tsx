/**
 * UnifiedOnboardingScreen - what the app is, in five steps
 *
 * Five steps (0-4), six while the Genesis window is open. Each card states its
 * facts once; no card repeats another:
 * 0. The Hook, the work you already do becomes proof you own and each proof mints
 *    PVT; nothing changes or moves, and content never leaves (link to the full Vision)
 * 1. The Provenance Envelope, a sealed receipt in a history no one can quietly
 *    edit: the track record you show when someone needs to trust you
 * 2. PVT, the ERC-20 on Base created only when proven work settles, and what
 *    agents hold and spend (three pills)
 * 3. Genesis, joining pays through the launch window (self-retiring; see
 *    genesisWindow.ts; three pills)
 * 3+G. The Wallet: a real crypto wallet holding your proofs and PVT, plus where
 *    you chat, keep promises, and meet agents
 * (no tab names anywhere in onboarding; the app teaches its own tabs)
 * 4+G. Secure Your Wallet, biometrics, the encrypted cloud backup and recovery,
 *    and legal links (final in-screen step)
 *
 * 2026-08-23 : cut from twelve steps that told the whole thesis (~1,900
 * words, eight of them restating Vision sections) to five about the APP. The
 * thesis lives on the Vision tab — linked from step 0 and a permanent tab — so
 * onboarding no longer tells it twice. Orientation register, not manifesto.
 *
 * The Genesis step advertises the time-limited campaign and RETIRES ITSELF when
 * the approved window closes — the flow drops back to five steps with no code
 * change and no one having to remember. The final step is informational; the
 * single binding ToS acceptance is collected on ConsentScreen immediately before
 * wallet creation. From the final step the linear chain
 * Consent -> BiometricSetup -> CloudBackupConfirm -> Attestation creates the
 * wallet and resets to MainTabs. Keep STEP_ACCENTS / HERO_IMAGES at TOTAL_STEPS
 * entries. All copy is translatable via onboarding.unified.* i18n keys; the
 * English source is `src/i18n/locales/enOnboardingNarrative.ts`.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Animated,
    Dimensions,
    Image,
    ScrollView,
    ImageSourcePropType,
    Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import { isGenesisWindowOpen } from './genesisWindow';
import BackButton from '../../components/BackButton';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
// The Genesis step (index 3) is a campaign slide that RETIRES ITSELF when the
// approved window closes — see genesisWindow.ts. Nobody has to remember to pull
// it: once `isGenesisWindowOpen()` goes false the step, its hero, and its accent
// drop out and the flow is five steps again. Evaluated once at module load, so
// a session running across the boundary retires it on next app start.
const GENESIS_ACTIVE = isGenesisWindowOpen();
/** 1 while the Genesis step is in the flow, 0 after it retires. */
const G = GENESIS_ACTIVE ? 1 : 0;
const TOTAL_STEPS = 5 + G;

// The Genesis film lives on the website (no video in the app) at a root URL that
// stays the same through the site's launch flip. Same URL VisionScreen links to.
const GENESIS_FILM_URL = 'https://provian.ai/films/genesis-is-open.mp4';

// Resume key. Versioned: the v1 key held an index into the retired twelve-step
// flow, and an index saved there would land a resuming user on the wrong step
// of this one (or past its end). A new key means the old value is simply ignored.
const ONBOARDING_STEP_KEY = '@provian_onboarding_step_v2';

// Background color constant used in gradient overlays and footer
const BG = '#0B0E14';

// CTA accent: one interactive color everywhere (Quiet Shield discipline).
// The per-step hero images carry the variety; buttons stay calm and
// consistent. The exception is the PVT / Genesis value moment, marked amber.
const STEP_ACCENTS: string[] = [
    '#4A8EE8', // 0 hook
    '#4A8EE8', // 1 envelope
    '#E8A838', // 2 pvt, amber (value moment)
    // 3 genesis, amber (value moment) — present only while the window is open
    ...(GENESIS_ACTIVE ? ['#E8A838'] : []),
    '#4A8EE8', // 3+G wallet features
    '#4A8EE8', // 4+G wallet setup
];

// Hero images for each step
const HERO_IMAGES: ImageSourcePropType[] = [
    require('../../../assets/images/onboarding-hook.png'),
    require('../../../assets/images/onboarding-envelope.png'),
    require('../../../assets/images/onboarding-pvt.png'),
    // Genesis hero — present only while the window is open
    ...(GENESIS_ACTIVE ? [require('../../../assets/images/onboarding-genesis.png')] : []),
    require('../../../assets/images/onboarding-wallet-features.png'),
    require('../../../assets/images/onboarding-wallet.png'),
];

// Drift guard (Fix F9): both per-step arrays must stay aligned with TOTAL_STEPS.
// This previously drifted to 15 entries after steps 12-14 were removed.
if (__DEV__ && (STEP_ACCENTS.length !== TOTAL_STEPS || HERO_IMAGES.length !== TOTAL_STEPS)) {
    console.warn(
        `[Onboarding] STEP_ACCENTS (${STEP_ACCENTS.length}) and HERO_IMAGES (${HERO_IMAGES.length}) must each have TOTAL_STEPS (${TOTAL_STEPS}) entries`,
    );
}

const UnifiedOnboardingScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const bio = useBiometricLabel();
    const [currentStep, setCurrentStep] = useState(0);
    const slideAnim = useRef(new Animated.Value(0)).current;
    const progressAnim = useRef(new Animated.Value(0)).current;

    // D-1 fix: Restore saved onboarding step on mount so crash mid-onboarding
    // resumes where the user left off instead of restarting at step 0.
    const [stepRestored, setStepRestored] = useState(false);
    useEffect(() => {
        AsyncStorage.getItem(ONBOARDING_STEP_KEY).then((saved) => {
            if (saved) {
                const step = parseInt(saved, 10);
                if (step > 0 && step < TOTAL_STEPS) {
                    slideAnim.setValue(-step * SCREEN_WIDTH);
                    progressAnim.setValue(step / (TOTAL_STEPS - 1));
                    setCurrentStep(step);
                }
            }
            setStepRestored(true);
        }).catch(() => setStepRestored(true));
    }, []);

    const goToStep = useCallback((step: number) => {
        Animated.parallel([
            Animated.timing(slideAnim, {
                toValue: -step * SCREEN_WIDTH,
                duration: 300,
                useNativeDriver: true,
            }),
            Animated.timing(progressAnim, {
                toValue: step / (TOTAL_STEPS - 1),
                duration: 300,
                useNativeDriver: false,
            }),
        ]).start();
        setCurrentStep(step);
        // D-1 fix: Persist step so crash/force-quit resumes here
        AsyncStorage.setItem(ONBOARDING_STEP_KEY, String(step)).catch(() => {});
    }, [slideAnim, progressAnim]);

    // --- Navigation handlers ---

    const next = () => goToStep(currentStep + 1);

    const handleSetupBiometrics = () => {
        navigation.navigate('Consent');
    };
    // The final step (Secure Your Wallet) is the last UnifiedOnboarding step. From
    // here the user enters the linear Consent → BiometricSetup → CloudBackupConfirm →
    // Attestation chain, and AttestationScreen completes onboarding and resets
    // to MainTabs. There is no return into this screen.

    const progressWidth = progressAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['0%', '100%'],
    });

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={['#0B0E14', '#0F1621', '#0B0E14']}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Progress bar */}
            <View style={styles.progressContainer}>
                {currentStep > 0 ? (
                    <BackButton onPress={() => goToStep(currentStep - 1)} />
                ) : (
                    <View style={styles.backButtonPlaceholder} />
                )}
                <View style={styles.progressTrack}>
                    <Animated.View style={[styles.progressFill, { width: progressWidth }]} />
                </View>
                <Text style={styles.progressText}>
                    {t('onboarding.unified.stepOf', { current: currentStep + 1, total: TOTAL_STEPS })}
                </Text>
            </View>

            {/* Sliding steps */}
            <Animated.View
                style={[
                    styles.slidingContainer,
                    { transform: [{ translateX: slideAnim }] },
                ]}
            >
                {/* ──────────── Step 0: THE HOOK ──────────── */}
                <StepShell index={0}>
                    <HeroImage source={HERO_IMAGES[0]} />
                    <TouchableOpacity
                        onPress={() => navigation.navigate('Vision')}
                        style={styles.visionLink}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.visionLinkText}>{t('agentHub.readFullVision')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.hookHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.hookSubtext')}
                    </Text>
                    <StepFooter>
                        <CTAButton label={t('onboarding.unified.hookCta')} onPress={next} accent={STEP_ACCENTS[0]} />
                        <TouchableOpacity
                            onPress={() => navigation.navigate('RecoveryStart')}
                            style={styles.recoverLink}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.recoverLinkText}>{t('onboarding.alreadyHaveWallet')}</Text>
                        </TouchableOpacity>
                    </StepFooter>
                </StepShell>

                {/* ──────────── Step 1: THE PROVENANCE ENVELOPE ──────────── */}
                <StepShell index={1}>
                    <HeroImage source={HERO_IMAGES[1]} />
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.envelopeHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.envelopeSubtext')}
                    </Text>
                    <View style={styles.valuePills}>
                        <ValuePill color={COLORS.success} label={t('onboarding.unified.envelopePill1')} />
                        <ValuePill color={COLORS.primary} label={t('onboarding.unified.envelopePill2')} />
                        <ValuePill color={COLORS.primary} label={t('onboarding.unified.envelopePill3')} />
                        <ValuePill color={COLORS.primaryLight} label={t('onboarding.unified.envelopePill4')} />
                    </View>
                    <StepFooter>
                        <CTAButton label={t('onboarding.unified.envelopeCta')} onPress={next} accent={STEP_ACCENTS[1]} />
                    </StepFooter>
                </StepShell>

                {/* ──────────── Step 2: PVT ──────────── */}
                <StepShell index={2}>
                    <HeroImage source={HERO_IMAGES[2]} />
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.pvtHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.pvtSubtext')}
                    </Text>
                    <View style={styles.valuePills}>
                        <ValuePill color="#F5C542" label={t('onboarding.unified.pvtPill1')} />
                        <ValuePill color="#F5C542" label={t('onboarding.unified.pvtPill2')} />
                        <ValuePill color="#F5C542" label={t('onboarding.unified.pvtPill3')} />
                    </View>
                    <StepFooter>
                        {/* "Why Start Now?" leads into Genesis; once Genesis retires the PVT
                            step leads straight to the wallet, so the CTA reads accordingly. */}
                        <CTAButton
                            label={t(GENESIS_ACTIVE ? 'onboarding.unified.pvtCta' : 'onboarding.unified.pvtCtaAfterGenesis')}
                            onPress={next}
                            accent={STEP_ACCENTS[2]}
                        />
                    </StepFooter>
                </StepShell>

                {/* ──────────── Step 3: GENESIS (while the window is open) ────────────
                    Self-retiring: rendered only while the approved Genesis window is open.
                    The step, its hero and its accent all key off GENESIS_ACTIVE, so the
                    flow closes up to five aligned steps by itself when the window
                    closes (genesisWindow.ts) — no manual removal step. */}
                {GENESIS_ACTIVE && (
                <StepShell index={3}>
                    <HeroImage source={HERO_IMAGES[3]} />
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.genesisHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.genesisSubtext')}
                    </Text>
                    <View style={styles.valuePills}>
                        <ValuePill color="#E8A838" label={t('onboarding.unified.genesisPill1')} />
                        <ValuePill color="#E8A838" label={t('onboarding.unified.genesisPill2')} />
                        <ValuePill color="#E8A838" label={t('onboarding.unified.genesisPill3')} />
                    </View>
                    <Text style={styles.genesisFinePrint}>{t('onboarding.unified.genesisFinePrint')}</Text>
                    {/* The Genesis film plays on the website (no video in the app), at a root
                        URL that stays the same through the site's launch flip. */}
                    <TouchableOpacity
                        onPress={() => Linking.openURL(GENESIS_FILM_URL)}
                        style={styles.visionLink}
                        activeOpacity={0.7}
                        accessibilityRole="link"
                    >
                        <Text style={styles.visionLinkText}>{t('onboarding.unified.genesisFilmLink')}</Text>
                    </TouchableOpacity>
                    <StepFooter>
                        <CTAButton label={t('onboarding.unified.genesisCta')} onPress={next} accent={STEP_ACCENTS[3]} />
                    </StepFooter>
                </StepShell>
                )}

                {/* ──────────── Step 3+G: THE WALLET (what the app does, how it is secured) ──────────── */}
                <StepShell index={3 + G}>
                    <HeroImage source={HERO_IMAGES[3 + G]} />
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.walletFeaturesHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.walletFeaturesSubtext')}
                    </Text>
                    <View style={styles.valuePills}>
                        <ValuePill color={COLORS.primary} label={t('onboarding.unified.walletFeaturesPill1')} />
                        <ValuePill color={COLORS.success} label={t('onboarding.unified.walletFeaturesPill2')} />
                        <ValuePill color="#F2555A" label={t('onboarding.unified.walletFeaturesPill3')} />
                        <ValuePill color={COLORS.primaryLight} label={t('onboarding.unified.walletFeaturesPill4')} />
                    </View>
                    <StepFooter>
                        <CTAButton label={t('onboarding.unified.walletFeaturesCta')} onPress={next} accent={STEP_ACCENTS[3 + G]} />
                    </StepFooter>
                </StepShell>

                {/* ──────────── Final step: SECURE YOUR WALLET (→ Consent → Biometrics) ────────────
                    Informational; the binding ToS acceptance is collected once on
                    ConsentScreen, immediately before wallet creation. The Network
                    Constitution is offered as reading, not a requirement to continue. */}
                <StepShell index={4 + G}>
                    <HeroImage source={HERO_IMAGES[4 + G]} />
                    <Text style={styles.headlineHero}>
                        {t('onboarding.unified.walletHeadline')}
                    </Text>
                    <Text style={styles.subtext}>
                        {t('onboarding.unified.walletSubtext', { biometric: bio.label })}
                    </Text>
                    <View style={styles.accordRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.accordLabel}>
                                {t('onboarding.unified.walletLegalNote')}
                            </Text>
                            <TouchableOpacity
                                onPress={() => navigation.navigate('TermsOfService')}
                                style={{ marginTop: SPACING.s }}
                            >
                                <Text style={styles.accordLink}>{t('onboarding.unified.termsLink')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => navigation.navigate('PrivacyPolicy')}
                                style={{ marginTop: 4 }}
                            >
                                <Text style={styles.accordLink}>{t('onboarding.readPrivacyPolicy')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => navigation.navigate('NetworkConstitution')}
                                style={{ marginTop: 4 }}
                            >
                                <Text style={styles.accordLink}>{t('onboarding.readConstitution')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                    <StepFooter>
                        <CTAButton label={t('onboarding.unified.walletCta')} onPress={handleSetupBiometrics} accent={STEP_ACCENTS[4 + G]} />
                    </StepFooter>
                </StepShell>
                {/* Onboarding ends at the final step. The Consent → BiometricSetup →
                    CloudBackupConfirm → Attestation chain finishes wallet creation
                    and AttestationScreen completes onboarding + resets to MainTabs. */}
            </Animated.View>
        </SafeAreaView>
    );
};

// ─── Sub-components ──────────────────────────────────────────

/** Wrapper for each step. Provides width, scroll, and layout. */
const StepShell = ({ index, children }: { index: number; children: React.ReactNode }) => {
    // Separate scroll content from footer by convention:
    // last child is <StepFooter>, everything before scrolls.
    const childArray = React.Children.toArray(children);
    const footer = childArray[childArray.length - 1];
    const scrollContent = childArray.slice(0, -1);

    return (
        <View style={styles.step}>
            <View style={styles.stepScrollWrap}>
                <ScrollView
                    style={styles.stepScroll}
                    contentContainerStyle={styles.stepScrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {scrollContent}
                </ScrollView>
                {/* Bottom fade so content-heavy steps don't look hard-cut against
                    the opaque footer — mirrors the HeroImage ambient fade. It
                    overlays the bottom of the scroll area (not the footer), so
                    scrolling body copy dissolves into BG right where the fixed
                    CTA begins, cueing that more content exists above. */}
                <LinearGradient
                    colors={['transparent', BG]}
                    style={styles.stepScrollFade}
                    pointerEvents="none"
                />
            </View>
            {footer}
        </View>
    );
};

/** Fixed footer at the bottom of each step */
const StepFooter = ({ children }: { children: React.ReactNode }) => (
    <View style={styles.stepFooter}>{children}</View>
);

/** Hero image with smooth ambient gradient fade to background */
const HeroImage = ({ source }: { source: ImageSourcePropType }) => (
    <View style={styles.heroImageContainer}>
        <Image source={source} style={styles.heroImage} resizeMode="cover" />
        <LinearGradient
            colors={['transparent', 'rgba(11,14,20,0.5)', BG]}
            locations={[0, 0.6, 1]}
            style={styles.heroGradientOverlay}
        />
    </View>
);

const CTAButton = ({ label, onPress, accent, disabled }: { label: string; onPress: () => void; accent: string; disabled?: boolean }) => (
    <TouchableOpacity
        style={[styles.ctaButton, { shadowColor: accent }, disabled && { opacity: 0.4 }]}
        onPress={onPress}
        activeOpacity={0.8}
        disabled={disabled}
    >
        <LinearGradient
            colors={disabled ? ['#3A3F47', '#4A4F57'] : [accent, accent === '#E8A838' ? '#F5C542' : '#6BA3F0']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.ctaGradient}
        >
            <Text style={styles.ctaText}>{label}</Text>
            <Ionicons name="arrow-forward" size={20} color="white" style={{ marginLeft: 8 }} />
        </LinearGradient>
    </TouchableOpacity>
);

const ValuePill = ({ color, label }: { color: string; label: string }) => (
    <View style={styles.valuePill}>
        <View style={[styles.valuePillDot, { backgroundColor: color, shadowColor: color, shadowOpacity: 0.8, shadowRadius: 4, elevation: 2 }]} />
        <Text style={styles.valuePillText}>{label}</Text>
    </View>
);


// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: BG,
    },

    // Progress bar
    progressContainer: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.m,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
    },
    progressTrack: {
        flex: 1,
        height: 4,
        backgroundColor: 'rgba(200,205,214,0.10)',
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#4A8EE8',
        borderRadius: 2,
    },
    progressText: {
        fontSize: 12,
        color: '#9CA3AF',
        fontWeight: '500',
        minWidth: 50,
        textAlign: 'right',
        letterSpacing: 0.5,
    },

    backButtonPlaceholder: {
        width: 44,
    },

    // Slider
    slidingContainer: {
        flex: 1,
        flexDirection: 'row',
        width: SCREEN_WIDTH * TOTAL_STEPS,
    },
    step: {
        width: SCREEN_WIDTH,
        flex: 1,
    },
    stepScrollWrap: {
        flex: 1,
    },
    stepScroll: {
        flex: 1,
    },
    stepScrollContent: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.xl,
    },
    stepScrollFade: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 28,
    },
    stepFooter: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.l,
        paddingTop: SPACING.s,
        backgroundColor: BG,
    },

    // Hero image
    heroImageContainer: {
        height: 320,
        marginHorizontal: -SPACING.l,
        marginTop: 0,
        marginBottom: SPACING.m,
        overflow: 'hidden',
    },
    heroImage: {
        width: '100%',
        height: '100%',
    },
    heroGradientOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 140,
    },

    genesisFinePrint: {
        fontSize: 12,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 18,
        marginTop: SPACING.s,
        marginBottom: SPACING.m,
    },

    // Vision link
    visionLink: {
        alignSelf: 'center',
        marginBottom: SPACING.m,
    },
    visionLinkText: {
        fontSize: 13,
        color: '#9CA3AF',
        textAlign: 'center',
    },
    recoverLink: {
        alignSelf: 'center',
        marginTop: SPACING.m,
        paddingVertical: SPACING.s,
    },
    recoverLinkText: {
        fontSize: 14,
        color: '#4A8EE8',
        fontWeight: '500',
    },

    // Typography
    headlineHero: {
        fontSize: 32,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.m,
        lineHeight: 40,
        letterSpacing: 0.3,
    },
    subtext: {
        fontSize: 15,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 23,
        marginBottom: SPACING.xl,
    },
    smallText: {
        fontSize: 13,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 19,
    },

    // Value pills
    valuePills: {
        gap: SPACING.s,
        marginBottom: SPACING.l,
    },
    valuePill: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: 'rgba(18,24,38,0.75)',
        borderRadius: 16,
        paddingHorizontal: SPACING.m,
        paddingVertical: 14,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
    },
    valuePillDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: SPACING.m,
        marginTop: 5,
    },
    valuePillText: {
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 20,
        flex: 1,
    },

    // Accord (ToS gate)
    accordRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 16,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        gap: SPACING.m,
        marginBottom: SPACING.l,
    },
    accordLabel: {
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 20,
        flex: 1,
    },
    accordLink: {
        color: COLORS.primary,
        textDecorationLine: 'underline',
    },

    // Checklist
    checkList: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    checkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
    },
    checkText: {
        fontSize: 15,
        color: COLORS.text,
        flex: 1,
    },

    // PE Card (step 10)
    peCard: {
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(0,229,255,0.20)',
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
        elevation: 8,
    },
    peCardGradient: {
        padding: SPACING.l,
    },
    peCardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    peBadge: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingHorizontal: SPACING.m,
        paddingVertical: 4,
        borderRadius: BORDER_RADIUS.s,
    },
    peBadgeText: {
        fontSize: 14,
        fontWeight: '700',
        color: '#4A8EE8',
        letterSpacing: 1,
    },
    peMultiplier: {
        fontSize: 16,
        fontWeight: '700',
        color: '#4CC38A',
    },
    peRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: SPACING.s,
    },
    peLabel: {
        fontSize: 13,
        color: '#9CA3AF',
        fontFamily: 'monospace',
    },
    peValue: {
        fontSize: 13,
        color: COLORS.chromeMuted,
        fontFamily: 'monospace',
    },

    // CTA Button
    ctaButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
        elevation: 10,
    },
    ctaGradient: {
        paddingVertical: 18,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    ctaText: {
        fontSize: 16,
        fontWeight: '700',
        color: 'white',
        letterSpacing: 0.5,
    },

});

export default UnifiedOnboardingScreen;
