import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { acceptedLegalVersions, legalAcceptanceCurrent } from '../core/legal/legalAcceptance';
import {
    WalletConnectGovernanceSettings,
    DEFAULT_WC_GOVERNANCE_SETTINGS,
} from '../core/walletconnect/governanceSettings';

// Lazy-load NetInfo. Its raw TS source pulls in a chain ending in
// expo-modules-core's setUpJsLogger.fx.ts, which uses syntax vitest's
// transformer rejects. NetInfo is only consulted from useNetworkMonitor,
// so loading at first use keeps tests that import walletStore transitively
// (the entire app, basically) from blowing up at module load time.
type NetInfoModule = typeof import('@react-native-community/netinfo').default;
let _netInfoCache: NetInfoModule | null = null;
function getNetInfo(): NetInfoModule {
    if (!_netInfoCache) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _netInfoCache = require('@react-native-community/netinfo').default;
    }
    return _netInfoCache!;
}

export interface Asset {
    symbol: string;
    name: string;
    balance: string;
    /** USD price. Meaningful only when `priceStatus` is 'market' or 'peg' (0 otherwise). */
    price: number;
    /**
     * where `price` came from. 'market' = the last known feed price (see
     * `priceAsOf` for its age); 'peg' = a stablecoin with no feed price, at its $1
     * peg; 'unknown' = never priced — render " ", never $0.00. Absent on snapshots
     * persisted before (treated as 'market' with no known age).
     */
    priceStatus?: 'market' | 'peg' | 'unknown';
    /** When the market price was observed at its source (ms). */
    priceAsOf?: number;
    chain: 'Base' | 'Arbitrum' | 'Optimism' | 'Solana';
    /**
     * Chain ID for precise network identification (e.g. 8453 for Base).
     * Undefined for Solana, which is not an EVM numeric-chainId chain — Solana
     * assets are discriminated by `chain === 'Solana'`.
     */
    chainId?: number;
    /** Token contract address (undefined for native assets like ETH) */
    tokenAddress?: string;
    /** Token decimals (e.g. 6 for USDC, 18 for ETH) */
    decimals?: number;
    isStablecoin?: boolean;
    isStaked?: boolean;
    isPVT?: boolean;
}

/** Composite key for unique asset identification across chains */
export const getAssetKey = (asset: Pick<Asset, 'symbol' | 'chain'>): string =>
    `${asset.symbol}-${asset.chain}`;

// the multi-mode hub was retired — Provian is a unified wallet, so the only
// live mode is 'wallet'. `null` = not yet onboarded. normalizeWalletMode still
// collapses any legacy persisted value to 'wallet' at read time.
export type WalletMode = 'wallet' | null;

// All users are now in unified wallet mode. Legacy modes collapse to 'wallet'.
export const normalizeWalletMode = (mode: WalletMode): 'wallet' | null => {
    if (!mode) return null;
    return 'wallet';
};

// SECURITY FIX: E-7 - Session timeout configuration
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity

interface WalletState {
    // Persisted state
    walletMode: WalletMode;
    onboardingComplete: boolean;
    // Per-mode onboarding tracking
    promisesOnboardingComplete: boolean;
    walletOnboardingComplete: boolean;
    userName: string;
    address: string;
    /** Solana (ed25519, base58) address, derived from the same seed as `address`. */
    solanaAddress: string;
    tosAcceptedAt: string | null;
    /** Version (content hash) of the Terms of Service this install accepted; null before any acceptance. */
    termsAcceptedVersion: string | null;
    /** Version (content hash) of the Privacy Policy this install accepted; null before any acceptance. */
    privacyAcceptedVersion: string | null;

    // Block counter (persisted) - tracks how many dangerous actions were blocked
    blocksCount: number;
    blocksCountThisMonth: number;
    blocksCountLastResetMonth: string; // YYYY-MM format for month tracking

    // WalletConnect owner governance settings (persisted). The human WalletConnect
    // signing path runs through the same crypto-spending governance pipeline as
    // agent on-chain actions; these are the owner-tunable controls. The kill
    // switch and biometric are enforced unconditionally and are NOT here.
    walletConnectGovernance: WalletConnectGovernanceSettings;

    // Session state (not persisted)
    isAuthenticated: boolean;
    lastActivityAt: number;  // SECURITY FIX: E-7 - Track last activity for session timeout
    assets: Asset[];
    isLockdownActive: boolean;
    isOffline: boolean;
    isDataSaver: boolean;
    transactionQueue: any[];

    // Hydration state
    _hasHydrated: boolean;
    setHasHydrated: (state: boolean) => void;

