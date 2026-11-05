#!/usr/bin/env node
/**
 * Crawl a locally running provian-site image and prove the review-open switch.
 *
 *   node provian-website/scripts/crawl-review-open.mjs --expect on|off \
 *     --base http://127.0.0.1:18081 --container <running container> \
 *     [--baseline http://127.0.0.1:18080] [--auth-file <file holding the local test password>] \
 *     [--chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
 *
 * Build and run the images first (repo root; any local image with a test .htpasswd can stand in
 * for HTPASSWD_SOURCE_IMAGE; the release APK must be at provian-website/public/download/):
 *   docker build -f provian-website/Dockerfile --build-arg HTPASSWD_SOURCE_IMAGE=<local auth image> \
 *     --build-arg REVIEW_OPEN=on  -t provian-site-local:review-on  .
 *   docker build ... --build-arg REVIEW_OPEN=off -t provian-site-local:review-off .
 *   docker run -d --name pvs-on -p 18081:8080 provian-site-local:review-on
 * and, for --baseline, the image built from the commit before the switch existed (or any image
 * whose behaviour is the reference).
 *
 * What it checks:
 *  - The image's resolved set (/etc/nginx/review-open/open-set.json, written by
 *    scripts/review-open.mjs from review-open.json) is in the expected mode and carries every URL
 *    the source list names (the crawl reads the same review-open.json).
 *  - Every URL of the export (each file, and each page directory with and without its slash),
 *    plus extra probes (query-string forms of the open pages, unlisted routes, random paths), is
 *    requested WITHOUT credentials:
 *      ON:  each open URL answers 200 (a redirect answers 301 to an open URL that answers 200);
 *           every other URL answers exactly what the baseline answers (401 for the walled site).
 *      OFF: every URL answers exactly what the baseline answers.
 *    Without --baseline, "what the baseline answers" is 401, except the always-public paths.
 *  - Each self-contained page URL serves the very file the set names (sha256 of the body against
 *    the export's file).
 *  - ON only: each open page is loaded in headless Chrome without credentials and every request
 *    the page makes is recorded. Any same-origin subresource answering an error fails the crawl;
 *    RSC prefetches of walled pages (their index.txt, 401) are reported, not failed: they are the
 *    page's links into the walled site. Requests to other origins are blocked and listed.
 *  - With --auth-file: a sample of walled URLs still answers 200 WITH the credentials.
 * Exit 0 only when every check passes; the evaluated counts are printed, and a population of zero
 * is a failure.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_LIST = join(siteRoot, 'review-open.json')
const NGINX_ROOT = '/usr/share/nginx/html'
const ALWAYS_PUBLIC = ['/privacy', '/privacy/', '/terms', '/terms/', '/home', '/home/', '/daemon', '/daemon/']

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`)
    out[k.slice(2)] = argv[i + 1]
    i++
  }
  return out
}

const opt = args(process.argv.slice(2))
if (!['on', 'off'].includes(opt.expect ?? '') || !opt.base || !opt.container) {
  console.error('usage: crawl-review-open.mjs --expect on|off --base <url> --container <name> [--baseline <url>] [--auth-file <file>] [--chrome <path>]')
  process.exit(2)
}
const BASE = opt.base.replace(/\/+$/, '')
const BASELINE = opt.baseline ? opt.baseline.replace(/\/+$/, '') : null
const CHROME = opt.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const failures = []
const fail = (msg) => failures.push(msg)
const lines = []
const log = (s = '') => { lines.push(s); console.log(s) }

function dockerExec(...cmd) {
  return execFileSync('docker', ['exec', opt.container, ...cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

// ── the set: the image's resolved set, bound to the source list ──────────
const source = JSON.parse(readFileSync(SOURCE_LIST, 'utf8'))
const set = JSON.parse(dockerExec('cat', '/etc/nginx/review-open/open-set.json'))
if (set.mode !== opt.expect) fail(`image switch is ${set.mode}, expected ${opt.expect}`)
const openExact = new Set(set.exact)
const openPrefixes = set.prefixes.map((p) => p.prefix)
for (const e of source.entries) {
  if (e.kind === 'apk') continue
  if (e.kind === 'prefix') { if (!openPrefixes.includes(e.url)) fail(`source ${e.url} (prefix) missing from the resolved set`); continue }
  if (!openExact.has(e.url)) fail(`source ${e.url} (${e.kind}) missing from the resolved set`)
}
const isOpen = (path) => openExact.has(path) || openPrefixes.some((p) => path.startsWith(p))

// ── the universe: every export URL plus probes ───────────────────────────
const exportFiles = dockerExec('find', NGINX_ROOT, '-type', 'f').split('\n').filter(Boolean).map((f) => f.slice(NGINX_ROOT.length))
const universe = new Set()
for (const f of exportFiles) {
  universe.add(f)
  if (f.endsWith('/index.html')) {
    const dir = f.slice(0, -'index.html'.length)
    universe.add(dir)
    if (dir !== '/') universe.add(dir.slice(0, -1))
  }
}
for (const u of set.exact) universe.add(u)
const PROBES = [
  '/p?d=abc', '/p/some-promise-id', '/p/?d=abc', '/download?p=prm_123', '/download/android?x=1',
  '/invited?invite=inv_0123456789&agent_wallet=wallet_aw_0123456789', '/pair?wallet=0xabc&t=1',
  '/approve-recovery?recoveryId=rec_td_1', '/support?from=app', '/earn', '/earn/', '/library/manual',
  '/library', '/library/', '/library/thesis/', '/library/manual/extra', '/start', '/start/', '/preview', '/preview/',
  '/preview/library/', '/preview/library/manual/', '/preview/start/', '/preview/faq/', '/vision/', '/genesis/', '/atlas/',
  '/about/', '/films/', '/films/to-the-stars/', '/a/', '/a/agent_123', '/lines/', '/developers/', '/index.html', '/index.txt',
  '/icon.png', '/logos/', '/logos/provian-512.png', '/films/to-the-stars-loop.mp4', '/docs-md/manual.md', '/docs-md/',
  '/llms.txt', '/llms-full.txt', '/robots.txt', '/apple-app-site-association', '/.well-known/apple-app-site-association',
  '/.well-known/assetlinks.json', '/.well-known/provian-app-version.json', '/.well-known/mcp-registry-auth',
  '/.well-known/security.txt', '/_next/static/chunks/does-not-exist.js', '/_next/static/', '/_next/',
  '/supportx', '/support-me', '/p-other', '/proposalsx', '/agents/index.html', '/invited/index.html',
  `/random-${Math.random().toString(16).slice(2, 10)}`, `/random-${Math.random().toString(16).slice(2, 10)}/deeper`,
  '/%73upport', '/download/../preview/', '/p/../preview/',
]
for (const p of PROBES.concat(ALWAYS_PUBLIC)) universe.add(p)
const urls = [...universe].sort()

/** The path nginx matches: decoded and normalized ($uri), without the query. */
function pathOf(u) {
  return decodeURIComponent(new URL(u, 'http://x').pathname)
}

