import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Item 2 — nothing on the Link Invitation screen clips, collides, or runs off-screen at the
 * smallest supported width (320pt iPhone SE 1st gen / 320dp Android). A static guard over the
 * screen source (the BackButton.guard.test.ts pattern): it reads the StyleSheet and the JSX and
 * reports every regression of the three defects the operator saw —
 * 1. the "Agent Name" label and value ran together (row/space-between, no gap, no shrink);
 * 2. a long agent name ran off the card's right edge (value could not shrink or wrap);
 * 3. the heading was sliced mid-line as it scrolled under a bare back button (no header bar),
 * and the loading / error states had no safe area or back button at all.
 */

const SCREEN = 'src/screens/Agent/LinkAcceptScreen.tsx';

/** The body of `name: { … }` inside StyleSheet.create, or null when the style does not exist. */
export function styleBlock(source: string, name: string): string | null {
    const m = new RegExp(`\\n\\s+${name}:\\s*\\{([^{}]*)\\}`).exec(source);
    return m ? m[1] : null;
}

function has(block: string | null, prop: string, value?: string): boolean {
    if (block === null) return false;
    const re = value === undefined
        ? new RegExp(`\\b${prop}\\s*:`)
        : new RegExp(`\\b${prop}\\s*:\\s*${value}(?![\\w.])`);
    return re.test(block);
}

export function linkAcceptLayoutViolations(source: string): string[] {
    const out: string[] = [];
    const row = styleBlock(source, 'statRow');
    const label = styleBlock(source, 'statLabel');
    const value = styleBlock(source, 'statValue');

    // 1 + 2: label/value rows wrap (or at least keep a gap), the value can shrink and take the rest.
    if (!has(row, 'flexWrap', "'wrap'") && !has(row, 'gap') && !has(row, 'columnGap')) {
        out.push('statRow: needs flexWrap:\'wrap\' or a gap so label and value never run together');
    }
    if (!has(value, 'flexShrink', '1') && !has(value, 'flex', '1')) {
        out.push('statValue: needs flexShrink:1 (or flex:1) so a long name wraps instead of overflowing the card');
    }
    if (!has(value, 'minWidth', '0') && !has(row, 'flexWrap', "'wrap'")) {
        out.push('statValue: needs minWidth:0 (or a wrapping row) so it can shrink below its intrinsic width');
    }
    if (!has(label, 'flexShrink', '0')) {
        out.push('statLabel: needs flexShrink:0 so the label is never squeezed into the value');
    }
    // A truncated name hides what the human is linking to — the value must wrap, not ellipsize.
    if (/<Text\s+style=\{styles\.statValue\}[^>]*numberOfLines/.test(source)) {
        out.push('statValue Text: must not set numberOfLines (the agent name wraps, never truncates)');
    }

    // 3: a real header bar (back button + centred title + spacer on the screen background) sits
    // ABOVE the ScrollView, and every state renders inside a SafeAreaView with it.
    const bar = styleBlock(source, 'headerBar');
    if (!bar || !has(bar, 'backgroundColor')) {
        out.push('headerBar: needs a fixed header bar style with the screen background colour');
    }
    const title = styleBlock(source, 'headerTitle');
    if (!title || !has(title, 'textAlign', "'center'")) {
        out.push('headerTitle: needs a centred header title');
    }
    if (!/BACK_BUTTON_SIZE|width:\s*44\b/.test(styleBlock(source, 'headerSpacer') ?? '')) {
        out.push('headerSpacer: needs a back-button-wide (44pt) spacer so the title stays centred');
    }
    const safeAreas = (source.match(/<SafeAreaView\b/g) ?? []).length;
    const headerRenders = (source.match(/\{header\}/g) ?? []).length;
    if (safeAreas < 3 || headerRenders < 3) {
        out.push(`states: loading, error and loaded must each render SafeAreaView + the header bar (found ${safeAreas} SafeAreaView, ${headerRenders} header)`);
    }
    return out;
}

describe('LinkAcceptScreen layout guard (320pt)', () => {
    const root = path.resolve(__dirname, '../../..');
    const source = fs.readFileSync(path.join(root, SCREEN), 'utf8');

    it('reads the real screen (not an empty population)', () => {
        expect(source.length).toBeGreaterThan(1000);
        expect(styleBlock(source, 'statRow')).not.toBeNull();
        expect(styleBlock(source, 'statValue')).not.toBeNull();
    });

    it('label/value rows wrap, long names wrap, and a fixed header bar frames every state', () => {
        expect(linkAcceptLayoutViolations(source)).toEqual([]);
    });

    it('RED control: the pre-fix row (row/space-between, no gap, no shrink) and bare nav bar are reported', () => {
        const planted = `
            if (loading) { return (<View style={styles.loadingContainer}><ActivityIndicator /></View>); }
            return (<SafeAreaView style={styles.safeArea}><View style={styles.navBar}><BackButton onPress={x} /></View>
            <Text style={styles.statValue} numberOfLines={1}>{inviteDetails.agent_name}</Text></SafeAreaView>);
            const styles = StyleSheet.create({
                navBar: {
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                },
                statRow: {
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                },
                statLabel: {
                    fontSize: 14,
                },
                statValue: {
                    fontSize: 16,
                    fontWeight: '600',
                },
            });`;
        const v = linkAcceptLayoutViolations(planted);
        expect(v.some((m) => m.startsWith('statRow'))).toBe(true);
        expect(v.some((m) => m.startsWith('statValue: needs flexShrink'))).toBe(true);
        expect(v.some((m) => m.startsWith('statLabel'))).toBe(true);
        expect(v.some((m) => m.startsWith('statValue Text'))).toBe(true);
        expect(v.some((m) => m.startsWith('headerBar'))).toBe(true);
        expect(v.some((m) => m.startsWith('states'))).toBe(true);
    });
});
