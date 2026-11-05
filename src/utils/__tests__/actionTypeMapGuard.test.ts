/**
 * the structural guard that makes 's "one action-type map" rule
 * mechanical instead of advisory.
 *
 * WHY THIS EXISTS: swept every PE display surface onto the canonical
 * `ACTION_TYPE_MAP`, but nothing enforced it. `AgentDetailScreen` kept a private
 * `humanizeActionType` (a bare `replace(/_/g,' ')`) that rendered
 * "Service:github commit" to users for weeks afterwards, and it took a human
 * reading the file to notice. fixed that screen; this fixes the class.
 *
 * Per CLAUDE.md — "a new assertion is not evidence until a negative control has
 * shown it failing" every rule below is first exercised against a deliberately
 * violating fixture, in-suite and permanent, so the corpus scan cannot pass by
 * being hard-wired to "ok". The three named traps are all handled explicitly:
 *
 * empty population — the scanned-file count is asserted non-zero and printed,
 * so a glob that stops matching fails LOUD instead of
 * vacuously passing over nothing.
 * self-referential — the fixtures build their keys FROM `KNOWN_ACTION_TYPES`
 * (derived from the real map) rather than from a private
 * copy of the key list.
 * unreachable branch — the `MIN_KNOWN_KEYS_FOR_MAP` threshold is exercised on
 * BOTH sides (2 keys clean, 3 keys flagged).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { KNOWN_ACTION_TYPES } from '../actionTypeDisplay';
import {
    findActionTypeMapViolations,
    findViolationsInSource,
    stripCommentsPreservingLines,
    MIN_KNOWN_KEYS_FOR_MAP,
    type ScreenSource,
} from '../actionTypeMapGuard';
import { PRE_FIX_SOURCES } from './actionTypeMapGuard.fixtures';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCREENS_DIR = resolve(REPO_ROOT, 'src/screens');

function collectScreens(dir: string, acc: ScreenSource[] = []): ScreenSource[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) collectScreens(full, acc);
        else if (entry.name.endsWith('.tsx')) {
            acc.push({ path: relative(REPO_ROOT, full), source: readFileSync(full, 'utf8') });
        }
    }
    return acc;
}

/** Real action types, taken from the real map — never a copy of the key list. */
const SAMPLE_TYPES = [...KNOWN_ACTION_TYPES].sort();

