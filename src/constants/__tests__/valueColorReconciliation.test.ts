/**
 * Value-color reconciliation guard — PLATINUM OWNS THE ASSET, AMBER OWNS THE MOMENT.
 *
 * The rule (theme.ts header, decided 2026-09-03): the PVT token identity — the coin,
 * PVT balances and amounts, earning chips/badges, the PVT wallet card accent — is
 * platinum (COLORS.platinum*). Amber stays the ambient accent for participation
 * VALUE MOMENTS (earning, footprint/abundance tiles and glows) and the warning
 * status. This suite makes that rule mechanical on the three surfaces that define
 * it: the coin (TokenIcon.tsx -> PVTIcon), the theme bindings (ACCENTS), and the
 * earning chip (peDisposition.ts -> buildEarningChip), plus the PVT wallet card.
 *
 * Per CLAUDE.md — "a new assertion is not evidence until a negative control has
 * shown it failing" every detector below is first fed a deliberately violating
 * input, in-suite and permanent, before it is applied to the real sources. The
 * three named traps:
 *
 * empty population — `extractBlock` THROWS when a marker is missing, and the
 * coin block must reference a non-empty set of platinum
 * tokens; a gutted block (zero refs) is asserted to FAIL the
 * guard, never to pass vacuously.
 * self-referential — the binding checks read ACCENTS/COLORS/buildEarningChip
 * from the real modules; the source scans read the real
 * files. The only literals declared here are the APPROVED
 * platinum palette (coin), pinned on
 * purpose so a drift toward gold trips a test.
 * unreachable branch — detectors take WIDENED inputs (plain strings / plain
 * Record<string, string>) so a violation is constructible;
 * the narrow `as const` types stay at the call sites.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLORS, ACCENTS, GRADIENTS } from '../theme';
import { buildEarningChip, type EarningChip } from '../../utils/peDisposition';

const REPO_ROOT = resolve(__dirname, '../../..');
const readSource = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

const TOKEN_ICON_PATH = 'src/components/TokenIcon.tsx';
const DASHBOARD_PATH = 'src/screens/Dashboard/DashboardScreen.tsx';
const THEME_PATH = 'src/constants/theme.ts';

/**
 * The approved platinum palette — the exact hexes the 2026-08-18 coin was drawn
 * with, now owned by the theme. Pinned deliberately: moving the PVT asset toward
 * gold/yellow-on-black is a product decision, not a refactor, and must trip here.
 */
const APPROVED_PLATINUM_PALETTE = {
    platinum: '#F5F7FB',
    platinumDeep: '#C2C9D5',
    platinumEdge: '#8A93A3',
    platinumCheck: '#152233',
    platinumSeal: '#1B2637',
} as const;

// ----------------------------------------------------------------------------
// Detectors — pure, over widened inputs, so each can be shown RED in-suite.
// ----------------------------------------------------------------------------

/** Hex color literals (#RGB / #RRGGBB / #RRGGBBAA). `url(#pvtPlat)` is NOT a hex. */
const HEX_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;
/** rgb()/rgba() literals — a card border written as a raw tint instead of a token. */
const RGB_LITERAL = /rgba?\([^)]*\)/g;

function findColorLiterals(src: string): string[] {
    return [...(src.match(HEX_LITERAL) ?? []), ...(src.match(RGB_LITERAL) ?? [])];
}

/** Distinct `COLORS.<platinum token>` references in a block. */
function findPlatinumTokenRefs(src: string): string[] {
    const refs = new Set<string>();
    for (const m of src.matchAll(/COLORS\.(platinum[A-Za-z]*)/g)) refs.add(m[1]);
    return [...refs].sort();
}

/**
 * Slice a source block between two markers. THROWS when either marker is missing
 * so a renamed anchor fails LOUD instead of scanning an empty string.
 */
function extractBlock(src: string, startMarker: string, endMarker: string, label: string): string {
    const start = src.indexOf(startMarker);
    if (start < 0) throw new Error(`${label}: start marker not found: ${startMarker}`);
    const end = src.indexOf(endMarker, start + startMarker.length);
    if (end < 0) throw new Error(`${label}: end marker not found: ${endMarker}`);
    const block = src.slice(start, end + endMarker.length);
    if (block.trim().length === 0) throw new Error(`${label}: empty block`);
    return block;
}

/** ACCENTS binding rule: pvt → platinum; footprint/abundance → amber (secondary). */
function checkAccentBindings(
    accents: Record<string, string>,
    colors: { platinum: string; secondary: string },
): string[] {
    const violations: string[] = [];
    if (accents.pvt !== colors.platinum) violations.push(`pvt must be COLORS.platinum (got ${accents.pvt})`);
    if (accents.pvt === colors.secondary) violations.push('pvt must not be amber');
    if (accents.footprint !== colors.secondary) violations.push(`footprint must be COLORS.secondary (got ${accents.footprint})`);
    if (accents.abundance !== colors.secondary) violations.push(`abundance must be COLORS.secondary (got ${accents.abundance})`);
    return violations;
}

