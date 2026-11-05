#!/usr/bin/env node
// The app's Open Source Licenses screen lists every third-party component the iOS and Android
// binaries ship, with its version, declared license, the license text it ships and the platform it
// ships on. This script builds that list from four checked-in sources and the installed packages:
//
//   npm      package-lock.json (the production closure: every installed package not marked
//            dev-only, skipping platform-specific binaries, which are build tools and differ by
//            machine), reading each package's own package.json and license file from node_modules.
//   iOS      ios/Podfile.lock. A pod built from a path inside node_modules is that npm package's own
//            native code and is already listed; a pod from the repo's own modules or from build
//            output is first-party. Every other pod is listed from scripts/oss-notices/
//            native-components.json, which must name it at the version the lockfile pins.
//   react-native's native dependencies
//            the third-party libraries react-native compiles into its prebuilt iOS framework and its
//            Android libraries (folly, glog, boost and others), at the versions react-native pins.
//   Android  scripts/oss-notices/android-runtime.json: the release runtime classpath as Gradle
//            resolves it, with each artifact's POM license, written by
//            scripts/oss-notices/refresh-android.mjs. It records a fingerprint of the Gradle inputs
//            and of every native npm package, so a dependency change that could move the classpath
//            refuses the stale list until it is refreshed.
//
// Every license text is stored once. --check refuses a generated module that lags any source, so
// the notices can never drift from what the binaries are built with.
//
//   node scripts/generate-oss-notices.mjs          write the generated module
//   node scripts/generate-oss-notices.mjs --check  fail if it is stale
//
// No runtime dependency: this runs at build time, offline, and writes a plain TS module.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export const OUT = 'src/screens/Settings/ossNotices.generated.ts';
export const NATIVE_MANIFEST = 'scripts/oss-notices/native-components.json';
export const ANDROID_RUNTIME = 'scripts/oss-notices/android-runtime.json';
export const LICENSE_DIR = 'scripts/oss-notices/licenses';
export const PODFILE_LOCK = 'ios/Podfile.lock';
/**
 * The state of a component whose shipped library includes a non-empty third-party notices file
 * (third_party_licenses.txt, as Google's SDK artifacts ship), which the list does not reproduce.
 */
export const BUNDLED_NOT_REPRODUCED = 'bundled_not_reproduced';

/** Files whose content decides the Android release runtime classpath besides the native npm packages. */
export const ANDROID_INPUT_FILES = [
  'android/build.gradle',
  'android/app/build.gradle',
  'android/settings.gradle',
  'android/gradle.properties',
  'android/gradle/wrapper/gradle-wrapper.properties',
];

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._][a-z0-9-]+)?(?:\.(?:md|txt|markdown|rst))?$/i;

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A license text in its stored form: LF line ends, no trailing blanks, trimmed. */
export function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

// ---------------------------------------------------------------------------------------------
// npm

/** The lockfile entries of the app's production closure, by install path. */
export function productionEntries(lock) {
  if (!lock || typeof lock.packages !== 'object') throw new Error('package-lock.json has no "packages" map (lockfileVersion 2 or later is required)');
  return Object.entries(lock.packages)
    .filter(([path, meta]) => path.startsWith('node_modules/')
      && !meta.dev && !meta.devOptional && !meta.link && !meta.os && !meta.cpu)
    .sort(([a], [b]) => byString(a, b));
}

