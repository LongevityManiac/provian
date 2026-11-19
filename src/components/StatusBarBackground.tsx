import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';

export default function StatusBarBackground() {
    const { top } = useSafeAreaInsets();
    return <View pointerEvents="none" style={[styles.background, { height: top }]} />;
}

const styles = StyleSheet.create({
    background: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: COLORS.background, zIndex: 1 },
});
