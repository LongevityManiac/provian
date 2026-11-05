#!/usr/bin/env node
/**
 * prune-unpublished-docs.mjs - after `next build`, strip every raw-markdown
 * mirror that is not in the published Library from the exported site.
 *
 * public/docs-md/ keeps a few mirror files that the frozen Gate 1 approval
 * manifest pins by path (they must stay in the repo, bytes unchanged). Next's
 * static export copies all of public/ into out/, so without this step those
 * unpublished mirrors would be served at /docs-md/<name>.md. The allowlist is
 * src/data/docsManifest.json — the same list the Library and llms.txt render
 * from (scripts/sync-docs.mjs) — so out/docs-md/ holds exactly the published
 * documents and nothing else. Fails the build if a published document is
 * missing from the export.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDocs = join(siteRoot, 'out', 'docs-md')
const manifest = JSON.parse(readFileSync(join(siteRoot, 'src', 'data', 'docsManifest.json'), 'utf8'))
const published = new Set(manifest.docs.map((doc) => `${doc.slug}.md`))

if (!existsSync(outDocs)) {
  console.error('prune-unpublished-docs: out/docs-md/ does not exist; run `next build` first')
  process.exit(1)
}

const removed = []
for (const name of readdirSync(outDocs)) {
  if (published.has(name)) continue
  unlinkSync(join(outDocs, name))
  removed.push(name)
}

const missing = [...published].filter((name) => !existsSync(join(outDocs, name)))
if (missing.length > 0) {
  console.error(`prune-unpublished-docs: published document(s) missing from out/docs-md/: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(
  `prune-unpublished-docs: out/docs-md/ holds ${published.size} published document(s); removed ${removed.length} unpublished mirror(s)${removed.length ? `: ${removed.join(', ')}` : ''}`,
)
