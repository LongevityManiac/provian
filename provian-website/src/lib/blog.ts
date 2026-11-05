// Build-time loader for blog posts. Mirrors src/lib/legal.ts exactly: the
// markdown lives beside its registry entry at src/content/blog/<slug>.md and
// is rendered once at export time with `marked`. There is no client-side
// markdown and no runtime filesystem access — Next's static export runs this
// during `next build` only.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'
import { BASE } from '@/lib/routes'
import { findPost, type BlogPostMeta } from '@/content/blog'

export interface RenderedPost extends BlogPostMeta {
  /** Rendered HTML for the body. The title is NOT in the body — the page hero shows it. */
  html: string
}

export function loadPost(slug: string): RenderedPost {
  const meta = findPost(slug)
  if (!meta) throw new Error(`blog: unknown post slug "${slug}" — add it to src/content/blog/index.ts`)
  const raw = readFileSync(join(process.cwd(), 'src', 'content', 'blog', `${meta.slug}.md`), 'utf8')
  // Internal links to staged routes are written as `{{BASE}}/…` in the
  // markdown and resolved here against the ONE route prefix in routes.ts, so
  // the launch flip (BASE='') moves them with every other link on the site.
  const html = marked.parse(raw.replaceAll('{{BASE}}', BASE), { async: false }) as string
  return { ...meta, html }
}
