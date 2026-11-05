// /films/<slug>/ — one watch page per film: the film, one sentence, one
// button. The share card carries og:video. The Genesis film's page sits inside
// GenesisGate and shows the closed-state screen after the window closes.
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { Film } from '@/components/Film'
import { GenesisClosed, GenesisGate } from '@/components/GenesisGate'
import { ShareControl } from '@/components/ShareControl'
import { FILMS, FILM_ORDER, type FilmInfo } from '@/lib/genesis'
import { pageMeta } from '@/lib/og'
import { filmPath, route } from '@/lib/routes'

export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return FILM_ORDER.map((key) => ({ slug: FILMS[key].slug }))
}

function filmBySlug(slug: string): FilmInfo | undefined {
  return FILM_ORDER.map((key) => FILMS[key]).find((f) => f.slug === slug)
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const film = filmBySlug(params.slug)
  if (!film) return {}
  return pageMeta({
    title: `${film.title} — a Provian film`,
    description: film.line,
    card: `film-${film.slug}`,
    path: `${filmPath(film.slug)}/`,
    video: { url: film.src, width: film.width, height: film.height },
  })
}

function Watch({ film }: { film: FilmInfo }) {
  const action = film.genesis
    ? { label: 'How Genesis works', href: route.genesis }
    : { label: 'Get the app', href: route.download }
  return (
    <section className="relative px-6 pb-24 pt-12 md:px-10 md:pt-16 lg:px-14">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
      <div className="relative mx-auto max-w-6xl">
        <Link
          href={route.films}
          className="font-mono text-xs uppercase tracking-[0.22em] text-text-secondary transition-colors hover:text-text-primary"
        >
          Films
        </Link>
        <h1 className="mt-4 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
          {film.title}
        </h1>
        <Film {...film} className="mt-8" />
        <p className="mt-8 max-w-3xl font-display text-2xl leading-[1.35] text-text-primary md:text-3xl">
          {film.line}
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link href={action.href} className="btn-primary">
            {action.label}
            <ArrowRight size={16} />
          </Link>
          <ShareControl path={filmPath(film.slug)} title={`${film.title} — a Provian film`} label="Share this film" />
        </div>
      </div>
    </section>
  )
}

export default function FilmPage({ params }: { params: { slug: string } }) {
  const film = filmBySlug(params.slug)
  if (!film) notFound()

  if (!film.genesis) {
    return (
      <div className="bg-void text-text-primary">
        <Watch film={film} />
      </div>
    )
  }

  return (
    <div className="bg-void text-text-primary">
      <GenesisGate>
        <Watch film={film} />
      </GenesisGate>
      <GenesisClosed>
        <section className="mx-auto flex min-h-[70svh] max-w-5xl flex-col items-center justify-center px-6 py-24 text-center">
          <h1 className="statement">Genesis closed December 31, 2026.</h1>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href={route.download} className="btn-primary">
              Get the app
              <ArrowRight size={16} />
            </Link>
            <Link href={route.films} className="btn-ghost">
              Films
            </Link>
          </div>
        </section>
      </GenesisClosed>
    </div>
  )
}
