/**
 * Pinned authority for the signed daemon release channel. ONE key, compiled in, never fetched or
 * overridable by environment. rotated it: the previous key
 * (29ade696…, Secret Manager `harness-catalog-signing-key`) was exposed and is no longer trusted for
 * anything; its private half signs nothing after the one transition release that carried this key.
 * The private half of this key lives only in Secret Manager `release-signing-key`.
 */
export const RELEASE_PUBLIC_KEY = '2c7555655c152d8c328b1647a0b06d38a26dd32e48b91fb0e0354d563e7805ce';
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
