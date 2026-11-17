import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promiseListBody } from './promiseListBody';

describe('promise list: what shows where the rows go', () => {
    it('before the first read answers it is loading, never "no promises"', () => {
        expect(promiseListBody('loading', 0)).toBe('loading');
    });
    it('a failed read is an error, never "no promises"', () => {
        expect(promiseListBody('failed', 0)).toBe('failed');
    });
    it('"no promises" only for a read that returned none', () => {
        expect(promiseListBody('loaded', 0)).toBe('empty');
    });
    it('rows show whenever there are rows', () => {
        for (const load of ['loading', 'loaded', 'failed'] as const) expect(promiseListBody(load, 2)).toBe('rows');
    });

    it('the screen decides its empty area through promiseListBody and starts in loading', () => {
        const src = readFileSync(resolve(__dirname, 'PromiseListScreen.tsx'), 'utf8');
        expect(src).toMatch(/useState<PromiseListLoad>\('loading'\)/);
        const start = src.indexOf('const renderEmpty = ');
        expect(start).toBeGreaterThanOrEqual(0);
        const body = src.slice(start, src.indexOf("t('promise.noActivePromises')", start));
        expect(body).toMatch(/const body = promiseListBody\(loadState, promises\.length\);/);
        expect(body).toMatch(/if \(body === 'loading'\) \{\s*return \(/);
        expect(body).toMatch(/if \(body === 'failed'\) \{\s*return \(/);
        // A successful read is what marks the list loaded.
        expect(src).toMatch(/setPromises\(data\);\s*\n\s*setLoadState\('loaded'\);/);
    });
});
