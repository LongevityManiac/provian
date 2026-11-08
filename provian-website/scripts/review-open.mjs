#!/usr/bin/env node
/**
 * The store-review open set, resolved against a built export and written as nginx maps.
 *
 *   node scripts/review-open.mjs <export dir> <output dir> <on|off>
 *
 * Reads `review-open.json` (the single source list) and resolves it against the static export:
 * every `page`/`prefix` file must exist, every `redirect` must land on a URL in the set, the
 * Each `next` page is opened together
 * with exactly the files an unauthenticated load of it requests: the scripts, stylesheets, fonts
 * and images its own HTML names (including the chunks named in its inline RSC payload), the fonts
 * and images its stylesheets name, the media paths written into its own script chunks, and its
 * `index.txt` RSC payload (client-side navigation between open pages). Anything that would open
 * another HTML page, or a file the export does not hold, fails the build.
 *
 * Writes to <output dir> (the Dockerfile copies it to /etc/nginx/review-open/):
 *   auth.map       $uri -> "off" for every open URL, read by the auth-realm map in nginx.conf
 *   files.map      $uri -> the self-contained file a `page`/`prefix` URL serves
 *   redirect.map   $uri -> the 301 target of a `redirect` URL
 *   mode.map       the switch itself (default 0 or 1), read by nginx.conf's RSC rule
 *   open-set.json  the resolved set, for scripts/crawl-review-open.mjs
 * With `off` the three URL maps hold only a comment (and mode.map says 0), so nginx serves exactly what it serves without
 * the switch; the set is still resolved, so a broken list fails the build in either mode.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_LIST = join(siteRoot, 'review-open.json')

const SITE_ORIGIN = 'https://provian.ai'
const KINDS = new Set(['page', 'prefix', 'redirect', 'next', 'file', 'alias'])
/** File types a page load fetches as a subresource. Anything else is a link, not an asset. */
const ASSET_EXT = /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|vtt)$/i
/** Media paths written into a script chunk as string literals (films, posters, images). */
const JS_MEDIA_LITERAL = /["'`](\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|woff2?))["'`]/g
/** Chunk and media paths in the inline RSC payload are written without the /_next/ prefix. */
const RSC_STATIC_REF = /(?:\/_next\/)?(static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./[\]()@%]+?\.(?:js|css|woff2?|png|jpe?g|svg|webp))/g

function fail(message) {
  throw new Error(`review-open: ${message}`)
}

function decodeEntities(s) {
  return s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&#39;', "'")
}

/** A same-origin path for `ref` (relative to `basePath`), or null for another origin or a non-URL. */
function sameOriginPath(ref, basePath) {
  const raw = decodeEntities(ref.trim())
  if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) return null
  let url
  try {
    url = new URL(raw, SITE_ORIGIN + basePath)
  } catch {
    return null
  }
  if (url.origin !== SITE_ORIGIN) return null
  return posix.normalize(decodeURIComponent(url.pathname))
}

function exportHas(exportDir, path) {
  const abs = join(exportDir, path)
  return existsSync(abs) && statSync(abs).isFile()
}

function readExport(exportDir, path) {
  return readFileSync(join(exportDir, path), 'utf8')
}

/** Every same-origin asset an HTML document loads. */
function htmlAssets(html, basePath) {
  const found = new Set()
  const add = (ref) => {
    const p = sameOriginPath(ref, basePath)
    if (p && ASSET_EXT.test(p)) found.add(p)
  }
  for (const m of html.matchAll(/<(script|link|img|video|source|audio|track|meta|image)\b[^>]*>/gi)) {
    const tag = m[0]
    const name = m[1].toLowerCase()
    for (const a of tag.matchAll(/\s(src|href|poster|content|srcset|srcSet|imageSrcSet|imagesrcset|xlink:href)=("([^"]*)"|'([^']*)')/g)) {
      const attr = a[1].toLowerCase()
      const value = a[3] ?? a[4] ?? ''
      if (name === 'meta' && attr !== 'content') continue
      if (attr.includes('srcset')) {
        for (const part of value.split(',')) add(part.trim().split(/\s+/)[0] ?? '')
      } else {
        add(value)
      }
    }
  }
  for (const m of html.matchAll(RSC_STATIC_REF)) found.add(`/_next/${m[1]}`)
  return found
}

function cssAssets(css, cssPath) {
  const found = new Set()
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g)) {
    const p = sameOriginPath(m[1] ?? m[2] ?? m[3] ?? '', cssPath)
    if (p && ASSET_EXT.test(p)) found.add(p)
  }
  return found
}

