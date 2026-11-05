#!/usr/bin/env node
// Refresh scripts/oss-notices/android-runtime.json: the Android release runtime classpath (every
// external module Gradle resolves for `releaseRuntimeClasspath`, the libraries the release APK
// packages) with each module's license and the license text it ships.
//
//   node scripts/oss-notices/refresh-android.mjs              run Gradle, then write the list
//   node scripts/oss-notices/refresh-android.mjs --from FILE  reuse a saved Gradle output
//
// Needs node_modules installed, the Android SDK (ANDROID_HOME, or ~/Library/Android/sdk) and a
// Gradle cache that has resolved the release build at least once (Gradle downloads what it lacks).
// The generator and its check never run Gradle: they read the committed list and refuse it when
// the fingerprint of the Gradle files and native npm packages no longer matches.
//
// License: scripts/oss-notices/native-components.json `android.overrides` first (for modules whose
// POM declares none or misstates it; an override may also name the stored text), else the licenses
// the module's POM (or its parent POM) declares, with the Apache 2.0 and MIT spellings normalized
// to SPDX ids and several licenses read as a choice, as Maven defines them. A module from an npm package's local Maven
// repository, or named in `android.fromNpm`, is that npm package and is recorded as such.
//
// Text: Apache-2.0 modules get the canonical Apache 2.0 text plus any NOTICE file the module ships
// (the Apache license asks for NOTICE files to travel with the work). Other modules get the
// license files they ship (LICENSE, COPYING, NOTICE). A module that ships none records null and the
// screen states its declared license. Closed-source Google SDK artifacts ship a third-party notices
// file, third_party_licenses.txt (two repeat it as their LICENSE). It is not reproduced; a module
// whose file is non-empty records `bundledNotices: true` so the screen says it ships that file
// instead of claiming it ships no license file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANDROID_RUNTIME,
  LICENSE_DIR,
  NATIVE_MANIFEST,
  androidInputsFingerprint,
  normalizeText,
  npmEntries,
} from '../generate-oss-notices.mjs';

const root = resolve(import.meta.dirname, '../..');
const INIT_SCRIPT = resolve(import.meta.dirname, 'android-runtime.init.gradle');
const ANDROID_TEXT_PREFIX = 'android-';

/** Parse the init script's output into components and their POM licenses. */
export function parseGradleOutput(text) {
  const components = [];
  const licenses = new Map();
  for (const line of text.split('\n')) {
    const c = line.match(/^OSS-COMPONENT (\S+)$/);
    if (c) { components.push(c[1]); continue; }
    const l = line.match(/^OSS-LICENSE (\S+) ([^\t]*)\t?(.*)$/);
    if (l) {
      if (!licenses.has(l[1])) licenses.set(l[1], []);
      licenses.get(l[1]).push(l[2].trim());
    }
  }
  if (components.length === 0) throw new Error('Gradle printed no OSS-COMPONENT lines; is the init script applied to :app?');
  return { components: [...new Set(components)].sort(), licenses };
}

/** One SPDX id for the common Apache 2.0 and MIT spellings; any other name is kept as declared. */
export function normalizeLicenseName(name) {
  const n = name.trim();
  if (/apache/i.test(n) && /\b2(\.0)?\b|-2\b/.test(n)) return 'Apache-2.0';
  if (/^(the )?mit( license)?$/i.test(n)) return 'MIT';
  return n;
}

/** A POM's licenses as one expression. Maven reads several listed licenses as a choice among them. */
export function combinedLicense(names) {
  const unique = [...new Set(names.map(normalizeLicenseName).filter(Boolean))];
  return unique.length ? unique.join(' OR ') : null;
}

/** id -> npm package for every module an npm package ships in its local Maven repository. */
export function localMavenModules(npm) {
  const out = new Map();
  for (const e of npm) {
    const repo = join(e.dir, 'local-maven-repo');
    if (!existsSync(repo)) continue;
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.pom')) {
          const parts = relative(repo, dir).split(sep);
          if (parts.length < 3) continue;
          const version = parts.pop();
          const artifact = parts.pop();
          out.set(`${parts.join('.')}:${artifact}:${version}`, e.name);
        }
      }
    };
    walk(repo);
  }
  return out;
}

const LICENSE_ENTRY = /(^|\/)(licen[cs]e|copying|notice)([-._][^/]*)?$/i;

function zipEntries(file) {
  try { return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean); } catch { return []; }
}

function zipText(file, entry) {
  return normalizeText(execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 1e8 }));
}

/**
 * The license and notice texts a module's jar or aar ships (an aar's classes.jar included), and
 * whether it ships a non-empty third-party notices file (third_party_licenses.txt), which is not
 * reproduced. An empty notices file does not count.
 */
