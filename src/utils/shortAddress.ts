/**
 * Shared helpers for displaying wallet addresses / identifiers in the UI.
 *
 * `shortAddress` returns the truncated form used throughout the Commons
 * screens: first 6 chars (including the 0x prefix) + last 4 chars.
 *
 * `displayWithAddress` combines a display name with a truncated address in
 * the standard Commons format:
 *   "Display Name (0xABCD...1234)"
 */

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return '';
  if (typeof addr !== 'string') return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function displayWithAddress(
  displayName: string | null | undefined,
  addr: string | null | undefined,
): string {
  const name = (displayName ?? '').trim();
  const short = shortAddress(addr);
  if (name && short) return `${name} (${short})`;
  if (name) return name;
  if (short) return short;
  return '';
}
