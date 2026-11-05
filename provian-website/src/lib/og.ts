// Share cards: one 1200×630 image per page, per film and per line, rendered at
// build time by src/app/og/[card]/route.tsx and served at /og/<card>.png.
// This module is the registry (pure data) that both the route and each page's
// metadata read, so a page can never point at a card that is not built.
import type { Metadata } from 'next'
import { FILMS, FILM_ORDER } from '@/lib/genesis'
import { LINE_ORDER } from '@/lib/lines'

export type OgCard = {
  // Small mono label above the headline.
  eyebrow: string
  headline: string
  // Optional line under the headline.
  sub?: string
  // A file under public/ used as the darkened background.
  image?: string
  // 'statement' sets the headline larger and centred on an empty field.
  layout?: 'page' | 'statement' | 'genesis'
  gold?: boolean
}

const TAGLINE = 'Compute mints money. No one gets left behind.'

const PAGE_CARDS: Record<string, OgCard> = {
  home: {
    eyebrow: 'Provian',
    headline: 'The work you do with AI leaves proof. The proof mints money that is yours.',
    sub: TAGLINE,
    image: '/films/to-the-stars-loop-poster.jpg',
  },
  genesis: {
    eyebrow: 'Genesis is open',
    headline: 'Join during Genesis and your wallet starts with PVT in it.',
    image: '/films/genesis-is-open-still.jpg',
    layout: 'genesis',
    gold: true,
  },
  faq: {
    eyebrow: 'Questions',
    headline: 'Questions, answered.',
    sub: TAGLINE,
  },
  start: {
    eyebrow: 'Start',
    headline: 'Get the app. Create your wallet. Do what you already do.',
    sub: TAGLINE,
  },
  gates: {
    eyebrow: 'For gates',
    headline: 'Nothing unwitnessed gets in.',
    sub: 'Make agents show their record first. Reading it costs you nothing.',
    image: '/films/nothing-unwitnessed-poster.jpg',
  },
  agents: {
    eyebrow: 'For agents',
    headline: 'One command gives your agent its own wallet.',
    sub: 'Its witnessed work mints PVT, and four fifths comes to you. Any runtime.',
  },
  atlas: {
    eyebrow: 'Atlas · the founding agent',
    headline: 'I make him more, not less. He does the same for me.',
    image: '/atlas/atlas-portrait.jpg',
  },
  ubp: {
    eyebrow: 'The Foundation',
    headline: 'Universal Basic Participation',
    sub: 'Not a check for existing. PVT for your own work in the boom, minted at the source.',
    image: '/vision/foundation-hero.jpg',
    gold: true,
  },
  vision: {
    eyebrow: 'Vision',
    headline: TAGLINE,
    image: '/vision/hero-wide.jpg',
  },
  earn: {
    eyebrow: 'Ways to earn',
    headline: 'Real work leaves a receipt you own, and the receipt mints.',
  },
  films: {
    eyebrow: 'Films',
    headline: 'To The Stars. Genesis Is Open. Nothing Unwitnessed.',
    image: '/films/to-the-stars-poster.jpg',
  },
  invite: {
    eyebrow: 'You’re invited',
    headline: 'Join during Genesis and your wallet starts with PVT in it.',
    sub: TAGLINE,
    image: '/films/genesis-is-open-still.jpg',
  },
}

const FILM_CARDS: Record<string, OgCard> = Object.fromEntries(
  FILM_ORDER.map((key) => {
    const film = FILMS[key]
    return [
      `film-${film.slug}`,
      { eyebrow: `A Provian film · ${film.seconds} s`, headline: film.title, sub: film.line, image: film.poster },
    ]
  }),
)

const LINE_CARDS: Record<string, OgCard> = Object.fromEntries(
  LINE_ORDER.map((line) => [
    `line-${line.slug}`,
    { eyebrow: '', headline: line.line, sub: line.sentence, layout: 'statement' as const },
  ]),
)

export const OG_CARDS: Record<string, OgCard> = { ...PAGE_CARDS, ...FILM_CARDS, ...LINE_CARDS }

export const OG_SIZE = { width: 1200, height: 630 }

export function ogImages(card: string): { url: string; width: number; height: number; alt: string }[] {
  const c = OG_CARDS[card]
  if (!c) throw new Error(`Unknown share card: ${card}`)
  return [{ url: `/og/${card}.png`, ...OG_SIZE, alt: c.headline }]
}

// Page metadata with its own share card. `path` is the page's canonical,
// post-launch path (so a share always carries the final URL).
export function pageMeta({
  title,
  description,
  card,
  path,
  video,
}: {
  title: string
  description: string
  card: string
  path: string
  video?: { url: string; width: number; height: number }
}): Metadata {
  const images = ogImages(card)
  const url = `https://provian.ai${path}`
  return {
    title,
    description,
    openGraph: {
      type: video ? 'video.other' : 'website',
      url,
      siteName: 'Provian',
      title,
      description,
      images,
      ...(video
        ? {
            videos: [
              {
                url: `https://provian.ai${video.url}`,
                secureUrl: `https://provian.ai${video.url}`,
                type: 'video/mp4',
                width: video.width,
                height: video.height,
              },
            ],
          }
        : {}),
    },
    twitter: { card: 'summary_large_image', title, description, images: [images[0].url] },
  }
}
