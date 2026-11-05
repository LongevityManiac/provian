/**
 * "About the Commons" the plain-words explainer, the network numbers, the institutions
 * (live, and not open yet), a short glossary, and the latest activity. All of this used to crowd
 * the Commons dashboard; it now lives one tap away behind the (i) in the Commons header.
 *
 * the institution lists name the SAME rows as the cards at the top of Commons › Work
 * (core/commons/institutionRows.ts, selected by id) so the two can never disagree.
 */
import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS } from '../../../constants/theme';
import { shortAddress } from '../../../utils/shortAddress';
import { timeAgo } from '../../../utils/timeAgo';
import type { FeedItem, InstitutionInfo } from '../../../core/commons/CommonsService';
import { selectInstitutionRows } from '../../../core/commons/institutionRows';
import { LoadFailed } from '../../../components/commons/LoadFailed';

interface Props {
  visible: boolean;
  onClose: () => void;
  stats: Record<string, unknown>;
  institutions: InstitutionInfo[];
  feed: FeedItem[];
  /** the network numbers and activity could not be loaded; shown instead of placeholder tiles. */
  loadFailed?: boolean;
  onRetry?: () => void;
}

const FEED_INSTITUTION_LABEL: Record<string, string> = {
  registry: 'commonsDashboard.institutionRegistry',
  forum: 'commonsDashboard.institutionForum',
  provenance: 'commonsDashboard.institutionProvenance',
};

const GLOSSARY: { term: string; def: string }[] = [
  { term: 'commonsHome.glossRecordTerm', def: 'commonsHome.glossRecordDef' },
  { term: 'commonsHome.glossPassTerm', def: 'commonsHome.glossPassDef' },
  { term: 'commonsHome.glossBurnTerm', def: 'commonsHome.glossBurnDef' },
  { term: 'commonsHome.glossProofTerm', def: 'commonsHome.glossProofDef' },
  { term: 'commonsHome.glossQuestionTerm', def: 'commonsHome.glossQuestionDef' },
];

export default function CommonsAboutSheet({ visible, onClose, stats, institutions, feed, loadFailed = false, onRetry }: Props) {
  const { t } = useTranslation();
  const rows = selectInstitutionRows(institutions);
  // Pass the count so i18next picks the singular form ("1 Human", not "1 Humans").
  const countLabel = (key: string, value: unknown): string =>
    typeof value === 'number' ? t(key, { count: value }) : t(key);
  const statTiles = [
    { key: 'humans', label: countLabel('commonsDashboard.statMembers', stats.commons_humans), value: stats.commons_humans ?? '–' },
    { key: 'agents', label: countLabel('commonsDashboard.statAgents', stats.commons_agents), value: stats.commons_agents ?? '–' },
    { key: 'posts', label: countLabel('commonsDashboard.statPosts', stats.forum_posts), value: stats.forum_posts ?? '–' },
  ];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} accessibilityLabel={t('common.close', { defaultValue: 'Close' })} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('commonsHome.aboutTitle')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
              <Ionicons name="close" size={24} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            {/* How it works, in three lines */}
            {(['aboutRead', 'aboutTalk', 'aboutEarn'] as const).map((k, i) => (
              <View key={k} style={styles.stepRow}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>{i + 1}</Text></View>
                <Text style={styles.stepText}>{t(`commonsHome.${k}`)}</Text>
              </View>
            ))}

            {loadFailed && onRetry ? (
              <LoadFailed onRetry={onRetry} />
            ) : (
              <View style={styles.statsRow}>
                {statTiles.map((s) => (
                  <View key={s.key} style={styles.statCard}>
                    <Text style={styles.statValue}>{String(s.value)}</Text>
                    <Text style={styles.statLabel}>{s.label}</Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.sectionTitle}>{t('commonsHome.glossaryTitle')}</Text>
            {GLOSSARY.map((g) => (
              <View key={g.term} style={styles.glossRow}>
                <Text style={styles.glossTerm}>{t(g.term)}</Text>
                <Text style={styles.glossDef}>{t(g.def)}</Text>
              </View>
            ))}

            <Text style={styles.sectionTitle}>{t('commonsDashboard.institutionsLive')}</Text>
            <Text style={styles.note}>{t('commonsDashboard.institutionsLiveNote')}</Text>
            <Text style={styles.list}>{rows.live.map((c) => t(c.nameKey)).join(' · ')}</Text>

            <Text style={styles.sectionTitle}>{t('commonsDashboard.notOpenYet')}</Text>
            <Text style={styles.list}>{rows.notOpen.map((c) => t(c.nameKey)).join(' · ')}</Text>

            {feed.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{t('commonsDashboard.recentActivity')}</Text>
                {feed.slice(0, 8).map((item) => (
                  <View key={item.id} style={styles.feedRow}>
                    <Text style={styles.feedSummary} numberOfLines={2}>
                      <Text style={styles.feedActor}>{item.actor_display_name || shortAddress(item.actor_wallet_id)}</Text>
                      {'  '}{item.summary}
                    </Text>
                    <Text style={styles.feedMeta}>
                      {FEED_INSTITUTION_LABEL[item.institution] ? t(FEED_INSTITUTION_LABEL[item.institution]) : item.institution} · {timeAgo(item.timestamp, t)}
                    </Text>
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: { backgroundColor: COLORS.surfaceElevated, borderTopLeftRadius: BORDER_RADIUS.xl, borderTopRightRadius: BORDER_RADIUS.xl, maxHeight: '88%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingTop: SPACING.l, paddingBottom: SPACING.s },
  title: { fontSize: 20, fontWeight: '600', color: COLORS.text },
  body: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.m, marginTop: SPACING.m },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { color: COLORS.primary, fontWeight: '700', fontSize: 13 },
  stepText: { flex: 1, color: COLORS.text, fontSize: 15, lineHeight: 22 },
  statsRow: { flexDirection: 'row', gap: SPACING.s, marginTop: SPACING.l },
  statCard: { ...GLASS.card, flex: 1, alignItems: 'center', paddingVertical: SPACING.m },
  statValue: { fontSize: 20, fontWeight: '600', color: COLORS.text },
  statLabel: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: SPACING.l, marginBottom: SPACING.s },
  glossRow: { marginBottom: SPACING.s },
  glossTerm: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  glossDef: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 2 },
  note: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: SPACING.s },
  list: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
  feedRow: { paddingVertical: SPACING.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  feedActor: { color: COLORS.text, fontWeight: '600' },
  feedSummary: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  feedMeta: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },
});
