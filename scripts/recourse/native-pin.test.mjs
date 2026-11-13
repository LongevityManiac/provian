import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const hook = require('./native/metro-hook.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('isolated recovery and chain readers resolve the same fixture pointer domain', () => {
  const pin = path.join(root, 'src/core/protocol/pointer-pin.generated.ts');
  const original = { type: 'sourceFile', filePath: pin };
  const config = hook({ resolver: { resolveRequest: () => original } }, root);
  const resolve = origin => config.resolver.resolveRequest({ originModulePath: origin }, '../protocol/pointer-pin.generated', 'ios');
  expect(resolve(path.join(root, 'src/core/recourse/human-account.ts')).filePath)
    .toBe(path.join(root, 'scripts/recourse/native/pointer-pin.ts'));
  // Harness imports retain their explicit dependencies, without resolver recursion.
  expect(resolve(path.join(root, 'scripts/recourse/native/runtime.ts'))).toBe(original);
});

test('isolated resolver preserves unrelated production modules and assets', () => {
  for (const original of [
    { type: 'sourceFile', filePath: path.join(root, 'src/core/recourse/human-account.ts') },
    { type: 'assetFiles', filePaths: [path.join(root, 'assets/icon.png')] },
  ]) {
    const config = hook({ resolver: {} }, root);
    const found = config.resolver.resolveRequest({ originModulePath: path.join(root, 'App.tsx'), resolveRequest: () => original }, 'dependency', 'ios');
    expect(found).toBe(original);
  }
});

test('native cloud transport routes to local storage before the real backup flow loads', () => {
  const cloud = path.join(root, 'src/core/recovery/cloud/ProvianCloudKeychainSync.ts');
  const config = hook({ resolver: { resolveRequest: () => ({ type: 'sourceFile', filePath: cloud }) } }, root);
  const found = config.resolver.resolveRequest({ originModulePath: path.join(root, 'src/core/recovery/cloud/CloudBackupV2.ts') }, './ProvianCloudKeychainSync', 'ios');
  expect(found.filePath).toBe(path.join(root, 'scripts/recourse/native/cloud-storage.ts'));
  const peCloud = path.join(root, 'src/core/meter/cloudFiles.ts');
  const peConfig = hook({ resolver: { resolveRequest: () => ({ type: 'sourceFile', filePath: peCloud }) } }, root);
  expect(peConfig.resolver.resolveRequest({ originModulePath: path.join(root, 'src/core/meter/phoneMeterRuntime.ts') }, './cloudFiles', 'ios').filePath)
    .toBe(path.join(root, 'scripts/recourse/native/cloud-files.ts'));
});
