import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, AppState, AppStateStatus, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainerRef } from '@react-navigation/native';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import AppNavigator from './src/navigation/AppNavigator';
import './src/i18n'; // Initialize i18n
import { COLORS } from './src/constants/theme';

// Apply Inter font globally - defaultProps approach works across all RN versions
(Text as any).defaultProps = (Text as any).defaultProps || {};
(Text as any).defaultProps.style = { fontFamily: 'Inter_400Regular' };
import { ThemeProvider } from './src/theme';
import NotificationService, { InAppNotification } from './src/services/NotificationService';
import RelayAPIService from './src/services/RelayAPIService';
import AppUpdateService from './src/services/AppUpdateService';
import { useCommonsBlockStore } from './src/store/commonsBlockStore';
import { resumeStorePurchases } from './src/core/store/storeRuntime';
import InAppNotificationBanner from './src/components/InAppNotificationBanner';
import {
  initializeServices,
  shutdownServices,
  getServiceStatus,
  type ServiceStatus,
} from './src/core/ServiceInitializer';
import { useWalletStore } from './src/store/walletStore';
import PromiseService from './src/core/promises/PromiseService';

import SeedManager from './src/core/wallet/SeedManager';
import { translate } from './src/i18n/translate';

// Time in background before requiring re-authentication (30 seconds)
const BACKGROUND_LOCK_TIMEOUT_MS = 30 * 1000;

