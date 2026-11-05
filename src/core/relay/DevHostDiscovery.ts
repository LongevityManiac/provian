/**
 * Dev Host Discovery
 * ==================
 * 
 * Automatically discovers the dev machine's IP address from Metro/Expo
 * so physical devices can connect to the local relay without manual config.
 */

import { NativeModules, Platform } from 'react-native';

// Lazy-load expo-constants. The static default-import previously here pulled
// in expo-modules-core at module load time, which (a) inflates production
// startup cost (Constants is only consulted in __DEV__ for relay discovery)
// and (b) breaks Vitest because expo-modules-core's source TS uses syntax
// the test transformer rejects. Loading on first call keeps tests that import
// DevHostDiscovery transitively (e.g. AgentAuthorizationGate.test.ts via the
// AgentExecutionGate → CryptoTransactionClassifier chain) from blowing up at
// load time, since they never actually invoke these functions.
type ConstantsModule = typeof import('expo-constants').default;
let _constantsCache: ConstantsModule | null = null;
function getConstants(): ConstantsModule {
  if (!_constantsCache) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _constantsCache = require('expo-constants').default;
  }
  return _constantsCache!;
}

// Default production relay URL (override with EXPO_PUBLIC_PROVIAN_RELAY_URL)
const PRODUCTION_RELAY_URL = 'https://api.provian.ai';
const DEV_RELAY_PORT = 8787;

/**
 * Extract host IP from a URL or host:port string.
 * Examples:
 *   "192.168.1.100:8081" -> "192.168.1.100"
 *   "http://192.168.1.100:8081/index.bundle" -> "192.168.1.100"
 *   "localhost:8081" -> "localhost"
 */
function extractHost(urlOrHostPort: string | undefined | null): string | null {
  if (!urlOrHostPort) return null;
  
  try {
    // Try parsing as full URL first
    if (urlOrHostPort.startsWith('http://') || urlOrHostPort.startsWith('https://')) {
      const url = new URL(urlOrHostPort);
      return url.hostname || null;
    }
    
    // Otherwise treat as host:port
    const hostPart = urlOrHostPort.split(':')[0];
    const cleanHost = hostPart.split('/')[0].trim();
    
    return cleanHost || null;
  } catch {
    // Fallback: just take everything before : or /
    const match = urlOrHostPort.match(/^([^:\/]+)/);
    return match ? match[1].trim() : null;
  }
}

/**
 * Get the dev host IP address by checking various sources.
 * 
 * Priority order:
 * 1. Expo Constants hostUri (e.g., "192.168.1.100:8081")
 * 2. Expo Constants debuggerHost
 * 3. React Native SourceCode scriptURL
 * 
 * @returns The dev host IP/hostname, or null if not discoverable
 */
export function getDevHostIP(): string | null {
  const Constants = getConstants();

  // 1. Try Expo hostUri (most reliable for Expo apps)
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = extractHost(hostUri);
    if (host) {
      console.log('[DevHostDiscovery] Found host from expoConfig.hostUri:', host);
      return host;
    }
  }

  // 2. Try Expo manifest debuggerHost (older Expo SDK)
  // @ts-ignore - manifest may exist on older SDK
  const debuggerHost = Constants.manifest?.debuggerHost || Constants.expoConfig?.extra?.debuggerHost;
  if (debuggerHost) {
    const host = extractHost(debuggerHost);
    if (host) {
      console.log('[DevHostDiscovery] Found host from debuggerHost:', host);
      return host;
    }
  }

  // 3. Try React Native SourceCode (native module)
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    const scriptURL = NativeModules.SourceCode?.scriptURL;
    if (scriptURL) {
      const host = extractHost(scriptURL);
      if (host) {
        console.log('[DevHostDiscovery] Found host from SourceCode.scriptURL:', host);
        return host;
      }
    }
  }

  // 4. Fallback: check if there's a manifest2 (new Expo format)
  // @ts-ignore
  const manifest2 = Constants.manifest2;
  if (manifest2?.extra?.expoGo?.debuggerHost) {
    const host = extractHost(manifest2.extra.expoGo.debuggerHost);
    if (host) {
      console.log('[DevHostDiscovery] Found host from manifest2:', host);
      return host;
    }
  }
  
  console.log('[DevHostDiscovery] Could not discover dev host IP');
  return null;
}

/**
 * Resolve the relay base URL based on environment and configuration.
 *
 * Priority order:
 * 1. EXPO_PUBLIC_PROVIAN_RELAY_URL env var (explicit override)
 * 2. In DEV mode: auto-discovered dev host with port 8787
 * 3. Production default URL
 *
 * @returns The relay base URL to use
 */
export function resolveRelayBaseUrl(): string {
  // 1. Check for explicit env var override (highest priority)
  // @ts-ignore - process.env may have this
  const envUrl = process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL;
  let candidate: string | null = null;

  if (envUrl) {
    console.log('[DevHostDiscovery] Using env EXPO_PUBLIC_PROVIAN_RELAY_URL:', envUrl);
    candidate = envUrl;
  } else if (__DEV__) {
    // 2. In DEV mode, try to auto-discover the dev host
    // SECURITY FIX: G-3 - HTTP relay ONLY allowed in __DEV__ mode
    const devHost = getDevHostIP();
    if (devHost) {
      candidate = `http://${devHost}:${DEV_RELAY_PORT}`;
      console.log('[DevHostDiscovery] Using auto-discovered dev relay URL:', candidate);
    }
  }

  if (candidate === null) {
    console.log('[DevHostDiscovery] Using production relay URL:', PRODUCTION_RELAY_URL);
    candidate = PRODUCTION_RELAY_URL;
  }

  // L-24 (Chunk I follow-up, 2026-05-07 audit at master c2ec352): the
  // pre-existing G-3 prod-HTTPS guard only checked the PRODUCTION_RELAY_URL
  // fallback branch. A misconfigured EXPO_PUBLIC_PROVIAN_RELAY_URL=http://...
  // baked into a release build would have shipped over plain HTTP. Tightened
  // to fire on every non-DEV return path so the guard's intent ("never
  // return HTTP URL in production") matches its implementation.
  if (!__DEV__ && !candidate.startsWith('https://')) {
    console.error('[DevHostDiscovery] SECURITY ERROR: production relay URL must use HTTPS:', candidate);
    throw new Error('Production relay URL must use HTTPS');
  }

  return candidate;
}

/**
 * Get relay status info for display in dev UI.
 */
export function getRelayDiscoveryInfo(): {
  baseUrl: string;
  source: 'env' | 'auto-discovered' | 'production';
  devHost: string | null;
  isDev: boolean;
} {
  // @ts-ignore
  const envUrl = process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL;
  const devHost = __DEV__ ? getDevHostIP() : null;
  
  let source: 'env' | 'auto-discovered' | 'production';
  let baseUrl: string;
  
  if (envUrl) {
    source = 'env';
    baseUrl = envUrl;
  } else if (__DEV__ && devHost) {
    source = 'auto-discovered';
    baseUrl = `http://${devHost}:${DEV_RELAY_PORT}`;
  } else {
    source = 'production';
    baseUrl = PRODUCTION_RELAY_URL;
  }
  
  return {
    baseUrl,
    source,
    devHost,
    isDev: __DEV__,
  };
}
