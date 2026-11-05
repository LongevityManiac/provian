#!/usr/bin/env node
/**
 * check-connection-token-format-parity — standing CI guard that the two
 * canonical connection-token-format modules cannot silently diverge.
 *
 * There are two canonical sources BY NECESSITY: the relay owns
 * provian-backend/src/core/connection-token-format.ts
 * and the SDK is a separately published package that cannot import across the
 * package boundary, so
 * provian-agent-sdk/src/connection-token-format.ts
 * MIRRORS it. That is a live duplication of the exact value that already drifted
 * THREE times (the 14-vs-16 bug: a real code is 14-char `PROV-XXXX-XXXX`, but
 * copies guarded `{16,256}` and rejected every real code). A future one-sided
 * edit to one module and not the other would silently break real codes at
 * whichever side lagged.
 *
 * This guard fails the build if the two modules diverge on any of the three axes
 * that DEFINE the format — ALPHABET, PATTERN shape (via GROUP + the RegExp
 * template), and LENGTH — so the copies cannot silently disagree again.
 *
 * Home: the Removed-Decision Registry `copy-guards` job (dependency-free, no npm
 * install), the same home as check-mcp-tool-parity.mjs / check-armed-state-copy.mjs,
 * which runs on every push-to-master and every pull_request — so divergence is
 * caught on the PR, before merge. `--self-test` plants a divergence on each axis
 * and requires detection (a guard that cannot fail is not evidence).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'provian-backend', 'src', 'core', 'connection-token-format.ts');
const SDK = join(ROOT, 'provian-agent-sdk', 'src', 'connection-token-format.ts');

// The three axes that fully determine the connection-code format. GROUP + PATTERN
// together capture the regex SHAPE (a `{4}`→`{5}`, an added group, or a changed
// `PROV-` prefix all move one of them), so this catches a pattern divergence that
// a bare alphabet comparison would miss.
const AXES = {
  alphabet: /CONNECTION_TOKEN_ALPHABET\s*=\s*'([^']*)'/,
  group: /const\s+GROUP\s*=\s*`([^`]*)`/,
  pattern: /CONNECTION_TOKEN_PATTERN\s*=\s*new RegExp\(\s*`([^`]*)`\s*\)/,
  length: /CONNECTION_TOKEN_LENGTH\s*=\s*(\d+)/,
};

function extract(source, label) {
  const out = {};
  for (const [axis, re] of Object.entries(AXES)) {
    const m = source.match(re);
    if (!m) {
      throw new Error(
        `${label}: could not find the ${axis} declaration — the canonical shape moved or was renamed. `
        + 'This guard reads the declarations by name; keep them in the canonical form.',
      );
    }
    out[axis] = m[1];
  }
  return out;
}

// Rebuild the effective regex source from the extracted axes: substitute the
// alphabet into GROUP, then GROUP into PATTERN. Used only to prove the extracted
// values are the REAL working format (not incidental text), so a "they match"
// verdict is meaningful.
function effectivePattern({ alphabet, group, pattern }) {
  const groupExpanded = group.replaceAll('${CONNECTION_TOKEN_ALPHABET}', alphabet);
  return pattern.replaceAll('${GROUP}', groupExpanded);
}

function compare(backend, sdk) {
  const diffs = [];
  for (const axis of Object.keys(AXES)) {
    if (backend[axis] !== sdk[axis]) {
      diffs.push(`${axis}: backend=${JSON.stringify(backend[axis])} sdk=${JSON.stringify(sdk[axis])}`);
    }
  }
  return diffs;
}

function run(backendSrc, sdkSrc) {
  const backend = extract(backendSrc, 'backend');
  const sdk = extract(sdkSrc, 'sdk');
  const diffs = compare(backend, sdk);

  // Sanity: the extracted backend format MUST accept a real 14-char code and
  // reject the retired 16-char form. Otherwise a "they match" verdict could be
  // two copies agreeing on garbage the extractor happened to grab.
  const src = effectivePattern(backend);
  const re = new RegExp(src);
  if (!re.test('PROV-ABCD-2345')) {
    throw new Error(`extracted backend pattern ${src} rejects a real 14-char code — extraction is wrong`);
  }
  if (re.test('ABCDEFGHIJKLMNOP')) {
    throw new Error(`extracted backend pattern ${src} accepts the retired 16-char form — extraction is wrong`);
  }
  return { backend, sdk, diffs };
}

function selfTest() {
  const backendSrc = readFileSync(BACKEND, 'utf8');
  const sdkSrc = readFileSync(SDK, 'utf8');

  // The real files must NOT diverge today, or the self-test's baseline is invalid.
  const base = run(backendSrc, sdkSrc);
  if (base.diffs.length) {
    console.error('self-test setup broken: the real modules already diverge:', base.diffs);
    process.exit(1);
  }

  // Plant a divergence on EACH axis (mutating an in-memory copy of the SDK
  // mirror) and require the comparison to report it. A one-sided edit is exactly
  // this shape.
  const mutations = {
    alphabet: (s) => s.replace('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 'ABCDEFGHJKLMNPQRSTUVWXYZ234567890'),
    length: (s) => s.replace(/CONNECTION_TOKEN_LENGTH\s*=\s*\d+/, 'CONNECTION_TOKEN_LENGTH = 16'),
    pattern: (s) => s.replace('${CONNECTION_TOKEN_ALPHABET}]{4}', '${CONNECTION_TOKEN_ALPHABET}]{5}'),
  };

  for (const [axis, mutate] of Object.entries(mutations)) {
    const mutatedSdk = mutate(sdkSrc);
    if (mutatedSdk === sdkSrc) {
      console.error(`self-test broken: the ${axis} mutation did not change the source`);
      process.exit(1);
    }
    const { diffs } = run(backendSrc, mutatedSdk);
    if (!diffs.length) {
      console.error(`self-test FAILED: a ${axis} divergence was NOT detected — the guard cannot fail`);
      process.exit(1);
    }
    console.log(`  self-test ok: ${axis} divergence detected -> ${diffs.join('; ')}`);
  }
  console.log('check-connection-token-format-parity --self-test: all three axes detected (guard can fail).');
}

function main() {
  if (process.argv.slice(2).includes('--self-test')) {
    selfTest();
    return;
  }
  let result;
  try {
    result = run(readFileSync(BACKEND, 'utf8'), readFileSync(SDK, 'utf8'));
  } catch (error) {
    console.error(`::error::connection-token-format parity check could not run: ${error.message}`);
    process.exit(1);
  }
  if (result.diffs.length) {
    console.error('::error::connection-token-format has DIVERGED between the relay canonical and the SDK mirror:');
    for (const d of result.diffs) console.error(`  ${d}`);
    console.error(`  backend: ${BACKEND}`);
    console.error(`  sdk:     ${SDK}`);
    console.error('  Re-sync both modules so ALPHABET, PATTERN, and LENGTH match, then push.');
    process.exit(1);
  }
  console.log(
    `OK: connection-token-format is in sync — alphabet=${result.backend.alphabet.length} symbols, `
    + `pattern=${effectivePattern(result.backend)}, length=${result.backend.length}.`,
  );
}

main();
