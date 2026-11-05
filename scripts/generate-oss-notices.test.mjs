import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OUT,
  PODFILE_LOCK,
  androidEntries,
  androidInputsFingerprint,
  withoutReleaseNumbers,
  assemble,
  buildAll,
  buildNotices,
  declaredLicense,
  expectedModule,
  iosEntries,
  isCurrent,
  licenseText,
  nameOf,
  npmEntries,
  npmPackageOfPath,
  parsePodfileLock,
  productionEntries,
  reactNativeDependencyEntries,
  reactNativePins,
  render,
} from './generate-oss-notices.mjs';

// The open source notices list every third-party component the binaries ship: the app's production
// npm closure from package-lock.json, the iOS pods ios/Podfile.lock pins (minus npm packages'
// own pods and first-party pods), the native libraries react-native compiles in, and the Android
// release runtime classpath. --check refuses a generated module that lags any of them.

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'oss-notices-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function install(base, path, pkg, files = {}) {
  const dir = join(base, path);
  mkdirSync(dir, { recursive: true });
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const LOCK = {
  lockfileVersion: 2,
  packages: {
    '': { name: 'app', dependencies: { a: '1' } },
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/a/node_modules/b': { version: '2.0.0' },
    'node_modules/devonly': { version: '1.0.0', dev: true, license: 'MIT' },
    'node_modules/devopt': { version: '1.0.0', devOptional: true, license: 'MIT' },
    'node_modules/linked': { resolved: 'pkgs/linked', link: true },
    'node_modules/native-darwin': { version: '1.0.0', os: ['darwin'], cpu: ['arm64'], optional: true, license: 'MIT' },
    'node_modules/c': { version: '3.0.0', license: 'Apache-2.0' },
  },
};

