/**
 * ProvianPinnedTLS — JS interface for the native pinned-DNS TLS module.
 *
 * Connects to a PRE-VALIDATED IP while TLS validates the HOSTNAME certificate,
 * so DNS rebinding cannot redirect the socket after the SSRF check (review #33).
 *
 * App code does not import this directly — `securePinnedFetch.ts` loads the
 * module via `requireOptionalNativeModule('ProvianPinnedTLS')` so it degrades
 * cleanly (JS fallback) when the native module isn't in the build (Expo Go).
 * This file exists for type clarity and direct use if ever needed.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface PinnedFetchRequest {
    /** Original hostname URL (e.g. https://api.merchant.test/charge). */
    url: string;
    /** Pre-validated public IP to connect to. */
    pinnedIp: string;
    /** Hostname used for TLS SNI + certificate validation. */
    hostname: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    followRedirects: boolean;
    /** WS4: hard cap on response bytes the native side may buffer (OOM defense). */
    maxBytes?: number;
    /** WS4: request timeout (ms) the native side honors. */
    timeoutMs?: number;
}

export interface PinnedFetchResult {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface ProvianPinnedTLSModule {
    fetch(request: PinnedFetchRequest): Promise<PinnedFetchResult>;
}

export default requireOptionalNativeModule<ProvianPinnedTLSModule>('ProvianPinnedTLS');
