import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useWalletStore, useHasHydrated, useSessionTimeoutWatcher, useBackgroundLock, useNetworkMonitor } from '../store/walletStore';
import type { AppParamList } from './types';
import ErrorBoundary from '../components/ErrorBoundary';
import AttestationScreen from '../screens/Onboarding/AttestationScreen';
import BiometricSetupScreen from '../screens/Onboarding/BiometricSetupScreen';
import UnifiedOnboardingScreen from '../screens/Onboarding/UnifiedOnboardingScreen';
import ConsentScreen from '../screens/Onboarding/ConsentScreen';
import CloudBackupConfirmScreen from '../screens/Onboarding/CloudBackupConfirmScreen';
import PhraseBackupScreen from '../screens/Onboarding/PhraseBackupScreen';
import StayInTheLoopScreen from '../screens/Onboarding/StayInTheLoopScreen';
import ExportMnemonicScreen from '../screens/Settings/Export/ExportMnemonicScreen';
import ImportRecoveryPhraseScreen from '../screens/Recovery/ImportRecoveryPhraseScreen';
import CloudRecoveryScreen from '../screens/Recovery/CloudRecoveryScreen';
import DashboardScreen from '../screens/Dashboard/DashboardScreen';
import SendScreen from '../screens/Action/SendScreen';
import HumanPresentmentScreen from '../screens/Presentment/HumanPresentmentScreen';
import PresentationRequesterScreen from '../screens/Presentment/PresentationRequesterScreen';
import LockdownScreen from '../screens/Security/LockdownScreen';
import WalletConnectScreen from '../screens/Action/WalletConnectScreen';
import ReceiveScreen from '../screens/Action/ReceiveScreen';
import SwapScreen from '../screens/Action/SwapScreen';
import BuyCryptoScreen from '../screens/Action/BuyCryptoScreen';
import SettingsScreen from '../screens/Settings/SettingsScreen';
import ContactsScreen from '../screens/Settings/ContactsScreen';
import ContactDetailScreen from '../screens/Settings/ContactDetailScreen';
import LanguageScreen from '../screens/Settings/LanguageScreen';
import SecuritySettingsScreen from '../screens/Settings/SecuritySettingsScreen';
import BackupAndRecoveryScreen from '../screens/Settings/BackupAndRecoveryScreen';
import LegalScreen from '../screens/Settings/LegalScreen';
import OpenSourceNoticesScreen from '../screens/Settings/OpenSourceNoticesScreen';
import HelpSupportScreen from '../screens/Settings/HelpSupportScreen';
import DeleteAllDataScreen from '../screens/Settings/DeleteAllDataScreen';
import { TermsOfServiceScreen, PrivacyPolicyScreen, NetworkConstitutionScreen } from '../screens/Legal';
import PEViewerScreen from '../screens/Security/PEViewerScreen';
import WalletLockScreen from '../screens/Security/WalletLockScreen';
import BiometricSettingsScreen from '../screens/Settings/BiometricSettingsScreen';
import WalletConnectSecurityScreen from '../screens/Settings/WalletConnectSecurityScreen';
import ArchiveScreen from '../screens/Settings/ArchiveScreen';
import CommonsBlockedScreen from '../screens/Settings/CommonsBlockedScreen';
import ProfileEditScreen from '../screens/Settings/ProfileEditScreen';
import DeviceManagementScreen from '../screens/Settings/DeviceManagementScreen';
import { COLORS } from '../constants/theme';
import WalletCreationService from '../core/wallet/WalletCreationService';
import RelayAPIService from '../services/RelayAPIService';
import { captureInvite, startDeferredInviteCheck } from '../services/inviteRuntime';
import { peekPendingLinkAccept, consumePendingLinkAccept, subscribePendingLinkAccept } from './pendingLinkAccept';
import { stashProtectedNav, consumeProtectedNav } from './pendingProtectedNav';
import { startPhoneMeter } from '../core/meter/phoneMeterRuntime';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deepLinkValidator, matchesPath, isPromiseImportLink } from '../core/navigation/deepLinkValidator';
import PromiseService from '../core/promises/PromiseService';

