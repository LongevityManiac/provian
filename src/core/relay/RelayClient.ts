import type { BiometricAction } from '../security/biometricAction';
/**
 * Provian Relay Client
 * ====================
 *
 * Connects the wallet to the Provian Relay service to:
 * 1. Fetch pending authorization requests from agents
 * 2. Submit decisions (ALLOW/DENY) back to the relay
 * 3. Include signed receipts for agent verification
 *
 * Dev Mode Auto-Discovery:
 * In __DEV__ builds, the relay URL is automatically set to the dev machine's IP
 * (extracted from Metro/Expo) with port 8787, so physical devices can connect
 * without manual configuration.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { buildAndSignReceipt, type DecisionReceipt, type RequestPayload } from './DecisionReceipt';
import { resolveRelayBaseUrl, getRelayDiscoveryInfo } from './DevHostDiscovery';

// ============================================================================
// SECURITY FIX 6.1: Dev API Key Guard
// ============================================================================

/**
 * SECURITY FIX 6.1: Validate API key is not a dev key in production.
 *
 * Test keys (format: `test-key:*`) are auto-generated for localhost development.
 * They MUST NOT be used in production builds as they bypass real authentication.
 *
 * @param apiKey - The API key to validate
 * @throws Error if a test key is detected in a production build
 */
function validateApiKeyForProduction(apiKey: string): void {
    if (!apiKey) return;

    // Pattern matches "test-key:" prefix
    const isTestKey = apiKey.toLowerCase().startsWith('test-key:');

    if (isTestKey && !__DEV__) {
        console.error('[SECURITY] Test API key detected in production build:', apiKey.substring(0, 15) + '...');
        throw new Error(
            'SECURITY ERROR: Test API keys (test-key:*) are not allowed in production builds. ' +
            'Please configure a real API key for production deployment.'
        );
    }

    if (isTestKey && __DEV__) {
        console.log('[RelayClient] Using test API key (OK in dev mode)');
    }
}

// ============================================================================
// Types
// ============================================================================

export interface RelayConfig {
  /** Relay service URL (e.g., http://localhost:8787 or https://relay.provian.io) */
  relayUrl: string;
  /** Wallet ID */
  walletId: string;
  /** API key for authentication */
  apiKey: string;
}

export interface RelayStatus {
  configured: boolean;
  relayUrl: string;
  walletId: string | null;
  urlSource: 'env' | 'auto-discovered' | 'production' | 'manual';
  isDev: boolean;
  pollingActive: boolean;
}

/** Intent context for tracking action provenance (Phase 1: Device-Attested Intent Binding) */
export interface RelayIntentContext {
  user_instruction_hash: string;
  reasoning_summary: string;
  external_inputs_used: string[];
}

export interface RelayRequest {
  id: string;
  walletId: string;
  agentId: string;
  actionType: string;
  amount: number;
  currency: string;
  merchant: string;
  purpose: string;
  metadata: Record<string, unknown>;
  status: 'PENDING' | 'ALLOW' | 'DENY' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  publicPost?: {
    platform: 'twitter' | 'linkedin' | 'instagram' | 'reddit' | 'facebook' | 'other';
    postType: 'reply' | 'new_post';
    contentPreview: string;
    fullContent?: string;
    threadContext?: string;
    replyToId?: string;
  };
  systemAccess?: {
    operation: 'read' | 'write_delete' | 'execute' | 'install';
    targetPath: string;
    description: string;
    requiresElevation: boolean;
  };
  uncategorized?: {
    actionType: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high';
    metadata?: Record<string, unknown>;
  };
  egressData?: {
    destination: string;
    method: string;
    data_description: string;
    data_categories: string[];
    payload_size_bytes: number;
  };
  intent_context?: RelayIntentContext;
  // Classification verification (Phase 3)
  reclassified?: boolean;
  original_type?: string;
  reclassification_reason?: string;
}

export interface RelayDecisionResult {
  success: boolean;
  existing?: boolean;
  decision?: 'ALLOW' | 'DENY';
  receipt?: DecisionReceipt;
  error?: string;
}

// ============================================================================
// Storage Keys
// ============================================================================