// Android out-of-app AI capture (Phase 2c M7 UsageStatsScheduler) is NOT live
// the scheduler is deliberately not constructed or
// started here. Its code is retained in src/core/capture/ for later; OPEN_ITEMS.md
// lists what must be fixed before it is ever wired back in, and the relay refuses
// its `mobile_usage_stats` surface.

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  const navigationRef = useRef<NavigationContainerRef<any>>(null) as React.RefObject<NavigationContainerRef<any>>;
  const [inAppNotification, setInAppNotification] = useState<InAppNotification | null>(null);
  const [servicesReady, setServicesReady] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [retryInFlight, setRetryInFlight] = useState(false);
  const [degradedAccepted, setDegradedAccepted] = useState(false);
  const backgroundTimeRef = useRef<number | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Get wallet state for re-locking
  const { onboardingComplete, setAuthenticated } = useWalletStore();

  // Handle AppState changes for security re-locking
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'background') {
        // App going to background - record the time
        backgroundTimeRef.current = Date.now();
        console.log('[App] Going to background');

        // Stop phone heartbeat so the relay can classify the phone as
        // offline after PHONE_OFFLINE_THRESHOLD_MS. See cardAccessMode matrix.

        // [Group 1 / M-2] Clear SeedManager biometric session on background.
        // Sibling pattern to CredentialCrypto.clearMasterKeyCache, which is
        // wired to the same AppState listener inside that module. Returns
        // immediately if no session was active.
        // Only on a real BACKGROUND: iOS reports 'inactive' while its own Face ID sheet is up, so
        // clearing on 'inactive' wiped the session the prompt had just granted and made the next
        // step (e.g. burn → sign) ask for Face ID again (found live 2026-09-22).
        if (nextAppState === 'background') SeedManager.clearBiometricSession();
      } else if (
        appStateRef.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // App coming back to foreground - check if we need to re-lock
        const backgroundDuration = backgroundTimeRef.current
          ? Date.now() - backgroundTimeRef.current
          : 0;

        console.log('[App] Returning from background after', backgroundDuration, 'ms');

        if (backgroundDuration > BACKGROUND_LOCK_TIMEOUT_MS && onboardingComplete) {
          // User was away too long - require re-authentication
          const lockScreen = 'WalletLock';

          if (navigationRef.current) {
            console.log('[App] Re-locking due to background timeout, navigating to', lockScreen);
            setAuthenticated(false);
            navigationRef.current.reset({
              index: 0,
              routes: [{ name: lockScreen }],
            });
          }
        }

        backgroundTimeRef.current = null;

        // Resume phone heartbeat so the relay knows the phone is back.
        // Safe to call even if no wallet is set up yet - the heartbeat
        // endpoint requires auth and will silently fail until a session
        // exists; the next tick after onboarding completes will succeed.
        if (onboardingComplete) {
        }

        // Deferred-completion trigger for remote promise close-outs: flush any
        // close-out tag recorded while offline (offline_pending) + reconcile.
        // Fire-and-forget; no-op when the relay is unconfigured/unreachable.
        if (onboardingComplete) {
          PromiseService.syncPendingPromises().catch(() => {});
        }

        // Re-check push registration on foreground WITHOUT prompting. Self-heals
        // the "user enabled notifications in system settings while backgrounded"
        // case (silently registers now that permission is granted) and re-registers
        // a rotated token. No nag: prompt is false, so a prior denial stays quiet.
        if (onboardingComplete) {
          NotificationService.ensurePushRegistration({ prompt: false }).catch(() => {});
        }
      }

      appStateRef.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    // Start heartbeat on mount if the user is already onboarded (e.g. app
    // cold-started in the foreground state).
    if (onboardingComplete && AppState.currentState === 'active') {
    }

    return () => {
      subscription.remove();
    };
  }, [onboardingComplete, setAuthenticated]);

  // Mounted-flag ref shared by the initial init effect and the Retry handler
  // so a Retry that completes after unmount does not call setState on a dead
  // tree, and a Retry that lands during the initial init does not stomp it.
  const initMountedRef = useRef(true);

  // Run service initialization. Reusable for cold-start and Retry button.
  // Always returns; never throws. The catch path sets degraded status so the
  // UI can render the recoverable error view instead of stalling on the
  // spinner forever.
  const runInit = useCallback(async () => {
    console.log('[App] Initializing core services...');
    try {
      const status = await initializeServices();
      if (!initMountedRef.current) return;
      setServiceStatus(status);
      setServicesReady(status.isReady);
      if (status.degradedMode) {
        console.warn(
          '[App] Running in degraded mode, failed services:',
          status.failedServices,
        );
      } else {
        console.log('[App] All core services initialized');
      }
    } catch (error) {
      console.error('[App] Service initialization threw:', error);
      if (!initMountedRef.current) return;
      const fallback: ServiceStatus = {
        isReady: false,
        services: { provenance: false, footprint: false },
        errors: [error instanceof Error ? error.message : 'Service initialization threw'],
        degradedMode: true,
        failedServices: ['initializer'],
      };
      setServiceStatus(fallback);
      setServicesReady(false);
    }
  }, []);

  // Retry handler for the recoverable error view. Guards against double-fire
  // while a retry is already in flight.
  const handleRetryInit = useCallback(async () => {
    if (retryInFlight) return;
    setRetryInFlight(true);
    setServiceStatus(null);
    try {
      await runInit();
    } finally {
      setRetryInFlight(false);
    }
  }, [retryInFlight, runInit]);

  // Continue-in-limited-mode handler. The four critical services are wrapped
  // to fail soft individually; allowing the user past the gate gets them to
  // the app shell so they can still reach screens that do not depend on the
  // failed service.
  const handleContinueDegraded = useCallback(() => {
    setDegradedAccepted(true);
    setServicesReady(true);
  }, []);

  useEffect(() => {
    initMountedRef.current = true;

    // Wire the push-token -> backend registrar BEFORE anything mints a token.
    // Kept here (not inside NotificationService) so the service doesn't import
    // RelayAPIService, which would be a circular dependency. ensureRegistered()
    // covers the case where the relay user isn't created yet (e.g. a token
    // rotation fires before signup finishes). Backend registration is idempotent.
    NotificationService.setTokenRegistrar(async (token) => {
      await RelayAPIService.ensureRegistered();
      await RelayAPIService.registerFCMToken(token);
    });

    runInit();

    // Initialize notification service (can happen in parallel)
    NotificationService.initialize().then(() => {
      console.log('[App] NotificationService initialized');
    });

    // Set up in-app notification handler
    NotificationService.setInAppNotificationHandler((notification) => {
      console.log('[App] In-app notification received:', notification.title);
      setInAppNotification(notification);
    });

    // Cleanup on unmount
    return () => {
      initMountedRef.current = false;
      NotificationService.cleanup();
      NotificationService.setInAppNotificationHandler(null);
      shutdownServices();
    };
  }, [runInit]);

  // Push registration: once a wallet is active (onboardingComplete), request
  // notification permission IN CONTEXT and register the Expo push token with the
  // backend. Fires for wallet creation, recovery/restore, and import/link (all
  // set onboardingComplete), and on cold start for returning users (permission
  // already granted -> silent re-register, which also picks up a rotated token).
  // Idempotent + no nag: prompts only when permission is undetermined, never on a
  // prior denial. Deliberately NOT run before a wallet exists.
  useEffect(() => {
    if (!onboardingComplete) return;
    NotificationService.ensurePushRegistration({ prompt: true }).catch((e) =>
      console.warn('[App] Push registration failed:', e),
    );
    // Best-effort APK update check: the website APK only (a no-op in the App Store and
    // Play builds, which their stores update; never blocks). See AppUpdateService / appUpdate.ts.
    AppUpdateService.promptIfUpdate().catch(() => {});
    // The Commons authors this person blocked (hidden on this phone), and any store purchase bought
    // but not yet recorded by the relay (store builds; a no-op in the website APK).
    void useCommonsBlockStore.getState().load();
    void resumeStorePurchases();
  }, [onboardingComplete]);

  // Set navigation ref when it's ready
  const handleNavigationReady = () => {
    if (navigationRef.current) {
      NotificationService.setNavigationRef(navigationRef.current);
      console.log('[App] Navigation ref set for NotificationService');
    }
  };

  // Handle tapping on in-app notification
  const handleNotificationPress = useCallback((notification: InAppNotification) => {
    console.log('[App] Notification tapped, navigating to Send');
    if (navigationRef.current) {
      navigationRef.current.navigate('Send', {
        isAgentInitiated: true,
        agentId: notification.data.agent_id,
        agentActionType: 'purchase',
        agentMerchant: notification.data.merchant,
        agentPurpose: notification.data.purpose,
        agentAmount: parseFloat(notification.data.amount) || 0,
        agentAssetSymbol: notification.data.currency || 'USDC',
        relayRequestId: notification.data.request_id,
      });
    }
  }, []);

  // Handle dismissing notification
  const handleNotificationDismiss = useCallback(() => {
    setInAppNotification(null);
  }, []);

  // Recoverable error view: a critical service failed to initialize and the
  // user has not yet chosen to continue in limited mode. Without this the
  // user would be trapped on the spinner forever with no way out.
  const showDegradedRecovery =
    fontsLoaded
    && !servicesReady
    && !degradedAccepted
    && serviceStatus?.degradedMode === true;

  if (showDegradedRecovery && serviceStatus) {
    const failedList = serviceStatus.failedServices.length
      ? serviceStatus.failedServices.join(', ')
      : translate('appInit.oneOrMoreServices', 'one or more services');
    return (
      <SafeAreaProvider>
        <View style={styles.loadingContainer}>
          <StatusBar style="light" />
          <Text style={styles.errorTitle}>{translate('appInit.couldNotFinishLoading', 'Provian could not finish loading')}</Text>
          <Text style={styles.errorText}>
            {translate('appInit.failedToInitialize', `Failed to initialize: ${failedList}`, { services: failedList })}
          </Text>
          {retryInFlight ? (
            <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 16 }} />
          ) : (
            <>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleRetryInit}
                disabled={retryInFlight}
                accessibilityRole="button"
                accessibilityLabel={translate('appInit.retryInitialization', 'Retry initialization')}
              >
                <Text style={styles.primaryButtonText}>{translate('appInit.retry', 'Retry')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handleContinueDegraded}
                accessibilityRole="button"
                accessibilityLabel={translate('appInit.continueLimitedMode', 'Continue in limited mode')}
              >
                <Text style={styles.secondaryButtonText}>{translate('appInit.continueLimitedMode', 'Continue in limited mode')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaProvider>
    );
  }

  // Show loading screen while fonts/services initialize.
  if (!fontsLoaded || !servicesReady) {
    return (
      <SafeAreaProvider>
        <View style={styles.loadingContainer}>
          <StatusBar style="light" />
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>{translate('appInit.initializing', 'Initializing Provian...')}</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="light" />
        <AppNavigator
          navigationRef={navigationRef}
          onReady={handleNavigationReady}
        />
        <InAppNotificationBanner
          notification={inAppNotification}
          onPress={handleNotificationPress}
          onDismiss={handleNotificationDismiss}
          autoDismissMs={10000}
        />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    paddingHorizontal: 24,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: COLORS.text,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  errorText: {
    marginTop: 8,
    fontSize: 13,
    color: COLORS.warning,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    minWidth: 200,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#0B0E14',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  secondaryButtonText: {
    color: COLORS.textTertiary,
    fontSize: 13,
  },
});
