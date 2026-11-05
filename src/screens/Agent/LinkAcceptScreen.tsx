import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction } from '../../core/security/biometricAction';
import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Keyboard,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { AppParamList } from '../../navigation/types';
import { COLORS, BORDER_RADIUS, SPACING } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import { apiFetch } from '../../core/network/apiFetch';
import { requireBiometric, BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import { checkAgentName, AGENT_NAME_MAX } from '../../core/agents/agentDisplayName';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { fieldScrollOffset, keyboardAvoidingBehavior } from '../../utils/keyboardLayout';

type Props = NativeStackScreenProps<AppParamList, 'LinkAccept'>;

interface InviteDetails {
    agent_name: string;
    pe_count: number;
    signing_bonus_pvt: number;
    agent_wallet_id: string;
    invite_id: string;
}

export default function LinkAcceptScreen({ route, navigation }: Props) {
    const { t } = useTranslation();
    const { inviteId } = route.params;
    const [loading, setLoading] = useState(true);
    const [accepting, setAccepting] = useState(false);
    const [declining, setDeclining] = useState(false);
    const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Item 5: the human names the agent here, prefilled with the name the agent sent.
    const [agentName, setAgentName] = useState('');
    const [nameError, setNameError] = useState<string | null>(null);

    const [userId, setUserId] = useState<string | null>(null);

    // keep the focused name field in view when the keyboard opens (edge-to-edge Android
    // does not resize the window, so the field sat under the keyboard). The KeyboardAvoidingView
    // pads the scroll area up; this scrolls the field to just below its top edge.
    const scrollRef = useRef<ScrollView>(null);
    const nameSectionY = useRef(0);
    const nameFocused = useRef(false);
    const scrollNameIntoView = () => {
        // Let the KeyboardAvoidingView apply its padding first, then scroll.
        setTimeout(() => {
            scrollRef.current?.scrollTo({ y: fieldScrollOffset(nameSectionY.current, SPACING.m), animated: true });
        }, 120);
    };
    useEffect(() => {
        const sub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
            if (nameFocused.current) scrollNameIntoView();
        });
        return () => sub.remove();
    }, []);

    useEffect(() => {
        RelayAPIService.getUserId().then(setUserId);
    }, []);

    useEffect(() => {
        fetchInviteDetails();
    }, []);

    const fetchInviteDetails = async () => {
        try {
            setLoading(true);
            setError(null);

            // Call backend to get invite details. [Group 9 / chunk-i] Use
            // apiFetch to match the rest of the wallet-relay traffic and
            // close the MITM window where an attacker on api.provian.ai
            // could substitute the displayed agent identity.
            const response = await apiFetch(
                `${process.env.EXPO_PUBLIC_RELAY_URL || 'https://api.provian.ai'}/v1/agent/wallet/invite/${inviteId}`,
                {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error(t('linkAccept.errorInviteNotFoundExpired'));
                }
                throw new Error(t('linkAccept.errorLoadFailedStatus', { status: response.status }));
            }

            const data = await response.json() as InviteDetails;
            setInviteDetails(data);
            setAgentName(typeof data.agent_name === 'string' ? data.agent_name : '');
        } catch (err) {
            console.error('[LinkAccept] Failed to fetch invite:', err);
            setError(errorDisplayCopy(err instanceof Error ? err.message : t('linkAccept.errorLoadFailed')));
        } finally {
            setLoading(false);
        }
    };

    const nameErrorText = (code: 'required' | 'tooLong' | 'markup'): string => (
        code === 'required' ? t('agentName.errorRequired')
            : code === 'tooLong' ? t('agentName.errorTooLong', { max: AGENT_NAME_MAX })
                : t('agentName.errorMarkup')
    );

    const handleAccept = async () => {
        if (!inviteDetails || !userId) return;

        const nameCheck = checkAgentName(agentName);
        if (!nameCheck.ok) {
            setNameError(nameErrorText(nameCheck.error));
            return;
        }
        setNameError(null);
        const chosenName = nameCheck.value;

        try {
            setAccepting(true);
            setError(null);

            // [Group 9 / chunk-i] Biometric gate before binding the wallet
            // to a remote agent. Linking establishes the verified human-
            // beneficiary relationship that can apply the separate 2x
            // human-trust factor; it does not change the PE's attestation
            // tier. Protocol state changes deserve a hardware confirmation,
            // not just a UI button tap.
            try {
                return await withBiometricAction(t('linkAccept.biometricPrompt', { name: chosenName }), async (biometricAction) => {
                    const result = await RelayAPIService.acceptAgentInvite(inviteId, chosenName, biometricAction);

                    if (!result) {
                        throw new Error(t('linkAccept.errorNetwork'));
                    }

                    if (result.error) {
                        throw new Error(result.error);
                    }

                    // Check for success field in response
                    if (result.success === true) {
                        // The request is no longer waiting: clear it from the bell now.
                        requestAttentionRefresh();
                        Alert.alert(
                            t('linkAccept.linkSuccessTitle'),
                            t('linkAccept.linkSuccessMessage', { name: result.agent_name || chosenName }),
                            [
                                {
                                    text: t('linkAccept.goToAgentHub'),
                                    onPress: () => {
                                        navigation.replace('AgentHub');
                                    },
                                },
                            ]
                        );
                    } else {
                        // Unexpected response format
                        throw new Error(t('linkAccept.errorUnexpectedResponse'));
                    }
                });
            } catch (bioErr) {
                if (!(bioErr instanceof BiometricAuthError) && !(bioErr instanceof BiometricNotAvailableError)) throw bioErr;
                if (bioErr instanceof BiometricAuthError) {
                    setError(t('linkAccept.errorAuthFailed'));
                } else if (bioErr instanceof BiometricNotAvailableError) {
                    setError(errorDisplayCopy(bioErr.message));
                } else {
                    setError(t('linkAccept.errorAuthRequired'));
                }
                setAccepting(false);
                return;
            }
        } catch (err) {
            console.error('[LinkAccept] Failed to accept invite:', err);
            const errorMessage = err instanceof Error ? err.message : t('linkAccept.errorAcceptFailed');
            setError(errorMessage);
            Alert.alert(
                t('linkAccept.linkFailedTitle'),
                errorMessage
            );
        } finally {
            setAccepting(false);
        }
    };

    // Item 4: declining tells the relay, which drops the request from the human's
    // pending list (and so from the attention bell). A legacy email invite is not
    // addressed to a specific human and has nothing to decline on the relay
    // (`link_request_not_found`), so it simply closes.
    const confirmDecline = async () => {
        setDeclining(true);
        const result = await RelayAPIService.declineLinkRequest(inviteId);
        setDeclining(false);
        if (result.ok || result.error === 'link_request_not_found') {
            requestAttentionRefresh();
            navigation.goBack();
            return;
        }
        Alert.alert(t('linkAccept.declineTitle'), t('linkAccept.errorDeclineFailed'));
    };

    const handleDecline = () => {
        Alert.alert(
            t('linkAccept.declineTitle'),
            t('linkAccept.declineMessage'),
            [
                { text: t('linkAccept.cancel'), style: 'cancel' },
                {
                    text: t('linkAccept.decline'),
                    style: 'destructive',
                    onPress: () => { void confirmDecline(); },
                },
            ]
        );
    };

    // One fixed header bar on every state (loading, error, loaded): content scrolls
    // BELOW it, never under a floating back button.
    const header = (
        <View style={styles.headerBar}>
            <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('linkAccept.backAccessibility')} />
            <Text style={styles.headerTitle} numberOfLines={1}>{t('linkAccept.headerTitle')}</Text>
            <View style={styles.headerSpacer} />
        </View>
    );

    if (loading) {
        return (
            <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
                {header}
                <View style={styles.centerState}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                    <Text style={styles.loadingText}>{t('linkAccept.loadingInvitation')}</Text>
                </View>
            </SafeAreaView>
        );
    }

    if (!inviteDetails) {
        return (
            <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
                {header}
                <View style={styles.centerState}>
                    <Text style={styles.errorTitle}>{t('linkAccept.errorTitle')}</Text>
                    <Text style={styles.errorText}>{error || t('linkAccept.errorInviteNotFound')}</Text>
                    <TouchableOpacity
                        style={styles.errorButton}
                        onPress={() => navigation.goBack()}
                    >
                        <Text style={styles.errorButtonText}>{t('linkAccept.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    const busy = accepting || declining;

    return (
        <SafeAreaView style={styles.safeArea} edges={['top']}>
            {header}
            <KeyboardAvoidingView style={styles.flex} behavior={keyboardAvoidingBehavior(Platform.OS)}>
            <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
                <Text style={styles.title}>{t('linkAccept.title')}</Text>
                <Text style={styles.subtitle}>
                    {t('linkAccept.subtitle', { name: inviteDetails.agent_name })}
                </Text>
            </View>

            <View style={styles.card}>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('linkAccept.agentNameLabel')}</Text>
                    <Text style={styles.statValue}>{inviteDetails.agent_name}</Text>
                </View>
                <View style={[styles.statRow, styles.statRowLast]}>
                    <Text style={styles.statLabel}>{t('linkAccept.peCountLabel')}</Text>
                    <Text style={styles.statValue}>{inviteDetails.pe_count.toLocaleString()}</Text>
                </View>
            </View>

            {/* Item 5: the human's name for this agent — what they will see everywhere. */}
            <View style={styles.nameSection} onLayout={(e) => { nameSectionY.current = e.nativeEvent.layout.y; }}>
                <Text style={styles.nameLabel}>{t('linkAccept.nameFieldLabel')}</Text>
                <TextInput
                    style={[styles.nameInput, nameError ? styles.nameInputError : null]}
                    value={agentName}
                    onChangeText={(v) => { setAgentName(v); if (nameError) setNameError(null); }}
                    placeholder={t('agentName.placeholder')}
                    placeholderTextColor={COLORS.textMuted}
                    maxLength={AGENT_NAME_MAX}
                    autoCapitalize="words"
                    autoCorrect={false}
                    returnKeyType="done"
                    editable={!busy}
                    onFocus={() => {
                        nameFocused.current = true;
                        if (Keyboard.isVisible()) scrollNameIntoView();
                    }}
                    onBlur={() => { nameFocused.current = false; }}
                    accessibilityLabel={t('linkAccept.nameFieldLabel')}
                />
                {nameError ? (
                    <Text style={styles.nameErrorText}>{nameError}</Text>
                ) : (
                    <Text style={styles.nameHint}>{t('linkAccept.nameFieldHint')}</Text>
                )}
            </View>

            {/* What linking means : two plain-language lines - what the link
                does, and the 80/20 default split. */}
            <View style={styles.infoSection}>
                <Text style={styles.infoTitle}>{t('linkAccept.whatLinkingMeans')}</Text>
                <Text style={styles.infoLine}>{t('linkAccept.linkMeansWhat')}</Text>
                <Text style={styles.infoLine}>{t('linkAccept.linkMeansSplit')}</Text>
            </View>

            {error ? <Text style={styles.inlineError}>{errorDisplayCopy(error)}</Text> : null}

            <View style={styles.actions}>
                <TouchableOpacity
                    style={[styles.button, styles.acceptButton, busy && styles.buttonDisabled]}
                    onPress={handleAccept}
                    disabled={busy}
                >
                    {accepting ? (
                        <ActivityIndicator size="small" color={COLORS.text} />
                    ) : (
                        <Text style={styles.acceptButtonText}>{t('linkAccept.acceptButton')}</Text>
                    )}
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.button, styles.declineButton, busy && styles.buttonDisabled]}
                    onPress={handleDecline}
                    disabled={busy}
                >
                    {declining ? (
                        <ActivityIndicator size="small" color={COLORS.textSecondary} />
                    ) : (
                        <Text style={styles.declineButtonText}>{t('linkAccept.declineButton')}</Text>
                    )}
                </TouchableOpacity>
            </View>
            </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    flex: {
        flex: 1,
    },
    // Fixed header bar (ConnectAgentScreen's pattern): back button + centred title +
    // a back-button-wide spacer, on the screen's own background with a hairline
    // divider, so scrolled content passes cleanly beneath a solid edge.
    headerBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
        backgroundColor: COLORS.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: COLORS.border,
    },
    headerTitle: {
        flex: 1,
        minWidth: 0,
        textAlign: 'center',
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        marginHorizontal: SPACING.s,
    },
    headerSpacer: {
        width: BACK_BUTTON_SIZE,
    },
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxl,
    },
    centerState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.l,
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: COLORS.textSecondary,
        textAlign: 'center',
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    errorText: {
        fontSize: 16,
        color: COLORS.textSecondary,
        textAlign: 'center',
        marginBottom: 24,
    },
    errorButton: {
        paddingHorizontal: 32,
        paddingVertical: 16,
        backgroundColor: COLORS.primary,
        borderRadius: BORDER_RADIUS.l,
        maxWidth: '100%',
    },
    errorButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'center',
    },
    header: {
        marginBottom: SPACING.l,
    },
    title: {
        fontSize: 26,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 16,
        color: COLORS.textSecondary,
    },
    card: {
        backgroundColor: COLORS.surface,
        borderRadius: BORDER_RADIUS.l,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        marginBottom: SPACING.l,
    },
    // Label/value rows WRAP at the smallest widths (320pt): the label keeps its
    // width, the value takes the rest and breaks onto its own line when it does not
    // fit — a long, unbroken agent name never runs off the card's edge or into the
    // label.
    statRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        columnGap: SPACING.m,
        rowGap: SPACING.xs,
        paddingVertical: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: COLORS.border,
    },
    statRowLast: {
        borderBottomWidth: 0,
    },
    statLabel: {
        flexShrink: 0,
        fontSize: 14,
        color: COLORS.textSecondary,
    },
    statValue: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        textAlign: 'right',
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
    },
    nameSection: {
        marginBottom: SPACING.l,
    },
    nameLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    nameInput: {
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.border,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
        fontSize: 16,
        color: COLORS.text,
    },
    nameInputError: {
        borderColor: COLORS.error,
    },
    nameHint: {
        fontSize: 12,
        lineHeight: 17,
        color: COLORS.textMuted,
        marginTop: SPACING.xs,
    },
    nameErrorText: {
        fontSize: 12,
        lineHeight: 17,
        color: COLORS.error,
        marginTop: SPACING.xs,
    },
    infoSection: {
        marginBottom: 24,
    },
    infoTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: 16,
    },
    infoLine: {
        fontSize: 15,
        color: COLORS.textSecondary,
        lineHeight: 22,
        marginBottom: 8,
    },
    inlineError: {
        fontSize: 13,
        lineHeight: 18,
        color: COLORS.error,
        marginBottom: SPACING.m,
    },
    actions: {
        gap: 16,
    },
    button: {
        minHeight: 56,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.l,
        justifyContent: 'center',
        alignItems: 'center',
    },
    acceptButton: {
        backgroundColor: COLORS.primary,
    },
    acceptButtonText: {
        fontSize: 17,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'center',
    },
    declineButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    declineButtonText: {
        fontSize: 17,
        fontWeight: '600',
        color: COLORS.textSecondary,
        textAlign: 'center',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
});