const RELAY_CONFIG_KEY = '@provian:relay_config';
// SECURITY FIX: M-16 - API key stored in SecureStore, not AsyncStorage
const RELAY_API_KEY_SECURE = 'provian_relay_api_key';

// ============================================================================
// Relay Client
// ============================================================================

class RelayClient {
  private config: RelayConfig | null = null;
  private initialized = false;
  private pollingActive = false;
  private urlSource: 'env' | 'auto-discovered' | 'production' | 'manual' = 'production';

  /**
   * Initialize the relay client by loading saved config or auto-configuring in dev mode.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const saved = await AsyncStorage.getItem(RELAY_CONFIG_KEY);
      if (saved) {
        this.config = JSON.parse(saved);
        // SECURITY FIX: M-16 - Load API key from SecureStore instead of AsyncStorage
        const secureApiKey = await SecureStore.getItemAsync(RELAY_API_KEY_SECURE);
        if (secureApiKey && this.config) {
          this.config.apiKey = secureApiKey;
        }
        this.urlSource = 'manual';
      }
    } catch (error) {
      console.error('[RelayClient] Failed to load config:', error);
    }

    this.initialized = true;
  }

  /**
   * Auto-configure relay for dev mode using discovered host IP.
   * This allows physical devices to connect without manual setup.
   *
   * @param walletId The wallet ID to use
   * @returns true if auto-configuration succeeded
   */
  autoConfigureForDev(walletId: string): boolean {
    const discovery = getRelayDiscoveryInfo();

    if (!discovery.isDev || discovery.source === 'production') {
      console.log('[RelayClient] Auto-config skipped: not in dev mode or no host discovered');
      return false;
    }

    const apiKey = `test-key:${walletId}`;

    // SECURITY FIX 6.1: Defense-in-depth - validate even though we check isDev above
    // This catches edge cases where discovery.isDev might be incorrectly set
    validateApiKeyForProduction(apiKey);

    this.config = {
      relayUrl: discovery.baseUrl,
      walletId,
      apiKey,
    };
    this.urlSource = discovery.source;

    console.log('[RelayClient] Auto-configured for dev:', {
      relayUrl: discovery.baseUrl,
      walletId,
      source: discovery.source,
    });

    return true;
  }

  /**
   * Check if relay is configured.
   */
  isConfigured(): boolean {
    return this.config !== null &&
           !!this.config.relayUrl &&
           !!this.config.walletId &&
           !!this.config.apiKey;
  }

  /**
   * Get current configuration.
   */
  getConfig(): RelayConfig | null {
    return this.config;
  }

  /**
   * Get relay status for UI display.
   */
  getStatus(): RelayStatus {
    const discovery = getRelayDiscoveryInfo();

    return {
      configured: this.isConfigured(),
      relayUrl: this.config?.relayUrl || discovery.baseUrl,
      walletId: this.config?.walletId || null,
      urlSource: this.config ? this.urlSource : discovery.source,
      isDev: discovery.isDev,
      pollingActive: this.pollingActive,
    };
  }

  /**
   * Get the resolved relay URL (auto-discovered or configured).
   */
  getResolvedRelayUrl(): string {
    if (this.config?.relayUrl) {
      return this.config.relayUrl;
    }
    return resolveRelayBaseUrl();
  }

