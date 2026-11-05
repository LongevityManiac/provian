/**
 * useAfterClose — run something only once a closing RN Modal is really gone.
 *
 * iOS cannot present a second Modal (or keep a Modal above a pushed screen) while one is still
 * animating out, so "close this sheet, then open that one / navigate" must wait for the Modal's
 * `onDismiss`. Android hides synchronously and has no onDismiss, so the queued action runs on the
 * next tick there. A timer backstops a missed onDismiss; the queued action runs at most once.
 */
import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

export function useAfterClose() {
  const queued = useRef<(() => void) | null>(null);

  const flush = useCallback(() => {
    const fn = queued.current;
    queued.current = null;
    fn?.();
  }, []);

  /** Queue `fn` to run after the Modal that is closing right now has been dismissed. */
  const afterClose = useCallback((fn: () => void) => {
    queued.current = fn;
    setTimeout(flush, Platform.OS === 'ios' ? 450 : 0);
  }, [flush]);

  /** Pass as the closing Modal's `onDismiss`. */
  return { afterClose, onDismiss: flush };
}
