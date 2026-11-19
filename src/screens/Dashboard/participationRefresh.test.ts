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
describe('Wallet participation card', () => {
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
