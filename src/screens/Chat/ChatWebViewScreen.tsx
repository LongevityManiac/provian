import { ActionTouchable } from '../../components/ScreenActions';
import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * ChatWebViewScreen: WebView wrapper for a single AI provider.
 *
 * M5 wires the capture pipeline end-to-end on this screen:
 *   1. Installs the MutationObserver injected script (M4) for the selected
 *      provider as the WebView's injectedJavaScript prop. The WebView
 *      lifecycle is screen-bounded; when the screen unmounts the observer
 *      goes with it.
 *   2. Attaches an onMessage handler that pushes observer metrics into the
 *      process-level MetricsBuffer (M4).
 *   3. Instantiates a MobileSessionStateMachine (M3) and feeds it:
 *        - foreground_changed on WebView navigation state changes whose
 *          URL maps to (or away from) a known provider
 *        - foreground_changed on AppState foreground/background transitions
 *        - input_event on Keyboard.keyboardDidShow, except on a provider's
 *          sign-in page or over a sign-in form (signing in is not a chat)
 *        - input_event on each new turn at the end of the conversation
 *          (turnMarkers.ts), so a turn spoken in the provider's own voice
 *          mode counts exactly like a typed one
 *        - 1 Hz tick from setInterval
 *        - shutdown on screen unmount
 *   4. Forwards MachineOutput payloads into a ChatPEEmitter which assembles
 *      ai_conversation_metadata, computes the session fingerprint, checks
 *      the 24 h FingerprintCache, and calls ProvenanceEnvelopeManager.
 *      createEnvelope for successful emissions.
 *
 * Voice: the provider's own voice feature runs inside the WebView. The page
 * may use the microphone (iOS grants the provider's own host after the OS
 * permission) and play its replies; nothing here times, records or reads the
 * audio. When the app leaves the screen the OS stops the page's microphone,
 * and voice stops; coming back offers one tap that reopens the page with a
 * working microphone.
 *
 * Only the app coming back to the foreground revives a session: a navigation
 * that fires while the app is in the background records the URL but does not
 * tell the session the chat is on screen.
 *
 * Hardware signing happens inside PEM on the existing path. Submission to
 * the relay happens via PEM's existing fire-and-forget flush; the retry
 * queue handles backend failures.
 *
 * M6 gates the entire capture pipeline on `mobileChatConsent`. When the
 * consent value is not `true` (declined, never-set, or still loading on
 * first mount), the WebView renders with no injected script, no
 * onMessage handler, and no state-machine / emitter instantiation. The
 * provider is still browsable in the wrapper; only the capture side is
 * bypassed. Consent is re-read on every focus so toggling the Settings
 * row mid-session takes effect on the next mount. See design notes
 * docs/PHASE_2C_DESIGN_NOTES.md §5.M6.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    BackHandler,
    Platform,
    StatusBar,
    AppState,
    Keyboard,
    type AppStateStatus,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { PROVIDER_CATALOG } from '../../core/capture/catalog';
import {
    getProvider,
    initialUrlFor,
    matchUrlToProvider,
    extractSessionId,
    type ProviderEntry,
    type SessionBoundaryMode,
} from '../../core/capture/ProviderCatalog';
import {
    buildInjectedScript,
    type SupportedProvider,
} from '../../core/capture/injectedScript';
import { createOnMessageHandler } from '../../core/capture/onMessage';
import {
    MobileSessionStateMachine,
    type MachineOutput,
    type ProviderContext,
} from '../../core/capture/MobileSessionStateMachine';
import { ChatPEEmitter } from '../../core/capture/ChatPEEmitter';
import { FingerprintCache } from '../../core/capture/FingerprintCache';
import {
    getMobileChatConsent,
    shouldRunCapturePipeline,
    type MobileChatConsent,
} from '../../core/capture/mobileChatConsent';
import {
    buildTurnWatcherScript,
    parseTurnWatcherMessage,
} from '../../core/capture/turnMarkers';
import { isAuthUrl, keyboardCounts, navigationMayRevive } from '../../core/capture/chatScreenSignals';
import { MarkerHealthReporter } from '../../core/capture/markerHealth';
import RelayAPIService from '../../services/RelayAPIService';

