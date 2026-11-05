#!/usr/bin/env node
/**
 * Render the self-contained public legal and setup pages.
 *
 * These pages use inline CSS and no external scripts, fonts, images or chunks.
 * verifySelfContained() enforces that asset boundary. All renderings derive from
 * the canonical content, so a separate deployment form cannot change binding text.
 *
 * NO SECOND SOURCE OF LEGAL TEXT. The privacy page renders
 * `src/content/legal/privacy.md` the same file the Next `/privacy` route
 * renders, itself a byte-identical vendored copy of the canonical
 * `docs/legal/privacy-policy.md` (see sync-legal.mjs). Two renderings, one
 * source, so the public copy cannot drift from the canonical one. Same rule
 * for /daemon: both renderings consume `src/content/daemon.ts` (see below).
 *
 * node scripts/build-public-legal.mjs
 *
 * Output (committed, served by nginx with `auth_basic off`):
 * public/legal/privacy.html -> https://provian.ai/privacy
 * public/legal/terms.html -> https://provian.ai/terms
 * public/legal/home.html -> https://provian.ai/home
 * public/legal/daemon.html -> https://provian.ai/daemon
 *
 * TERMS ADDED AT brand verification's submission form takes a terms-of-
 * service URL alongside the privacy policy. It is optional, but a URL entered
 * there must resolve publicly or the submission bounces — so /terms is carved
 * out on the same terms as /privacy rather than left to fail at review.
 *
 * DAEMON ADDED AT (B7): the app's Earn tab links to
 * https://provian.ai/daemon for desktop-daemon setup, and that link must
 * resolve for users who never hold preview credentials — so /daemon is carved
 * out on the same self-contained terms. ONE source: `src/content/daemon.ts`
 * is the copy module the Next `/daemon` route renders; this script transpiles
 * that same module (TypeScript compiler API — already a devDependency, no new
 * deps) and renders the public HTML from it. Two renderings, one source, so
 * the public copy cannot drift from the gated one.
 *
 * AT LAUNCH FLIP: drop the `auth_basic off` carve-out locations from
 * nginx.conf and the Next-rendered /privacy, /terms, and /daemon take over
 * again. Nothing here needs deleting.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import ts from 'typescript'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(siteRoot, 'public', 'legal')

/** Inline, dependency-free, and dark-mode aware. No font/asset requests. */
const CSS = `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1a1a; --muted:#5b6472; --line:#e4e7ec; --accent:#2f6f5e; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0e1116; --fg:#e6e9ef; --muted:#9aa4b2; --line:#232936; --accent:#69c9ac; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.65; }
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
h1 { font-size: 1.9rem; line-height:1.25; margin: 0 0 .5rem; letter-spacing:-.02em; }
h2 { font-size: 1.25rem; margin: 2.25rem 0 .5rem; letter-spacing:-.01em; }
h3 { font-size: 1.05rem; margin: 1.5rem 0 .4rem; }
p, li { color: var(--fg); }
a { color: var(--accent); }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
code { background: color-mix(in srgb, var(--fg) 8%, transparent); padding:.1rem .3rem; border-radius:3px; font-size:.9em; }
table { border-collapse: collapse; width:100%; display:block; overflow-x:auto; }
th, td { border:1px solid var(--line); padding:.5rem .6rem; text-align:left; font-size:.95rem; }
.masthead { font-weight:600; letter-spacing:.02em; text-decoration:none; color:var(--fg); display:inline-block; margin-bottom:2rem; }
.tagline { color: var(--muted); font-size:1.05rem; margin:0 0 2rem; }
.foot { margin-top:3rem; padding-top:1.25rem; border-top:1px solid var(--line); color:var(--muted); font-size:.9rem; }
`

/**
 * Extra rules used only by the daemon page (kept out of the base CSS so the
 * three previously committed pages regenerate byte-identical). Still inline,
 * still no external references.
 */
const DAEMON_CSS = `
.eyebrow { color:var(--muted); font-size:.78rem; font-weight:600; letter-spacing:.09em; text-transform:uppercase; margin:2.5rem 0 0; }
.eyebrow + h1, .eyebrow + h2 { margin-top:.35rem; }
pre { background: color-mix(in srgb, var(--fg) 7%, transparent); border:1px solid var(--line); border-radius:6px; padding:.65rem .85rem; overflow-x:auto; font-size:.9rem; }
pre code { background:transparent; padding:0; }
`

