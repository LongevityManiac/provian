/**
 * The image build's geo database download (scripts/bundle-jurisdiction-data.mjs): db-ip keeps only
 * the two most recent monthly files, so the build must take this month's, or last month's when this
 * month's is not out yet, and never fail because a pinned month aged out.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

const SCRIPT = pathToFileURL(path.resolve(__dirname, '../../../scripts/bundle-jurisdiction-data.mjs')).href;

interface Probe { readonly urls?: string[]; readonly picked?: string; readonly size?: number; readonly error?: string; readonly asked: string[] }

/**
 * Runs the script's download in a child node with a stub fetch: `statuses` maps a month label to
 * the status that month's file answers; `body` is 'mmdb' (a valid-looking database) or 'junk'.
 */
function probe(nowIso: string, statuses: Record<string, number>, body: 'mmdb' | 'junk' = 'mmdb', tz = 'UTC'): Probe {
  const js = `
    const { geoDatabaseUrls, downloadGeoDatabase } = await import(${JSON.stringify(SCRIPT)});
    const { gzipSync } = await import('node:zlib');
    const now = new Date(${JSON.stringify(nowIso)});
    const statuses = ${JSON.stringify(statuses)};
    const marker = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);
    const payload = ${JSON.stringify(body)} === 'mmdb' ? Buffer.concat([Buffer.alloc(1100000, 7), marker, Buffer.alloc(64)]) : Buffer.alloc(1100000, 7);
    const asked = [];
    const fakeFetch = async (url) => {
      asked.push(url);
      const month = url.match(/lite-(\\d{4}-\\d{2})\\./)[1];
      const status = statuses[month] ?? 404;
      return new Response(status === 200 ? gzipSync(payload) : 'no', { status });
    };
    const out = { urls: geoDatabaseUrls(now), asked };
    try {
      const { url, bytes } = await downloadGeoDatabase(fakeFetch, now);
      Object.assign(out, { picked: url, size: bytes.length });
    } catch (e) { out.error = e.message; }
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', js], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Probe;
}

const url = (month: string): string => `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;

describe('geo database download', () => {
  it('asks for this UTC month, then last month, across a year boundary', () => {
    expect(probe('2026-11-28T12:00:00Z', {}).urls).toEqual([url('2026-11'), url('2026-10')]);
    expect(probe('2027-01-01T00:30:00Z', {}).urls).toEqual([url('2027-01'), url('2026-12')]);
    // The month is UTC's, whatever the build machine's zone: already December in Auckland, still
    // November in UTC; already December in UTC, still November 30 in Honolulu.
    expect(probe('2026-11-30T20:00:00Z', {}, 'mmdb', 'Pacific/Auckland').urls).toEqual([url('2026-11'), url('2026-10')]);
    expect(probe('2026-12-01T03:00:00Z', {}, 'mmdb', 'Pacific/Honolulu').urls).toEqual([url('2026-12'), url('2026-11')]);
  });

  it('takes this month when it is out, without asking for last month', () => {
    const p = probe('2026-11-28T12:00:00Z', { '2026-11': 200, '2026-10': 200 });
    expect(p).toMatchObject({ picked: url('2026-11'), asked: [url('2026-11')] });
    expect(p.size).toBeGreaterThan(1000000);
  });

  it('falls back to last month when this month is not out yet (404)', () => {
    expect(probe('2026-12-01T00:30:00Z', { '2026-11': 200 })).toMatchObject({
      picked: url('2026-11'), asked: [url('2026-12'), url('2026-11')],
    });
  });

  it('any other failure stops the build rather than quietly taking an older month', () => {
    expect(probe('2026-11-28T12:00:00Z', { '2026-11': 503, '2026-10': 200 })).toMatchObject({
      error: 'geo_download_503', asked: [url('2026-11')],
    });
  });

  it('stops the build when neither month is served, or the file is not a MaxMind database', () => {
    expect(probe('2026-11-28T12:00:00Z', {})).toMatchObject({ error: 'geo_download_no_recent_month' });
    expect(probe('2026-11-28T12:00:00Z', { '2026-11': 200 }, 'junk')).toMatchObject({ error: 'geo_database_not_mmdb' });
  });
});
