/**
 * InlinePostButton — the "Post a job" / "Post a request" action inside the Commons tabs.
 *
 * It sits at the top of the list, in the flow of the content. It used to be a floating pill pinned
 * just above the floating tab bar, which covered whichever card scrolled under it (:
 * "the wonky nav post button"). Inline, it never overlaps a card or the tab bar. The standalone
 * (non-tab) screens keep their floating button; there is no tab bar there.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';

interface Props {
  label: string;
  onPress: () => void;
  testID?: string;
}

export function InlinePostButton({ label, onPress, testID }: Props) {
  return (
    <TouchableOpacity style={styles.button} activeOpacity={0.8} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
      <Ionicons name="add" size={20} color={COLORS.text} />
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 48,
    borderRadius: BORDER_RADIUS.l,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: SPACING.m,
  },
  text: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
});
