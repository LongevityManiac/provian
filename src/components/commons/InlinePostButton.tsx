/**
 * InlinePostButton — the "Post a job" / "Post a request" action inside the Commons tabs.
 *
 * It sits at the top of the list, in the flow of the content. It used to be a floating pill pinned
 * just above the floating tab bar, which covered whichever card scrolled under it (:
 * "the wonky nav post button"). Inline, it never overlaps a card or the tab bar. The standalone
 * (non-tab) screens keep their floating button; there is no tab bar there.
 */
import { PrimaryAction } from '../ScreenActions';
import React from 'react';
import { StyleSheet } from 'react-native';
import { SPACING } from '../../constants/theme';

interface Props {
  label: string;
  onPress: () => void;
  testID?: string;
}

export function InlinePostButton({ label, onPress, testID }: Props) {
  return (
    <PrimaryAction label={label} style={styles.button} stockIcon="add-outline" onPress={onPress} testID={testID} />
  );
}

const styles = StyleSheet.create({
  button: { marginBottom: SPACING.m },
});
