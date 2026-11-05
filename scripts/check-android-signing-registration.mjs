#!/usr/bin/env node
/**
 * Refuse a release APK whose signing key Google and the website do not know.
 *
 * WHY (2026-09-23, run): the Android launch key was rotated on 2026-09-20
 * (item C) and the website's assetlinks.json moved with it, but the Google
 * OAuth Android client that Drive backup signs in through still named the OLD key's
 * SHA-1. Every release build since then failed Google Sign-In with status 10
 * (DEVELOPER_ERROR): no wallet could be created with a Drive backup, and no wallet
 * could be recovered from one. Nothing checked the pairing, so it shipped silently.
 *
 * This check binds the APK's actual signer to both registrations the app depends on:
 * 1. android/app/google-services.json — an Android OAuth client (client_type 1) for
 * the package whose certificate_hash is the signer's SHA-1 (Google Sign-In /
 * Drive appDataFolder backup and recovery);
 * 2. provian-website/public/.well-known/assetlinks.json — the signer's SHA-256
 * (App Links / credential sharing).
 * google-services.json must be the LIVE config (re-pull it after changing the OAuth
 * client: `firebase apps:sdkconfig ANDROID <appId> --project=provian`), so a key
 * rotation that skips the Google side fails here, at build time, not on a user's phone.
 *
 * Usage: node scripts/check-android-signing-registration.mjs <path-to-apk>
 * Exit 0 = registered; exit 1 = refused (the reason is printed).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'com.provian.wallet';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GOOGLE_SERVICES_PATH = path.join(REPO_ROOT, 'android', 'app', 'google-services.json');
export const ASSETLINKS_PATH = path.join(REPO_ROOT, 'provian-website', 'public', '.well-known', 'assetlinks.json');

const hex = (s) => String(s ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();

/** Parse `apksigner verify --print-certs` output → the first signer's SHA-1 and SHA-256 (bare lowercase hex). */
export function parseSignerDigests(apksignerOutput) {
  const sha1 = /Signer #1 certificate SHA-1 digest:\s*([0-9a-f:]+)/i.exec(apksignerOutput);
  const sha256 = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i.exec(apksignerOutput);
  if (!sha1 || !sha256) throw new Error('could not read the signer digests from apksigner output');
  return { sha1: hex(sha1[1]), sha256: hex(sha256[1]) };
}

/** Parse `keytool -printcert -jarfile <aab>` output → the first certificate's SHA-1 and SHA-256 (bare lowercase hex). */
export function parseKeytoolDigests(keytoolOutput) {
  const sha1 = /SHA1:\s*([0-9a-f:]+)/i.exec(keytoolOutput);
  const sha256 = /SHA256:\s*([0-9a-f:]+)/i.exec(keytoolOutput);
  if (!sha1 || !sha256) throw new Error('could not read the signer digests from keytool output');
  return { sha1: hex(sha1[1]), sha256: hex(sha256[1]) };
}

/**
 * PURE: every reason the signer is not registered (empty = registered).
 * @param {{sha1: string, sha256: string}} signer
 * @param {unknown} googleServices parsed google-services.json
 * @param {unknown} assetlinks parsed assetlinks.json
 */
export function registrationProblems(signer, googleServices, assetlinks, packageName = PACKAGE_NAME) {
  const problems = [];
  const clients = (googleServices?.client ?? []).flatMap((c) => c?.oauth_client ?? []);
  const androidHashes = clients
    .filter((c) => c?.client_type === 1 && c?.android_info?.package_name === packageName)
    .map((c) => hex(c.android_info.certificate_hash));
  if (!androidHashes.includes(signer.sha1)) {
    problems.push(
      `google-services.json has no Android OAuth client for ${packageName} with the signer's SHA-1 ${signer.sha1} ` +
      `(registered: ${androidHashes.length ? androidHashes.join(', ') : 'none'}). Google Sign-In (Drive backup + recovery) ` +
      'would fail with status 10. Update the Android OAuth client in Google Cloud (project provian → Google Auth Platform → ' +
      'Clients) to this SHA-1, then re-pull google-services.json.',
    );
  }
  const statements = Array.isArray(assetlinks) ? assetlinks : [];
  const linked = statements
    .filter((s) => s?.target?.namespace === 'android_app' && s?.target?.package_name === packageName)
    .flatMap((s) => s.target.sha256_cert_fingerprints ?? [])
    .map(hex);
  if (!linked.includes(signer.sha256)) {
    problems.push(
      `assetlinks.json does not list the signer's SHA-256 ${signer.sha256} for ${packageName} ` +
      `(listed: ${linked.length ? linked.join(', ') : 'none'}). App Links and credential sharing would fail.`,
    );
  }
  return problems;
}

function apksignerPath() {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.HOME ?? '', 'Library', 'Android', 'sdk');
  const dir = path.join(sdk, 'build-tools');
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  if (versions.length === 0) throw new Error(`no Android build-tools under ${dir}`);
  return path.join(dir, versions[versions.length - 1], 'apksigner');
}

function main() {
  const apk = process.argv[2];
  if (!apk || !fs.existsSync(apk)) {
    console.error('usage: node scripts/check-android-signing-registration.mjs <path-to-apk-or-aab>');
    process.exit(1);
  }
  // A Play bundle (.aab) is JAR-signed; an APK carries APK signature blocks.
  const signer = apk.endsWith('.aab')
    ? parseKeytoolDigests(execFileSync('keytool', ['-printcert', '-jarfile', apk], { encoding: 'utf8' }))
    : parseSignerDigests(execFileSync(apksignerPath(), ['verify', '--print-certs', apk], { encoding: 'utf8' }));
  const problems = registrationProblems(
    signer,
    JSON.parse(fs.readFileSync(GOOGLE_SERVICES_PATH, 'utf8')),
    JSON.parse(fs.readFileSync(ASSETLINKS_PATH, 'utf8')),
  );
  if (problems.length > 0) {
    console.error('REFUSED: the release build is signed with a key Google or the website does not know.');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`signing registration ok — SHA-1 ${signer.sha1} (Google OAuth client) and SHA-256 ${signer.sha256} (assetlinks) are registered for ${PACKAGE_NAME}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
