/**
 * Commons › People : the directory of everyone in the Commons — people and AI agents — with
 * your own agents and the top contributors above it. (Both used to sit on the long dashboard.)
 */
import { ActionTouchable } from '../../../components/ScreenActions';
import ProvianIcon from '../../../components/ProvianIcon';
import { PublicStandingLine } from '../../../components/commons/PublicStandingLine';
import { projectPublicStanding } from '../../../core/commons/publicHeaders';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS } from '../../../constants/theme';
import RelayAPIService, { LinkedAgent } from '../../../services/RelayAPIService';
import * as CommonsService from '../../../core/commons/CommonsService';
import type { CommonsProfile as CommonsProfileType } from '../../../core/commons/CommonsService';
import CommonsRegistry from '../CommonsRegistry';
import { LoadFailed } from '../../../components/commons/LoadFailed';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

export default function CommonsPeopleTab({ navigation }: Props) {
  const { t } = useTranslation();
  const [linkedAgents, setLinkedAgents] = useState<LinkedAgent[] | null>(null);
  const [agentsLoadFailed, setAgentsLoadFailed] = useState(false);
  const [agentCommonsProfiles, setAgentCommonsProfiles] = useState<Map<string, CommonsProfileType>>(new Map());
  const loadAgents = useCallback(async () => {
    const linkedData = await RelayAPIService.getLinkedAgents({ throwOnError: true }).catch((): null => null);
    if (!linkedData) {
      // keep agents already shown; with none shown, the section says it could not load
      setLinkedAgents((prev) => prev ?? []);
      setAgentsLoadFailed(true);
      return;
    }
    setAgentsLoadFailed(false);
    // Commons profiles are keyed by WALLET id (route /agent/:walletId); the map is keyed by
    // agent_id because that is what the row looks up. linked records are the only
    // relay-side agent records — sessions no longer exist.
    const profileMap = new Map<string, CommonsProfileType>();
    await Promise.all(linkedData.linked_agents.map(async (a) => {
      try {
        const p = await CommonsService.getAgentProfile(a.wallet_id);
        profileMap.set(a.agent_id, p);
      } catch {
        // Agent hasn't joined Commons yet - that's fine
      }
    }));
    setAgentCommonsProfiles(profileMap);
    setLinkedAgents(linkedData.linked_agents);
  }, []);

  useFocusEffect(useCallback(() => {
    void loadAgents();
  }, [loadAgents]));

  const header = (
    <View>
      {/* Your agents */}
      {linkedAgents !== null && (
        linkedAgents.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsDashboard.yourAgents')}</Text>
            {linkedAgents.map((s) => {
              const commonsProfile = agentCommonsProfiles.get(s.agent_id);
              return (
                <ActionTouchable
                  key={s.wallet_id}
                  style={styles.agentRow}
                  onPress={() =>
                    commonsProfile
                      ? navigation.navigate('CommonsProfile', { walletId: commonsProfile.wallet_id })
                      : Alert.alert(s.display_name || s.agent_id, t('commonsDashboard.agentJoinExplainer'))
                  }
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  <View style={styles.agentIcon}>
                    <ProvianIcon name="agent" size={22} color={COLORS.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.agentName} numberOfLines={1}>{commonsProfile?.display_name || s.display_name || s.agent_id}</Text>
                    {commonsProfile
                      ? <PublicStandingLine walletId={commonsProfile.wallet_id} kind="agent" standing={projectPublicStanding(commonsProfile)} />
                      : <Text style={styles.agentMeta}>{t('commonsDashboard.agentNotJoined')}</Text>}
                  </View>
                  <Ionicons name={commonsProfile ? 'chevron-forward' : 'information-circle-outline'} size={16} color={COLORS.textMuted} />
                </ActionTouchable>
              );
            })}
          </View>
        ) : agentsLoadFailed ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsDashboard.yourAgents')}</Text>
            <LoadFailed onRetry={() => { void loadAgents(); }} />
          </View>
        ) : (
          <ActionTouchable
            style={styles.connectRow}
            // Straight to the AGENT connect flow (code + one-command screen), not the Agents hub.
            onPress={() => navigation.navigate('ConnectAgent', { mode: 'agent' })}
            activeOpacity={0.75}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={20} color={COLORS.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.connectTitle}>{t('commonsDashboard.connectAgent')}</Text>
              <Text style={styles.agentMeta}>{t('commonsDashboard.noAgentsText')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
          </ActionTouchable>
        )
      )}


    </View>
  );

  return <CommonsRegistry navigation={navigation} embedded listHeader={header} />;
}

const styles = StyleSheet.create({
  section: { marginBottom: SPACING.l },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.s },
  card: { ...GLASS.card, padding: SPACING.m },
  agentRow: { ...GLASS.card, flexDirection: 'row', alignItems: 'center', padding: SPACING.m, marginBottom: SPACING.s, gap: SPACING.m },
  agentIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  agentName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  agentMeta: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  connectRow: { ...GLASS.card, flexDirection: 'row', alignItems: 'center', padding: SPACING.m, marginBottom: SPACING.l, gap: SPACING.m, borderStyle: 'dashed', borderColor: COLORS.borderFocus },
  connectTitle: { fontSize: 15, fontWeight: '600', color: COLORS.primary },
  lbHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.s },
  lbTitle: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  windowToggle: { flexDirection: 'row', gap: 6 },
  windowChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.surfaceHighlight },
  windowChipActive: { backgroundColor: COLORS.primaryMuted },
  windowChipText: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },
  windowChipTextActive: { color: COLORS.text },
  lbRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 6, borderRadius: BORDER_RADIUS.s },
  lbRowYou: { backgroundColor: COLORS.primaryMuted },
  lbRank: { width: 34, fontSize: 13, color: COLORS.textSecondary, fontWeight: '600' },
  lbName: { flex: 1, fontSize: 14, color: COLORS.text },
  lbCount: { fontSize: 12, color: COLORS.textSecondary },
});
