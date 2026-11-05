/**
 * server.ts load order — an import must appear ABOVE every use of its binding.
 *
 * server.ts does not keep its imports at the top. It interleaves them with the
 * mounts they serve, which is readable and, in a CommonJS emit, load-bearing:
 * `tsc` writes `const routes_x_1 = require(...)` at the import's SOURCE
 * position, so a binding used above its import is a `const` in the temporal
 * dead zone. The process does not warn, does not degrade, and does not fall
 * back — it throws `ReferenceError: Cannot access 'routes_x_1' before
 * initialization` on the first line of module execution and the container never
 * binds a port.
 *
 * Nothing else in the battery sees this. Every unit test imports the ROUTER
 * module directly and passes; typecheck passes because TypeScript's own module
 * semantics hoist imports; the only witness is starting the process. On
 * 2026-09-07 that witness was Cloud Run: `/v1/catalog/harnesses` was mounted
 * ~770 lines above its import, two revisions failed their startup probe, and
 * production stayed on the previous image while the deploy reported success.
 *
 * This is the cheap witness that runs before the expensive one.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER = join(__dirname, 'server.ts');

interface Binding {
  name: string;
  importLine: number;
}

/**
 * Top-level import bindings and the 1-indexed line their `require` is emitted
 * on. Multi-line `import { … }` blocks count from the `import` keyword, which
 * is where tsc places the require.
 */
export function parseTopLevelImports(source: string): Binding[] {
  const lines = source.split('\n');
  const bindings: Binding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^import\s/.test(line)) continue;
    // `import './side-effect';` binds nothing.
    if (/^import\s+['"]/.test(line)) continue;

    // Gather the statement, which may span lines until the `from '…';` tail.
    let stmt = line;
    let j = i;
    while (!/from\s+['"][^'"]+['"];?\s*$/.test(stmt) && j + 1 < lines.length) {
      j++;
      stmt += '\n' + lines[j];
    }

    const clause = stmt.replace(/^import\s+/, '').replace(/\s*from\s+['"][^'"]+['"];?\s*$/, '');
    // `import type { … }` and `import { type X }` are erased entirely.
    if (/^type\s/.test(clause)) { i = j; continue; }

    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const raw of named[1].split(',')) {
        const piece = raw.trim();
        if (!piece || /^type\s/.test(piece)) continue;
        const local = piece.split(/\s+as\s+/).pop()!.trim();
        if (local) bindings.push({ name: local, importLine: i + 1 });
      }
    }
    const beforeBrace = named ? clause.slice(0, clause.indexOf('{')) : clause;
    const dflt = beforeBrace.replace(/,\s*$/, '').replace(/^\*\s+as\s+/, '').trim();
    if (dflt && /^[A-Za-z_$][\w$]*$/.test(dflt)) {
      bindings.push({ name: dflt, importLine: i + 1 });
    }
    i = j;
  }
  return bindings;
}

/** The first 1-indexed line that uses `name` outside an import statement. */
export function firstUseLine(source: string, name: string): number | null {
  const lines = source.split('\n');
  const word = new RegExp(`(^|[^\\w$.'"\`])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^import\s/.test(line)) inImport = true;
    if (inImport) {
      if (/from\s+['"][^'"]+['"];?\s*$/.test(line) || /^import\s+['"]/.test(line)) inImport = false;
      continue;
    }
    const code = line.replace(/\/\/.*$/, '');
    if (word.test(code)) return i + 1;
  }
  return null;
}

describe('server.ts module load order', () => {
  const source = readFileSync(SERVER, 'utf8');
  const bindings = parseTopLevelImports(source);

  it('parses a non-empty set of import bindings', () => {
    // The empty population is not a pass. If the parser stops matching
    // this file's import style, the whole suite would go vacuously green.
    expect(bindings.length).toBeGreaterThan(200);
  });

  it('every imported binding is imported above its first use', () => {
    const violations: string[] = [];
    let checked = 0;

    for (const b of bindings) {
      const use = firstUseLine(source, b.name);
      if (use === null) continue;
      checked++;
      if (use < b.importLine) {
        violations.push(`${b.name}: used at line ${use}, imported at line ${b.importLine}`);
      }
    }

    expect(checked).toBeGreaterThan(150);
    expect(violations).toEqual([]);
  });
});

describe('the load-order guard itself (negative control)', () => {
  // The guard must report a violation it is shown. Without this, a parser that
  // silently matched nothing would look identical to a clean file.
  const broken = [
    "import express from 'express';",
    'const app = express();',
    "app.use('/x', createLateRouter());",
    "import { createLateRouter } from './routes/late';",
  ].join('\n');

  it('detects a binding used above its import', () => {
    const bindings = parseTopLevelImports(broken);
    const late = bindings.find(b => b.name === 'createLateRouter');
    expect(late).toBeDefined();
    expect(firstUseLine(broken, 'createLateRouter')!).toBeLessThan(late!.importLine);
  });

  it('does not flag a binding imported above its use', () => {
    const bindings = parseTopLevelImports(broken);
    const early = bindings.find(b => b.name === 'express');
    expect(early).toBeDefined();
    expect(firstUseLine(broken, 'express')!).toBeGreaterThan(early!.importLine);
  });
});
