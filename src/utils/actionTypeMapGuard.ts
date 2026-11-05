/**
 * the structural guard behind 's "one action-type map" rule.
 *
 * (CLAUDE.md pitfall #59) requires every PE display surface to render
 * `action_type` through the ONE canonical map in `actionTypeDisplay.ts`
 * (`ACTION_TYPE_MAP` + `getActionTypeDisplay`), with `formatActionType` as the
 * only fallback — the one that strips the namespace so a raw internal string
 * ("service:github_commit") never reaches a user.
 *
 * That rule was enforced by CONVENTION ONLY, and convention lost:
 * `AgentDetailScreen` kept a private `humanizeActionType` a bare
 * `replace(/_/g, ' ')` that rendered "Service:github commit" for weeks after
 * the sweep meant to have removed it (fixed in). Nothing stopped the next
 * screen from doing the same. This is the mechanical detector.
 *
 * Shape deliberately mirrors `findRedeclaredLiterals` in the backend's
 * `wp11/cutover-hard-stops.ts` a PURE function over `(path, source)` pairs, so
 * the caller — including a negative control planting a deliberate violation —
 * controls the corpus entirely. No filesystem access lives in this module,
 * which also keeps `node:fs` out of anything the RN bundle can reach.
 *
 * The known-action-type set is passed IN rather than imported, so the test binds
 * it to `KNOWN_ACTION_TYPES` (derived from the real map) instead of this file
 * keeping a private copy of the key list — the "self-referential control" trap.
 */

export interface ScreenSource {
    readonly path: string;
    readonly source: string;
}

export type ActionTypeViolationKind =
    | 'local_humanizer'
    | 'local_action_type_map'
    | 'inline_action_type_format';

export interface ActionTypeViolation {
    readonly kind: ActionTypeViolationKind;
    readonly path: string;
    /** 1-indexed, and equal to the ORIGINAL file's line (comments are blanked, not deleted). */
    readonly line: number;
    /** The offending identifier, or the matched expression for an inline hit. */
    readonly name: string;
    /** What to do instead. This text lands in the failing test's output. */
    readonly remedy: string;
}

/**
 * How many known action_type keys an object literal must carry before it counts
 * as a redeclared display map. Two is a plausible incidental pair (a screen
 * mapping `send`/`receive` to nav routes); three is a map. The boundary is
 * exercised in both directions by the suite — an untested threshold is a
 * number someone picked, not a rule.
 */
export const MIN_KNOWN_KEYS_FOR_MAP = 3;

const LOCAL_HUMANIZER_NAME = /humani[sz]e|format_?action|pretty_?action|prettify_?action/i;