/** The page's own subresources, closed over its stylesheets and its own script chunks. */
function nextPageClosure(exportDir, pageUrl) {
  const htmlPath = `${pageUrl}index.html`
  if (!exportHas(exportDir, htmlPath)) fail(`next page ${pageUrl}: the export has no ${htmlPath}`)
  const html = readExport(exportDir, htmlPath)
  const assets = htmlAssets(html, pageUrl)
  for (const p of [...assets]) {
    if (p.endsWith('.css') && exportHas(exportDir, p)) for (const q of cssAssets(readExport(exportDir, p), p)) assets.add(q)
  }
  for (const p of [...assets]) {
    if (!p.endsWith('.js') || !exportHas(exportDir, p)) continue
    for (const m of readExport(exportDir, p).matchAll(JS_MEDIA_LITERAL)) {
      // A literal is a candidate, not a requirement: open it only when the export holds it.
      if (exportHas(exportDir, m[1])) assets.add(m[1])
    }
  }
  for (const p of assets) {
    if (!exportHas(exportDir, p)) fail(`next page ${pageUrl} loads ${p}, which the export does not hold`)
    if (/\.html?$/i.test(p) || p.endsWith('.txt')) fail(`next page ${pageUrl}: refusing to open document ${p} as an asset`)
  }
  const rsc = `${pageUrl}index.txt`
  if (exportHas(exportDir, rsc)) assets.add(rsc)
  return [...assets].sort()
}

/** Exact URL, with the trailing-slash twin for an extensionless path. */
function bothForms(url) {
  if (url === '/') return ['/']
  const bare = url.replace(/\/+$/, '')
  return posix.extname(bare) ? [bare] : [bare, `${bare}/`]
}

function assertUrl(entry, field) {
  const v = entry[field]
  if (typeof v !== 'string' || !/^\/[A-Za-z0-9_\-./]*$/.test(v) || v.includes('..') || v.includes('//')) {
    fail(`${entry.kind} entry: ${field} ${JSON.stringify(v)} is not a plain absolute path`)
  }
  return v
}

/** Resolve the source list against an export. Throws on anything that does not resolve. */
export function resolveOpenSet(exportDir, list = JSON.parse(readFileSync(SOURCE_LIST, 'utf8'))) {
  const entries = list.entries
  if (!Array.isArray(entries) || entries.length === 0) fail('review-open.json has no entries')
  const exact = new Map() // uri -> source
  const files = new Map() // uri -> served file
  const prefixes = [] // { prefix, file }
  const redirects = new Map() // uri -> target
  const nextPages = {} // page url -> asset list
  const addExact = (uri, source) => { if (!exact.has(uri)) exact.set(uri, source) }

  for (const entry of entries) {
    if (!KINDS.has(entry.kind)) fail(`unknown kind ${JSON.stringify(entry.kind)}`)
    if (typeof entry.source !== 'string' || entry.source.length === 0) fail(`${entry.kind} ${entry.url ?? ''}: every entry names its source`)
    switch (entry.kind) {
      case 'page': {
        const url = assertUrl(entry, 'url')
        const file = assertUrl(entry, 'file')
        if (!file.startsWith('/legal/') || !exportHas(exportDir, file)) fail(`page ${url}: ${file} is not a self-contained render in the export`)
        for (const u of bothForms(url)) { addExact(u, entry.source); files.set(u, file) }
        break
      }
      case 'prefix': {
        const url = assertUrl(entry, 'url')
        const file = assertUrl(entry, 'file')
        if (!url.endsWith('/')) fail(`prefix ${url} must end with /`)
        if (!file.startsWith('/legal/') || !exportHas(exportDir, file)) fail(`prefix ${url}: ${file} is not a self-contained render in the export`)
        prefixes.push({ prefix: url, file, source: entry.source })
        break
      }
      case 'redirect': {
        const url = assertUrl(entry, 'url')
        const to = assertUrl(entry, 'to')
        for (const u of bothForms(url)) { addExact(u, entry.source); redirects.set(u, to) }
        break
      }
      case 'next': {
        const url = assertUrl(entry, 'url')
        if (!url.endsWith('/')) fail(`next page ${url} must be written with its trailing slash`)
        const assets = nextPageClosure(exportDir, url)
        nextPages[url] = assets
        for (const u of bothForms(url)) addExact(u, entry.source)
        for (const a of assets) addExact(a, `loaded by ${url}`)
        break
      }
      case 'file': {
        const url = assertUrl(entry, 'url')
        if (!exportHas(exportDir, url)) fail(`file ${url} is not in the export`)
        addExact(url, entry.source)
        break
      }
      case 'alias': {
        const url = assertUrl(entry, 'url')
        const file = assertUrl(entry, 'file')
        if (!ASSET_EXT.test(file) || !exportHas(exportDir, file)) fail(`alias ${url}: ${file} is not an asset in the export`)
        addExact(url, entry.source)
        files.set(url, file)
        break
      }
    }
  }
  for (const [from, to] of redirects) {
    if (!exact.has(to) || redirects.has(to)) fail(`redirect ${from} -> ${to}: the target is not an open page`)
  }
  return {
    exact: [...exact.keys()].sort(),
    sources: Object.fromEntries([...exact.entries()].sort()),
    files: Object.fromEntries([...files.entries()].sort()),
    prefixes,
    redirects: Object.fromEntries([...redirects.entries()].sort()),
    nextPages,
  }
}

