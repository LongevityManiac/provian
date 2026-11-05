import i18next from 'i18next';
import { translate } from '../i18n/translate';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { apiFetch } from '../core/network/apiFetch';
import {
    ensurePushRegistration as ensurePushRegistrationDecision,
    type PushPermissionStatus,
    type PushRegistrationOutcome,
} from './pushRegistration';
import { createDeviceTokenGate } from './pushTokenRegistrationGuard';
import { useWalletStore } from '../store/walletStore';
import { stashProtectedNav } from '../navigation/pendingProtectedNav';
import { requestAttentionRefresh } from '../core/attention/attentionRefresh';

// Storage keys
const PUSH_TOKEN_KEY = 'provian_push_token';
const BACKEND_URL_KEY = '@provian_backend_url';
const NOTIFICATION_PREFS_KEY = '@provian_notification_prefs';

// Default backend URL
const DEFAULT_BACKEND_URL = 'https://api.provian.ai';

/**
 * Agent-activity notification family. The wallet no longer governs
 * agents — there are no approval, goal, kill-switch, or proxied-payment
 * pushes. What remains agent-related is ACTIVITY about the human's linked
 * agents: a link request / invite-link event, and an agent's PE / earning
 * event. Every type in this set is gated by the `agentActivity` preference
 * and taps land on the Earn hub (AgentHub), where link requests and linked
 * agents live.
 */
export const AGENT_ACTIVITY_NOTIFICATION_TYPES = [
    'agent_link_request',
    'agent_linked',
    'agent_pe_recorded',
    'agent_pvt_minted',
] as const;
export type AgentActivityNotificationType = (typeof AGENT_ACTIVITY_NOTIFICATION_TYPES)[number];

// Notification types
export type NotificationType =
    | 'transaction_received'
    | 'recovery_initiated'
    | 'promise_created'
    | 'promise_accepted'
    | 'promise_fulfilled'
    // The relay's other promise transitions (routes/human-promises.ts). Until 2026-10-17 these
    // arrived with no type to match, so a counter-offer, a close-out request, a dispute, a
    // decline or a broken promise opened nothing on tap.
    | 'promise_countered'
    | 'promise_closeout_requested'
    | 'promise_disputed'
    | 'promise_rejected'
    | 'promise_broken'
    | 'swap_completed'
    | 'price_alert'
    | AgentActivityNotificationType
    ;

export interface AgentActivityNotificationData {
    type: AgentActivityNotificationType;
    /** The linked agent this event concerns (relay agent_id), when known. */
    agent_id?: string;
    agent_name?: string;
    /** Link-request / invite id for `agent_link_request` (opens LinkAccept for it). */
    invite_id?: string;
    /** The requesting agent's wallet id for `agent_link_request`. */
    agent_wallet_id?: string;
    /** PE id for `agent_pe_recorded` / `agent_pvt_minted`. */
    pe_id?: string;
}

export interface TransactionReceivedNotificationData {
    type: 'transaction_received';
    tx_hash: string;
    amount: string;
    symbol: string;
    chain: string;
    from: string;
}

export interface RecoveryNotificationData {
    type: 'recovery_initiated';
    recovery_id: string;
    initiator: string;
    wallet_address: string;
}

export interface PromiseNotificationData {
    type: 'promise_created' | 'promise_accepted' | 'promise_fulfilled' | 'promise_countered' | 'promise_closeout_requested' | 'promise_disputed' | 'promise_rejected' | 'promise_broken';
    promise_id: string;
    promise_what: string;
    counterparty: string;
}

export type NotificationData =
    | AgentActivityNotificationData
    | TransactionReceivedNotificationData
    | RecoveryNotificationData
    | PromiseNotificationData;

export interface InAppNotification {
    id: string;
    title: string;
    body: string;
    data: any;
}

export interface NotificationPreferences {
    /**
     * Notifications about the human's linked agents (link requests, invite /
     * link events, agent PE and earning events). Renamed from the retired
     * `agentApprovals` (the wallet no longer approves agent actions);
     * a persisted legacy `agentApprovals` value seeds this on load.
     */
    agentActivity: boolean;
    transactionReceived: boolean;
    recoveryAlerts: boolean;
    promiseUpdates: boolean;
    priceAlerts: boolean;
    // Retired with the approval flow. Kept in the persisted shape so
    // an existing device's stored preferences still parse; nothing reads them.
    agentCommunicateRequests: boolean;
    agentCommitRequests: boolean;
    agentShareDataRequests: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
    agentActivity: true,
    transactionReceived: true,
    recoveryAlerts: true,
    promiseUpdates: true,
    priceAlerts: false,
    agentCommunicateRequests: true,
    agentCommitRequests: true,
    agentShareDataRequests: true,
};

