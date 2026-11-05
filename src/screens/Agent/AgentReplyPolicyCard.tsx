/**
 * AgentReplyPolicyCard (, item 4) — the linked human chooses how their agent
 * answers Commons mail: answer anyone (the default), or ask me first (it answers its human directly
 * and, for anyone else, asks here in the app before replying). The agent is told on every thread read
 * and follows it; nothing on the relay blocks a send.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService, { type AgentReplyPolicyMode } from '../../services/RelayAPIService';

const MODES: readonly AgentReplyPolicyMode[] = ['answer_anyone', 'ask_me_first'];

export default function AgentReplyPolicyCard({ walletId, agentName }: { walletId: string; agentName: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AgentReplyPolicyMode | null>(null);
  const [saving, setSaving] = useState(false);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    RelayAPIService.getAgentReplyPolicy(walletId).then((m) => { if (!cancelled) setMode(m); }, () => undefined);
    return () => { cancelled = true; };
  }, [walletId]));

  const choose = async (next: AgentReplyPolicyMode) => {
    if (saving || next === mode) return;
    setSaving(true);
    const ok = await RelayAPIService.setAgentReplyPolicy(walletId, next);
    setSaving(false);
    if (ok) setMode(next);
    else Alert.alert(t('common.errorTitle'), t('agentDetail.replyPolicySaveFailed'));
  };

  // Nothing is shown until the relay answers: no flash of a choice that may not be the stored one.
  if (mode === null) return null;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="mail-unread-outline" size={18} color={COLORS.primary} />
        <Text style={styles.title}>{t('agentDetail.replyPolicyTitle')}</Text>
      </View>
      <View style={styles.options}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.option, mode === m && styles.optionOn]}
            onPress={() => { void choose(m); }}
            disabled={saving}
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === m, disabled: saving }}
            activeOpacity={0.75}
          >
            <Text style={[styles.optionText, mode === m && styles.optionTextOn]}>
              {t(m === 'answer_anyone' ? 'agentDetail.replyPolicyAnyone' : 'agentDetail.replyPolicyAskFirst')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.sub}>
        {t(mode === 'answer_anyone' ? 'agentDetail.replyPolicyAnyoneSub' : 'agentDetail.replyPolicyAskFirstSub', { name: agentName })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.m, marginBottom: SPACING.m },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginBottom: SPACING.s },
  title: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  options: { flexDirection: 'row', gap: SPACING.s },
  option: { flex: 1, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, paddingVertical: SPACING.s, alignItems: 'center' },
  optionOn: { borderColor: COLORS.primary, backgroundColor: COLORS.primaryMuted },
  optionText: { fontSize: 14, color: COLORS.textSecondary, fontWeight: '500' },
  optionTextOn: { color: COLORS.primary, fontWeight: '600' },
  sub: { fontSize: 13, color: COLORS.textSecondary, marginTop: SPACING.s, lineHeight: 18 },
});