/**
 * Chip palette rule: chips that name PVT as an ASSET (earning / minted) are
 * platinum; `pending` is the amber STATUS semantic (COLORS.warning); `record_only`
 * is muted text. Amber never colors the asset.
 */
function checkChipPalette(
    chips: Record<'earning' | 'minted' | 'pending' | 'record_only', Pick<EarningChip, 'color'> | null>,
    colors: { platinum: string; warning: string; textSecondary: string; secondary: string },
): string[] {
    const violations: string[] = [];
    for (const k of ['earning', 'minted'] as const) {
        const c = chips[k]?.color;
        if (c !== colors.platinum) violations.push(`${k} chip must be COLORS.platinum (got ${c})`);
        if (c === colors.secondary) violations.push(`${k} chip must not be amber`);
    }
    if (chips.pending?.color !== colors.warning) violations.push(`pending chip must be COLORS.warning (got ${chips.pending?.color})`);
    if (chips.record_only?.color !== colors.textSecondary) violations.push(`record_only chip must be COLORS.textSecondary (got ${chips.record_only?.color})`);
    return violations;
}

/** Slice the real coin out of TokenIcon.tsx: `const PVTIcon = (` … the first `\n);`. */
function realPVTIconBlock(): string {
    return extractBlock(readSource(TOKEN_ICON_PATH), 'const PVTIcon = (', '\n);', 'PVTIcon');
}

/** Slice the PVT wallet-card treatment out of DashboardScreen.tsx. */
function realPvtCardBlock(): string {
    return extractBlock(
        readSource(DASHBOARD_PATH),
        'const isPvtCard = asset.isPVT === true;',
        '<View style={styles.assetHeader}>',
        'isPvtCard',
    );
}

// ----------------------------------------------------------------------------
// Negative controls — each detector observed RED before it is trusted.
// ----------------------------------------------------------------------------

describe('value-color guard — negative controls (each shape observed RED)', () => {
    it('findColorLiterals reports a hex smuggled back into the coin', () => {
        const mutated = realPVTIconBlock().replace('{COLORS.platinum}', '"#F5F7FB"');
        expect(mutated).not.toBe(realPVTIconBlock()); // the mutation actually landed
        expect(findColorLiterals(mutated)).toEqual(['#F5F7FB']);
    });

    it('findColorLiterals reports a raw rgba() tint and a short #RGB, but not url(#id)', () => {
        expect(findColorLiterals('stroke="#FFF" fill="url(#pvtPlat)"')).toEqual(['#FFF']);
        expect(findColorLiterals("borderColor: 'rgba(240,242,245,0.22)'")).toEqual(['rgba(240,242,245,0.22)']);
        expect(findColorLiterals('fill="url(#pvtPlat)"')).toEqual([]);
    });

    it('a gutted coin (zero platinum token refs) FAILS the reference guard — no vacuous pass', () => {
        const gutted = realPVTIconBlock().replace(/COLORS\.platinum[A-Za-z]*/g, 'COLORS.text');
        expect(findPlatinumTokenRefs(gutted)).toEqual([]);
        // The real assertion below requires a NON-EMPTY, specific set — this is what
        // a gutted block would be measured against.
        expect(findPlatinumTokenRefs(gutted).length).toBe(0);
    });

    it('extractBlock THROWS on a missing marker instead of scanning nothing', () => {
        expect(() => extractBlock('nothing here', 'const PVTIcon = (', '\n);', 'PVTIcon'))
            .toThrow(/start marker not found/);
        expect(() => extractBlock('const PVTIcon = ( <Svg/>', 'const PVTIcon = (', '\n);', 'PVTIcon'))
            .toThrow(/end marker not found/);
    });

    it('checkAccentBindings reports pvt re-bound to amber', () => {
        const drifted = { ...ACCENTS, pvt: COLORS.secondary };
        const v = checkAccentBindings(drifted, COLORS);
        expect(v.some((s) => s.startsWith('pvt must be COLORS.platinum'))).toBe(true);
        expect(v).toContain('pvt must not be amber');
    });

    it('checkAccentBindings reports a value MOMENT re-bound to platinum', () => {
        expect(checkAccentBindings({ ...ACCENTS, footprint: COLORS.platinum }, COLORS))
            .toEqual([expect.stringMatching(/^footprint must be COLORS\.secondary/)]);
        expect(checkAccentBindings({ ...ACCENTS, abundance: COLORS.platinum }, COLORS))
            .toEqual([expect.stringMatching(/^abundance must be COLORS\.secondary/)]);
    });

    it('checkChipPalette reports an amber asset chip and a platinum status chip', () => {
        const real = {
            earning: buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: '1.2' }),
            minted: buildEarningChip({ mintStatus: 'minted' }),
            pending: buildEarningChip({ mintStatus: 'deferred' }),
            record_only: buildEarningChip({ mintStatus: 'record_only' }),
        };
        expect(checkChipPalette({ ...real, earning: { color: COLORS.secondary } }, COLORS))
            .toEqual([
                expect.stringMatching(/^earning chip must be COLORS\.platinum/),
                'earning chip must not be amber',
            ]);
        expect(checkChipPalette({ ...real, minted: { color: COLORS.success } }, COLORS))
            .toEqual([expect.stringMatching(/^minted chip must be COLORS\.platinum/)]);
        expect(checkChipPalette({ ...real, pending: { color: COLORS.platinum } }, COLORS))
            .toEqual([expect.stringMatching(/^pending chip must be COLORS\.warning/)]);
        expect(checkChipPalette({ ...real, record_only: null }, COLORS))
            .toEqual([expect.stringMatching(/^record_only chip must be COLORS\.textSecondary/)]);
    });
});

