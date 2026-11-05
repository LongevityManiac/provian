/**
 * follow-through: `expo prebuild --clean` must restore the committed native
 * modules exactly. The config plugins that write them read `plugins/native/`, and
 * this suite pins those sources byte-identical to the committed `ios/` and
 * `android/` trees, so a native edit that skips `plugins/native/` goes RED here
 * instead of being silently reverted by the next clean prebuild.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMITTED_DIR = {
  ios: join(repoRoot, 'ios/Provian'),
  android: join(repoRoot, 'android/app/src/main/java/com/provian/wallet'),
};

/** The plugins app.json runs, as loaded modules keyed by their app.json path. */
function appPlugins() {
  const app = JSON.parse(readFileSync(join(repoRoot, 'app.json'), 'utf8'));
  return app.expo.plugins
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    .filter((name) => name.startsWith('./plugins/'))
    .map((name) => ({ name, mod: require(join(repoRoot, name)), source: readFileSync(join(repoRoot, `${name}.js`), 'utf8') }));
}

/** Every (platform, file) whose plugin source is `plugins/native/`, with both byte buffers. */
function nativeSourcePairs() {
  const pairs = [];
  for (const { name, mod } of appPlugins()) {
    if (!mod.NATIVE_FILES) continue;
    for (const [platform, files] of Object.entries(mod.NATIVE_FILES)) {
      for (const file of files) {
        pairs.push({
          plugin: name,
          label: `${platform}/${file}`,
          pluginSource: readFileSync(join(repoRoot, 'plugins/native', platform, file)),
          committed: readFileSync(join(COMMITTED_DIR[platform], file)),
        });
      }
    }
  }
  return pairs;
}

/** Names of the pairs whose plugin source differs from the committed file. */
export function divergentPairs(pairs) {
  return pairs.filter((p) => !p.pluginSource.equals(p.committed)).map((p) => p.label);
}

describe('native plugin sources (plugins/native) match the committed native trees', () => {
  it('evaluates a non-empty population', () => {
    const pairs = nativeSourcePairs();
    // SecureEnclave (2 iOS + 2 Android) + CloudKeychainSync (2 iOS + 2 Android).
    expect(pairs.length).toBeGreaterThanOrEqual(8);
  });

  it('every plugin-written native file is byte-identical to the committed copy', () => {
    expect(divergentPairs(nativeSourcePairs())).toEqual([]);
  });

  it('RED control: a divergent plugin source is reported', () => {
    const [first] = nativeSourcePairs();
    const planted = { ...first, pluginSource: Buffer.concat([first.pluginSource, Buffer.from('\n// drift\n')]) };
    expect(divergentPairs([planted])).toEqual([first.label]);
  });

  it('every committed Provian native module file is restored by an app.json plugin', () => {
    const plugins = appPlugins();
    const restored = (file) =>
      plugins.some(({ mod, source }) =>
        Object.values(mod.NATIVE_FILES ?? {}).some((files) => files.includes(file)) || source.includes(`'${file}'`),
      );
    const committedModules = [
      ...readdirSync(COMMITTED_DIR.ios).filter((f) => /^Provian.+\.(swift|m)$/.test(f)),
      ...readdirSync(COMMITTED_DIR.android).filter((f) => /^Provian.+\.kt$/.test(f)),
    ];
    expect(committedModules.length).toBeGreaterThanOrEqual(12);
    expect(committedModules.filter((f) => !restored(f))).toEqual([]);
  });
});
