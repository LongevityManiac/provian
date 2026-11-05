// L326 — `expo prebuild --clean` must regenerate the committed Android RELEASE settings, not Expo's
// template. Run against the REAL template prebuild uses (node_modules/expo/template.tgz) and bound
// to the committed android/ files the plugin's text must reproduce.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = require(path.join(ROOT, 'plugins/withReleaseBuildConfig.js'));
const { AndroidConfig } = require('@expo/config-plugins');

const fromTemplate = (member) => execFileSync(
  'tar', ['-xzOf', path.join(ROOT, 'node_modules/expo/template.tgz'), member], { encoding: 'utf8' },
);
const TEMPLATE_GRADLE = fromTemplate('package/android/app/build.gradle');
const TEMPLATE_PROPS = fromTemplate('package/android/gradle.properties');
const COMMITTED_GRADLE = readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const COMMITTED_PROPS = readFileSync(path.join(ROOT, 'android/gradle.properties'), 'utf8');

const count = (s, needle) => s.split(needle).length - 1;
const DEBUG_SIGN = 'signingConfig signingConfigs.debug';

describe('withReleaseBuildConfig — app/build.gradle', () => {
  it('RED CONTROL — the template alone signs release with the DEBUG key and has no guard', () => {
    expect(count(TEMPLATE_GRADLE, DEBUG_SIGN)).toBe(2); // debug buildType AND release buildType
    expect(TEMPLATE_GRADLE).not.toContain('signingConfigs.release');
    expect(TEMPLATE_GRADLE).not.toContain('Release build refused');
  });

  it('the patched template signs release with the launch keystore and refuses a release without it', () => {
    const out = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    expect(count(out, DEBUG_SIGN)).toBe(1); // debug buildType only
    expect(count(out, 'signingConfig signingConfigs.release')).toBe(1);
    expect(out).toContain('def releaseKeystorePropsFile = rootProject.file("keystore.properties")');
    expect(out).toContain('Release build refused: android/keystore.properties is missing.');
  });

  it('every line it adds is the committed android/app/build.gradle text', () => {
    const out = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    const templateLines = new Set(TEMPLATE_GRADLE.split('\n'));
    const added = out.split('\n').filter((l) => !templateLines.has(l) && l.trim() !== '');
    expect(added.length).toBeGreaterThan(30);
    for (const line of added) expect(COMMITTED_GRADLE.split('\n')).toContain(line);
  });

  it('is idempotent', () => {
    const once = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    expect(plugin.applyReleaseSigning(once)).toBe(once);
  });

  it('RED CONTROL — a template whose release signing anchor moved FAILS the prebuild, never ships debug-signed', () => {
    const moved = TEMPLATE_GRADLE.replace('// Caution! In production, you need to generate your own keystore file.', '// changed');
    expect(moved).not.toBe(TEMPLATE_GRADLE);
    expect(() => plugin.applyReleaseSigning(moved)).toThrow(/anchor for the release buildType signing/);
  });
});

describe('withReleaseBuildConfig — gradle.properties', () => {
  const render = (items) => AndroidConfig.Properties.propertiesListToString(items);

  it('RED CONTROL — the template turns release PNG crunching ON', () => {
    expect(TEMPLATE_PROPS).toContain('android.enablePngCrunchInReleaseBuilds=true');
  });

  it('turns it off with the committed comment, exactly once', () => {
    const out = render(plugin.applyPngCrunchOff(AndroidConfig.Properties.parsePropertiesFile(TEMPLATE_PROPS)));
    expect(count(out, 'android.enablePngCrunchInReleaseBuilds=')).toBe(1);
    expect(out).toContain('android.enablePngCrunchInReleaseBuilds=false');
    const block = out.slice(out.indexOf('# AAPT2 PNG crunching is DISABLED'), out.indexOf('=false') + '=false'.length);
    expect(block.length).toBeGreaterThan(100);
    expect(COMMITTED_PROPS).toContain(block);
  });
});
