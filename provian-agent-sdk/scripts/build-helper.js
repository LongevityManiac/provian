#!/usr/bin/env node
/**
 * build-helper: produce the native foreground-capture helper(s) and stage them
 * into bin/helpers/<platform>/ so `npm pack` / `npm publish` bundle them into the
 * tarball (the `files` allowlist ships `bin/helpers`, and postinstall-helper.js
 * copies them to ~/.provian/helpers/<platform>/ at install time).
 *
 * Why this exists: prepublishOnly runs `npm run build` (tsc + copy-assets) only,
 * which never builds the native helper. Without this step a *local* publish (or
 * a bare `npm pack`) ships an empty bin/helpers, postinstall prints "foreground
 * helper not bundled," and the LLMSessionPlugin self-disables for "no foreground
 * helper binary" — so ai_conversation capture never runs on a freshly-installed
 * human desktop (the only place it runs — agent devices never start it). Wiring this into `prepack` makes the package build the helper itself, so
 * it is correct regardless of the publish path.
 *
 * Runs on `npm pack` AND `npm publish` (both fire `prepack`). It is idempotent
 * and CI-safe:
 *   - SKIP-IF-PRESENT: if bin/helpers/<platform>/ already carries a built helper,
 *     it is left untouched. This is the key that keeps build-foreground-helpers.yml
 *     intact — that workflow builds the macOS (Swift) helper on macos-latest and
 *     the Windows (.NET) helper on windows-latest, downloads BOTH into
 *     bin/helpers/ on the ubuntu `package` runner, then `npm pack`s. This step's
 *     prepack must be a no-op there (ubuntu cannot build a Swift/.NET helper).
 *   - PLATFORM-GUARDED: only the helper for the CURRENT platform is ever built
 *     here (darwin builds the .app; win32 builds the .exe). A cross-platform
 *     helper (e.g. the Windows .exe on a Mac) can only come from the native CI
 *     runner, so if it is absent this step warns and continues — it never fails a
 *     pack/publish over a helper this host cannot produce.
 *
 * Platform coverage:
 *   - macOS: build.sh produces a UNIVERSAL (arm64 + x86_64) .app by default, so
 *     the one binary runs on both Apple-silicon and Intel Macs. Fatal if the
 *     Swift toolchain is missing on a Mac (a mac publish must build it).
 *   - Windows: a self-contained win-x64 .exe. dotnet can cross-compile it from
 *     any host (EnableWindowsTargeting), so this builds it wherever the .NET 8
 *     SDK is present — but NON-FATALLY: the authoritative Windows builder is the
 *     windows-latest CI runner (build-foreground-helpers.yml), and a flaky local
 *     cross-build must never break a Mac publish that already has the mac helper.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const NATIVE_DARWIN_DIR = path.join(PKG_ROOT, 'native', 'darwin', 'foreground-helper');
const NATIVE_WIN32_DIR = path.join(PKG_ROOT, 'native', 'win32', 'foreground-helper');

const DARWIN_STAGE_DIR = path.join(PKG_ROOT, 'bin', 'helpers', 'darwin');
const DARWIN_APP = 'ProvianForegroundHelper.app';
const DARWIN_STAGED_BIN = path.join(
  DARWIN_STAGE_DIR, DARWIN_APP, 'Contents', 'MacOS', 'ProvianForegroundHelper',
);

const WIN32_STAGE_DIR = path.join(PKG_ROOT, 'bin', 'helpers', 'win32');
const WIN32_STAGED_EXE = path.join(WIN32_STAGE_DIR, 'ProvianForegroundHelper.exe');

function log(msg) {
  process.stdout.write(`build-helper: ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`build-helper: ${msg}\n`);
}

function haveCommand(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

// ---------------------------------------------------------------------------
// macOS (Swift) helper
// ---------------------------------------------------------------------------

function buildDarwinHelper() {
  if (fs.existsSync(DARWIN_STAGED_BIN)) {
    log('macOS helper already staged at bin/helpers/darwin — skipping build.');
    return;
  }
  if (process.platform !== 'darwin') {
    warn(
      'macOS helper is absent and cannot be built on this platform. It is built '
      + 'on macOS (or the macos-latest runner in build-foreground-helpers.yml). '
      + 'ai_conversation capture will be unavailable on macOS desktops in this package.',
    );
    return;
  }
  if (!haveCommand('swift')) {
    // On a Mac publish we EXPECT the Swift toolchain; a missing one means a
    // silently helper-less publish, so fail loudly rather than ship broken.
    throw new Error(
      'swift toolchain not found (install Xcode Command Line Tools: '
      + '`xcode-select --install`). Cannot build the macOS foreground helper.',
    );
  }

  log('building macOS helper via native/darwin/foreground-helper/build.sh …');
  const built = spawnSync('bash', ['build.sh'], {
    cwd: NATIVE_DARWIN_DIR,
    stdio: 'inherit',
  });
  if (built.error) throw built.error;
  if (built.status !== 0) {
    throw new Error(`build.sh failed with exit code ${built.status}`);
  }

  const nativeApp = path.join(NATIVE_DARWIN_DIR, DARWIN_APP);
  if (!fs.existsSync(path.join(nativeApp, 'Contents', 'MacOS', 'ProvianForegroundHelper'))) {
    throw new Error(`build.sh did not produce ${nativeApp}`);
  }

  // Stage the whole .app bundle. `cp -R` preserves the bundle layout, the
  // executable bit, and the embedded ad-hoc code signature (a JS recursive copy
  // would need to re-apply the exec bit; cp -R just works and matches the CI
  // "cp -R … bin/helpers/darwin/" step exactly).
  fs.mkdirSync(DARWIN_STAGE_DIR, { recursive: true });
  fs.rmSync(path.join(DARWIN_STAGE_DIR, DARWIN_APP), { recursive: true, force: true });
  const staged = spawnSync('cp', ['-R', nativeApp, DARWIN_STAGE_DIR], { stdio: 'inherit' });
  if (staged.error) throw staged.error;
  if (staged.status !== 0) {
    throw new Error(`staging the .app into bin/helpers/darwin failed (exit ${staged.status})`);
  }

  if (!fs.existsSync(DARWIN_STAGED_BIN)) {
    throw new Error(`staged helper binary missing at ${DARWIN_STAGED_BIN}`);
  }
  try {
    fs.accessSync(DARWIN_STAGED_BIN, fs.constants.X_OK);
  } catch {
    throw new Error(`staged helper binary is not executable: ${DARWIN_STAGED_BIN}`);
  }
  // Surface the shipped architectures so a silently single-arch stage is visible.
  const archs = spawnSync('lipo', ['-archs', DARWIN_STAGED_BIN], { encoding: 'utf8' });
  if (!archs.error && archs.status === 0) {
    log(`macOS helper archs: ${archs.stdout.trim()}`);
  }
  log(`macOS helper staged → ${path.relative(PKG_ROOT, DARWIN_STAGED_BIN)}`);
}

// ---------------------------------------------------------------------------
// Windows (.NET) helper
// ---------------------------------------------------------------------------

function buildWin32Helper() {
  if (fs.existsSync(WIN32_STAGED_EXE)) {
    log('Windows helper already staged at bin/helpers/win32 — skipping build.');
    return;
  }
  // Non-fatal throughout: CI's windows-latest runner is the authoritative
  // Windows builder, so a missing SDK or a flaky local cross-build must never
  // break a Mac publish that already carries the macOS helper.
  if (!haveCommand('dotnet')) {
    warn(
      'Windows helper is absent and the .NET SDK (dotnet) is not installed here. '
      + 'It is built + bundled by the windows-latest runner in '
      + 'build-foreground-helpers.yml; install the .NET 8 SDK to build it locally. '
      + 'ai_conversation capture will be unavailable on Windows desktops in this package.',
    );
    return;
  }
  try {
    // dotnet cross-compiles a self-contained win-x64 single-file .exe from any
    // host; EnableWindowsTargeting lets the net8.0-windows (WinForms/WPF) TFM
    // build off Windows. Publish to native/win32/.../publish, then stage ONLY
    // the .exe (matching build.ps1) so no .pdb/side files leak into the tarball.
    const csproj = path.join(NATIVE_WIN32_DIR, 'ProvianForegroundHelper.csproj');
    const publishDir = path.join(NATIVE_WIN32_DIR, 'publish');
    log('building Windows helper via dotnet publish (win-x64, self-contained) …');
    const built = spawnSync('dotnet', [
      'publish', csproj,
      '-c', 'Release',
      '-r', 'win-x64',
      '--self-contained', 'true',
      '-p:PublishSingleFile=true',
      '-p:EnableWindowsTargeting=true',
      '-o', publishDir,
    ], { cwd: NATIVE_WIN32_DIR, stdio: 'inherit' });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error(`dotnet publish failed with exit code ${built.status}`);

    const publishedExe = path.join(publishDir, 'ProvianForegroundHelper.exe');
    if (!fs.existsSync(publishedExe)) {
      throw new Error(`dotnet publish did not produce ${publishedExe}`);
    }
    fs.mkdirSync(WIN32_STAGE_DIR, { recursive: true });
    fs.copyFileSync(publishedExe, WIN32_STAGED_EXE);
    log(`Windows helper staged → ${path.relative(PKG_ROOT, WIN32_STAGED_EXE)}`);
  } catch (err) {
    warn(
      `Windows helper cross-build failed (${err && err.message ? err.message : String(err)}). `
      + 'The windows-latest CI runner remains the authoritative Windows builder; '
      + 'continuing without the Windows helper in this local package.',
    );
  }
}

function main() {
  buildDarwinHelper();
  buildWin32Helper();

  const present = [];
  if (fs.existsSync(DARWIN_STAGED_BIN)) present.push('darwin');
  if (fs.existsSync(WIN32_STAGED_EXE)) present.push('win32');
  log(`bin/helpers now carries: ${present.length ? present.join(', ') : '(none)'}`);
}

main();
