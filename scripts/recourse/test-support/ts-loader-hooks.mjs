// Test-only module hooks: compile the TypeScript files the recourse CLIs import (the relay's shared
// modules under provian-backend/src) to ES modules with esbuild, so a CLI started by a test loads
// the same way on every Node. Bare Node 20 cannot load .ts at all, and Node 22+ strips types but
// loads a .ts in provian-backend (a CommonJS package) as CommonJS, which hides its named exports.
// The CLIs and the modules themselves are unchanged; only how a test starts them.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const TS = /\.(c|m)?tsx?$/;
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

function resolveTs(specifier, parentURL) {
  if (!parentURL || !TS.test(new URL(parentURL).pathname)) return null;
  if (!(specifier.startsWith('./') || specifier.startsWith('../')) || HAS_EXTENSION.test(specifier)) return null;
  for (const suffix of ['.ts', '.tsx', '/index.ts']) {
    const candidate = new URL(specifier + suffix, parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return null;
}

function loadTs(url) {
  if (!url.startsWith('file:') || !TS.test(new URL(url).pathname)) return null;
  const path = fileURLToPath(url);
  const { code } = transformSync(readFileSync(path, 'utf8'), {
    loader: path.endsWith('x') ? 'tsx' : 'ts', format: 'esm', target: 'node20', sourcefile: path,
  });
  return { format: 'module', source: code, shortCircuit: true };
}

// Synchronous hooks, for module.registerHooks (Node 22.15+ and 23.5+).
export const syncHooks = {
  resolve: (specifier, context, next) => resolveTs(specifier, context.parentURL) ?? next(specifier, context),
  load: (url, context, next) => loadTs(url) ?? next(url, context),
};

// Asynchronous hooks, for module.register (Node 20, where registerHooks does not exist).
export async function resolve(specifier, context, next) {
  return resolveTs(specifier, context.parentURL) ?? next(specifier, context);
}
export async function load(url, context, next) {
  return loadTs(url) ?? next(url, context);
}