describe('production closure', () => {
  it('keeps installed runtime packages and drops dev-only, linked and platform-binary entries', () => {
    expect(productionEntries(LOCK).map(([p]) => p)).toEqual(['node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/c']);
    expect(nameOf('node_modules/a/node_modules/@scope/b')).toBe('@scope/b');
  });

  it('RED: refuses a lockfile without a packages map', () => {
    expect(() => productionEntries({ lockfileVersion: 1, dependencies: {} })).toThrow(/packages/);
  });

  it('resolves the declared license from the lockfile, then package.json, else UNKNOWN', () => {
    expect(declaredLicense({ license: 'MIT' }, {})).toBe('MIT');
    expect(declaredLicense({}, { license: 'ISC' })).toBe('ISC');
    expect(declaredLicense({}, { license: { type: 'BSD-2-Clause' } })).toBe('BSD-2-Clause');
    expect(declaredLicense({}, { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)');
    expect(declaredLicense({}, {})).toBe('UNKNOWN');
  });
});

describe('building the npm notices', () => {
  const base = join(scratch, 'ok');
  install(base, 'node_modules/a', { name: 'a', version: '1.0.0' }, { LICENSE: 'MIT License\r\n\r\nCopyright a   \r\n', 'NOTICE.md': 'Notice a' });
  install(base, 'node_modules/a/node_modules/b', { name: 'b', version: '2.0.0', license: 'ISC' });
  install(base, 'node_modules/c', { name: 'c', version: '3.0.0' }, { 'LICENSE-APACHE': 'Apache text', 'readme.md': 'not a license' });

  it('lists each package with version, platform, license and its license text (shared texts stored once)', () => {
    const built = buildNotices(LOCK, base);
    expect(built.notices).toEqual([
      { name: 'a', version: '1.0.0', platform: 'npm', license: 'MIT', text: 0 },
      { name: 'b', version: '2.0.0', platform: 'npm', license: 'ISC', text: -1 },
      { name: 'c', version: '3.0.0', platform: 'npm', license: 'Apache-2.0', text: 1 },
    ]);
    expect(built.texts).toEqual(['MIT License\n\nCopyright a\n\nNotice a', 'Apache text']);
    expect(licenseText(join(base, 'node_modules/a/node_modules/b'))).toBeNull();
  });

  it('RED: refuses a package the lockfile names but node_modules lacks, or holds at another version', () => {
    const missing = join(scratch, 'missing');
    install(missing, 'node_modules/a', { name: 'a', version: '1.0.0' });
    expect(() => buildNotices(LOCK, missing)).toThrow(/not installed; run npm ci/);
    const drifted = join(scratch, 'drifted');
    install(drifted, 'node_modules/a', { name: 'a', version: '1.0.1' });
    install(drifted, 'node_modules/a/node_modules/b', { name: 'b', version: '2.0.0' });
    install(drifted, 'node_modules/c', { name: 'c', version: '3.0.0' });
    expect(() => buildNotices(LOCK, drifted)).toThrow(/installed at 1\.0\.1 but package-lock\.json pins 1\.0\.0/);
  });

  it('RED: the check refuses a generated module that lags the lockfile', () => {
    const next = render(buildNotices(LOCK, base));
    const out = join(scratch, 'notices.generated.ts');
    writeFileSync(out, next);
    expect(isCurrent(out, next)).toBe(true);
    const bumped = structuredClone(LOCK);
    bumped.packages['node_modules/c'].license = 'MIT';
    expect(isCurrent(out, render(buildNotices(bumped, base)))).toBe(false);
    expect(isCurrent(join(scratch, 'absent.ts'), next)).toBe(false);
  });
});

// A native fixture: a license directory, a manifest and the npm packages pods may come from.
const licenseDir = install(scratch, 'licenses', null, {
  'apache-2.0.txt': 'Apache License 2.0 text\n',
  'mit-meta.txt': 'MIT License\n\nCopyright Meta\n',
  'boost.txt': 'Boost Software License\n',
  'folly.txt': 'Folly Apache text\n',
  'socketrocket.txt': 'SocketRocket BSD\n',
});
const NPM = [
  { name: 'react-native', version: '0.81.5', dir: '/nm/react-native' },
  { name: 'expo-camera', version: '17.0.10', dir: '/nm/expo-camera' },
];
const MANIFEST = {
  ios: {
    firstPartyPathPrefixes: ['../modules/', 'build/generated/ios'],
    podsFromNpm: { 'React-Core-prebuilt': 'react-native' },
    podsExpandingToReactNativeDependencies: ['ReactNativeDependencies'],
    pods: {
      ZXingObjC: { version: '3.6.9', license: 'Apache-2.0', text: 'apache-2.0.txt' },
      'hermes-engine': { version: '0.81.5', license: 'MIT', text: 'mit-meta.txt' },
    },
  },
  reactNativeDependencies: {
    buildOnlyAndroid: ['gflags'],
    components: [
      { name: 'boost', license: 'BSL-1.0', text: 'boost.txt', ios: { pin: 'podspec:boost', version: '1.84.0' }, android: { pin: 'toml:boost', version: '1.83.0' } },
      { name: 'folly', license: 'Apache-2.0', text: 'folly.txt', ios: { pin: 'podspec:RCT-Folly', version: '2024.11.18.00' }, android: { pin: 'toml:folly', version: '2024.11.18.00' } },
      { name: 'SocketRocket', license: 'BSD-3-Clause', text: 'socketrocket.txt', ios: { pin: 'helpers:socket_rocket', version: '0.7.1' } },
    ],
  },
  android: { fromNpm: { 'com.facebook.react:react-android': 'react-native' }, overrides: {} },
};

const PODFILE = `PODS:
  - ZXingObjC (3.6.9):
    - ZXingObjC/All (= 3.6.9)
  - ZXingObjC/All (3.6.9)
  - React-Core (0.81.5):
    - React-Core/Default (= 0.81.5)
  - React-Core/Default (0.81.5)
  - "ExpoCamera (17.0.10)":
    - ExpoModulesCore
  - ProvianAppAttest (1.0.0)
  - ReactCodegen (0.81.5)
  - React-Core-prebuilt (0.81.5)
  - ReactNativeDependencies (0.81.5)
  - hermes-engine (0.81.5)

DEPENDENCIES:
  - ZXingObjC

SPEC REPOS:
  trunk:
    - ZXingObjC

EXTERNAL SOURCES:
  React-Core:
    :path: "../node_modules/react-native/"
  ExpoCamera:
    :path: "../node_modules/expo-camera/ios"
  ProvianAppAttest:
    :path: "../modules/provian-app-attest/ios"
  ReactCodegen:
    :path: build/generated/ios
  React-Core-prebuilt:
    :podspec: "../node_modules/react-native/React-Core-prebuilt.podspec"
  ReactNativeDependencies:
    :podspec: "../node_modules/react-native/third-party-podspecs/ReactNativeDependencies.podspec"
  hermes-engine:
    :podspec: "../node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec"
    :tag: hermes-2025

SPEC CHECKSUMS:
  ZXingObjC: abc
`;

const ios = (podfileText, manifest = MANIFEST, npm = NPM) => iosEntries({ podfile: parsePodfileLock(podfileText), manifest, npm, licenseDir, reactNativeVersion: '0.81.5' });

describe('iOS pods', () => {
  it('lists a trunk pod at its locked version and the reviewed node_modules podspec pods; skips npm packages\' pods and first-party pods', () => {
    const { entries, expanded } = ios(PODFILE);
    expect(entries).toEqual([
      { name: 'ZXingObjC', version: '3.6.9', platform: 'ios', license: 'Apache-2.0', text: 'Apache License 2.0 text' },
      { name: 'hermes-engine', version: '0.81.5', platform: 'ios', license: 'MIT', text: 'MIT License\n\nCopyright Meta' },
    ]);
    expect(expanded).toEqual(['ReactNativeDependencies']);
    expect(npmPackageOfPath('../node_modules/@walletconnect/react-native-compat')).toBe('@walletconnect/react-native-compat');
    expect(npmPackageOfPath('../modules/provian-app-attest/ios')).toBeNull();
  });

  it('RED: refuses a trunk pod whose locked version moved, an unreviewed pod, and a reviewed pod the lockfile dropped', () => {
    expect(() => ios(PODFILE.replaceAll('3.6.9', '3.7.0'))).toThrow(/ZXingObjC is locked at 3\.7\.0 but .* records 3\.6\.9/);
    expect(() => ios(PODFILE.replace('  - ProvianAppAttest (1.0.0)\n', '  - ProvianAppAttest (1.0.0)\n  - SomeTrunkPod (2.0.0)\n'))).toThrow(/pod SomeTrunkPod 2\.0\.0 is not in/);
    expect(() => ios(PODFILE.replace(/ {2}- ZXingObjC.*\n( {4}- .*\n)?/g, ''))).toThrow(/names pod ZXingObjC, which Podfile\.lock no longer pins/);
  });

  it('RED: refuses a node_modules pod whose npm package is not in the closure, and a local path that is neither npm nor first-party', () => {
    expect(() => ios(PODFILE, MANIFEST, NPM.filter((e) => e.name !== 'expo-camera'))).toThrow(/npm package expo-camera is not in the production closure/);
    expect(() => ios(PODFILE.replace('"../modules/provian-app-attest/ios"', '"../vendor/someone-else/ios"'))).toThrow(/neither node_modules nor a first-party path/);
  });

  it('reads the committed lockfile: ZXingObjC at its locked version, no React-Core, no Provian pod', () => {
    const podfile = parsePodfileLock(readFileSync(join(root, PODFILE_LOCK), 'utf8'));
    expect(podfile.pods.get('ZXingObjC')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(podfile.external.get('ProvianAppAttest').path).toBe('../modules/provian-app-attest/ios');
  });
});

describe('react-native native dependencies', () => {
  const rn = install(scratch, 'rn', { name: 'react-native', version: '0.81.5' }, {
    'scripts/cocoapods/helpers.rb': "@@boost_config = {\n  :git => 'x'\n}\n@@socket_rocket_config = {\n  :version => '0.7.1'\n}\n@@folly_config = {\n  :version => '2024.11.18.00',\n  :git => 'y'\n}\n",
    'third-party-podspecs/boost.podspec': "spec.version = '1.84.0'\n",
    'third-party-podspecs/RCT-Folly.podspec': "folly_release_version = folly_config[:version]\nspec.version = folly_release_version\n",
    'third-party-podspecs/ReactNativeDependencies.podspec': 'spec.version = version\n',
    'gradle/libs.versions.toml': '[versions]\nkotlin = "2.1.20"\n# Native Dependencies\nboost="1_83_0"\nfolly="2024.11.18.00"\ngflags="2.2.0"\n\n[libraries]\nx = { module = "a:b" }\n',
  });
  const pins = reactNativePins(rn);
  const build = (manifest = MANIFEST, p = pins) => reactNativeDependencyEntries({ manifest, pins: p, ios: true, android: true, licenseDir });

  it('lists each library per platform, once when both platforms ship the same version', () => {
    expect(pins.nativeKeys).toEqual(['boost', 'folly', 'gflags']);
    expect(build().map((e) => `${e.platform} ${e.name}@${e.version}`)).toEqual([
      'ios boost@1.84.0', 'android boost@1.83.0', 'ios-android folly@2024.11.18.00', 'ios SocketRocket@0.7.1',
    ]);
  });

  it('RED: refuses a reviewed version react-native no longer pins, and a native pin nobody reviewed', () => {
    const moved = structuredClone(pins);
    moved.tomlPins.folly = '2025.01.01.00';
    expect(() => build(MANIFEST, moved)).toThrow(/folly: react-native 0\.81\.5 pins 2025\.01\.01\.00 for android/);
    const added = structuredClone(pins);
    added.nativeKeys.push('nlohmannjson');
    expect(() => build(MANIFEST, added)).toThrow(/unreviewed Android native dependency nlohmannjson/);
    const podspec = structuredClone(pins);
    podspec.podspecs.fmt = '11.0.2';
    expect(() => build(MANIFEST, podspec)).toThrow(/unreviewed iOS native dependency fmt/);
  });
});

describe('Android runtime classpath', () => {
  const runtime = (fingerprint) => ({
    fingerprint,
    artifacts: [
      { id: 'androidx.core:core:1.16.0', license: 'Apache-2.0', text: 'apache-2.0.txt' },
      { id: 'com.facebook.fresco:fresco:3.6.0', license: 'MIT', text: null },
      { id: 'com.facebook.react:react-android:0.81.5', npm: 'react-native' },
      { id: 'host.exp.exponent:expo.modules.camera:17.0.10', npm: 'expo-camera' },
    ],
  });

  it('lists each runtime artifact and leaves out the ones npm packages ship', () => {
    const { entries, reactAndroid } = androidEntries({ runtime: runtime('sha256:x'), npm: NPM, fingerprint: 'sha256:x', licenseDir });
    expect(entries).toEqual([
      { name: 'androidx.core:core', version: '1.16.0', platform: 'android', license: 'Apache-2.0', text: 'Apache License 2.0 text' },
      { name: 'com.facebook.fresco:fresco', version: '3.6.0', platform: 'android', license: 'MIT', text: null },
    ]);
    expect(reactAndroid).toBe(true);
  });

  it('RED: refuses a list whose fingerprint no longer matches, and an artifact attributed to a package npm does not install', () => {
    expect(() => androidEntries({ runtime: runtime('sha256:old'), npm: NPM, fingerprint: 'sha256:new', licenseDir })).toThrow(/android-runtime\.json is stale/);
    expect(() => androidEntries({ runtime: runtime('sha256:x'), npm: NPM.filter((e) => e.name !== 'expo-camera'), fingerprint: 'sha256:x', licenseDir })).toThrow(/attributed to npm package expo-camera/);
    expect(() => androidEntries({ runtime: { fingerprint: 'sha256:x', artifacts: [] }, npm: NPM, fingerprint: 'sha256:x', licenseDir })).toThrow(/lists no artifacts/);
  });

  it('marks a library that ships a third-party notices file as bundled, not as shipping no license file', () => {
    const bundled = { fingerprint: 'sha256:x', artifacts: [
      { id: 'com.google.android.gms:play-services-base:18.5.0', license: 'Android Software Development Kit License', text: null, bundledNotices: true },
      { id: 'com.google.android.datatransport:transport-runtime:3.1.9', license: 'Apache-2.0', text: 'apache-2.0.txt', bundledNotices: true },
      { id: 'com.android.installreferrer:installreferrer:2.2', license: 'Android Software Development Kit License', text: null },
    ] };
    const { entries } = androidEntries({ runtime: bundled, npm: NPM, fingerprint: 'sha256:x', licenseDir });
    expect(entries.map((e) => [e.name, e.text === null, e.notice])).toEqual([
      ['com.google.android.gms:play-services-base', true, 'bundled_not_reproduced'],
      ['com.google.android.datatransport:transport-runtime', false, 'bundled_not_reproduced'],
      ['com.android.installreferrer:installreferrer', true, undefined],
    ]);
    const built = assemble(entries);
    expect(built.notices.find((n) => n.name === 'com.google.android.gms:play-services-base')).toEqual({ name: 'com.google.android.gms:play-services-base', version: '18.5.0', platform: 'android', license: 'Android Software Development Kit License', text: -1, notice: 'bundled_not_reproduced' });
    expect(Object.hasOwn(built.notices.find((n) => n.name === 'com.android.installreferrer:installreferrer'), 'notice')).toBe(false);
  });

  it('RED: refuses a bundled flag that is not true, and an unknown notice state', () => {
    const bad = { fingerprint: 'sha256:x', artifacts: [{ id: 'g:a:1', license: 'MIT', text: null, bundledNotices: 'yes' }] };
    expect(() => androidEntries({ runtime: bad, npm: NPM, fingerprint: 'sha256:x', licenseDir })).toThrow(/bundledNotices "yes"; it is true or absent/);
    expect(() => assemble([{ name: 'x', version: '1', platform: 'android', license: 'MIT', text: null, notice: 'elsewhere' }])).toThrow(/unknown state "elsewhere"/);
  });

  it('RED: the fingerprint moves when a Gradle file or a native npm package version changes', () => {
    const repo = join(scratch, 'fp');
    install(repo, 'android', null, { 'app/build.gradle': 'implementation("a:b:1")\n' });
    const pkg = install(repo, 'node_modules/expo-camera', { name: 'expo-camera', version: '17.0.10' }, { 'android/build.gradle': '' });
    const plain = install(repo, 'node_modules/left-pad', { name: 'left-pad', version: '1.0.0' });
    const npm = [{ name: 'expo-camera', version: '17.0.10', dir: pkg }, { name: 'left-pad', version: '1.0.0', dir: plain }];
    const before = androidInputsFingerprint(repo, npm);
    expect(androidInputsFingerprint(repo, [npm[0], { ...npm[1], version: '1.0.1' }])).toBe(before);
    expect(androidInputsFingerprint(repo, [{ ...npm[0], version: '17.0.11' }, npm[1]])).not.toBe(before);
    writeFileSync(join(repo, 'android/app/build.gradle'), 'implementation("a:b:2")\n');
    expect(androidInputsFingerprint(repo, npm)).not.toBe(before);
  });
});

describe('assembly', () => {
  it('stores each text once and refuses a duplicate platform, name and version', () => {
    const built = assemble([
      { name: 'x', version: '1', platform: 'ios', license: 'MIT', text: 'T' },
      { name: 'x', version: '1', platform: 'android', license: 'MIT', text: 'T' },
    ]);
    expect(built.texts).toEqual(['T']);
    expect(built.notices.map((n) => n.platform)).toEqual(['android', 'ios']);
    expect(() => assemble([
      { name: 'x', version: '1', platform: 'ios', license: 'MIT', text: null },
      { name: 'x', version: '1', platform: 'ios', license: 'MIT', text: null },
    ])).toThrow(/duplicate notice ios x@1/);
  });
});

describe('the committed module', () => {
  const { built, next } = expectedModule(root);
  const has = (platform, name) => built.notices.find((n) => n.platform === platform && n.name === name);

  it('matches this checkout\'s lockfiles, installed packages and native sources', () => {
    expect(built.notices.length).toBeGreaterThan(1000);
    expect(isCurrent(resolve(root, OUT), next)).toBe(true);
  });

  it('includes a trunk pod at its locked version and an Android runtime artifact; excludes node_modules and Provian pods', () => {
    const podfile = parsePodfileLock(readFileSync(join(root, PODFILE_LOCK), 'utf8'));
    expect(has('ios', 'ZXingObjC')?.version).toBe(podfile.pods.get('ZXingObjC'));
    expect(has('ios', 'CocoaAsyncSocket')).toBeDefined();
    expect(has('ios-android', 'folly')).toBeDefined();
    expect(has('android', 'androidx.core:core')).toBeDefined();
    expect(has('android', 'com.squareup.okhttp3:okhttp')).toBeDefined();
    for (const pod of ['React-Core', 'React-Core-prebuilt', 'ExpoCamera', 'RNSVG', 'ProvianAppAttest', 'ProvianSecureSeed', 'ReactCodegen', 'ReactNativeDependencies']) {
      expect(built.notices.filter((n) => n.name === pod)).toEqual([]);
    }
    expect(built.notices.filter((n) => n.name.startsWith('host.exp.exponent:') || n.name === 'com.facebook.react:react-android')).toEqual([]);
  });

  it('RED: an npm-only module is stale against the full build', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const npmOnly = render(assemble(npmEntries(lock, root).map(({ dir: _dir, ...e }) => e)));
    const out = join(scratch, 'npm-only.generated.ts');
    writeFileSync(out, npmOnly);
    expect(isCurrent(out, next)).toBe(false);
    expect(isCurrent(out, render(buildAll(root)))).toBe(false);
  });
});

describe('a release number bump leaves the Android fingerprint unchanged', () => {
  const gradle = (versionCode, dep) => [
    'android {',
    '    defaultConfig {',
    `        versionCode ${versionCode}`,
    '        versionName "1.0.0"',
    '    }',
    '}',
    'dependencies {',
    `    implementation("${dep}")`,
    '}',
    '',
  ].join('\n');
  const fingerprintOf = (content) => {
    const root = mkdtempSync(join(tmpdir(), 'oss-fp-'));
    mkdirSync(join(root, 'android/app'), { recursive: true });
    writeFileSync(join(root, 'android/app/build.gradle'), content);
    try {
      return androidInputsFingerprint(root, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('strips only the versionCode and versionName lines', () => {
    const out = withoutReleaseNumbers(gradle(63, 'androidx.core:core:1.13.1'));
    expect(out).not.toMatch(/versionCode|versionName/);
    expect(out).toContain('implementation("androidx.core:core:1.13.1")');
  });

  it('a versionCode bump keeps the fingerprint; a dependency change moves it', () => {
    const base = fingerprintOf(gradle(62, 'androidx.core:core:1.13.1'));
    expect(fingerprintOf(gradle(63, 'androidx.core:core:1.13.1'))).toBe(base);
    expect(fingerprintOf(gradle(62, 'androidx.core:core:1.15.0'))).not.toBe(base);
  });
});
