import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { combinedLicense, localMavenModules, normalizeLicenseName, parseGradleOutput, shippedTexts } from './refresh-android.mjs';

// The Android runtime list is written from Gradle's resolved release classpath; modules an npm
// package ships from its own local Maven repository are attributed to that package.

const scratch = mkdtempSync(join(tmpdir(), 'oss-android-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('reading the Gradle output', () => {
  it('collects components and their POM licenses, ignoring other build output', () => {
    const out = [
      '> Configure project :app',
      'OSS-COMPONENT androidx.core:core:1.16.0',
      'OSS-LICENSE androidx.core:core:1.16.0 The Apache Software License, Version 2.0\thttp://www.apache.org/licenses/LICENSE-2.0.txt',
      'OSS-COMPONENT net.java.dev.jna:jna:5.17.0',
      'OSS-LICENSE net.java.dev.jna:jna:5.17.0 LGPL-2.1-or-later\thttps://www.gnu.org/licenses/old-licenses/lgpl-2.1',
      'OSS-LICENSE net.java.dev.jna:jna:5.17.0 Apache-2.0\thttps://www.apache.org/licenses/LICENSE-2.0.txt',
      'OSS-COMPONENT androidx.core:core:1.16.0',
    ].join('\n');
    const parsed = parseGradleOutput(out);
    expect(parsed.components).toEqual(['androidx.core:core:1.16.0', 'net.java.dev.jna:jna:5.17.0']);
    expect(combinedLicense(parsed.licenses.get('androidx.core:core:1.16.0'))).toBe('Apache-2.0');
    expect(combinedLicense(parsed.licenses.get('net.java.dev.jna:jna:5.17.0'))).toBe('LGPL-2.1-or-later OR Apache-2.0');
    expect(combinedLicense([])).toBeNull();
  });

  it('RED: refuses output with no components (the init script did not run)', () => {
    expect(() => parseGradleOutput('BUILD SUCCESSFUL')).toThrow(/no OSS-COMPONENT lines/);
  });

  it('normalizes only the Apache 2.0 and MIT spellings', () => {
    for (const n of ['The Apache Software License, Version 2.0', 'Apache-2', 'APACHE-2', 'Apache 2.0', 'The Apache License, Version 2.0']) expect(normalizeLicenseName(n)).toBe('Apache-2.0');
    for (const n of ['MIT', 'The MIT License', 'MIT license']) expect(normalizeLicenseName(n)).toBe('MIT');
    expect(normalizeLicenseName('Android Software Development Kit License')).toBe('Android Software Development Kit License');
    expect(normalizeLicenseName('Simplified BSD License')).toBe('Simplified BSD License');
  });
});

/** Build a zip archive at `out` holding `files` (name -> content). */
function zipOf(out, files) {
  const dir = mkdtempSync(join(scratch, 'zip-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  execFileSync('zip', ['-q', '-r', out, ...Object.keys(files)], { cwd: dir });
  return out;
}

describe('third-party notices files Google artifacts ship', () => {
  const NOTICES = 'Animal Sniffer:\n\nThe MIT License\n\nCopyright (c) 2008 Kohsuke Kawaguchi\n';

  it('flags a library whose third_party_licenses.txt is non-empty, and does not reproduce it', () => {
    const jar = zipOf(join(scratch, 'bundled.jar'), { 'third_party_licenses.txt': NOTICES, 'third_party_licenses.json': '{}', 'LICENSE': NOTICES });
    expect(shippedTexts(jar)).toEqual({ licenses: [], notices: [], bundledNotices: true });
  });

  it('flags one whose notices file sits inside an aar\'s classes.jar', () => {
    const inner = zipOf(join(scratch, 'classes.jar'), { 'third_party_licenses.txt': NOTICES });
    const aar = zipOf(join(scratch, 'nested.aar'), { 'AndroidManifest.xml': '<manifest/>' });
    execFileSync('zip', ['-q', '-j', aar, inner]);
    expect(shippedTexts(aar).bundledNotices).toBe(true);
  });

  it('RED: does not flag a library whose third_party_licenses.txt is empty, or one without the file', () => {
    const empty = zipOf(join(scratch, 'empty.jar'), { 'third_party_licenses.txt': '', 'third_party_licenses.json': '{}' });
    expect(shippedTexts(empty)).toEqual({ licenses: [], notices: [], bundledNotices: false });
    const blank = zipOf(join(scratch, 'blank.jar'), { 'third_party_licenses.txt': ' \n\n' });
    expect(shippedTexts(blank).bundledNotices).toBe(false);
    const plain = zipOf(join(scratch, 'plain.jar'), { 'META-INF/LICENSE.txt': 'Apache License\n', 'META-INF/NOTICE.txt': 'Notice\n' });
    expect(shippedTexts(plain)).toEqual({ licenses: ['Apache License'], notices: ['Notice'], bundledNotices: false });
  });
});

describe('modules npm packages ship', () => {
  it('maps each POM in a package\'s local Maven repository to that package', () => {
    const dir = join(scratch, 'node_modules/expo-camera');
    const v = join(dir, 'local-maven-repo/host/exp/exponent/expo.modules.camera/17.0.10');
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, 'expo.modules.camera-17.0.10.pom'), '<project/>');
    const plain = join(scratch, 'node_modules/left-pad');
    mkdirSync(plain, { recursive: true });
    const map = localMavenModules([{ name: 'expo-camera', version: '17.0.10', dir }, { name: 'left-pad', version: '1.0.0', dir: plain }]);
    expect([...map]).toEqual([['host.exp.exponent:expo.modules.camera:17.0.10', 'expo-camera']]);
  });
});
