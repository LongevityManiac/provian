/**
 * The ONE Monday-00:00-UTC week boundary.
 *
 * Three copies of this arithmetic used to exist (`pvt-accrual.ts`, a private
 * twin in `durable-accrual-effects.ts`, and an inline block in the economic
 * projection). A weekly counter written by one copy and read by another agrees
 * only while the copies agree, and nothing checked that they did. This module
 * is the single source; the others import it. `pvt-accrual.ts` re-exports it so
 * existing importers keep their path.
 */
export function getWeekStart(timestamp: number): number {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - diff);
  return date.getTime();
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
