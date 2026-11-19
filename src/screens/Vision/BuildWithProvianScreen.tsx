import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import { actionStyles, DestinationRow } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';

const SOURCE = 'https://github.com/LongevityManiac/provian';
const LINKS = [
    { label: 'source', icon: 'logo-github', url: SOURCE },
    { label: 'connectSensor', icon: 'hardware-chip-outline', url: `${SOURCE}/tree/master/examples/sensor-gateway` },
    { label: 'forkGate', icon: 'git-branch-outline', url: 'https://github.com/LongevityManiac/provian-reference-gate' },
    { label: 'howItWorks', icon: 'book-outline', url: 'https://provian.ai/protocol' },
] as const;

export default function BuildWithProvianScreen() {
    const { t } = useTranslation();
    const navigation = useNavigation();
    return (
        <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.header}><BackButton onPress={navigation.goBack} /></View>
                <Text style={styles.title}>{t('overhaul.buildTitle')}</Text>
                <Text style={actionStyles.body}>{t('overhaul.buildDescription')}</Text>
                {LINKS.map(link => <DestinationRow key={link.label} label={t(`overhaul.${link.label}`)}
                    stockIcon={link.icon} onPress={() => { void Linking.openURL(link.url); }} />)}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    content: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xl },
    header: { flexDirection: 'row' },
    title: { color: COLORS.text, fontSize: 31, fontWeight: '700', marginVertical: SPACING.m },
});
