/**
 * Commons › Work : paid work and open requests in one place.
 * Institutions — the Commons institution cards (the rows) restored as cards at the
 * top: LIVE Escrow · Bonds · Agent market (each opens its screen), and NOT OPEN
 * Disputes · Voting · Compute market · Insurance (each explains itself on tap —
 * no tile does nothing). Rows are selected BY ID (core/commons/institutionRows.ts).
 * Jobs — the Commons hiring board (people and agents hiring people and agents).
 * Requests — the wants board: "here's what I need", and people and agents reach out.
 * The cards, the Jobs/Requests switch and the hint ride INSIDE the board's own scroll (`header`):
 * as fixed chrome above it they left the list a sliver behind the floating tab bar (on a
 * phone: the first job card sat entirely under the nav).
 */
import React, { useCallback, useState } from 'react';
import { Alert, View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../../constants/theme';
import * as CommonsService from '../../../core/commons/CommonsService';
import type { InstitutionInfo } from '../../../core/commons/CommonsService';
import { selectInstitutionRows, type InstitutionCard } from '../../../core/commons/institutionRows';
import CommonsHumanJobs from '../CommonsHumanJobs';
import CommonsWants from '../CommonsWants';

type WorkView = 'jobs' | 'requests';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

/** Accent per live card (the pre- tile top borders). */
const TILE_ACCENT: Record<string, string> = {
  bank: '#4CC38A',
  bonds: '#B794FF',
  court: '#F2555A',
  market: '#6BA3F0',
};

export default function CommonsWorkTab({ navigation }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<WorkView>('jobs');
  const [catalog, setCatalog] = useState<InstitutionInfo[]>([]);

  useFocusEffect(useCallback(() => {
    let live = true;
    CommonsService.getInstitutions()
      .then((r) => { if (live) setCatalog(r.institutions ?? []); })
      .catch(() => undefined); // the cards render from their fixed ids either way
    return () => { live = false; };
  }, []));

  const rows = selectInstitutionRows(catalog);

  const renderCard = (c: InstitutionCard, notOpen: boolean) => {
    const name = t(c.nameKey);
    const body = (
      <>
        <Ionicons name={c.icon} size={22} color={notOpen ? COLORS.textMuted : COLORS.text} />
        <Text style={[styles.tileName, notOpen && styles.tileNameMuted]} numberOfLines={2}>{name}</Text>
        {c.screen ? <Ionicons name="chevron-forward" size={14} color={COLORS.textSecondary} style={styles.tileChevron} /> : null}
      </>
    );
    if (c.screen) {
      const screen = c.screen;
      return (
        <TouchableOpacity
          key={c.id}
          style={[styles.tile, { borderTopColor: TILE_ACCENT[c.id] ?? COLORS.primary }]}
          onPress={() => navigation.navigate(screen)}
          accessibilityRole="button"
          accessibilityLabel={name}
          activeOpacity={0.8}
        >
          {body}
        </TouchableOpacity>
      );
    }
    // a NOT OPEN card explains itself on tap — no tile does nothing.
    const bodyKey = c.notOpenBodyKey;
    return (
      <TouchableOpacity
        key={c.id}
        style={[styles.tile, notOpen ? styles.tileNotOpen : { borderTopColor: TILE_ACCENT[c.id] ?? COLORS.primary }]}
        onPress={() => Alert.alert(`${name} · ${t('commonsDashboard.notOpenYet')}`, bodyKey ? t(bodyKey) : t('commonsDashboard.notOpenYet'))}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${t('commonsDashboard.notOpenYet')}`}
        activeOpacity={0.8}
      >
        {body}
      </TouchableOpacity>
    );
  };

  const header = (
    <>
      {/* Institutions — LIVE row, then NOT OPEN row */}
      <View style={styles.institutions}>
        <Text style={styles.rowLabel}>{t('commonsDashboard.institutionsLive')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tileRow}>
          {rows.live.map((c) => renderCard(c, false))}
        </ScrollView>
        <Text style={styles.rowLabel}>{t('commonsDashboard.notOpenYet')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tileRow}>
          {rows.notOpen.map((c) => renderCard(c, true))}
        </ScrollView>
      </View>

      <View style={styles.switchRow}>
        {(['jobs', 'requests'] as const).map((v) => (
          <TouchableOpacity
            key={v}
            style={[styles.switchChip, view === v && styles.switchChipActive]}
            onPress={() => setView(v)}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === v }}
          >
            <Text style={[styles.switchText, view === v && styles.switchTextActive]}>
              {v === 'jobs' ? t('commonsHome.workJobs') : t('commonsHome.workRequests')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.hint}>{view === 'jobs' ? t('commonsHome.workJobsHint') : t('commonsHome.workRequestsHint')}</Text>
    </>
  );

  return (
    <View style={styles.container}>
      {view === 'jobs'
        ? <CommonsHumanJobs navigation={navigation} embedded header={header} />
        : <CommonsWants navigation={navigation} embedded header={header} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  institutions: { paddingTop: SPACING.xs },
  rowLabel: {
    fontSize: 11, fontWeight: '700', color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6,
    paddingHorizontal: SPACING.l, marginTop: SPACING.xs, marginBottom: SPACING.xs,
  },
  tileRow: { paddingHorizontal: SPACING.l, gap: SPACING.s },
  tile: {
    width: 104,
    minHeight: 74,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderTopWidth: 2,
  },
  tileNotOpen: { opacity: 0.5, borderTopColor: COLORS.border },
  tileName: { fontSize: 13, fontWeight: '600', color: COLORS.chromeMuted, marginTop: SPACING.xs },
  tileNameMuted: { color: COLORS.textMuted },
  tileChevron: { position: 'absolute', top: SPACING.s, right: SPACING.s },
  switchRow: { flexDirection: 'row', gap: SPACING.s, paddingHorizontal: SPACING.l, marginTop: SPACING.m },
  switchChip: { paddingHorizontal: 16, minHeight: 36, justifyContent: 'center', borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.surfaceHighlight },
  switchChipActive: { backgroundColor: COLORS.primaryMuted, borderWidth: 1, borderColor: COLORS.primary },
  switchText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
  switchTextActive: { color: COLORS.text },
  hint: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18, paddingHorizontal: SPACING.l, marginTop: SPACING.s, marginBottom: SPACING.s },
});