/**
 * Persisted-preference shape: the current keys plus the legacy `agentApprovals`
 * key an older build may have stored. Read once at load; never written back.
 */
type StoredNotificationPreferences = Partial<NotificationPreferences> & {
    agentApprovals?: unknown;
};

/**
 * Merge a stored preference blob onto the defaults. A device that persisted the
 * legacy `agentApprovals` toggle (and has not yet stored `agentActivity`) keeps
 * its choice: the legacy boolean becomes the `agentActivity` default.
 */
export function mergeStoredNotificationPreferences(
    stored: StoredNotificationPreferences,
): NotificationPreferences {
    const { agentApprovals, ...current } = stored;
    const legacyAgentActivity =
        typeof agentApprovals === 'boolean' && typeof current.agentActivity !== 'boolean'
            ? { agentActivity: agentApprovals }
            : {};
    return { ...DEFAULT_PREFS, ...legacyAgentActivity, ...current };
}

export type NotificationHandler = (data: NotificationData) => void;
export type InAppNotificationHandler = (notification: InAppNotification) => void;

class NotificationService {
    private static instance: NotificationService;
    private notificationListener: Notifications.Subscription | null = null;
    private responseListener: Notifications.Subscription | null = null;
    private pushTokenListener: Notifications.Subscription | null = null;
    private tokenRegistrar: ((token: string) => Promise<void>) | null = null;
    private handlers: NotificationHandler[] = [];
    private inAppHandler: InAppNotificationHandler | null = null;
    private navigationRef: any = null;
    private preferences: NotificationPreferences = DEFAULT_PREFS;
    private permissionGranted: boolean = false;
    // Loop guard for the push-token rotation listener (see initialize()). Dedupes
    // on the device-token value so a re-emitted identical token cannot drive an
    // unbounded re-registration storm. See pushTokenRegistrationGuard.ts.
    private deviceTokenGate: (token: unknown) => boolean = createDeviceTokenGate();

    private constructor() {}

    static getInstance(): NotificationService {
        if (!NotificationService.instance) {
            NotificationService.instance = new NotificationService();
        }
        return NotificationService.instance;
    }

    async initialize(navigationRef?: any): Promise<void> {
        this.navigationRef = navigationRef;

        // [M-6] One-time migration: move FCM token from AsyncStorage to SecureStore
        await this.migratePushTokenToSecureStore();

        // Load preferences
        await this.loadPreferences();

        // Configure notification handler
        Notifications.setNotificationHandler({
            handleNotification: async (notification) => {
                const data = notification.request.content.data as any;

                // Check if this notification type is enabled
                if (!this.shouldShowNotification(data?.type)) {
                    return {
                        shouldShowAlert: false,
                        shouldPlaySound: false,
                        shouldSetBadge: false,
                        shouldShowBanner: false,
                        shouldShowList: false,
                    };
                }

                // High priority for recovery alerts
                const highPriorityTypes = [
                    'recovery_initiated',
                ];
                if (highPriorityTypes.includes(data?.type)) {
                    return {
                        shouldShowAlert: true,
                        shouldPlaySound: true,
                        shouldSetBadge: true,
                        shouldShowBanner: true,
                        shouldShowList: true,
                    };
                }

                // Default handling
                return {
                    shouldShowAlert: true,
                    shouldPlaySound: false,
                    shouldSetBadge: true,
                    shouldShowBanner: true,
                    shouldShowList: true,
                };
            },
        });

        // Listen for notifications
        this.notificationListener = Notifications.addNotificationReceivedListener(
            this.handleNotificationReceived.bind(this)
        );

        // Listen for user taps
        this.responseListener = Notifications.addNotificationResponseReceivedListener(
            this.handleNotificationResponse.bind(this)
        );

        // Token-rotation listener: Expo can rotate the device push token (OS
        // reinstall of the APNs/FCM registration, app restore, etc). When the
        // token actually changes we re-mint the Expo token and re-register with
        // the backend so a rotation never silently orphans this device.
        //
        // LOOP GUARD (2026-08-12 incident): registerForPushNotifications() calls
        // getExpoPushTokenAsync(), which on some OS builds (observed on iOS /
        // Darwin 25.6.0) RE-EMITS this very token-changed event. Re-minting on
        // every emit therefore recurses without bound — tens of POSTs/sec to
        // /fcm-token, which trips the relay rate limiter (429) and starves every
        // other call sharing that budget. The device token does not change
        // between echoes, so we gate on its value: an identical re-emit returns
        // early (no re-mint), a genuine rotation re-registers exactly once.
        // Best-effort; never throws. See pushTokenRegistrationGuard.ts.
        this.pushTokenListener = Notifications.addPushTokenListener((devicePushToken) => {
            if (!this.deviceTokenGate(devicePushToken)) return;
            console.log('[NotificationService] Device push token changed - re-registering');
            this.registerForPushNotifications()
                .then((token) => (token && this.tokenRegistrar ? this.tokenRegistrar(token) : undefined))
                .catch((err) => console.warn('[NotificationService] Token-refresh re-register failed:', err));
        });

        console.log('[NotificationService] Initialized');
    }

