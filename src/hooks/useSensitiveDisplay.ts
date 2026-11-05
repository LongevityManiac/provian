/**
 * useSensitiveDisplay - React hook for short-lived secret display.
 *
 * Phase 2.12 - Theme 12 fix. The mnemonic / private-key export screens
 * showed sensitive material indefinitely, copied it to a clipboard that
 * was never cleared, and let the OS take screenshots while the secret
 * was on screen. This hook centralises the safe-display lifecycle so
 * every secret-display screen behaves the same way:
 *
 *   1. Screen capture is blocked while the value is mounted.
 *   2. The value auto-hides after `ttlSeconds` (defaults to 60s).
 *   3. Copying to the clipboard schedules a clipboard wipe `clipboardClearMs`
 *      after the copy. Hiding the value or unmounting the screen also
 *      clears the clipboard immediately if it still contains our secret.
 *   4. Navigating away from the screen (blur) wipes the in-memory secret
 *      and the clipboard. Re-revealing requires re-authentication on the
 *      caller's side.
 *
 * Strings cannot be wiped from memory in JS (the V8 string interner
 * keeps a reference until GC), so for the most sensitive paths the
 * caller should also drop the React state holding the secret as soon as
 * the user has finished reading it. This hook does that automatically
 * on the ttl timer + on blur.
 *
 * The clipboard wipe only fires if the clipboard still matches what we
 * copied - if the user pasted into another app and that app overwrote
 * the clipboard with something else, we don't stomp on it.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';

interface UseSensitiveDisplayOptions {
  /** Initial value to display. Pass null to start hidden. */
  initialValue?: string | null;
  /** Auto-hide after this many seconds (default 60). 0 = never. */
  ttlSeconds?: number;
  /** Wipe clipboard this many ms after a copy (default 60000). */
  clipboardClearMs?: number;
}

interface UseSensitiveDisplayResult {
  /** The currently displayed value, or null if hidden. */
  value: string | null;
  /** Reveal a new value. Resets the ttl timer. */
  reveal: (newValue: string) => void;
  /** Hide the value immediately and wipe the clipboard if applicable. */
  hide: () => Promise<void>;
  /** Copy the value to clipboard with auto-clear scheduled. */
  copyToClipboard: () => Promise<boolean>;
  /** Whether the value was recently copied (resets when clipboard clears). */
  copied: boolean;
}

export function useSensitiveDisplay(
  options: UseSensitiveDisplayOptions = {},
): UseSensitiveDisplayResult {
  const ttlSeconds = options.ttlSeconds ?? 60;
  const clipboardClearMs = options.clipboardClearMs ?? 60_000;

  const [value, setValue] = useState<string | null>(options.initialValue ?? null);
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<string | null>(value);
  // What this hook last put on the clipboard. Only that is ever wiped, and the clipboard is read
  // only when there is something to wipe: on iOS every read shows the system paste prompt.
  const copiedRef = useRef<string | null>(null);
  const ttlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep ref in sync so async callbacks see the latest value
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Block screen capture / screenshots while a value is on screen.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      ScreenCapture.preventScreenCaptureAsync().catch(() => {/* ignore */});

      return () => {
        mounted = false;
        ScreenCapture.allowScreenCaptureAsync().catch(() => {/* ignore */});
        // On blur: wipe value, clipboard, and timers.
        clearTimeoutSafe(ttlTimerRef);
        clearTimeoutSafe(clipboardTimerRef);
        const wasCopied = takeCopied(copiedRef);
        valueRef.current = null;
        setValue(null);
        setCopied(false);
        if (wasCopied) {
          clearClipboardIfMatches(wasCopied).catch(() => {/* ignore */});
        }
      };
    }, []),
  );

  // Final cleanup on unmount (covers cases where useFocusEffect doesn't fire)
  useEffect(() => {
    return () => {
      clearTimeoutSafe(ttlTimerRef);
      clearTimeoutSafe(clipboardTimerRef);
      const wasCopied = takeCopied(copiedRef);
      valueRef.current = null;
      if (wasCopied) {
        clearClipboardIfMatches(wasCopied).catch(() => {/* ignore */});
      }
    };
  }, []);

  const hide = useCallback(async () => {
    clearTimeoutSafe(ttlTimerRef);
    clearTimeoutSafe(clipboardTimerRef);
    const wasCopied = takeCopied(copiedRef);
    valueRef.current = null;
    setValue(null);
    setCopied(false);
    if (wasCopied) {
      await clearClipboardIfMatches(wasCopied).catch(() => {/* ignore */});
    }
  }, []);

  const reveal = useCallback((newValue: string) => {
    clearTimeoutSafe(ttlTimerRef);
    valueRef.current = newValue;
    setValue(newValue);
    setCopied(false);

    if (ttlSeconds > 0) {
      ttlTimerRef.current = setTimeout(() => {
        // Hide and wipe clipboard if applicable
        hide().catch(() => {/* ignore */});
      }, ttlSeconds * 1000);
    }
  }, [ttlSeconds, hide]);

  const copyToClipboard = useCallback(async (): Promise<boolean> => {
    if (!valueRef.current) return false;
    const snapshot = valueRef.current;
    try {
      await Clipboard.setStringAsync(snapshot);
    } catch {
      return false;
    }
    copiedRef.current = snapshot;
    setCopied(true);

    clearTimeoutSafe(clipboardTimerRef);
    if (clipboardClearMs > 0) {
      clipboardTimerRef.current = setTimeout(() => {
        if (copiedRef.current === snapshot) copiedRef.current = null;
        clearClipboardIfMatches(snapshot).catch(() => {/* ignore */});
        setCopied(false);
        clipboardTimerRef.current = null;
      }, clipboardClearMs);
    }
    return true;
  }, [clipboardClearMs]);

  return { value, reveal, hide, copyToClipboard, copied };
}

/** The value this hook copied, if any, clearing the record of it. */
export function takeCopied(ref: { current: string | null }): string | null {
  const copied = ref.current;
  ref.current = null;
  return copied;
}

function clearTimeoutSafe(ref: { current: ReturnType<typeof setTimeout> | null }): void {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * Read the clipboard and only wipe it if the contents still match the
 * value we copied. Avoids stomping on whatever the user has now selected.
 */
async function clearClipboardIfMatches(expected: string): Promise<void> {
  try {
    const current = await Clipboard.getStringAsync();
    if (current === expected) {
      await Clipboard.setStringAsync('');
    }
  } catch {
    // Ignore - best-effort cleanup
  }
}