// ----------------------------------------------------------------------------
// The real surfaces.
// ----------------------------------------------------------------------------

describe('theme — the platinum scale and the ACCENTS bindings', () => {
    it('COLORS carries the approved platinum palette (the exact hexes the coin is drawn with)', () => {
        for (const [name, hex] of Object.entries(APPROVED_PLATINUM_PALETTE)) {
            expect(COLORS[name as keyof typeof APPROVED_PLATINUM_PALETTE]).toBe(hex);
        }
        // Platinum is never the amber value accent, and never gold on black.
        expect(COLORS.platinum).not.toBe(COLORS.secondary);
        expect(COLORS.platinum).not.toBe(COLORS.secondaryLight);
    });

    it('ACCENTS.pvt is platinum; ACCENTS.footprint / ACCENTS.abundance stay amber (COLORS.secondary)', () => {
        expect(checkAccentBindings(ACCENTS, COLORS)).toEqual([]);
        expect(ACCENTS.pvt).toBe(COLORS.platinum);
        expect(ACCENTS.footprint).toBe(COLORS.secondary);
        expect(ACCENTS.abundance).toBe(COLORS.secondary);
    });

    it('GRADIENTS.platinumSheen is flat (file convention) and platinum', () => {
        expect(GRADIENTS.platinumSheen.length).toBeGreaterThan(0);
        for (const stop of GRADIENTS.platinumSheen) expect(stop).toBe(COLORS.platinumDeep);
    });

    it('the theme header states the rule and no longer defers it to a tracker', () => {
        const theme = readSource(THEME_PATH);
        expect(theme).toContain('PLATINUM OWNS THE ASSET, AMBER OWNS THE');
        expect(theme).not.toContain('tracked in OPEN_ITEMS');
    });
});

describe('TokenIcon.tsx — the PVT coin is drawn from theme tokens only', () => {
    it('PVTIcon contains no hex or rgba literal', () => {
        const block = realPVTIconBlock();
        expect(block.length).toBeGreaterThan(0);
        expect(findColorLiterals(block)).toEqual([]);
    });

    it('PVTIcon references the full platinum scale, every token of which exists in COLORS', () => {
        const refs = findPlatinumTokenRefs(realPVTIconBlock());
        expect(refs.length).toBeGreaterThan(0); // never a pass over zero
        expect(refs).toEqual(['platinum', 'platinumCheck', 'platinumDeep', 'platinumEdge', 'platinumSeal']);
        for (const r of refs) expect(typeof COLORS[r as keyof typeof COLORS]).toBe('string');
        expect(readSource(TOKEN_ICON_PATH)).toMatch(/import \{ COLORS \} from '\.\.\/constants\/theme'/);
    });
});

describe('DashboardScreen.tsx — the PVT wallet card reads the same platinum tokens', () => {
    it('the isPvtCard treatment uses COLORS.platinum tokens and no raw color literal', () => {
        const block = realPvtCardBlock();
        expect(findColorLiterals(block)).toEqual([]);
        const refs = findPlatinumTokenRefs(block);
        expect(refs.length).toBeGreaterThan(0);
        expect(refs).toEqual(expect.arrayContaining(['platinum', 'platinumMuted']));
        expect(block).not.toMatch(/COLORS\.(secondary|chrome)\b/);
    });
});

describe('peDisposition — the earning chip colors the PVT asset platinum', () => {
    it('an eligible PVT amount resolves to COLORS.platinum; minted too; pending stays the amber status', () => {
        const earning = buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: '1.2' });
        expect(earning?.label).toBe('Earns ~1.2 PVT · pending');
        expect(earning?.color).toBe(COLORS.platinum);
        expect(earning?.backgroundColor).toBe(`${COLORS.platinum}22`);
        expect(buildEarningChip({ mintStatus: 'minting' })?.color).toBe(COLORS.platinum);
        expect(buildEarningChip({ mintStatus: 'minted' })?.color).toBe(COLORS.platinum);
        expect(checkChipPalette({
            earning,
            minted: buildEarningChip({ mintStatus: 'minted' }),
            pending: buildEarningChip({ mintStatus: 'deferred' }),
            record_only: buildEarningChip({ mintStatus: 'record_only' }),
        }, COLORS)).toEqual([]);
    });
});
