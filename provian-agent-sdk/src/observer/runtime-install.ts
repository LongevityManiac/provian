/**
 * runtime-install — the ONE decision of which on-disk artifact the machine's
 * long-lived hooks are allowed to point at.
 *
 * WHY THIS EXISTS (2026-09-07). The Atlas Mac mini was set up with what the
 * runbook called a "delete-safe global install": build the SDK from a checkout,
 * `npm install -g .`, then delete the checkout. npm did not copy the package —
 * it SYMLINKED it — so `@provian/agent-sdk` pointed back into the source tree.
 * Both bakers resolve their target from `__dirname`, which follows that symlink,
 * so the launchd plist and the global git post-commit hook were written with
 * source-tree paths. When the checkout was deleted:
 *
 *   - every Provian CLI became a dangling symlink,
 *   - the git hook silently stopped reporting,
 *   - and the observer survived ONLY because its process had already loaded its
 *     code; `KeepAlive` would have failed forever on the next restart.
 *
 * The machine looked healthy and was, in fact, one process exit from permanent
 * silence.
 *
 * THE RULE THIS MODULE ENFORCES: a path is bakeable only if it is a real,
 * installed artifact. A source tree is never bakeable, and the check is not
 * "does the file exist right now" — the symlink existed and resolved fine on the
 * day it was baked. It is "is this an artifact whose lifetime is independent of
 * a developer's working copy".
 *
 * Preference order, most durable first:
 *   1. The single-file bundle in `~/.provian` — already a real copy in our own
 *      directory, with no dependency tree to lose. The hosted bootstrap puts it
 *      there, and it survives deleting any checkout.
 *   2. A genuine npm-installed package (ships `dist/`, ships NO `src/`) → its
 *      own compiled scripts. npm owns the lifetime; that is a real install.
 *   3. A source tree → REFUSED, loudly, naming the reason.
 *
 * Resolution is PURE: it decides, it does not copy. Nothing here writes to the
 * filesystem, so asking "what would be baked?" is safe to do anywhere,
 * including from a test on a developer's machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/** Where the hosted `curl … | sh` bootstrap drops the bundle it downloaded. */
export const HOSTED_BUNDLE = path.join(homedir(), '.provian', 'agent.js');

export type RuntimeKind = 'bundle' | 'package';

export interface RuntimeTarget {
  kind: RuntimeKind;
  /** Absolute, realpath-resolved. Never inside a source tree. */
  root: string;
  /** argv for `<node> …` that runs the observer daemon. */
  observerArgs: string[];
  /** argv for `<node> …` that reports a PE. */
  reportPeArgs: string[];
}

export class SourceTreeRefusal extends Error {
  constructor(readonly offendingPath: string) {
    super(
      `Refusing to install against a source checkout (${offendingPath}). ` +
      'A checkout can be moved or deleted, which silently kills the observer and the git hook. ' +
      'Install the published package or run the hosted bootstrap so there is a real copy to point at.',
    );
    this.name = 'SourceTreeRefusal';
  }
}

export interface RuntimeProbe {
  exists(p: string): boolean;
  isDir(p: string): boolean;
  realpath(p: string): string;
}

export const realProbe: RuntimeProbe = {
  exists: (p) => { try { fs.statSync(p); return true; } catch { return false; } },
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
};

/**
 * Is `pkgRoot` a developer's working copy rather than an installed package?
 *
 * A published npm package ships `dist/` and NOT `src/` or `tsconfig.json`
 * (`files` in package.json excludes them). A checkout has the opposite shape.
 * That difference is the whole test — deliberately structural, because the
 * symlink that caused the outage pointed at something that existed, was
 * readable, and ran correctly right up until it did not.
 */
export function looksLikeSourceTree(pkgRoot: string, probe: RuntimeProbe = realProbe): boolean {
  return probe.isDir(path.join(pkgRoot, 'src')) && probe.exists(path.join(pkgRoot, 'tsconfig.json'));
}