async function status(base, path, init = {}) {
  const res = await fetch(base + path, { method: 'HEAD', redirect: 'manual', ...init })
  return { status: res.status, location: res.headers.get('location') }
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

function expectedWithoutBaseline(path) {
  if (ALWAYS_PUBLIC.includes(path) || (path.startsWith('/.well-known/') && path !== '/.well-known/mcp-registry-auth')) return 'public'
  return 401
}

log(`review-open crawl — expect ${opt.expect.toUpperCase()} — ${BASE}${BASELINE ? ` (baseline ${BASELINE})` : ''}`)
log(`source list: ${source.entries.length} entries; resolved set: ${set.exact.length} exact URLs + ${set.prefixes.length} prefix (${Object.entries(set.nextPages).map(([p, a]) => `${p} ${a.length} files`).join(', ')})`)
log(`universe: ${exportFiles.length} export files -> ${urls.length} URLs (with page directories and ${PROBES.length} probes)`)
log('')

const rows = await pool(urls, 16, async (u) => {
  const got = await status(BASE, u)
  const ref = BASELINE ? await status(BASELINE, u) : null
  return { u, got, ref }
})

const counts = { open200: 0, open301: 0, walled401: 0, sameAsBaseline: 0, other: 0 }
const openRows = []
const walledSample = []
for (const { u, got, ref } of rows) {
  const path = pathOf(u)
  const open = opt.expect === 'on' && isOpen(path)
  if (open) {
    if (set.redirects[path]) {
      if (got.status !== 301 || got.location !== set.redirects[path]) fail(`${u}: expected 301 -> ${set.redirects[path]}, got ${got.status} ${got.location ?? ''}`)
      else {
        const t = await status(BASE, got.location)
        if (t.status !== 200) fail(`${u}: redirect target ${got.location} answered ${t.status}`)
        counts.open301++
      }
    } else if (got.status !== 200) {
      fail(`${u}: open URL answered ${got.status}`)
    } else counts.open200++
    openRows.push(`  ${String(got.status).padEnd(3)} ${u}${got.location ? ` -> ${got.location}` : ''}`)
    continue
  }
  if (ref) {
    if (got.status !== ref.status || (got.location ?? '') !== (ref.location ?? '')) {
      fail(`${u}: answered ${got.status}${got.location ? ` -> ${got.location}` : ''}, baseline ${ref.status}${ref.location ? ` -> ${ref.location}` : ''}`)
    } else counts.sameAsBaseline++
  } else {
    const exp = expectedWithoutBaseline(path)
    if (exp === 401 && got.status !== 401) fail(`${u}: expected 401, got ${got.status}`)
  }
  if (got.status === 401) { counts.walled401++; if (walledSample.length < 1e9) walledSample.push(u) } else counts.other++
}

if (opt.expect === 'on') {
  log(`OPEN (no credentials): ${counts.open200} x 200, ${counts.open301} x 301 -> 200`)
  for (const r of openRows) log(r)
  log('')
}
log(`NOT OPEN: ${counts.walled401} URLs answered 401; ${counts.other} answered as the always-public / pre-existing set (200, 301, 404)${BASELINE ? `; ${counts.sameAsBaseline} identical to the baseline` : ''}`)
const nonOpenNon401 = rows.filter(({ u, got }) => !(opt.expect === 'on' && isOpen(pathOf(u))) && got.status !== 401)
for (const { u, got, ref } of nonOpenNon401) log(`  ${got.status} ${u}${got.location ? ` -> ${got.location}` : ''}${ref ? `   (baseline ${ref.status})` : ''}`)
const named = ['/library', '/library/', '/start', '/start/', '/preview', '/preview/', '/preview/library/', '/preview/library/manual/', '/preview/start/', '/vision/', '/genesis/', '/atlas/', '/a/agent_123', '/films/', '/films/to-the-stars-loop.mp4', '/logos/provian-512.png', '/docs-md/manual.md', '/llms.txt', '/.well-known/mcp-registry-auth', '/index.txt', PROBES.find((p) => p.startsWith('/random-'))]
log('  named walled routes: ' + named.map((n) => `${n}=${rows.find((r) => r.u === n)?.got.status}`).join(' '))
const chunkRows = rows.filter(({ u }) => u.startsWith('/_next/static/'))
const chunkOpen = chunkRows.filter(({ got }) => got.status === 200).length
log(`  /_next/static: ${chunkRows.length} files, ${chunkOpen} answer 200 without credentials, ${chunkRows.length - chunkOpen} answer 401`)
log('')

// ── the challenge: a walled URL challenges; an RSC request does not (ON) ──
{
  const probe = async (base, path, headers = {}) => {
    const r = await fetch(base + path, { method: 'HEAD', redirect: 'manual', headers })
    return `${r.status}${r.headers.get('www-authenticate') ? ' +challenge' : ' no-challenge'}`
  }
  const walledTxt = '/about/index.txt'
  const plain = await probe(BASE, walledTxt)
  const rsc = await probe(BASE, walledTxt, { RSC: '1' })
  const openRsc = opt.expect === 'on' ? await probe(BASE, '/proposals/index.txt', { RSC: '1' }) : null
  const wantRsc = opt.expect === 'on' ? '401 no-challenge' : '401 +challenge'
  if (plain !== '401 +challenge') fail(`${walledTxt}: expected 401 +challenge, got ${plain}`)
  if (rsc !== wantRsc) fail(`${walledTxt} with RSC: 1: expected ${wantRsc}, got ${rsc}`)
  if (openRsc && !openRsc.startsWith('200')) fail(`/proposals/index.txt with RSC: 1: expected 200, got ${openRsc}`)
  if (BASELINE) {
    const refRsc = await probe(BASELINE, walledTxt, { RSC: '1' })
    log(`CHALLENGE: ${walledTxt} -> ${plain}; with RSC: 1 -> ${rsc} (baseline ${refRsc})${openRsc ? `; open /proposals/index.txt with RSC: 1 -> ${openRsc}` : ''}`)
  } else log(`CHALLENGE: ${walledTxt} -> ${plain}; with RSC: 1 -> ${rsc}`)
  log('')
}

// ── each self-contained page URL serves the file the set names ───────────
if (opt.expect === 'on') {
  const fileSha = {}
  for (const f of new Set(Object.values(set.files).concat(set.prefixes.map((p) => p.file)))) {
    fileSha[f] = dockerExec('sha256sum', NGINX_ROOT + f).split(/\s+/)[0]
  }
  const pageChecks = Object.entries(set.files).concat(set.prefixes.map((p) => [`${p.prefix}any-id`, p.file]))
  let ok = 0
  for (const [u, f] of pageChecks) {
    const res = await fetch(BASE + u, { redirect: 'manual' })
    const body = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(body).digest('hex')
    if (res.status !== 200 || sha !== fileSha[f]) fail(`${u}: expected ${f} (sha256 ${fileSha[f]}), got ${res.status} sha256 ${sha}`)
    else ok++
  }
  log(`SERVED FILE: ${ok}/${pageChecks.length} page URLs serve byte-for-byte the self-contained render the set names`)
  log('')
}

// ── headless Chrome: what an unauthenticated page load requests ──────────
async function chromeLoads(pages) {
  if (!existsSync(CHROME)) { fail(`Chrome not found at ${CHROME}; pass --chrome`); return }
  const WS = globalThis.WebSocket ?? (await import('ws')).default
  const profile = mkdtempSync(join(tmpdir(), 'review-open-crawl-'))
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
  try {
    let port
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {}
    }
    if (!port) { fail('Chrome did not start'); return }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const ws = new WS(version.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0
    const pending = new Map()
    const listeners = []
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } else for (const l of listeners) l(msg)
    }
    const send = (method, params = {}, sessionId) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params, sessionId })) })

    let pageOk = 0
    for (const page of pages) {
      const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
      const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
      const reqs = new Map()
      const blocked = new Set()
      const prompts = []
      let loaded = false
      const onMsg = async (m) => {
        if (m.sessionId !== sessionId) return
        if (m.method === 'Fetch.authRequired') {
          // A real browser would show a password prompt here.
          prompts.push(new URL(m.params.request.url).pathname)
          await send('Fetch.continueWithAuth', { requestId: m.params.requestId, authChallengeResponse: { response: 'CancelAuth' } }, sessionId)
        } else if (m.method === 'Fetch.requestPaused') {
          const url = m.params.request.url
          if (url.startsWith(BASE + '/') || url === BASE) await send('Fetch.continueRequest', { requestId: m.params.requestId }, sessionId)
          else { blocked.add(new URL(url).origin); await send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId) }
        } else if (m.method === 'Network.requestWillBeSent') {
          reqs.set(m.params.requestId, { url: m.params.request.url, type: m.params.type, status: null, purpose: m.params.request.headers?.['Next-Router-Prefetch'] ? 'prefetch' : '' })
        } else if (m.method === 'Network.responseReceived') {
          const r = reqs.get(m.params.requestId); if (r) { r.status = m.params.response.status; r.type = m.params.type }
        } else if (m.method === 'Network.loadingFailed') {
          const r = reqs.get(m.params.requestId); if (r && r.status === null) r.status = `failed:${m.params.errorText}`
        } else if (m.method === 'Page.loadEventFired') loaded = true
      }
      listeners.push(onMsg)
      await send('Network.enable', {}, sessionId)
      await send('Page.enable', {}, sessionId)
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true }, sessionId)
      await send('Page.navigate', { url: BASE + page }, sessionId)
      for (let i = 0; i < 150 && !loaded; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 2500)) // let hydration, prefetches and lazy media settle
      const evalRes = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : 0', returnByValue: true }, sessionId)
      const textLen = evalRes.result?.result?.value ?? 0
      listeners.splice(listeners.indexOf(onMsg), 1)
      await send('Target.closeTarget', { targetId })

      const sameOrigin = [...reqs.values()].filter((r) => r.url.startsWith(BASE))
      const doc = sameOrigin.find((r) => r.type === 'Document')
      const bad = []
      const walledLinks = []
      for (const r of sameOrigin) {
        if (r.type === 'Document') continue
        const ok = typeof r.status === 'number' && r.status < 400
        if (ok) continue
        const p = new URL(r.url).pathname
        if (r.status === 401 && p.endsWith('.txt') && !isOpen(p)) { walledLinks.push(p); continue }
        bad.push(`${r.status} ${r.type} ${p}`)
      }
      const docOk = doc && (doc.status === 200)
      if (!loaded || !docOk || bad.length || prompts.length || textLen < 100) {
        fail(`browser ${page}: load=${loaded} document=${doc?.status} text=${textLen} bad=[${bad.join(', ')}] password prompts=[${prompts.join(', ')}]`)
      } else pageOk++
      log(`  ${page}  document ${doc?.status}; ${sameOrigin.length - 1} same-origin subresources, ${bad.length} errors, ${prompts.length} password prompts; ${textLen} chars rendered${walledLinks.length ? `; ${walledLinks.length} RSC prefetches of walled pages answered 401` : ''}${blocked.size ? `; blocked other origins: ${[...blocked].join(' ')}` : ''}`)
      for (const b of bad) log(`      ERROR ${b}`)
      for (const p of prompts) log(`      PASSWORD PROMPT for ${p}`)
    }
    log(`BROWSER: ${pageOk}/${pages.length} open pages load with every same-origin subresource answering < 400 and no password prompt`)
    ws.close()
  } finally {
    const exited = new Promise((r) => proc.once('exit', r))
    proc.kill('SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a leftover temp profile is harmless */ }
  }
}

