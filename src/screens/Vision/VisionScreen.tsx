/**
 * VisionScreen - the Provian vision, card by card.
 *
 * A permanent tab screen: the opening, twelve cards, the builders' notes, and the
 * call to participate. Accessible before wallet creation (registered outside the
 * auth guard). During Genesis, a full card leads before wallet setup; existing
 * owners get compact expandable details near the closing, with an
 * is created; it retires itself at 2027-01-01T00:00:00Z (genesisWindow.ts).
 *
 * Every card has a share icon. A "Share the Vision" button at the bottom shares
 * the summary. The films and documents open on provian.ai at root URLs that stay
 * the same through the website's launch flip.
 */

import React, { useCallback, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    Image,
    TouchableOpacity,
    Linking,
    Share,
    Alert,
    ActivityIndicator,
    ImageSourcePropType,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import BackButton from '../../components/BackButton';
import { useWalletStore } from '../../store/walletStore';
import { isGenesisWindowOpen } from '../Onboarding/genesisWindow';

const BG = '#0B0E14';
const GOLD = '#E8A838';

// Root-level website URLs (not under the staged /preview base), so they are the
// same before and after the launch flip.
export const VISION_LINKS = {
    toTheStarsFilm: 'https://provian.ai/films/to-the-stars.mp4',
    genesisFilm: 'https://provian.ai/films/genesis-is-open.mp4',
    nothingUnwitnessedFilm: 'https://provian.ai/films/nothing-unwitnessed.mp4',
    executiveSummary: 'https://provian.ai/docs-md/executive-summary.md',
    thesis: 'https://provian.ai/docs-md/the-provian-thesis.md',
    exponentialCurrency: 'https://provian.ai/docs-md/the-exponential-currency.md',
    site: 'https://provian.ai/home',
} as const;

// ─── Card data ───────────────────────────────────────────────

interface CardData {
    n: number;
    image: ImageSourcePropType;
    /** A film this card links out to (website-hosted, root URL), with its link label key. */
    film?: { url: string; labelKey: string };
}

const CARDS: CardData[] = [
    { n: 1, image: require('../../../assets/images/vision-envelope.png') },
    { n: 2, image: require('../../../assets/images/vision-pvt.png') },
    { n: 3, image: require('../../../assets/images/vision-burn.png') },
    {
        n: 4,
        image: require('../../../assets/images/vision-other-fear.png'),
        film: { url: VISION_LINKS.nothingUnwitnessedFilm, labelKey: 'visionScreen.card4Watch' },
    },
    { n: 5, image: require('../../../assets/images/vision-agent-economy.png') },
    { n: 6, image: require('../../../assets/images/vision-atlas.png') },
    { n: 7, image: require('../../../assets/images/vision-commons.png') },
    { n: 8, image: require('../../../assets/images/vision-promises.png') },
    { n: 9, image: require('../../../assets/images/vision-ubp.png') },
    { n: 10, image: require('../../../assets/images/vision-earn-code.png') },
    { n: 11, image: require('../../../assets/images/vision-open-standard.png') },
    { n: 12, image: require('../../../assets/images/vision-computes-next.png') },
];

// ─── Main component ──────────────────────────────────────────

const VisionScreen = () => {
    const { t } = useTranslation();
    const onboardingComplete = useWalletStore((st) => st.onboardingComplete);
    const genesisOpen = isGenesisWindowOpen();
    const [genesisDetailsExpanded, setGenesisDetailsExpanded] = useState(false);

    const shareSection = useCallback(async (title: string, body: string) => {
        try {
            await Share.share({
                title: t('visionScreen.shareSectionTitle', { title }),
                message: `${body}\n\nhttps://provian.ai`,
            });
        } catch {
            // User cancelled
        }
    }, [t]);

    const shareVision = useCallback(async () => {
        try {
            await Share.share({
                title: t('visionScreen.shareVisionTitle'),
                message: t('visionScreen.shareVisionMessage'),
            });
        } catch {
            // User cancelled
        }
    }, [t]);

    const navigation = useNavigation();
    // Show back button when accessed as a Stack screen (not a tab)
    const canGoBack = navigation.canGoBack() && navigation.getState()?.type !== 'tab';

    const renderShare = (title: string, body: string) => (
        <TouchableOpacity
            onPress={() => shareSection(title, body)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
            <Ionicons name="share-outline" size={18} color={COLORS.textMuted} />
        </TouchableOpacity>
    );

    const genesisTitle = t('visionScreen.genesisTitle');
    const genesisBody = t('visionScreen.genesisBody');
    const buildersTitle = t('visionScreen.buildersTitle');
    const buildersShareBody = [
        t('visionScreen.ladderBody'),
        t('visionScreen.gateBody'),
        t('visionScreen.walletArchBody'),
    ].join('\n\n');

    // Reuse all campaign details and actions; wallet setup changes placement only.
    const renderGenesis = (compact: boolean) => (
        <View testID="vision-genesis-card" style={[s.sectionCard, s.genesisCard]}>
            {!compact && (
                <>
                    <Image
                        source={require('../../../assets/images/onboarding-genesis.png')}
                        style={s.sectionImage}
                        resizeMode="cover"
                    />
                    <LinearGradient colors={['transparent', 'rgba(11,14,20,0.95)']} style={s.sectionImageFade} />
                </>
            )}
            <View style={s.sectionContent}>
                <View style={s.sectionHeader}>
                    {compact ? (
                        <TouchableOpacity
                            testID="vision-genesis-details-toggle"
                            style={s.genesisDetailsToggle}
                            onPress={() => setGenesisDetailsExpanded((expanded) => !expanded)}
                            accessibilityRole="button"
                            accessibilityLabel={genesisTitle}
                            accessibilityState={{ expanded: genesisDetailsExpanded }}
                        >
                            <Text style={s.sectionTitle}>{genesisTitle}</Text>
                            <Ionicons name={genesisDetailsExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={GOLD} />
                        </TouchableOpacity>
                    ) : <Text style={s.sectionTitle}>{genesisTitle}</Text>}
                    {renderShare(genesisTitle, genesisBody)}
                </View>
                {(!compact || genesisDetailsExpanded) && (
                    <View testID="vision-genesis-details">
                        <Text style={s.sectionBody}>{genesisBody}</Text>
                        <Text style={s.finePrint}>{t('visionScreen.genesisFinePrint')}</Text>
                    </View>
                )}
                {(!compact || genesisDetailsExpanded) && (
                    <TouchableOpacity
                        style={s.filmLinkInline}
                        onPress={() => Linking.openURL(VISION_LINKS.genesisFilm)}
                        accessibilityRole="link"
                    >
                        <Ionicons name="play-circle-outline" size={18} color={GOLD} />
                        <Text style={[s.filmLinkText, { color: GOLD }]}>{t('visionScreen.genesisWatch')}</Text>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );

    return (
        <SafeAreaView style={s.container} edges={['top']}>
            <LinearGradient
                colors={[BG, '#0F1621', BG]}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            {canGoBack && (
                <BackButton onPress={() => navigation.goBack()} style={{ position: 'absolute', top: Platform.OS === 'ios' ? 56 : 40, left: SPACING.m, zIndex: 10 }} />
            )}
            <ScrollView
                contentContainerStyle={s.scroll}
                showsVerticalScrollIndicator={false}
            >
                {/* ── HERO ── */}
                <View style={s.heroWrap}>
                    <Image
                        source={require('../../../assets/images/vision-hero.png')}
                        style={s.heroImage}
                        resizeMode="cover"
                    />
                    <LinearGradient
                        colors={['transparent', BG]}
                        style={s.heroFade}
                    />
                    <View style={s.heroOverlay}>
                        <Image
                            source={require('../../../assets/images/provian-logo.png')}
                            style={s.heroLogo}
                            resizeMode="contain"
                        />
                    </View>
                </View>
                <Text style={s.heroTitle}>{t('visionScreen.heroTitle')}</Text>
                <Text style={s.heroSubtitle}>{t('visionScreen.heroSubtitle')}</Text>
                <TouchableOpacity
                    style={s.filmLink}
                    onPress={() => Linking.openURL(VISION_LINKS.toTheStarsFilm)}
                    accessibilityRole="link"
                >
                    <Ionicons name="play-circle-outline" size={20} color={COLORS.primary} />
                    <Text style={s.filmLinkText}>{t('visionScreen.watchFilm')}</Text>
                </TouchableOpacity>

                {/* Full introduction is useful before a wallet exists. */}
                {genesisOpen && !onboardingComplete && renderGenesis(false)}

                {/* ── OPENING ── */}
                <View style={s.declarationWrap}>
                    <Text style={s.declaration}>
                        {t('visionScreen.opening1')}{'\n\n'}
                        {t('visionScreen.opening2')}{'\n\n'}
                        {t('visionScreen.opening3')}
                    </Text>
                </View>

                {/* ── CARDS ── */}
                {CARDS.map((card) => {
                    const title = t(`visionScreen.card${card.n}Title`);
                    const body = t(`visionScreen.card${card.n}Body`);
                    const film = card.film;
                    return (
                        <View key={card.n} style={s.sectionCard}>
                            <Image source={card.image} style={s.sectionImage} resizeMode="cover" />
                            <LinearGradient colors={['transparent', 'rgba(11,14,20,0.95)']} style={s.sectionImageFade} />
                            <View style={s.sectionContent}>
                                <View style={s.sectionHeader}>
                                    <Text style={s.sectionTitle}>{`${card.n} · ${title}`}</Text>
                                    {renderShare(title, body)}
                                </View>
                                <Text style={s.sectionBody}>{body}</Text>
                                {film && (
                                    <TouchableOpacity
                                        style={s.filmLinkInline}
                                        onPress={() => Linking.openURL(film.url)}
                                        accessibilityRole="link"
                                    >
                                        <Ionicons name="play-circle-outline" size={18} color={COLORS.primary} />
                                        <Text style={s.filmLinkText}>{t(film.labelKey)}</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                        </View>
                    );
                })}

                {/* ── FOR THE BUILDERS ── */}
                <View style={[s.sectionCard, s.builderCard]}>
                    <Image
                        source={require('../../../assets/images/vision-builders.png')}
                        style={s.sectionImage}
                        resizeMode="cover"
                    />
                    <LinearGradient colors={['transparent', 'rgba(11,14,20,0.97)']} style={s.sectionImageFade} />
                    <View style={s.sectionContent}>
                        <View style={s.sectionHeader}>
                            <Text style={[s.sectionTitle, s.builderTitle]}>{buildersTitle}</Text>
                            {renderShare(buildersTitle, buildersShareBody)}
                        </View>

                        <View style={s.techBlockFirst}>
                            <Text style={s.techHeading}>{t('visionScreen.ladderHeading')}</Text>
                            <Text style={s.techBody}>{t('visionScreen.ladderBody')}</Text>
                        </View>

                        <View style={s.techBlock}>
                            <Text style={s.techHeading}>{t('visionScreen.gateHeading')}</Text>
                            <Text style={s.techBody}>{t('visionScreen.gateBody')}</Text>
                        </View>

                        <View style={s.techBlock}>
                            <Text style={s.techHeading}>{t('visionScreen.walletArchHeading')}</Text>
                            <Text style={s.techBody}>{t('visionScreen.walletArchBody')}</Text>
                        </View>
                    </View>
                </View>

                {/* ── CLOSING STATEMENT ── */}
                <View style={s.closingWrap}>
                    <Text style={s.closingText}>{t('visionScreen.closingText')}</Text>
                    <Text style={s.closingCta}>{t('visionScreen.closingCta')}</Text>
                    <Text style={s.closingSignoff}>{t('visionScreen.closingSignoff')}</Text>
                    <Text style={s.thesisLine}>{t('visionScreen.thesisLine')}</Text>
                </View>

                {/* Existing owners keep Genesis details and invitations in participation. */}
                {genesisOpen && onboardingComplete && renderGenesis(true)}

                {/* ── SHARE THE VISION ── */}
                <TouchableOpacity style={s.shareButton} onPress={shareVision} activeOpacity={0.7}>
                    <Ionicons name="share-social-outline" size={20} color={COLORS.primary} />
                    <Text style={s.shareButtonText}>{t('visionScreen.shareButtonText')}</Text>
                </TouchableOpacity>

                {/* ── FOOTER ── */}
                <View style={s.footerCard}>
                    <TouchableOpacity style={s.footerLink} onPress={() => Linking.openURL(VISION_LINKS.executiveSummary)}>
                        <Ionicons name="book-outline" size={18} color={COLORS.primary} />
                        <Text style={s.footerLinkText}>{t('visionScreen.readExecutiveSummary')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.footerLink} onPress={() => Linking.openURL(VISION_LINKS.thesis)}>
                        <Ionicons name="book-outline" size={18} color={COLORS.primary} />
                        <Text style={s.footerLinkText}>{t('visionScreen.readThesis')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.footerLink} onPress={() => Linking.openURL(VISION_LINKS.exponentialCurrency)}>
                        <Ionicons name="book-outline" size={18} color={COLORS.primary} />
                        <Text style={s.footerLinkText}>{t('visionScreen.readCurrency')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={s.footerLink}
                        onPress={() => Linking.openURL(VISION_LINKS.site)}
                    >
                        <Ionicons name="globe-outline" size={18} color={COLORS.primary} />
                        <Text style={s.footerLinkText}>{t('visionScreen.footerVisit')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={s.footerLink}
                        onPress={() => Linking.openURL('mailto:hello@provian.ai')}
                    >
                        <Ionicons name="mail-outline" size={18} color={COLORS.primary} />
                        <Text style={s.footerLinkText}>{t('visionScreen.footerContact')}</Text>
                    </TouchableOpacity>
                    <Text style={s.footerNote}>{t('visionScreen.footerNote')}</Text>
                </View>

                {/* Bottom spacer for floating tab bar */}
                <View style={{ height: 100 }} />
            </ScrollView>
        </SafeAreaView>
    );
};

// ─── Styles ──────────────────────────────────────────────────

const s = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: BG,
    },
    scroll: {
        paddingBottom: SPACING.xl,
    },

    // Hero
    heroWrap: {
        height: 400,
        overflow: 'hidden',
    },
    heroImage: {
        width: '100%',
        height: '100%',
    },
    heroFade: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 160,
    },
    heroOverlay: {
        position: 'absolute',
        bottom: 40,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    heroLogo: {
        width: 80,
        height: 80,
        borderRadius: 20,
    },
    heroTitle: {
        fontSize: 36,
        fontWeight: '800',
        color: COLORS.text,
        textAlign: 'center',
        marginTop: SPACING.m,
        letterSpacing: 0.5,
    },
    heroSubtitle: {
        fontSize: 20,
        fontWeight: '600',
        color: COLORS.secondary,
        textAlign: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.m,
        letterSpacing: 0.3,
    },
    filmLink: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        gap: SPACING.xs,
        marginBottom: SPACING.xl,
        paddingVertical: SPACING.xs,
    },
    filmLinkInline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
        paddingVertical: SPACING.xs,
    },
    filmLinkText: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.primary,
    },

    // Genesis card
    genesisCard: {
        borderColor: 'rgba(232,168,56,0.30)',
        borderTopColor: 'rgba(232,168,56,0.50)',
    },
    genesisDetailsToggle: {
        flex: 1,
        marginRight: SPACING.m,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.s,
        minHeight: 44,
    },
    finePrint: {
        fontSize: 12,
        color: COLORS.textMuted,
        lineHeight: 18,
        marginTop: SPACING.s,
    },
    inviteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        backgroundColor: GOLD,
        borderRadius: 28,
        paddingVertical: 13,
        paddingHorizontal: SPACING.l,
        marginTop: SPACING.l,
    },
    inviteButtonText: {
        fontSize: 16,
        fontWeight: '700',
        color: BG,
        letterSpacing: 0.2,
    },

    // Opening declaration
    declarationWrap: {
        paddingHorizontal: SPACING.l,
        marginBottom: SPACING.xxl,
    },
    declaration: {
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'left',
        lineHeight: 28,
        letterSpacing: 0.2,
    },

    // Section cards
    sectionCard: {
        marginHorizontal: SPACING.m,
        marginBottom: SPACING.l,
        borderRadius: 22,
        overflow: 'hidden',
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
    },
    sectionImage: {
        width: '100%',
        height: 220,
    },
    sectionImageFade: {
        position: 'absolute',
        top: 130,
        left: 0,
        right: 0,
        height: 90,
    },
    sectionContent: {
        padding: SPACING.l,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    sectionTitle: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
        flex: 1,
        marginRight: SPACING.s,
        letterSpacing: -0.2,
    },
    sectionBody: {
        fontSize: 15,
        color: '#9CA3AF',
        lineHeight: 25,
    },

    // Builder section (technical)
    builderCard: {
        borderColor: 'rgba(74,142,232,0.25)',
        borderTopColor: 'rgba(74,142,232,0.40)',
    },
    builderTitle: {
        fontFamily: 'monospace',
        letterSpacing: 1,
    },
    techBlockFirst: {
        marginTop: SPACING.xs,
    },
    techBlock: {
        marginTop: SPACING.l,
        paddingTop: SPACING.l,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    techHeading: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.primary,
        marginBottom: SPACING.s,
        fontFamily: 'monospace',
    },
    techBody: {
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 22,
    },

    // Closing
    closingWrap: {
        paddingHorizontal: SPACING.l,
        marginTop: SPACING.l,
        marginBottom: SPACING.xl,
    },
    closingText: {
        fontSize: 17,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'left',
        lineHeight: 27,
        marginBottom: SPACING.l,
    },
    closingCta: {
        fontSize: 16,
        fontWeight: '500',
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 24,
        marginBottom: SPACING.m,
    },
    closingSignoff: {
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.secondary,
        textAlign: 'center',
        lineHeight: 26,
        fontStyle: 'italic',
        marginBottom: SPACING.xl,
    },
    thesisLine: {
        fontSize: 28,
        fontWeight: '800',
        color: COLORS.secondary,
        textAlign: 'center',
        lineHeight: 38,
        letterSpacing: 1,
    },

    // Share button
    shareButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        borderWidth: 1.5,
        borderColor: COLORS.primary,
        backgroundColor: 'rgba(74,142,232,0.10)',
        borderRadius: 28,
        paddingVertical: 15,
        paddingHorizontal: SPACING.xl,
        marginBottom: SPACING.xl,
        gap: SPACING.s,
    },
    shareButtonText: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.primary,
        letterSpacing: 0.3,
    },

    // Footer
    footerCard: {
        marginHorizontal: SPACING.m,
        backgroundColor: 'rgba(17,24,39,0.80)',
        borderRadius: 22,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        gap: SPACING.m,
    },
    footerLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    footerLinkText: {
        fontSize: 15,
        color: COLORS.primary,
        fontWeight: '600',
    },
    footerNote: {
        fontSize: 12,
        color: COLORS.textMuted,
        textAlign: 'center',
        lineHeight: 18,
        marginTop: SPACING.s,
    },
});

export default VisionScreen;
