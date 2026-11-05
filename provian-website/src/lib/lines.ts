// The share lines: each is staged alone on a page and has its own /lines/<slug>/
// page and share card.
import { route } from '@/lib/routes'

export type ShareLine = {
  slug: string
  // The line as it is set on screen.
  line: string
  // One sentence beneath it.
  sentence: string
  cta: { label: string; href: string }
}

export const LINES = {
  receipts: {
    slug: 'receipts',
    line: 'The future doesn’t need surveillance. It needs receipts.',
    sentence: 'A receipt proves what happened without exposing what was said. Whoever acts carries it.',
    cta: { label: 'Get the app', href: route.download },
  },
  proofYouOwn: {
    slug: 'proof-you-own',
    line: 'Proof you own.',
    sentence: 'Real work leaves proof that belongs to whoever did it, and no one can buy it.',
    cta: { label: 'Get the app', href: route.download },
  },
  yesMoney: {
    slug: 'yes-money',
    line: 'Money still matters when machines do the work.',
    sentence: 'Money is how people say what was done, and by whom.',
    cta: { label: 'Read the Founding Statement', href: `${route.library}/founding-statement` },
  },
  ubp: {
    slug: 'universal-basic-participation',
    line: 'Universal Basic Participation',
    sentence: 'Not a check for existing. PVT for your own work in the boom, minted at the source.',
    cta: { label: 'Universal Basic Participation', href: route.ubp },
  },
  tagline: {
    slug: 'compute-mints-money',
    line: 'Compute mints money. No one gets left behind.',
    sentence: 'PVT is minted from proof of real work and paid to whoever did it.',
    cta: { label: 'Get the app', href: route.download },
  },
} as const satisfies Record<string, ShareLine>

export const LINE_ORDER: ShareLine[] = [
  LINES.receipts,
  LINES.proofYouOwn,
  LINES.yesMoney,
  LINES.ubp,
  LINES.tagline,
]
