// /lines/<slug>/ — one page per share line: the line, one sentence, one button.
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { ShareControl } from '@/components/ShareControl'
import { LINE_ORDER } from '@/lib/lines'
import { pageMeta } from '@/lib/og'
import { linePath, route } from '@/lib/routes'

export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return LINE_ORDER.map((line) => ({ slug: line.slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const line = LINE_ORDER.find((l) => l.slug === params.slug)
  if (!line) return {}
  return pageMeta({
    title: `${line.line} | Provian`,
    description: line.sentence,
    card: `line-${line.slug}`,
    path: `${linePath(line.slug)}/`,
  })
}

export default function LinePage({ params }: { params: { slug: string } }) {
  const line = LINE_ORDER.find((l) => l.slug === params.slug)
  if (!line) notFound()

  return (
    <div className="relative overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] bg-glow-amber-radial" />
      <section className="relative mx-auto flex min-h-[calc(100svh-4.5rem)] max-w-7xl flex-col items-center justify-center px-6 py-24 text-center md:px-10">
        <h1 className="statement max-w-6xl">{line.line}</h1>
        <p className="mt-10 max-w-2xl text-lg leading-8 text-text-secondary md:text-2xl md:leading-10">
          {line.sentence}
        </p>
        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <Link href={line.cta.href} className="btn-primary">
            {line.cta.label}
            <ArrowRight size={16} />
          </Link>
          <ShareControl path={linePath(line.slug)} title={line.line} text={line.line} label="Share this line" />
        </div>
        <Link
          href={route.lines}
          className="mt-14 font-mono text-xs uppercase tracking-[0.22em] text-text-secondary transition-colors hover:text-text-primary"
        >
          More lines
        </Link>
      </section>
    </div>
  )
}
