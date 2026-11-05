#!/usr/bin/env node
/**
 * postinstall-helper: copy the foreground helper from the packaged SDK into
 * ~/.provian/helpers/<platform>/ so the LLMSessionPlugin can resolve it at
 * runtime without hitting any in-repo dev paths. macOS gets the
 * ProvianForegroundHelper.app bundle; Windows gets the
 * ProvianForegroundHelper.exe (self-contained single-file publish).
 *
 * Skips silently when:
 *   - platform is neither darwin nor win32 (e.g. Linux: no helper yet),
 *   - the source helper is not bundled in the SDK tarball,
 *   - any copy/permission operation fails.
 *
 * Postinstall scripts must never break install, so every failure path
 * here is catch-and-log (stderr) with a non-zero process.exitCode avoided.
 *
 * The consent gate is separate: the helper binary lands on disk
 * unconditionally so opting back in later (setting
 * `"capture": { "llm_session_enabled": true }` in ~/.provian/config.json)
 * does not require reinstalling the SDK.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dst);
    // Preserve executable bits on binary files.
    try { fs.chmodSync(dst, stat.mode); } catch { /* ignore */ }
  }
}

function removeIfExists(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function isDevCheckout() {
  // Heuristic: dev checkouts have a tsconfig.json next to package.json. The
  // shipped tarball does not. npm installs land in node_modules/<pkg>/ which
  // also lacks tsconfig.json.
  return fs.existsSync(path.resolve(__dirname, '..', 'tsconfig.json'));
}

function installDarwinHelper() {
  const source = path.resolve(__dirname, '..', 'bin', 'helpers', 'darwin', 'ProvianForegroundHelper.app');
  if (!fs.existsSync(source)) {
    if (!isDevCheckout()) {
      console.log('provian: foreground helper not bundled. To opt in, see https://provian.ai/developers');
    }
    return;
  }
  const targetDir = path.join(os.homedir(), '.provian', 'helpers', 'darwin');
  const target = path.join(targetDir, 'ProvianForegroundHelper.app');

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    removeIfExists(target);
    copyRecursive(source, target);
    // Clear quarantine so Gatekeeper does not prompt on first launch.
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', target], { stdio: 'ignore' });
  } catch (err) {
    // Silent failure. register-device will log again if the helper is missing.
    process.stderr.write(`provian: could not install foreground helper: ${err && err.message ? err.message : String(err)}\n`);
  }
}

function installWin32Helper() {
  const source = path.resolve(__dirname, '..', 'bin', 'helpers', 'win32', 'ProvianForegroundHelper.exe');
  if (!fs.existsSync(source)) {
    if (!isDevCheckout()) {
      console.log('provian: foreground helper not bundled. To opt in, see https://provian.ai/developers');
    }
    return;
  }
  const targetDir = path.join(os.homedir(), '.provian', 'helpers', 'win32');
  const target = path.join(targetDir, 'ProvianForegroundHelper.exe');

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    removeIfExists(target);
    copyRecursive(source, target);
    // No quarantine flag on Windows; SmartScreen is governed by the binary's
    // own signature, set at build/sign time, not by a postinstall xattr.
  } catch (err) {
    // Silent failure. register-device will log again if the helper is missing.
    process.stderr.write(`provian: could not install foreground helper: ${err && err.message ? err.message : String(err)}\n`);
  }
}

function main() {
  if (process.platform === 'darwin') {
    installDarwinHelper();
  } else if (process.platform === 'win32') {
    installWin32Helper();
  }
}

try {
  main();
} catch (err) {
  // Never fail the parent install.
  process.stderr.write(`provian postinstall skipped: ${err && err.message ? err.message : String(err)}\n`);
}