export function shippedTexts(binary) {
  const licenses = [];
  const notices = [];
  let bundledNotices = false;
  const take = (file, entries) => {
    // Google SDK artifacts ship a third-party notices file, third_party_licenses.txt, and some
    // repeat it as their LICENSE; neither is reproduced.
    const bundled = entries.includes('third_party_licenses.txt') ? zipText(file, 'third_party_licenses.txt') : null;
    if (bundled) bundledNotices = true;
    for (const e of entries.filter((x) => LICENSE_ENTRY.test(x) && !/\.(class|json|html?)$/i.test(x)).sort()) {
      const text = zipText(file, e);
      if (!text || text === bundled) continue;
      const bucket = /(^|\/)notice[^/]*$/i.test(e) ? notices : licenses;
      if (!bucket.includes(text)) bucket.push(text);
    }
  };
  const entries = zipEntries(binary);
  take(binary, entries);
  if (binary.endsWith('.aar') && entries.includes('classes.jar')) {
    const dir = mkdtempSync(join(tmpdir(), 'oss-aar-'));
    try {
      const jar = join(dir, 'classes.jar');
      writeFileSync(jar, execFileSync('unzip', ['-p', binary, 'classes.jar'], { maxBuffer: 1e9 }));
      take(jar, zipEntries(jar));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { licenses, notices, bundledNotices };
}

function cachedBinary(gradleHome, id) {
  const [g, a, v] = id.split(':');
  const dir = join(gradleHome, 'caches/modules-2/files-2.1', g, a, v);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).flatMap((h) => readdirSync(join(dir, h)).map((f) => join(dir, h, f)));
  return files.find((f) => f.endsWith(`${a}-${v}.aar`)) || files.find((f) => f.endsWith(`${a}-${v}.jar`)) || null;
}

function runGradle() {
  const env = { ...process.env };
  const sdk = join(homedir(), 'Library/Android/sdk');
  if (!env.ANDROID_HOME && !existsSync(join(root, 'android/local.properties')) && existsSync(sdk)) env.ANDROID_HOME = sdk;
  return execFileSync('./gradlew', ['-q', '-I', INIT_SCRIPT, ':app:provianOssRuntimeClasspath'], {
    cwd: join(root, 'android'), env, encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function main() {
  const fromIndex = process.argv.indexOf('--from');
  const output = fromIndex > 0 ? readFileSync(process.argv[fromIndex + 1], 'utf8') : runGradle();
  const { components, licenses } = parseGradleOutput(output);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const npm = npmEntries(lock, root);
  const manifest = JSON.parse(readFileSync(join(root, NATIVE_MANIFEST), 'utf8'));
  const licenseDir = join(root, LICENSE_DIR);
  const gradleHome = process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');
  const local = localMavenModules(npm);

  // Reuse a stored text whenever the content already exists.
  const stored = new Map();
  for (const f of readdirSync(licenseDir).filter((f) => f.endsWith('.txt')).sort()) {
    if (f.startsWith(ANDROID_TEXT_PREFIX)) continue;
    stored.set(normalizeText(readFileSync(join(licenseDir, f), 'utf8')), f);
  }
  const apache = normalizeText(readFileSync(join(licenseDir, 'apache-2.0.txt'), 'utf8'));
  const written = new Map();
  const store = (text, artifact) => {
    if (stored.has(text)) return stored.get(text);
    let name = `${ANDROID_TEXT_PREFIX}${artifact.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.txt`;
    for (let i = 2; written.has(name) && written.get(name) !== text; i++) name = `${ANDROID_TEXT_PREFIX}${artifact.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}-${i}.txt`;
    written.set(name, text);
    stored.set(text, name);
    return name;
  };

  const artifacts = [];
  const problems = [];
  for (const id of components) {
    const [g, a] = id.split(':');
    const ga = `${g}:${a}`;
    const fromNpm = local.get(id) || manifest.android.fromNpm[ga];
    if (fromNpm) { artifacts.push({ id, npm: fromNpm }); continue; }
    const override = manifest.android.overrides[ga];
    const license = override ? override.license : combinedLicense(licenses.get(id) || []);
    if (!license) { problems.push(`${id}: its POM declares no license; add it to android.overrides in ${NATIVE_MANIFEST}`); continue; }
    const binary = cachedBinary(gradleHome, id);
    const shipped = binary ? shippedTexts(binary) : { licenses: [], notices: [], bundledNotices: false };
    let text = null;
    if (override && override.text) {
      text = override.text;
    } else {
      const body = license === 'Apache-2.0' ? [apache] : shipped.licenses;
      const all = [...body, ...shipped.notices];
      if (all.length) text = store(all.join('\n\n'), a);
    }
    artifacts.push(shipped.bundledNotices ? { id, license, text, bundledNotices: true } : { id, license, text });
  }
  if (problems.length) {
    console.error(`refresh-android: ${problems.join('\n  ')}`);
    process.exit(1);
  }

  for (const [name, text] of written) writeFileSync(join(licenseDir, name), `${text}\n`);
  const referenced = new Set(artifacts.map((x) => x.text).filter(Boolean));
  for (const f of readdirSync(licenseDir)) if (f.startsWith(ANDROID_TEXT_PREFIX) && !referenced.has(f)) rmSync(join(licenseDir, f));

  const out = {
    about: 'The Android release runtime classpath (Gradle releaseRuntimeClasspath, external modules) with each module\'s license and stored text. Written by scripts/oss-notices/refresh-android.mjs; do not edit by hand.',
    fingerprint: androidInputsFingerprint(root, npm),
    artifacts,
  };
  writeFileSync(join(root, ANDROID_RUNTIME), `${JSON.stringify(out, null, 2)}\n`);
  const npmCount = artifacts.filter((x) => x.npm).length;
  console.log(`refresh-android: wrote ${ANDROID_RUNTIME} (${artifacts.length} modules, ${npmCount} shipped by npm packages, ${written.size} module-specific texts)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
