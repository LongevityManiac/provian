/** Offline IP observation. No caller-supplied location or country headers are used. */
import fs from 'fs';
import path from 'path';
import { Reader, type CityResponse } from 'maxmind';
import { isPrivateIp } from '../net/private-ip';
export interface CountryObservation {
  readonly country: string | null;
  readonly region: string | null;
  readonly database: string;
}
let reader: Reader<CityResponse> | null = null;
let databaseLabel: string | null = null;

/**
 * Names the bundled database's monthly release from the file's own build date, so the label always
 * matches the file the image bundled (the build takes the newest month db-ip still serves).
 */
export function geoDatabaseLabel(buildEpoch: Date): string {
  return Number.isFinite(buildEpoch.getTime())
    ? `dbip-city-lite-${buildEpoch.toISOString().slice(0, 7)}`
    : 'dbip-city-lite-unknown';
}

function bundledDatabase(): { readonly reader: Reader<CityResponse>; readonly database: string } {
  reader ??= new Reader<CityResponse>(fs.readFileSync(path.resolve(__dirname, '../../../data/jurisdiction/city.mmdb')));
  databaseLabel ??= geoDatabaseLabel(reader.metadata.buildEpoch);
  return { reader, database: databaseLabel };
}
/**
 * The occupied Ukrainian regions under US embargo — Crimea and Sevastopol, Donetsk,
 * and Luhansk — matched by the tokens that name each region, not an exact string.
 * DB-IP City Lite carries no subdivision ISO code and reports these regions under
 * either RU or UA with inconsistent names ("Crimea", "Sebastopol City", "Donetsk",
 * "Luhansk", and Oblast / Republic / People's-Republic variants). A name-token match
 * keeps every spelling — those in the current database and any a later one introduces —
 * resolving to the blocked UA code, so a renamed subdivision can never reopen minting
 * there. Kherson and Zaporizhzhia are deliberately absent: the embargo does not reach
 * them, so they resolve to an ordinary UA region and mint.
 */
export function occupiedUaRegion(name: string): string | null {
  const token = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!token) return null;
  if (token.includes('crimea') || token.includes('krym')) return 'UA-43';
  if (token.includes('sevastopol') || token.includes('sebastopol')) return 'UA-40';
  if (token.includes('donets')) return 'UA-14';
  if (token.includes('luhans') || token.includes('lugansk')) return 'UA-09';
  return null;
}
export function countryFromIp(ip: string | undefined): CountryObservation {
  let bundled: ReturnType<typeof bundledDatabase>;
  try {
    bundled = bundledDatabase();
  } catch {
    return { country: null, region: null, database: 'dbip-city-lite-unavailable' };
  }
  const { database } = bundled;
  const unknown = { country: null, region: null, database };
  const address = ip?.replace(/^::ffff:/i, '');
  if (!address || isPrivateIp(address)) return unknown;
  try {
    const result = bundled.reader.get(address);
    const country = result?.country?.iso_code;
    const subdivision = result?.subdivisions?.[0];
    const name = subdivision?.names?.en ?? '';
    const code = subdivision?.iso_code;
    const region = occupiedUaRegion(name) ?? (country && (code || name) ? `${country}-${code || name}` : null);
    return country && /^[A-Z]{2}$/.test(country)
      ? { country: region?.startsWith('UA-') ? 'UA' : country, region, database }
      : unknown;
  } catch { return unknown; }
}
