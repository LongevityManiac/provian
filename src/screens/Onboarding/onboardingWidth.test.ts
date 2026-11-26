/**
 * The onboarding pager follows the live window width. In the web app the window can be resized
 * after the page loads (or have no width yet while the page loads), so a width read once at module
 * load left every step at the old width until a reload. Each step, the strip and the slide offset
 * must come from useWindowDimensions, and a width change must re-position the current step.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREEN = readFileSync(resolve(__dirname, 'UnifiedOnboardingScreen.tsx'), 'utf8');

export function pagerWidthProblems(src: string): string[] {
    const problems: string[] = [];
    if (/Dimensions\.get\(/.test(src)) problems.push('reads the width once with Dimensions.get');
    if (!/const \{ width: screenWidth \} = useWindowDimensions\(\);/.test(src)) problems.push('screen does not read the live width');
    if (!/width: screenWidth \* TOTAL_STEPS/.test(src)) problems.push('strip width is not the live width times the steps');
    if (!/<View style=\{\[styles\.step, \{ width \}\]\}>/.test(src)) problems.push('a step is not one live width wide');
    if (!/toValue: -step \* screenWidth/.test(src)) problems.push('slide offset does not use the live width');
    if (!/slideAnim\.setValue\(-currentStep \* screenWidth\);\s[\s\S]{0,200}\}, \[screenWidth\]\);/.test(src)) problems.push('a resize does not re-position the current step');
    return problems;
}

describe('onboarding pager width', () => {
    it('every step, the strip and the slide follow the live window width', () => {
        expect(pagerWidthProblems(SCREEN)).toEqual([]);
    });

    it('RED: the width read once at load is caught', () => {
        const fixed = SCREEN
            .replace('const { width: screenWidth } = useWindowDimensions();', "const { width: screenWidth } = Dimensions.get('window');")
            .replace('<View style={[styles.step, { width }]}>', '<View style={styles.step}>');
        expect(pagerWidthProblems(fixed)).toEqual(expect.arrayContaining([
            'reads the width once with Dimensions.get',
            'screen does not read the live width',
            'a step is not one live width wide',
        ]));
    });
});
