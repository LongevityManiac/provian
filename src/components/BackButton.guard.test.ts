import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * One back button (src/components/BackButton.tsx). A screen that draws its own
 * `arrow-back` icon re-introduces the inconsistency the 2026-09-22 sweep removed
 * (circled 36/40/44pt, square, bare). WarningScreen's labelled "Go Back" pill is
 * a different control and is the one allowed exception.
 */
const ALLOWED = new Set(['src/components/BackButton.tsx', 'src/components/WarningScreen.tsx']);
const ARROW = /name=["']arrow-back["']/;

export function findHandDrawnBackArrows(files: ReadonlyArray<{ path: string; source: string }>): string[] {
    return files.filter((f) => !ALLOWED.has(f.path) && ARROW.test(f.source)).map((f) => f.path);
}

function tsxFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : tsxFiles(p);
        return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [p] : [];
    });
}

describe('back-button consistency guard', () => {
    const root = path.resolve(__dirname, '../..');
    const files = tsxFiles(path.join(root, 'src')).map((p) => ({
        path: path.relative(root, p).split(path.sep).join('/'),
        source: fs.readFileSync(p, 'utf8'),
    }));

    it('scans a real corpus (not an empty population)', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files.some((f) => f.path === 'src/components/BackButton.tsx')).toBe(true);
    });

    it('no screen draws its own arrow-back — use <BackButton />', () => {
        expect(findHandDrawnBackArrows(files)).toEqual([]);
    });

    it('RED control: a planted hand-drawn arrow is reported', () => {
        const planted = { path: 'src/screens/Fake.tsx', source: '<Ionicons name="arrow-back" size={24} />' };
        expect(findHandDrawnBackArrows([...files, planted])).toEqual(['src/screens/Fake.tsx']);
    });
});
