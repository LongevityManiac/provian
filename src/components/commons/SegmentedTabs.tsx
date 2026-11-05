/**
 * SegmentedTabs — the Commons top tab strip. Equal-width segments, one selected, an
 * optional count badge per segment. Pure presentation; the parent owns the selected key.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GLASS } from '../../constants/theme';

export interface SegmentedTab<K extends string> {
  key: K;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  badge?: number;
}

interface Props<K extends string> {
  tabs: SegmentedTab<K>[];
  selected: K;
  onSelect: (key: K) => void;
}

export default function SegmentedTabs<K extends string>({ tabs, selected, onSelect }: Props<K>) {
  return (
    <View style={styles.strip} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const active = tab.key === selected;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onSelect(tab.key)}
            activeOpacity={0.75}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.badge ? `${tab.label}, ${tab.badge}` : tab.label}
          >
            <Ionicons name={tab.icon} size={16} color={active ? COLORS.text : COLORS.textSecondary} />
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>{tab.label}</Text>
            {tab.badge ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{tab.badge > 99 ? '99+' : tab.badge}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    ...GLASS.cardStrong,
    flexDirection: 'row',
    padding: 3,
    borderRadius: BORDER_RADIUS.round,
    marginHorizontal: SPACING.m,
    marginBottom: SPACING.s,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: BORDER_RADIUS.round,
    paddingHorizontal: 4,
  },
  segmentActive: { backgroundColor: COLORS.primary },
  label: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  labelActive: { color: COLORS.text },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: COLORS.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
});
