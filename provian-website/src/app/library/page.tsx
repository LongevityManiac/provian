import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { route } from '@/lib/routes'
import manifest from '@/data/docsManifest.json'

export const metadata: Metadata = {
  title: 'Library | Provian',
  description:
    'Why Provian exists and how its economy works, and the reference for anyone building on it.',
}

interface DocEntry {
  slug: string
  title: string
  group: string
  badge?: string
  displayVersion?: string
  description: string
  sourcePath: string
  sizeKB: number
}

// The published Library is eight documents (scripts/sync-docs.mjs is the one
// list; this page renders whatever docsManifest.json holds, in its order).
const library = manifest.docs as DocEntry[]

const GROUPS: { key: string; title: string; blurb: string }[] = [
  {
    key: 'why',
    title: 'Why Provian',
    blurb: 'Start with the Executive Summary. The Thesis tells the whole story.',
  },
  {
    key: 'build',
    title: 'Build on it',
    blurb: 'The complete reference, the open standard, and the gate contract.',
  },
]

export default function LibraryPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── HERO ── */}
      <section className="relative overflow-hidden px-6 pb-16 pt-16 md:px-10 md:pb-20 md:pt-20 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-glow-blue-radial" />
        <div className="relative z-10 mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">The Library</p>
          <h1 className="mt-6 max-w-4xl font-display text-5xl font-semibold leading-[0.95] tracking-[-0.04em] md:text-7xl">
            The Provian <span className="gradient-text">Library.</span>
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            Five documents on why Provian exists and how its economy works, and
            three for anyone building on it. Every document is also available as
            raw markdown for agents that prefer the source.
          </p>
        </div>
      </section>

      {/* ── GROUPED LIBRARY ── */}
      {GROUPS.map((group, gi) => {
        const docs = library.filter((d) => d.group === group.key)
        if (docs.length === 0) return null
        return (
          <section
            key={group.key}
            className={`border-t border-white/10 px-6 py-20 md:px-10 lg:px-14 ${
              gi % 2 === 1 ? 'bg-surface' : ''
            }`}
          >
            <div className="mx-auto max-w-7xl">
              <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
                <div className="lg:sticky lg:top-28 lg:self-start">
                  <p className="eyebrow">{group.title}</p>
                  <p className="mt-6 leading-8 text-text-secondary">{group.blurb}</p>
                </div>
                <div className="grid gap-4">
                  {docs.map((doc) => {
                    const featured = Boolean(doc.badge)
                    return (
                      <Link
                        key={doc.slug}
                        href={`${route.library}/${doc.slug}/`}
                        className={`glass group flex items-start justify-between gap-4 p-6 transition-colors hover:border-white/20 ${
                          featured ? 'border-provian-blue/40 ring-1 ring-provian-blue/20' : ''
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            {doc.badge && (
                              <span className="rounded-full border border-provian-blue/40 bg-provian-blue/10 px-2.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-provian-blue-bright">
                                {doc.badge}
                              </span>
                            )}
                            <h3 className="font-display text-xl font-semibold tracking-[-0.02em]">
                              {doc.title}
                            </h3>
                            {doc.displayVersion && (
                              <span className="font-mono text-xs text-text-muted">
                                {doc.displayVersion}
                              </span>
                            )}
                          </div>
                          <p className="mt-2 leading-7 text-text-secondary">{doc.description}</p>
                        </div>
                        <ArrowUpRight
                          size={18}
                          className="mt-1 shrink-0 text-text-muted transition-colors group-hover:text-provian-blue-bright"
                        />
                      </Link>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
