/**
 * finding #2 — a create entry must be reachable when the active list is
 * non-empty.
 *
 * PromiseListScreen's only "create promise" entry used to live inside
 * renderEmpty (rendered only when the active list is empty), so once a wallet
 * held any active promise there was no way to create another. A wallet holds
 * many promises, so the create affordance must live in the PERSISTENT header,
 * which renders regardless of list state.
 *
 * The Vitest harness has no React renderer wired up, so this pins the fix at the
 * source level by isolating the persistent header region (between the Header and
 * Tabs JSX markers) and asserting the create navigation lives there — NOT only
 * inside renderEmpty (same strategy as PromiseSettlementGating.source.test.ts).
 *
 * RED control: delete the persistent button (leaving the
 * create entry only inside renderEmpty) and the "header carries the create
 * navigation" case goes red. Observed red on 2026-09-11, then restored.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIST = readFileSync(resolve(__dirname, 'PromiseListScreen.tsx'), 'utf8');
const CREATE_NAV = "navigation.navigate('CreatePromise')";

/** The persistent header region: rendered on every list state. */
function headerRegion(src: string): string {
    const start = src.indexOf('{/* Header */}');
    const end = src.indexOf('{/* Tabs */}');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

/** The renderEmpty body: rendered ONLY when the active list is empty. */
function renderEmptyBody(src: string): string {
    const start = src.indexOf('const renderEmpty =');
    const end = src.indexOf('const TabButton =');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('PromiseListScreen — persistent create affordance (#2)', () => {
    it('the persistent header carries a CreatePromise navigation (reachable with a non-empty list)', () => {
        expect(headerRegion(LIST)).toContain(CREATE_NAV);
    });

    it('keeps the Scan entry in the header (did not replace it with create)', () => {
        expect(headerRegion(LIST)).toContain("navigation.navigate('ScanPromise')");
    });

    it('offers one persistent filled create action in every list state', () => {
        const total = LIST.split(CREATE_NAV).length - 1;
        expect(total).toBe(1);
        expect(renderEmptyBody(LIST)).not.toContain(CREATE_NAV);
        expect(headerRegion(LIST)).toMatch(/<PrimaryAction label=\{t\('promise.makePromise'\)\}[\s\S]+?CreatePromise/);
    });
});
