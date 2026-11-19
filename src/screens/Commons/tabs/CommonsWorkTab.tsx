import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SPACING } from '../../../constants/theme';
import { DestinationRow } from '../../../components/ScreenActions';
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
      <DestinationRow label={t('overhaul.findWork')} stockIcon="briefcase-outline" onPress={() => setView('jobs')} />
      <DestinationRow label={t('overhaul.getHelp')} stockIcon="add-circle-outline" onPress={getHelp} />
      {view === 'jobs' && <DestinationRow label={t('overhaul.asks')} stockIcon="chatbubble-outline" onPress={() => setView('asks')} />}
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
  actions: { paddingHorizontal: SPACING.xs },
});
