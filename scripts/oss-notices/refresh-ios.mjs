#!/usr/bin/env node
// Refresh the iOS pod entries of scripts/oss-notices/native-components.json from ios/Podfile.lock
// and the installed pods (ios/Pods, after `pod install`).
//
//   node scripts/oss-notices/refresh-ios.mjs
//
// Every pod the generator cannot attribute to an npm package, to a first-party path or to
// react-native's prebuilt dependencies gets an entry: its locked version, its license (an existing
// entry's reviewed license is kept; a new pod takes its podspec's license type) and the license file
// the pod ships, stored once under scripts/oss-notices/licenses/. Entries for pods the lockfile no
// longer pins are removed. The generator and its check never need ios/Pods: they read the result.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LICENSE_DIR, NATIVE_MANIFEST, PODFILE_LOCK, licenseText, normalizeText, parsePodfileLock } from '../generate-oss-notices.mjs';

const root = resolve(import.meta.dirname, '../..');

/** The pods that need a reviewed entry: not built from a local path and not otherwise attributed. */
export function podsNeedingEntries(podfile, manifest) {
  return [...podfile.pods].filter(([pod]) => {
    const source = podfile.external.get(pod);
    if (source && source.path) return false;
    if (Object.hasOwn(manifest.ios.podsFromNpm, pod)) return false;
    return !manifest.ios.podsExpandingToReactNativeDependencies.includes(pod);
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function podspecLicense(pod, version) {
  const local = join(root, 'ios/Pods/Local Podspecs', `${pod}.podspec.json`);
  const candidates = [local];
  const trunk = join(homedir(), '.cocoapods/repos/trunk/Specs');
  if (existsSync(trunk)) {
    // The CDN trunk shards specs as Specs/<a>/<b>/<c>/<Pod>/<version>/<Pod>.podspec.json.
    for (const a of readdirSync(trunk)) for (const b of readdirSync(join(trunk, a))) for (const c of readdirSync(join(trunk, a, b))) {
      candidates.push(join(trunk, a, b, c, pod, version, `${pod}.podspec.json`));
    }
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const spec = JSON.parse(readFileSync(p, 'utf8'));
    const l = typeof spec.license === 'string' ? spec.license : spec.license && spec.license.type;
    if (l) return /apache/i.test(l) && /2/.test(l) ? 'Apache-2.0' : l;
  }
  return null;
}

function main() {
  const podfile = parsePodfileLock(readFileSync(join(root, PODFILE_LOCK), 'utf8'));
  const manifestPath = join(root, NATIVE_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const licenseDir = join(root, LICENSE_DIR);
  const stored = new Map();
  for (const f of readdirSync(licenseDir).filter((f) => f.endsWith('.txt')).sort()) stored.set(normalizeText(readFileSync(join(licenseDir, f), 'utf8')), f);

  const problems = [];
  const pods = {};
  for (const [pod, version] of podsNeedingEntries(podfile, manifest)) {
    const dir = join(root, 'ios/Pods', pod);
    if (!existsSync(dir)) { problems.push(`${pod}: ios/Pods/${pod} is missing; run pod install`); continue; }
    const text = licenseText(dir);
    if (!text) { problems.push(`${pod}: the pod ships no license file; add its text to ${LICENSE_DIR} and its entry by hand`); continue; }
    let file = stored.get(text);
    if (!file) {
      file = `ios-${pod.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.txt`;
      writeFileSync(join(licenseDir, file), `${text}\n`);
      stored.set(text, file);
    }
    const prior = manifest.ios.pods[pod];
    const license = prior ? prior.license : podspecLicense(pod, version);
    if (!license) { problems.push(`${pod}: no license type found in its podspec; add its entry by hand`); continue; }
    pods[pod] = { version, license, text: file, source: prior && prior.source ? prior.source : 'license file shipped in the pod' };
  }
  if (problems.length) {
    console.error(`refresh-ios: ${problems.join('\n  ')}`);
    process.exit(1);
  }
  manifest.ios.pods = pods;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`refresh-ios: ${Object.keys(pods).length} pods recorded in ${NATIVE_MANIFEST}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
