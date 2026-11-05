/**
 * Tab bar reachability + identity guard.
 *
 * The defect this pins: FloatingTabBar hung its press handler on the
 * `<Ionicons>` glyph itself. @expo/vector-icons forwards props to a Text, so
 * the tab's real touch target was the ~22pt glyph box, not the 44pt cell that
 * surrounds it — the padding around every tab icon was dead to the touch, on
 * the one control the user hits most. It was also the only place in the app
 * that did this; every other screen wraps icons in a Touchable.
 *
 * Second defect: the bar rendered no label and no accessibility identity, so
 * the icons (compass / sparkles / wallet / trending-up / people / heart /
 * chatbubbles) had to be guessed, and a screen reader announced nothing useful.
 *
 * The Vitest harness has no React renderer, so this pins both at the source
 * level (same strategy as PromiseSettlementGating.source.test.ts).
 *
 * Per the project's standing doctrine — "a new assertion is not evidence until
 * a negative control has shown it failing" — the detector below is exercised
 * against a deliberately-violating sample in-suite, and the evaluated-item
 * count is asserted non-zero so none of this can pass over an empty population.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommonActions, TabRouter } from '@react-navigation/routers';

const SRC = readFileSync(resolve(__dirname, 'TabNavigator.tsx'), 'utf8');

function opensWallet(source: string): boolean {
    const initial = source.match(/<Tab\.Navigator\s+initialRouteName="([^"]+)"/);
    return initial?.[1] === 'WalletTab' && /<Tab\.Screen\s+name="WalletTab"/.test(source);
}

function selectedRoute(state: { index?: number; routes: readonly { name: string }[] } | null): string | undefined {
    const index = state?.index;
    return index === undefined ? undefined : state?.routes[index]?.name;
}

describe('Daily entry preserves attention and every tab', () => {
    it('opens the wallet, which carries the existing attention bell', () => {
        expect(opensWallet(SRC)).toBe(true);
        expect(SRC).toContain('component={DashboardScreen}');
        expect(SRC).toContain('tabBarBadge: attentionCount');
    });

    it('RED: rejects an unregistered or manifesto-first initial destination', () => {
        expect(opensWallet(SRC.replace('initialRouteName="WalletTab"', 'initialRouteName="VisionTab"'))).toBe(false);
        expect(opensWallet(SRC.replace('name="WalletTab"', 'name="MissingWallet"'))).toBe(false);
    });

    it('the actual tab router opens Wallet and can still reach every registered destination', () => {
        const routeNames = Array.from(SRC.matchAll(/<Tab\.Screen\s+name="([^"]+)"/g), (m) => m[1]);
        const initialRouteName = SRC.match(/<Tab\.Navigator\s+initialRouteName="([^"]+)"/)?.[1];
        const backBehavior = SRC.includes('backBehavior="initialRoute"') ? 'initialRoute' : undefined;
        const router = TabRouter({ initialRouteName, backBehavior });
        const options = { routeNames, routeParamList: {}, routeGetIdList: {} };
        const initial = router.getInitialState(options);
        expect(routeNames).toHaveLength(7);
        expect(selectedRoute(initial)).toBe('WalletTab');
        expect(router.getStateForAction(initial, CommonActions.goBack(), options)).toBeNull();
        for (const name of routeNames) {
            const next = router.getStateForAction(initial, CommonActions.navigate(name), options);
            expect(selectedRoute(next)).toBe(name);
            expect(next?.routes.map((r) => r.name)).toEqual(routeNames);
            if (next && name !== 'WalletTab') {
                const hydrated = router.getRehydratedState(next, options);
                const back = router.getStateForAction(hydrated, CommonActions.goBack(), options);
                expect(selectedRoute(back)).toBe('WalletTab');
            }
        }
        // An invalid destination is refused, rather than passing a reachability check.
        expect(router.getStateForAction(initial, CommonActions.navigate('MissingTab'), options)).toBeNull();
        // RED: setting only initialRouteName silently falls back to firstRoute on Back.
        const legacy = TabRouter({ initialRouteName });
        const legacyInitial = legacy.getInitialState(options);
        const unwantedBack = legacy.getStateForAction(legacyInitial, CommonActions.goBack(), options);
        expect(selectedRoute(unwantedBack)).toBe('VisionTab');
    });
});

/** Finds the defect shape: a press handler sitting on an Ionicons glyph. */
function findPressableGlyphs(source: string): string[] {
    return Array.from(source.matchAll(/<Ionicons\b[^>]*?onPress/gs), (m) => m[0]);
}

