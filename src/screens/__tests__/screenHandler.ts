/**
 * Run a screen's ACTUAL handler under vitest.
 *
 * React Native screens cannot be imported here, so the handler's source is cut out of the screen
 * file, transpiled, and evaluated against a context that stands in for the component's scope
 * (state, refs, services). The code under test is the screen's own text, not a copy of it.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Handler = (...args: unknown[]) => Promise<unknown>;

/**
 * `const <name> = async (...) => {...}` or `const <name> = useCallback(async (...) => {...}, [...])`
 * inside the screen at `path`, bound to `context`.
 */
export function screenHandler(path: string, name: string, context: Record<string, unknown>): Handler {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
        if (!found && ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
            if (ts.isArrowFunction(node.initializer)) found = node.initializer;
            else if (ts.isCallExpression(node.initializer) && node.initializer.arguments[0]) found = node.initializer.arguments[0];
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`No handler "${name}" in ${path}`);
    const js = ts.transpileModule(`(${found.getText(source)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
    }).outputText;
    return runInNewContext(js, context) as Handler;
}

/**
 * Stands in for the approval prompt: like the real one, requests queue and each runs its action
 * once its turn comes — a second request made before the first prompt answers still runs.
 */
export function queuedApproval(): { request: (reason: string, action: (approval: { nativeId: null }) => Promise<unknown>) => Promise<unknown>; requests: () => number } {
    let tail: Promise<unknown> = Promise.resolve();
    let count = 0;
    return {
        request: (_reason, action) => {
            count++;
            const run = tail.then(() => action({ nativeId: null }));
            tail = run.catch(() => undefined);
            return run;
        },
        requests: () => count,
    };
}
