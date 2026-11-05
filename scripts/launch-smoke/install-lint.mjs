/**
 * Install-command lint (settlement kernel task 3).
 *
 * Greps the repo's markdown docs for `npm install` / `pip install` lines and
 * verifies every named package actually resolves on its public registry.
 *
 * Pre-flip (default): packages on this launch's publish list
 * (@provian/agent-sdk, @provian/cli, @provian/mcp, provian-sdk) are EXPECTED
 * unpublished — reported, not failed. Any OTHER named package that does not
 * resolve is a doc bug in both modes (pre-flip: WARN so CI stays green until
 * the docs session fixes it; post-flip: FAIL).
 *
 * Post-flip (--post-flip): every named package must resolve. Green or the
 * docs lie.
 *
 * Zero deps. Exit 0 clean, 1 on failures.
 */

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

const PENDING_PUBLISH = new Set(['@provian/agent-sdk', '@provian/cli', '@provian/mcp', 'provian-sdk']);

// Directories scanned for markdown. Keep curated: node_modules and build
// output are never doc surfaces.
const SCAN_DIRS = ['docs', 'provian-agent-sdk', 'provian-cli', 'provian-python-sdk', 'provian-mcp', 'provian-website', 'provian-backend', 'contracts'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', '.next', 'build', 'coverage', '.git']);
// Internal operator docs (runbooks, session prompts, submission plans) are not
// public doc surfaces — they legitimately reference not-yet-published packages
// and would false-fail post-flip.
const SKIP_REL_PATHS = ['docs/launch/'];

function* walkMarkdown(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walkMarkdown(p);
    else if (name.endsWith('.md')) yield p;
  }
}

function extractPackages(line) {
  const pkgs = [];
  const npm = line.match(/npm\s+install(?:\s+-[-\w]+)*\s+(.+)/);
  if (npm) {
    for (const tok of npm[1].split(/\s+/)) {
      if (!tok || tok.startsWith('-')) continue;
      // Skip local paths and URLs — `npm install /path/to/x` or file: specs.
      if (tok.startsWith('/') || tok.startsWith('.') || tok.includes('://') || tok.startsWith('file:')) continue;
      // Strip version specifiers and shell noise.
      const clean = tok.replace(/["'`;)]+$/g, '').replace(/(?<=.)@[~^]?[\d*].*$/, '');
      if (/^(@[\w.-]+\/)?[\w.-]+$/.test(clean)) pkgs.push({ registry: 'npm', name: clean });
    }
  }
  const pip = line.match(/pip\s+install\s+(.+)/);
  if (pip) {
    for (const tok of pip[1].split(/\s+/)) {
      if (!tok || tok.startsWith('-')) continue;
      const unquoted = tok.replace(/^["']|["']$/g, '');
      if (unquoted.startsWith('/') || unquoted.startsWith('.') || unquoted.includes('://')) continue;
      const clean = unquoted.replace(/\[.*\]$/, '').replace(/[=<>!~].*$/, '');
      if (/^[\w.-]+$/.test(clean)) pkgs.push({ registry: 'pypi', name: clean });
    }
  }
  return pkgs;
}

// Only command CONTEXTS are linted: lines inside fenced code blocks, and the
// contents of inline backtick spans in prose. Scanning raw prose lines turned
// sentence fragments after "pip install …" into phantom package names
// ("pypi:and", "npm:Steps"), which post-flip mode escalates to hard failures —
// a guaranteed false-fail of the §6.1 gate. Each context is further split at
// shell operators so a chained `npm install x && npm run build` only
// contributes tokens from its own command segment.
function* commandContexts(line, inFence) {
  // Split at shell operators, then drop trailing `# comment` text per segment.
  const segments = (text) => text.split(/&&|\|\||[;|]/).map((s) => s.split(/\s#/)[0]);
  if (inFence) {
    yield* segments(line);
    return;
  }
  for (const span of line.matchAll(/`([^`]+)`/g)) {
    yield* segments(span[1]);
  }
}

async function npmResolves(pkg) {
  try {
    await execFileP('npm', ['view', pkg, 'version'], { timeout: 30_000 });
    return true;
  } catch (e) {
    if (/404|E404|not found/i.test(`${e.stdout || ''}${e.stderr || ''}`)) return false;
    throw e;
  }
}

async function pypiResolves(pkg) {
  // Without a timeout one stalled connection hangs the whole gate check.
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`PyPI lookup ${pkg}: HTTP ${res.status}`);
}

async function main() {
  const postFlip = process.argv.includes('--post-flip');

  // Collect package -> [file:line, ...]
  const found = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walkMarkdown(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (SKIP_REL_PATHS.some((p) => rel.startsWith(p))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      let inFence = false;
      lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          return;
        }
        if (!/\b(npm|pip)\s+install\b/.test(line)) return;
        for (const ctx of commandContexts(line, inFence)) {
          for (const pkg of extractPackages(ctx)) {
            const key = `${pkg.registry}:${pkg.name}`;
            if (!found.has(key)) found.set(key, { ...pkg, refs: [] });
            found.get(key).refs.push(`${rel}:${i + 1}`);
          }
        }
      });
    }
  }

  if (found.size === 0) {
    console.log('[install-lint] no install commands found in docs — nothing to verify');
    return;
  }

  // Resolve with bounded concurrency — ~150 sequential registry lookups blow
  // past the smoke runner's per-check timeout.
  const entries = [...found.values()];
  const CONCURRENCY = 8;
  const resolved = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      const { registry, name } = entries[i];
      resolved[i] = registry === 'npm' ? await npmResolves(name) : await pypiResolves(name);
    }
  }));

  const failures = [];
  const pendings = [];
  const warns = [];
  entries.forEach(({ registry, name, refs }, i) => {
    const resolves = resolved[i];
    const where = refs.slice(0, 3).join(', ') + (refs.length > 3 ? ` (+${refs.length - 3} more)` : '');
    if (resolves) {
      console.log(`  ✓ ${registry}:${name} resolves (${where})`);
    } else if (PENDING_PUBLISH.has(name)) {
      if (postFlip) failures.push(`${registry}:${name} still unpublished post-flip (${where})`);
      else pendings.push(`${registry}:${name} pending this launch's publish (${where})`);
    } else if (postFlip) {
      failures.push(`${registry}:${name} does not resolve — docs reference a nonexistent package (${where})`);
    } else {
      warns.push(`${registry}:${name} does not resolve and is NOT on the publish list — doc bug (${where})`);
    }
  });

  for (const p of pendings) console.log(`  - ${p}`);
  for (const w of warns) console.log(`  ! WARN ${w}`);
  for (const f of failures) console.error(`  ✗ ${f}`);

  console.log(`[install-lint] ${found.size} packages referenced: ${found.size - failures.length - pendings.length - warns.length} resolve, ${pendings.length} pending publish, ${warns.length} warn, ${failures.length} fail`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[install-lint] fatal:', e);
  process.exit(1);
});
