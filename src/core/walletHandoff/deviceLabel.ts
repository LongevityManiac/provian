/**
 * How this device names itself to the other side of a QR handoff ("Chrome on macOS",
 * "iPhone 15 Pro"), so the sending device can show where the wallet is going before the person
 * confirms. Never more than 64 characters (the relay's limit).
 */
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import type { HandoffDevice, HandoffPlatform } from './handoffFlow';

/** "Chrome on macOS" from a browser's user agent; "Web browser" when it says nothing useful. */
export function browserLabel(userAgent: string): string {
    const ua = userAgent || '';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
        : null;
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
        : /Linux/.test(ua) ? 'Linux'
        : null;
    if (browser && os) return `${browser} on ${os}`;
    return browser ?? (os ? `Web browser on ${os}` : 'Web browser');
}

export function thisHandoffDevice(): HandoffDevice {
    const platform: HandoffPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    if (platform === 'web') {
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        return { label: browserLabel(ua), platform };
    }
    const model = (Device.modelName ?? '').trim();
    const label = model || (platform === 'ios' ? 'iPhone' : 'Android phone');
    return { label: label.slice(0, 64), platform };
}
