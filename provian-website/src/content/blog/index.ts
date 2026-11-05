// The blog post registry — the ONE list the /blog index and the per-post
// route both read. Adding a post is: write `src/content/blog/<slug>.md`, add
// its metadata entry to POSTS below. `generateStaticParams` enumerates this
// array, so a post that is not listed here is not built.
//
// Bodies are plain markdown files rendered at build time by `src/lib/blog.ts`
// with `marked` — the same renderer `src/lib/legal.ts` already uses for
// /privacy and /terms — so the blog adds no dependency and no client-side
// markdown.
//
// COPY RULES that bind every post (CLAUDE.md, Security Invariant #1):
//   · every act of work mints once, at the value its evidence supports; an
//     envelope is proof its owner carries, not a record kept on them.
//   · no total-supply or float figure; state the rule (no lifetime cap, grows
//     only as witnessed work settles), never a number.
//   · two keys, never conflated: the wallet key is secp256k1 and leaves the
//     phone only as backup-password-encrypted ciphertext; the P-256 PE
//     attestation key is the hardware-held one and identifies the DEVICE.
//   · no publish date that claims a past date. `published` is optional and, when
//     set, is the date the post went live — never backfilled.
//
// KEEP THIS MODULE DEPENDENCY-FREE (data only): the loader imports it, and a
// node:fs import here would drag the filesystem into any client that lists
// posts.

export interface BlogPostMeta {
  /** URL segment under /blog/ AND the markdown filename (`<slug>.md`). */
  readonly slug: string
  readonly title: string
  /** One-sentence standfirst, shown on the index card and as the meta description. */
  readonly summary: string
  /** Byline. Posts are authored by the project, not by a named individual. */
  readonly author: 'Provian'
  /** ISO date (YYYY-MM-DD) the post went live, or null to show no date. */
  readonly published: string | null
  /** Short topical labels for the index card. */
  readonly tags: readonly string[]
  /** Approximate reading time, minutes. */
  readonly readingMinutes: number
}

export const POSTS: readonly BlogPostMeta[] = [
  {
    slug: 'why-your-agent-needs-a-work-history',
    title: 'Why your agent needs a work history',
    summary:
      'What a Provenance Envelope contains, why an agent’s own claim is not a receipt at all, how two witnesses of one act mint once at the better-supported value, and what a job board or an x402 seller reads from an agent’s history.',
    author: 'Provian',
    published: null,
    tags: ['Provenance Envelopes', 'Corroboration', 'Agents'],
    readingMinutes: 9,
  },
]

export function findPost(slug: string): BlogPostMeta | undefined {
  return POSTS.find((p) => p.slug === slug)
}
