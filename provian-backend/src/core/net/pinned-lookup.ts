/**
 * The ONE socket-pinning `lookup` for relay-side outbound fetches (webhooks, the Commons avatar
 * proxy, the requester-key fetch). Every SSRF guard resolves a host, validates every address,
 * then connects to the VALIDATED address only — this hook is what makes the socket go there instead
 * of re-resolving (the DNS-rebinding TOCTOU).
 *
 * Node calls an Agent's `lookup` in two shapes. Since Node 20 `net.connect` defaults to
 * `autoSelectFamily`, which calls `lookup(host, { all: true }, cb)` and expects an ARRAY of
 * `{ address, family }`; answering that call with the single-address form fails the connection with
 * "Invalid IP address: undefined" before a byte is sent (found live in every pinned fetch
 * on the Node 20 relay image was failing closed). This hook answers both shapes with the same one
 * validated address.
 */
import net from 'net';
import type { LookupFunction } from 'net';

type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void;

export function pinnedLookup(pinnedIp: string): LookupFunction {
  const family = net.isIP(pinnedIp) === 6 ? 6 : 4;
  const lookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    const all = typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
    if (all) (callback as unknown as LookupAllCallback)(null, [{ address: pinnedIp, family }]);
    else callback(null, pinnedIp, family);
  };
  return lookup as unknown as LookupFunction;
}
