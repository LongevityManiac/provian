// Compare the frameworks actually embedded in the app with RN's configuration-specific
// archives. The .last_build_configuration markers can say Release while Hermes is Debug.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function parseUuids(output) {
  const entries = [...output.matchAll(/^UUID: ([A-Fa-f0-9-]{36}) \(([^)]+)\)/gm)];
  if (!entries.length) throw new Error('Runtime binary has no Mach-O UUIDs');
  return new Map(entries.map(([, uuid, arch]) => [arch, uuid.toUpperCase()]));
}

export function assertMatchingRuntime(expected, actual, name) {
  if (!expected.size || !actual.size) throw new Error(`${name}: empty runtime architecture set`);
  for (const [arch, uuid] of actual) {
    if (expected.get(arch) !== uuid) {
      throw new Error(`${name}: ${arch} runtime does not match the requested build configuration`);
    }
  }
}

export function checkIosRuntime(configuration, pods, frameworks, platform) {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error(`Unsupported configuration: ${configuration}`);
  const slice = { iphoneos: 'ios-arm64', iphonesimulator: 'ios-arm64_x86_64-simulator' }[platform];
  if (!slice) throw new Error(`Unsupported iOS platform: ${platform}`);
  const require = createRequire(import.meta.url);
  const version = require('react-native/package.json').version;
  const temp = mkdtempSync(path.join(tmpdir(), 'provian-runtime-'));
  const uuidOf = file => parseUuids(execFileSync('xcrun', ['dwarfdump', '--uuid', file], { encoding: 'utf8' }));
  try {
    for (const [name, archive, member] of [
      ['hermes', `hermes-engine-artifacts/hermes-ios-${version}-${configuration.toLowerCase()}.tar.gz`, `./destroot/Library/Frameworks/universal/hermes.xcframework/${slice}/hermes.framework/hermes`],
      ['React', `ReactNativeCore-artifacts/reactnative-core-${version}-${configuration.toLowerCase()}.tar.gz`, `React.xcframework/${slice}/React.framework/React`],
    ]) {
      execFileSync('tar', ['-xf', path.join(pods, archive), '-C', temp, member]);
      assertMatchingRuntime(uuidOf(path.join(temp, member)), uuidOf(path.join(frameworks, `${name}.framework`, name)), name);
    }
    console.log(`iOS runtime verified: React and Hermes both ${configuration} (${platform})`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    checkIosRuntime(...process.argv.slice(2));
  } catch (error) {
    console.error(`iOS build refused: ${error.message}. Re-extract the matching RN/Hermes pod archives and rebuild; do not trust configuration markers.`);
    process.exitCode = 1;
  }
}
