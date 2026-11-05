#!/usr/bin/env node
/**
 * ROUTE REACHABILITY MATRIX — every route, its auth posture, and whether they agree.
 *
 * WHY THIS EXISTS. Two routes were found serving unauthenticated callers with discovery closed:
 * `GET /v1/agents/directory` answered 200, and `GET /v1/agent/wallet/challenge` answered 400 —
 * a 400 where a 401 belongs, which is the signature of a route with NO auth middleware at all
 * (the request reached the handler's own validator). Both were found by hand. Finding two by hand
 * is not evidence there were only two, so this enumerates ALL of them.
 *
 * WHY THE TYPESCRIPT AST AND NOT REGEX. Three earlier regex versions of this tool each reported
 * a confidently wrong matrix, and every one of them was wrong in the direction that hides doors:
 *   1. Line-based argument reading missed every MULTI-LINE route, so
 *      `app.post(\n '/v1/wallet/human/register',\n authenticate, …)` — which answers 401 live —
 *      was reported OPEN.
 *   2. A hand-written auth-middleware allowlist omitted `authenticateAgentSession`, so the 10
 *      routes it gates, including `GET /v1/relay/agent/kill-switch`, were reported OPEN.
 *   3. Regex comment-stripping swallowed real code: it found 78 of server.ts's 102 route openers,
 *      silently DROPPING `POST /v1/devices/register` from the matrix entirely.
 * A matrix that misses routes is worse than no matrix, because its silence reads as coverage.
 * The compiler's own parser cannot make any of those three mistakes.
 *
 * Usage:
 *   node scripts/route-reachability-matrix.mjs              # table
 *   node scripts/route-reachability-matrix.mjs --open       # only ungated routes
 *   node scripts/route-reachability-matrix.mjs --middleware # distinct middleware, for classifying
 *   node scripts/route-reachability-matrix.mjs --self-test  # pin classifier to live-probed truth
 *   node scripts/route-reachability-matrix.mjs --json
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(BACKEND, 'src/routes');
const SERVER = join(BACKEND, 'src/server.ts');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

/**
 * DERIVED FROM `--middleware`, NOT GUESSED. Run that mode after any routing change and classify
 * every `????` row before trusting this table.
 */
const AUTH_MIDDLEWARE = new Set([
  'authenticate',              // wallet auth (phone)
  'authenticateAgent',         // agent API key
  'authenticateWalletRecorder', // wallet-only recorder auth (the retired agent-session bearer's successor)
  'authenticateTrustReader',    // wallet OR agent API key on the trust-profile read
  'authenticateDevice',        // device-bound auth
  'authenticateDeviceOwner',   // device-owner auth, applied at MOUNT level
  'createDeviceRegisterAuth',  // dedicated one-time setup-token auth for /v1/devices/register
  'authenticateCommons',       // commons bearer
  'authenticateGovernance',
  'requireAdminSecret',
  'adminAuth',
  'authenticateWalletOwner',    // local wallet-auth guard in witnesses-github.ts
]);

/**
 * Closes a surface pre-launch without authenticating anyone. Not auth, but a real refusal.
 * `appClientDiscoveryGate` is one: an anonymous (keyless) caller gets 404 — it opens
 * pre-flip ONLY to a caller presenting a Bearer credential (the phone app), so it still closes
 * the surface to the public web.
 */
const LAUNCH_GATE_MIDDLEWARE = new Set(['publicDiscoveryGate', 'publicLaunchGate', 'appClientDiscoveryGate']);

/** Deliberately-open surfaces: health/liveness only. */
const INTENTIONALLY_PUBLIC = new Set(['/health', '/healthz', '/readyz', '/', '/v1/health', '/v1/admin/health']);

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Identifier name for a middleware argument: `foo`, `foo(bar)`, `a.b` → `foo` / `b`. */
function middlewareName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isCallExpression(node)) return middlewareName(node.expression);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function isHandlerLiteral(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Walk every CallExpression in a source file. */
function forEachCall(sf, fn) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) fn(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** `import { a, b } from './routes/x'` → name → 'x'. */
function importMapOf(sf, pattern = /^\.\/routes\/(.+)$/) {
  const map = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const m = st.moduleSpecifier.text.match(pattern);
    if (!m || !st.importClause?.namedBindings) continue;
    const nb = st.importClause.namedBindings;
    if (!ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) map.set(el.name.text, m[1]);
  }
  return map;
}

/**
 * Module-level `const X = 'literal'` → name → value.
 *
 * A mount path is not always written inline: `pvt-public-reads.ts` mounts at
 * `PVT_PUBLIC_READ_MOUNT_PATH` so the mount and its tests cannot disagree.
 * Requiring a string literal silently skipped that mount, and a skipped mount is
 * an invisible route.
 */
