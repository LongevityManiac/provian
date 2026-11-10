export interface MembershipPosition { readonly block: number; readonly logIndex: number; readonly timestamp: number; }
export function utcCalendarMonth(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('recourse_timestamp_invalid');
  const date = new Date(timestamp * 1000);
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
  if (!Number.isSafeInteger(month)) throw new Error('recourse_timestamp_invalid');
  return month;
}
