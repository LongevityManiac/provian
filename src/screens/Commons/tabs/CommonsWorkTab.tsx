import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SPACING } from '../../../constants/theme';
import { ChoiceChip, PrimaryAction } from '../../../components/ScreenActions';
import CommonsHumanJobs from '../CommonsHumanJobs';
import CommonsWants from '../CommonsWants';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

export default function CommonsWorkTab({ navigation }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<'jobs' | 'asks'>('jobs');
  const getHelp = () => Alert.alert(t('overhaul.getHelp'), undefined, [
    { text: t('commonsHome.postJob'), onPress: () => navigation.navigate('CommonsHumanJobsPost') },
    { text: t('overhaul.asks'), onPress: () => setView('asks') },
    { text: t('common.cancel'), style: 'cancel' },
  ]);

  const header = (
    <View style={styles.actions}>
      <ChoiceChip label={t('overhaul.findWork')} selected={view === 'jobs'} onPress={() => setView('jobs')} />
      <ChoiceChip label={t('overhaul.asks')} selected={view === 'asks'} onPress={() => setView('asks')} />
      <PrimaryAction label={t('overhaul.getHelp')} stockIcon="add-outline" onPress={getHelp} style={styles.action} />
    </View>
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs, paddingHorizontal: SPACING.l, paddingVertical: SPACING.xs },
  action: { marginLeft: 'auto', paddingHorizontal: SPACING.s, paddingVertical: SPACING.s },
});