const FN_DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const CONST_FN_DECL =
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;
const OBJ_DECL = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*\{\s*$/;
const OBJ_KEY = /^\s*['"]?([A-Za-z0-9_:]+)['"]?\s*:/;

/**
 * A field that makes an object literal a DISPLAY table rather than merely a table
 * keyed by action type.
 *
 * The rule states is "one map for how an action TYPE LOOKS" icon, colour,
 * label. A per-screen table of screen-specific COPY keyed by action type is a
 * legitimate pattern and not this defect: approval prose genuinely differs per
 * screen, appearance must not. Without this distinction the guard would reject
 * `ACTION_COPY` in ActionApprovalScreen — the correct shape migrated TO —
 * and a guard that rejects the fix teaches people to delete the guard.
 *
 * KNOWN LIMIT: a display map that names its fields something else evades this.
 * The trade is deliberate — a detector that fires on correct code costs more
 * than one that misses an exotic spelling.
 */
const DISPLAY_FIELD = /\b(?:icon|color|colour|emoji|label)\s*:/;

/**
 * An action_type expression transformed inline — the same defect without a named
 * function to hang it on, e.g. `{envelope.action_type.replace(/_/g, ' ')}` or the
 * `request.actionType.toUpperCase()` fallback found in
 * AgentAuthorizationScreen.
 *
 * The transform must attach DIRECTLY to the identifier. An earlier draft allowed
 * up to 60 intervening characters and flagged
 * `getActionTypeDisplay(envelope.action_type).label.toUpperCase()` correct code
 * that routes through the canonical map and then uppercases the RESULT. Crossing
 * a `)` boundary inverts the meaning of the match, so it is not allowed.
 *
 * The trailing word boundary is load-bearing the other way: it excludes the
 * PLURAL `actionTypes.split(',')` (a real, legitimate config parse in the same
 * screen) — a list being parsed, not a label being rendered.
 *
 * KNOWN LIMIT: an action_type copied into a local variable first, then
 * transformed, is not matched. Precision is preferred to reach here; the named
 * shapes above catch the version of this defect that has actually occurred.
 */
const INLINE_FORMAT =
    /\b(?:action_type|actionType)\b\s*\.\s*(?:replace|split|toUpperCase|toLowerCase)\s*\(/;

/**
 * Blank out comments while preserving every newline, so reported line numbers
 * still match the original file.
 *
 * NOT optional, and not cosmetic: the fix left a comment in
 * `AgentDetailScreen` reading "NEVER a per-screen humanizer". A raw-source scan
 * would flag the very comment documenting the fix that closed the defect — a
 * guard that fires on its own rule gets deleted rather than obeyed.
 *
 * A local copy of the backend's helper because `provian-backend` is a separate
 * package the RN app cannot import. Known approximation: a regex literal
 * containing a lone quote (`/['"]/`) can be misread as opening a string. That
 * direction is safe — string mode COPIES characters rather than blanking them,
 * so the worst case is an unstripped comment (a loud false positive), never a
 * swallowed violation.
 */
export function stripCommentsPreservingLines(source: string): string {
    let out = '';
    let mode: 'code' | 'line' | 'block' | 'string' = 'code';
    let quote = '';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (mode === 'code') {
            if (c === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { mode = 'string'; quote = c; out += c; i += 1; continue; }
            out += c; i += 1; continue;
        }
        if (mode === 'string') {
            if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
            if (c === quote) mode = 'code';
            out += c; i += 1; continue;
        }
        if (mode === 'line') {
            if (c === '\n') { mode = 'code'; out += '\n'; i += 1; continue; }
            out += '  '; i += 1; continue;
        }
        // block comment
        if (c === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
        out += c === '\n' ? '\n' : '  ';
        i += 1;
    }
    return out;
}

/**
 * Every violation in one file. Exported for focused testing; `findActionTypeMapViolations`
 * is what a caller normally wants.
 */
export function findViolationsInSource(
    path: string,
    source: string,
    knownActionTypes: ReadonlySet<string>,
): readonly ActionTypeViolation[] {
    const out: ActionTypeViolation[] = [];
    const lines = stripCommentsPreservingLines(source).split('\n');

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        // --- local_humanizer -------------------------------------------------
        const decl = FN_DECL.exec(line) ?? CONST_FN_DECL.exec(line);
        if (decl !== null && LOCAL_HUMANIZER_NAME.test(decl[1])) {
            out.push({
                kind: 'local_humanizer',
                path,
                line: i + 1,
                name: decl[1],
                remedy:
                    `import { getActionTypeDisplay } from '<path>/utils/actionTypeDisplay' and use `
                    + `its .label, rather than declaring ${decl[1]} here (, pitfall #59).`,
            });
        }

        // --- local_action_type_map -------------------------------------------
        const obj = OBJ_DECL.exec(line);
        if (obj !== null) {
            let depth = 0;
            let hasDisplayField = false;
            const hits = new Set<string>();
            for (let j = i; j < lines.length; j += 1) {
                for (const ch of lines[j]) {
                    if (ch === '{') depth += 1;
                    else if (ch === '}') depth -= 1;
                }
                if (j > i) {
                    const key = OBJ_KEY.exec(lines[j]);
                    if (key !== null && knownActionTypes.has(key[1])) hits.add(key[1]);
                    if (DISPLAY_FIELD.test(lines[j])) hasDisplayField = true;
                }
                if (depth <= 0) break;
            }
            if (hits.size >= MIN_KNOWN_KEYS_FOR_MAP && hasDisplayField) {
                out.push({
                    kind: 'local_action_type_map',
                    path,
                    line: i + 1,
                    name: obj[1],
                    remedy:
                        `${obj[1]} redeclares the action_type map with ${hits.size} known keys `
                        + `(${[...hits].sort().slice(0, 4).join(', ')}...). Add entries to `
                        + `ACTION_TYPE_MAP in utils/actionTypeDisplay.ts instead (, pitfall #59).`,
                });
            }
        }

        // --- inline_action_type_format ---------------------------------------
        const inline = INLINE_FORMAT.exec(line);
        if (inline !== null) {
            out.push({
                kind: 'inline_action_type_format',
                path,
                line: i + 1,
                name: inline[0].trim(),
                remedy:
                    'Formatting an action_type inline bypasses the canonical map. Use '
                    + 'getActionTypeDisplay(type).label (, pitfall #59).',
            });
        }
    }
    return out;
}

/**
 * Every violation across a corpus, newest concern first by path then line.
 *
 * `files` is passed in whole so a negative control can hand this function a
 * synthetic violating screen and observe it reported — the corpus is never
 * discovered inside the detector.
 */
export function findActionTypeMapViolations(
    files: readonly ScreenSource[],
    knownActionTypes: ReadonlySet<string>,
): readonly ActionTypeViolation[] {
    return files
        .flatMap((f) => findViolationsInSource(f.path, f.source, knownActionTypes))
        .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