/** The installed name of a lockfile path: the segment after its last node_modules/. */
export function nameOf(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** A package's declared license as one SPDX-like string. */
export function declaredLicense(meta, pkg) {
  const pick = (v) => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && typeof v.type === 'string') return v.type.trim();
    return null;
  };
  const fromLock = pick(meta.license);
  if (fromLock) return fromLock;
  const fromPkg = pick(pkg.license);
  if (fromPkg) return fromPkg;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(pick).filter(Boolean);
    if (all.length) return all.length === 1 ? all[0] : `(${all.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

/** The license text a package ships, or null when it ships none. Prefers LICENSE over NOTICE. */
export function licenseText(dir) {
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort((a, b) => {
    const rank = (f) => (/^licen[cs]e/i.test(f) ? 0 : /^copying/i.test(f) ? 1 : 2);
    return rank(a) - rank(b) || byString(a, b);
  });
  const texts = [];
  for (const f of files) {
    const text = normalizeText(readFileSync(join(dir, f), 'utf8'));
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts.length ? texts.join('\n\n') : null;
}

/** Every production npm package as an entry with its text, plus its install directory. */
export function npmEntries(lock, nodeModulesRoot) {
  const entries = [];
  const seen = new Set();
  for (const [path, meta] of productionEntries(lock)) {
    const name = nameOf(path);
    const dir = resolve(nodeModulesRoot, path);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) throw new Error(`${path} is in package-lock.json but not installed; run npm ci`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (meta.version && pkg.version !== meta.version) throw new Error(`${path} is installed at ${pkg.version} but package-lock.json pins ${meta.version}; run npm ci`);
    const key = `${name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, version: pkg.version, platform: 'npm', license: declaredLicense(meta, pkg), text: licenseText(dir), dir });
  }
  return entries;
}

/** name -> installed versions, for proving a native component is an npm package already listed. */
function npmIndex(npm) {
  const index = new Map();
  for (const e of npm) {
    if (!index.has(e.name)) index.set(e.name, new Set());
    index.get(e.name).add(e.version);
  }
  return index;
}

// ---------------------------------------------------------------------------------------------
// Shared native data

/** Read a stored license text by file name from the license directory; refuses a missing or empty file. */
export function readStoredText(licenseDir, file) {
  if (typeof file !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.txt$/.test(file)) throw new Error(`license text name ${JSON.stringify(file)} is not a plain .txt file name`);
  const path = join(licenseDir, file);
  if (!existsSync(path)) throw new Error(`license text ${file} is missing from ${LICENSE_DIR}`);
  const text = normalizeText(readFileSync(path, 'utf8'));
  if (!text) throw new Error(`license text ${file} is empty`);
  return text;
}

// ---------------------------------------------------------------------------------------------
// iOS

/** The pods a Podfile.lock pins (root names and versions) and the external source of each. */
export function parsePodfileLock(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const section = (name) => {
    const start = lines.indexOf(`${name}:`);
    if (start < 0) return [];
    const out = [];
    for (let i = start + 1; i < lines.length && (lines[i] === '' || lines[i].startsWith(' ')); i++) out.push(lines[i]);
    return out;
  };
  const pods = new Map();
  for (const line of section('PODS')) {
    const m = line.match(/^ {2}- "?([^\s"(]+) \(([^)]+)\)"?:?$/);
    if (!m) continue;
    const name = m[1].split('/')[0];
    const prior = pods.get(name);
    if (prior && prior !== m[2]) throw new Error(`Podfile.lock pins ${name} at both ${prior} and ${m[2]}`);
    pods.set(name, m[2]);
  }
  if (pods.size === 0) throw new Error('Podfile.lock has no PODS entries');
  const external = new Map();
  let current = null;
  for (const line of section('EXTERNAL SOURCES')) {
    const head = line.match(/^ {2}"?([^\s":]+)"?:$/);
    if (head) { current = head[1]; external.set(current, {}); continue; }
    const kv = line.match(/^ {4}:(\w+): "?([^"]*)"?$/);
    if (kv && current) external.get(current)[kv[1]] = kv[2];
  }
  return { pods, external };
}

/** The npm package a path inside node_modules belongs to, e.g. ../node_modules/@scope/pkg/ios -> @scope/pkg. */
export function npmPackageOfPath(path) {
  const m = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return m ? m[1] : null;
}

/**
 * Classify every pod in the lockfile. Returns the iOS entries to list and the pods that expand to
 * react-native's prebuilt dependencies. Refuses any pod it cannot place and any manifest pod the
 * lockfile no longer pins.
 */
