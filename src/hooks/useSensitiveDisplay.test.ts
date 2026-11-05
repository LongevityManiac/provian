/**
 * A sensitive value (recovery phrase, private key) that was only shown never touches the clipboard;
 * one that was copied is wiped when it is hidden, when the screen loses focus, and on unmount.
 *
 * On iOS every clipboard read shows the system "would like to paste" prompt, so hiding a phrase the
 * person never copied must not read the clipboard. The hook runs here for real, under a minimal React
 * harness (refs, state setters, effects and the focus effect, run once, cleanups captured).
 * RED controls: wiping on the shown value reads the clipboard after a show-only hide; dropping a
 * wipe leaves a copied phrase on the clipboard. Each case below fails one of those.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({
    text: '',
    reads: 0,
    getStringAsync: async (): Promise<string> => { clipboard.reads += 1; return clipboard.text; },
    setStringAsync: async (v: string): Promise<boolean> => { clipboard.text = v; return true; },
}));
const harness = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, focusCleanup: null as null | (() => void) }));

vi.mock('expo-clipboard', () => ({ getStringAsync: () => clipboard.getStringAsync(), setStringAsync: (v: string) => clipboard.setStringAsync(v) }));
vi.mock('expo-screen-capture', () => ({ preventScreenCaptureAsync: async () => undefined, allowScreenCaptureAsync: async () => undefined }));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (fn: () => (() => void) | void) => { const c = fn(); if (typeof c === 'function') harness.focusCleanup = c; },
}));
vi.mock('react', () => ({
    useRef: <T,>(v: T) => ({ current: v }),
    useState: <T,>(v: T) => [v, () => undefined],
    useCallback: <T,>(fn: T) => fn,
    useEffect: (fn: () => (() => void) | void) => { const c = fn(); if (typeof c === 'function') harness.cleanups.push(c); },
}));

import { useSensitiveDisplay } from './useSensitiveDisplay';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the clipboard is read only to wipe what was copied', () => {
    beforeEach(() => {
        clipboard.text = 'something the person copied elsewhere';
        clipboard.reads = 0;
        harness.cleanups = [];
        harness.focusCleanup = null;
    });

    it('show, then hide: the clipboard is never read (no paste prompt) and keeps what it had', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        await h.hide();
        expect(clipboard.reads).toBe(0);
        expect(clipboard.text).toBe('something the person copied elsewhere');
    });

    it('show, then leave the screen or unmount: the clipboard is never read', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        harness.focusCleanup?.();
        for (const c of harness.cleanups) c();
        await flush();
        expect(clipboard.reads).toBe(0);
    });

    it('copy, then hide: the copied phrase is wiped', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        expect(await h.copyToClipboard()).toBe(true);
        await h.hide();
        expect(clipboard.text).toBe('');
    });

    it('copy, then leave the screen: the copied phrase is wiped, and unmount does not read again', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        await h.copyToClipboard();
        harness.focusCleanup?.();
        await flush();
        expect(clipboard.text).toBe('');
        const reads = clipboard.reads;
        for (const c of harness.cleanups) c();
        await flush();
        expect(clipboard.reads).toBe(reads);
    });

    it('copy, then unmount: the copied phrase is wiped', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        await h.copyToClipboard();
        for (const c of harness.cleanups) c();
        await flush();
        expect(clipboard.text).toBe('');
    });

    it('copy, then the person copies something else: hiding leaves their new clipboard alone', async () => {
        const h = useSensitiveDisplay({ ttlSeconds: 0, clipboardClearMs: 0 });
        h.reveal('abandon ability able');
        await h.copyToClipboard();
        clipboard.text = 'a later copy';
        await h.hide();
        expect(clipboard.text).toBe('a later copy');
    });
});