    // Actions
    acceptTos: () => void;
    setUserName: (name: string) => void;
    completeOnboarding: (mode: WalletMode, userName?: string) => void;
    setAuthenticated: (isAuth: boolean) => void;
    updateActivity: () => void;  // SECURITY FIX: E-7 - Update last activity timestamp
    resetOnboarding: () => void;
    setAssets: (assets: Asset[]) => void;
    addAsset: (asset: Asset) => void;
    updateAssetBalance: (symbol: string, balance: string, chain?: Asset['chain']) => void;
    setAddress: (address: string) => void;
    setSolanaAddress: (solanaAddress: string) => void;
    incrementBlockCount: () => void;
    setLockdown: (isActive: boolean) => void;
    setOffline: (isActive: boolean) => void;
    setDataSaver: (isActive: boolean) => void;
    queueTransaction: (tx: any) => void;
    clearQueue: () => void;
    setWalletConnectGovernance: (patch: Partial<WalletConnectGovernanceSettings>) => void;
}

/** Selector: whether this install accepted the Terms and Privacy Policy versions the app ships now. */
export const selectLegalAcceptanceCurrent = (s: Pick<WalletState, 'termsAcceptedVersion' | 'privacyAcceptedVersion'>): boolean =>
    legalAcceptanceCurrent(s);

// Real wallets start empty - balances come from on-chain queries
const INITIAL_ASSETS: Asset[] = [];

