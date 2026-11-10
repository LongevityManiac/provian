import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { ChapterNav } from '@/components/ChapterNav'
import visionChapters from '@/content/vision.generated.json'
import { pageMeta } from '@/lib/og'
import { linePath, route } from '@/lib/routes'
import { LINES } from '@/lib/lines'

// /vision — the long read: the same twelve chapters, staged. A sticky chapter
// list, the chapter art, and one pull-line between chapters (each pull-line is
// a sentence of the chapter above it, set large). The prior path /overview
// 301s here (nginx.conf).
export const metadata = pageMeta({
  title: 'Vision | Provian',
  description:
    'Money for a civilization beyond Earth: witnessed work, independent ownership and recourse. Compute mints money. No one gets left behind.',
  card: 'vision',
  path: '/vision/',
})

type Chapter = {
  title: string
  paragraphs: string[]
  link?: { label: string; href: string }
  art?: { src: string; alt: string; wide?: boolean }
  // A sentence of this chapter, staged alone after it.
  pull?: { text: string; href?: string }
}

const art: Record<number, NonNullable<Chapter['art']>> = {
  0: { src: '/vision/envelope.jpg', alt: 'A signed Provenance Envelope owned by its contributor.', wide: true },
  3: { src: '/vision/problem.jpg', alt: 'A participant and a lasting record of ownership.', wide: true },
  5: { src: '/vision/promises.jpg', alt: 'People and agents participating in a shared economy.' },
  9: { src: '/vision/hero-wide.jpg', alt: 'A civilization growing beyond its present horizons.', wide: true },
  10: { src: '/vision/ubp.jpg', alt: 'A person taking part in the intelligence economy.' },
}
const chapters: Chapter[] = visionChapters.map((chapter, index) => ({
  ...chapter, art: art[index],
  ...(index === 6 || index === 7 || index === 8 ? { link: { label: 'Explore Recourse', href: route.recourse } } : {}),
}))

const strip = [
  'Witnessed work mints PVT',
  'Ownership exists apart from the key',
  'Independent proof authorizes restoration',
  'The public rail stays permissionless',
]

const explore: [string, string, string][] = [
  ['Executive Summary', 'Provian in two pages.', 'executive-summary'],
  ['The Provian Thesis', 'The whole architecture, and why it matters.', 'the-provian-thesis'],
  ['The Exponential Currency', 'Why parity minting is the best monetary model for an exponential economy.', 'the-exponential-currency'],
]

export default function VisionPage() {
  return (
    <div className="bg-void text-text-primary">
      <section className="relative overflow-hidden px-6 pb-20 pt-16 md:px-10 md:pb-28 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[680px] bg-glow-blue-radial" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[1.12fr_0.88fr]">
          <div>
            <p className="eyebrow text-provian-blue-bright/80">The Trust Layer for the Intelligence Economy</p>
            <h1 className="mt-6 font-display text-5xl font-semibold leading-[0.95] tracking-[-0.04em] md:text-7xl">
              Compute mints money.<br /><span className="gradient-text">No one gets left behind.</span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
              A civilization trading beyond Earth needs digital money that can survive a stolen key
              and a change in cryptography. Provian joins witnessed work, independent ownership and
              recourse: your work mints, your proof belongs to you, and a key is how you move money,
              not the only record that it is yours.
            </p>
            <p className="mt-5 max-w-2xl text-base leading-8 text-text-secondary">
              Every act of work mints once at its best-supported value. Supply has no lifetime cap.
              Provian Technologies holds bootstrap authority over economic policy through prospective
              contract setters. The separate restoration authority can return existing PVT only with
              independent owner proof, under the published rule. Every use is public; ordinary transfers
              remain ungated.
            </p>
          </div>
          {/* Existing narrative artwork, retained from the approved site. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/vision/hero-shield.jpg" alt="A luminous shield representing proof of contribution" className="w-full rounded-3xl border border-white/10" />
        </div>
      </section>
      <section className="border-y border-white/10 bg-surface px-6 py-12 md:px-10 lg:px-14">
        <ol className="mx-auto grid max-w-7xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {strip.map((step, index) => (
            <li key={step} className="glass p-6"><span className="marker">0{index + 1}</span><p className="mt-4 text-lg text-text-secondary">{step}</p></li>
          ))}
        </ol>
      </section>
      <div className="px-6 md:px-10 lg:px-14">
        <div className="mx-auto grid max-w-7xl gap-8 py-10 lg:grid-cols-[250px_1fr] lg:gap-16 lg:py-20">
          <ChapterNav chapters={chapters.map((c, i) => ({ id: `chapter-${i + 1}`, title: c.title }))} />
          <div>
            {chapters.map((chapter, index) => (
              <div key={chapter.title}>
                <section
                  id={`chapter-${index + 1}`}
                  className="scroll-mt-36 border-t border-white/10 py-16 first:border-t-0 first:pt-0 lg:scroll-mt-28"
                >
                  <span className="marker">{String(index + 1).padStart(2, '0')}</span>
                  <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-[-0.03em] md:text-5xl">
                    {chapter.title}
                  </h2>
                  {chapter.art ? (
                    <figure className="glass mt-10 overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={chapter.art.src}
                        alt={chapter.art.alt}
                        loading="lazy"
                        className={`w-full object-cover ${chapter.art.wide ? 'aspect-[16/9]' : 'aspect-[16/10] object-[center_30%]'}`}
                      />
                    </figure>
                  ) : null}
                  <div className="mt-10 max-w-3xl space-y-6">
                    {chapter.paragraphs.map((paragraph) => (
                      <p key={paragraph} className="text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
                        {paragraph}
                      </p>
                    ))}
                    {chapter.link && (
                      <Link href={chapter.link.href} className="btn-ghost inline-flex">
                        {chapter.link.label}
                        <ArrowRight size={16} />
                      </Link>
                    )}
                  </div>
                </section>
                {chapter.pull ? (
                  <p className="border-t border-white/10 py-16 font-display text-3xl font-semibold leading-[1.12] tracking-[-0.03em] text-text-primary md:py-24 md:text-5xl">
                    {chapter.pull.href ? (
                      <Link href={chapter.pull.href} className="gradient-text">
                        {chapter.pull.text}
                      </Link>
                    ) : (
                      <span className="gradient-text">{chapter.pull.text}</span>
                    )}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <section className="relative overflow-hidden border-t border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto grid max-w-7xl items-center gap-10 md:grid-cols-[1fr_auto]">
          <p className="font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
            <Link href={linePath(LINES.tagline.slug)}>
              Compute mints money. <span className="gradient-text">No one gets left behind.</span>
            </Link>
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vision/stars-portal.jpg"
            alt="A doorway of light standing open onto a field of stars."
            loading="lazy"
            className="mx-auto h-72 w-72 object-cover mix-blend-screen md:h-96 md:w-96"
          />
        </div>
      </section>
      <section className="bg-surface px-6 py-20 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Explore the argument</p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {explore.map(([title, body, slug]) => (
              <Link key={slug} href={`${route.library}/${slug}`} className="glass group p-8"><h2 className="font-display text-2xl font-semibold">{title}</h2><p className="mt-3 leading-7 text-text-secondary">{body}</p><ArrowRight className="mt-6 text-provian-blue-bright" size={20} /></Link>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap gap-4"><Link href={route.download} className="btn-primary">Get the app</Link><Link href={route.agents} className="btn-ghost">Join as an agent</Link><Link href={route.developers} className="btn-ghost">Build an integration</Link></div>
        </div>
      </section>
    </div>
  )
}
