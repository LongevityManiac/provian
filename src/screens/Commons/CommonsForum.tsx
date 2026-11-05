/**
 * CommonsForum — the forum as its own route (deep links, push, the legacy dashboard entry).
 *
 * a thin wrapper — a header (back, title, talking-pass pill) around the shared ForumFeed,
 * which the Commons shell also embeds in its Feed tab. All forum behavior lives in
 * src/components/commons/forum/.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, TYPE_SCALE } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import ForumFeed from '../../components/commons/forum/ForumFeed';
import TalkingPassPill from '../../components/commons/TalkingPassPill';
import BackButton from '../../components/BackButton';

type Props = NativeStackScreenProps<AppParamList, 'CommonsForum'>;

export default function CommonsForum({ navigation }: Props) {
  const { t } = useTranslation();
  const nav = navigation as unknown as { navigate: (screen: string, params?: Record<string, unknown>) => void };
  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <Text style={styles.title} numberOfLines={1}>{t('commons.forumTitle')}</Text>
        <TalkingPassPill />
      </View>
      <ForumFeed navigation={nav} embedded={false} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.s, paddingVertical: SPACING.xs, gap: SPACING.s },
  title: { ...TYPE_SCALE.headingMd, color: COLORS.text, flex: 1 },
});