if (opt.expect === 'on') {
  const pages = [
    ...Object.entries(set.files).filter(([u, f]) => f.startsWith('/legal/') && (!u.endsWith('/') || u === '/')).map(([u]) => u),
    ...Object.keys(set.redirects).filter((u) => !u.endsWith('/')),
    ...Object.keys(set.nextPages),
    '/p/some-promise-id', '/invited/?invite=inv_0123456789&agent_wallet=wallet_aw_0123456789', '/download?p=prm_123',
  ]
  log(`BROWSER (headless Chrome, no credentials, other origins blocked): ${pages.length} pages`)
  await chromeLoads(pages)
  log('')
}

// ── the wall still opens with the credentials ────────────────────────────
if (opt['auth-file']) {
  const pw = readFileSync(opt['auth-file'], 'utf8').trim()
  const auth = { Authorization: 'Basic ' + Buffer.from(`provian:${pw}`).toString('base64') }
  const sample = ['/preview/', '/preview/library/', '/agents/', '/index.txt', '/.well-known/mcp-registry-auth', '/llms.txt', chunkRows.find(({ u, got }) => u.endsWith('.js') && got.status === 401)?.u].filter(Boolean)
  const res = await pool(sample, 4, async (u) => ({ u, s: (await status(BASE, u, { headers: auth })).status }))
  for (const r of res) if (r.s !== 200) fail(`${r.u}: answered ${r.s} WITH credentials`)
  log(`WITH CREDENTIALS: ${res.map((r) => `${r.u}=${r.s}`).join(' ')}`)
  log('')
}

if (rows.length === 0) fail('evaluated zero URLs')
if (failures.length) {
  log(`RESULT: FAIL — ${failures.length} problem(s) over ${rows.length} URLs`)
  for (const f of failures) log(`  - ${f}`)
  process.exit(1)
}
log(`RESULT: PASS — ${rows.length} URLs evaluated, switch ${opt.expect.toUpperCase()}`)
