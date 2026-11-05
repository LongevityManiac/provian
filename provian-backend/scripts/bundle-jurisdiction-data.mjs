// Build-time download only. Runtime country lookups never leave the relay.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const url = 'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz';
const res = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
if (!res.ok) throw new Error(`geo_download_${res.status}`);
const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
if (bytes.length < 1000000) throw new Error('geo_database_empty');
mkdirSync('data/jurisdiction', { recursive: true });
writeFileSync('data/jurisdiction/city.mmdb', bytes);
writeFileSync('data/jurisdiction/geo-metadata.json', JSON.stringify({source:url,sha256:createHash('sha256').update(bytes).digest('hex')}));