export function iosEntries({ podfile, manifest, npm, licenseDir, reactNativeVersion }) {
  const ios = manifest.ios;
  const index = npmIndex(npm);
  const entries = [];
  const expanded = [];
  const problems = [];
  for (const [pod, version] of [...podfile.pods].sort(([a], [b]) => byString(a, b))) {
    const source = podfile.external.get(pod);
    if (source && source.path) {
      const pkg = npmPackageOfPath(source.path);
      if (pkg) {
        if (!index.has(pkg)) problems.push(`pod ${pod} is built from ${source.path}, but npm package ${pkg} is not in the production closure`);
        continue;
      }
      if (ios.firstPartyPathPrefixes.some((p) => source.path.startsWith(p))) continue;
      problems.push(`pod ${pod} is built from local path ${source.path}, which is neither node_modules nor a first-party path`);
      continue;
    }
    if (Object.hasOwn(ios.podsFromNpm, pod)) {
      const pkg = ios.podsFromNpm[pod];
      if (!index.get(pkg)?.has(version)) problems.push(`pod ${pod} ${version} is listed as npm package ${pkg}, which is not installed at ${version}`);
      continue;
    }
    if (ios.podsExpandingToReactNativeDependencies.includes(pod)) {
      if (version !== reactNativeVersion) problems.push(`pod ${pod} is locked at ${version} but react-native is ${reactNativeVersion}`);
      expanded.push(pod);
      continue;
    }
    const known = ios.pods[pod];
    if (!known) { problems.push(`pod ${pod} ${version} is not in ${NATIVE_MANIFEST}; add its license (scripts/oss-notices/refresh-ios.mjs)`); continue; }
    if (known.version !== version) { problems.push(`pod ${pod} is locked at ${version} but ${NATIVE_MANIFEST} records ${known.version}; review its license and refresh`); continue; }
    entries.push({ name: pod, version, platform: 'ios', license: known.license, text: readStoredText(licenseDir, known.text) });
  }
  const claimed = [...Object.keys(ios.pods), ...Object.keys(ios.podsFromNpm), ...ios.podsExpandingToReactNativeDependencies];
  for (const pod of claimed) if (!podfile.pods.has(pod)) problems.push(`${NATIVE_MANIFEST} names pod ${pod}, which Podfile.lock no longer pins`);
  if (problems.length) throw new Error(`iOS notices: ${problems.join('; ')}`);
  return { entries, expanded };
}

// ---------------------------------------------------------------------------------------------
// react-native's native dependencies