  /**
   * Save relay configuration.
   */
  async saveConfig(config: RelayConfig): Promise<void> {
    // Validate
    if (!config.relayUrl || !config.walletId || !config.apiKey) {
      throw new Error('All relay config fields are required');
    }

    // Auto-generate dev key for localhost if needed
    let apiKey = config.apiKey;
    if (!apiKey && this.isLocalhostUrl(config.relayUrl)) {
      apiKey = `test-key:${config.walletId}`;
    }

    // SECURITY FIX 6.1: Reject test keys in production
    validateApiKeyForProduction(apiKey);

    this.config = { ...config, apiKey };
    this.urlSource = 'manual';
    // SECURITY FIX: M-16 - Store API key in SecureStore, not AsyncStorage
    await SecureStore.setItemAsync(RELAY_API_KEY_SECURE, apiKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    // Store config without API key in AsyncStorage (non-sensitive metadata)
    const { apiKey: _, ...configWithoutKey } = this.config;
    await AsyncStorage.setItem(RELAY_CONFIG_KEY, JSON.stringify({ ...configWithoutKey, apiKey: '' }));
  }

  /**
   * Set polling state (for UI display).
   */
  setPollingActive(active: boolean): void {
    this.pollingActive = active;
  }

  /**
   * Clear relay configuration.
   */
  async clearConfig(): Promise<void> {
    this.config = null;
    await AsyncStorage.removeItem(RELAY_CONFIG_KEY);
    // SECURITY FIX: M-16 - Also clear from SecureStore
    await SecureStore.deleteItemAsync(RELAY_API_KEY_SECURE);
  }

  /**
   * Generate dev API key for the configured walletId.
   * SECURITY FIX 6.1: Throws in production builds to prevent accidental use.
   */
  generateDevApiKey(): string {
    if (!this.config?.walletId) {
      throw new Error('walletId not configured');
    }
    const apiKey = `test-key:${this.config.walletId}`;

    // SECURITY FIX 6.1: This method should never be called in production
    validateApiKeyForProduction(apiKey);

    return apiKey;
  }

  /**
   * Fetch pending authorization requests from the relay.
   */
  async fetchPendingRequests(): Promise<RelayRequest[]> {
    if (!this.isConfigured()) {
      throw new Error('Relay not configured');
    }

    const response = await this.fetch('/pending');
    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch pending requests');
    }

    return data.requests || [];
  }

  /**
   * Submit a decision to the relay with a signed receipt.
   */
  async submitDecision(
    requestId: string,
    decision: 'ALLOW' | 'DENY',
    request: RelayRequest,
    options?: { notes?: string; reasonCodes?: string[]; modifiedContent?: string }, biometricAction?: BiometricAction
  ): Promise<RelayDecisionResult> {
    if (!this.isConfigured()) {
      throw new Error('Relay not configured');
    }

    // Build the request payload for receipt signing
    const requestPayload: RequestPayload = {
      agentId: request.agentId,
      actionType: request.actionType,
      amount: request.amount,
      currency: request.currency,
      merchant: request.merchant,
      purpose: request.purpose,
      metadata: request.metadata,
    };

    // Build and sign receipt
    const receipt = await buildAndSignReceipt({
      requestId,
      walletId: this.config!.walletId,
      decision,
      requestPayload,
      reasonCodes: options?.reasonCodes,
      notes: options?.notes,
    }, biometricAction);

    const body = JSON.stringify({
      requestId,
      walletId: this.config!.walletId,
      decision,
      notes: options?.notes,
      receipt,
      ...(options?.modifiedContent ? { modified_content: options.modifiedContent } : {}),
    });

    // Submit to relay
    const response = await this.fetch('/decision', {
      method: 'POST',
      body,
    });

    const data = await response.json();

    if (!data.success) {
      return {
        success: false,
        error: data.error || 'Failed to submit decision',
      };
    }

    return {
      success: true,
      existing: data.existing,
      decision: data.decision,
      receipt,
    };
  }

  /**
   * Check the status of a specific request.
   */
  async checkRequestStatus(requestId: string): Promise<{
    status: string;
    decidedAt?: string;
    receipt?: DecisionReceipt;
  }> {
    if (!this.isConfigured()) {
      throw new Error('Relay not configured');
    }

    const response = await this.fetch(`/status/${requestId}`);
    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Failed to check status');
    }

    return {
      status: data.status,
      decidedAt: data.decidedAt,
      receipt: data.receipt,
    };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private isLocalhostUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'localhost' ||
             parsed.hostname === '127.0.0.1' ||
             parsed.hostname.endsWith('.local');
    } catch {
      return false;
    }
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    if (!this.config) {
      throw new Error('Relay not configured');
    }

    const url = `${this.config.relayUrl.replace(/\/$/, '')}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Provian-Api-Key': this.config.apiKey,
        ...options.headers,
      },
    });

    return response;
  }
}

// Singleton instance
export const relayClient = new RelayClient();
export default relayClient;

// Re-export discovery utilities
export { resolveRelayBaseUrl, getRelayDiscoveryInfo, getDevHostIP } from './DevHostDiscovery';
