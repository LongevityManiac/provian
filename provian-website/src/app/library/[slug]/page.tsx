/**
 * /library/[slug] - renders one vendored long-form document.
 *
 * Source markdown lives in public/docs-md/<slug>.md (vendored by
 * scripts/sync-docs.mjs and committed). It is read from disk at build time
 * (static export), converted with marked, and styled with the site's
 * prose-provian classes. The raw markdown stays fetchable at
 * /docs-md/<slug>.md for agents that prefer the source.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, FileDown } from 'lucide-react'
import { Marked, type Tokens } from 'marked'
import { route } from '@/lib/routes'
import manifest from '@/data/docsManifest.json'

interface DocEntry {
  slug: string
  title: string
  group: string
  badge?: string
  description: string
  sourcePath: string
  sizeKB: number
}

// The published Library: the documents scripts/sync-docs.mjs
// writes to docsManifest.json. Nothing else gets a library route.
const docs = manifest.docs as DocEntry[]

// sync-docs.mjs rewrites every cross-doc link in the docs-md mirror to its
// absolute raw-markdown URL (https://provian.ai/docs-md/<slug>.md), so the
// link resolves for agents reading the raw file or llms-full.txt. A reader on
// the library page should stay in the library, so point those URLs at the
// doc's library route instead, keeping any #fragment.
const LIBRARY_SLUGS = new Set(docs.map((d) => d.slug))
const DOCS_MD_URL = /^https:\/\/provian\.ai\/docs-md\/([a-z0-9-]+)\.md(#.*)?$/

function resolveLibraryHref(href: string): string {
  const m = DOCS_MD_URL.exec(href)
  return m && LIBRARY_SLUGS.has(m[1]) ? `${route.library}/${m[1]}/${m[2] ?? ''}` : href
}

// The documents link to their own sections the way GitHub renders them
// (`[4. Provenance Envelopes](#4-provenance-envelopes)`), so every heading gets
// the id GitHub would give it: the heading's text, lowercased, punctuation
// dropped, each space a hyphen, and `-1`, `-2`… on a repeat.
function headingText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-')
}

// One Marked per document, so the repeat counter starts fresh on each page.
function libraryMarked(): Marked {
  const seen = new Map<string, number>()
  return new Marked({
    walkTokens(token) {
      if (token.type === 'link') {
        const link = token as Tokens.Link
        link.href = resolveLibraryHref(link.href)
      }
    },
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens)
        const base = headingSlug(headingText(inner))
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n === 0 ? base : `${base}-${n}`
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`
      },
    },
  })
}

// Emits one static page per published document and nothing else.
export function generateStaticParams() {
  return docs.map((d) => ({ slug: d.slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = docs.find((d) => d.slug === params.slug)
  return {
    title: doc ? `${doc.title} | Provian Library` : 'Provian Library',
    description: doc?.description,
  }
}

export default function LibraryDocPage({ params }: { params: { slug: string } }) {
  const doc = docs.find((d) => d.slug === params.slug)
  if (!doc) {
    return (
      <div className="bg-void text-text-primary">
        <section className="mx-auto max-w-4xl px-6 py-24 md:px-10">
          <p className="text-text-secondary">Unknown document.</p>
          <Link
            href={route.library}
            className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright hover:underline"
          >
            <ArrowLeft size={15} />
            All documents
          </Link>
        </section>
      </div>
    )
  }

  const raw = readFileSync(join(process.cwd(), 'public', 'docs-md', `${doc.slug}.md`), 'utf8')
  const html = libraryMarked().parse(raw, { async: false }) as string

  return (
    <div className="bg-void text-text-primary">
      <section className="relative overflow-hidden border-b border-white/10 px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-glow-blue-radial" />
        <div className="relative z-10 mx-auto max-w-4xl">
          <Link
            href={route.library}
            className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Library
          </Link>
          <h1 className="mt-6 font-display text-4xl font-semibold leading-[1.02] tracking-[-0.03em] md:text-5xl">
            {doc.title}
          </h1>
          <p className="mt-4 text-lg leading-8 text-text-secondary">{doc.description}</p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-text-muted">
            <span className="font-mono">{doc.sourcePath}</span>
            <span>{doc.sizeKB} KB</span>
            <a
              href={`/docs-md/${doc.slug}.md`}
              className="inline-flex items-center gap-1.5 text-provian-blue-bright hover:underline"
            >
              <FileDown size={14} />
              Raw markdown
            </a>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="mx-auto max-w-4xl">
          <article className="prose-provian" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </section>
    </div>
  )
}