/** How long the "turn the microphone back on" bar stays after returning to the app. */
const RESTORE_VOICE_BAR_MS = 20_000;

let markerHealthReporter: MarkerHealthReporter | null = null;
function getMarkerHealthReporter(): MarkerHealthReporter {
    if (!markerHealthReporter) {
        markerHealthReporter = new MarkerHealthReporter({
            send: body => RelayAPIService.reportChatMarkers(body),
            storage: AsyncStorage,
        });
    }
    return markerHealthReporter;
}

type ChatWebViewRoute = RouteProp<AppParamList, 'ChatWebView'>;
type Nav = NativeStackNavigationProp<AppParamList>;

const TICK_INTERVAL_MS = 1_000;
const SUPPORTED_INJECTED_PROVIDERS: readonly string[] = [
    'claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice',
];

const ChatWebViewScreen: React.FC = () => {
    const { t } = useTranslation();
    const route = useRoute<ChatWebViewRoute>();
    const navigation = useNavigation<Nav>();
    const webViewRef = useRef<WebView | null>(null);
    const canGoBackRef = useRef(false);
    const lastUrlRef = useRef<string | null>(null);
    const authFormVisibleRef = useRef(false);
    // The opaque cover shows only while a page is first loading (on open, and after a reopen or
    // retry). Android reports in-page navigations as loads that never finish, so after the first
    // load nothing puts the cover back over a page that is working.
    const [loading, setLoading] = useState(true);
    const [webViewKey, setWebViewKey] = useState(0);
    const [sourceUri, setSourceUri] = useState<string | null>(null);
    const [showRestoreVoice, setShowRestoreVoice] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const providerId = route.params?.providerId ?? '';
    const entry = getProvider(providerId, PROVIDER_CATALOG);

    // --- Consent gate (M6) --------------------------------------------
    //
    // All capture wiring below is conditional on `captureEnabled`. When
    // the user declined or has not yet decided, the state machine is
    // never constructed and the WebView runs without any capture
    // plumbing. React hook order is preserved; only hook bodies are
    // gated so installation is a no-op.
    const [consent, setConsent] = useState<MobileChatConsent | 'loading'>('loading');
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            getMobileChatConsent().then(value => {
                if (!cancelled) setConsent(value);
            });
            return () => {
                cancelled = true;
            };
        }, []),
    );
    const captureEnabled = shouldRunCapturePipeline(consent);

    // --- Capture pipeline (M5, gated by M6) ---------------------------
    //
    // The state machine is long-lived across this screen mount. The
    // emitter is created with a FingerprintCache backed by AsyncStorage
    // so the 24 h dedup window persists across app restarts. Both
    // construct lazily so a non-consenting user pays zero cost.

    const machineRef = useRef<MobileSessionStateMachine | null>(null);
    if (captureEnabled && machineRef.current === null) {
        machineRef.current = new MobileSessionStateMachine();
    }
    const emitter = useMemo(() => {
        if (!captureEnabled) return null;
        return new ChatPEEmitter({
            fingerprintCache: new FingerprintCache({ storage: AsyncStorage }),
        });
    }, [captureEnabled]);

    const handleOutputs = useCallback(async (outputs: MachineOutput[]): Promise<void> => {
        if (outputs.length === 0) return;
        if (!emitter) return;
        try {
            await emitter.handleEmissions(outputs);
        } catch (err) {
            console.warn('[ChatWebViewScreen] Emitter failed:', err);
        }
    }, [emitter]);

    const stepMachine = useCallback((input: Parameters<MobileSessionStateMachine['step']>[0]) => {
        const m = machineRef.current;
        if (!m) return;
        const outputs = m.step(input);
        if (outputs.length > 0) {
            void handleOutputs(outputs);
        }
    }, [handleOutputs]);

    const metricsOnMessage = useMemo(
        () => (captureEnabled ? createOnMessageHandler() : undefined),
        [captureEnabled],
    );
    const onMessage = useMemo(() => {
        if (!metricsOnMessage) return undefined;
        return (event: { nativeEvent: { data: string } }): void => {
            const raw = event?.nativeEvent?.data;
            const msg = typeof raw === 'string' && entry ? parseTurnWatcherMessage(raw, entry.provider) : null;
            if (!msg) {
                metricsOnMessage(event);
                return;
            }
            if (msg.t === 'turns_added') {
                // A new turn at the end of the conversation, typed or spoken.
                if (AppState.currentState === 'active') {
                    setShowRestoreVoice(false);
                    stepMachine({ t: 'input_event', ts: Date.now() });
                }
            } else if (msg.t === 'auth_page') {
                authFormVisibleRef.current = msg.visible;
            } else {
                void getMarkerHealthReporter().report(msg);
            }
        };
    }, [metricsOnMessage, stepMachine, entry]);

    const close = useCallback(() => {
        navigation.goBack();
    }, [navigation]);

    const onAndroidBack = useCallback((): boolean => {
        if (canGoBackRef.current && webViewRef.current) {
            webViewRef.current.goBack();
            return true;
        }
        return false;
    }, []);

    useEffect(() => {
        if (Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', onAndroidBack);
        return () => sub.remove();
    }, [onAndroidBack]);

    // --- Voice after the app was away ------------------------------------
    //
    // Leaving the app (home, lock) makes the OS stop the page's microphone. Some providers'
    // pages notice and recover; others keep showing "listening" with nothing reaching them, and
    // only a fresh page brings the microphone back. Coming back offers that in one tap. This
    // runs whether or not chat capture is on: it is about the person's voice chat working.
    useEffect(() => {
        let wasBackground = false;
        const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
            if (next === 'background') wasBackground = true;
            else if (next === 'active' && wasBackground) {
                wasBackground = false;
                setShowRestoreVoice(true);
            }
        });
        return () => sub.remove();
    }, []);
    useEffect(() => {
        if (!showRestoreVoice) return;
        const timer = setTimeout(() => setShowRestoreVoice(false), RESTORE_VOICE_BAR_MS);
        return () => clearTimeout(timer);
    }, [showRestoreVoice]);
    const restoreVoice = useCallback(() => {
        setShowRestoreVoice(false);
        setErrorMessage(null);
        setSourceUri(lastUrlRef.current);
        setLoading(true);
        setWebViewKey(k => k + 1);
    }, []);

    // --- AppState + Keyboard + 1 Hz tick wiring ------------------------
    useEffect(() => {
        if (!captureEnabled) return;
        const appSub = AppState.addEventListener('change', (next: AppStateStatus) => {
            if (next === 'active') {
                // Re-foreground: synthesize foreground_changed from the last
                // tracked URL. We do NOT rely on the WebView to re-fire
                // onNavigationStateChange; vendor behavior varies across
                // WKWebView versions and android.webkit.WebView OEM builds.
                // If the state machine is in `closing`, a provider-matching
                // synthesized event returns it to `active` before the 60s
                // closingWindowMs fires and splits the session.
                const url = lastUrlRef.current;
                const ctx = url ? providerContextFromUrl(url) : null;
                stepMachine({ t: 'foreground_changed', ts: Date.now(), providerContext: ctx });
                return;
            }
            // Any other state counts as foreground loss.
            stepMachine({ t: 'foreground_changed', ts: Date.now(), providerContext: null });
        });
        const kbSub = Keyboard.addListener('keyboardDidShow', () => {
            if (!keyboardCounts({ url: lastUrlRef.current, authFormVisible: authFormVisibleRef.current })) return;
            setShowRestoreVoice(false);
            stepMachine({ t: 'input_event', ts: Date.now() });
        });
        const timer = setInterval(() => {
            stepMachine({ t: 'tick', ts: Date.now() });
        }, TICK_INTERVAL_MS);
        return () => {
            clearInterval(timer);
            appSub.remove();
            kbSub.remove();
            stepMachine({ t: 'shutdown', ts: Date.now() });
        };
    }, [stepMachine, captureEnabled]);

    if (!entry) {
        return (
            <SafeAreaView style={styles.errorRoot}>
                <StatusBar barStyle="light-content" />
                <View style={styles.errorHeader}>
                    <ActionTouchable
                        onPress={close}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={t('chatWebView.close')}
                    >
                        <Ionicons name="close" size={24} color={COLORS.text} />
                    </ActionTouchable>
                </View>
                <View style={styles.errorBody}>
                    <Text style={styles.errorTitle}>{t('chatWebView.providerNotFound')}</Text>
                    <Text style={styles.errorSubtitle}>
                        {t('chatWebView.providerNotInCatalog', { providerId })}
                    </Text>
                </View>
            </SafeAreaView>
        );
    }

    const startUrl = initialUrlFor(entry);
    if (lastUrlRef.current === null) {
        lastUrlRef.current = startUrl;
    }
    const uri = sourceUri ?? startUrl;

    const injectedJavaScript: string | undefined = captureEnabled
        && SUPPORTED_INJECTED_PROVIDERS.includes(entry.provider)
            ? buildInjectedScript(entry.provider as SupportedProvider)
                + buildTurnWatcherScript(entry.provider as SupportedProvider)
            : undefined;

    const handleNavigationStateChange = (state: { canGoBack: boolean; url: string }): void => {
        canGoBackRef.current = state.canGoBack;
        lastUrlRef.current = state.url;
        if (!captureEnabled) return;
        // Only the app coming back to the foreground revives a session (the AppState handler
        // replays the last URL then).
        if (!navigationMayRevive(AppState.currentState)) return;
        const ctx = providerContextFromUrl(state.url);
        stepMachine({
            t: 'foreground_changed',
            ts: Date.now(),
            providerContext: ctx,
        });
    };

    return (
        <SafeAreaView style={styles.root} edges={['top']}>
            <StatusBar barStyle="light-content" />
            <View style={styles.header}>
                <ActionTouchable
                    onPress={close}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('chatWebView.close')}
                    style={styles.closeButton}
                >
                    <Ionicons name="close" size={24} color={COLORS.text} />
                </ActionTouchable>
                <Text style={styles.title} numberOfLines={1}>
                    {providerTitle(entry.provider)}
                </Text>
                <View style={styles.spacer} />
            </View>
            <View style={styles.webContainer}>
                <WebView
                    key={webViewKey}
                    ref={webViewRef}
                    source={{ uri }}
                    originWhitelist={['https://*']}
                    javaScriptEnabled
                    sharedCookiesEnabled
                    thirdPartyCookiesEnabled
                    allowsBackForwardNavigationGestures
                    startInLoadingState={false}
                    injectedJavaScript={injectedJavaScript}
                    onMessage={onMessage}
                    onLoadStart={() => setErrorMessage(null)}
                    onLoadEnd={() => setLoading(false)}
                    onLoadProgress={(e: { nativeEvent: { progress: number } }) => {
                        if ((e.nativeEvent?.progress ?? 0) >= 1) setLoading(false);
                    }}
                    onError={(e: { nativeEvent: { description?: string } }) => {
                        setLoading(false);
                        setErrorMessage(e.nativeEvent.description ?? t('chatWebView.failedToLoad'));
                    }}
                    onNavigationStateChange={handleNavigationStateChange}
                    keyboardDisplayRequiresUserAction={false}
                    // The provider's own voice: the page may use the microphone (iOS grants the
                    // provider's own host once the OS permission is given) and play its replies.
                    mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
                    allowsInlineMediaPlayback
                    mediaPlaybackRequiresUserAction={false}
                    style={styles.webView}
                />
                {loading && (
                    <View style={styles.loadingOverlay} pointerEvents="none">
                        <ActivityIndicator color={COLORS.primary} size="large" />
                    </View>
                )}
                {errorMessage && (
                    <View style={styles.errorOverlay}>
                        <Ionicons
                            name="warning-outline"
                            size={32}
                            color={COLORS.warning}
                        />
                        <Text style={styles.errorBannerText}>{errorDisplayCopy(errorMessage)}</Text>
                        <ActionTouchable
                            style={styles.retryButton}
                            onPress={() => {
                                setErrorMessage(null);
                                setLoading(true);
                                webViewRef.current?.reload();
                            }}
                        >
                            <Text style={styles.retryText}>{t('chatWebView.retry')}</Text>
                        </ActionTouchable>
                    </View>
                )}
                {showRestoreVoice && !errorMessage && (
                    <ActionTouchable
                        style={styles.restoreVoiceBar}
                        onPress={restoreVoice}
                        accessibilityLabel={t('chatWebView.restoreVoice')}
                    >
                        <Ionicons name="mic-outline" size={18} color={COLORS.text} />
                        <Text style={styles.restoreVoiceText} numberOfLines={2}>
                            {t('chatWebView.restoreVoice')}
                        </Text>
                    </ActionTouchable>
                )}
            </View>
        </SafeAreaView>
    );
};

