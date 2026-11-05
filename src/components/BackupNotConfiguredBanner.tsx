import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
/**
 * BackupNotConfiguredBanner
 *
 * Persistent warning shown on the wallet home screen when the user chose
 * "Skip for now" during onboarding and hasn't set up backup since.
 *
 * Behavior:
 * - Polls AsyncStorage on mount and on screen focus for `@provian_backup_skipped`.
 * - Renders only if the flag is 'true' and the user hasn't dismissed it this session.
 * - Dismiss is in-memory only - the banner returns on next launch until the
 *   user actually completes backup (at which point onboarding clears the flag
 *   to 'false', or SecurityInfoService can clear it when backup finishes).
 * - Tap anywhere on the banner navigates to the Recovery setup screen.
 *
 * Non-blocking by design. No full-screen modal, no OS alert, just an
 * amber card at the top of the wallet home.
 */

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { SPACING } from '../constants/theme';
import { BACKUP_SKIPPED_KEY } from '../core/recovery/phraseBackup';

const STORAGE_KEY = BACKUP_SKIPPED_KEY;

interface Props {
  onPress: () => void;
}

const BackupNotConfiguredBanner: React.FC<Props> = ({ onPress }) => {
  useTranslation();
  const [isSkipped, setIsSkipped] = useState<boolean>(false);
  // Dismissal is per-session: held in component state, never persisted.
  // Unmounting the component (app restart) resets this to false and the
  // banner comes back if the flag is still true.
  const [dismissedThisSession, setDismissedThisSession] = useState<boolean>(false);

  const refresh = React.useCallback(async () => {
    try {
      const val = await AsyncStorage.getItem(STORAGE_KEY);
      setIsSkipped(val === 'true');
    } catch {
      setIsSkipped(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [refresh])
  );

  if (!isSkipped || dismissedThisSession) return null;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={i18next.t('ui.backupBanner.accessibility')}
    >
      <View style={styles.iconContainer}>
        <Ionicons name="warning" size={22} color="#E8A838" />
      </View>
      <View style={styles.content}>
        <Text style={styles.title}>{i18next.t('recovery.backupNotConfigured')}</Text>
        <Text style={styles.subtitle}>
          {i18next.t('ui.backupBanner.body')}</Text>
      </View>
      <TouchableOpacity
        style={styles.dismiss}
        onPress={(e) => {
          e.stopPropagation();
          setDismissedThisSession(true);
        }}
        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
        accessibilityRole="button"
        accessibilityLabel={i18next.t('ui.backupBanner.dismiss')}
      >
        <Ionicons name="close" size={18} color="#8B929E" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACING.m,
    marginVertical: SPACING.s,
    padding: SPACING.m,
    borderRadius: 14,
    backgroundColor: 'rgba(232, 168, 56, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(232, 168, 56, 0.28)',
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(232, 168, 56, 0.14)',
    marginRight: SPACING.m,
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFD580',
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#CCAA55',
    lineHeight: 16,
  },
  dismiss: {
    padding: 4,
    marginLeft: SPACING.s,
  },
});

export default BackupNotConfiguredBanner;
