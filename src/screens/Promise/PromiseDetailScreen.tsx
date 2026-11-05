import { enumDisplayCopy } from '../../i18n/displayCopy';
import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Alert,
    ActivityIndicator,
    TextInput,
    Modal,
    Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { safeFormatDate } from '../../utils/safeDate';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useTheme } from '../../theme';
import { useWalletStore } from '../../store/walletStore';
import PromiseService, { PromiseRecord as PromiseType, PromiseEvent } from '../../core/promises/PromiseService';
import { PROMISE_ACTION_STATUSES, counterOfferView } from './promiseActions';
import type { IoniconsName } from '../../types/icons';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';

const PromiseDetailScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const { promiseId, openedAt } = route.params;
    const { address, userName } = useWalletStore();
    const { colors: themeColors } = useTheme();
    const [promise, setPromise] = useState<PromiseType | null>(null);

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);
    const [showQR, setShowQR] = useState(false);
    const [showDisputeModal, setShowDisputeModal] = useState(false);
    const [disputeReason, setDisputeReason] = useState('');
    // minimal counter editor (re-propose new terms on a still-open promise).
    const [showCounterModal, setShowCounterModal] = useState(false);
    const [counterGave, setCounterGave] = useState('');
    const [counterOwe, setCounterOwe] = useState('');

    useEffect(() => {
        loadPromise();
        // Live remote close-out: reconcile events from the counterparty's phone
        // (they accept, request a close-out, agree to one, or dispute) so the two
        // parties can settle a promise without being co-located. No-op when the
        // relay is unavailable; the in-person QR flow is unaffected.
        let unsubscribe: (() => void) | undefined;
        (async () => {
            await PromiseService.syncPendingPromises().catch(() => {});
            unsubscribe = PromiseService.subscribeToUpdates(promiseId, (updated) => {
                setPromise({ ...updated });
            });
            loadPromise();
        })();
        return () => { unsubscribe?.(); };
    }, [promiseId]);

    // Opened again from a link or a notification while already showing this promise: the screen
    // does not remount, so pick up what the link adopted or the relay now holds.
    const firstOpen = useRef(openedAt);
    useEffect(() => {
        if (openedAt === undefined || openedAt === firstOpen.current) return;
        void (async () => {
            await PromiseService.syncPendingPromises().catch(() => {});
            await loadPromise();
        })();
    }, [openedAt]);

    const loadPromise = async () => {
        try {
            const data = await PromiseService.getPromise(promiseId);
            // A copy: a relay sync changes the stored record in place, and handing React the same
            // object again would not re-render (two-sim proof, 2026-10-17: the screen kept showing
            // "waiting" after its own sync had moved the promise to countered).
            setPromise(data ? { ...data } : null);
        } catch (error) {
            console.error('[PromiseDetail] Load error:', error);
        } finally {
            setLoading(false);
        }
    };

    // P4-06: accept an IMPORTED (recipient) pending promise from the share-link
    // "Open to accept" path. Mirrors ScanPromiseScreen's accept flow via the
    // service, then reports whether the acceptance synced to the counterparty.
    const handleAccept = () => {
        Alert.alert(
            t('promise.acceptThisPromise'),
            t('promise.acceptImportedConfirm', { who: promise?.who ?? '' }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.accept'),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            const acceptorName = userName || 'Anonymous';
                            const result = await PromiseService.acceptImportedPromise(
                                promiseId, address, acceptorName,
                            );
                            loadPromise();
                            if (result?.mode === 'accepted_synced') {
                                Alert.alert(
                                    t('common.success'),
                                    t('promise.acceptedSynced', { who: promise?.who ?? '' }),
                                );
                            } else {
                                Alert.alert(t('common.success'), t('promise.acceptedLocal'));
                            }
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToAccept'));
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    const handleDecline = () => {
        Alert.alert(
            t('promise.declinePromise'),
            t('promise.declineConfirm', { who: promise?.who ?? '' }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.decline'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await PromiseService.declineImportedPromise(promiseId, address);
                            loadPromise();
                            Alert.alert(t('promise.declined'), t('promise.declinedMsg'));
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToUpdate'));
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    // open the counter editor, pre-filled with the current terms.
    const handleCounter = () => {
        setCounterGave(promise?.theyGave ?? '');
        setCounterOwe(promise?.theyOwe ?? '');
        setShowCounterModal(true);
    };

    // Submit a counter-offer: re-propose new terms (signs phase `counter` over the
    // new digest, publishes to the relay). The counterparty then re-shares/imports
    // the new terms to accept — so we prompt to re-share the link.
    const submitCounter = async () => {
        if (!counterGave.trim() || !counterOwe.trim()) {
            Alert.alert(t('common.required'), t('promise.counterRequiredTerms'));
            return;
        }
        setActionLoading(true);
        try {
            await PromiseService.counterPromise(promiseId, address, {
                theyGave: counterGave.trim(),
                theyOwe: counterOwe.trim(),
                dueDate: promise?.dueDate,
            });
            setShowCounterModal(false);
            loadPromise();
            requestAttentionRefresh();
            // The other party sees the counter's terms only through a re-shared link (their
            // copy on the relay is encrypted to this wallet), so offer the share right here.
            Alert.alert(
                t('promise.counterSentTitle'),
                t('promise.counterSentBody', { who: promise?.who ?? '' }),
                [
                    { text: t('common.close'), style: 'cancel' },
                    { text: t('promise.shareLink'), onPress: () => { void handleShareCounter(); } },
                ],
            );
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('promise.failedToCounter'));
        } finally {
            setActionLoading(false);
        }
    };

    // 2026-10-17: share the E2E link carrying THIS device's current terms — after a counter,
    // the counter's terms. The other phone adopts them only if they hash to the digest the
    // relay holds for the counter, then can accept, counter or decline.
    const handleShareCounter = async () => {
        const current = await PromiseService.getPromise(promiseId);
        if (!current) return;
        try {
            const urls = await PromiseService.buildShareLink(current);
            const name = userName || t('promise.someone');
            await Share.share({
                message: [
                    t('promise.shareCounterMessage', { name }),
                    '',
                    t('promise.shareCounterOpen', { url: urls.universalUrl }),
                    '',
                    t('promise.shareCounterFallback', { url: urls.fallbackUrl }),
                ].join('\n'),
                title: t('promise.counterTitle'),
            });
        } catch {
            // Never log the share URLs (they carry the fragment key).
            Alert.alert(t('common.errorTitle'), t('promise.failedToShareCounter'));
        }
    };

    // 2026-10-17: accept the other party's counter-offer — sign the counter's terms and record
    // it on the relay; this phone shows `accepted` only once the relay has it.
    const handleAcceptCounter = () => {
        if (!promise) return;
        Alert.alert(
            t('promise.acceptCounterTitle'),
            t('promise.acceptCounterConfirm', { terms: PromiseService.getPromiseDisplayText(promise), who: promise.who }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.accept'),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await PromiseService.acceptCounterOffer(promiseId, address);
                            requestAttentionRefresh();
                            loadPromise();
                            Alert.alert(t('common.success'), t('promise.counterAcceptedBody', { who: promise.who }));
                        } catch {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToAcceptCounter'));
                            loadPromise();
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ],
        );
    };

    // 2026-10-17: decline the other party's counter-offer, or withdraw this device's own.
    const handleDeclineCounter = (withdraw: boolean) => {
        if (!promise) return;
        Alert.alert(
            withdraw ? t('promise.withdrawCounterTitle') : t('promise.declineCounterTitle'),
            t('promise.declineCounterConfirm', { who: promise.who }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: withdraw ? t('promise.withdrawCounter') : t('promise.decline'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await PromiseService.declineCounterOffer(promiseId, address);
                            requestAttentionRefresh();
                            loadPromise();
                            Alert.alert(t('promise.declined'), t('promise.counterDeclinedBody', { who: promise.who }));
                        } catch {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToDeclineCounter'));
                            loadPromise();
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ],
        );
    };

    const handleFulfill = () => {
        Alert.alert(
            t('promise.markFulfilled'),
            t('promise.markFulfilledConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.yesFulfilled'),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            // Remote-aware: when the counterparty is on another phone
                            // this initiates a mutual close-out (awaits their agree);
                            // offline / in-person it falls back to a local fulfill.
                            const result = await PromiseService.closeOutPromise(promiseId, address);
                            requestAttentionRefresh(); // item 9: a close-out moves the bell
                            loadPromise();
                            if (result?.mode === 'awaiting_counterparty') {
                                Alert.alert(
                                    t('promise.closeoutRequestedTitle'),
                                    t('promise.closeoutRequestedSent', { who: promise?.who ?? '' }),
                                );
                            } else if (result?.mode === 'offline_pending') {
                                // Relay-backed but offline: recorded locally, NOT settled.
                                Alert.alert(
                                    t('promise.closeoutOfflineTitle'),
                                    t('promise.closeoutOfflineBody', { who: promise?.who ?? '' }),
                                );
                            } else {
                                Alert.alert(t('common.success'), t('promise.promiseFulfilled'));
                            }
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToUpdate'));
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    const handleAgreeCloseout = () => {
        Alert.alert(
            t('promise.closeoutRequestedTitle'),
            t('promise.closeoutAgreePrompt', { who: promise?.who ?? '' }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.closeoutAgreeConfirm'),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            // Counterparty already posted their close-out tag, so this
                            // finalizes it: status fulfilled, both signatures recorded.
                            await PromiseService.closeOutPromise(promiseId, address);
                            requestAttentionRefresh(); // item 9: my close-out clears the bell
                            loadPromise();
                            Alert.alert(t('common.success'), t('promise.closeoutClosed'));
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToUpdate'));
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    const handleBroken = () => {
        Alert.alert(
            t('promise.markBroken'),
            t('promise.markBrokenConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.yesMarkBroken'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await PromiseService.markBroken(promiseId, address);
                            loadPromise();
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToUpdate'));
                        } finally {
                            setActionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    const handleDispute = async () => {
        if (!disputeReason.trim()) {
            Alert.alert(t('common.required'), t('promise.disputeReason'));
            return;
        }

        setActionLoading(true);
        try {
            await PromiseService.disputePromise(promiseId, address, disputeReason);
            setShowDisputeModal(false);
            setDisputeReason('');
            loadPromise();
            Alert.alert(t('promise.disputed'), t('promise.disputedMsg'));
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('promise.failedToDispute'));
        } finally {
            setActionLoading(false);
        }
    };

    const handleDelete = () => {
        Alert.alert(
            t('promise.deletePromise'),
            t('promise.deleteConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: async () => {
                        await PromiseService.deletePromise(promiseId);
                        navigation.goBack();
                    },
                },
            ]
        );
    };

    const getEventIcon = (type: string): IoniconsName => {
        switch (type) {
            case 'created':
                return 'add-circle';
            case 'accepted':
                return 'checkmark-circle';
            case 'fulfilled':
                return 'checkmark-circle';
            case 'broken':
                return 'close-circle';
            case 'disputed':
                return 'alert-circle';
            case 'negotiation_rejected':
                return 'close-circle';
            case 'comment':
                return 'chatbubble';
            default:
                return 'ellipse';
        }
    };

    const getEventColor = (type: string): string => {
        switch (type) {
            case 'created':
                return '#4A8EE8';
            case 'accepted':
                return '#6BA3F0';
            case 'fulfilled':
                return '#4CC38A';
            case 'broken':
                return COLORS.error;
            case 'disputed':
                return '#E8A838';
            case 'negotiation_rejected':
                return COLORS.error;
            default:
                return '#8B929E';
        }
    };

    const renderEvent = (event: PromiseEvent, index: number, isLast: boolean) => (
        <View key={event.id} style={styles.eventItem}>
            <View style={styles.eventTimeline}>
                <View style={[styles.eventDot, { backgroundColor: getEventColor(event.type) }]}>
                    <Ionicons name={getEventIcon(event.type)} size={14} color="white" />
                </View>
                {!isLast && <View style={styles.eventLine} />}
            </View>
            <View style={styles.eventContent}>
                <Text style={styles.eventType}>
                    {/* A declined counter (or offer) records `negotiation_rejected`; never show the raw type. */}
                    {event.type === 'negotiation_rejected'
                        ? t('promise.declined')
                        : enumDisplayCopy(event.type)}
                </Text>
                <Text style={styles.eventDate}>
                    {safeFormatDate(event.timestamp, 'MMM d, yyyy h:mm a')}
                </Text>
                {event.comment && (
                    <Text style={styles.eventComment}>{event.comment}</Text>
                )}
                {event.provenanceEnvelopeId && (
                    <TouchableOpacity
                        style={styles.peLink}
                        onPress={() => navigation.navigate('PEViewer', { envelopeId: event.provenanceEnvelopeId })}
                    >
                        <Ionicons name="shield-checkmark" size={12} color="#4A8EE8" />
                        <Text style={styles.peLinkText}>{t('promise.viewAuditTrail')}</Text>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#4A8EE8" />
                </View>
            </SafeAreaView>
        );
    }

    if (!promise) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />
                <View style={styles.errorContainer}>
                    <View style={styles.errorIconCircle}>
                        <Ionicons name="alert-circle" size={48} color={COLORS.error} />
                    </View>
                    <Text style={styles.errorText}>{t('promise.notFound')}</Text>
                    <TouchableOpacity onPress={() => navigation.goBack()}>
                        <Text style={styles.backLink}>{t('common.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    const canTakeAction = PROMISE_ACTION_STATUSES.has(promise.status);
    // 2026-10-17: a countered promise waits on the party who did not counter.
    const counterView = counterOfferView(promise);
    // P4-06: I am the RECIPIENT of a still-pending promise someone made TO me
    // (imported via share link / QR — the creator is the other party, so
    // `creatorAddress !== my address`). For this case the screen must offer a
    // real Accept/Decline, not the settlement actions (which throw on 'pending').
    const isRecipientPending =
        promise.status === 'pending' && !!address && promise.creatorAddress !== address;

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('promise.detailTitle')}</Text>
                <TouchableOpacity
                    style={styles.headerButton}
                    onPress={() => setShowQR(true)}
                >
                    <Ionicons name="qr-code" size={20} color="#E8A838" />
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Status Card */}
                <View style={styles.statusCard}>
                    <View style={[styles.statusPill, { backgroundColor: `${PromiseService.getStatusColor(promise.status)}26` }]}>
                        <View style={[styles.statusDot, { backgroundColor: PromiseService.getStatusColor(promise.status) }]} />
                        <Text style={[styles.statusText, { color: PromiseService.getStatusColor(promise.status) }]}>
                            {PromiseService.getStatusLabelWithName(promise.status, promise.who)}
                        </Text>
                    </View>
                </View>

                {/* Promise Info */}
                <View style={styles.infoCard}>
                    <Text style={styles.sectionHeader}>{t('promise.exchangeSection')}</Text>
                    <Text style={styles.promiseWhat}>
                        {PromiseService.getPromiseDisplayText(promise)}
                    </Text>

                    {promise.theyGave && promise.theyOwe && (
                        <View style={styles.exchangeDetails}>
                            <View style={styles.exchangeSide}>
                                <Text style={styles.exchangeSideLabel}>{t('promise.gaveSection')}</Text>
                                <Text style={styles.exchangeSideValue}>{promise.theyGave}</Text>
                            </View>
                            <Ionicons name="arrow-forward" size={18} color="#E8A838" />
                            <View style={styles.exchangeSide}>
                                <Text style={styles.exchangeSideLabel}>{t('promise.owedSection')}</Text>
                                <Text style={styles.exchangeSideValue}>{promise.theyOwe}</Text>
                            </View>
                        </View>
                    )}

                    <View style={styles.infoRow}>
                        <View style={styles.infoItem}>
                            <Text style={styles.infoLabel}>{t('promise.withSection')}</Text>
                            <Text style={styles.infoValue}>{promise.who}</Text>
                        </View>
                        <View style={styles.infoItem}>
                            <Text style={styles.infoLabel}>{t('promise.typeSection')}</Text>
                            <Text style={[styles.infoValue, { color: promise.direction === 'i_owe' ? '#E8A838' : '#4CC38A' }]}>
                                {promise.direction === 'i_owe' ? t('promise.typeIOwe') : t('promise.typeTheyOweMe')}
                            </Text>
                        </View>
                    </View>

                    {promise.dueDate && (
                        <View style={styles.infoRow}>
                            <View style={styles.infoItem}>
                                <Text style={styles.infoLabel}>{t('promise.dueSection')}</Text>
                                <Text style={styles.infoValue}>{safeFormatDate(promise.dueDate, 'MMMM d, yyyy')}</Text>
                            </View>
                        </View>
                    )}

                    <View style={styles.infoRow}>
                        <View style={styles.infoItem}>
                            <Text style={styles.infoLabel}>{t('promise.createdSection')}</Text>
                            <Text style={styles.infoValue}>{safeFormatDate(promise.createdAt, 'MMM d, yyyy')}</Text>
                        </View>
                    </View>
                </View>

                {/* Timeline */}
                <View style={styles.timelineCard}>
                    <Text style={styles.sectionHeader}>{t('promise.timelineSection')}</Text>
                    {promise.events.map((event, index) =>
                        renderEvent(event, index, index === promise.events.length - 1)
                    )}
                </View>

                {/* Actions */}
                {canTakeAction && (
                    <View style={styles.actionsCard}>
                        <Text style={styles.sectionHeader}>{t('promise.actionsSection')}</Text>

                        {isRecipientPending ? (
                            <>
                                <Text style={styles.acceptPrompt}>
                                    {t('promise.acceptPromptBody', { who: promise.who })}
                                </Text>
                                <TouchableOpacity
                                    style={styles.fulfillButton}
                                    onPress={handleAccept}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="checkmark-circle" size={20} color="#0B0E14" />
                                    <Text style={styles.fulfillButtonText}>{t('promise.accept')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={handleDecline}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="close-circle" size={20} color={COLORS.error} />
                                    <Text style={styles.brokenButtonText}>{t('promise.decline')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={handleCounter}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="swap-horizontal" size={20} color={COLORS.primary} />
                                    <Text style={styles.brokenButtonText}>{t('promise.counter')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : counterView?.kind === 'awaiting_terms' ? (
                            // The other party countered; their terms reach this phone only
                            // through the link they re-share. Declining needs no terms.
                            <>
                                <View style={styles.waitingNote}>
                                    <Ionicons name="time-outline" size={18} color="#E8A838" />
                                    <Text style={styles.waitingNoteText}>
                                        {t('promise.counterAwaitingTermsBody', { who: promise.who })}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={() => handleDeclineCounter(false)}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="close-circle" size={20} color={COLORS.error} />
                                    <Text style={styles.brokenButtonText}>{t('promise.decline')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : counterView?.kind === 'answer' ? (
                            // The other party's counter, its terms shown above: accept, counter, decline.
                            <>
                                <Text style={styles.acceptPrompt}>
                                    {t('promise.counterAnswerPrompt', { who: promise.who })}
                                </Text>
                                <TouchableOpacity
                                    style={styles.fulfillButton}
                                    onPress={handleAcceptCounter}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="checkmark-circle" size={20} color="#0B0E14" />
                                    <Text style={styles.fulfillButtonText}>{t('promise.accept')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={handleCounter}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="swap-horizontal" size={20} color={COLORS.primary} />
                                    <Text style={styles.brokenButtonText}>{t('promise.counter')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={() => handleDeclineCounter(false)}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="close-circle" size={20} color={COLORS.error} />
                                    <Text style={styles.brokenButtonText}>{t('promise.decline')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : counterView?.kind === 'mine' ? (
                            // This device countered: share the counter's link, or withdraw it.
                            <>
                                <View style={styles.waitingNote}>
                                    <Ionicons name="time-outline" size={18} color="#E8A838" />
                                    <Text style={styles.waitingNoteText}>
                                        {t('promise.counterWaitingAnswer', { who: promise.who })}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.fulfillButton}
                                    onPress={() => { void handleShareCounter(); }}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="share-outline" size={20} color="#0B0E14" />
                                    <Text style={styles.fulfillButtonText}>{t('promise.shareCounter')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={() => handleDeclineCounter(true)}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="close-circle" size={20} color={COLORS.error} />
                                    <Text style={styles.brokenButtonText}>{t('promise.withdrawCounter')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : promise.status === 'pending' ? (
                            // P4-11: the creator viewing their OWN still-pending
                            // promise — there is nothing to settle until the
                            // counterparty accepts. Fulfill/Dispute/Broken all
                            // throw Invalid transition on a 'pending' promise, so
                            // show a passive awaiting note instead.
                            <View style={styles.waitingNote}>
                                <Ionicons name="time-outline" size={18} color="#E8A838" />
                                <Text style={styles.waitingNoteText}>
                                    {t('promise.awaitingAcceptance', { who: promise.who })}
                                </Text>
                            </View>
                        ) : promise.closeoutInitiatedByCounterparty ? (
                            <TouchableOpacity
                                style={styles.fulfillButton}
                                onPress={handleAgreeCloseout}
                                disabled={actionLoading}
                            >
                                <Ionicons name="checkmark-done-circle" size={20} color="#0B0E14" />
                                <Text style={styles.fulfillButtonText}>{t('promise.closeoutAgreeButton')}</Text>
                            </TouchableOpacity>
                        ) : promise.closeoutInitiatedByMe ? (
                            <View style={styles.waitingNote}>
                                <Ionicons name="time-outline" size={18} color="#E8A838" />
                                <Text style={styles.waitingNoteText}>
                                    {t('promise.closeoutWaiting', { who: promise.who })}
                                </Text>
                            </View>
                        ) : (
                            <TouchableOpacity
                                style={styles.fulfillButton}
                                onPress={handleFulfill}
                                disabled={actionLoading}
                            >
                                <Ionicons name="checkmark-circle" size={20} color="white" />
                                <Text style={styles.fulfillButtonText}>{t('promise.markFulfilled')}</Text>
                            </TouchableOpacity>
                        )}

                        {/* P4-11: settlement actions (Dispute / Mark Broken) are
                            valid ONLY from 'accepted' — assertValidTransition
                            throws on a 'pending' promise. Pending promises show
                            Accept/Decline (recipient) or an awaiting note
                            (creator) above instead. */}
                        {promise.status === 'accepted' && (
                            <>
                                <TouchableOpacity
                                    style={styles.disputeButton}
                                    onPress={() => setShowDisputeModal(true)}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="alert-circle" size={20} color="#E8A838" />
                                    <Text style={styles.disputeButtonText}>{t('promise.dispute')}</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.brokenButton}
                                    onPress={handleBroken}
                                    disabled={actionLoading}
                                >
                                    <Ionicons name="close-circle" size={20} color={COLORS.error} />
                                    <Text style={styles.brokenButtonText}>{t('promise.markBroken')}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                )}

                {/* Delete Option */}
                <TouchableOpacity style={styles.deleteRow} onPress={handleDelete}>
                    <Ionicons name="trash" size={18} color={COLORS.error} />
                    <Text style={styles.deleteRowText}>{t('promise.deletePromise')}</Text>
                </TouchableOpacity>
            </ScrollView>

            {/* QR Modal */}
            <Modal visible={showQR} animationType="fade" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.qrModal}>
                        <Text style={styles.qrTitle}>{t('promise.sharePromise')}</Text>
                        {promise.qrData && (
                            <View style={styles.qrContainer}>
                                <QRCode
                                    value={promise.qrData}
                                    size={200}
                                    backgroundColor="white"
                                    color="#0B0E14"
                                />
                            </View>
                        )}
                        <TouchableOpacity
                            style={styles.closeButton}
                            onPress={() => setShowQR(false)}
                        >
                            <Text style={styles.closeButtonText}>{t('common.close')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Dispute Modal */}
            <Modal visible={showDisputeModal} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.disputeModal}>
                        <Text style={styles.disputeTitle}>{t('promise.disputeTitle')}</Text>
                        <Text style={styles.disputeSubtitle}>
                            {t('promise.disputeExplain')}
                        </Text>
                        <TextInput
                            style={styles.disputeInput}
                            placeholder={t("promise.disputeReasonPlaceholder")}
                            placeholderTextColor="#9CA3AF"
                            value={disputeReason}
                            onChangeText={setDisputeReason}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                        />
                        <View style={styles.disputeButtons}>
                            <TouchableOpacity
                                style={styles.disputeCancelButton}
                                onPress={() => {
                                    setShowDisputeModal(false);
                                    setDisputeReason('');
                                }}
                            >
                                <Text style={styles.disputeCancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.disputeSubmitButton}
                                onPress={handleDispute}
                                disabled={actionLoading}
                            >
                                {actionLoading ? (
                                    <ActivityIndicator color="white" size="small" />
                                ) : (
                                    <Text style={styles.disputeSubmitText}>{t('promise.submitDispute')}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Counter Modal (minimal re-propose-terms editor) */}
            <Modal visible={showCounterModal} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.disputeModal}>
                        <Text style={styles.disputeTitle}>{t('promise.counterTitle')}</Text>
                        <Text style={styles.disputeSubtitle}>{t('promise.counterSubtext')}</Text>
                        <TextInput
                            style={styles.disputeInput}
                            placeholder={t('promise.whatDidTheyGive')}
                            placeholderTextColor="#9CA3AF"
                            value={counterGave}
                            onChangeText={setCounterGave}
                        />
                        <TextInput
                            style={styles.disputeInput}
                            placeholder={t('promise.whatDoTheyOwe')}
                            placeholderTextColor="#9CA3AF"
                            value={counterOwe}
                            onChangeText={setCounterOwe}
                        />
                        <View style={styles.disputeButtons}>
                            <TouchableOpacity
                                style={styles.disputeCancelButton}
                                onPress={() => setShowCounterModal(false)}
                            >
                                <Text style={styles.disputeCancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.disputeSubmitButton}
                                onPress={submitCounter}
                                disabled={actionLoading}
                            >
                                {actionLoading ? (
                                    <ActivityIndicator color="white" size="small" />
                                ) : (
                                    <Text style={styles.disputeSubmitText}>{t('promise.counterSubmit')}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
    },
    headerButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        letterSpacing: 0.3,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.m,
    },
    errorIconCircle: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(255,71,87,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorText: {
        fontSize: 18,
        color: COLORS.text,
        fontWeight: '600',
    },
    backLink: {
        color: '#4A8EE8',
        fontWeight: '600',
        fontSize: 15,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxxl,
    },
    statusCard: {
        alignItems: 'center',
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s + 2,
        borderRadius: BORDER_RADIUS.round,
        gap: 8,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusText: {
        fontWeight: '700',
        fontSize: 14,
        letterSpacing: 0.3,
    },
    infoCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.m,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    sectionHeader: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.m,
    },
    infoLabel: {
        fontSize: 11,
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        fontWeight: '600',
        marginBottom: 4,
    },
    promiseWhat: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.m,
    },
    exchangeDetails: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,179,0,0.08)',
        borderRadius: 14,
        padding: SPACING.m,
        marginBottom: SPACING.l,
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.15)',
    },
    exchangeSide: {
        flex: 1,
    },
    exchangeSideLabel: {
        fontSize: 11,
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        fontWeight: '600',
        marginBottom: 2,
    },
    exchangeSideValue: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.text,
    },
    infoRow: {
        flexDirection: 'row',
        marginTop: SPACING.m,
    },
    infoItem: {
        flex: 1,
    },
    infoValue: {
        fontSize: 16,
        color: COLORS.text,
        fontWeight: '600',
    },
    timelineCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.m,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    eventItem: {
        flexDirection: 'row',
    },
    eventTimeline: {
        alignItems: 'center',
        width: 32,
    },
    eventDot: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    eventLine: {
        width: 2,
        flex: 1,
        backgroundColor: 'rgba(42,48,56,0.8)',
        marginVertical: 4,
    },
    eventContent: {
        flex: 1,
        paddingLeft: SPACING.m,
        paddingBottom: SPACING.l,
    },
    eventType: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.text,
    },
    eventDate: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: 2,
    },
    eventComment: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: SPACING.s,
        fontStyle: 'italic',
    },
    peLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: SPACING.s,
    },
    peLinkText: {
        fontSize: 12,
        color: '#4A8EE8',
        fontWeight: '600',
    },
    actionsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.m,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    fulfillButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.s,
        gap: SPACING.s,
        backgroundColor: '#4CC38A',
        shadowColor: '#4CC38A',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    fulfillButtonText: {
        fontSize: 16,
        fontWeight: '700',
        color: '#0B0E14',
    },
    acceptPrompt: {
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 20,
        marginBottom: SPACING.m,
    },
    waitingNote: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.s,
        gap: SPACING.s,
        backgroundColor: 'rgba(255,179,0,0.10)',
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.25)',
    },
    waitingNoteText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: '#E8A838',
    },
    disputeButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.s,
        gap: SPACING.s,
        backgroundColor: 'rgba(255,179,0,0.15)',
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.35)',
    },
    disputeButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#E8A838',
    },
    brokenButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        gap: SPACING.s,
        backgroundColor: 'rgba(255,71,87,0.15)',
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.35)',
    },
    brokenButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.error,
    },
    deleteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        gap: SPACING.s,
        opacity: 0.7,
    },
    deleteRowText: {
        fontSize: 14,
        color: COLORS.error,
        fontWeight: '500',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.85)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    qrModal: {
        backgroundColor: 'rgba(18,21,26,0.95)',
        padding: SPACING.xl,
        borderRadius: 22,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    qrTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.l,
    },
    qrContainer: {
        backgroundColor: 'white',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.l,
    },
    closeButton: {
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.xl,
    },
    closeButtonText: {
        color: '#4A8EE8',
        fontWeight: '600',
        fontSize: 16,
    },
    disputeModal: {
        backgroundColor: 'rgba(18,21,26,0.95)',
        padding: SPACING.l,
        borderRadius: 22,
        width: '90%',
        maxWidth: 400,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    disputeTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    disputeSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        marginBottom: SPACING.l,
    },
    disputeInput: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        borderRadius: 14,
        padding: SPACING.m,
        color: COLORS.text,
        fontSize: 16,
        minHeight: 100,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    disputeButtons: {
        flexDirection: 'row',
        gap: SPACING.m,
    },
    disputeCancelButton: {
        flex: 1,
        padding: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    disputeCancelText: {
        color: COLORS.chromeMuted,
        fontWeight: '600',
    },
    disputeSubmitButton: {
        flex: 1,
        padding: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        backgroundColor: '#E8A838',
        shadowColor: '#E8A838',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    disputeSubmitText: {
        color: '#0B0E14',
        fontWeight: '700',
    },
});

export default PromiseDetailScreen;
