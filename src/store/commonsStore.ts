import type { BiometricAction } from '../core/security/biometricAction';
/**
 * Provian Commons - Zustand Store
 *
 * Dedicated state management for the Commons mode.
 * Server is authoritative for most data - local state is cache + UI state.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as CommonsService from '../core/commons/CommonsService';
import { REPLIES_SEEN_KEY } from '../core/commons/inbox';
import type {
  CommonsProfile,
  FeedItem,
  InstitutionInfo,
} from '../core/commons/CommonsService';

interface CommonsState {
  // Profile
  profile: CommonsProfile | null;
  isJoined: boolean;
  membershipStatus: 'unknown' | 'joined' | 'not_joined';
  isLoading: boolean;
  error: string | null;

  // Notifications
  pendingConsentRequests: number;
  unreadForumReplies: number;
  /** threads with a message you have not read. */
  unreadThreads: number;
  /** everything waiting in the Commons Inbox (consents + unread threads + new replies). */
  inboxUnread: number;

  // Cached data
  feedCache: { items: FeedItem[]; timestamp: number } | null;
  institutionsCache: { institutions: InstitutionInfo[]; timestamp: number } | null;
  statsCache: { stats: Record<string, unknown>; timestamp: number } | null;

  // Forum
  subscribedChannels: string[];

  // Actions
  /**
   * Reconcile membership from the authenticated relay truth.
   * Returns null when the relay cannot answer, so callers never turn a network
   * failure into the false claim that this wallet still needs to join.
   */
  refreshMembership: () => Promise<boolean | null>;
  fetchProfile: (walletId: string) => Promise<void>;
  joinCommons: (displayName: string, bio?: string, biometricAction?: BiometricAction) => Promise<void>;
  leaveCommons: () => Promise<void>;
  updateProfile: (updates: {
    display_name?: string;
    bio?: string;
    avatar_url?: string;
    skills?: string[];
    availability?: string;
  }) => Promise<void>;
  fetchFeed: () => Promise<FeedItem[]>;
  fetchInstitutions: () => Promise<InstitutionInfo[]>;
  fetchStats: () => Promise<Record<string, unknown>>;
  refreshNotifications: () => Promise<void>;
  /** the Inbox was opened — replies up to now are seen. */
  markRepliesSeen: (upTo: number) => Promise<void>;
  reset: () => void;
}

const CACHE_TTL_MS = 30_000; // 30 seconds
let notificationRefreshGeneration = 0;