/** The tab options blocks, one per registered tab. */
function findTabOptions(source: string): string[] {
    return Array.from(source.matchAll(/tabBarLabelKey:\s*'([^']+)'/g), (m) => m[1]);
}

describe('FloatingTabBar - touch target (negative control included)', () => {
    it('DETECTOR negative control: flags a press handler on an Ionicons glyph', () => {
        const violating = `
            <View style={tabStyles.iconWrap}>
                <Ionicons name={iconName} size={22} color={c} onPress={() => go()} />
            </View>`;
        // RED control: if this ever returns 0 the detector is inert and every
        // assertion below is meaningless.
        expect(findPressableGlyphs(violating)).toHaveLength(1);
    });

    it('no Ionicons in the tab bar carries its own press handler', () => {
        expect(findPressableGlyphs(SRC)).toHaveLength(0);
    });

    it('each tab cell is a Pressable, so the whole cell is the target', () => {
        expect(SRC).toContain('<Pressable');
        expect(SRC).toMatch(/<Pressable[^>]*?\n\s*style=\{tabStyles\.tab\}/s);
        expect(SRC).toMatch(/onPress=\{onPress\}/);
    });

    it('the tab cell has padding, so the target exceeds the glyph box', () => {
        expect(SRC).toMatch(/tab:\s*\{[^}]*paddingVertical:/s);
    });
});

describe('FloatingTabBar - accessibility identity', () => {
    it('exposes tablist / tab roles and selected state', () => {
        expect(SRC).toContain('accessibilityRole="tablist"');
        expect(SRC).toContain('accessibilityRole="tab"');
        expect(SRC).toContain('accessibilityState={{ selected: focused }}');
    });

    it('every tab carries an accessibilityLabel', () => {
        expect(SRC).toContain('accessibilityLabel=');
    });
});

describe('FloatingTabBar - labels are rendered and translated', () => {
    const keys = findTabOptions(SRC);

    it('evaluates a non-empty set of tabs', () => {
        // Guards against the vacuous pass: a universally-quantified claim over
        // zero tabs would otherwise report green.
        expect(keys.length).toBeGreaterThan(0);
        // Vision · Abundance · Wallet · Earn · Commons · Promises · Chat
        expect(keys).toHaveLength(7);
    });

    it('every tab label comes from an i18n key, never a hardcoded string', () => {
        for (const k of keys) expect(k).toMatch(/^nav\./);
        expect(SRC).not.toMatch(/tabBarLabel:\s*'/);
    });

    it('the label is actually rendered, not just declared in options', () => {
        expect(SRC).toContain("const label = t(options.tabBarLabelKey as string)");
        expect(SRC).toMatch(/style=\{\[tabStyles\.label,/);
    });

    it('long locale labels shrink instead of clipping', () => {
        expect(SRC).toContain('adjustsFontSizeToFit');
        expect(SRC).toContain('minimumFontScale');
    });

    it('the pending-approval badge shows its count rather than a bare dot', () => {
        expect(SRC).toMatch(/badge > 9 \? '9\+' : badge/);
        expect(SRC).not.toMatch(/<Ionicons\s+name="ellipse"/);
    });

    it('content behind the floating bar fades out, from the bar TOP EDGE down only ', () => {
        // A scrim exists, never takes touches, and its height is exactly the bar's measured height
        // plus its float offset — so it can never reach above the bar and cover a floating button.
        expect(SRC).toMatch(/<LinearGradient\s+pointerEvents="none"/);
        expect(SRC).toContain('style={[tabStyles.scrim, { height: wrapperBottom + barHeight }]}');
        expect(SRC).toContain('onLayout={(e) => setBarHeight(');
        // RED control: the scrim must be anchored to the screen bottom (a scrim floating with the
        // bar's own `bottom` offset would leave the strip below the bar uncovered).
        expect(SRC).toMatch(/scrim: \{\s*position: 'absolute',\s*left: 0,\s*right: 0,\s*bottom: 0,/);
    });
});
