#!/usr/bin/env node
/**
 * sync-legal.mjs - vendor the canonical legal docs into the website tree.
 *
 * SINGLE SOURCE OF TRUTH: `docs/legal/*.md` at the repo root. Those files are
 * the canonical Privacy Policy and Terms of Service; the in-app legal screens
 * and this website both derive from them, so they must never drift.
 *
 * The Docker build context is narrowed to provian-website/ (repo-root
 * .dockerignore), so the site cannot read ../docs/legal at image build time.
 * This script copies the canonical markdown, BYTE-IDENTICAL, into the website
 * tree so the /privacy and /terms routes can render it at build time. Re-run it
 * whenever a source doc changes, then commit the result:
 *
 *   node scripts/sync-legal.mjs
 *
 * Output:
 *   src/content/legal/<name>.md  - byte-identical copy of docs/legal/<source>
 *
 * These live under src/content/ (NOT public/) on purpose: they are read at
 * build time by the route components and are not separately web-served.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(siteRoot, '..')

const DOCS = [
  { source: 'docs/legal/privacy-policy.md', dest: 'src/content/legal/privacy.md' },
  { source: 'docs/legal/terms-of-service.md', dest: 'src/content/legal/terms.md' },
]

const outDir = join(siteRoot, 'src/content/legal')
mkdirSync(outDir, { recursive: true })

for (const { source, dest } of DOCS) {
  const raw = readFileSync(join(repoRoot, source), 'utf8')
  const outPath = join(siteRoot, dest)
  writeFileSync(outPath, raw)
  console.log(`  ${source}  ->  ${dest}  (${(raw.length / 1024).toFixed(1)} KB)`)
}

console.log(`Synced ${DOCS.length} legal docs. Commit the result.`)
