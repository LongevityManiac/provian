// Build-time loader for the plain public pages (support, account deletion). Their one source is
// src/content/public/<slug>.md; scripts/build-public-legal.mjs renders the same files into the
// self-contained pages served before launch, so the two renderings cannot drift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'

export type PublicDocSlug = 'support' | 'delete-account'

export function loadPublicDoc(slug: PublicDocSlug): { title: string; html: string } {
  const raw = readFileSync(join(process.cwd(), 'src', 'content', 'public', `${slug}.md`), 'utf8')
  const lines = raw.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  const title = h1 >= 0 ? lines[h1].slice(2).trim() : 'Provian'
  const body = h1 >= 0 ? [...lines.slice(0, h1), ...lines.slice(h1 + 1)].join('\n') : raw
  return { title, html: marked.parse(body, { async: false }) as string }
}
