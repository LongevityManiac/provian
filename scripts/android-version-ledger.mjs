#!/usr/bin/env node
/**
 * One numbering for every Android build. The Google Play bundle and the website APK are the same
 * app signed by the same key, so a phone can move between them; Android orders them only by
 * versionCode. Every Android artifact, whichever channel it ships on, therefore takes its
 * versionCode from app.json (`expo.android.versionCode`, the only source) and must be strictly
 * higher than every versionCode any earlier artifact used. This ledger records each one.
 *
 *   node scripts/android-version-ledger.mjs check <versionCode>
 *   node scripts/android-version-ledger.mjs record <versionCode> <play|website> <artifact path>
 *   node scripts/android-version-ledger.mjs --self-test
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LEDGER = join(ROOT, 'android', 'release-version-codes.json');

export function readLedger(path) {
  if (!existsSync(path)) return { builds: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.builds)) throw new Error(`malformed ledger: ${path}`);
  return parsed;
}

export function highestUsed(ledger) {
  return ledger.builds.reduce((m, b) => Math.max(m, Number(b.versionCode) || 0), 0);
}

/** Refuse a versionCode any earlier artifact used, or one at or below the highest. */
export function checkCode(ledger, code) {
  if (!Number.isSafeInteger(code) || code <= 0) return `versionCode ${code} is not a positive integer`;
  const top = highestUsed(ledger);
  if (code <= top) return `versionCode ${code} is not above ${top}, the highest any Android build has used. Bump expo.android.versionCode in app.json and versionCode in android/app/build.gradle.`;
  return null;
}

export function recordBuild(ledger, entry) {
  const refusal = checkCode(ledger, entry.versionCode);
  if (refusal) throw new Error(refusal);
  return { builds: [...ledger.builds, entry] };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'l.json');
  let l = readLedger(path);
  if (checkCode(l, 1) !== null) throw new Error('self-test: an empty ledger must admit 1');
  l = recordBuild(l, { versionCode: 55, channel: 'website', artifact: 'a.apk', sha256: 'x' });
  // RED: the same code again, and a lower one, are refused whichever channel asks.
  if (checkCode(l, 55) === null) throw new Error('self-test: a reused versionCode was admitted');
  if (checkCode(l, 54) === null) throw new Error('self-test: a lower versionCode was admitted');
  let threw = false;
  try { recordBuild(l, { versionCode: 55, channel: 'play', artifact: 'b.aab', sha256: 'y' }); } catch { threw = true; }
  if (!threw) throw new Error('self-test: a Play build reused a website versionCode');
  if (checkCode(l, 56) !== null) throw new Error('self-test: the next code was refused');
  writeFileSync(path, JSON.stringify(l));
  if (highestUsed(readLedger(path)) !== 55) throw new Error('self-test: ledger did not round-trip');
  console.log('android-version-ledger self-test ok');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === '--self-test') {
  selfTest();
} else if (cmd === 'check') {
  const refusal = checkCode(readLedger(DEFAULT_LEDGER), Number(args[0]));
  if (refusal) { console.error(`ERROR: ${refusal}`); process.exit(1); }
  console.log(`versionCode ${args[0]} is free`);
} else if (cmd === 'record') {
  const [code, channel, artifact] = args;
  if (channel !== 'play' && channel !== 'website') { console.error('channel must be play or website'); process.exit(2); }
  const next = recordBuild(readLedger(DEFAULT_LEDGER), {
    versionCode: Number(code), channel, artifact: basename(artifact), sha256: sha256File(artifact), built_at: new Date().toISOString(),
  });
  writeFileSync(DEFAULT_LEDGER, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`recorded versionCode ${code} (${channel})`);
} else {
  console.error('usage: android-version-ledger.mjs check <code> | record <code> <play|website> <artifact> | --self-test');
  process.exit(2);
}
