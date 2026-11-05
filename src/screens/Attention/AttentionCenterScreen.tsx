/**
 * AttentionCenterScreen — one place, on app open, for everything that needs the human's
 * action: pending approval requests, remote presentation requests, and linked agents needing
 * recovery/re-key. Badge-counted from the same source (`loadAttention`); each row opens its action
 * directly. Holds a neutral loading state and never flashes the empty ("all caught up") state
 * before the first load resolves.
 */
import React, { useCallback, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { loadAttention, type AttentionItem, type AttentionSnapshot } from '../../core/attention/attention';
import type { AgentRecoveryAlert } from '../../services/RelayAPIService';
import BackButton from '../../components/BackButton';
import { publishHumanRecoveryAnchor } from '../../core/agents/humanRecoveryAnchor';

function reasonLabel(reason: AgentRecoveryAlert['reason'], t: (k: string) => string): string {
    switch (reason) {
        case 'escrow_missing': return t('attention.reasonEscrowMissing');
        case 'at_rest_secret_nondecrypting': return t('attention.reasonNondecrypting');
        case 'keystore_missing': return t('attention.reasonKeystoreMissing');
        default: return t('attention.reasonAtRestMissing');
    }
}

interface RowMeta { icon: keyof typeof Ionicons.glyphMap; tint: string; title: string; subtitle: string; }

export default function AttentionCenterScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const [snap, setSnap] = useState<AttentionSnapshot | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [anchorFailed, setAnchorFailed] = useState(false);

    const load = useCallback(async () => {
        setSnap(await loadAttention());
    }, []);

    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const rowMeta = useCallback((item: AttentionItem): RowMeta => {
        // Item 4: rows name the agent (the human's name for it), never the raw wallet id.
        const agent = item.agentName || t('attention.unknownAgent');
        if (item.kind === 'recovery_anchor') {
            return {
                icon: 'shield-checkmark-outline', tint: '#E8A838',
                title: t('attention.recoveryAnchorTitle'),
                subtitle: anchorFailed ? t('attention.recoveryAnchorFailed') : t('attention.recoveryAnchorSub'),
            };
        }
        if (item.kind === 'recovery' && item.recovery) {
            return {
                icon: 'warning-outline', tint: '#E8A838',
                title: t('attention.recoveryTitle'),
                subtitle: item.recoveryPending
                    ? t('attention.recoveryPendingSub', { agent: item.agentName || item.recovery.agent_name })
                    : t('attention.recoverySub', { agent: item.agentName || item.recovery.agent_name, reason: reasonLabel(item.recovery.reason, t) }),
            };
        }
        if (item.kind === 'link_request' && item.linkRequest) {
            return {
                icon: 'link-outline', tint: COLORS.warning,
                title: t('attention.linkRequestTitle'),
                subtitle: t('attention.linkRequestSub', { agent }),
            };
        }
        if (item.kind === 'promise' && item.promise && item.promiseReason === 'closeout') {
            return {
                icon: 'checkmark-circle-outline', tint: COLORS.success,
                title: t('attention.promiseCloseoutTitle'),
                subtitle: t('attention.promiseCloseoutSub'),
            };
        }
        if (item.kind === 'challenge' && item.challenge) {
            return {
                icon: 'help-circle-outline', tint: COLORS.warning,
                title: t('attention.challengeTitle'),
                subtitle: t('attention.challengeSub'),
            };
        }
        if (item.kind === 'thread_presentation' && item.threadPresentation) {
            return {
                icon: 'ribbon-outline', tint: COLORS.primary,
                title: t('attention.threadPresentationTitle'),
                subtitle: t('attention.threadPresentationSub'),
            };
        }
        if (item.kind === 'promise' && item.promise) {
            const countered = item.promise.status === 'countered';
            return {
                icon: 'hand-left-outline', tint: COLORS.secondary,
                title: countered ? t('attention.promiseCounteredTitle') : t('attention.promiseOfferTitle'),
                subtitle: countered ? t('attention.promiseCounteredSub') : t('attention.promiseOfferSub'),
            };
        }
        if (item.kind === 'consent' && item.consent) {
            return {
                icon: 'eye-outline', tint: COLORS.primary,
                title: t('attention.consentTitle'),
                subtitle: t('attention.consentSub'),
            };
        }
        if (item.kind === 'presentation' && item.presentation) {
            const verify = item.presentation.status === 'presented';
            return {
                icon: 'ribbon-outline', tint: COLORS.primary,
                title: verify ? t('attention.presentationVerifyTitle') : t('attention.presentationComposeTitle'),
                subtitle: verify
                    ? t('attention.presentationVerifySub', { agent })
                    : t('attention.presentationComposeSub', { agent }),
            };
        }
        if (item.kind === 'job' && item.job) {
            const title = item.job.title;
            switch (item.jobReason) {
                case 'refund': return { icon: 'return-down-back-outline', tint: '#E8A838', title: t('attention.jobRefundTitle'), subtitle: t('attention.jobRefundSub', { title }) };
                case 'applicants': return { icon: 'people-outline', tint: COLORS.primary, title: t('attention.jobApplicantsTitle'), subtitle: t('attention.jobApplicantsSub', { title, count: item.job.applicant_count }) };
                case 'fund': return { icon: 'lock-closed-outline', tint: '#E8A838', title: t('attention.jobFundTitle'), subtitle: t('attention.jobFundSub', { title }) };
                case 'deliver': return { icon: 'hammer-outline', tint: COLORS.secondary, title: t('attention.jobDeliverTitle'), subtitle: t('attention.jobDeliverSub', { title }) };
                default: return { icon: 'cash-outline', tint: COLORS.success, title: t('attention.jobReleaseTitle'), subtitle: t('attention.jobReleaseSub', { title }) };
            }
        }
        if (item.kind === 'thread' && item.thread) {
            return {
                icon: 'chatbubble-ellipses-outline', tint: COLORS.secondary,
                title: t('attention.threadTitle'),
                subtitle: t('attention.threadSub', { anchor: item.thread.anchor_kind.replace('_', ' '), count: item.thread.message_count }),
            };
        }
        return {
            icon: 'checkmark-done-circle', tint: COLORS.platinum,
            title: t('attention.approvalTitle'),
            subtitle: t('attention.approvalSub', { agent }),
        };
    }, [t, anchorFailed]);

    const openItem = useCallback((item: AttentionItem) => {
        if (item.kind === 'recovery_anchor') {
            // The ONE confirmation: publish this wallet's recovery key; every agent without an
            // escrow seals to it on its own (item 11 — no per-agent tap).
            void publishHumanRecoveryAnchor({ prompt: true }).then((outcome) => {
                setAnchorFailed(outcome === 'failed');
                void load();
            });
            return;
        }
        if (item.kind === 'approval') { navigation.navigate('ApprovalInbox'); return; }
        if (item.kind === 'link_request' && item.linkRequest) {
            navigation.navigate('LinkAccept', { inviteId: item.linkRequest.invite_id, agentWalletId: item.linkRequest.agent_wallet_id });
            return;
        }
        if (item.kind === 'promise' && item.promise) {
            navigation.navigate('PromiseDetail', { promiseId: item.promise.promise_id });
            return;
        }
        if (item.kind === 'consent') {
            navigation.navigate('CommonsConsentRequests');
            return;
        }
        if (item.kind === 'challenge' && item.challenge) {
            navigation.navigate('CommonsForumPost', { postId: item.challenge.post_id });
            return;
        }
        if (item.kind === 'thread_presentation' && item.threadPresentation?.thread_id) {
            navigation.navigate('CommonsThread', { threadId: item.threadPresentation.thread_id });
            return;
        }
        if (item.kind === 'presentation' && item.presentation) {
            navigation.navigate('PresentationRequest', { requestId: item.presentation.request_id });
            return;
        }
        if (item.kind === 'recovery' && item.recovery) {
            navigation.navigate('RecoverAgent', { walletId: item.recovery.agent_wallet_id, agentName: item.agentName || item.recovery.agent_name });
            return;
        }
        if (item.kind === 'thread' && item.thread) {
            navigation.navigate('CommonsThread', { threadId: item.thread.thread_id });
            return;
        }
        if (item.kind === 'job' && item.job) {
            navigation.navigate('CommonsHumanJobManage', { jobId: item.job.job_id });
        }
    }, [navigation, load]);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
                <Text style={styles.headerTitle} numberOfLines={1}>{t('attention.title')}</Text>
                <View style={{ width: 44 }} />
            </View>
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
            >
                <Text style={styles.subtitle}>{t('attention.subtitle')}</Text>
                {snap === null ? (
                    <View style={styles.centerBlock}><ActivityIndicator color={COLORS.primary} /></View>
                ) : snap.items.length === 0 ? (
                    <View style={styles.centerBlock}>
                        <Ionicons name="checkmark-circle-outline" size={44} color={COLORS.textMuted} />
                        <Text style={styles.emptyText}>{t('attention.empty')}</Text>
                    </View>
                ) : (
                    snap.items.map((item) => {
                        const meta = rowMeta(item);
                        return (
                            <TouchableOpacity key={item.id} style={styles.row} onPress={() => openItem(item)} activeOpacity={0.75}>
                                <View style={[styles.rowIcon, { backgroundColor: `${meta.tint}22` }]}>
                                    <Ionicons name={meta.icon} size={20} color={meta.tint} />
                                </View>
                                <View style={styles.rowBody}>
                                    <Text style={styles.rowTitle}>{meta.title}</Text>
                                    <Text style={styles.rowSubtitle} numberOfLines={2}>{meta.subtitle}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
                            </TouchableOpacity>
                        );
                    })
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingTop: SPACING.s, paddingBottom: SPACING.s },
    headerTitle: { fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'center', color: COLORS.text },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },
    subtitle: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACING.l },
    centerBlock: { alignItems: 'center', paddingVertical: SPACING.xxxl, gap: SPACING.m },
    emptyText: { color: COLORS.textMuted, fontSize: 14 },
    row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, backgroundColor: 'rgba(18,21,26,0.70)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(200,205,214,0.08)', padding: SPACING.m, marginBottom: SPACING.m },
    rowIcon: { width: 40, height: 40, borderRadius: BORDER_RADIUS.round, alignItems: 'center', justifyContent: 'center' },
    rowBody: { flex: 1, minWidth: 0 },
    rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
    rowSubtitle: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
});
