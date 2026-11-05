/**
 * Fact-base fixes item 3 : the never-wired external-claim extension is deleted.
 * The route-level assertions (the mobile submit read only the fields it names) went with the
 * retired `POST /v1/pe/submit/mobile` (PE meter, 2026-10-03); the tree-wide absence check stays.
 */
import fs from 'fs';
import path from 'path';

const DELETED_FIELD = ['outcome', 'anchors'].join('_');

describe('the deleted external-claim field', () => {
  it('nothing under src/ (outside this test) names the deleted field or its module', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|js)$/.test(e.name) || p === __filename) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (src.includes(DELETED_FIELD) || src.includes(['outcome', 'anchors'].join('-'))) hits.push(p);
      }
    };
    walk(path.resolve(__dirname, '..'));
    expect(hits).toEqual([]);
  });
});