function q(s) {
  if (/["\\\s;{}]/.test(s)) fail(`cannot write ${JSON.stringify(s)} into an nginx map`)
  return `"${s}"`
}

function regexFor(prefix) {
  return `~^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
}

export function nginxMaps(set, enabled) {
  const head = (what) => `# Generated by scripts/review-open.mjs from review-open.json. ${what}\n`
  if (!enabled) {
    const off = head('Review-open switch OFF: no entries.')
    return { auth: off, files: off, redirect: off, mode: `${head('Review-open switch OFF.')}default 0;\n` }
  }
  let auth = head('Review-open switch ON: these URLs skip the preview password.')
  for (const u of set.exact) auth += `${q(u)} off;\n`
  for (const p of set.prefixes) auth += `${regexFor(p.prefix)} off;\n`
  let files = head('Review-open switch ON: the self-contained file each page URL serves.')
  for (const [u, f] of Object.entries(set.files)) files += `${q(u)} ${q(f)};\n`
  for (const p of set.prefixes) files += `${regexFor(p.prefix)} ${q(p.file)};\n`
  let redirect = head('Review-open switch ON: 301 targets.')
  for (const [u, t] of Object.entries(set.redirects)) redirect += `${q(u)} ${q(t)};\n`
  return { auth, files, redirect, mode: `${head('Review-open switch ON.')}default 1;\n` }
}

/**
 * The OFF guarantee, checked on the maps actually written: with the switch off every URL map holds
 * only comments and the mode map says `default 0;`, so nginx opens nothing it did not open before.
 * Throws naming the first entry that would open a URL.
 */
export function assertOffMapsOpenNothing(maps) {
  for (const [name, text] of Object.entries(maps)) {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '' || t.startsWith('#')) continue
      if (name === 'mode' && t === 'default 0;') continue
      throw new Error(`review-open: switch OFF but ${name}.map holds an entry: ${JSON.stringify(t)}`)
    }
  }
  if (!/^default 0;$/m.test(maps.mode ?? '')) throw new Error('review-open: switch OFF but mode.map does not say default 0;')
}

/** Permanent controls for the OFF guarantee: a non-empty set written OFF opens nothing (GREEN), and the same set written ON is refused by the OFF check (RED). */
function selfTest() {
  const set = {
    exact: ['/support'],
    prefixes: [{ prefix: '/p/', file: 'p.html' }],
    files: { '/support': 'support.html' },
    redirects: { '/earn': '/library/manual' },
    nextPages: {},
  }
  assertOffMapsOpenNothing(nginxMaps(set, false))
  let refused = false
  try { assertOffMapsOpenNothing(nginxMaps(set, true)) } catch { refused = true }
  if (!refused) throw new Error('review-open self-test: the OFF check accepted ON maps (it cannot fail)')
  const on = nginxMaps(set, true)
  if (!on.auth.includes('"/support" off;') || !on.mode.includes('default 1;')) {
    throw new Error('review-open self-test: ON maps do not open the listed URL')
  }
  console.log('review-open self-test: ok — OFF maps open nothing for a non-empty set; ON maps refused by the OFF check')
}

function main(argv) {
  if (argv[0] === '--self-test') return selfTest()
  const [exportDir, outDir, mode] = argv
  if (!exportDir || !outDir || !['on', 'off'].includes(mode ?? '')) {
    console.error('usage: node scripts/review-open.mjs <export dir> <output dir> <on|off>')
    console.error(`review-open: the switch must be exactly "on" or "off" (got ${JSON.stringify(mode)})`)
    process.exit(1)
  }
  const set = resolveOpenSet(exportDir)
  const enabled = mode === 'on'
  const maps = nginxMaps(set, enabled)
  if (!enabled) assertOffMapsOpenNothing(maps)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'auth.map'), maps.auth)
  writeFileSync(join(outDir, 'files.map'), maps.files)
  writeFileSync(join(outDir, 'redirect.map'), maps.redirect)
  writeFileSync(join(outDir, 'mode.map'), maps.mode)
  writeFileSync(join(outDir, 'open-set.json'), `${JSON.stringify({ mode, ...set }, null, 2)}\n`)
  const nextCount = Object.values(set.nextPages).reduce((n, a) => n + a.length, 0)
  console.log(`review-open: switch ${mode.toUpperCase()}; ${set.exact.length} exact URLs + ${set.prefixes.length} prefix resolved (${nextCount} files loaded by ${Object.keys(set.nextPages).length} Next pages)${enabled ? '' : '; nothing opened'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