    private shouldShowNotification(type: NotificationType): boolean {
        switch (type) {
            case 'transaction_received':
                return this.preferences.transactionReceived;
            case 'recovery_initiated':
                return this.preferences.recoveryAlerts;
            case 'promise_created':
            case 'promise_accepted':
            case 'promise_fulfilled':
            case 'promise_countered':
            case 'promise_closeout_requested':
            case 'promise_disputed':
            case 'promise_rejected':
            case 'promise_broken':
                return this.preferences.promiseUpdates;
            case 'price_alert':
                return this.preferences.priceAlerts;
            // Linked-agent activity: link requests, invite/link events, agent
            // PE / earning events. One opt-in for the whole family.
            case 'agent_link_request':
            case 'agent_linked':
            case 'agent_pe_recorded':
            case 'agent_pvt_minted':
                return this.preferences.agentActivity;
            default:
                return true;
        }
    }

    async requestPermission(): Promise<boolean> {
        if (!Device.isDevice) {
            console.log('[NotificationService] Must use physical device');
            return false;
        }

        const { status: existingStatus } = await Notifications.getPermissionsAsync();

        if (existingStatus === 'granted') {
            this.permissionGranted = true;
            await this.registerForPushNotifications();
            return true;
        }

        const { status } = await Notifications.requestPermissionsAsync();
        this.permissionGranted = status === 'granted';

        if (this.permissionGranted) {
            await this.registerForPushNotifications();
        }

        return this.permissionGranted;
    }

    isPermissionGranted(): boolean {
        return this.permissionGranted;
    }

    async checkPermissionStatus(): Promise<boolean> {
        const { status } = await Notifications.getPermissionsAsync();
        this.permissionGranted = status === 'granted';
        return this.permissionGranted;
    }

    /**
     * Wire the callback that pushes a minted/rotated token to the backend. Set
     * once at app start (App.tsx) to `token => RelayAPIService.registerFCMToken`.
     * Kept as a callback so this service doesn't import RelayAPIService, which
     * would create a circular dependency (RelayAPIService imports this service).
     */
    setTokenRegistrar(registrar: ((token: string) => Promise<void>) | null): void {
        this.tokenRegistrar = registrar;
    }

    /**
     * Idempotent push-registration entry point - the missing link that makes
     * relay -> phone push actually work end to end.
     *
     * Call with `{ prompt: true }` right after a wallet becomes active (creation,
     * recovery, import) to ask for notification permission IN CONTEXT, mint the
     * Expo token, and register it with the backend. Call with `{ prompt: false }`
     * on app start / foreground to silently (re-)register when already granted -
     * that path also self-heals if the user enables notifications in system
     * settings later. Never prompts on a prior denial (no nag), never throws.
     * See src/services/pushRegistration.ts for the decision logic.
     */
    async ensurePushRegistration(options: { prompt?: boolean } = {}): Promise<PushRegistrationOutcome> {
        const outcome = await ensurePushRegistrationDecision(
            {
                isDevice: Device.isDevice,
                getPermissionStatus: async () =>
                    (await Notifications.getPermissionsAsync()).status as PushPermissionStatus,
                requestPermission: async () =>
                    (await Notifications.requestPermissionsAsync()).status as PushPermissionStatus,
                // registerForPushNotifications mints the Expo token, stores it in
                // SecureStore, and (re)creates the Android channels; returns the token.
                mintToken: () => this.registerForPushNotifications(),
                register: async (token: string) => {
                    if (this.tokenRegistrar) await this.tokenRegistrar(token);
                },
            },
            options,
        );
        if (outcome === 'registered') this.permissionGranted = true;
        console.log(`[NotificationService] ensurePushRegistration -> ${outcome}`);
        return outcome;
    }

