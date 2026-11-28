// Build-time download only. Runtime country lookups never leave the relay.
//
// db-ip publishes the free database once a month and keeps only the two most recent months, so a
// pinned month stops downloading about two months later. The build takes this month's file, or
// last month's when this month's is not out yet (404). Any other failure stops the build.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DOWNLOAD_TIMEOUT_MS = 180_000;
/** A download that stalls past this fails the build instead of holding it open. */
const BUILD_STEP_LIMIT_MS = 300_000;
const MMDB_METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);

/** This UTC month's file first, then last month's. */
export function geoDatabaseUrls(now = new Date()) {
  return [0, 1].map((back) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const label = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
    return `https://download.db-ip.com/free/dbip-city-lite-${label}.mmdb.gz`;
  });
}

/** Downloads the newest available month and checks it is a MaxMind-format database. */
export async function downloadGeoDatabase(fetchImpl = fetch, now = new Date()) {
  for (const url of geoDatabaseUrls(now)) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`geo_download_${res.status}`);
    const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
    if (bytes.length < 1000000) throw new Error('geo_database_empty');
    if (bytes.lastIndexOf(MMDB_METADATA_MARKER) === -1) throw new Error('geo_database_not_mmdb');
    return { url, bytes };
  }
  throw new Error('geo_download_no_recent_month');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setTimeout(() => {
    console.error('geo_download_stalled');
    process.exit(1);
  }, BUILD_STEP_LIMIT_MS).unref();
  const { url, bytes } = await downloadGeoDatabase();
  mkdirSync('data/jurisdiction', { recursive: true });
  writeFileSync('data/jurisdiction/city.mmdb', bytes);
  writeFileSync('data/jurisdiction/geo-metadata.json', JSON.stringify({ source: url, sha256: createHash('sha256').update(bytes).digest('hex') }));
  console.log(`geo database: ${url}`);
}
