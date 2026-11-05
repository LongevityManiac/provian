import NotificationService from '../../services/NotificationService';
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../theme';
import { saveLanguagePreference } from '../../i18n';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

type Language = {
    code: string;
    nameKey: string;
    nativeName: string;
};

const LANGUAGES: Language[] = [
    { code: 'en', nameKey: 'language.names.en', nativeName: 'English' },
    { code: 'es', nameKey: 'language.names.es', nativeName: 'Espa\u00F1ol' },
    { code: 'fr', nameKey: 'language.names.fr', nativeName: 'Fran\u00E7ais' },
    { code: 'pt', nameKey: 'language.names.pt', nativeName: 'Portugu\u00EAs' },
    { code: 'hi', nameKey: 'language.names.hi', nativeName: '\u0939\u093F\u0928\u094D\u0926\u0940' },
    { code: 'id', nameKey: 'language.names.id', nativeName: 'Bahasa Indonesia' },
    { code: 'ja', nameKey: 'language.names.ja', nativeName: '\u65E5\u672C\u8A9E' },
    { code: 'ko', nameKey: 'language.names.ko', nativeName: '\uD55C\uAD6D\uC5B4' },
    { code: 'vi', nameKey: 'language.names.vi', nativeName: 'Ti\u1EBFng Vi\u1EC7t' },
    { code: 'zh', nameKey: 'language.names.zh', nativeName: '\u7B80\u4F53\u4E2D\u6587' },
    { code: 'tl', nameKey: 'language.names.tl', nativeName: 'Filipino' },
    { code: 'sw', nameKey: 'language.names.sw', nativeName: 'Kiswahili' },
];

const LanguageScreen = ({ navigation }: any) => {
    const { t, i18n } = useTranslation();
    const { colors: themeColors } = useTheme();
    const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);

    const handleSelectLanguage = async (code: string) => {
        setSelectedLanguage(code);
        await i18n.changeLanguage(code);
        await saveLanguagePreference(code);
        await NotificationService.ensurePushRegistration({ prompt: false });
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('language.headerTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.infoCard}>
                    <Ionicons name="language" size={24} color="#4A8EE8" />
                    <Text style={styles.infoText}>
                        {t('language.infoText')}
                    </Text>
                </View>

                <Text style={styles.sectionHeader}>{t('language.availableLanguages')}</Text>

                {LANGUAGES.map((language) => (
                    <TouchableOpacity
                        key={language.code}
                        style={[
                            styles.languageCard,
                            selectedLanguage === language.code && styles.languageCardSelected
                        ]}
                        onPress={() => handleSelectLanguage(language.code)}
                    >
                        <View style={styles.languageInfo}>
                            <Text style={styles.languageName}>{t(language.nameKey)}</Text>
                            <Text style={styles.languageNative}>{language.nativeName}</Text>
                        </View>
                        {selectedLanguage === language.code && (
                            <Ionicons name="checkmark-circle" size={24} color="#4A8EE8" />
                        )}
                    </TouchableOpacity>
                ))}
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
    },
    infoCard: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        padding: SPACING.m,
        borderRadius: 20,
        marginBottom: SPACING.xl,
        flexDirection: 'row',
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.20)',
    },
    infoText: {
        flex: 1,
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 20,
    },
    sectionHeader: {
        color: '#9CA3AF',
        fontSize: 11,
        fontWeight: '600',
        marginBottom: SPACING.m,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    languageCard: {
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
    languageCardSelected: {
        borderColor: 'rgba(74,142,232,0.30)',
        backgroundColor: 'rgba(74,142,232,0.08)',
    },
    languageInfo: {
        flex: 1,
    },
    languageName: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
    },
    languageNative: {
        color: '#8B929E',
        fontSize: 14,
    },
});

export default LanguageScreen;
