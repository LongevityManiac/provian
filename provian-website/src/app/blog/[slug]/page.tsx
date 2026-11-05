// /blog/<slug> — one static page per registry entry. `generateStaticParams`
// enumerates src/content/blog/index.ts, so the static export builds exactly
// the posts listed there and nothing else (output:'export' has no runtime
// fallback). The body is markdown rendered at build time by src/lib/blog.ts.
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ArrowUpRight, Clock } from 'lucide-react'
import { route } from '@/lib/routes'
import { POSTS, findPost } from '@/content/blog'
import { loadPost } from '@/lib/blog'

type Params = { slug: string }

export function generateStaticParams(): Params[] {
  return POSTS.map((p) => ({ slug: p.slug }))
}

export function generateMetadata({ params }: { params: Params }): Metadata {
  const post = findPost(params.slug)
  if (!post) return { title: 'Blog | Provian' }
  return {
    title: `${post.title} | Provian`,
    description: post.summary,
  }
}

export default function BlogPostPage({ params }: { params: Params }) {
  const post = loadPost(params.slug)

  return (
    <div className="bg-void text-text-primary">
      <section className="relative overflow-hidden border-b border-white/10 px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-glow-blue-radial" />
        <div className="relative z-10 mx-auto max-w-4xl">
          <Link
            href={route.blog}
            className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Blog
          </Link>
          <p className="eyebrow mt-8 text-provian-blue-bright/80">Developer writeup</p>
          <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.02] tracking-[-0.03em] md:text-5xl">
            {post.title}
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-text-secondary md:text-lg md:leading-8">
            {post.summary}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-[0.22em] text-text-muted">
            <span>By {post.author}</span>
            {post.published && <span>{post.published}</span>}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {post.readingMinutes} min read
            </span>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="mx-auto max-w-4xl">
          <article className="prose-provian" dangerouslySetInnerHTML={{ __html: post.html }} />

          <div className="mt-16 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
            <Link
              href={route.developers}
              className="inline-flex items-center gap-2 rounded-full bg-provian-blue-bright px-6 py-3 font-medium text-black transition hover:opacity-90"
            >
              Developers <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href={route.blog}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3 font-medium text-text-primary transition hover:bg-white/5"
            >
              All writeups <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
