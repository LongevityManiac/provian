/**
 * — every Archive route the router mounts is documented in openapi.json, and nothing
 * is documented that is not mounted (the scheduler sweep is internal and undocumented). RED: a
 * documented path list missing one mounted route is reported by name.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ARCHIVE_OPENAPI_PATHS } from './archive-openapi';

function mountedArchivePaths(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/router\.(get|post)\(\s*[`']([^`']+)[`']/g)) out.add(m[2]);
  // The on/off pairs are mounted from a template: `/v1/archive/${on ? 'on' : 'off'}`.
  for (const m of source.matchAll(/router\.post\(`(\/v1\/archive(?:\/mobile)?)\/\$\{on \? 'on' : 'off'\}`/g)) {
    out.delete(`${m[1]}/\${on ? 'on' : 'off'}`);
    out.add(`${m[1]}/on`);
    out.add(`${m[1]}/off`);
  }
  return [...out]
    .filter((p) => !p.includes('${'))
    .filter((p) => !p.startsWith('/v1/internal/'))
    .map((p) => p.replace(/:([a-z_]+)/g, '{$1}'))
    .sort();
}

function missing(mounted: readonly string[], documented: readonly string[]): string[] {
  return mounted.filter((p) => !documented.includes(p));
}

describe('Archive routes ↔ openapi', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'archive.ts'), 'utf8');
  const mounted = mountedArchivePaths(source);
  const documented = Object.keys(ARCHIVE_OPENAPI_PATHS).sort();

  it('GREEN: mounted and documented are the same set (and not empty)', () => {
    expect(mounted.length).toBeGreaterThanOrEqual(18);
    expect(mounted).toEqual(documented);
  });

  it('RED: a documented set missing a mounted route reports it by name', () => {
    expect(missing(mounted, documented.filter((p) => p !== '/v1/archive/device/parts'))).toEqual(['/v1/archive/device/parts']);
  });
});
