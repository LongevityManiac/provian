import React from 'react';
import * as Application from 'expo-application';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

const LegalScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();

    const LegalItem = ({ icon, title, description, onPress }: any) => (
        <TouchableOpacity style={styles.legalCard} onPress={onPress}>
            <View style={styles.legalLeft}>
                <View style={styles.iconContainer}>
                    <Ionicons name={icon} size={20} color={COLORS.chromeMuted} />
                </View>
                <View style={styles.legalInfo}>
                    <Text style={styles.legalTitle}>{title}</Text>
                    <Text style={styles.legalDescription}>{description}</Text>
                </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('legal.headerTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.disclaimerCard}>
                    <Ionicons name="information-circle" size={24} color="#4A8EE8" />
                    <Text style={styles.disclaimerText}>
                        {t('legal.disclaimer')}
                    </Text>
                </View>

                <Text style={styles.sectionHeader}>{t('legal.legalDocuments')}</Text>

                <LegalItem
                    icon="reader"
                    title={t('legal.constitution')}
                    description={t('legal.constitutionDesc')}
                    onPress={() => navigation.navigate('NetworkConstitution')}
                />

                <LegalItem
                    icon="document-text"
                    title={t('legal.terms')}
                    description={t('legal.readTerms')}
                    onPress={() => navigation.navigate('TermsOfService')}
                />

                <LegalItem
                    icon="shield-checkmark"
                    title={t('legal.privacy')}
                    description={t('legal.handleData')}
                    onPress={() => navigation.navigate('PrivacyPolicy')}
                />

                <LegalItem
                    icon="book"
                    title={t('legal.openSourceLicenses')}
                    description={t('legal.thirdPartySoftware')}
                    onPress={() => navigation.navigate('OpenSourceNotices')}
                />

                <Text style={styles.sectionHeader}>{t('legal.contactSection')}</Text>

                <LegalItem
                    icon="mail"
                    title={t('legal.contactUs')}
                    description="hello@provian.ai"
                    onPress={() => Linking.openURL('mailto:hello@provian.ai?subject=Provian%20Wallet%20Inquiry')}
                />

                <Text style={styles.sectionHeader}>{t('legal.aboutSection')}</Text>

                <View style={styles.infoSection}>
                    <Text style={styles.infoLabel}>{t('legal.version')}</Text>
                    <Text style={styles.infoValue}>{t('legal.versionValue', { version: Application.nativeApplicationVersion ?? '1.0.0', build: Application.nativeBuildVersion ?? '—' })}</Text>
                </View>


                <View style={styles.provianBrand}>
                    <Ionicons name="shield-checkmark" size={48} color="#4A8EE8" />
                    <Text style={styles.brandName}>{t('legal.brandName')}</Text>
                    <Text style={styles.brandTagline}>{t('legal.brandTagline')}</Text>
                    <Text style={styles.copyright}>{t('legal.copyright')}</Text>
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
    disclaimerCard: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        padding: SPACING.m,
        borderRadius: 20,
        marginBottom: SPACING.xl,
        flexDirection: 'row',
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.20)',
    },
    disclaimerText: {
        flex: 1,
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
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
    legalCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    legalLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    iconContainer: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    legalInfo: {
        flex: 1,
    },
    legalTitle: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 2,
    },
    legalDescription: {
        color: '#8B929E',
        fontSize: 12,
    },
    infoSection: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    infoLabel: {
        color: '#8B929E',
        fontSize: 14,
    },
    infoValue: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '600',
    },
    provianBrand: {
        alignItems: 'center',
        marginTop: SPACING.xl * 2,
        marginBottom: SPACING.xl,
    },
    brandName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        marginTop: SPACING.m,
    },
    brandTagline: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: SPACING.xs,
    },
    copyright: {
        fontSize: 12,
        color: '#9CA3AF',
        marginTop: SPACING.m,
    },
});

export default LegalScreen;
