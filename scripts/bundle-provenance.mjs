#!/usr/bin/env node
/** Bind the bytes bundled for a release to its checkout and distribution channel. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function assertCleanCheckout(cwd = root) {
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd }).toString().trim()) {
    throw new Error('Release bundling requires a clean committed checkout, including untracked sources');
  }
}
export function sourceDigest() {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'index.ts', 'App.tsx', 'src', 'shims', 'assets', 'modules', 'package.json', 'package-lock.json', 'babel.config.js', 'metro.config.js'], { cwd: root }).toString().split('\0').filter(Boolean)
    .filter(p => !p.endsWith('.test.ts') && !p.includes('/__tests__/'));
  if (!files.length) throw new Error('No bundle sources found');
  const hash = createHash('sha256');
  for (const path of files.sort()) { hash.update(path + '\0'); hash.update(readFileSync(join(root, path))); }
  return hash.digest('hex');
}
export function verifyBundle(bundle, stamp) {
  const parsed = JSON.parse(stamp);
  if (!/^[a-f0-9]{40}$/.test(parsed.head) || !/^[a-f0-9]{64}$/.test(parsed.sources)
    || !['ios', 'play', 'website'].includes(parsed.channel)) throw new Error('Invalid provenance');
  if (!bundle.includes(Buffer.from(stamp))) throw new Error('Bundle does not contain the expected source/channel provenance');
  return { ...parsed, bundle_sha256: createHash('sha256').update(bundle).digest('hex'), bundle_bytes: bundle.length };
}
const [cmd, arg, stamp] = process.argv.slice(2);
if (cmd === 'stamp') {
  if (!['ios', 'play', 'website'].includes(arg)) throw new Error('Unknown channel');
  assertCleanCheckout();
  console.log(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), sources: sourceDigest(), channel: arg }));
} else if (cmd === 'verify') {
  const bundle = statSync(arg).isDirectory() ? readFileSync(join(arg, 'main.jsbundle'))
    : execFileSync('unzip', ['-p', arg, arg.endsWith('.aab') ? 'base/assets/index.android.bundle' : 'assets/index.android.bundle'], { maxBuffer: 100 * 1024 * 1024 });
  console.log(JSON.stringify(verifyBundle(bundle, stamp), null, 2));
}
