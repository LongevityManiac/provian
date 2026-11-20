import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import BackButton from '../../components/BackButton';
import SettleNowCard from '../../components/SettleNowCard';
import { COLORS, SPACING } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';

export default function SettleNowScreen({ navigation }: NativeStackScreenProps<AppParamList, 'SettleNow'>) {
    return <SafeAreaView style={styles.screen}>
        <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /></View>
        <ScrollView contentContainerStyle={styles.content}>
            <SettleNowCard />
        </ScrollView>
    </SafeAreaView>;
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: COLORS.background },
    header: { padding: SPACING.m },
    content: { paddingHorizontal: SPACING.m, paddingBottom: SPACING.l },
});
