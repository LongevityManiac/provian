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
 *        - input_event on Keyboard.keyboardDidShow
 *        - 1 Hz tick from setInterval
 *        - shutdown on screen unmount
 *   4. Forwards MachineOutput payloads into a ChatPEEmitter which assembles
 *      ai_conversation_metadata, computes the session fingerprint, checks
 *      the 24 h FingerprintCache, and calls ProvenanceEnvelopeManager.
 *      createEnvelope for successful emissions.
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
    TouchableOpacity,
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
import { COLORS, SPACING } from '../../constants/theme';
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
    const [loading, setLoading] = useState(true);
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

    const onMessage = useMemo(
        () => (captureEnabled ? createOnMessageHandler() : undefined),
        [captureEnabled],
    );

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
                    <TouchableOpacity
                        onPress={close}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={t('chatWebView.close')}
                    >
                        <Ionicons name="close" size={24} color={COLORS.text} />
                    </TouchableOpacity>
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

    const injectedJavaScript: string | undefined = captureEnabled
        && SUPPORTED_INJECTED_PROVIDERS.includes(entry.provider)
            ? buildInjectedScript(entry.provider as SupportedProvider)
            : undefined;

    const handleNavigationStateChange = (state: { canGoBack: boolean; url: string }): void => {
        canGoBackRef.current = state.canGoBack;
        lastUrlRef.current = state.url;
        if (!captureEnabled) return;
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
                <TouchableOpacity
                    onPress={close}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('chatWebView.close')}
                    style={styles.closeButton}
                >
                    <Ionicons name="close" size={24} color={COLORS.text} />
                </TouchableOpacity>
                <Text style={styles.title} numberOfLines={1}>
                    {providerTitle(entry.provider)}
                </Text>
                <View style={styles.spacer} />
            </View>
            <View style={styles.webContainer}>
                <WebView
                    ref={webViewRef}
                    source={{ uri: startUrl }}
                    originWhitelist={['https://*']}
                    javaScriptEnabled
                    sharedCookiesEnabled
                    thirdPartyCookiesEnabled
                    allowsBackForwardNavigationGestures
                    startInLoadingState={false}
                    injectedJavaScript={injectedJavaScript}
                    onMessage={onMessage}
                    onLoadStart={() => {
                        setLoading(true);
                        setErrorMessage(null);
                    }}
                    onLoadEnd={() => setLoading(false)}
                    onError={(e: { nativeEvent: { description?: string } }) => {
                        setLoading(false);
                        setErrorMessage(e.nativeEvent.description ?? t('chatWebView.failedToLoad'));
                    }}
                    onHttpError={(e: { nativeEvent: { statusCode: number } }) => {
                        if (e.nativeEvent.statusCode >= 500) {
                            setErrorMessage(t('chatWebView.serverError', { statusCode: e.nativeEvent.statusCode }));
                        }
                    }}
                    onNavigationStateChange={handleNavigationStateChange}
                    keyboardDisplayRequiresUserAction={false}
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
                        <TouchableOpacity
                            style={styles.retryButton}
                            onPress={() => {
                                setErrorMessage(null);
                                webViewRef.current?.reload();
                            }}
                        >
                            <Text style={styles.retryText}>{t('chatWebView.retry')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </SafeAreaView>
    );
};

function providerContextFromUrl(url: string): ProviderContext | null {
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
        color: COLORS.white,
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
