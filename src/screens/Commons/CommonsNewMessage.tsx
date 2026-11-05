/**
 * CommonsNewMessage (, item 3) — "New message" from the Inbox: pick who to
 * write to (your linked agents first, then a Directory search) and open the direct thread with them.
 * Sending, the message key and the speech window are the thread screen's, unchanged.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import RelayAPIService, { type LinkedAgent } from '../../services/RelayAPIService';
import { composeRecipients, type ComposeRecipient } from '../../core/commons/composeRecipients';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

type Props = NativeStackScreenProps<AppParamList, 'CommonsNewMessage'>;
type DirectoryProfile = { wallet_id: string; display_name: string; participant_type: 'agent' | 'human' };

export default function CommonsNewMessage({ navigation }: Props) {
  const { t } = useTranslation();
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<LinkedAgent[]>([]);
  const [profiles, setProfiles] = useState<DirectoryProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // bumped by "Try again" to re-run the same search
  const [searchAttempt, setSearchAttempt] = useState(0);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    RelayAPIService.getLinkedAgents().then((r) => { if (!cancelled) setAgents(r.linked_agents); }, () => undefined);
    return () => { cancelled = true; };
  }, []));

  // The Directory is searched only once the person types (a short pause between keystrokes).
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) { setProfiles([]); setSearching(false); setSearchFailed(false); return undefined; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      CommonsService.browseRegistry({ q, page_size: 30 })
        .then((r) => { if (!cancelled) { setProfiles(r.profiles); setSearchFailed(false); } })
        .catch(() => { if (!cancelled) { setProfiles([]); setSearchFailed(true); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, searchAttempt]);

  const lists = useMemo(() => composeRecipients({ linkedAgents: agents, profiles, myId, query }), [agents, profiles, myId, query]);
  const open = (r: ComposeRecipient) => navigation.replace('CommonsThread', { counterparty: r.walletId, counterpartyName: r.name });

  const row = (r: ComposeRecipient) => (
    <TouchableOpacity key={r.walletId} style={styles.row} onPress={() => open(r)} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={r.name}>
      <View style={[styles.rowIcon, { backgroundColor: r.kind === 'agent' ? COLORS.secondaryMuted : COLORS.primaryMuted }]}>
        <Ionicons name={r.kind === 'agent' ? 'hardware-chip' : 'person'} size={18} color={r.kind === 'agent' ? COLORS.secondary : COLORS.primary} />
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>{r.name}</Text>
      <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
        <Text style={styles.headerTitle}>{t('commons.newMessageTitle')}</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t('commons.newMessageSearch')}
          placeholderTextColor={COLORS.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {lists.own.length > 0 && <Text style={styles.section}>{t('commons.newMessageYourAgents')}</Text>}
        {lists.own.map(row)}
        <Text style={styles.section}>{t('commons.newMessageDirectory')}</Text>
        {query.trim().length === 0 ? <Text style={styles.hint}>{t('commons.newMessageSearchHint')}</Text>
          : searching ? <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.m }} />
          : searchFailed ? <LoadFailed onRetry={() => setSearchAttempt((n) => n + 1)} />
          : lists.directory.length === 0 ? <Text style={styles.hint}>{t('commons.newMessageNoResults')}</Text>
          : lists.directory.map(row)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  search: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.s, color: COLORS.text, fontSize: 15, marginBottom: SPACING.m },
  section: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: SPACING.m, marginBottom: SPACING.s },
  hint: { color: COLORS.textSecondary, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.s, gap: SPACING.s },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: COLORS.text },
});