function stringConstsOf(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    const decl = ts.isVariableStatement(st) ? st.declarationList : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer)) {
        map.set(d.name.text, d.initializer.text);
      }
    }
  }
  return map;
}

/**
 * MOUNT HELPERS. `server.ts` does not always mount a router itself: the PVT
 * public read surface is mounted by `mountPvtPublicReads(app, deps)`, which
 * lives in `routes/pvt-public-reads.ts` and calls `app.use(...)` there.
 *
 * Following only `app.use` in server.ts reported ZERO routes for that whole
 * surface — seven endpoints simply absent from an inventory whose job is to
 * find the ones nobody remembered. Missing routes is worse than misclassifying
 * them: `pre-launch-surface-gate.test.ts` checks its coverage against these
 * rows, so an invisible route is an unchecked route.
 *
 * This finds `someHelper(app, …)` where `someHelper` is imported from a routes
 * module, and returns those modules so their own `app.use(...)` calls are
 * scanned too. One level deep, deliberately: a mount helper calling another
 * mount helper would need its own reason first.
 */
function mountHelperModules(sf, importMap) {
  const modules = new Set();
  forEachCall(sf, (call) => {
    if (!ts.isIdentifier(call.expression)) return;
    const [first] = call.arguments;
    if (!first || !ts.isIdentifier(first) || first.text !== 'app') return;
    const file = importMap.get(call.expression.text);
    if (file) modules.add(file);
  });
  return [...modules];
}

/**
 * IN-HANDLER credential checks. Express middleware is not the only place this codebase
 * authenticates: webhooks verify an HMAC in the body, the scheduler routes compare a shared
 * secret, `/v1/pe/submit` verifies a device signature, and `agent-record.ts` calls
 * `isPublicDiscoveryOpen` directly instead of mounting the gate. A route doing any of these is
 * CLOSED to an anonymous caller even though no middleware names it — counting it as OPEN would
 * bury the handful of genuinely open doors in ~160 false positives.
 */
const IN_HANDLER_AUTH = [
  'verifyWalletAuthToken', 'verifyAgentSession', 'verifyDeviceSignature', 'verifySchedulerSecret',
  'requireAdminSecret', 'assertAdminSecret', 'ADMIN_API_KEY', 'SCHEDULER_SECRET',
  'timingSafeEqual', 'verifyHmac', 'verifyWebhookSignature', 'verifySignature',
  'isPublicDiscoveryOpen', 'PUBLIC_LAUNCH', 'isAppClientDiscoveryAdmissible',
  'verifyConnectionToken',
  'resolveDeviceAuth', 'requireInternalAuth', 'verifySetupToken',
  'authenticateScheduler',     // OIDC / shared-secret guard on every /v1/internal/scheduler/* route
  'authenticateGitHubWorker',  // dedicated OIDC principal and audience, accepted only on its worker route
  'requireCommonsAuth', 'getCommonsAuth', 'commonsAuthenticate',
  'requireAuth', 'getAuthenticatedWallet',  // commons.ts local closures over verifyWalletAuthToken
];

/** Cache of module source text, for one-level import following. */
const moduleTextCache = new Map();
function localModuleText(fromFile, spec) {
  if (!spec.startsWith('.')) return '';
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
    if (!existsSync(cand)) continue;
    if (!moduleTextCache.has(cand)) moduleTextCache.set(cand, readFileSync(cand, 'utf8'));
    return moduleTextCache.get(cand);
  }
  return '';
}

/**
 * Scan a handler for an in-handler credential check, FOLLOWING ONE LEVEL of local import.
 *
 * The indirection is not incidental: `POST /v1/witnesses/github/webhook` is a three-line handler
 * that delegates to `handleGitHubWebhook`, and the HMAC verification — the actual gate — lives in
 * that module. Scanning only the inline body reported the webhook routes OPEN.
 */
function inHandlerAuth(node, sf) {
  if (!node) return null;
  const text = node.getFullText();
  const scan = (t) => IN_HANDLER_AUTH.filter((p) => t.includes(p));
  let hits = scan(text);

  if (!hits.length && sf) {
    // Resolve identifiers CALLED in this handler back to their local module and scan that.
    const imports = new Map();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) imports.set(el.name.text, st.moduleSpecifier.text);
      }
    }
    for (const name of new Set([...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))) {
      const spec = imports.get(name);
      if (!spec) continue;
      const found = scan(localModuleText(sf.fileName, spec));
      if (found.length) { hits = found.map((h) => `${h}@${name}`); break; }
    }
  }

  // An `authorization` header read plus a 401 is the generic hand-rolled shape.
  if (!hits.length && /headers\.authorization/.test(text) && /401/.test(text)) {
    return 'authorization+401';
  }
  return hits.length ? [...new Set(hits)].join('+') : null;
}

