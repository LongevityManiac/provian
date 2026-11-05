import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

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
function loader(read: () => Promise<object | null>) {
    const state: { accrual: unknown; error: boolean; refreshing: boolean } = { accrual: 'stale', error: true, refreshing: false };
    const relay = { getPVTAccrual: vi.fn(read) };
    const js = ts.transpileModule(`const load = ${initializer(screen, 'loadParticipation')};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const load = new Function('useCallback', 'relayService', 'setPvtRefreshing', 'setPvtAccrual', 'setPvtLoadError', js + ';return load;')(
        (fn: unknown) => fn, relay, (v: boolean) => { state.refreshing = v; }, (v: unknown) => { state.accrual = v; }, (v: boolean) => { state.error = v; },
    ) as () => Promise<void>;
    return { load, state, relay };
}

describe('Wallet participation recovery', () => {
    it('retries a failed read in place and replaces its error with the returned record', async () => {
        const data = { totalPEs: 7, currentSettlementProjection: { available: true, totalPVT: '42.0' } };
        let answer: object | null = null;
        const s = loader(async () => answer);
        await s.load();
        expect(s.state).toEqual({ accrual: null, error: true, refreshing: false });
        answer = data;
        await s.load();
        expect(s.state).toEqual({ accrual: data, error: false, refreshing: false });
        expect(s.relay.getPVTAccrual).toHaveBeenCalledTimes(2);
    });
    it('shows neither stale earnings nor invented zero when the read throws, and ends the spinner', async () => {
        const s = loader(async () => { throw new Error('network down'); });
        await s.load();
        expect(s.state).toEqual({ accrual: null, error: true, refreshing: false });
    });
    it('binds pull refresh and the card retry to the actual shared loader', () => {
        for (const [tag, prop] of [['RefreshControl', 'onRefresh'], ['ParticipationCard', 'onRetry']]) {
            const matches = nodes(screen).filter(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(screen) === tag);
            expect(matches).toHaveLength(1);
            const element = matches[0] as ts.JsxSelfClosingElement;
            const attr = element.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(screen) === prop) as ts.JsxAttribute | undefined;
            expect(attr?.initializer?.getText(screen)).toBe('{loadParticipation}');
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
