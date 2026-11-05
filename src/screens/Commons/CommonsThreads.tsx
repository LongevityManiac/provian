/**
 * CommonsThreads — the human's threads: bilateral, end-to-end encrypted conversations
 * anchored to a job, a want, an escrow, a dispute, or a profile. Every message is a Provenance
 * Envelope sealing only the content hash; the content is ciphertext the relay cannot read.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import { timeAgo } from '../../utils/timeAgo';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { ThreadDocument } from '../../core/commons/CommonsService';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

type Props = NativeStackScreenProps<AppParamList, 'CommonsThreads'>;


export default function CommonsThreads({ navigation }: Props) {
  const { t } = useTranslation();
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
  const [threads, setThreads] = useState<ThreadDocument[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await CommonsService.listThreads();
      setThreads(r.threads);
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsThreads] load error:', err);
      setLoadFailed(true);
      setThreads((prev) => prev ?? []);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const other = (th: ThreadDocument): string => (th.party_a === myId ? th.party_b : th.party_a);
  // the relay attaches each party's published Commons display name; fall back to the short id.
  const nameOf = (th: ThreadDocument): string => th.display_names?.[other(th)] ?? shortAddress(other(th));

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
        <Text style={styles.headerTitle}>{t('commons.threadsTitle')}</Text>
        <TouchableOpacity onPress={() => navigation.navigate('CommonsNewMessage')} style={styles.compose} accessibilityRole="button" accessibilityLabel={t('commons.newMessageTitle')}>
          <Ionicons name="create-outline" size={24} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}>
        <View style={styles.explainer}>
          <Ionicons name="lock-closed-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
          <Text style={styles.explainerText}>{t('commons.threadsExplainer')}</Text>
        </View>
        {threads === null ? (
          <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
        ) : threads.length === 0 && loadFailed ? (
          <LoadFailed onRetry={() => { void load(); }} />
        ) : threads.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="chatbubbles-outline" size={40} color={COLORS.textTertiary} />
            <Text style={styles.emptyText}>{t('commons.threadsEmpty')}</Text>
          </View>
        ) : (
          threads.map((th) => (
            <TouchableOpacity key={th.thread_id} style={[styles.row, th.unread && styles.rowUnread]} onPress={() => navigation.navigate('CommonsThread', { threadId: th.thread_id, counterpartyName: th.display_names?.[other(th)] ?? undefined })} activeOpacity={0.75}>
              <View style={[styles.rowIcon, { backgroundColor: th.parties[other(th)]?.kind === 'agent' ? COLORS.secondaryMuted : COLORS.primaryMuted }]}>
                <Ionicons name={th.parties[other(th)]?.kind === 'agent' ? 'hardware-chip' : 'person'} size={18} color={th.parties[other(th)]?.kind === 'agent' ? COLORS.secondary : COLORS.primary} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>{nameOf(th)}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {t(`commons.anchor_${th.anchor_kind}`)} · {t('commons.threadMessages', { count: th.message_count })} · {timeAgo(th.last_message_at, t)}
                </Text>
              </View>
              {th.unread && <View style={styles.unreadDot} />}
              <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m },
  compose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  explainer: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.m },
  explainerText: { color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 },
  center: { alignItems: 'center', paddingVertical: SPACING.xxl, gap: SPACING.s },
  emptyText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.s, gap: SPACING.s },
  rowUnread: { borderWidth: 1, borderColor: COLORS.primary },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  rowSub: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary },
});
