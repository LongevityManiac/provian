#!/usr/bin/env node
// Serve the static export (out/) the way nginx.conf does, without the auth
// wall, for local verification of the exact production bundle.
//
//   node scripts/serve-out.mjs [--port 4173] [--clock 2027-01-02T00:00:00Z]
//
// --clock shifts the browser's clock: every HTML response gets a script, ahead
// of the page's own, that makes Date.now() and `new Date()` start from that
// instant. That is how the Genesis CLOSED state is verified against the same
// build that serves the open state (the gates read the visitor's clock).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const port = Number(arg('port', process.env.PORT || '4173'))
const clock = arg('clock', null)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
}

// The redirects and single-page fallbacks nginx.conf carries.
const REDIRECTS = {
  '/preview/overview': '/preview/vision/',
  '/preview/foundation': '/preview/ubp/',
  '/preview/agents': '/agents/',
  '/overview': '/vision/',
  '/foundation': '/ubp/',
}
const FALLBACKS = [
  [/^\/a(\/.*)?$/, '/a/index.html'],
  [/^\/p(\/.*)?$/, '/p/index.html'],
]

const clockScript = clock
  ? `<script>(function(){var o=${Date.parse(clock)}-Date.now(),D=Date;function N(){if(arguments.length===0)return new D(D.now()+o);return new (Function.prototype.bind.apply(D,[null].concat([].slice.call(arguments))))}N.prototype=D.prototype;N.now=function(){return D.now()+o};N.parse=D.parse;N.UTC=D.UTC;window.Date=N})()</script>`
  : ''

async function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  if (clean.includes('..')) return null
  for (const [re, file] of FALLBACKS) if (re.test(clean)) return path.join(root, file)
  const candidates = [path.join(root, clean), path.join(root, clean, 'index.html')]
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return file
    } catch {
      // try the next candidate
    }
  }
  return null
}

createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0]
  const bare = urlPath.replace(/\/$/, '')
  if (REDIRECTS[bare]) {
    res.writeHead(301, { Location: REDIRECTS[bare] })
    res.end()
    return
  }
  const file = await resolve(req.url || '/')
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('404')
    return
  }
  const ext = path.extname(file)
  let body = await readFile(file)
  if (ext === '.html' && clockScript) {
    body = Buffer.from(body.toString('utf8').replace('<head>', `<head>${clockScript}`))
  }
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }
  const range = req.headers.range
  if (range && ext === '.mp4') {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-')
    const start = Number(startRaw)
    const end = endRaw ? Number(endRaw) : body.length - 1
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    })
    res.end(body.subarray(start, end + 1))
    return
  }
  res.writeHead(200, headers)
  res.end(body)
}).listen(port, () => {
  console.log(`serving out/ on http://localhost:${port}${clock ? ` (clock ${clock})` : ''}`)
})
