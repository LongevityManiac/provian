import { format } from 'date-fns';

/**
 * True when `value` is a finite epoch-millisecond number that yields a valid
 * Date. Rejects NaN / Infinity / strings / objects / null — anything that would
 * make `new Date(value)` an "Invalid Date".
 */
export function isValidTimestamp(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        !Number.isNaN(new Date(value).getTime())
    );
}

/**
 * Format an epoch-millisecond timestamp with date-fns, returning `fallback`
 * instead of throwing when the value is not a valid date.
 *
 * WHY: `date-fns` `format(new Date(bad))` throws `RangeError: Invalid time
 * value`. A crafted promise QR / share deep-link can carry a non-numeric
 * `dueDate` / `timestamp` that persists to AsyncStorage and then crashes the
 * whole Promises tab on EVERY render — the root ErrorBoundary swallows the app
 * and the poisoned record survives, so relaunch re-crashes (Pass-3 #14, an
 * unrecoverable soft-lock). Routing every `format(new Date(...))` render site
 * through this guard keeps a poisoned record renderable so the user can still
 * open the list/detail and delete it. Import-time validation blocks NEW poison;
 * this recovers records already persisted before that fix.
 */
export function safeFormatDate(value: unknown, fmt: string, fallback = '—'): string {
    if (!isValidTimestamp(value)) return fallback;
    try {
        return format(new Date(value), fmt);
    } catch {
        return fallback;
    }
}
