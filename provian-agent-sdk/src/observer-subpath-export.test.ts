/**
 * `@provian/agent-sdk/observer` resolves (EXTERNAL_DEVICE_INTEGRATION.md §11b).
 *
 * The package's REAL `package.json` is installed into a throwaway `node_modules/@provian/agent-sdk`,
 * every file its `exports` map targets is laid down, and Node's own resolver (`createRequire`) is
 * asked for `@provian/agent-sdk/observer` from a consumer beside it. The `types` condition is checked
 * the same way. Each `exports` target is then mapped back through the build (`rootDir: ./src` →
 * `outDir: dist`) to the source entry that `npm run build` compiles to it, and that entry is loaded
 * to prove it carries the names the doc imports.
 *
 * Negative control (permanent, in-suite): the same harness with `./observer` removed from the map
 * must refuse the specifier with ERR_PACKAGE_PATH_NOT_EXPORTED, so the positive case cannot pass on
 * a resolver that accepts anything.
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join, relative, sep } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as observer from './observer';
import * as root from './index';
import type { ObserverPlugin } from './observer';
import type { ObserverPlugin as RootObserverPlugin } from './index';

const PKG_ROOT = join(__dirname, '..');
const REAL_PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  files: string[];
  exports: Record<string, string | Record<string, string>>;
  typesVersions?: Record<string, Record<string, string[]>>;
};

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function targetsOf(entry: string | Record<string, string>): string[] {
  return typeof entry === 'string' ? [entry] : Object.values(entry);
}

/** Install `pkg` under a temp node_modules with every exports target present; return a consumer require. */
function installFake(pkg: typeof REAL_PKG): { require: NodeRequire; pkgDir: string } {
  // realpath: macOS tmpdir is a /var → /private/var symlink, and the resolver returns real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provian-sdk-exports-')));
  tmpRoots.push(root);
  const pkgDir = join(root, 'node_modules', '@provian', 'agent-sdk');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
  for (const entry of Object.values(pkg.exports)) {
    for (const target of targetsOf(entry)) {
      const file = join(pkgDir, target);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, file.endsWith('.json') ? '{}' : 'module.exports = {};\n');
    }
  }
  const consumer = join(root, 'consumer.js');
  writeFileSync(consumer, '');
  return { require: createRequire(consumer), pkgDir };
}

/** dist/<x>.js | dist/<x>.d.ts → src/<x>.ts (tsconfig.build.json: rootDir ./src, outDir dist). */
function sourceOf(distTarget: string): string {
  const rel = distTarget.replace(/^\.\//, '');
  expect(rel.startsWith('dist/')).toBe(true);
  return join(PKG_ROOT, 'src', rel.slice('dist/'.length).replace(/\.d\.ts$|\.js$/, '.ts'));
}

describe('@provian/agent-sdk/observer subpath export', () => {
  it('Node resolves the subpath through the real exports map to the built observer entry', () => {
    const { require: req, pkgDir } = installFake(REAL_PKG);
    const resolved = req.resolve('@provian/agent-sdk/observer');
    expect(relative(pkgDir, resolved).split(sep).join('/')).toBe('dist/observer/index.js');
  });

  it('declares a types condition beside require, as the root entry does', () => {
    const entry = REAL_PKG.exports['./observer'];
    expect(typeof entry).toBe('object');
    const conds = entry as Record<string, string>;
    expect(conds.types).toBe('./dist/observer/index.d.ts');
    expect(conds.require).toBe('./dist/observer/index.js');
    expect(Object.keys(conds)).toEqual(Object.keys(REAL_PKG.exports['.'] as Record<string, string>));
    // moduleResolution node10 ignores `exports`; typesVersions points it at the same declarations.
    expect(REAL_PKG.typesVersions?.['*']?.observer).toEqual([conds.types.replace(/^\.\//, '')]);
  });

  it('every ./observer target is compiled from src/observer/index.ts, which the published files ship', () => {
    const targets = targetsOf(REAL_PKG.exports['./observer']);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(existsSync(sourceOf(t))).toBe(true);
    expect(new Set(targets.map(sourceOf))).toEqual(new Set([join(PKG_ROOT, 'src', 'observer', 'index.ts')]));
    expect(REAL_PKG.files).toContain('dist');
  });

  it('the observer entry and the root entry export the names the doc imports', () => {
    expect(typeof observer.ProvianObserver).toBe('function');
    expect(typeof observer.ProcessPlugin).toBe('function');
    expect(root.ProvianObserver).toBe(observer.ProvianObserver);
    expect(root.ProcessPlugin).toBe(observer.ProcessPlugin);
    // Type-only export: compile-time check that ObserverPlugin is reachable from both entries.
    const asPlugin: ObserverPlugin | null = null;
    const asRootPlugin: RootObserverPlugin | null = asPlugin;
    expect(asRootPlugin).toBeNull();
  });

  it('NEGATIVE CONTROL: without ./observer in the map the same resolver refuses the subpath', () => {
    const { './observer': _dropped, ...rest } = REAL_PKG.exports;
    const { require: req } = installFake({ ...REAL_PKG, exports: rest });
    let code: unknown = null;
    try {
      req.resolve('@provian/agent-sdk/observer');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