function page({ title, body, extraCss = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<title>${title}</title>
<style>${CSS}${extraCss}</style>
</head>
<body>
<main>
<a class="masthead" href="/home">PROVIAN</a>
${body}
<div class="foot">
  <a href="/home">Home</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms">Terms of Service</a> &nbsp;·&nbsp; <a href="mailto:hello@provian.ai">hello@provian.ai</a>
</div>
</main>
</body>
</html>
`
}

/**
 * The public homepage. Deliberately plain: it exists so the OAuth reviewer can
 * see what the application is and reach the privacy policy. It describes current
 * wallet, witness, and beneficiary behavior from the shared source.
 */
const HOME_BODY = `
<h1>Provian</h1>
<p class="tagline">The Trust Layer for the Intelligence Economy.</p>

<p>Compute mints money. No one gets left behind. Provian is a non-custodial mobile wallet
built on an open standard for proof you own: when a person, an agent, or a device does useful
work, the work leaves a signed receipt, and the receipt mints money. The wallet seed is encrypted
on the phone and backed up only as ciphertext to the user’s own cloud account, restored with a
backup password. Receipts are signed by a separate key held on the device.</p>

<h2>What the app does</h2>
<ul>
  <li><strong>Non-custodial wallet.</strong> EVM accounts on Base, Arbitrum, and Optimism, plus a Solana account, with an optional
      end-to-end encrypted cloud backup that only the user's backup password can unlock.</li>
  <li><strong>Agent partnerships.</strong> Agents hold their own wallets and keys. A person can link an agent as its
      beneficiary and share in what its work earns, and can end the link at any time.</li>
  <li><strong>Receipts you own.</strong> Signed, hash-chained Provenance Envelopes carry the evidence behind each act:
      what kind of work happened, what witnessed it, and fingerprints of what was produced, never the private content.
      Every act of work mints PVT once, at the value its evidence supports.</li>
</ul>

<h2>Google Drive access</h2>
<p>On Android, Provian requests the <code>drive.appdata</code> scope for one purpose: to store the user's
encrypted wallet backup in the private application-data folder of their own Google Drive. The
backup is encrypted on the device with a backup password before it is uploaded. Provian cannot read it, and
the scope grants no access to any other file in the user's Drive.</p>

<h2>Contact</h2>
<p>Questions, data requests, and security reports: <a href="mailto:hello@provian.ai">hello@provian.ai</a></p>
`

/**
 * Load the /daemon copy module — the SAME `src/content/daemon.ts` the Next
 * route renders. Node 20 cannot import .ts directly, so transpile it with the
 * TypeScript compiler API (a devDependency already) and import the result via
 * a data: URL. The module is dependency-free by contract (data + types only —
 * enforced by its own docblock and by this import failing if anything else is
 * added), so type-stripping is the only transform that happens.
 */
async function loadDaemonContent() {
  const src = readFileSync(join(siteRoot, 'src', 'content', 'daemon.ts'), 'utf8')
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText, 'utf8').toString('base64')}`)
}

/**
 * Render the daemon copy as a plain self-contained document, visually in line
 * with the other public pages (same shell, same CSS). Everything interpolated
 * is HTML-escaped: the copy legitimately contains `<addr>` / `<token>`
 * placeholders that must render as text, never parse as tags.
 */
