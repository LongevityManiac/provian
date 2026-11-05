// /blog — the developer writeup index (launch channel G7). Lists every post in
// the typed registry at src/content/blog; each post is its own static page at
// /blog/<slug>. No dates are shown unless a post records the date it went live.
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowUpRight, Clock } from 'lucide-react'
import { route } from '@/lib/routes'
import { POSTS } from '@/content/blog'

export const metadata: Metadata = {
  title: 'Blog | Provian',
  description:
    'Technical writeups from Provian: how Provenance Envelopes are built, how work gets witnessed and corroborated, and what a verifiable work history is worth to a counterparty.',
}

export default function BlogIndexPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-glow-blue-radial" />

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-28 pt-28 md:px-10 md:pt-36">
        <p className="eyebrow text-provian-blue-bright/80">Blog</p>
        <h1 className="mt-6 max-w-3xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.04em] md:text-6xl">
          Writeups for people who build agents.
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-text-secondary">
          How a receipt is built, what gets signed, why two witnesses of one act mint once, and what a
          counterparty can read from an agent&rsquo;s history.
        </p>

        <div className="mt-14 grid gap-5">
          {POSTS.map((post) => (
            <Link key={post.slug} href={`${route.blog}/${post.slug}/`} className="glass block p-7 md:p-9">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-[0.22em] text-text-muted">
                <span>{post.author}</span>
                {post.published && <span>{post.published}</span>}
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  {post.readingMinutes} min
                </span>
              </div>
              <h2 className="mt-4 font-display text-2xl font-semibold tracking-[-0.02em] md:text-3xl">
                {post.title}
              </h2>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary md:text-base md:leading-7">
                {post.summary}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-white/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted"
                  >
                    {tag}
                  </span>
                ))}
                <span className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-provian-blue-bright">
                  Read <ArrowUpRight className="h-4 w-4" aria-hidden />
                </span>
              </div>
            </Link>
          ))}
        </div>

        <div className="glass mt-12 p-7">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">Proof and PVT</p>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary">
            Every act of work mints PVT once, at the value its evidence supports, proven by a receipt its owner
            carries. While the protocol is operated, supply has no lifetime cap and grows only as witnessed work settles. PVT is worth what the
            network does with it, and its worth outside that loop is for markets Provian does not create, run or
            promise.
          </p>
        </div>

        <div className="mt-12 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
          <Link
            href={route.developers}
            className="inline-flex items-center gap-2 rounded-full bg-provian-blue-bright px-6 py-3 font-medium text-black transition hover:opacity-90"
          >
            Developers <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href={route.library}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3 font-medium text-text-primary transition hover:bg-white/5"
          >
            Library <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/llms.txt"
            className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3 font-medium text-text-primary transition hover:bg-white/5"
          >
            llms.txt <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>
    </div>
  )
}