export const useWalletStore = create<WalletState>()(
    persist(
        (set) => ({
            // Persisted state
            walletMode: null,
            onboardingComplete: false,
            // Per-mode onboarding tracking
            promisesOnboardingComplete: false,
            walletOnboardingComplete: false,
            userName: '',
            address: '',
            solanaAddress: '',
            tosAcceptedAt: null,
            termsAcceptedVersion: null,
            privacyAcceptedVersion: null,

            // Block counter
            blocksCount: 0,
            blocksCountThisMonth: 0,
            blocksCountLastResetMonth: '',

            // WalletConnect owner governance (safe defaults)
            walletConnectGovernance: DEFAULT_WC_GOVERNANCE_SETTINGS,

            // Session state (not persisted)
            isAuthenticated: false,
            lastActivityAt: 0,  // SECURITY FIX: E-7 - Initialize last activity timestamp
            assets: INITIAL_ASSETS,
            isLockdownActive: false,
            isOffline: false,
            isDataSaver: false,
            transactionQueue: [],

            // Hydration tracking
            _hasHydrated: false,
            setHasHydrated: (state) => set({ _hasHydrated: state }),

            // Actions
            // Records when, and which versions of the Terms of Service and Privacy Policy, were accepted.
            acceptTos: () => set({ tosAcceptedAt: new Date().toISOString(), ...acceptedLegalVersions() }),

            setUserName: (name) => set({ userName: name }),

            completeOnboarding: (mode, userName) => set((state) => ({
                    walletMode: 'wallet',
                    onboardingComplete: true,
                    promisesOnboardingComplete: true,
                    walletOnboardingComplete: true,
                    userName: userName || '',
                    isAuthenticated: true,
            })),

            // SECURITY FIX: E-7 - Update lastActivityAt when authentication changes
            setAuthenticated: (isAuth) => set({
                isAuthenticated: isAuth,
                lastActivityAt: isAuth ? Date.now() : 0,
            }),

            // SECURITY FIX: E-7 - Update activity timestamp on user interaction
            updateActivity: () => set({ lastActivityAt: Date.now() }),

            resetOnboarding: () => set({
                walletMode: null,
                onboardingComplete: false,
                promisesOnboardingComplete: false,
                    walletOnboardingComplete: false,
                userName: '',
                address: '',
                solanaAddress: '',
                tosAcceptedAt: null,
                termsAcceptedVersion: null,
                privacyAcceptedVersion: null,
                isAuthenticated: false,
            }),

            setAssets: (assets) => set({ assets }),

            addAsset: (asset) => set((state) => {
                // Use composite key (symbol + chain) to prevent cross-chain merging
                const existingIndex = state.assets.findIndex(
                    a => a.symbol === asset.symbol && a.chain === asset.chain,
                );
                if (existingIndex >= 0) {
                    const updatedAssets = [...state.assets];
                    const existingBalance = parseFloat(updatedAssets[existingIndex].balance.replace(/,/g, ''));
                    const newBalance = parseFloat(asset.balance.replace(/,/g, ''));
                    updatedAssets[existingIndex] = {
                        ...updatedAssets[existingIndex],
                        balance: (existingBalance + newBalance).toString(),
                    };
                    return { assets: updatedAssets };
                }
                return { assets: [...state.assets, asset] };
            }),

            updateAssetBalance: (symbol, balance, chain) => set((state) => ({
                assets: state.assets.map(a =>
                    a.symbol === symbol && (!chain || a.chain === chain) ? { ...a, balance } : a
                ),
            })),

            setAddress: (address) => set({ address }),
            setSolanaAddress: (solanaAddress) => set({ solanaAddress }),

            incrementBlockCount: () => set((state) => {
                const now = new Date();
                const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                const monthlyCount = state.blocksCountLastResetMonth === currentMonth
                    ? state.blocksCountThisMonth + 1
                    : 1;
                return {
                    blocksCount: state.blocksCount + 1,
                    blocksCountThisMonth: monthlyCount,
                    blocksCountLastResetMonth: currentMonth,
                };
            }),

            setLockdown: (status) => set({ isLockdownActive: status }),
            setOffline: (status) => set({ isOffline: status }),
            setDataSaver: (status) => set({ isDataSaver: status }),
            queueTransaction: (tx) => set((state) => ({ transactionQueue: [...state.transactionQueue, tx] })),
            clearQueue: () => set({ transactionQueue: [] }),
            setWalletConnectGovernance: (patch) => set((state) => ({
                walletConnectGovernance: { ...state.walletConnectGovernance, ...patch },
            })),
        }),
        {
            name: 'provian-wallet-storage',
            storage: createJSONStorage(() => AsyncStorage),
            // Only persist these fields
            partialize: (state) => ({
                walletMode: state.walletMode,
                onboardingComplete: state.onboardingComplete,
                promisesOnboardingComplete: state.promisesOnboardingComplete,
                walletOnboardingComplete: state.walletOnboardingComplete,
                userName: state.userName,
                address: state.address,
                solanaAddress: state.solanaAddress,
                tosAcceptedAt: state.tosAcceptedAt,
                termsAcceptedVersion: state.termsAcceptedVersion,
                privacyAcceptedVersion: state.privacyAcceptedVersion,
                blocksCount: state.blocksCount,
                blocksCountThisMonth: state.blocksCountThisMonth,
                blocksCountLastResetMonth: state.blocksCountLastResetMonth,
                walletConnectGovernance: state.walletConnectGovernance,
                // N-1: Persist transaction queue so offline-queued txs survive app crash/restart
                transactionQueue: state.transactionQueue,
            }),
            onRehydrateStorage: () => (state, error) => {
                if (error) {
                    // N-6: If AsyncStorage data is corrupted, log the error and
                    // still mark hydration complete so the app doesn't hang on
                    // the loading spinner. The store falls back to initial state.
                    console.error('[WalletStore] Hydration failed - using defaults:', error);
                }
                // Backfill WalletConnect governance for pre-existing installs (and
                // any field added later) so the owner always has the safe defaults
                // unless they explicitly changed a value. Fail-safe: persisted
                // values win only where present, defaults fill the rest.
                if (state) {
                    state.walletConnectGovernance = {
                        ...DEFAULT_WC_GOVERNANCE_SETTINGS,
                        ...(state.walletConnectGovernance || {}),
                    };
                }
                if (state) {
                    state.setHasHydrated(true);
                } else {
                    // N-6: state is null when hydration fails (corrupted JSON).
                    // Access the store directly to unblock the app.
                    useWalletStore.getState().setHasHydrated(true);
                }
            },
        }
    )
);

// Hook to wait for hydration
export const useHasHydrated = () => useWalletStore((state) => state._hasHydrated);

// =============================================================================
// SELECTIVE SELECTORS (#3: contain updateActivity() re-renders)
// Components should use these instead of subscribing to the full store.
// =============================================================================

export const selectAddress = (state: WalletState) => state.address;
export const selectSolanaAddress = (state: WalletState) => state.solanaAddress;
export const selectAssets = (state: WalletState) => state.assets;
export const selectWalletMode = (state: WalletState) => state.walletMode;
export const selectIsAuthenticated = (state: WalletState) => state.isAuthenticated;
export const selectIsLockdownActive = (state: WalletState) => state.isLockdownActive;
export const selectIsOffline = (state: WalletState) => state.isOffline;
export const selectUserName = (state: WalletState) => state.userName;
export const selectOnboardingComplete = (state: WalletState) => state.onboardingComplete;
export const selectBlocksCount = (state: WalletState) => state.blocksCount;
export const selectBlocksCountThisMonth = (state: WalletState) => state.blocksCountThisMonth;
export const selectLastActivityAt = (state: WalletState) => state.lastActivityAt;

