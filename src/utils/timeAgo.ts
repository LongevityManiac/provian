/**
 * Locale-aware short relative time for Commons lists ("Just now", "5m ago", "3h ago", "2d ago",
 * "4w ago", then a date). Strings come from i18n so every locale reads naturally.
 */
type Translate = (key: string, options?: Record<string, unknown>) => string;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function timeAgo(timestamp: number, t: Translate, now: number = Date.now()): string {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Math.max(0, now - ts);
  if (diff < MIN) return t('commons.justNow');
  if (diff < HOUR) return t('commonsHome.minutesAgo', { count: Math.floor(diff / MIN) });
  if (diff < DAY) return t('commons.hoursAgo', { count: Math.floor(diff / HOUR) });
  if (diff < WEEK) return t('commons.daysAgo', { count: Math.floor(diff / DAY) });
  if (diff < 8 * WEEK) return t('commonsHome.weeksAgo', { count: Math.floor(diff / WEEK) });
  return new Date(ts).toLocaleDateString();
}