/**
 * The package root that CONTAINS this module, with every symlink resolved.
 *
 * Resolving is the point: `__dirname` under a linked global install reports the
 * link's path, which is what got baked. `realpathSync` reports where the bytes
 * actually live, which is what `looksLikeSourceTree` must judge.
 */
export function resolvePackageRoot(moduleDir: string, probe: RuntimeProbe = realProbe): string {
  // dist/observer → dist → package root
  return probe.realpath(path.resolve(moduleDir, '..', '..'));
}

/** Is this path shaped like the self-contained single-file bundle? */
export function isBundlePath(p: string): boolean {
  return path.basename(p) === 'agent.js';
}

export interface ResolveRuntimeOptions {
  probe?: RuntimeProbe;
  /** Directory of the calling module (default: this module's own). */
  moduleDir?: string;
  /** The hosted bootstrap exports PROVIAN_BUNDLE_PATH when it is the runner. */
  bundlePath?: string;
  /** Override for tests. */
  hostedBundle?: string;
}

/**
 * Pick the artifact to bake, materializing a real copy when one is available.
 *
 * Throws `SourceTreeRefusal` rather than baking a checkout path. That refusal is
 * the entire fix: the previous code silently preferred whatever `__dirname`
 * pointed at, which is how a working machine was left one restart from dead.
 */
export function resolveRuntimeTarget(options: ResolveRuntimeOptions = {}): RuntimeTarget {
  const probe = options.probe ?? realProbe;
  const hosted = options.hostedBundle ?? HOSTED_BUNDLE;
  const moduleDir = options.moduleDir ?? __dirname;

  // 1. A single-file bundle: already a real copy, already in our directory.
  //    `bundlePath` is set by the hosted bootstrap when IT is the runner; an
  //    empty string means "not set" and must never become `node "" observe`.
  //    An EXPLICIT bundlePath is the caller asserting where the running bundle
  //    is; the auto-detected hosted path must be probed for existence first.
  const candidate = options.bundlePath || (probe.exists(hosted) ? hosted : null);
  if (candidate && isBundlePath(candidate)) {
    return bundleTarget(probe.realpath(candidate));
  }

  // 2. A genuine npm-installed package.
  const pkgRoot = resolvePackageRoot(moduleDir, probe);
  if (looksLikeSourceTree(pkgRoot, probe)) {
    // 3. Refuse. This is the case that broke Atlas.
    throw new SourceTreeRefusal(pkgRoot);
  }
  return {
    kind: 'package',
    root: pkgRoot,
    observerArgs: [path.join(pkgRoot, 'dist', 'scripts', 'start-observer.js')],
    reportPeArgs: [path.join(pkgRoot, 'dist', 'scripts', 'report-pe.js')],
  };
}

function bundleTarget(bundle: string): RuntimeTarget {
  return {
    kind: 'bundle',
    root: bundle,
    observerArgs: [bundle, 'observe'],
    reportPeArgs: [bundle, 'report-pe'],
  };
}

export interface BakedTargetHealth {
  ok: boolean;
  /** Executable/script paths referenced by installed hooks that do NOT resolve. */
  broken: string[];
  checked: string[];
}

/**
 * Do the paths already baked into long-lived hooks still resolve?
 *
 * This is the check nothing performed on the Mini for eleven days. It reads
 * the installed artifacts themselves rather than recomputing what they SHOULD
 * say, because the failure mode is precisely a stale correct-looking file.
 */
export function checkBakedTargets(paths: string[], probe: RuntimeProbe = realProbe): BakedTargetHealth {
  const broken = paths.filter((p) => !probe.exists(p));
  return { ok: broken.length === 0, broken, checked: paths };
}

/** Every `node <script>` path referenced by a launchd plist / systemd unit / hook file. */
export function extractScriptPaths(content: string): string[] {
  const out = new Set<string>();
  // launchd: <string>/abs/path.js</string>; systemd/hook: single- or double-quoted paths.
  for (const m of content.matchAll(/["'>\s]((?:\/[^"'<>\s]+?)\.(?:js|cjs|mjs))["'<\s]/g)) {
    out.add(m[1]);
  }
  return [...out];
}