function providerContextFromUrl(url: string): ProviderContext | null {
    // A provider's sign-in page is not its chat surface: signing in is not a chat.
    if (isAuthUrl(url)) return null;
    const entry: ProviderEntry | null = matchUrlToProvider(url, PROVIDER_CATALOG);
    if (!entry) return null;
    const boundaryMode: SessionBoundaryMode = entry.session_boundary;
    const sessionId = entry.session_id_extraction ? extractSessionId(url, entry) : null;
    const timestampGapMs = entry.timestamp_gap_seconds === null
        ? null
        : entry.timestamp_gap_seconds * 1000;
    return {
        provider: entry.provider,
        sessionId,
        boundaryMode,
        timestampGapMs,
    };
}

function providerTitle(id: string): string {
    switch (id) {
        case 'claude':
            return 'Claude';
        case 'chatgpt':
            return 'ChatGPT';
        case 'gemini':
            return 'Gemini';
        case 'perplexity':
            return 'Perplexity';
        case 'grok':
            return 'Grok';
        case 'venice':
            return 'Venice';
        default:
            return id;
    }
}

const styles = StyleSheet.create({
    restoreVoiceBar: {
        position: 'absolute',
        left: SPACING.m,
        right: SPACING.m,
        bottom: SPACING.l,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        backgroundColor: COLORS.surfaceElevated,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: COLORS.border,
    },
    restoreVoiceText: {
        flex: 1,
        color: COLORS.text,
        fontSize: 14,
    },
    root: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        height: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: COLORS.border,
        backgroundColor: COLORS.background,
    },
    closeButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        flex: 1,
        color: COLORS.text,
        fontSize: 17,
        fontWeight: '600',
        textAlign: 'center',
    },
    spacer: {
        width: 32,
    },
    webContainer: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    webView: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.background,
    },
    errorOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SPACING.l,
        backgroundColor: COLORS.background,
    },
    errorBannerText: {
        color: COLORS.textSecondary,
        marginTop: SPACING.m,
        textAlign: 'center',
    },
    retryButton: {
        marginTop: SPACING.l,
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
        backgroundColor: COLORS.primary,
        borderRadius: 8,
    },
    retryText: {
        color: COLORS.onPrimary,
        fontWeight: '600',
    },
    errorRoot: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    errorHeader: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    errorBody: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SPACING.l,
    },
    errorTitle: {
        color: COLORS.text,
        fontSize: 20,
        fontWeight: '600',
    },
    errorSubtitle: {
        color: COLORS.textSecondary,
        marginTop: SPACING.s,
        textAlign: 'center',
    },
});

export default ChatWebViewScreen;
