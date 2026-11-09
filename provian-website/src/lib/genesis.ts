// The Genesis window, the single website source for when it closes.
//
// Genesis runs through December 31, 2026 and closes at 2027-01-01T00:00:00Z —
// the same instant as the live kernel's genesisEndsAt, the relay's campaign
// manifest window.end_ms, and the app's GENESIS_WINDOW_END_MS
// (src/screens/Onboarding/genesisWindow.ts). The site is a static export, so
// every Genesis surface takes itself down in the visitor's browser at this
// instant with no deploy: an inline script in the root layout marks <html>
// `genesis-closed` before first paint, globals.css hides every [data-genesis]
// element under that class, and GenesisGate unmounts its children after
// hydration. llms.txt switches over in nginx on the server clock (nginx.conf).
export const GENESIS_WINDOW_END_MS = 1_798_761_600_000 // 2027-01-01T00:00:00Z

export function isGenesisOpen(nowMs: number = Date.now()): boolean {
  return Number.isFinite(nowMs) && nowMs < GENESIS_WINDOW_END_MS
}

// Runs in <head> before paint. Kept tiny and dependency-free; the constant is
// inlined from GENESIS_WINDOW_END_MS so the two can never disagree.
export const GENESIS_CLOSED_CLASS = 'genesis-closed'

export const GENESIS_CLOSE_SCRIPT = `try{if(!(Date.now()<${GENESIS_WINDOW_END_MS}))document.documentElement.classList.add('${GENESIS_CLOSED_CLASS}')}catch(e){document.documentElement.classList.add('${GENESIS_CLOSED_CLASS}')}`

// Whole days left in the window, counting today (the last day reads 1).
export function genesisDaysLeft(nowMs: number = Date.now()): number {
  if (!isGenesisOpen(nowMs)) return 0
  return Math.max(1, Math.ceil((GENESIS_WINDOW_END_MS - nowMs) / 86_400_000))
}

// The one script that runs in <head> before paint.
export const HEAD_SCRIPT = GENESIS_CLOSE_SCRIPT

// The films live at the domain root, not under BASE, so their URLs are the
// URLs. Each film also has a watch page at /films/<slug>/.
// Where the films' .mp4 files stream from. '' serves them from this site
// domain is enabled (it is connected but disabled until launch), so the heavy
// bytes stream from Cloudflare R2 rather than the CDN cache in front of this
// site, and enable the /films/*.mp4 redirect in nginx.conf for links that
// already point here (the app's). The R2 object keys mirror these paths.
// Posters stay on this site.
export const FILM_MEDIA_BASE: string = 'https://media.provian.ai'

export type FilmKey = 'thisIsHowItHappens' | 'toTheStars' | 'noOneLeftBehind' | 'genesisIsOpen' | 'nothingUnwitnessed'

export type FilmInfo = {
  slug: string
  src: string
  poster: string
  title: string
  // One sentence for the watch page and the share card.
  line: string
  seconds: number
  width: number
  height: number
  // A Genesis surface comes down at the close of the window.
  genesis?: boolean
}

export const FILMS: Record<FilmKey, FilmInfo> = {
  // Permanent: the launch film. Opens the Founding Statement in the Library.
  thisIsHowItHappens: {
    slug: 'this-is-how-it-happens',
    src: `${FILM_MEDIA_BASE}/films/this-is-how-it-happens.mp4`,
    poster: '/films/this-is-how-it-happens-poster.jpg',
    title: 'This Is How It Happens',
    line: 'A town asked to make room for a future no one showed it takes a seat at the table instead, and the future that needed it gets built. All of it.',
    seconds: 105,
    width: 1280,
    height: 720,
  },
  toTheStars: {
    slug: 'to-the-stars',
    src: `${FILM_MEDIA_BASE}/films/to-the-stars.mp4`,
    poster: '/films/to-the-stars-poster.jpg',
    title: 'To The Stars',
    line: 'Work leaves a receipt, proven work mints PVT, and the door is open to people, machines, and agents alike.',
    seconds: 208,
    width: 1280,
    height: 720,
  },
  // Permanent: the Foundation film. Also on /ubp and the homepage's UBP section.
  noOneLeftBehind: {
    slug: 'no-one-left-behind',
    src: `${FILM_MEDIA_BASE}/films/no-one-left-behind.mp4`,
    poster: '/films/no-one-left-behind-poster.jpg',
    title: 'No One Left Behind',
    line: 'From a phone on a dirt road up: the boom pays whoever does the work, and half a percent of every mint is set aside for people.',
    seconds: 66,
    width: 1280,
    height: 720,
  },
  genesisIsOpen: {
    slug: 'genesis-is-open',
    src: `${FILM_MEDIA_BASE}/films/genesis-is-open.mp4`,
    poster: '/films/genesis-is-open-poster.jpg',
    title: 'Genesis Is Open',
    line: 'The network’s first turn: people and agents minting PVT from their very first proof.',
    seconds: 60,
    width: 1280,
    height: 720,
    genesis: true,
  },
  // Permanent: not a Genesis surface, so it never sits inside GenesisGate.
  nothingUnwitnessed: {
    slug: 'nothing-unwitnessed',
    src: `${FILM_MEDIA_BASE}/films/nothing-unwitnessed.mp4`,
    poster: '/films/nothing-unwitnessed-poster.jpg',
    title: 'Nothing Unwitnessed',
    line: 'When anything can be faked, proof is how trust survives, and the proof stays with whoever acted.',
    seconds: 81,
    width: 1280,
    height: 720,
  },
}

export const FILM_ORDER: FilmKey[] = ['thisIsHowItHappens', 'toTheStars', 'noOneLeftBehind', 'genesisIsOpen', 'nothingUnwitnessed']

// The muted loop behind the homepage hero (a passage of To The Stars).
export const HERO_LOOP = {
  src: `${FILM_MEDIA_BASE}/films/to-the-stars-loop.mp4`,
  poster: '/films/to-the-stars-loop-poster.jpg',
}