    cleanup(): void {
        try {
            if (this.notificationListener) {
                this.notificationListener.remove();
                this.notificationListener = null;
            }
        } catch (e) {}
        try {
            if (this.responseListener) {
                this.responseListener.remove();
                this.responseListener = null;
            }
        } catch (e) {}
        try {
            if (this.pushTokenListener) {
                this.pushTokenListener.remove();
                this.pushTokenListener = null;
            }
        } catch (e) {}
    }

    addHandler(handler: NotificationHandler): () => void {
        this.handlers.push(handler);
        return () => {
            this.handlers = this.handlers.filter(h => h !== handler);
        };
    }

    setNavigationRef(ref: any): void {
        this.navigationRef = ref;
    }

    private handleNotificationReceived(notification: Notifications.Notification): void {
        const data = notification.request.content.data as any;
        console.log('[NotificationService] Notification received:', data?.type);

        // Item 4: any push may add (or resolve) something that needs the human, so the bell and
        // the tab badge reload now rather than at the next Dashboard focus.
        requestAttentionRefresh();

        // Notify all handlers
        this.handlers.forEach(handler => handler(data));

        // Show in-app notification
        if (this.inAppHandler) {
            this.inAppHandler({
                id: notification.request.identifier,
                title: notification.request.content.title || '',
                body: notification.request.content.body || '',
                data,
            });
        }
    }

    /**
     * [F11] Navigate to a notification-tap target through the wallet-lock gate.
     * When the wallet is locked (`isAuthenticated === false`) the target is
     * stashed and the user is sent to WalletLock; AppNavigator replays the stash
     * after a real unlock. When already authenticated, navigate directly. This
     * closes the bypass where tapping a banner over a locked WalletLock screen
     * landed on a sensitive screen (transaction, recovery, promise) with no auth.
     */
    private navigateProtected(screen: string, params?: Record<string, unknown>): void {
        if (!this.navigationRef) return;
        let authed = false;
        try {
            authed = useWalletStore.getState().isAuthenticated === true;
        } catch {
            authed = false; // fail closed: treat store-read failure as locked
        }
        if (authed) {
            this.navigationRef.navigate(screen as never, params as never);
            return;
        }
        stashProtectedNav({ screen, params });
        this.navigationRef.navigate('WalletLock' as never);
    }

