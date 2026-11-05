/**
 * Catalog sync check.
 *
 * The mobile `ai-providers.json` must be byte-for-byte identical to the
 * desktop `ai-providers.json`. Drift between surfaces creates cross-surface
 * inconsistency for the same user and breaks the "identical matching rules
 * everywhere" design commitment in CAPTURE_ARCHITECTURE.md §2.
 *
 * This test is the enforcement mechanism. If it fails, update both copies
 * and re-run.
 *
 * See docs/PHASE_2C_DESIGN_NOTES.md §4.Q1 for the rationale.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ai-providers catalog sync', () => {
    it('mobile and desktop catalogs are byte-identical', () => {
        const mobilePath = resolve(__dirname, '..', 'ai-providers.json');
        const desktopPath = resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'provian-agent-sdk',
            'src',
            'observer',
            'config',
            'ai-providers.json',
        );

        const mobileBytes = readFileSync(mobilePath);
        const desktopBytes = readFileSync(desktopPath);

        expect(mobileBytes.equals(desktopBytes)).toBe(true);
    });

    it('mobile and desktop catalogs parse to structurally equal values', () => {
        const mobilePath = resolve(__dirname, '..', 'ai-providers.json');
        const desktopPath = resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'provian-agent-sdk',
            'src',
            'observer',
            'config',
            'ai-providers.json',
        );

        const mobile = JSON.parse(readFileSync(mobilePath, 'utf8'));
        const desktop = JSON.parse(readFileSync(desktopPath, 'utf8'));

        expect(mobile).toEqual(desktop);
    });
});
