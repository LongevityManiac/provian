import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Execute the screen's actual setup finisher; React Native rendering is irrelevant to its action lifetime.
const source = readFileSync('src/screens/Onboarding/BiometricSetupScreen.tsx', 'utf8');
const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let finisher: ts.ArrowFunction | undefined;
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'finishSetup' && node.initializer && ts.isArrowFunction(node.initializer)) finisher = node.initializer;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'finishSetup') calls.push(node);
    ts.forEachChild(node, visit);
}
visit(ast);
function setup(register: () => Promise<boolean>) {
    if (!finisher) throw new Error('No setup finisher found');
    const relay = { ensureHumanWalletRegistered: vi.fn(register) };
    const storage = { setItem: vi.fn(async () => undefined) };
    const navigate = vi.fn();
    const js = ts.transpileModule(`const finish = ${finisher.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const finish = new Function('RelayAPIService', 'setAddress', 'AsyncStorage', 'setTimeout', 'navigation', js + ';return finish;')(relay, vi.fn(), storage, (fn: () => void) => fn(), { navigate }) as (address: string, action: object) => Promise<void>;
    return { finish, relay, storage, navigate };
}
describe('first-session onboarding registration', () => {
    it('both fresh and resumed setup await the finisher with their live action', () => {
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(ts.isAwaitExpression(call.parent)).toBe(true);
            expect(call.arguments[1]?.getText(ast)).toBe('biometricAction');
        }
    });
    it('keeps setup open until the same approved action finishes registration', async () => {
        let resolve!: (ok: boolean) => void;
        const pending = new Promise<boolean>(r => { resolve = r; });
        const s = setup(() => pending);
        const action = { nativeId: 'creation' };
        const completed = s.finish('0xabc', action);
        expect(s.relay.ensureHumanWalletRegistered).toHaveBeenCalledWith('0xabc', undefined, action);
        expect(s.navigate).not.toHaveBeenCalled();
        expect(s.storage.setItem).not.toHaveBeenCalled();
        resolve(true);
        await completed;
        expect(s.navigate).toHaveBeenCalledWith('CloudBackupConfirm');
    });
    it('continues through mandatory backup when registration is refused', async () => {
        const s = setup(async () => false);
        await expect(s.finish('0xabc', {})).resolves.toBeUndefined();
        expect(s.navigate).toHaveBeenCalledExactlyOnceWith('CloudBackupConfirm');
        expect(s.storage.setItem).toHaveBeenCalledWith('@provian_device_key_created', 'true');
    });
    it('continues through mandatory backup when registration throws', async () => {
        const s = setup(async () => { throw new Error('offline'); });
        await expect(s.finish('0xabc', {})).resolves.toBeUndefined();
        expect(s.navigate).toHaveBeenCalledExactlyOnceWith('CloudBackupConfirm');
        expect(s.storage.setItem).toHaveBeenCalledWith('@provian_device_key_created', 'true');
    });
});