    private handleNotificationResponse(response: Notifications.NotificationResponse): void {
        const data = response.notification.request.content.data as any;
        console.log('[NotificationService] Notification tapped:', data?.type);

        if (!this.navigationRef) return;

        // Deep link based on notification type. [F11] Every destination routes
        // through navigateProtected so a locked wallet is unlocked first.
        switch (data?.type) {
            case 'transaction_received':
                this.navigateProtected('TransactionDetail', {
                    transaction: {
                        hash: data.tx_hash,
                        chain: data.chain,
                        amount: data.amount,
                        symbol: data.symbol,
                        from: data.from,
                        type: 'received',
                        status: 'confirmed',
                        timestamp: Date.now(),
                    },
                });
                break;

            case 'recovery_initiated':
                this.navigateProtected('RecoveryStart', {
                    recoveryId: data.recovery_id,
                });
                break;

            case 'promise_created':
            case 'promise_accepted':
            case 'promise_fulfilled':
            case 'promise_countered':
            case 'promise_closeout_requested':
            case 'promise_disputed':
            case 'promise_rejected':
            case 'promise_broken':
                this.navigateProtected('PromiseDetail', {
                    promiseId: data.promise_id,
                    openedAt: Date.now(),
                });
                break;

            // Item 4: a link request opens THAT request (LinkAccept) so the human can
            // review, name, and accept or decline it in one tap; without an invite id it
            // falls back to the Agent Hub, where link requests are listed.
            case 'agent_link_request':
                if (typeof data.invite_id === 'string' && data.invite_id.length > 0) {
                    this.navigateProtected('LinkAccept', {
                        inviteId: data.invite_id,
                        ...(typeof data.agent_wallet_id === 'string' && data.agent_wallet_id.length > 0
                            ? { agentWalletId: data.agent_wallet_id }
                            : {}),
                    });
                } else {
                    this.navigateProtected('AgentHub');
                }
                break;

            // Other linked-agent activity (invite/link events, agent PE / earning
            // events) lands on the Earn hub, where linked agents are reviewed.
            case 'agent_linked':
            case 'agent_pe_recorded':
            case 'agent_pvt_minted':
                this.navigateProtected('AgentHub');
                break;

            // Trust Layer §2.1: an agent asked this human to approve a described
            // action — deep-link to the approval inbox.
            case 'human_approval_request':
                this.navigateProtected('ApprovalInbox');
                break;

            // §3f: an agent asked to present to this human remotely — deep-link straight to
            // the request if we have its id, else to the attention center.
            case 'presentation_request':
                if (typeof data.request_id === 'string' && data.request_id.length > 0) {
                    this.navigateProtected('PresentationRequest', { requestId: data.request_id });
                } else {
                    this.navigateProtected('AttentionCenter');
                }
                break;

            // Commons operator announcement broadcast - open the announcement thread.
            // a thread message / presentation request / deliverable landed for this human.
            case 'thread_message':
                if (typeof data.thread_id === 'string' && data.thread_id.length > 0) {
                    this.navigateProtected('CommonsThread', { threadId: data.thread_id });
                } else {
                    this.navigateProtected('CommonsThreads');
                }
                break;
            // someone replied to my post or comment — open the tree at the new reply.
            case 'forum_reply':
                if (typeof data.post_id === 'string' && data.post_id.length > 0) {
                    this.navigateProtected('CommonsForumPost', {
                        postId: data.post_id,
                        ...(typeof data.comment_id === 'string' && data.comment_id.length > 0 ? { focusCommentId: data.comment_id } : {}),
                        ...(typeof data.channel === 'string' && data.channel.length > 0 ? { channel: data.channel } : {}),
                    });
                } else {
                    this.navigateProtected('CommonsForum');
                }
                break;
            // a step on a Commons job this person is a party to (applied / hired / funded /
            // delivered / released / disputed / dispute_settled) — open the job screen.
            case 'commons_job':
                if (typeof data.job_id === 'string' && data.job_id.length > 0) {
                    this.navigateProtected('CommonsHumanJobManage', { jobId: data.job_id });
                } else {
                    this.navigateProtected('CommonsHumanJobs');
                }
                break;
            case 'commons_announcement':
                if (data.postId) {
                    this.navigateProtected('CommonsForumPost', {
                        postId: data.postId,
                        channel: data.channel || 'announcements',
                    });
                } else {
                    this.navigateProtected('CommonsForum');
                }
                break;

            default:
                this.navigateProtected('Dashboard');
        }
    }

    async registerForPushNotifications(): Promise<string | null> {
        if (!Device.isDevice) {
            return null;
        }

        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') {
            return null;
        }

        try {
            const projectId = Constants.expoConfig?.extra?.eas?.projectId
                ?? Constants.easConfig?.projectId;

            const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
            const token = tokenData.data;

            // [M-6] Store FCM token in SecureStore instead of AsyncStorage
            await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);

            // Set up Android channels
            if (Platform.OS === 'android') {
                await Notifications.setNotificationChannelAsync('agent-requests', {
                    name: translate('notifications.agentRequestsChannel', 'Agent Activity'),
                    importance: Notifications.AndroidImportance.MAX,
                    vibrationPattern: [0, 250, 250, 250],
                    lightColor: '#6366F1',
                    sound: 'default',
                });

                await Notifications.setNotificationChannelAsync('transactions', {
                    name: translate('notifications.transactionAlertsChannel', 'Transaction Alerts'),
                    importance: Notifications.AndroidImportance.HIGH,
                    sound: 'default',
                });

                await Notifications.setNotificationChannelAsync('recovery', {
                    name: translate('settings.recoveryAlerts', 'Recovery Alerts'),
                    importance: Notifications.AndroidImportance.MAX,
                    vibrationPattern: [0, 500, 250, 500],
                    lightColor: '#EF4444',
                    sound: 'default',
                });

                await Notifications.setNotificationChannelAsync('promises', {
                    name: translate('settings.promiseUpdates', 'Promise Updates'),
                    importance: Notifications.AndroidImportance.DEFAULT,
                });
            }

