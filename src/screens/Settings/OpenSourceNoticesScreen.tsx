/**
 * OpenSourceNoticesScreen: every third-party component the app is built with (npm packages, iOS
 * pods and the native libraries react-native compiles in, Android runtime libraries), its version,
 * the platform it ships on, its declared license and the license text it ships. The list is
 * generated at build time (scripts/generate-oss-notices.mjs); a stale list fails
 * `npm run check:copy`.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, type ListRenderItem } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS, BORDER_RADIUS } from '../../constants/theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { OSS_NOTICES } from './ossNotices.generated';
import type { OssNotice } from './ossNoticeTypes';
import { noticeKey, noticeLineKey, noticeText, PLATFORM_LABEL_KEYS } from './ossNoticeText';

const keyOf = noticeKey;

const OpenSourceNoticesScreen = ({ navigation }: { navigation: { goBack: () => void } }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState<string | null>(null);

    const renderItem: ListRenderItem<OssNotice> = useCallback(({ item }) => {
        const key = keyOf(item);
        const expanded = open === key;
        const text = expanded ? noticeText(item) : null;
        const lineKey = expanded ? noticeLineKey(item) : null;
        return (
            <TouchableOpacity
                style={styles.card}
                onPress={() => setOpen(expanded ? null : key)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
            >
                <View style={styles.row}>
                    <View style={styles.info}>
                        <Text style={styles.name}>{item.name}</Text>
                        <Text style={styles.meta}>{`${t(PLATFORM_LABEL_KEYS[item.platform])} · ${t('ossNotices.versionLicense', { version: item.version, license: item.license })}`}</Text>
                    </View>
                    <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.textMuted} />
                </View>
                {expanded && text !== null && (
                    <Text style={styles.licenseText} selectable>{text}</Text>
                )}
                {expanded && lineKey !== null && (
                    <Text style={styles.licenseText}>{t(lineKey, { license: item.license })}</Text>
                )}
            </TouchableOpacity>
        );
    }, [open, t]);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('legal.openSourceLicenses')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>
            <FlatList
                data={OSS_NOTICES}
                keyExtractor={keyOf}
                renderItem={renderItem}
                extraData={open}
                initialNumToRender={20}
                contentContainerStyle={styles.content}
                ListHeaderComponent={
                    <View style={styles.introBlock}>
                        <Text style={styles.intro}>{t('ossNotices.intro', { count: OSS_NOTICES.length })}</Text>
                        <Text style={styles.intro}>{t('ossNotices.questions')}</Text>
                    </View>
                }
            />
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.xxl,
    },
    introBlock: {
        marginBottom: SPACING.m,
    },
    intro: {
        color: COLORS.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        marginBottom: SPACING.s,
    },
    card: {
        backgroundColor: COLORS.surface,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    info: {
        flex: 1,
        marginRight: SPACING.s,
    },
    name: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '600',
    },
    meta: {
        color: COLORS.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    licenseText: {
        color: COLORS.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        marginTop: SPACING.m,
    },
});

export default OpenSourceNoticesScreen;