// SECURITY FIX: E-7 - Session timeout check utility (outside store to avoid circular ref)
export const isSessionTimedOut = (): boolean => {
    const state = useWalletStore.getState();
    if (!state.isAuthenticated || state.lastActivityAt === 0) return false;
    return Date.now() - state.lastActivityAt > SESSION_TIMEOUT_MS;
};

// SECURITY FIX: E-7 - Hook to check session timeout
export const useSessionTimedOut = () => {
    const isAuthenticated = useWalletStore(selectIsAuthenticated);
    const lastActivityAt = useWalletStore(selectLastActivityAt);
    if (!isAuthenticated || lastActivityAt === 0) return false;
    return Date.now() - lastActivityAt > SESSION_TIMEOUT_MS;
};

/**
 * SECURITY FIX: Session timeout foreground idle watcher.
 * Runs a 30-second interval to detect when the session expires while the app
 * is in the foreground, and logs the user out so the lock screen is shown.
 * Call this hook in AppNavigator after hydration.
 */
type SessionLockNavRef = {
    current: {
        reset: (state: { index: number; routes: { name: string }[] }) => void;
        getCurrentRoute?: () => { name?: string } | undefined;
    } | null;
};

export const useSessionTimeoutWatcher = (navigationRef?: SessionLockNavRef) => {
    const isAuthenticated = useWalletStore(selectIsAuthenticated);
    const onboardingComplete = useWalletStore(selectOnboardingComplete);

    useEffect(() => {
        if (!isAuthenticated || !onboardingComplete) return;

        const interval = setInterval(() => {
            if (isSessionTimedOut()) {
                console.warn('[SessionTimeout] Session expired while in foreground - logging out');
                useWalletStore.getState().setAuthenticated(false);
                // SECURITY (review #8): deauthenticating alone does NOT lock the
                // screen - nothing else navigates to WalletLock from the
                // isAuthenticated flag, so MainTabs would stay mounted and fully
                // usable on an idle, abandoned phone. Drive the lock navigation
                // here (mirrors App.tsx's background-timeout handler).
                const nav = navigationRef?.current;
                if (nav && nav.getCurrentRoute?.()?.name !== 'WalletLock') {
                    nav.reset({ index: 0, routes: [{ name: 'WalletLock' }] });
                }
            }
        }, 30_000);

        return () => clearInterval(interval);
    }, [isAuthenticated, onboardingComplete, navigationRef]);
};

/**
 * SECURITY: Background lock - lock wallet after 30s in background.
 * When the app moves to background, record the timestamp. When it returns
 * to foreground, if 30+ seconds have passed, deauthenticate so the user
 * must Face ID again through WalletLockScreen.
 * Call this hook in AppNavigator alongside useSessionTimeoutWatcher.
 */
const BACKGROUND_LOCK_MS = 30_000; // 30 seconds

export const useBackgroundLock = () => {
    const isAuthenticated = useWalletStore(selectIsAuthenticated);
    const backgroundedAt = useRef<number | null>(null);

    useEffect(() => {
        if (!isAuthenticated) return;

        const handleAppStateChange = (nextState: AppStateStatus) => {
            if (nextState === 'background' || nextState === 'inactive') {
                backgroundedAt.current = Date.now();
            } else if (nextState === 'active' && backgroundedAt.current) {
                const elapsed = Date.now() - backgroundedAt.current;
                backgroundedAt.current = null;
                if (elapsed >= BACKGROUND_LOCK_MS) {
                    console.warn(`[BackgroundLock] App was backgrounded for ${Math.round(elapsed / 1000)}s - locking`);
                    useWalletStore.getState().setAuthenticated(false);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => subscription.remove();
    }, [isAuthenticated]);
};

/**
 * D-6 fix: Automatic offline detection via NetInfo.
 * Subscribes to network state changes and auto-toggles `isOffline` in the store.
 * Call this hook in AppNavigator alongside useSessionTimeoutWatcher and useBackgroundLock.
 */
export const useNetworkMonitor = () => {
    useEffect(() => {
        const unsubscribe = getNetInfo().addEventListener((state) => {
            const offline = state.isConnected === false || state.isInternetReachable === false;
            const current = useWalletStore.getState().isOffline;
            if (offline !== current) {
                useWalletStore.getState().setOffline(offline);
                console.log(`[NetworkMonitor] Network state changed: ${offline ? 'offline' : 'online'}`);
            }
        });
        return () => unsubscribe();
    }, []);
};
