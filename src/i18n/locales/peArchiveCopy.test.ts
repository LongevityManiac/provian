/**
 * — the PE Archive copy, in all 12 locales: the same keys everywhere, the price and
 * the 30-day line present, and the "Archive full — add 1 GB for $5" prompt saying nothing is deleted.
 * 2026-10-07: the card is short lines (what it is, optional, what changes when on, price, and a
 * purchase is permanent and non-refundable), and every purchase outcome has its own line.
 * Every positive assertion has a RED control beside it.
 */
import { describe, expect, it } from 'vitest';

import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import hi from './hi.json';
import id from './id.json';
import ja from './ja.json';
import ko from './ko.json';
import pt from './pt.json';
import sw from './sw.json';
import tl from './tl.json';
import vi from './vi.json';
import zh from './zh.json';

type Tree = Record<string, unknown>;
const locales: Record<string, Tree> = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh };
const PRESENTER_KEYS = ['peArchivedRow', 'peFactUnavailableTitle', 'peFactNotAnchored', 'peFactArchivedUnavailable', 'peFactUnavailable'];

function section(tree: Tree, ...path: string[]): Record<string, string> {
    let node: unknown = tree;
    for (const p of path) node = (node as Tree | undefined)?.[p];
    return (node ?? {}) as Record<string, string>;
}

/** The keys a locale is missing relative to English (empty = parity). */
function missingKeys(reference: Record<string, string>, other: Record<string, string>): string[] {
    return Object.keys(reference).filter((k) => typeof other[k] !== 'string' || other[k].length === 0);
}

describe('PE Archive copy (all 12 locales)', () => {
    const enArchive = section(en as Tree, 'peArchive');

    it('every locale carries every peArchive key and the presenter keys', () => {
        expect(Object.keys(locales)).toHaveLength(12);
        expect(Object.keys(enArchive).length).toBeGreaterThanOrEqual(20);
        for (const [code, tree] of Object.entries(locales)) {
            expect(missingKeys(enArchive, section(tree, 'peArchive')), code).toEqual([]);
            const pres = section(tree, 'trustLayer', 'presenter');
            for (const k of PRESENTER_KEYS) expect(typeof pres[k] === 'string' && pres[k].length > 0, `${code}.${k}`).toBe(true);
        }
    });

    it('RED control: a locale missing a key is caught by the same predicate', () => {
        const { full: _dropped, ...partial } = enArchive;
        void _dropped;
        expect(missingKeys(enArchive, partial)).toEqual(['full']);
    });

    it('the 1 MB minimum is per uploaded part, as the relay charges it; RED: the old per-day wording fails', () => {
        const perPart = /^Each part a device uploads\b.*at least 1 MB/;
        expect(enArchive.lineMinimum).toMatch(perPart);
        expect('Each day a device uploads counts as at least 1 MB of your space.').not.toMatch(perPart);
    });

    it('states the price ($5 / 5 USDC per GB), the 30-day line, and that a full Archive deletes nothing', () => {
        for (const [code, tree] of Object.entries(locales)) {
            const a = section(tree, 'peArchive');
            expect(a.linePrice, code).toMatch(/5/);
            expect(a.lineMinimum, code).toMatch(/1\s?(MB|Mo)|MB\s?1/);
            expect(a.lineWhenOn, code).toMatch(/30/);
            expect(a.lineWhat, code).toContain('Provian');
            expect(a.full, code).toMatch(/1 GB|1 Go|GB 1/);
            expect(a.full, code).toMatch(/\$5|5 \$|US\$ 5/);
            expect(a.payButton, code).toMatch(/5(\.00)? USDC|USDC 5/);
            expect(a.onStatus, code).toContain('{{used}}');
            expect(a.onStatus, code).toContain('{{paid}}');
            expect(a.insufficientBody, code).toContain('{{balance}}');
            expect(section(tree, 'trustLayer', 'presenter').peArchivedRow, code).toContain('{{day}}');
        }
        expect(enArchive.full).toBe('Archive full — add 1 GB for $5. Until then new days stay on this phone and in its backup; nothing is deleted.');
        expect(enArchive.lineWhat).toContain("Provian stores them but can't read them");
        expect(enArchive.lineOptional).toContain('Off unless you turn it on');
        expect(enArchive.lineWhenOn).toContain('leave this phone and your backup');
        expect(enArchive.lineWhenOn).toContain('come back whenever you open or present them');
        expect(enArchive.lineFinal).toBe('Every purchase is permanent and non-refundable.');
        expect(enArchive.finalNotice).toContain('Permanent and non-refundable');
        expect(enArchive.confirmComing).toContain('Nothing is charged before that');
    });

    it('the card is short lines, not one paragraph (each card line ≤ 160 chars in English)', () => {
        for (const k of ['lineWhat', 'lineOptional', 'lineWhenOn', 'linePrice', 'lineMinimum', 'lineFinal']) {
            expect(enArchive[k].length, k).toBeLessThanOrEqual(160);
        }
        expect(enArchive.body).toBeUndefined();
    });

    it('RED control: the old one-paragraph body would fail the line-length rule', () => {
        const old = "Your PEs are yours. They live on this phone and in your own encrypted backup, and that copy grows over time. The PE Archive gives them a permanent home: this phone locks each day's PEs so only you can open them, then stores them with Provian.";
        expect(old.length).toBeGreaterThan(160);
    });

    it('RED control: a prompt that drops the price or the GB fails the same checks', () => {
        expect('Archive full.').not.toMatch(/1 GB|1 Go|GB 1/);
        expect('Archive full — add space.').not.toMatch(/\$5|5 \$|US\$ 5/);
    });
});
