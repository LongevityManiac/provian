import i18next from 'i18next';

/** Resolve display copy at call time, with a usable fallback before app startup. */
export function translate(
    key: string,
    fallback: string,
    values: Record<string, string | number | undefined> = {},
): string {
    return i18next.isInitialized
        ? i18next.t(key, { defaultValue: fallback, ...values })
        : fallback;
}