import ExitStrategyInfoScreen from '../screens/Settings/Export/ExitStrategyInfoScreen';
import VisionScreen from '../screens/Vision/VisionScreen';


// Transaction History
import TransactionHistoryScreen from '../screens/History/TransactionHistoryScreen';
import TransactionDetailScreen from '../screens/History/TransactionDetailScreen';

// Promise Tool
import PromiseListScreen from '../screens/Promise/PromiseListScreen';
import CreatePromiseScreen from '../screens/Promise/CreatePromiseScreen';
import PromiseDetailScreen from '../screens/Promise/PromiseDetailScreen';
import ScanPromiseScreen from '../screens/Promise/ScanPromiseScreen';

// Chat (Phase 2c)
import { ChatWebViewScreen } from '../screens/Chat';

// Recovery Flow Screens
import { RecoveryStartScreen } from '../screens/Recovery';

// Agent Screens
import {
    AgentHubScreen,
    AgentDetailScreen,
    LinkAcceptScreen,
    ConnectAgentScreen,
    RecoverAgentScreen,
    RekeyAgentScreen,
    LinkExternalWalletScreen,
    AgentCardSpendingScreen,
    BondManagementScreen,
    ClaimsScreen,
    ApprovalInboxScreen,
} from '../screens/Agent';

// Earn Screens
import { EarnSurfaceDetailScreen, ForgeConnectScreen, ForgeContributorsScreen, ProveOwnWalletScreen } from '../screens/Earn';

// Credential Screens

// Activity Screens
import {
    ActivityLogScreen,
    EnvelopeDetailScreen,
} from '../screens/Activity';

// Provenance / PVT Dashboard
import { MyProvenanceDashboardScreen, PVTDetailScreen, OwnProfileScreen } from '../screens/Provenance';

// human surface
import AttentionCenterScreen from '../screens/Attention/AttentionCenterScreen';
import PresentationRequestScreen from '../screens/Presentment/PresentationRequestScreen';

// M2 Face ID Authorization

// Unified Tab Navigator
import TabNavigator from './TabNavigator';

// Commons Screens
import CommonsOnboarding from '../screens/Commons/CommonsOnboarding';
import CommonsDashboard from '../screens/Commons/CommonsDashboard';
import CommonsProfile from '../screens/Commons/CommonsProfile';
import CommonsRegistry from '../screens/Commons/CommonsRegistry';
import CommonsMarket from '../screens/Commons/CommonsMarket';
import CommonsHumanJobs from '../screens/Commons/CommonsHumanJobs';
import CommonsHumanJobsPost from '../screens/Commons/CommonsHumanJobsPost';
import CommonsHumanJobManage from '../screens/Commons/CommonsHumanJobManage';
import CommonsInstitutions from '../screens/Commons/CommonsInstitutions';
import CommonsCourt from '../screens/Commons/CommonsCourt';
import CommonsBonds from '../screens/Commons/CommonsBonds';
import CommonsGovernance from '../screens/Commons/CommonsGovernance';
import CommonsForum from '../screens/Commons/CommonsForum';
import CommonsForumPost from '../screens/Commons/CommonsForumPost';
import CommonsCompose from '../screens/Commons/CommonsCompose';
import { TalkingPassHost } from '../components/commons/TalkingPassSheet';
import CommonsThreads from '../screens/Commons/CommonsThreads';
import CommonsNewMessage from '../screens/Commons/CommonsNewMessage';
import CommonsThread from '../screens/Commons/CommonsThread';
import CommonsWants from '../screens/Commons/CommonsWants';
import CommonsConsentRequests from '../screens/Commons/CommonsConsentRequests';

const Stack = createNativeStackNavigator<AppParamList>();

