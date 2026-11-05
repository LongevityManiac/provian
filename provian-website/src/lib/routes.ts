// Single source of truth for site routes and navigation.
//
// Route prefix is a deployment setting. Reader-facing links are derived here.
export const BASE = ''

export const EMAIL = 'hello@provian.ai'

// homepage lives at the root and carries the full header and footer like every
// other page. `length` rather than `!== ''` so the check stays well-typed while
// BASE is the literal '/preview'.
export const SPLASH_AT_ROOT: boolean = BASE.length > 0

export const route = {
  splash: '/',
  // domain root.
  home: BASE || '/',
  // The Genesis campaign page: the clock, the two paths, how to invite. After
  // the close it shows a single closed-state screen.
  genesis: '/genesis',
  // A person's path, in order.
  start: `${BASE}/start`,
  // The long read. /overview is the prior path; nginx 301s it here.
  vision: `${BASE}/vision`,
  // Catalog of ways to earn, linked from Start.
  earn: `${BASE}/earn`,
  // The one agent page: join, then why. Root-level because agents share
  agents: '/agents',
  // The protagonist: Atlas's statement, his live history, the authorship
  // disclosure.
  atlas: '/atlas',
  // Universal Basic Participation, with the Foundation as its mechanism.
  // /foundation is the prior path; nginx 301s it here.
  ubp: `${BASE}/ubp`,
  developers: `${BASE}/developers`,
  // The enterprise page: for the systems that will read incoming envelopes and decide (the
  // reference gate, the predicates, what a platform or hardware vendor can enable).
  gates: `${BASE}/gates`,
  // Developer writeups. An index at /blog plus one static page per post in
  // src/content/blog, rendered with the same `marked` the legal pages use.
  blog: `${BASE}/blog`,
  commons: `${BASE}/commons`,
  library: `${BASE}/library`,
  // Short questions and answers, each one readable alone.
  faq: `${BASE}/faq`,
  // One watch page per film; the .mp4 URLs under /films/ do not move.
  films: '/films',
  // One page per share line.
  lines: '/lines',
  // Secondary "use case" surface. Path stays /enterprise so the existing relay
  // pilot endpoint keeps working; it lives in the footer.
  enterprise: `${BASE}/enterprise`,
  // Public functional pages live at the domain root, not under BASE.
  download: '/download',
  daemon: '/daemon',
  // About / Our Story and how to get involved (#get-involved).
  about: '/about',
  support: '/support',
  // Android APK distribution page (checksum + version + sideload steps).
  downloadAndroid: '/download/android',
  // Promise share-link web fallback (open-in-app + get-the-app).
  promise: '/p',
  // Canonical legal pages, rendered from docs/legal/*.md.
  legalPrivacy: '/privacy',
  legalTerms: '/terms',
} as const

export function filmPath(slug: string): string {
  return `${route.films}/${slug}`
}

export function linePath(slug: string): string {
  return `${route.lines}/${slug}`
}

export type NavItem = { label: string; href: string }

// Primary header navigation. Genesis leads it in gold with the days left, and
// is rendered by the header itself inside GenesisGate so it removes itself at
// the close; these four follow it, then the "Get the app" button.
export const PRIMARY_NAV: NavItem[] = [
  { label: 'Start', href: route.start },
  { label: 'Agents', href: route.agents },
  { label: 'Vision', href: route.vision },
  { label: 'Foundation', href: route.ubp },
]

// The header "More" menu: one short list.
export const MORE_NAV: NavItem[] = [
  { label: 'Atlas', href: route.atlas },
  { label: 'Films', href: route.films },
  { label: 'Commons', href: route.commons },
  { label: 'Library', href: route.library },
  { label: 'Developers', href: route.developers },
  { label: 'Gates', href: route.gates },
  { label: 'FAQ', href: route.faq },
  { label: 'About', href: route.about },
]

// Public functional pages share a minimal header/footer that must NOT advertise
// the gated routes. This is the safe cross-nav among the public pages
// themselves, so landing on /support is not a dead end while the site stays
// behind the password.
export const PUBLIC_NAV: NavItem[] = [
  { label: 'Get the app', href: route.download },
  { label: 'Desktop app', href: route.daemon },
  { label: 'About', href: route.about },
  { label: 'Support', href: route.support },
]

// Social profiles, rendered as icon links in the footer. EMPTY until a real
// account exists: we ship no dead links. To add a channel, append a
// { label, href } with the LIVE profile URL — the label must match a key in
// Footer.tsx's SOCIAL_ICONS map (GitHub | X | Facebook | Instagram).
export const SOCIAL_NAV: NavItem[] = []

// Canonical legal links, shown in the footer of every page.
export const LEGAL_NAV: NavItem[] = [
  { label: 'Privacy', href: route.legalPrivacy },
  { label: 'Terms', href: route.legalTerms },
]

// Footer columns: the full sitemap. Contact, Blog, For organizations and
// Support live here and not in the header.
export const FOOTER_NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Participate',
    items: [
      { label: 'Get the app', href: route.download },
      { label: 'Start', href: route.start },
      { label: 'Ways to earn', href: route.earn },
      { label: 'Agents', href: route.agents },
      { label: 'Desktop app', href: route.daemon },
    ],
  },
  {
    heading: 'Explore',
    items: [
      { label: 'Vision', href: route.vision },
      { label: 'Foundation', href: route.ubp },
      { label: 'Atlas', href: route.atlas },
      { label: 'Films', href: route.films },
      { label: 'The Commons', href: route.commons },
      { label: 'Library', href: route.library },
      { label: 'Developers', href: route.developers },
      { label: 'Gates', href: route.gates },
      { label: 'FAQ', href: route.faq },
      { label: 'Blog', href: route.blog },
    ],
  },
  {
    heading: 'Company',
    items: [
      { label: 'About', href: route.about },
      { label: 'Contact', href: `mailto:${EMAIL}` },
      { label: 'For organizations', href: route.enterprise },
      { label: 'Collaborate', href: `${route.about}#get-involved` },
      { label: 'Support', href: route.support },
    ],
  },
]

// that renders without the site header and footer. Always false after the
// flip, when the root is the homepage.
export function isSplash(pathname: string): boolean {
  return SPLASH_AT_ROOT && pathname === route.splash
}

export function isStaged(pathname: string): boolean {
  return pathname === route.home || pathname.startsWith(`${BASE}/`)
}

// visitor here has already passed the gate, so they get the full site chrome
// (primary nav + full footer). The truly-public pages (the splash and /support)
// keep the minimal chrome so they never advertise gated links to an
// unauthenticated visitor.
const FULL_CHROME_ROOT: string[] = [
  route.download,
  route.about,
  route.daemon,
  route.genesis,
  route.agents,
  route.atlas,
  route.films,
  route.lines,
]

export function usesFullChrome(pathname: string): boolean {
  if (isStaged(pathname)) return true
  return FULL_CHROME_ROOT.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