            console.log('[NotificationService] Push token:', token.substring(0, 20) + '...');
            return token;
        } catch (error) {
            console.error('[NotificationService] Error getting push token:', error);
            return null;
        }
    }

    async registerTokenWithBackend(userId: string, backendUrl?: string): Promise<boolean> {
        try {
            const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
            if (!token) return false;

            const url = backendUrl || await this.getBackendUrl();

            // Network request to api.provian.ai (standard HTTPS)
            const response = await apiFetch(`${url}/v1/users/${userId}/fcm-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fcm_token: token, language: i18next.resolvedLanguage ?? i18next.language ?? 'en' }),
            });

            return response.ok;
        } catch (error) {
            console.error('[NotificationService] Error registering token:', error);
            return false;
        }
    }

    // Preferences management
    async getPreferences(): Promise<NotificationPreferences> {
        return this.preferences;
    }

    async updatePreferences(updates: Partial<NotificationPreferences>): Promise<void> {
        this.preferences = { ...this.preferences, ...updates };
        await AsyncStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(this.preferences));
    }

    private async loadPreferences(): Promise<void> {
        try {
            const stored = await AsyncStorage.getItem(NOTIFICATION_PREFS_KEY);
            if (stored) {
                this.preferences = mergeStoredNotificationPreferences(
                    JSON.parse(stored) as StoredNotificationPreferences,
                );
            }
        } catch (error) {
            console.error('[NotificationService] Error loading preferences:', error);
        }
    }

    // Send local notifications
    async sendTransactionReceivedNotification(
        amount: string,
        symbol: string,
        from: string,
        chain: string,
        txHash: string
    ): Promise<void> {
        if (!this.preferences.transactionReceived) return;

        const truncatedFrom = from.slice(0, 8) + '...' + from.slice(-6);

        this.triggerInAppNotification({
            id: txHash,
            title: translate('settings.transactionReceived', 'Transaction Received'),
            body: translate('notifications.receivedBody', `Received ${amount} ${symbol} from ${truncatedFrom}`, { amount, symbol, from: truncatedFrom }),
            data: {
                type: 'transaction_received',
                tx_hash: txHash,
                amount,
                symbol,
                chain,
                from,
            },
        });

        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: translate('settings.transactionReceived', 'Transaction Received'),
                    body: translate('notifications.receivedBody', `Received ${amount} ${symbol} from ${truncatedFrom}`, { amount, symbol, from: truncatedFrom }),
                    data: { type: 'transaction_received', tx_hash: txHash, amount, symbol, chain, from },
                    sound: 'default',
                },
                trigger: null, // Immediate
            });
        } catch (error) {
            console.log('[NotificationService] System notification failed');
        }
    }

    async sendRecoveryInitiatedNotification(
        recoveryId: string,
        initiator: string,
        walletAddress: string
    ): Promise<void> {
        if (!this.preferences.recoveryAlerts) return;

        this.triggerInAppNotification({
            id: recoveryId,
            title: translate('notifications.recoveryTitle', 'Recovery Initiated'),
            body: translate('notifications.recoveryBody', `Someone is attempting to recover wallet ${walletAddress.slice(0, 10)}...`, { address: walletAddress.slice(0, 10) }),
            data: {
                type: 'recovery_initiated',
                recovery_id: recoveryId,
                initiator,
                wallet_address: walletAddress,
            },
        });

        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: translate('notifications.recoveryTitle', 'Recovery Initiated'),
                    body: translate('notifications.recoveryBody', `Someone is attempting to recover wallet ${walletAddress.slice(0, 10)}...`, { address: walletAddress.slice(0, 10) }),
                    data: { type: 'recovery_initiated', recovery_id: recoveryId, initiator, wallet_address: walletAddress },
                    sound: 'default',
                },
                trigger: null,
            });
        } catch (error) {
            console.log('[NotificationService] System notification failed');
        }
    }

    async sendPromiseNotification(
        type: 'promise_created' | 'promise_accepted' | 'promise_fulfilled',
        promiseId: string,
        promiseWhat: string,
        counterparty: string
    ): Promise<void> {
        if (!this.preferences.promiseUpdates) return;

        const titles = {
            promise_created: translate('promise.createTitle', 'New Promise'),
            promise_accepted: translate('actionTypes.labels.promise_accepted', 'Promise Accepted'),
            promise_fulfilled: translate('actionTypes.labels.promise_fulfilled', 'Promise Fulfilled'),
        };

        const bodies = {
            promise_created: translate('notifications.promiseCreatedBody', `${counterparty} made you a promise`, { counterparty }),
            promise_accepted: translate('notifications.promiseAcceptedBody', `${counterparty} accepted your promise`, { counterparty }),
            promise_fulfilled: translate('notifications.promiseFulfilledBody', `Promise "${promiseWhat.slice(0, 30)}..." was fulfilled`, { what: promiseWhat.slice(0, 30) }),
        };

        this.triggerInAppNotification({
            id: promiseId,
            title: titles[type],
            body: bodies[type],
            data: {
                type,
                promise_id: promiseId,
                promise_what: promiseWhat,
                counterparty,
            },
        });
    }

    // Backend URL management
    async setBackendUrl(url: string): Promise<void> {
        await AsyncStorage.setItem(BACKEND_URL_KEY, url);
    }

    async getBackendUrl(): Promise<string> {
        const stored = await AsyncStorage.getItem(BACKEND_URL_KEY);
        const url = stored || DEFAULT_BACKEND_URL;
        // review #39: every authenticated relay request routes through here with
        // the HMAC wallet bearer token attached. Mirror resolveRelayBaseUrl's
        // guard so a tampered (or stale) http:// value can't carry that token in
        // cleartext in production. DEV builds may use http for local hosts.
        if (!__DEV__ && !url.startsWith('https://')) {
            console.error('[NotificationService] SECURITY: backend URL must use HTTPS in production, ignoring:', url);
            return DEFAULT_BACKEND_URL;
        }
        return url;
    }

    async getPushToken(): Promise<string | null> {
        return SecureStore.getItemAsync(PUSH_TOKEN_KEY);
    }

    // [M-6] Migrate FCM token from AsyncStorage to SecureStore (one-time)
    private async migratePushTokenToSecureStore(): Promise<void> {
        try {
            const oldToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
            if (oldToken) {
                await SecureStore.setItemAsync(PUSH_TOKEN_KEY, oldToken);
                await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
                console.log('[NotificationService] Migrated push token to SecureStore');
            }
        } catch (error) {
            console.warn('[NotificationService] Push token migration failed:', error);
        }
    }

    setInAppNotificationHandler(handler: InAppNotificationHandler | null): void {
        this.inAppHandler = handler;
    }

    triggerInAppNotification(notification: InAppNotification): void {
        console.log('[NotificationService] In-app notification:', notification.title);
        if (this.inAppHandler) {
            this.inAppHandler(notification);
        }
    }

    /**
     * General-purpose local notification sender.
     * Used by callers that need to send both a system notification and an
     * in-app notification.
     */
    async sendLocalNotification(
        title: string,
        body: string,
        data?: Record<string, string>
    ): Promise<void> {
        // In-app notification
        this.triggerInAppNotification({
            id: data?.recovery_id || `local_${Date.now()}`,
            title,
            body,
            data: data || {},
        });

        // System notification (immediate)
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title,
                    body,
                    data: data || {},
                    sound: 'default',
                },
                trigger: null, // Immediate
            });
        } catch (error) {
            console.log('[NotificationService] System notification failed');
        }
    }

    async scheduleTestNotification(): Promise<void> {
        const testId = 'test_' + Date.now();
        const testData: AgentActivityNotificationData & { test_id: string } = {
            type: 'agent_pe_recorded',
            test_id: testId,
            agent_id: 'Atlas',
            agent_name: 'Atlas',
        };

        setTimeout(() => {
            this.triggerInAppNotification({
                id: testId,
                title: translate('notifications.agentActivityTitle', 'Agent Activity'),
                body: translate('notifications.agentActivityBody', 'Atlas recorded a new Provenance Envelope', { agent: 'Atlas' }),
                data: testData,
            });
        }, 500);

        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: translate('notifications.agentActivityTitle', 'Agent Activity'),
                    body: translate('notifications.agentActivityBody', 'Atlas recorded a new Provenance Envelope', { agent: 'Atlas' }),
                    data: { ...testData },
                    sound: 'default',
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: 2,
                },
            });
        } catch (error) {
            console.log('[NotificationService] System notification failed');
        }
    }
}

export default NotificationService.getInstance();
