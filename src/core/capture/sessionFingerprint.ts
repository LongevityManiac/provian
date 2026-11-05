/**
 * Session fingerprint hash for `ai_conversation` PEs.
 *
 * Recipe (PHASE_2B_DESIGN_NOTES.md §5, locked at 2b sign-off):
 *
 *   SHA-256(
 *     LEN32(provider)         || utf8(provider)
 *     LEN32(sessionStartMs)   || utf8(decimal(sessionStartMs))
 *     LEN32(durationMs)       || utf8(decimal(durationMs))
 *     LEN32(turnCount)        || utf8(decimal(turnCount))
 *     LEN32(pluginName)       || utf8(pluginName)
 *   )
 *
 * Each numeric field is serialized as its decimal string (no leading zeros,
 * no separators). Each UTF-8 byte chunk is prefixed with a 4-byte big-endian
 * length so field boundaries cannot alias.
 *
 * `pluginName` is the surface tag; it keeps fingerprints from a desktop
 * session and a mobile session for the same user on the same provider from
 * colliding by construction. Desktop uses `"llm_session_plugin"`, mobile
 * WebView uses `"mobile_webview"`, Android UsageStats (M7) uses
 * `"mobile_usage_stats"`.
 *
 * Byte-identical inputs produce identical hashes. The mobile and desktop
 * implementations must encode the same way; this module mirrors the byte
 * layout of
 * `provian-agent-sdk/src/observer/plugins/llm-session/LLMSessionPlugin.ts`
 * `computeSessionFingerprint`. A direct cross-surface determinism test
 * lives in `__tests__/sessionFingerprint.test.ts`.
 */

import { sha256 } from '@noble/hashes/sha2';

/**
 * Plugin-name tag for mobile WebView fingerprints. Distinct from the
 * desktop `llm_session_plugin` and the future Android UsageStats
 * `mobile_usage_stats`. Changing this value silently rebases the
 * dedup space for every mobile wallet.
 */
export const MOBILE_WEBVIEW_PLUGIN_NAME = 'mobile_webview';

export interface FingerprintInput {
    provider: string;
    sessionStartMs: number;
    durationMs: number;
    turnCount: number;
    pluginName: string;
}

const UTF8_ENCODER = new TextEncoder();

/**
 * Deterministic SHA-256 fingerprint over the five length-prefixed fields.
 * Synchronous. Returns a lowercase hex string (64 characters).
 */
export function computeSessionFingerprint(input: FingerprintInput): string {
    const parts: string[] = [
        input.provider,
        String(Math.trunc(input.sessionStartMs)),
        String(Math.trunc(input.durationMs)),
        String(Math.trunc(input.turnCount)),
        input.pluginName,
    ];

    const buffers: Uint8Array[] = [];
    let totalLen = 0;
    for (const p of parts) {
        const utf8 = UTF8_ENCODER.encode(p);
        const prefix = new Uint8Array(4);
        const len = utf8.length;
        prefix[0] = (len >>> 24) & 0xff;
        prefix[1] = (len >>> 16) & 0xff;
        prefix[2] = (len >>> 8) & 0xff;
        prefix[3] = len & 0xff;
        buffers.push(prefix);
        buffers.push(utf8);
        totalLen += 4 + utf8.length;
    }

    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const b of buffers) {
        combined.set(b, offset);
        offset += b.length;
    }

    return toHex(sha256(combined));
}

function toHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
}
