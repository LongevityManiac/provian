import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { initialWalletTop, readWithRetry, seedWalletTop, startWalletTop, succeedWalletTop, failWalletTop, WALLET_TOP_RETRY_DELAYS_MS, type WalletTopShown } from '../../core/wallet/walletTopLoad';

const screen = ts.createSourceFile('dashboard.tsx', readFileSync('src/screens/Dashboard/DashboardScreen.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const card = ts.createSourceFile('card.tsx', readFileSync('src/components/ParticipationCard.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(ast: ts.SourceFile): ts.Node[] {
    const out: ts.Node[] = [];
    function visit(node: ts.Node): void { out.push(node); ts.forEachChild(node, visit); }
    visit(ast); return out;
}
function initializer(ast: ts.SourceFile, name: string): string {
    const node = nodes(ast).find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name);
    if (!node || !ts.isVariableDeclaration(node) || !node.initializer) throw new Error(`Missing ${name}`);
    return node.initializer.getText(ast);
}
function loader(read: () => Promise<object | null>, seeded: object | null = null) {
    let shown: WalletTopShown<object> = seeded ? seedWalletTop(initialWalletTop<object>(), seeded, 100) : initialWalletTop<object>();
    const state = { refreshing: false, saved: [] as unknown[] };
    const relay = { getPVTAccrual: vi.fn(read) };
    const run = { current: 0 };
    const js = ts.transpileModule(`const load = ${initializer(screen, 'loadParticipation')};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const load = new Function(
        'useCallback', 'relayService', 'setPvtRefreshing', 'setParticipation', 'participationRun', 'address',
        'readWithRetry', 'startWalletTop', 'succeedWalletTop', 'failWalletTop', 'saveWalletTop',
        js + ';return load;',
    )(
        (fn: unknown) => fn, relay, (v: boolean) => { state.refreshing = v; },
        (next: WalletTopShown<object> | ((prev: WalletTopShown<object>) => WalletTopShown<object>)) => {
            shown = typeof next === 'function' ? next(shown) : next;
        },
        run, '0xabc',
        (r: () => Promise<object | null>, o: object) => readWithRetry(r, { ...o, sleep: async () => undefined }),
        startWalletTop, succeedWalletTop, failWalletTop,
        (_k: string, _a: string, v: unknown) => { state.saved.push(v); },
    ) as () => Promise<void>;
    return { load, state, relay, shown: () => shown };
}

describe('Wallet participation recovery', () => {
    it('retries a failed read in place and replaces its error with the returned record', async () => {
        const data = { totalPEs: 7, currentSettlementProjection: { available: true, totalPVT: '42.0' } };
        let answer: object | null = null;
        const s = loader(async () => answer);
        await s.load();
        expect(s.shown()).toEqual({ value: null, savedAtMs: null, phase: 'failed' });
        expect(s.relay.getPVTAccrual).toHaveBeenCalledTimes(WALLET_TOP_RETRY_DELAYS_MS.length + 1);
        answer = data;
        await s.load();
        expect(s.shown().value).toEqual(data);
        expect(s.shown().phase).toBe('fresh');
        expect(s.state.saved).toEqual([data]);
        expect(s.state.refreshing).toBe(false);
    });
    it('never invents a zero for a failed read, and ends the spinner', async () => {
        const s = loader(async () => { throw new Error('network down'); });
        await s.load();
        expect(s.shown()).toEqual({ value: null, savedAtMs: null, phase: 'failed' });
        expect(s.state.refreshing).toBe(false);
    });
    it('keeps the saved answer on screen when every retry fails', async () => {
        const saved = { totalPEs: 3, currentSettlementProjection: { available: false } };
        const s = loader(async () => null, saved);
        await s.load();
        expect(s.shown()).toEqual({ value: saved, savedAtMs: 100, phase: 'saved' });
        expect(s.state.saved).toEqual([]);
    });
    it('the card shows the error only in the failed phase', () => {
        const element = nodes(screen).find(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(screen) === 'ParticipationCard') as ts.JsxSelfClosingElement;
        const attr = (name: string) => (element.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(screen) === name) as ts.JsxAttribute | undefined)?.initializer?.getText(screen);
        expect(attr('loadError')).toBe("{participation.phase === 'failed'}");
        expect(attr('pvtAccrual')).toBe('{participation.value}');
    });
    it('binds pull refresh and the card retry to the actual shared loader', () => {
        for (const [tag, prop] of [['RefreshControl', 'onRefresh'], ['ParticipationCard', 'onRetry']]) {
            const matches = nodes(screen).filter(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(screen) === tag);
            expect(matches).toHaveLength(1);
            const element = matches[0] as ts.JsxSelfClosingElement;
            const attr = element.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(screen) === prop) as ts.JsxAttribute | undefined;
            if (tag === 'ParticipationCard') expect(attr?.initializer?.getText(screen)).toBe('{loadParticipation}');
            else {
                const expression = (attr?.initializer as ts.JsxExpression)?.expression;
                if (!expression) throw Error('Missing pull refresh handler');
                const participation = vi.fn(), balances = vi.fn();
                const handler = new Function('loadParticipation', 'refreshBalances', `return ${expression.getText(screen)}`)(participation, balances);
                handler();
                expect(participation).toHaveBeenCalledOnce();
                expect(balances).toHaveBeenCalledOnce();
            }
        }
    });
    it('the card retries on error while successful records still open the chain', () => {
        const retryOf = new Function('isLoadError', 'onRetry', `return ${initializer(card, 'retry')};`) as (failed: boolean, retry: unknown) => unknown;
        const element = nodes(card).find(n => ts.isJsxOpeningElement(n) && n.tagName.getText(card) === 'TouchableOpacity') as ts.JsxOpeningElement;
        const attr = element.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(card) === 'onPress') as ts.JsxAttribute;
        if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) throw new Error('Missing card press handler');
        const pressOf = new Function('retry', 'onPress', `return ${attr.initializer.expression.getText(card)};`) as (retry: unknown, onPress: unknown) => () => void;
        const retry = vi.fn(), navigate = vi.fn();
        pressOf(retryOf(true, retry), navigate)();
        expect(retry).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
        pressOf(retryOf(false, retry), navigate)();
        expect(navigate).toHaveBeenCalledOnce();
    });
});