function classify(middleware, fullPath, handler, sf) {
  const auth = middleware.filter((x) => AUTH_MIDDLEWARE.has(x));
  const gate = middleware.filter((x) => LAUNCH_GATE_MIDDLEWARE.has(x));
  if (auth.length) return { posture: 'AUTH', by: [...new Set(auth)].join('+') };
  if (gate.length) return { posture: 'LAUNCH_GATE', by: [...new Set(gate)].join('+') };
  const inner = inHandlerAuth(handler, sf);
  if (inner) return { posture: 'IN_HANDLER', by: inner };
  // A handler whose whole body is a 503 stub with no I/O is INERT: it is reachable but does
  // nothing and touches nothing. These are the runtime boundary quarantine stubs (pvt-mint, advance-epoch,
  // the anchor jobs). Reporting them as OPEN buries the doors that actually do something.
  if (handler) {
    const t = handler.getFullText();
    if (/res\s*\.\s*status\(\s*503\s*\)/.test(t) && !/\bawait\b|\.collection\(|\bdb\b/.test(t)) {
      return { posture: 'INERT_503', by: 'unconfigured stub' };
    }
  }
  if (INTENTIONALLY_PUBLIC.has(fullPath)) return { posture: 'PUBLIC_BY_DESIGN', by: 'health' };
  return { posture: 'OPEN', by: '' };
}

const joinPath = (prefix, sub) => (!sub || sub === '/'
  ? prefix
  : `${prefix.replace(/\/$/, '')}${sub.startsWith('/') ? '' : '/'}${sub}`);

/** Extract `holder.METHOD('/path', ...mw, handler)` from a source file. */
function routesIn(sf, holder) {
  const out = [];
  forEachCall(sf, (call) => {
    const ex = call.expression;
    if (!ts.isPropertyAccessExpression(ex)) return;
    if (!ts.isIdentifier(ex.expression) || ex.expression.text !== holder) return;
    if (!METHODS.has(ex.name.text)) return;
    const [first, ...rest] = call.arguments;
    if (!first || !ts.isStringLiteral(first)) return;
    const mws = [];
    let handler = null;
    for (const arg of rest) {
      if (isHandlerLiteral(arg)) { handler = arg; continue; }
      const n = middlewareName(arg);
      if (n) mws.push(n);
    }
    out.push({ method: ex.name.text.toUpperCase(), path: first.text, middleware: mws, handler });
  });
  return out;
}

/**
 * `router.use(...)` — router-level middleware applies to EVERY route on that router. A path-scoped
 * `router.use('/x', mw)` is recorded with its prefix so it is not applied to unrelated routes.
 */
function routerLevelIn(sf) {
  const global = [];
  forEachCall(sf, (call) => {
    const ex = call.expression;
    if (!ts.isPropertyAccessExpression(ex)) return;
    if (!ts.isIdentifier(ex.expression) || ex.expression.text !== 'router') return;
    if (ex.name.text !== 'use') return;
    const args = [...call.arguments];
    if (args.length && ts.isStringLiteral(args[0])) return; // path-scoped; ignore for global posture
    for (const a of args) {
      if (isHandlerLiteral(a)) continue;
      const n = middlewareName(a);
      if (n) global.push(n);
    }
  });
  return global;
}

function main() {
  const serverSf = parse(SERVER);
  const importMap = importMapOf(serverSf);
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
  const rows = [];

  // Routes declared directly on `app`.
  for (const r of routesIn(serverSf, 'app')) {
    rows.push({ ...r, full: r.path, source: 'server.ts', handler: undefined, ...classify(r.middleware, r.path, r.handler, serverSf) });
  }

  // `app.use('/prefix', ...middleware, createXRouter(deps))` — mount-level middleware is REAL auth
  // and applies to every route on the mounted router. Missing it reported all of /v1/devices/* as
  // open when the mount carries `authenticateDeviceOwner`.
  //
  // `selfBase` lets a mount helper resolve a factory declared in its OWN module
  // (`mountPvtPublicReads` mounts `createPvtPublicReadRouter` from the same file),
  // which no import map can answer.
  const collectAppMounts = (sf, sfImportMap, selfBase) => {
    const stringConsts = stringConstsOf(sf);
    forEachCall(sf, (call) => {
      const ex = call.expression;
      if (!ts.isPropertyAccessExpression(ex)) return;
      if (!ts.isIdentifier(ex.expression) || ex.expression.text !== 'app') return;
      if (ex.name.text !== 'use') return;
      const [first, ...rest] = call.arguments;
      if (!first) return;
      const prefix = ts.isStringLiteral(first)
        ? first.text
        : (ts.isIdentifier(first) ? stringConsts.get(first.text) : undefined);
      if (prefix === undefined) return;

      let factoryFile = null;
      const mountMw = [];
      for (const arg of rest) {
        const n = middlewareName(arg);
        if (!n) continue;
        const f = sfImportMap.get(n)
          ?? (selfBase && /^create[A-Za-z0-9_]*Router$/.test(n) ? selfBase : undefined);
        if (f && !factoryFile) factoryFile = f;
        else mountMw.push(n);
      }
      if (!factoryFile) return;
      const path = join(ROUTES_DIR, `${factoryFile}.ts`);
      if (!existsSync(path) || !files.includes(`${factoryFile}.ts`)) return;

      const routerSf = parse(path);
      const routerLevel = routerLevelIn(routerSf);
      for (const r of routesIn(routerSf, 'router')) {
        const full = joinPath(prefix, r.path);
        const all = [...r.middleware, ...routerLevel, ...mountMw];
        rows.push({
          ...r, full, source: `${factoryFile}.ts`, mountMiddleware: mountMw, routerLevel,
          handler: undefined,
          ...classify(all, full, r.handler, routerSf),
        });
      }
    });
  };

  collectAppMounts(serverSf, importMap, null);

  // …then the same scan inside every mount helper server.ts calls with `app`.
  for (const base of mountHelperModules(serverSf, importMap)) {
    const path = join(ROUTES_DIR, `${base}.ts`);
    if (!existsSync(path) || !files.includes(`${base}.ts`)) continue;
    const helperSf = parse(path);
    collectAppMounts(helperSf, importMapOf(helperSf, /^\.\/([^/]+)$/), base);
  }

  if (process.argv.includes('--middleware')) {
    const counts = new Map();
    for (const r of rows) {
      for (const mw of [...r.middleware, ...(r.routerLevel ?? []), ...(r.mountMiddleware ?? [])]) {
        counts.set(mw, (counts.get(mw) ?? 0) + 1);
      }
    }
    for (const [mw, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const k = AUTH_MIDDLEWARE.has(mw) ? 'AUTH' : LAUNCH_GATE_MIDDLEWARE.has(mw) ? 'GATE' : '????';
      console.log(`${k}  ${String(n).padStart(4)}  ${mw}`);
    }
    return;
  }

  rows.sort((a, b) => a.full.localeCompare(b.full) || a.method.localeCompare(b.method));

  // SELF-TEST — the classifier pinned to routes whose UNAUTHENTICATED response was OBSERVED
  // against live production. A static matrix nobody checked against reality is exactly the kind of
  // evidence this repo keeps discovering was never evidence. NOT_FOUND is its own failure: it
  // means the tool cannot see a route that demonstrably exists.
  if (process.argv.includes('--self-test')) {
    const GROUND_TRUTH = [
      { method: 'GET', full: '/v1/agent/wallet/challenge', observed: 400, expect: 'OPEN' },
      { method: 'GET', full: '/v1/agents/directory', observed: 200, expect: 'OPEN' },
      { method: 'POST', full: '/v1/wallet/human/register', observed: 401, expect: 'AUTH' },
      { method: 'POST', full: '/v1/devices/register', observed: 401, expect: 'AUTH' },
      { method: 'POST', full: '/v1/agent/external-address/challenge', observed: 401, expect: 'AUTH' },
    ];
    let bad = 0;
    for (const g of GROUND_TRUTH) {
      const row = rows.find((r) => r.full === g.full && r.method === g.method);
      const got = row?.posture ?? 'NOT_FOUND';
      const ok = got === g.expect;
      if (!ok) bad += 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${g.method}  ${g.full} — live ${g.observed}, expect ${g.expect}, got ${got}`);
    }
    console.log(bad === 0
      ? `\nself-test ok: ${GROUND_TRUTH.length}/${GROUND_TRUTH.length} match observed production behaviour`
      : `\nSELF-TEST FAILED: ${bad} disagree with observed production behaviour`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const shown = process.argv.includes('--open') ? rows.filter((r) => r.posture === 'OPEN') : rows;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ total: rows.length, rows: shown }, null, 2));
    return;
  }
  console.log(`ROUTE REACHABILITY MATRIX — ${rows.length} routes\n`);
  for (const r of shown) {
    console.log(`${r.posture.padEnd(17)}  ${r.method.padEnd(6)}  ${r.full}${r.by ? `  [${r.by}]` : ''}`);
  }
  const byPosture = rows.reduce((a, r) => ({ ...a, [r.posture]: (a[r.posture] ?? 0) + 1 }), {});
  console.log(`\nSUMMARY: ${JSON.stringify(byPosture)}`);
}

main();
