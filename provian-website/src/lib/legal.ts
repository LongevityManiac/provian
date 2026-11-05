// Build-time loader for the canonical legal documents.
//
// The markdown lives at src/content/legal/<slug>.md — a byte-identical copy of
// the repo-root docs/legal/*.md (the SINGLE SOURCE OF TRUTH), vendored by
// scripts/sync-legal.mjs because the Docker build context cannot reach ../docs.
// Rendering the site straight from that markdown is what keeps the website,
// the in-app legal screens, and the canonical source from drifting apart.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'

export type LegalSlug = 'privacy' | 'terms'

export interface LegalDoc {
  /** First H1 in the source (e.g. "Provian Privacy Policy"). */
  title: string
  /** The "Last Updated: …" date, if the doc carries one. */
  lastUpdated: string | null
  /** Rendered HTML for the body (the title/last-updated header is stripped
   *  because those are surfaced in the page hero instead). */
  html: string
}

export function loadLegalDoc(slug: LegalSlug): LegalDoc {
  const raw = readFileSync(
    join(process.cwd(), 'src', 'content', 'legal', `${slug}.md`),
    'utf8',
  )

  // Both docs open with:  # <Title> \n **Last Updated: …** \n --- \n <body>.
  // Pull the title + date out of that header and render only the body, so the
  // hero and the prose don't both show the H1.
  const lines = raw.split('\n')
  let title = 'Legal'
  let lastUpdated: string | null = null
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (title === 'Legal' && t.startsWith('# ')) title = t.slice(2).trim()
    if (!lastUpdated) {
      const lu = t.match(/Last Updated:\s*([^*]+)/i)
      if (lu) lastUpdated = lu[1].replace(/\*/g, '').trim()
    }
    if (t === '---') {
      bodyStart = i + 1
      break
    }
  }

  const body = lines.slice(bodyStart).join('\n')
  const html = marked.parse(body, { async: false }) as string
  return { title, lastUpdated, html }
}
