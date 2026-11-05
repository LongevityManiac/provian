import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Exercise the actual default stdout writer and bootstrap exit pattern through an OS pipe. */
it('flushes a large JSON response before process.exit; the no-await control truncates it', async () => {
  const path = resolve(__dirname, 'act-verbs.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'runActVerbCli');
  expect(fn).toBeDefined();
  const code = ts.transpileModule(fn!.getText(source).replace('export async', 'async'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  expect(code).toContain('await io.stdout(text);');
  // Only the action's result and unrelated collaborators are mocked. The default
  // process.stdout.write callback, await, and process.exit run unchanged in Node.
  const prelude = `
    const runActVerb = async () => ({
      messages: Array.from({ length: 100 }, (_, id) => ({ id, text: 'message '.repeat(2000) })),
      reply_policy: { mode: 'ask_me_first' }, tail: 'complete'
    });
    const scrubSecrets = text => text;
    const unreadMailNotice = () => null;
  `;
  const pipe = (body: string): Promise<{ code: number | null; output: string; errors: string }> =>
    new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['-e', `${prelude}\n${body}\nrunActVerbCli('threads', [], { mailNotice: () => null }).then(code => process.exit(code));`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [], errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      child.on('error', reject);
      child.on('close', (exitCode) => resolveResult({ code: exitCode, output: Buffer.concat(output).toString('utf8'), errors: Buffer.concat(errors).toString('utf8') }));
    });
  const complete = await pipe(code);
  expect(complete.code).toBe(0);
  expect(complete.errors).toBe('');
  expect(Buffer.byteLength(complete.output)).toBeGreaterThan(65_536);
  const parsed = JSON.parse(complete.output);
  expect(parsed.messages).toHaveLength(100);
  expect(parsed.messages[99]).toEqual({ id: 99, text: 'message '.repeat(2000) });
  expect(parsed.reply_policy).toEqual({ mode: 'ask_me_first' });
  expect(parsed.tail).toBe('complete');

  const truncated = await pipe(code.replace('await io.stdout(text);', 'io.stdout(text);'));
  expect(truncated.code).toBe(0);
  expect(truncated.errors).toBe('');
  expect(Buffer.byteLength(truncated.output)).toBeLessThan(Buffer.byteLength(complete.output));
  expect(() => JSON.parse(truncated.output)).toThrow();
});
