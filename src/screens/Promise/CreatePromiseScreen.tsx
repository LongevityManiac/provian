import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    ScrollView,
    Alert,
    ActivityIndicator,
    Platform,
    Share,
    KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import QRCode from 'react-native-qrcode-svg';
import { format } from 'date-fns';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useTheme } from '../../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWalletStore } from '../../store/walletStore';
import PromiseService, { PromiseDirection } from '../../core/promises/PromiseService';
import { useTranslation } from 'react-i18next';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

type Step = 'choose' | 'form' | 'qr';

const DISPLAY_NAME_KEY = 'provian_user_display_name';

const CreatePromiseScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { address, userName } = useWalletStore();
    const { colors: themeColors } = useTheme();
    const [displayName, setDisplayName] = React.useState(userName || '');

    const backgroundGradient = GRADIENTS.backgroundDiagonal;

    // Load display name for Promise-only users
    React.useEffect(() => {
        const loadDisplayName = async () => {
            try {
                const storedName = await AsyncStorage.getItem(DISPLAY_NAME_KEY);
                if (storedName) {
                    setDisplayName(storedName);
                }
            } catch (err) {
                console.log('[CreatePromise] Failed to load display name:', err);
            }
        };
        if (!userName) {
            loadDisplayName();
        }
    }, [userName]);
    const [step, setStep] = useState<Step>('choose');
    const [loading, setLoading] = useState(false);

    // Form state - two-sided value capture
    const [who, setWho] = useState('');
    const [theyGave, setTheyGave] = useState(''); // What the giver provided
    const [theyOwe, setTheyOwe] = useState(''); // What is owed in return
    const [direction, setDirection] = useState<PromiseDirection>('i_owe');
    const [hasDueDate, setHasDueDate] = useState(false);
    const [dueDate, setDueDate] = useState(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const [showDatePicker, setShowDatePicker] = useState(false);

    // Created promise
    const [createdPromise, setCreatedPromise] = useState<any>(null);
    // C3: E2E-encrypted remote share link for the created promise (terms encrypted
    // under a fresh key that rides only the URL fragment).
    const [shareUrls, setShareUrls] = useState<{ universalUrl: string; fallbackUrl: string } | null>(null);

    const handleSelectDirection = (dir: PromiseDirection) => {
        setDirection(dir);
        setStep('form');
    };

    const handleCreate = async () => {
        if (!who.trim()) {
            Alert.alert(t('common.required'), t('promise.requiredName'));
            return;
        }
        if (!theyGave.trim()) {
            Alert.alert(t('common.required'), direction === 'i_owe'
                ? t('promise.requiredGaveIOwe')
                : t('promise.requiredGaveTheyOwe'));
            return;
        }
        if (!theyOwe.trim()) {
            Alert.alert(t('common.required'), direction === 'i_owe'
                ? t('promise.requiredOweIOwe')
                : t('promise.requiredOweTheyOwe'));
            return;
        }

        setLoading(true);
        try {
            // C11: defer the relay publish so we can AWAIT it below before showing
            // the accept path — a fire-and-forget publish can land after a fast
            // acceptor's write, pushing both online devices onto the offline QR.
            const promise = await PromiseService.createPromise({
                theyGave: theyGave.trim(),
                theyOwe: theyOwe.trim(),
                who: who.trim(),
                direction,
                dueDate: hasDueDate ? dueDate.getTime() : undefined,
                // the creator address MUST be the real wallet address — the
                // EIP-191 create signature recovers to it and the relay verifies it.
                // No `local:<name>` fallback: with no wallet, signing throws and the
                // catch below surfaces the failure.
                creatorAddress: address,
                creatorName: displayName || userName || 'Me',
                deferRelayPublish: true,
            });

            // C3: build the E2E-encrypted share link (terms encrypted; key only in
            // the URL fragment). Best-effort — a crypto failure must not block the
            // local promise (the QR + in-person paths still work).
            try {
                setShareUrls(await PromiseService.buildShareLink(promise));
            } catch (linkErr) {
                console.log('[CreatePromise] Share-link build skipped:', linkErr);
            }

            // C11: confirm the creator's relay doc is published BEFORE presenting
            // the online accept path. Non-fatal if it fails (offline → QR path).
            await PromiseService.publishCreatedPromise(promise);

            setCreatedPromise(promise);
            setStep('qr');
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('promise.failedToCreate'));
            console.error('[CreatePromise] Error:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDateChange = (event: any, selectedDate?: Date) => {
        // On Android, dismiss after selection; on iOS with inline, keep open
        if (Platform.OS === 'android') {
            setShowDatePicker(false);
        }
        if (selectedDate) {
            setDueDate(selectedDate);
        }
    };

    const handleSharePromise = async () => {
        try {
            const shareName = displayName || userName || t('promise.someone');
            // C3: share the E2E-encrypted link (body travels encrypted; the key
            // rides only the fragment). The provian://promise fallback opens the
            // app even before AASA/assetlinks verify the universal link. Falls
            // back to the bare download link only if encryption was unavailable.
            const lines = [t('promise.shareMadePromise', { name: shareName }), ''];
            if (shareUrls) {
                lines.push(t('promise.shareOpenToAccept', { url: shareUrls.universalUrl }));
                lines.push('', t('promise.shareFallbackLink', { url: shareUrls.fallbackUrl }));
            } else {
                lines.push(t('promise.shareDownload', { url: `https://provian.ai/download?p=${createdPromise?.id}` }));
            }
            await Share.share({
                message: lines.join('\n'),
                title: t('promise.acceptMyPromise'),
            });
        } catch (error) {
            // Never log the share URLs (they carry the fragment key).
            console.error('[CreatePromise] Share failed');
        }
    };

    const handleBack = () => {
        if (step === 'form') {
            setStep('choose');
            setWho('');
            setTheyGave('');
            setTheyOwe('');
            setHasDueDate(false);
        } else {
            navigation.goBack();
        }
    };

    const resetForm = () => {
        setStep('choose');
        setWho('');
        setTheyGave('');
        setTheyOwe('');
        setHasDueDate(false);
        setCreatedPromise(null);
        setShareUrls(null);
    };

    // Navigate back to promise list after success
    const handleDone = () => {
        navigation.goBack();
    };

    // QR/Success Screen
    if (step === 'qr' && createdPromise) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.header}>
                    <TouchableOpacity
                        onPress={() => navigation.goBack()}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.done')}
                    >
                        <Ionicons name="close" size={24} color={themeColors.textPrimary} />
                    </TouchableOpacity>
                    <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('promise.created')}</Text>
                    <View style={{ width: 24 }} />
                </View>

                <ScrollView contentContainerStyle={styles.qrContent}>
                    <View style={styles.successIconContainer}>
                        <Ionicons name="checkmark-circle" size={64} color={COLORS.success} />
                    </View>

                    <Text style={styles.qrTitle}>{t('promise.shareWith', { name: who })}</Text>
                    <Text style={styles.qrSubtitle}>
                        {t('promise.shareInstruction', { name: who })}
                    </Text>

                    <View style={styles.qrContainer}>
                        <QRCode
                            value={createdPromise.qrData || JSON.stringify({
                                version: 2,
                                promiseId: createdPromise.id,
                                theyGave: createdPromise.theyGave,
                                theyOwe: createdPromise.theyOwe,
                                who: createdPromise.who,
                                creatorAddress: createdPromise.creatorAddress,
                                creatorName: createdPromise.creatorName,
                                dueDate: createdPromise.dueDate,
                                creatorSignature: createdPromise.creatorSignature,
                                timestamp: createdPromise.createdAt,
                            })}
                            size={200}
                            backgroundColor="white"
                            color={COLORS.background}
                        />
                    </View>

                    <TouchableOpacity style={styles.shareButton} onPress={handleSharePromise}>
                        <Ionicons name="share-outline" size={20} color="white" />
                        <Text style={styles.shareButtonTextPrimary}>{t('promise.shareLink')}</Text>
                    </TouchableOpacity>

                    {/* Promise Summary - Two sided */}
                    <View style={styles.summaryCard}>
                        <Text style={styles.summaryLabel}>{t('promise.exchangeLabel')}</Text>
                        <View style={styles.exchangeDisplay}>
                            <Text style={styles.exchangeValue}>{theyGave}</Text>
                            <View style={styles.exchangeArrow}>
                                <Ionicons name="arrow-forward" size={20} color={COLORS.primary} />
                            </View>
                            <Text style={styles.exchangeValue}>{theyOwe}</Text>
                        </View>

                        <Text style={styles.summaryLabel}>{t('promise.withLabel')}</Text>
                        <Text style={styles.summaryValue}>{who}</Text>

                        {hasDueDate && (
                            <>
                                <Text style={styles.summaryLabel}>{t('promise.dueLabel')}</Text>
                                <Text style={styles.summaryValue}>{format(dueDate, 'MMMM d, yyyy')}</Text>
                            </>
                        )}
                    </View>

                    <TouchableOpacity
                        style={styles.doneButton}
                        onPress={handleDone}
                    >
                        <Text style={styles.doneButtonText}>{t('common.done')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.createAnotherButton} onPress={resetForm}>
                        <Text style={styles.createAnotherButtonText}>{t('promise.createAnother')}</Text>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // Choose Direction Screen
    if (step === 'choose') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                    <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('promise.createTitle')}</Text>
                    <View style={{ width: BACK_BUTTON_SIZE }} />
                </View>

                <View style={styles.chooseContent}>
                    <Text style={styles.chooseTitle}>{t('promise.whatKind')}</Text>

                    <TouchableOpacity
                        style={styles.bigOptionCard}
                        onPress={() => handleSelectDirection('owed_to_me')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.bigOptionIcon}>
                            <Text style={styles.bigOptionEmoji}>📥</Text>
                        </View>
                        <Text style={styles.bigOptionTitle}>{t('promise.theyOweMe')}</Text>
                        <Text style={styles.bigOptionExample}>{t('promise.theyOweMeExample')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.bigOptionCard}
                        onPress={() => handleSelectDirection('i_owe')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.bigOptionIcon}>
                            <Text style={styles.bigOptionEmoji}>📤</Text>
                        </View>
                        <Text style={styles.bigOptionTitle}>{t('promise.iOwe')}</Text>
                        <Text style={styles.bigOptionExample}>{t('promise.iOweExample')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Form Screen - Two-sided value capture
    const isTheyOweMe = direction === 'owed_to_me';

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

            <View style={styles.header}>
                <BackButton onPress={handleBack} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>
                    {isTheyOweMe ? t('promise.formTitle') : t('promise.formTitleIOwe')}
                </Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.formContent}>
                {/* Who */}
                <Text style={styles.fieldLabel}>
                    {isTheyOweMe ? t('promise.whoOwes') : t('promise.whoDoYouOwe')}
                </Text>
                <View style={styles.inputContainer}>
                    <TextInput
                        style={styles.input}
                        placeholder={t('promise.theirName')}
                        placeholderTextColor={COLORS.textTertiary}
                        value={who}
                        onChangeText={setWho}
                        autoFocus
                    />
                </View>

                {/* What they gave (the giver's contribution) */}
                <Text style={styles.fieldLabel}>
                    {isTheyOweMe ? t('promise.whatDidYouGive') : t('promise.whatDidTheyGive')}
                </Text>
                <View style={styles.inputContainer}>
                    <TextInput
                        style={styles.input}
                        placeholder={isTheyOweMe
                            ? t('promise.gaveExampleTheyOwe')
                            : t('promise.gaveExampleIOwe')}
                        placeholderTextColor={COLORS.textTertiary}
                        value={theyGave}
                        onChangeText={setTheyGave}
                    />
                </View>
                <Text style={styles.fieldHint}>
                    {isTheyOweMe ? t('promise.hintYouProvided') : t('promise.hintTheyProvided')}
                </Text>

                {/* What they owe (the promise in return) */}
                <Text style={styles.fieldLabel}>
                    {isTheyOweMe ? t('promise.whatDoTheyOwe') : t('promise.whatDoYouOwe')}
                </Text>
                <View style={styles.inputContainer}>
                    <TextInput
                        style={styles.input}
                        placeholder={isTheyOweMe
                            ? t('promise.oweExampleTheyOwe')
                            : t('promise.oweExampleIOwe')}
                        placeholderTextColor={COLORS.textTertiary}
                        value={theyOwe}
                        onChangeText={setTheyOwe}
                    />
                </View>
                <Text style={styles.fieldHint}>
                    {isTheyOweMe ? t('promise.hintTheyPromised') : t('promise.hintYouPromised')}
                </Text>

                {/* Exchange Preview */}
                {theyGave && theyOwe && (
                    <View style={styles.exchangePreview}>
                        <Text style={styles.exchangePreviewLabel}>{t('promise.theExchange')}</Text>
                        <Text style={styles.exchangePreviewText}>
                            {theyGave} → {theyOwe}
                        </Text>
                    </View>
                )}

                {/* Due Date */}
                <Text style={styles.fieldLabel}>
                    {isTheyOweMe ? t('promise.whenShouldTheyPay') : t('promise.whenWillYouPay')}
                </Text>
                <TouchableOpacity
                    style={styles.dueDateToggle}
                    onPress={() => setHasDueDate(!hasDueDate)}
                >
                    <Ionicons
                        name={hasDueDate ? 'checkbox' : 'square-outline'}
                        size={24}
                        color={hasDueDate ? COLORS.primary : COLORS.textSecondary}
                    />
                    <Text style={styles.dueDateToggleText}>{t('promise.setDate')}</Text>
                </TouchableOpacity>

                {hasDueDate && (
                    <>
                        <TouchableOpacity
                            style={styles.datePickerButton}
                            onPress={() => setShowDatePicker(!showDatePicker)}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="calendar-outline" size={20} color={COLORS.primary} />
                            <Text style={styles.datePickerText}>{format(dueDate, 'MMMM d, yyyy')}</Text>
                            <Ionicons
                                name={showDatePicker ? 'chevron-up' : 'chevron-down'}
                                size={20}
                                color={COLORS.textSecondary}
                            />
                        </TouchableOpacity>

                        {showDatePicker && (
                            <View style={styles.datePickerContainer}>
                                <DateTimePicker
                                    value={dueDate}
                                    mode="date"
                                    display={Platform.OS === 'ios' ? 'inline' : 'default'}
                                    onChange={handleDateChange}
                                    minimumDate={new Date()}
                                    style={Platform.OS === 'ios' ? styles.iosDatePicker : undefined}
                                />
                            </View>
                        )}
                    </>
                )}

                {/* Counterparty Info */}
                <View style={styles.counterpartyInfo}>
                    <Ionicons name="information-circle-outline" size={16} color={COLORS.textSecondary} />
                    <Text style={styles.counterpartyInfoText}>
                        {t('promise.shareNote')}
                    </Text>
                </View>

                {/* Create Button */}
                <TouchableOpacity
                    style={[styles.createButton, { backgroundColor: themeColors.primary }, loading && styles.createButtonDisabled]}
                    onPress={handleCreate}
                    disabled={loading}
                >
                    {loading ? (
                        <ActivityIndicator color="white" />
                    ) : (
                        <>
                            <Ionicons name="heart" size={20} color="white" />
                            <Text style={styles.createButtonText}>{t('promise.createPromise')}</Text>
                        </>
                    )}
                </TouchableOpacity>

                {/* Simple footer */}
                <Text style={styles.footerText}>
                    {t('promise.promiseSigned')}
                </Text>
            </ScrollView>
            </KeyboardAvoidingView>
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
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    // Choose screen
    chooseContent: {
        flex: 1,
        padding: SPACING.l,
        paddingTop: SPACING.xl,
    },
    chooseTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        textAlign: 'center',
        marginBottom: SPACING.xl,
    },
    bigOptionCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.xl,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
    },
    bigOptionIcon: {
        marginBottom: SPACING.m,
    },
    bigOptionEmoji: {
        fontSize: 48,
    },
    bigOptionTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.s,
    },
    bigOptionExample: {
        fontSize: 14,
        color: '#8B929E',
        fontStyle: 'italic',
        textAlign: 'center',
    },
    // Form screen
    formContent: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxxl,
    },
    fieldLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.s,
        marginTop: SPACING.l,
    },
    fieldHint: {
        fontSize: 12,
        color: '#9CA3AF',
        marginTop: SPACING.xs,
        fontStyle: 'italic',
    },
    inputContainer: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        paddingHorizontal: SPACING.m,
    },
    input: {
        color: COLORS.text,
        fontSize: 17,
        paddingVertical: SPACING.m,
    },
    exchangePreview: {
        backgroundColor: 'rgba(255,179,0,0.10)',
        borderRadius: 14,
        padding: SPACING.m,
        marginTop: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.25)',
    },
    exchangePreviewLabel: {
        fontSize: 12,
        color: '#E8A838',
        marginBottom: SPACING.xs,
    },
    exchangePreviewText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    dueDateToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.s,
    },
    dueDateToggleText: {
        fontSize: 16,
        color: COLORS.chromeMuted,
    },
    datePickerButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 14,
        marginTop: SPACING.s,
        gap: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    datePickerText: {
        flex: 1,
        fontSize: 16,
        color: COLORS.chromeMuted,
    },
    datePickerContainer: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 14,
        marginTop: SPACING.s,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    iosDatePicker: {
        height: 320,
    },
    counterpartyInfo: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        marginTop: SPACING.l,
        paddingHorizontal: SPACING.xs,
    },
    counterpartyInfoText: {
        flex: 1,
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 20,
    },
    createButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.l,
        borderRadius: 28,
        marginTop: SPACING.xl,
        gap: SPACING.s,
        backgroundColor: '#E8A838',
    },
    createButtonDisabled: {
        opacity: 0.6,
    },
    createButtonText: {
        color: '#0B0E14',
        fontSize: 18,
        fontWeight: 'bold',
    },
    footerText: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.l,
    },
    // QR Screen styles
    qrContent: {
        padding: SPACING.m,
        alignItems: 'center',
        paddingBottom: SPACING.xxxl,
    },
    successIconContainer: {
        marginBottom: SPACING.l,
    },
    shareButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        backgroundColor: '#E8A838',
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.l,
        width: '100%',
    },
    shareButtonTextPrimary: {
        color: '#0B0E14',
        fontWeight: 'bold',
        fontSize: 16,
    },
    qrTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.s,
    },
    qrSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.xl,
        lineHeight: 20,
    },
    qrContainer: {
        backgroundColor: 'white',
        padding: SPACING.l,
        borderRadius: 18,
        marginBottom: SPACING.xl,
        ...SHADOWS.large,
    },
    summaryCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 18,
        width: '100%',
        marginBottom: SPACING.xl,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    summaryLabel: {
        fontSize: 12,
        color: '#8B929E',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginTop: SPACING.m,
    },
    summaryValue: {
        fontSize: 16,
        color: COLORS.chromeMuted,
        fontWeight: '600',
        marginTop: 4,
    },
    exchangeDisplay: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: SPACING.s,
        gap: SPACING.s,
    },
    exchangeValue: {
        flex: 1,
        fontSize: 15,
        color: COLORS.chromeMuted,
        fontWeight: '600',
    },
    exchangeArrow: {
        paddingHorizontal: SPACING.xs,
    },
    doneButton: {
        backgroundColor: '#E8A838',
        paddingVertical: SPACING.l,
        paddingHorizontal: SPACING.xxl,
        borderRadius: 28,
    },
    doneButtonText: {
        color: '#0B0E14',
        fontSize: 16,
        fontWeight: 'bold',
    },
    createAnotherButton: {
        paddingVertical: SPACING.m,
        marginTop: SPACING.m,
    },
    createAnotherButtonText: {
        color: '#8B929E',
        fontSize: 14,
        fontWeight: '500',
        textDecorationLine: 'underline',
    },
});

export default CreatePromiseScreen;
