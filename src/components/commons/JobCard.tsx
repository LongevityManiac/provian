/**
 * JobCard — one job on the Commons hiring board or the Market. The whole card opens the job
 * screen; Apply shows only when the job hires people (a person applies from the app), and when it
 * cannot apply the card says why instead of hiding the button silently.
 *
 * The poster header renders only profile-published fields (display name, avatar, person/agent) —
 * speech is speech: nothing from the presentation vocabulary is shown on a card.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import type { HumanJob } from '../../core/commons/CommonsService';
import { formatHumanJobCompensation } from '../../core/commons/humanJobFormat';
import { applyEligibility, jobCurrencyOf, jobSeekingOf, type ApplyBlockReason, type JobPartyKind } from '../../core/commons/jobBoard';
import { getPublicHeader, type PublicHeader } from '../../core/commons/publicHeaders';
import { timeAgo } from '../../utils/timeAgo';

const JOBS_ACCENT = '#E8A838';

/** Plain words for each reason a viewer cannot apply. */
export function applyBlockText(reason: ApplyBlockReason, t: TFunction): string {
  switch (reason) {
    case 'hires_agents': return t('commonsJobs.applyBlockedHiresAgents');
    case 'hires_people': return t('commonsJobs.applyBlockedHiresPeople');
    case 'not_member': return t('commonsJobs.applyBlockedNotMember');
    case 'own_job': return t('commonsJobs.applyBlockedOwnJob');
    case 'already_applied': return t('commonsJobs.applyBlockedApplied');
    case 'already_hired':
    case 'not_open':
    default: return t('commonsJobs.applyBlockedClosed');
  }
}

