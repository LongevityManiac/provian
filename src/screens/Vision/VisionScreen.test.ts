import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = readFileSync(resolve(__dirname, 'VisionScreen.tsx'), 'utf8');
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };

// Execute the actual TSX with host elements and synchronous hooks, without a
// native runtime. This exercises placement and the real event handlers.
function screen(owner: boolean, open = true, code = source) {
    const state: unknown[] = [];
    let cursor = 0;
    const share = vi.fn(async () => {});
    const openURL = vi.fn();
    const react = {
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node =>
            ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useCallback: (fn: unknown) => fn,
        useState: (initial: unknown) => {
            const i = cursor++;
            if (!(i in state)) state[i] = initial;
            return [state[i], (value: unknown) => { state[i] = typeof value === 'function' ? value(state[i]) : value; }];
        },
    };
    const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Image', 'TouchableOpacity', 'ActivityIndicator'].map((k) => [k, k]));
    const imports: Record<string, unknown> = {
        react,
        'react-native': { ...native, StyleSheet: { create: (s: unknown) => s }, Platform: { OS: 'ios' }, Share: { share }, Linking: { openURL }, Alert: { alert: vi.fn() } },
        'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
        'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
        '@expo/vector-icons': { Ionicons: 'Ionicons' },
        '@react-navigation/native': { useNavigation: () => ({ canGoBack: () => false, getState: () => ({ type: 'tab' }) }) },
        'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
        '../../constants/theme': { COLORS: {}, SPACING: {} },
        '../../components/BackButton': () => null,
        '../../store/walletStore': { useWalletStore: (select: (s: { onboardingComplete: boolean }) => unknown) => select({ onboardingComplete: owner }) },
        '../Onboarding/genesisWindow': { isGenesisWindowOpen: () => open },
    };
    const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { default: () => Node } };
    new Function('require', 'module', 'exports', compiled)((name: string) => {
        if (name.endsWith('.png')) return name;
        if (!(name in imports)) throw new Error(`Unmocked import ${name}`);
        return imports[name];
    }, mod, mod.exports);
    return { render: () => { cursor = 0; return mod.exports.default(); }, share, openURL };
}
function walk(node: unknown): unknown[] {
    if (!node || typeof node !== 'object' || !('children' in node)) return [node];
    return [node, ...(node as Node).children.flatMap(walk)];
}
const nodes = (tree: Node) => walk(tree).filter((n): n is Node => !!n && typeof n === 'object' && 'props' in n);
const byId = (tree: Node, id: string) => nodes(tree).filter((n) => n.props.testID === id);
const text = (node: Node) => walk(node).filter((n) => typeof n === 'string').join(' ');

describe('Vision wallet-aware Genesis', () => {
    it('keeps the full introduction before the story for someone without a wallet', () => {
        const tree = screen(false).render();
        expect(byId(tree, 'vision-genesis-card')).toHaveLength(1);
        expect(byId(tree, 'vision-genesis-details')).toHaveLength(1);
        expect(byId(tree, 'vision-genesis-details-toggle')).toHaveLength(0);
        expect(walk(tree).indexOf(byId(tree, 'vision-genesis-card')[0])).toBeLessThan(walk(tree).indexOf('visionScreen.opening1'));
    });
    it('places one compact card after the closing, keeping details, sharing and film usable', async () => {
        const s = screen(true);
        let tree = s.render();
        expect(byId(tree, 'vision-genesis-card')).toHaveLength(1);
        expect(walk(tree).indexOf(byId(tree, 'vision-genesis-card')[0])).toBeGreaterThan(walk(tree).indexOf('visionScreen.closingSignoff'));
        expect(byId(tree, 'vision-genesis-details')).toHaveLength(0);
        const card = byId(tree, 'vision-genesis-card')[0];
        const toggle = byId(tree, 'vision-genesis-details-toggle')[0];
        expect(toggle.props.accessibilityState).toEqual({ expanded: false });
        (toggle.props.onPress as () => void)();
        tree = s.render();
        expect(byId(tree, 'vision-genesis-details')).toHaveLength(1);
        expect(text(byId(tree, 'vision-genesis-details')[0])).toContain('visionScreen.genesisFinePrint');
        expect(byId(tree, 'vision-genesis-details-toggle')[0].props.accessibilityState).toEqual({ expanded: true });
        const film = nodes(byId(tree, 'vision-genesis-card')[0]).find((n) => n.props.onPress && text(n) === 'visionScreen.genesisWatch')!;
        (film.props.onPress as () => void)();
        expect(s.openURL).toHaveBeenCalledWith('https://provian.ai/films/genesis-is-open.mp4');
        const shareButton = nodes(byId(tree, 'vision-genesis-card')[0]).find((n) => n.type === 'TouchableOpacity' && n.children.some((c) => !!c && typeof c === 'object' && (c as Node).props.name === 'share-outline'))!;
        await (shareButton.props.onPress as () => Promise<void>)();
        expect(s.share).toHaveBeenCalledTimes(1);
        (byId(tree, 'vision-genesis-details-toggle')[0].props.onPress as () => void)();
        expect(byId(s.render(), 'vision-genesis-details')).toHaveLength(0);
    });
    it.each([false, true])('retires Genesis for wallet owner=%s when its window closes', (owner) => {
        expect(byId(screen(owner, false).render(), 'vision-genesis-card')).toHaveLength(0);
    });
    it('detects the former unconditional top-card behavior as a negative control', () => {
        const mutant = source.replace('genesisOpen && !onboardingComplete', 'genesisOpen');
        expect(mutant).not.toBe(source);
        const tree = screen(true, true, mutant).render();
        expect(byId(tree, 'vision-genesis-card')).toHaveLength(2);
        expect(walk(tree).indexOf(byId(tree, 'vision-genesis-card')[0])).toBeLessThan(walk(tree).indexOf('visionScreen.opening1'));
    });
});
