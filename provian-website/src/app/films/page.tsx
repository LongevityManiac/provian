// /films — the four films. Each has its own watch page at /films/<slug>/;
// the .mp4 files stay at /films/<slug>.mp4 (the app links to those).
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Film } from '@/components/Film'
import { GenesisGate } from '@/components/GenesisGate'
import { FILMS, FILM_ORDER, type FilmInfo } from '@/lib/genesis'
import { pageMeta } from '@/lib/og'
import { filmPath } from '@/lib/routes'

export const metadata = pageMeta({
  title: 'Films | Provian',
  description: 'Four short films: To The Stars, No One Left Behind, Genesis Is Open, and Nothing Unwitnessed.',
  card: 'films',
  path: '/films/',
})

function FilmBlock({ film }: { film: FilmInfo }) {
  return (
    <div className="border-t border-white/10 py-16 md:py-24">
      <Film {...film} />
      <div className="mt-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-10">
        <p className="max-w-3xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">{film.line}</p>
        <Link
          href={filmPath(film.slug)}
          className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
        >
          Open and share
          <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  )
}

export default function FilmsPage() {
  return (
    <div className="bg-void px-6 pb-10 pt-20 text-text-primary md:px-10 md:pt-28 lg:px-14">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow text-provian-blue-bright/80">Films</p>
        <h1 className="mt-6 pb-12 font-display text-6xl font-semibold leading-[0.95] tracking-[-0.04em] md:text-8xl">
          Films
        </h1>
        {FILM_ORDER.map((key) => {
          const film = FILMS[key]
          return film.genesis ? (
            <GenesisGate key={key}>
              <FilmBlock film={film} />
            </GenesisGate>
          ) : (
            <FilmBlock key={key} film={film} />
          )
        })}
      </div>
    </div>
  )
}