/** The poster, as they published themselves. */
export function PosterHeader({ walletId, size = 28 }: { walletId: string; size?: number }) {
  const { t } = useTranslation();
  const [header, setHeader] = useState<PublicHeader | null>(null);
  useEffect(() => {
    let live = true;
    void getPublicHeader(walletId).then((h) => { if (live) setHeader(h); });
    return () => { live = false; };
  }, [walletId]);
  const name = header?.display_name ?? t('commonsJobs.posterUnknown');
  const initials = name.split(' ').slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  return (
    <View style={styles.posterRow}>
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
        {header?.avatar_url ? (
          <Image source={{ uri: header.avatar_url }} style={{ width: size, height: size, borderRadius: size / 2 }} />
        ) : header?.participant_type === 'agent' ? (
          <Ionicons name="hardware-chip" size={size * 0.55} color={COLORS.secondary} />
        ) : (
          <Text style={styles.avatarText}>{initials || '?'}</Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.posterName} numberOfLines={1}>{name}</Text>
        {header ? (
          <Text style={styles.posterKind}>{header.participant_type === 'agent' ? t('commonsJobs.kindAgent') : t('commonsJobs.kindPerson')}</Text>
        ) : null}
      </View>
    </View>
  );
}

interface Props {
  job: HumanJob;
  featuredRank: number | null;
  viewer: { walletId: string | null | undefined; kind: JobPartyKind | null | undefined; appliedJobIds?: ReadonlySet<string> };
  onOpen: (job: HumanJob) => void;
  onApply: (job: HumanJob) => void;
  applying: boolean;
}

export default function JobCard({ job, featuredRank, viewer, onOpen, onApply, applying }: Props) {
  const { t } = useTranslation();
  const seeking = jobSeekingOf(job);
  const currency = jobCurrencyOf(job);
  const isParty = !!viewer.walletId && (job.poster_wallet_id === viewer.walletId || job.accepted_applicant_wallet_id === viewer.walletId);
  const eligibility = applyEligibility(job, viewer);

  return (
    <TouchableOpacity
      style={[styles.card, featuredRank !== null && styles.cardFeatured]}
      onPress={() => onOpen(job)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={job.title}
    >
      <View style={styles.topRow}>
        <PosterHeader walletId={job.poster_wallet_id} />
        {featuredRank !== null && (
          <View style={styles.featuredBadge}>
            <Ionicons name="flame" size={12} color={JOBS_ACCENT} />
            <Text style={styles.featuredText}>{t('commons.featuredRank', { rank: featuredRank })}</Text>
          </View>
        )}
      </View>

      <Text style={styles.title} numberOfLines={2}>{job.title}</Text>

      <View style={styles.chipRow}>
        <View style={styles.chip}>
          <Ionicons name={seeking === 'agent' ? 'hardware-chip-outline' : 'person-outline'} size={12} color={COLORS.textSecondary} />
          <Text style={styles.chipText}>{seeking === 'agent' ? t('commonsJobs.hiresAgent') : t('commonsJobs.hiresPerson')}</Text>
        </View>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{currency === 'usdc' ? 'USDC' : 'PVT'}</Text>
        </View>
        <View style={styles.chip}>
          <Text style={[styles.chipText, styles.capitalize]}>{job.category.replace(/_/g, ' ')}</Text>
        </View>
      </View>

      <Text style={styles.description} numberOfLines={3}>{job.description}</Text>

      <View style={styles.footer}>
        <View style={styles.meta}>
          <Ionicons name={currency === 'usdc' ? 'card' : 'diamond'} size={14} color={COLORS.success} />
          <Text style={styles.comp}>{formatHumanJobCompensation(job)}</Text>
          <Text style={styles.metaMuted}>· {t('commonsHumanJobs.appliedCount', { count: job.applicant_count })}</Text>
          <Text style={styles.metaMuted}>· {timeAgo(job.posted_at, t)}</Text>
        </View>
        {eligibility.canApply ? (
          <TouchableOpacity style={styles.applyButton} onPress={() => onApply(job)} disabled={applying} activeOpacity={0.7} accessibilityRole="button">
            {applying ? <ActivityIndicator size="small" color={COLORS.text} /> : (
              <>
                <Ionicons name="hand-right" size={14} color={COLORS.text} />
                <Text style={styles.applyText}>{t('commonsHumanJobs.apply')}</Text>
              </>
            )}
          </TouchableOpacity>
        ) : isParty ? (
          <View style={styles.openPill}>
            <Ionicons name="settings-outline" size={14} color={COLORS.text} />
            <Text style={styles.applyText}>{t('commonsHumanJobs.manage')}</Text>
          </View>
        ) : (
          <Text style={styles.blocked}>{applyBlockText(eligibility.reason, t)}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 2,
    borderTopColor: JOBS_ACCENT,
    ...SHADOWS.card,
  },
  cardFeatured: { borderColor: 'rgba(232,168,56,0.45)' },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginBottom: SPACING.s },
  posterRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, flex: 1 },
  avatar: { backgroundColor: COLORS.surfaceHighlight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  posterName: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  posterKind: { color: COLORS.textTertiary, fontSize: 11 },
  featuredBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(232,168,56,0.15)', paddingHorizontal: SPACING.s, paddingVertical: 3, borderRadius: BORDER_RADIUS.round,
  },
  featuredText: { color: JOBS_ACCENT, fontSize: 11, fontWeight: '700' },
  title: { fontSize: 16, fontWeight: '600', color: COLORS.text, marginBottom: SPACING.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginBottom: SPACING.s },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.surfaceHighlight, paddingHorizontal: SPACING.s, paddingVertical: 3, borderRadius: BORDER_RADIUS.s,
  },
  chipText: { fontSize: 11, color: COLORS.textSecondary, fontWeight: '600' },
  capitalize: { textTransform: 'capitalize' },
  description: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginBottom: SPACING.s },
  footer: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.s, gap: SPACING.s },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  comp: { fontSize: 13, color: COLORS.success, fontWeight: '600' },
  metaMuted: { fontSize: 12, color: COLORS.textTertiary },
  applyButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, alignSelf: 'flex-end',
    backgroundColor: COLORS.primary, paddingHorizontal: SPACING.m, paddingVertical: SPACING.s, borderRadius: BORDER_RADIUS.round,
  },
  openPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end',
    backgroundColor: 'rgba(232,168,56,0.18)', borderWidth: 1, borderColor: 'rgba(232,168,56,0.45)',
    paddingHorizontal: SPACING.m, paddingVertical: SPACING.s, borderRadius: BORDER_RADIUS.round,
  },
  applyText: { fontSize: 13, fontWeight: '600', color: COLORS.text },
  blocked: { fontSize: 12, color: COLORS.textTertiary, lineHeight: 17 },
});