function renderDaemonBody(d) {
  const esc = (s) =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  const inlineCode = ({ before, code, after }) =>
    `${esc(before)} <code>${esc(code)}</code> ${esc(after)}`

  const witnesses = d.DAEMON_WITNESSES.map(
    (w) => `<h3>${esc(w.title)}</h3>
<p>${esc(w.body)}</p>${w.aside ? `\n<p><small><em>${esc(w.aside)}</em></small></p>` : ''}`
  ).join('\n')

  const steps = d.DAEMON_STEPS.map((s) => {
    const cmd = s.cmd ? `\n<pre><code>${esc(s.cmd)}</code></pre>` : ''
    return `<h3>${esc(s.n)} · ${esc(s.title)}</h3>
<p>${esc(s.body)}</p>${cmd}`
  }).join('\n')

  const custody = d.DAEMON_CUSTODY_POINTS.map((p) => `  <li>${esc(p)}</li>`).join('\n')

  return `
<p class="eyebrow">${esc(d.DAEMON_HERO.eyebrow)}</p>
<h1>${esc(d.DAEMON_HERO.heading)}</h1>
<p class="tagline">${esc(d.DAEMON_HERO.lede)}</p>
<p><em>${esc(d.DAEMON_HERO.aside)}</em></p>

<p class="eyebrow">${esc(d.DAEMON_WITNESSES_SECTION.eyebrow)}</p>
<h2>${esc(d.DAEMON_WITNESSES_SECTION.heading)}</h2>
${witnesses}

<p class="eyebrow">${esc(d.DAEMON_SETUP_SECTION.eyebrow)}</p>
<h2>${esc(d.DAEMON_SETUP_SECTION.heading)}</h2>
<p>${esc(d.DAEMON_SETUP_SECTION.lede)}</p>
${steps}
<p>${inlineCode(d.DAEMON_FORGE_NOTE)}</p>

<p class="eyebrow">${esc(d.DAEMON_CUSTODY_SECTION.eyebrow)}</p>
<h2>${esc(d.DAEMON_CUSTODY_SECTION.heading)}</h2>
<ul>
${custody}
</ul>

<p class="eyebrow">${esc(d.DAEMON_BETA.eyebrow)}</p>
<h2>${esc(d.DAEMON_BETA.heading)}</h2>
<p>${inlineCode(d.DAEMON_BETA.body)}</p>
<p><a href="${d.DAEMON_BETA.mailtoHref}">${esc(d.DAEMON_BETA.mailtoLabel)}</a></p>
`
}

/**
 * Fail the build on ANY external reference. This is the guard that keeps the
 * carve-out from re-opening the `/_next/static/*` hole: a self-contained page
 * cannot pull an auth-gated asset, so it cannot leak one.
 */