describe(' detector — negative controls (each shape observed RED)', () => {
    it('flags a per-screen humanizer declared as a function', () => {
        const fixture = `
export default function FakeScreen() { return null; }
function humanizeActionType(actionType: string): string {
    return actionType.replace(/_/g, ' ');
}
`;
        const hits = findViolationsInSource('src/screens/Fake/A.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('local_humanizer');
        expect(hits.find((h) => h.kind === 'local_humanizer')?.name).toBe('humanizeActionType');
    });

    it('flags a per-screen humanizer declared as a const arrow', () => {
        const fixture = `const prettyActionLabel = (t: string) => t.toUpperCase();\n`;
        const hits = findViolationsInSource('src/screens/Fake/B.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('local_humanizer');
    });

    it(`flags a local map at the ${MIN_KNOWN_KEYS_FOR_MAP}-known-key threshold`, () => {
        const keys = SAMPLE_TYPES.slice(0, MIN_KNOWN_KEYS_FOR_MAP);
        const fixture = `const ACTION_CONFIG: Record<string, { icon: string }> = {\n`
            + keys.map((k) => `  ${k}: { icon: 'x', color: '#fff' },`).join('\n')
            + `\n};\n`;
        const hits = findViolationsInSource('src/screens/Fake/C.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('local_action_type_map');
        expect(hits.find((h) => h.kind === 'local_action_type_map')?.name).toBe('ACTION_CONFIG');
    });

    it(`does NOT flag a map below the threshold (${MIN_KNOWN_KEYS_FOR_MAP - 1} known keys)`, () => {
        const keys = SAMPLE_TYPES.slice(0, MIN_KNOWN_KEYS_FOR_MAP - 1);
        const fixture = `const ROUTE_FOR: Record<string, { icon: string }> = {\n`
            + keys.map((k) => `  ${k}: { icon: 'x', color: '#fff' },`).join('\n')
            + `\n};\n`;
        const hits = findViolationsInSource('src/screens/Fake/D.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).not.toContain('local_action_type_map');
    });

    it('flags an inline action_type transform', () => {
        const fixture = `const label = envelope.action_type.replace(/_/g, ' ');\n`;
        const hits = findViolationsInSource('src/screens/Fake/E.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('inline_action_type_format');
    });

    it('flags the raw-type fallback this guard actually found (AgentAuthorizationScreen,)', () => {
        // The real line, before fixed it. `config` came from a private map,
        // and anything the map lacked reached the user as "SHARE_DATA".
        const fixture = `const label = config ? config.label.toUpperCase() : request.actionType.toUpperCase();\n`;
        const hits = findViolationsInSource('src/screens/Fake/I.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('inline_action_type_format');
    });

    it('every violation carries a remedy a reader can act on', () => {
        const fixture = `function humanizeActionType(t: string) { return t; }\n`;
        const [hit] = findViolationsInSource('src/screens/Fake/F.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hit.remedy).toMatch(/actionTypeDisplay/);
        expect(hit.line).toBe(1);
    });
});

describe(' detector — the REAL pre-fix code it must flag (verbatim from 16b9ed2c)', () => {
    // Synthetic fixtures prove each rule fires. These prove the rules match code
    // that actually shipped — a detector validated only against examples its own
    // author invented is tuned to that author's imagination.
    for (const { name, source, expect: expected } of PRE_FIX_SOURCES) {
        it(`flags ${name}`, () => {
            const kinds = findViolationsInSource(`src/screens/X/${name}.tsx`, source, KNOWN_ACTION_TYPES)
                .map((v) => v.kind);
            for (const kind of expected) expect(kinds).toContain(kind);
        });
    }

    it('covers all three violation kinds across the real corpus', () => {
        // Guards against the fixtures silently narrowing to one easy shape.
        const kinds = new Set(
            PRE_FIX_SOURCES.flatMap((f) =>
                findViolationsInSource('src/screens/X/f.tsx', f.source, KNOWN_ACTION_TYPES).map((v) => v.kind)),
        );
        expect([...kinds].sort()).toEqual([
            'inline_action_type_format', 'local_action_type_map', 'local_humanizer',
        ]);
    });
});

describe(' detector — the false positives it must NOT produce', () => {
    it('is blind to comments — the comment naming the defect is not the defect', () => {
        // The real comment left in AgentDetailScreen by the fix. A raw-source scan
        // flags the documentation of the rule, which is how guards get deleted.
        const fixture = `
/**
 * Canonical display, from the ONE map (, pitfall #59). NEVER a per-screen
 * humanizer: the local one this replaced was a raw underscore-replace, so
 * a namespaced type leaked as "Service:github commit".
 */
const x = 1;
`;
        expect(findViolationsInSource('src/screens/Fake/G.tsx', fixture, KNOWN_ACTION_TYPES)).toEqual([]);
    });

    it('does NOT flag a transform of the canonical map RESULT (the .label.toUpperCase() shape)', () => {
        // The first draft of INLINE_FORMAT allowed 60 intervening characters and
        // flagged this — correct code, routed through the canonical map, whose
        // uppercase applies to the resulting LABEL. Crossing a `)` inverts the
        // meaning of the match, so this control is permanent.
        const fixture = `<Text>{getActionTypeDisplay(envelope.action_type).label.toUpperCase()}</Text>\n`;
        expect(findViolationsInSource('src/screens/Fake/J.tsx', fixture, KNOWN_ACTION_TYPES)).toEqual([]);
    });

    it('does NOT flag a COPY-only table keyed by action type (the shape migrated TO)', () => {
        // ActionApprovalScreen legitimately keeps per-screen i18n copy keyed by
        // request type. The rule is one map for how a type LOOKS, not a ban on
        // every table keyed by action type — a guard that rejects the correct fix
        // gets deleted rather than obeyed.
        const keys = SAMPLE_TYPES.slice(0, MIN_KNOWN_KEYS_FOR_MAP + 2);
        const fixture = `const ACTION_COPY: Record<string, { titleKey: string }> = {\n`
            + keys.map((k) => `  ${k}: { titleKey: 'x.${k}', bannerKey: 'y.${k}' },`).join('\n')
            + `\n};\n`;
        expect(findViolationsInSource('src/screens/Fake/K.tsx', fixture, KNOWN_ACTION_TYPES)).toEqual([]);
    });

    it('STILL flags the same table once it carries display fields', () => {
        // The paired RED control for the exemption above: identical key set, plus
        // an icon/colour. Without this the narrowing could silently blind rule 2.
        const keys = SAMPLE_TYPES.slice(0, MIN_KNOWN_KEYS_FOR_MAP + 2);
        const fixture = `const ACTION_COPY: Record<string, { icon: string }> = {\n`
            + keys.map((k) => `  ${k}: { icon: 'x', color: '#fff', titleKey: 'y' },`).join('\n')
            + `\n};\n`;
        const hits = findViolationsInSource('src/screens/Fake/L.tsx', fixture, KNOWN_ACTION_TYPES);
        expect(hits.map((h) => h.kind)).toContain('local_action_type_map');
    });

    it('leaves the PLURAL actionTypes config parse alone (a real call in AgentAuthorizationScreen)', () => {
        const fixture = `const parsed = actionTypes.split(',').map((s) => s.trim());\n`;
        expect(findViolationsInSource('src/screens/Fake/H.tsx', fixture, KNOWN_ACTION_TYPES)).toEqual([]);
    });

    it('stripCommentsPreservingLines keeps line numbers stable', () => {
        const src = 'const a = 1;\n// comment\n/* block\n   block */\nconst b = 2;\n';
        const stripped = stripCommentsPreservingLines(src);
        expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
        expect(stripped).toContain('const a = 1;');
        expect(stripped).toContain('const b = 2;');
        expect(stripped).not.toContain('comment');
    });
});

/**
 * EMPTY as of every violation the guard found is fixed. Kept as the
 * RATCHET mechanism rather than deleted, so a future pre-existing violation has
 * an honest place to sit instead of pressuring someone to weaken the detector.
 *
 * The original entries (ActionApprovalScreen, AIControlsDashboardScreen) were
 * migrated in once the operator made the product call the consolidation needed.
 *
 * Historic note on why a ratchet rather than an excuse.
 *
 * The detector found three redeclarations. `AgentAuthorizationScreen` was fixed in
 * (it leaked the RAW type as "SHARE_DATA" a live user-visible bug). These
 * two are older and are NOT a leak: each renders a label it has, from a private
 * icon/color/label table. Consolidating them is a real UI decision, not a
 * mechanical migration — the two tables disagree with each other AND with the
 * canonical map (`public_post` is COLORS.primary in one and '#9B72F0' in the
 * other; labels read "Message"/"Commitment" against "Communicate"/"Commit"), and
 * one of the screens is the security approval flow. Picking the winner is a
 * product call, so it is tracked, not smuggled into a guard commit.
 *
 * This list can only SHRINK: the test below fails if an entry stops violating,
 * so a fix cannot land while leaving stale debt recorded here. Adding an entry is
 * a visible diff that needs its own justification.
 */
const KNOWN_VIOLATION_BASELINE: readonly string[] = [
    // Pre-existing (pass-2 commit fecfccc2): PresentationRequesterScreen declares
    // humanizeField/humanizePredicate, which humanize VOCABULARY PREDICATE FIELD
    // names (continuity.chain_depth → "chain depth"), NOT PE action types — so
    // getActionTypeDisplay (an action-type map) does not apply. The `humanize*`
    // heuristic false-matches them. Tracked here (a product call on whether to add
    // a central field-label map) rather than smuggled into an unrelated commit.
    'src/screens/Presentment/PresentationRequesterScreen.tsx',
];

describe('the real src/screens corpus', () => {
    const screens = collectScreens(SCREENS_DIR);

    it('scans a NON-EMPTY population (the empty-population trap)', () => {
        // A pass over zero files is not a pass. If the glob or the directory
        // layout moves, this fails LOUD rather than reporting a clean sweep.
        console.log(`[] scanned ${screens.length} screen .tsx files under src/screens`);
        expect(screens.length).toBeGreaterThan(0);
        // The four screens / put on the canonical map must be in scope.
        for (const name of [
            'EnvelopeDetailScreen.tsx',
            'ActivityLogScreen.tsx',
            'AgentDetailScreen.tsx',
            'MyProvenanceDashboardScreen.tsx',
        ]) {
            expect(screens.some((s) => s.path.endsWith(name))).toBe(true);
        }
    });

    it('no screen redeclares the action-type map, outside the baseline (, pitfall #59)', () => {
        const violations = findActionTypeMapViolations(screens, KNOWN_ACTION_TYPES)
            .filter((v) => !KNOWN_VIOLATION_BASELINE.includes(v.path));
        const report = violations
            .map((v) => `  ${v.path}:${v.line}  [${v.kind}] ${v.name}\n      → ${v.remedy}`)
            .join('\n');
        expect(violations, violations.length === 0 ? '' : `\n${report}\n`).toEqual([]);
    });

    it('the baseline only shrinks — every entry must STILL violate', () => {
        // Without this, a fixed screen stays listed forever and the baseline
        // silently becomes a blanket exemption for files nobody rechecks.
        const violations = findActionTypeMapViolations(screens, KNOWN_ACTION_TYPES);
        console.log(`[] baseline carries ${KNOWN_VIOLATION_BASELINE.length} pre-existing violation(s)`);
        for (const path of KNOWN_VIOLATION_BASELINE) {
            expect(
                violations.some((v) => v.path === path),
                `${path} no longer violates — DELETE it from KNOWN_VIOLATION_BASELINE.`,
            ).toBe(true);
        }
    });
});