/** The native dependency versions react-native pins for each platform, read from its package. */
export function reactNativePins(rnDir) {
  const version = JSON.parse(readFileSync(join(rnDir, 'package.json'), 'utf8')).version;
  const helpersText = readFileSync(join(rnDir, 'scripts/cocoapods/helpers.rb'), 'utf8');
  const helpers = {};
  for (const m of helpersText.matchAll(/@@(\w+)_config\s*=\s*\{([\s\S]*?)\n\s*\}/g)) {
    const v = m[2].match(/:version\s*=>\s*['"]([^'"]+)['"]/);
    if (v) helpers[m[1]] = v[1];
  }
  const podspecDir = join(rnDir, 'third-party-podspecs');
  const podspecs = {};
  const podspecHelpers = {};
  for (const f of readdirSync(podspecDir).filter((f) => f.endsWith('.podspec')).sort(byString)) {
    const name = f.slice(0, -'.podspec'.length);
    const text = readFileSync(join(podspecDir, f), 'utf8');
    const literal = text.match(/spec\.version\s*=\s*['"]([^'"]+)['"]/);
    const viaHelper = text.match(/(\w+)_config\[:version\]/);
    if (viaHelper) podspecHelpers[name] = viaHelper[1];
    podspecs[name] = literal ? literal[1] : viaHelper && helpers[viaHelper[1]] ? helpers[viaHelper[1]] : null;
  }
  const toml = readFileSync(join(rnDir, 'gradle/libs.versions.toml'), 'utf8').replace(/\r\n?/g, '\n');
  const start = toml.indexOf('[versions]');
  if (start < 0) throw new Error('react-native gradle/libs.versions.toml has no [versions] table');
  const end = toml.indexOf('\n[', start + 1);
  const versions = toml.slice(start, end < 0 ? undefined : end);
  const tomlPins = {};
  const nativeKeys = [];
  let inNative = false;
  for (const line of versions.split('\n')) {
    if (/^#\s*Native Dependencies/i.test(line)) { inNative = true; continue; }
    if (line.startsWith('#')) { inNative = false; continue; }
    const kv = line.match(/^\s*([\w-]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    tomlPins[kv[1]] = kv[2];
    if (inNative) nativeKeys.push(kv[1]);
  }
  return { version, helpers, podspecs, podspecHelpers, tomlPins, nativeKeys };
}

/** A pin's value: podspec:<file>, helpers:<config> or toml:<key>. */
export function pinValue(pins, pin) {
  const [kind, key] = String(pin).split(':');
  const value = kind === 'podspec' ? pins.podspecs[key] : kind === 'helpers' ? pins.helpers[key] : kind === 'toml' ? pins.tomlPins[key] : undefined;
  return typeof value === 'string' ? value.replace(/_/g, '.') : null;
}

/**
 * Entries for the libraries react-native compiles into its prebuilt binaries. iOS components are
 * listed when a pod expands to them; Android components when react-native's Android library is in
 * the runtime classpath. Each reviewed version must equal react-native's pin, and every native pin
 * react-native declares must be claimed by a reviewed component (or declared build-only).
 */
export function reactNativeDependencyEntries({ manifest, pins, ios, android, licenseDir }) {
  const rnd = manifest.reactNativeDependencies;
  const problems = [];
  const claimedIos = new Set();
  const claimedAndroid = new Set(rnd.buildOnlyAndroid);
  const entries = [];
  for (const c of rnd.components) {
    const versions = {};
    for (const platform of ['ios', 'android']) {
      const spec = c[platform];
      if (!spec) continue;
      const [kind, key] = spec.pin.split(':');
      if (platform === 'ios') claimedIos.add(kind === 'podspec' ? `podspec:${key}` : `helpers:${key}`);
      else if (kind === 'toml') claimedAndroid.add(key);
      const pinned = pinValue(pins, spec.pin);
      if (pinned === null) problems.push(`${c.name}: react-native ${pins.version} has no pin ${spec.pin}`);
      else if (pinned !== spec.version) problems.push(`${c.name}: react-native ${pins.version} pins ${pinned} for ${platform} but ${NATIVE_MANIFEST} records ${spec.version}; review its license and update the manifest`);
      if ((platform === 'ios' && ios) || (platform === 'android' && android)) versions[platform] = spec.version;
    }
    const text = readStoredText(licenseDir, c.text);
    if (versions.ios && versions.android && versions.ios === versions.android) {
      entries.push({ name: c.name, version: versions.ios, platform: 'ios-android', license: c.license, text });
    } else {
      if (versions.ios) entries.push({ name: c.name, version: versions.ios, platform: 'ios', license: c.license, text });
      if (versions.android) entries.push({ name: c.name, version: versions.android, platform: 'android', license: c.license, text });
    }
  }
  if (ios) {
    for (const name of Object.keys(pins.podspecs)) {
      if (name === 'ReactNativeDependencies') continue;
      if (!claimedIos.has(`podspec:${name}`)) problems.push(`react-native pins an unreviewed iOS native dependency ${name}; add it to ${NATIVE_MANIFEST}`);
    }
    // A helpers pin a reviewed podspec reads its version from is claimed through that podspec.
    const viaPodspec = new Set(Object.entries(pins.podspecHelpers).filter(([n]) => claimedIos.has(`podspec:${n}`)).map(([, key]) => key));
    for (const key of Object.keys(pins.helpers)) {
      if (!claimedIos.has(`helpers:${key}`) && !viaPodspec.has(key)) problems.push(`react-native pins an unreviewed iOS native dependency ${key}; add it to ${NATIVE_MANIFEST}`);
    }
  }
  if (android) {
    for (const key of pins.nativeKeys) if (!claimedAndroid.has(key)) problems.push(`react-native pins an unreviewed Android native dependency ${key}; add it to ${NATIVE_MANIFEST}`);
  }
  if (problems.length) throw new Error(`react-native native dependencies: ${problems.join('; ')}`);
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Android

/**
 * A Gradle file without its `versionCode` and `versionName` lines. Every release bumps them and
 * neither decides which libraries ship, so they stay out of the fingerprint.
 */
export function withoutReleaseNumbers(gradle) {
  return gradle.replace(/^[ \t]*version(?:Code|Name)[ \t]+\S.*$/gm, '');
}

/**
 * Fingerprint of everything that decides the Android release runtime classpath: the Gradle files,
 * the first-party modules' Gradle files, and every production npm package that carries Android code
 * or a local Maven repository (name@version).
 */
export function androidInputsFingerprint(checkoutRoot, npm) {
  const hash = createHash('sha256');
  const add = (label, content) => hash.update(`${label}\0${content}\0`);
  for (const f of ANDROID_INPUT_FILES) {
    const p = join(checkoutRoot, f);
    add(f, existsSync(p) ? withoutReleaseNumbers(readFileSync(p, 'utf8')) : '(absent)');
  }
  const modulesDir = join(checkoutRoot, 'modules');
  if (existsSync(modulesDir)) {
    for (const m of readdirSync(modulesDir).sort(byString)) {
      for (const f of ['android/build.gradle', 'android/build.gradle.kts']) {
        const p = join(modulesDir, m, f);
        if (existsSync(p)) add(`modules/${m}/${f}`, readFileSync(p, 'utf8'));
      }
    }
  }
  const native = npm
    .filter((e) => ['android', 'ReactAndroid', 'local-maven-repo'].some((d) => existsSync(join(e.dir, d))))
    .map((e) => `${e.name}@${e.version}`)
    .sort(byString);
  add('native-npm', native.join('\n'));
  return `sha256:${hash.digest('hex')}`;
}

/** Entries for the Android release runtime classpath, excluding the artifacts npm packages ship. */
export function androidEntries({ runtime, npm, fingerprint, licenseDir }) {
  if (!runtime || !Array.isArray(runtime.artifacts) || runtime.artifacts.length === 0) throw new Error(`${ANDROID_RUNTIME} lists no artifacts`);
  if (runtime.fingerprint !== fingerprint) throw new Error(`${ANDROID_RUNTIME} is stale: the Gradle files or a native npm package changed since it was written; run node scripts/oss-notices/refresh-android.mjs`);
  const index = npmIndex(npm);
  const entries = [];
  const problems = [];
  const seen = new Set();
  let reactAndroid = false;
  for (const a of runtime.artifacts) {
    const parts = String(a.id).split(':');
    if (parts.length !== 3 || parts.some((p) => !p)) { problems.push(`artifact ${JSON.stringify(a.id)} is not group:artifact:version`); continue; }
    if (seen.has(a.id)) { problems.push(`artifact ${a.id} is listed twice`); continue; }
    seen.add(a.id);
    const [group, artifact, version] = parts;
    if (a.npm !== undefined) {
      if (!index.has(a.npm)) problems.push(`artifact ${a.id} is attributed to npm package ${a.npm}, which is not in the production closure`);
      if (a.npm === 'react-native' && `${group}:${artifact}` === 'com.facebook.react:react-android') reactAndroid = true;
      continue;
    }
    if (typeof a.license !== 'string' || !a.license) { problems.push(`artifact ${a.id} has no license`); continue; }
    if (a.bundledNotices !== undefined && a.bundledNotices !== true) { problems.push(`artifact ${a.id} has bundledNotices ${JSON.stringify(a.bundledNotices)}; it is true or absent`); continue; }
    const entry = { name: `${group}:${artifact}`, version, platform: 'android', license: a.license, text: a.text === null ? null : readStoredText(licenseDir, a.text) };
    // The library ships a third-party notices file that is not reproduced.
    entries.push(a.bundledNotices ? { ...entry, notice: BUNDLED_NOT_REPRODUCED } : entry);
  }
  if (problems.length) throw new Error(`Android notices: ${problems.join('; ')}`);
  return { entries, reactAndroid };
}

// ---------------------------------------------------------------------------------------------
// Assembly

/** One sorted list with every text stored once; refuses a duplicate platform/name/version. */
export function assemble(entries) {
  const texts = [];
  const textIndex = new Map();
  const seen = new Set();
  const notices = [];
  for (const e of entries) {
    const key = `${e.platform} ${e.name}@${e.version}`;
    if (seen.has(key)) throw new Error(`duplicate notice ${key}`);
    seen.add(key);
    let index = -1;
    if (e.text !== null) {
      if (!textIndex.has(e.text)) { textIndex.set(e.text, texts.length); texts.push(e.text); }
      index = textIndex.get(e.text);
    }
    const notice = { name: e.name, version: e.version, platform: e.platform, license: e.license, text: index };
    if (e.notice !== undefined) {
      if (e.notice !== BUNDLED_NOT_REPRODUCED) throw new Error(`notice ${key} has unknown state ${JSON.stringify(e.notice)}`);
      notice.notice = e.notice;
    }
    notices.push(notice);
  }
  notices.sort((a, b) => byString(a.name, b.name) || byString(a.version, b.version) || byString(a.platform, b.platform));
  return { notices, texts };
}

/** The full notice set for a checkout: npm, iOS, react-native's native dependencies and Android. */
export function buildAll(checkoutRoot) {
  const lock = JSON.parse(readFileSync(join(checkoutRoot, 'package-lock.json'), 'utf8'));
  const npm = npmEntries(lock, checkoutRoot);
  const manifest = JSON.parse(readFileSync(join(checkoutRoot, NATIVE_MANIFEST), 'utf8'));
  const licenseDir = join(checkoutRoot, LICENSE_DIR);
  const rnDir = join(checkoutRoot, 'node_modules/react-native');
  if (!existsSync(join(rnDir, 'package.json'))) throw new Error('react-native is not installed; run npm ci');
  const pins = reactNativePins(rnDir);
  const podfile = parsePodfileLock(readFileSync(join(checkoutRoot, PODFILE_LOCK), 'utf8'));
  const ios = iosEntries({ podfile, manifest, npm, licenseDir, reactNativeVersion: pins.version });
  const runtime = JSON.parse(readFileSync(join(checkoutRoot, ANDROID_RUNTIME), 'utf8'));
  const android = androidEntries({ runtime, npm, fingerprint: androidInputsFingerprint(checkoutRoot, npm), licenseDir });
  const rn = reactNativeDependencyEntries({ manifest, pins, ios: ios.expanded.length > 0, android: android.reactAndroid, licenseDir });
  return assemble([...npm.map(({ dir: _dir, ...e }) => e), ...ios.entries, ...rn, ...android.entries]);
}

/** Backwards-compatible npm-only build (used by tests of the npm closure on its own). */
export function buildNotices(lock, nodeModulesRoot) {
  return assemble(npmEntries(lock, nodeModulesRoot).map(({ dir: _dir, ...e }) => e));
}

export function render({ notices, texts }) {
  return '// GENERATED by scripts/generate-oss-notices.mjs from package-lock.json and the installed packages,\n'
    + '// ios/Podfile.lock, react-native\'s native dependency pins and scripts/oss-notices/. Do not edit;\n'
    + '// re-run the script (`--check` runs in `npm run check:copy`).\n'
    + "import type { OssNotice } from './ossNoticeTypes';\n\n"
    + `export const OSS_LICENSE_TEXTS: readonly string[] = ${JSON.stringify(texts)};\n\n`
    + `export const OSS_NOTICES: readonly OssNotice[] = [\n${notices.map((n) => `  ${JSON.stringify(n)},`).join('\n')}\n];\n`;
}

/** Build the expected module for a checkout: its lockfiles, installed packages and native sources. */
export function expectedModule(checkoutRoot = root) {
  const built = buildAll(checkoutRoot);
  return { built, next: render(built) };
}

/** True when the generated file at outPath is byte-identical to the expected module. */
export function isCurrent(outPath, next) {
  let current = null;
  try { current = readFileSync(outPath, 'utf8'); } catch { current = null; }
  return current === next;
}

function main() {
  const check = process.argv.includes('--check');
  const { built, next } = expectedModule();
  const outPath = resolve(root, OUT);
  const current = isCurrent(outPath, next);
  const count = (p) => built.notices.filter((n) => n.platform === p).length;
  const summary = `${built.notices.length} components: ${count('npm')} npm, ${count('ios')} iOS, ${count('android')} Android, ${count('ios-android')} on both; ${built.texts.length} distinct license texts`;
  if (check) {
    if (!current) {
      console.error(`oss-notices: ${OUT} is stale; run node scripts/generate-oss-notices.mjs`);
      process.exit(1);
    }
    console.log(`oss-notices: ok — ${summary}`);
  } else if (!current) {
    writeFileSync(outPath, next);
    console.log(`oss-notices: wrote ${OUT} (${summary})`);
  } else {
    console.log(`oss-notices: ${OUT} is current (${summary})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