function verifySelfContained(name, html, { allowExternalNavigation = false } = {}) {
  const violations = []
  // The manual names off-site pages (the reference gate's repository) and loopback endpoints in its
  // setup instructions. Navigating to them loads nothing into this page, so for that page only the
  // external-URL rule ignores anchor hrefs and code text; every asset rule (script, link, src, url())
  // still applies to the whole page.
  if (allowExternalNavigation) {
    html = html.replace(/<a\s+href="https?:\/\/[^"]*"/gi, '<a').replace(/<code>[\s\S]*?<\/code>/gi, '<code></code>')
  }
  const patterns = [
    [/<script\b/i, '<script> tag'],
    [/<link\b/i, '<link> tag (stylesheet/preload)'],
    [/\/_next\//, '/_next/ reference'],
    [/\ssrc\s*=/i, 'src= attribute (image/iframe/script)'],
    // Block absolute EXTERNAL URLs (auth-gated/off-site assets widen the public
    // surface). First-party provian.ai URLs are allowed: the daemon page shows a
    // copy-paste `curl … https://api.provian.ai/v1/bootstrap/device` command as
    // literal text — it loads no asset (asset loads are caught by src=/<script>/
    // <link> above). The strict boundary `(?![a-z0-9.-])` keeps a look-alike like
    // provian.ai.evil.com out of the allowance.
    [/https?:\/\/(?!schema\.org\b|(?:[a-z0-9-]+\.)?provian\.ai(?![a-z0-9.-]))/i, 'absolute external URL'],
    [/@import\b/i, 'CSS @import'],
    [/url\(\s*(?!['"]?data:)/i, 'CSS url() to a non-data asset'],
  ]
  for (const [re, label] of patterns) if (re.test(html)) violations.push(label)
  if (violations.length > 0) {
    console.error(`REFUSED: ${name} is not self-contained -> ${violations.join(', ')}`)
    console.error('These pages are served WITHOUT auth. An external reference would either break')
    console.error('for the public (asset is auth-gated) or widen the public surface. Inline it.')
    process.exit(1)
  }
}

mkdirSync(OUT_DIR, { recursive: true })

const legalSrc = (name) => readFileSync(join(siteRoot, 'src', 'content', 'legal', name), 'utf8')

const privacyHtml = page({
  title: 'Privacy Policy — Provian',
  body: marked.parse(legalSrc('privacy.md')),
})
const termsHtml = page({
  title: 'Terms of Service — Provian',
  body: marked.parse(legalSrc('terms.md')),
})
const homeHtml = page({ title: 'Provian', body: HOME_BODY })

const daemonContent = await loadDaemonContent()
const daemonHtml = page({
  title: daemonContent.DAEMON_META.title,
  body: renderDaemonBody(daemonContent),
  extraCss: DAEMON_CSS,
})

// Pages the app opens, served before launch without the wall (support, account deletion, the
// manual, the promise fallback and the download pages). The markdown in src/content/public/ is their
// one source; the Next routes for /support and /delete-account render the same files.
const publicSrc = (name) => readFileSync(join(siteRoot, 'src', 'content', 'public', name), 'utf8')
const supportHtml = page({ title: 'Support — Provian', body: marked.parse(publicSrc('support.md')) })
const deleteAccountHtml = page({ title: 'Delete your account — Provian', body: marked.parse(publicSrc('delete-account.md')) })
const promiseHtml = page({ title: 'Open your promise in Provian', body: marked.parse(publicSrc('promise.md')) })
const downloadHtml = page({ title: 'Get Provian', body: marked.parse(publicSrc('download.md')) })
const manualHtml = page({
  title: 'The Provian Manual',
  body: marked.parse(readFileSync(join(siteRoot, 'public', 'docs-md', 'manual.md'), 'utf8')),
  extraCss: DAEMON_CSS,
})

/** The Android download facts, read from the /download/android page (the one place they are stamped). */
function androidApkFacts() {
  const src = readFileSync(join(siteRoot, 'src', 'app', 'download', 'android', 'page.tsx'), 'utf8')
  const pick = (re, label) => {
    const m = re.exec(src)
    if (!m) throw new Error(`download/android page.tsx: cannot read ${label}`)
    return m[1]
  }
  return {
    version: pick(/const VERSION = '([^']+)'/, 'VERSION'),
    versionCode: pick(/const VERSION_CODE = (\d+)/, 'VERSION_CODE'),
    sha256: pick(/const APK_SHA256 = '([0-9a-f]{64})'/, 'APK_SHA256'),
    size: pick(/const APK_SIZE = '([^']+)'/, 'APK_SIZE'),
    signing: pick(/const SIGNING_SHA256 =\s*'([0-9A-F:]+)'/, 'SIGNING_SHA256'),
  }
}
const apk = androidApkFacts()
const apkFile = `provian-wallet-${apk.version}.apk`
const downloadAndroidHtml = page({
  title: 'Download Provian for Android (APK)',
  body: marked.parse(`# Install Provian on Android

Provian for Android installs straight from a signed APK, with no store account needed. Android 7.0 or later. It is also on Google Play.

**[Download the APK](/download/${apkFile})** — ${apkFile} · v${apk.version} · ${apk.size}

## Verify the download

Before you install, confirm the file is exactly what Provian published. On a Mac or Linux computer: \`shasum -a 256 ${apkFile}\`

- SHA-256: \`${apk.sha256}\`
- Version: ${apk.version} (versionCode ${apk.versionCode})
- Package: com.provian.wallet
- Signing certificate (SHA-256): \`${apk.signing}\`

## Install

1. Tap Download the APK and let the download finish. It is a large file, so use Wi-Fi if you can.
2. Open the downloaded file from the notification, or from Files / Downloads.
3. Android says apps from this source aren't allowed yet. Tap Settings and turn on "Allow from this source" for your browser or Files app. You are permitting this one app, not weakening the whole phone.
4. Go back, tap Install, then open Provian and create your wallet.
`),
})

const PAGES = [
  ['privacy.html', privacyHtml, 'from src/content/legal/privacy.md'],
  ['terms.html', termsHtml, 'from src/content/legal/terms.md'],
  ['home.html', homeHtml, ''],
  ['daemon.html', daemonHtml, 'from src/content/daemon.ts'],
  ['support.html', supportHtml, 'from src/content/public/support.md'],
  ['delete-account.html', deleteAccountHtml, 'from src/content/public/delete-account.md'],
  ['promise.html', promiseHtml, 'from src/content/public/promise.md'],
  ['download.html', downloadHtml, 'from src/content/public/download.md'],
  ['download-android.html', downloadAndroidHtml, 'from src/app/download/android/page.tsx'],
  ['manual.html', manualHtml, 'from public/docs-md/manual.md'],
]

for (const [name, html] of PAGES) verifySelfContained(name, html, { allowExternalNavigation: name === 'manual.html' })
for (const [name, html] of PAGES) writeFileSync(join(OUT_DIR, name), html)

for (const [name, html, note] of PAGES) {
  console.log(`public/legal/${name.padEnd(22)} ${String(html.length).padStart(6)} bytes ${note}`)
}
console.log(`all ${PAGES.length} verified self-contained: no script, link, src, /_next/, or external URL`)
