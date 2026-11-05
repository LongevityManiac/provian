import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, SPACING } from '../../constants/theme';
import {
  getNetworkConstitution,
  NETWORK_CONSTITUTION_SOURCE,
  NETWORK_CONSTITUTION_SOURCE_SHA256,
} from '../../generated/networkConstitution';
import BackButton from '../../components/BackButton';

/** Canonical reader generated from the repository-root NETWORK_CONSTITUTION.md. */
const NetworkConstitutionScreen = ({ navigation }: { navigation: Pick<NavigationProp<ParamListBase>, 'goBack'> }) => {
  const { t, i18n } = useTranslation();
  const charter = getNetworkConstitution(i18n.resolvedLanguage || i18n.language);
  return (
  <SafeAreaView style={styles.container}>
    <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
    <View style={styles.header}>
      <BackButton onPress={() => navigation.goBack()} color={COLORS.chrome} />
      <Text style={styles.headerTitle}>{charter.title}</Text>
      <View style={styles.headerSpacer} />
    </View>

    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator>
      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{charter.status}</Text>
      </View>
      <Text style={styles.sourceNote}>
        {t('constitutionScreen.canonicalNote')}{'\n'}
        {NETWORK_CONSTITUTION_SOURCE} · {NETWORK_CONSTITUTION_SOURCE_SHA256.slice(0, 12)}
      </Text>

      {charter.sections.map((section, index) => (
        <View key={`${section.title}-${index}`} style={section.level === 1 ? styles.part : styles.article}>
          {section.title ? <Text style={section.level === 1 ? styles.partTitle : styles.articleTitle}>{section.title}</Text> : null}
          {section.body.split('\n\n').filter(Boolean).map((paragraph, paragraphIndex) => (
            paragraph.startsWith('|')
              ? <View key={paragraphIndex} style={styles.table}>{paragraph.split('\n').map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.tableRow}>{row.split('|').slice(1, -1).map((cell, cellIndex) => <Text key={cellIndex} style={[styles.body, cellIndex === 0 ? styles.tableLabel : undefined]}>{cell.trim()}</Text>)}</View>
                ))}</View>
              : <Text key={paragraphIndex} style={[styles.body, styles.paragraph]}>{paragraph}</Text>
          ))}
        </View>
      ))}
    </ScrollView>
  </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E14' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.m, paddingVertical: SPACING.s,
  },
  headerTitle: { flex: 1, color: COLORS.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 44 },
  content: { padding: SPACING.l, paddingBottom: SPACING.xl * 2 },
  statusBox: {
    backgroundColor: 'rgba(245,197,66,0.10)', borderColor: 'rgba(245,197,66,0.28)',
    borderWidth: 1, borderRadius: 16, padding: SPACING.m, marginBottom: SPACING.m,
  },
  statusText: { color: '#F4E3A1', fontSize: 13, lineHeight: 20, fontWeight: '600' },
  sourceNote: {
    color: COLORS.textTertiary, fontSize: 11, lineHeight: 16, marginBottom: SPACING.xl,
    fontFamily: 'monospace',
  },
  part: { marginTop: SPACING.m, marginBottom: SPACING.xl },
  article: { marginBottom: SPACING.xl },
  partTitle: {
    color: COLORS.primary, fontSize: 14, fontWeight: '800', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: SPACING.s,
  },
  articleTitle: { color: COLORS.text, fontSize: 17, fontWeight: '800', marginBottom: SPACING.m },
  paragraph: { marginBottom: SPACING.m },
  table: { borderWidth: 1, borderColor: 'rgba(200,205,214,0.16)', borderRadius: 12, overflow: 'hidden' },
  tableRow: { padding: SPACING.m, borderBottomWidth: 1, borderBottomColor: 'rgba(200,205,214,0.12)', gap: 4 },
  tableLabel: { fontWeight: '700', color: COLORS.text },
  body: { color: COLORS.chromeMuted, fontSize: 14, lineHeight: 22 },
});

export default NetworkConstitutionScreen;
