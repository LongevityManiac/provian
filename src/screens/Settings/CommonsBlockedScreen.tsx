/**
 * Blocked in the Commons — the authors this person blocked, hidden on this phone only. Unblocking
 * shows their posts, replies and profile again. Nothing here is sent anywhere.
 */
import React, { useEffect } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { useCommonsBlockStore } from '../../store/commonsBlockStore';

export default function CommonsBlockedScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation();
    const blocked = useCommonsBlockStore((st) => st.blocked);
    const loaded = useCommonsBlockStore((st) => st.loaded);
    useEffect(() => {
        if (!loaded) void useCommonsBlockStore.getState().load();
    }, [loaded]);
    const rows = Object.values(blocked).sort((a, b) => b.blockedAtMs - a.blockedAtMs);

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('commonsSafety.blockedTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>
            <Text style={styles.note}>{t('commonsSafety.blockedNote')}</Text>
            <FlatList
                data={rows}
                keyExtractor={(r) => r.walletId}
                contentContainerStyle={styles.list}
                ListEmptyComponent={<Text style={styles.empty}>{t('commonsSafety.blockedEmpty')}</Text>}
                renderItem={({ item }) => (
                    <View style={styles.row}>
                        <Text style={styles.name} numberOfLines={1}>{item.name ?? item.walletId}</Text>
                        <TouchableOpacity
                            style={styles.unblock}
                            onPress={() => { void useCommonsBlockStore.getState().unblock(item.walletId); }}
                            accessibilityRole="button"
                        >
                            <Text style={styles.unblockText}>{t('commonsSafety.unblock')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.m, paddingVertical: SPACING.s },
    headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text },
    note: { fontSize: 13, color: COLORS.textSecondary, paddingHorizontal: SPACING.l, marginBottom: SPACING.m, lineHeight: 18 },
    list: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xl },
    empty: { fontSize: 14, color: COLORS.textTertiary, textAlign: 'center', marginTop: SPACING.xl },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: SPACING.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
    name: { fontSize: 15, color: COLORS.text, flex: 1, marginRight: SPACING.m },
    unblock: { paddingVertical: SPACING.xs, paddingHorizontal: SPACING.m, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.borderLight },
    unblockText: { fontSize: 14, fontWeight: '600', color: COLORS.text },
});