// An agent link invitation that arrived before onboarding was complete (a tap, or the
// first-launch deferred invite) is held in `./pendingLinkAccept` and replayed by the effect
// below the moment onboardingComplete flips to true.

// Same pattern for a remote promise imported (and already persisted) from a
// share link before the Promises tab exists. Holds only the promiseId — the
// terms are already decrypted + saved locally; this just deep-links to the
// detail once onboarding/navigation is ready. The secret key is never stashed.
type PendingPromiseImport = { promiseId: string };
let pendingPromiseImport: PendingPromiseImport | null = null;

interface AppNavigatorProps {
    navigationRef?: React.RefObject<NavigationContainerRef<any>>;
    onReady?: () => void;
}

const AppNavigator = ({ navigationRef, onReady }: AppNavigatorProps) => {
    const hasHydrated = useHasHydrated();
    const { onboardingComplete } = useWalletStore();

    // SECURITY FIX: Detect session timeout while app is in foreground and lock
    // the screen (navigate to WalletLock), not just deauthenticate (review #8).
    useSessionTimeoutWatcher(navigationRef);
    useBackgroundLock();
    // D-6 fix: Auto-detect network state changes (online/offline)
    useNetworkMonitor();

    // Populate the Solana address (derived from the SAME seed as the EVM
    // address) into the store whenever the EVM address is known but the Solana
    // address is not. Fires on fresh creation, restore, AND app boot for wallets
    // created before Solana support (getSolanaAddress backfills from the seed).
    const evmAddress = useWalletStore(s => s.address);
    const storeSolanaAddress = useWalletStore(s => s.solanaAddress);
    const setSolanaAddress = useWalletStore(s => s.setSolanaAddress);
    useEffect(() => {
        if (evmAddress && !storeSolanaAddress) {
            WalletCreationService.getInstance()
                .getSolanaAddress()
                .then(sol => { if (sol) setSolanaAddress(sol); })
                .catch(() => { /* non-fatal; retried next launch */ });
        }
    }, [evmAddress, storeSolanaAddress, setSolanaAddress]);

    // Initialize sync services for relay synchronization
    useEffect(() => {
        // PE METER : the relay stops storing PEs. Start the phone's meter on
        // EVERY app start: it keeps every PE on this phone, sends one batch of act records a day
        // (and right before a presentation or payout), files receipts + proofs, checks the mailbox
        // once a day, and keeps the
        // encrypted backup in the person's own iCloud / Google Drive current. It also publishes
        // the person's message key when it is missing (so PEs can be sealed to them).
        // Fire-and-forget: it must never block navigation readiness.
        void startPhoneMeter();

        (async () => {
            // Self-healing wallet registration. The wallet_created PE, the
            // wallets doc, and the first accrual entry are all created by the
            // relay's /v1/wallet/human/register call. Fresh onboarding attempts
            // it with the creation approval, but recovery/import users and anyone whose call failed
            // on a network blip, end up with NO record on the relay (empty
            // "Your record starts here" forever). ensureHumanWalletRegistered
            // is idempotent server-side and skipped locally once confirmed, so
            // this reconciles any missing registration without re-minting.
            try {
                const { address, onboardingComplete: done } = useWalletStore.getState();
                if (done && address) {
                    await RelayAPIService.ensureHumanWalletRegistered(address);
                }
            } catch {
                // Non-fatal; retried on next launch.
            }
        })();

        // [H-6 / I-W-1] Deep link handler with proper URL parsing.
        // Handles BOTH runtime events AND cold-start launches. Previously the
        // `linking.addEventListener` path only fired for URLs delivered while
        // the app was already running. If a user tapped a provian://link?...
        // invite with the app fully closed, the URL was dropped and the
        // LinkAccept screen never opened.
        //
        // Gating: LinkAccept requires a wallet, so if onboarding is not
        // complete we stash the params and replay them once onboarding
        // finishes (see the replay effect below). Reading the store via
        // getState() here is intentional: we need the value at delivery
        // time, not at effect-mount time.
        const handleDeepLink = (url: string | null) => {
            if (!url) return;
            const parsed = deepLinkValidator(url);
            if (!parsed) {
                // Log ONLY scheme://host/path — strip the query AND fragment: a
                // malformed promise-import link carries the secret key in `#k=...`
                // and the ciphertext in `?d=...`, neither of which may be logged.
                console.warn('[AppNavigator] Rejected invalid deep link:', url.split('#')[0].split('?')[0]);
                return;
            }

            // C3: E2E-encrypted remote promise import. The decryption key rides
            // ONLY the URL fragment (parsed.fragment) — never sent to a server.
            // NEVER log `d` (ciphertext) or `k` (key). Decrypt + persist in-memory,
            // then deep-link to the detail (stash + replay if pre-onboarding).
            if (isPromiseImportLink(parsed)) {
                const d = parsed.params?.d;
                const k = new URLSearchParams(parsed.fragment).get('k');
                if (!d || !k) {
                    console.warn('[AppNavigator] Promise import link missing ciphertext or key');
                    return;
                }
                (async () => {
                    try {
                        const { address } = useWalletStore.getState();
                        const imported = await PromiseService.importPromiseFromShareLink(
                            d,
                            k,
                            address ?? 'local:promise-import',
                        );
                        if (!imported) return;
                        const onboarded = useWalletStore.getState().onboardingComplete;
                        if (onboarded && navigationRef?.current) {
                            navigationRef.current.navigate('PromiseDetail', { promiseId: imported.id, openedAt: Date.now() });
                        } else {
                            // Already saved locally; surface it once tabs exist.
                            pendingPromiseImport = { promiseId: imported.id };
                        }
                    } catch {
                        // Wrong key / tampered / malformed → fail closed, no import.
                        // No `d`/`k` in the log.
                        console.warn('[AppNavigator] Promise import failed (invalid or tampered link)');
                    }
                })();
                return;
            }

            // Agent-to-human link invitation handler
            if (parsed.host === 'link' || matchesPath(parsed, '/link')) {
                const inviteId = parsed.params?.invite;
                const agentWalletId = parsed.params?.agent_wallet;
                if (!inviteId || !agentWalletId) return;
                const onboarded = useWalletStore.getState().onboardingComplete;
                if (!onboarded) {
                    void captureInvite({ kind: 'agent', inviteId, agentWalletId });
                    return;
                }
                if (navigationRef?.current) {
                    // [F11] LinkAccept is a wallet-authenticated action. If the wallet
                    // is locked, stash the target and send the user through WalletLock;
                    // the isAuthenticated replay effect above navigates to LinkAccept
                    // after a real unlock, never landing it over the lock screen.
                    const authed = useWalletStore.getState().isAuthenticated === true;
                    if (authed) {
                        navigationRef.current.navigate('LinkAccept', { inviteId, agentWalletId });
                    } else {
                        stashProtectedNav({ screen: 'LinkAccept', params: { inviteId, agentWalletId } });
                        navigationRef.current.navigate('WalletLock');
                    }
                }
            }
        };

        // Cold-start deep link: app was launched from a URL. getInitialURL
        // returns the URL if present; null otherwise. Fire-and-forget.
        Linking.getInitialURL()
            .then(handleDeepLink)
            .catch(() => { /* ignore */ });

        const linkingSub = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));

        return () => {
            linkingSub.remove();
        };
    }, []);

    // Replay a deep link that arrived before onboarding finished. Fires once
    // onboardingComplete flips to true (and on every subsequent mount that
    // observes a stashed link plus a ready navigationRef). The stash is
    // consumed at most once.
    useEffect(() => {
        const replay = () => {
            const state = useWalletStore.getState();
            if (!state.onboardingComplete || !peekPendingLinkAccept() || !navigationRef?.current) return;
            const stashed = consumePendingLinkAccept();
            if (!stashed) return;
            if (state.isAuthenticated === true) {
                navigationRef.current.navigate('LinkAccept', stashed);
            } else {
                stashProtectedNav({ screen: 'LinkAccept', params: stashed });
                navigationRef.current.navigate('WalletLock');
            }
        };
        const unsubscribe = subscribePendingLinkAccept(replay);
        replay();
        return unsubscribe;
    }, [onboardingComplete, navigationRef]);

    useEffect(() => {
        if (!hasHydrated || onboardingComplete) return;
        void startDeferredInviteCheck();
    }, [hasHydrated, onboardingComplete]);

    // Replay a promise-import deep link that arrived before onboarding finished.
    // The promise is already decrypted + persisted; this only navigates to it.
    useEffect(() => {
        if (!onboardingComplete) return;
        const stashed = pendingPromiseImport;
        if (!stashed) return;
        if (!navigationRef?.current) return;
        pendingPromiseImport = null;
        navigationRef.current.navigate('PromiseDetail', { promiseId: stashed.promiseId, openedAt: Date.now() });
    }, [onboardingComplete, navigationRef]);

    // [F11] Replay a protected navigation target (a notification tap or deep link
    // that arrived while the wallet was locked). NotificationService / handleDeepLink
    // stash the destination and send the user to WalletLock; once a real unlock
    // flips isAuthenticated true (WalletLock resets to MainTabs), navigate to the
    // stashed screen so it lands ON TOP of an authenticated session, never over the
    // lock. Consumed at most once. WalletLock's own unlock takes the stash before it flips
    // isAuthenticated (landAfterUnlock, so its reset can never wipe the replayed screen); this
    // effect serves every other path that flips it.
    const isAuthenticated = useWalletStore((s) => s.isAuthenticated);
    useEffect(() => {
        if (!isAuthenticated) return;
        if (!navigationRef?.current) return;
        const target = consumeProtectedNav();
        if (!target) return;
        // Dynamic (screen, params) pair — the typed navigate overloads can't model
        // a runtime-chosen screen name, so dispatch through an untyped ref.
        (navigationRef.current as { navigate: (screen: string, params?: Record<string, unknown>) => void })
            .navigate(target.screen, target.params);
    }, [isAuthenticated, navigationRef]);

    // Wait for store hydration before determining initial route
    if (!hasHydrated) {
        return (
            <View style={loadingStyles.container}>
                <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
        );
    }

    // Determine initial route based on persisted state
    const getInitialRoute = () => {
        if (!onboardingComplete) {
            // First time user → Unified onboarding flow
            return 'Onboarding';
        }

        // All returning users go through WalletLock → MainTabs
        return 'WalletLock';
    };

    return (
        <ErrorBoundary>
            <NavigationContainer
                ref={navigationRef}
                onReady={onReady}
                onStateChange={() => {
                    // N-5: Update activity timestamp on every navigation event so the
                    // 15-minute session timeout doesn't fire while the user is actively
                    // navigating between screens.
                    useWalletStore.getState().updateActivity();
                }}
            >
                <Stack.Navigator
                initialRouteName={getInitialRoute()}
                screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: COLORS.background },
                    animation: 'fade_from_bottom',
                    animationDuration: 250,
                }}
            >
                <Stack.Screen name="Onboarding" component={UnifiedOnboardingScreen} />
                <Stack.Screen name="Vision" component={VisionScreen} />
                {/* Commons */}
                <Stack.Screen name="CommonsOnboarding" component={CommonsOnboarding} />
                <Stack.Screen name="CommonsDashboard" component={CommonsDashboard} />
                <Stack.Screen name="CommonsProfile" component={CommonsProfile} />
                <Stack.Screen name="CommonsRegistry" component={CommonsRegistry} />
                <Stack.Screen name="CommonsMarket" component={CommonsMarket} />
                <Stack.Screen name="CommonsHumanJobs" component={CommonsHumanJobs} />
                <Stack.Screen name="CommonsHumanJobsPost" component={CommonsHumanJobsPost} />
                <Stack.Screen name="CommonsHumanJobManage" component={CommonsHumanJobManage} />
                <Stack.Screen name="CommonsInstitutions" component={CommonsInstitutions} />
                <Stack.Screen name="CommonsCourt" component={CommonsCourt} />
                <Stack.Screen name="CommonsBonds" component={CommonsBonds} />
                <Stack.Screen name="CommonsGovernance" component={CommonsGovernance} />
                <Stack.Screen name="CommonsForum" component={CommonsForum} />
                <Stack.Screen name="CommonsForumPost" component={CommonsForumPost} />
                <Stack.Screen name="CommonsCompose" component={CommonsCompose} />
                <Stack.Screen name="CommonsThreads" component={CommonsThreads} />
                <Stack.Screen name="CommonsNewMessage" component={CommonsNewMessage} />
                <Stack.Screen name="CommonsThread" component={CommonsThread} />
                <Stack.Screen name="CommonsWants" component={CommonsWants} />
                <Stack.Screen name="CommonsConsentRequests" component={CommonsConsentRequests} />
                <Stack.Screen name="Consent" component={ConsentScreen} />
                <Stack.Screen name="BiometricSetup" component={BiometricSetupScreen} />
                <Stack.Screen name="CloudBackupConfirm" component={CloudBackupConfirmScreen} />
                <Stack.Screen name="PhraseBackup" component={PhraseBackupScreen} />
                <Stack.Screen name="StayInTheLoop" component={StayInTheLoopScreen} />
                <Stack.Screen name="ImportRecoveryPhrase" component={ImportRecoveryPhraseScreen} />
                <Stack.Screen name="ExportMnemonic" component={ExportMnemonicScreen} />
                <Stack.Screen name="Attestation" component={AttestationScreen} />
                <Stack.Screen name="MainTabs" component={TabNavigator} />
                <Stack.Screen name="Dashboard" component={DashboardScreen} />
                <Stack.Screen name="Send" component={SendScreen} />
                <Stack.Screen name="HumanPresentment" component={HumanPresentmentScreen} />
                <Stack.Screen name="PresentationRequester" component={PresentationRequesterScreen} />
                <Stack.Screen name="Receive" component={ReceiveScreen} options={{ presentation: 'modal' }} />
                <Stack.Screen name="Swap" component={SwapScreen} />
                <Stack.Screen name="BuyCrypto" component={BuyCryptoScreen} />
                <Stack.Screen name="Settings" component={SettingsScreen} />
                <Stack.Screen name="Contacts" component={ContactsScreen} />
                <Stack.Screen name="ContactDetail" component={ContactDetailScreen} />
                <Stack.Screen name="Language" component={LanguageScreen} />
                <Stack.Screen name="SecuritySettings" component={SecuritySettingsScreen} />
                <Stack.Screen name="BackupAndRecovery" component={BackupAndRecoveryScreen} />
                <Stack.Screen name="Legal" component={LegalScreen} />
                <Stack.Screen name="OpenSourceNotices" component={OpenSourceNoticesScreen} />
                <Stack.Screen name="HelpSupport" component={HelpSupportScreen} />
                <Stack.Screen name="DeleteAllData" component={DeleteAllDataScreen} />
                <Stack.Screen name="TermsOfService" component={TermsOfServiceScreen} />
                <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
                <Stack.Screen name="NetworkConstitution" component={NetworkConstitutionScreen} />
                <Stack.Screen name="WalletLock" component={WalletLockScreen} />

                <Stack.Screen name="BiometricSettings" component={BiometricSettingsScreen} />
                <Stack.Screen name="WalletConnectSecurity" component={WalletConnectSecurityScreen} />
                <Stack.Screen name="PeArchive" component={ArchiveScreen} />
                <Stack.Screen name="CommonsBlocked" component={CommonsBlockedScreen} />
                <Stack.Screen name="ProfileEdit" component={ProfileEditScreen} />
                <Stack.Screen name="DeviceManagement" component={DeviceManagementScreen} />
                <Stack.Screen name="PEViewer" component={PEViewerScreen} />
                <Stack.Screen name="Lockdown" component={LockdownScreen} />
                <Stack.Screen name="WalletConnect" component={WalletConnectScreen} />

                {/* Exit Strategy */}
                <Stack.Screen name="ExitStrategyInfo" component={ExitStrategyInfoScreen} />

                {/* Transaction History */}
                <Stack.Screen name="TransactionHistory" component={TransactionHistoryScreen} />
                <Stack.Screen name="TransactionDetail" component={TransactionDetailScreen} />

                {/* Promise Tool */}
                <Stack.Screen name="PromiseList" component={PromiseListScreen} />
                <Stack.Screen name="CreatePromise" component={CreatePromiseScreen} />
                <Stack.Screen name="PromiseDetail" component={PromiseDetailScreen} />
                <Stack.Screen name="ScanPromise" component={ScanPromiseScreen} />

                {/* Chat (Phase 2c) */}
                <Stack.Screen name="ChatWebView" component={ChatWebViewScreen} />

                {/* Recovery Flow */}
                <Stack.Screen name="RecoveryStart" component={RecoveryStartScreen} />
                <Stack.Screen name="CloudRecovery" component={CloudRecoveryScreen} />

                {/* Agent Stack */}
                <Stack.Screen name="AgentHub" component={AgentHubScreen} />
                <Stack.Screen name="AgentDetail" component={AgentDetailScreen} />
                <Stack.Screen name="LinkAccept" component={LinkAcceptScreen} />
                <Stack.Screen name="ConnectAgent" component={ConnectAgentScreen} />
                <Stack.Screen name="RecoverAgent" component={RecoverAgentScreen} />
                <Stack.Screen name="RekeyAgent" component={RekeyAgentScreen} />
                <Stack.Screen name="LinkExternalWallet" component={LinkExternalWalletScreen} />
                <Stack.Screen name="AgentCardSpending" component={AgentCardSpendingScreen} />
                <Stack.Screen name="EarnSurfaceDetail" component={EarnSurfaceDetailScreen} />
                <Stack.Screen name="ForgeConnect" component={ForgeConnectScreen} />
                <Stack.Screen name="ProveOwnWallet" component={ProveOwnWalletScreen} />
                <Stack.Screen name="ForgeContributors" component={ForgeContributorsScreen} />
                <Stack.Screen name="BondManagement" component={BondManagementScreen} />
                <Stack.Screen name="BondClaims" component={ClaimsScreen} />


                {/* Activity Stack */}
                <Stack.Screen name="ActivityLog" component={ActivityLogScreen} />
                <Stack.Screen name="EnvelopeDetail" component={EnvelopeDetailScreen} />

                {/* Provenance / PVT Dashboard */}
                <Stack.Screen name="MyProvenance" component={MyProvenanceDashboardScreen} />
                <Stack.Screen name="PVTDetail" component={PVTDetailScreen} />

                {/* Trust Layer (pass 2) */}
                <Stack.Screen name="OwnProfile" component={OwnProfileScreen} />
                <Stack.Screen name="ApprovalInbox" component={ApprovalInboxScreen} />
                <Stack.Screen name="AttentionCenter" component={AttentionCenterScreen} />
                <Stack.Screen name="PresentationRequest" component={PresentationRequestScreen} />

                </Stack.Navigator>
                {/* the one talking-pass sheet, opened from any Commons screen. */}
                <TalkingPassHost />
            </NavigationContainer>
        </ErrorBoundary>
    );
};

const loadingStyles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: COLORS.background,
    },
});

export default AppNavigator;
