#!/usr/bin/env node
// The Android release APK the site serves is named by the /download/android page:
// its VERSION picks the file name and its APK_SHA256 picks the object in the
// release bucket (gs://<bucket>/android/<sha256>.apk). This script is the one
// reader of those page facts.
//
//   node scripts/release-apk.mjs expect
//       prints "<sha256> <file name> <bytes>" for the build to fetch.
//   node scripts/release-apk.mjs verify <export dir>
//       refuses (exit 1) unless <export dir>/download/<file name> exists, has the
//       page's byte count and SHA-256, and is the only APK there. The site image
//       build runs this on the static export, so no image can carry a missing or
//       mismatched APK, whatever tree it was built from.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'download', 'android', 'page.tsx')

function fail(message) {
  console.error(`release-apk: ${message}`)
  process.exit(1)
}

function readPageFacts(source) {
  const one = (re, what) => {
    const matches = [...source.matchAll(re)]
    if (matches.length !== 1) fail(`expected exactly one ${what} in ${PAGE}, found ${matches.length}`)
    return matches[0][1]
  }
  const version = one(/^const VERSION = '([0-9A-Za-z.+-]+)'$/gm, "VERSION = '<version>'")
  // The download link is built from this template; if it changes, this reader must too.
  one(/^const APK_FILE = (`provian-wallet-\$\{VERSION\}\.apk`)$/gm, 'APK_FILE = `provian-wallet-${VERSION}.apk`')
  const sha256 = one(/^const APK_SHA256 = '([0-9a-f]{64})'$/gm, "APK_SHA256 = '<64 hex>'")
  const size = one(/^const APK_SIZE = '([0-9][0-9,]*) bytes \(/gm, "APK_SIZE = '<n> bytes (…)'")
  return { sha256, file: `provian-wallet-${version}.apk`, bytes: Number(size.replaceAll(',', '')) }
}

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function verify(exportDir, facts) {
  const dir = join(exportDir, 'download')
  const path = join(dir, facts.file)
  if (!existsSync(path)) fail(`${path} is missing; the page names ${facts.file} (sha256 ${facts.sha256})`)
  const others = readdirSync(dir).filter((name) => name.endsWith('.apk') && name !== facts.file)
  if (others.length > 0) fail(`unexpected APK(s) beside ${facts.file}: ${others.join(', ')}`)
  const bytes = statSync(path).size
  if (bytes !== facts.bytes) fail(`${facts.file} is ${bytes} bytes; the page says ${facts.bytes}`)
  const actual = await sha256Of(path)
  if (actual !== facts.sha256) fail(`${facts.file} sha256 is ${actual}; the page says ${facts.sha256}`)
  console.log(`release-apk: ok ${facts.file} ${facts.bytes} bytes sha256 ${facts.sha256}`)
}

const [mode, arg] = process.argv.slice(2)
const facts = readPageFacts(readFileSync(PAGE, 'utf8'))
if (mode === 'expect') {
  console.log(`${facts.sha256} ${facts.file} ${facts.bytes}`)
} else if (mode === 'verify' && arg) {
  await verify(arg, facts)
} else {
  fail('usage: release-apk.mjs expect | verify <export dir>')
}