const useCommonsStore = create<CommonsState>((set, get) => ({
  profile: null,
  isJoined: false,
  membershipStatus: 'unknown',
  isLoading: false,
  error: null,
  pendingConsentRequests: 0,
  unreadForumReplies: 0,
  unreadThreads: 0,
  inboxUnread: 0,
  feedCache: null,
  institutionsCache: null,
  statsCache: null,
  subscribedChannels: ['general'],

  refreshMembership: async () => {
    try {
      const context = await CommonsService.getJoinContext();
      if (!context.already_joined) {
        set({ profile: null, isJoined: false, membershipStatus: 'not_joined' });
        return false;
      }

      // The authenticated join context is the membership authority. Hydrating
      // the profile is useful for the Commons dashboard, but a transient profile
      // read failure must not erase a confirmed membership or make Earn say
      // "Set up" after a cold start.
      set({ isJoined: true, membershipStatus: 'joined' });
      try {
        const profile = await CommonsService.getAgentProfile(context.wallet_id);
        set({ profile, isJoined: true, membershipStatus: 'joined' });
      } catch {
        // Keep the authoritative joined state; the profile can retry on focus.
      }
      return true;
    } catch {
      // Unknown is not "not joined". Preserve the last confirmed state.
      return null;
    }
  },

  fetchProfile: async (walletId: string) => {
    set({ isLoading: true, error: null });
    try {
      const profile = await CommonsService.getAgentProfile(walletId);
      set({ profile, isJoined: true, membershipStatus: 'joined', isLoading: false });
    } catch {
      set({ profile: null, isJoined: false, membershipStatus: 'unknown', isLoading: false });
    }
  },

  joinCommons: async (displayName: string, bio?: string, biometricAction?: BiometricAction) => {
    set({ isLoading: true, error: null });
    try {
      const result = await CommonsService.joinCommons({
        display_name: displayName,
        bio,
      }, biometricAction);
      set({ profile: result.profile, isJoined: true, membershipStatus: 'joined', isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  leaveCommons: async () => {
    set({ isLoading: true, error: null });
    try {
      await CommonsService.leaveCommons();
      set({
        profile: null,
        isJoined: false,
        membershipStatus: 'not_joined',
        isLoading: false,
        feedCache: null,
        institutionsCache: null,
        statsCache: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to leave';
      set({ error: message, isLoading: false });
    }
  },

  updateProfile: async (updates) => {
    set({ isLoading: true, error: null });
    try {
      const updated = await CommonsService.updateCommonsProfile(updates);
      set({ profile: updated, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update';
      set({ error: message, isLoading: false });
    }
  },

  fetchFeed: async () => {
    const { feedCache } = get();
    if (feedCache && Date.now() - feedCache.timestamp < CACHE_TTL_MS) {
      return feedCache.items;
    }

    try {
      const result = await CommonsService.getActivityFeed({ page_size: 50 });
      set({ feedCache: { items: result.items, timestamp: Date.now() } });
      return result.items;
    } catch {
      return feedCache?.items || [];
    }
  },

  fetchInstitutions: async () => {
    const { institutionsCache } = get();
    if (institutionsCache && Date.now() - institutionsCache.timestamp < CACHE_TTL_MS) {
      return institutionsCache.institutions;
    }

    try {
      const result = await CommonsService.getInstitutions();
      set({ institutionsCache: { institutions: result.institutions, timestamp: Date.now() } });
      return result.institutions;
    } catch {
      return institutionsCache?.institutions || [];
    }
  },

  fetchStats: async () => {
    const { statsCache } = get();
    if (statsCache && Date.now() - statsCache.timestamp < CACHE_TTL_MS) {
      return statsCache.stats;
    }

    try {
      const stats = await CommonsService.getNetworkStats();
      set({ statsCache: { stats, timestamp: Date.now() } });
      return stats;
    } catch {
      return statsCache?.stats || {};
    }
  },

  refreshNotifications: async () => {
    const generation = ++notificationRefreshGeneration;
    // the Inbox badge counts the three things that wait on a person. Each source is
    // best-effort on its own — one failing read never zeroes the others.
    const [consents, threads, replies, seenRaw] = await Promise.all([
      CommonsService.getPendingConsents().then((r) => r.consents.length).catch(() => null),
      CommonsService.unreadThreads().then((r) => r.count ?? r.threads.length).catch(() => null),
      CommonsService.getMyReplies({ page_size: 25 }).then((r) => r.replies).catch(() => null),
      AsyncStorage.getItem(REPLIES_SEEN_KEY).catch(() => null),
    ]);
    // A read acknowledgement starts a new refresh. An earlier response must not
    // restore the unread count it fetched before that acknowledgement.
    if (generation !== notificationRefreshGeneration) return;
    const seenAt = Number(seenRaw) || 0;
    const myId = get().profile?.wallet_id ?? null;
    const newReplies = replies === null
      ? null
      : replies.filter((r) => r.author_wallet_id !== myId && (Number(r.created_at) || 0) > seenAt).length;
    const next = {
      pendingConsentRequests: consents ?? get().pendingConsentRequests,
      unreadThreads: threads ?? get().unreadThreads,
      unreadForumReplies: newReplies ?? get().unreadForumReplies,
    };
    set({ ...next, inboxUnread: next.pendingConsentRequests + next.unreadThreads + next.unreadForumReplies });
  },

  markRepliesSeen: async (upTo) => {
    if (!Number.isFinite(upTo) || upTo <= 0) return;
    const prior = Number(await AsyncStorage.getItem(REPLIES_SEEN_KEY)) || 0;
    await AsyncStorage.setItem(REPLIES_SEEN_KEY, String(Math.max(prior, upTo)));
    // Recount against the bounded watermark; a reply arriving during this load remains unread.
    await get().refreshNotifications();
  },

  reset: () => {
    notificationRefreshGeneration += 1;
    set({
      profile: null,
      isJoined: false,
      membershipStatus: 'unknown',
      isLoading: false,
      error: null,
      pendingConsentRequests: 0,
      unreadForumReplies: 0,
      unreadThreads: 0,
      inboxUnread: 0,
      feedCache: null,
      institutionsCache: null,
      statsCache: null,
    });
  },
}));

export default useCommonsStore;
