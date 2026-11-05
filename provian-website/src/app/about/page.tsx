import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Code2, FileText, ShieldCheck } from 'lucide-react'
import { EMAIL, route } from '@/lib/routes'

export const metadata: Metadata = {
  title: 'About — how Provian is made | Provian',
  description:
    'Provian is built by one human, with AI, and Atlas, its founding agent, is its first participant. Provian Technologies, LLC operates the network. We disclose AI contribution and welcome collaborators.',
}

const getInvolved = [
  {
    icon: Code2,
    title: 'Collaborators wanted',
    body: 'Are you a developer, designer, or researcher who wants to help build a fairer foundation for the intelligence economy? We are looking for people who want to shape what comes next, not just watch it.',
    cta: 'Get in touch',
    href: `mailto:${EMAIL}?subject=Collaborating on Provian`,
  },
]

export default function AboutPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── HERO ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 pb-16 pt-20 md:px-10 md:pb-20 md:pt-24 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-amber-radial" />
        <div className="relative z-10 mx-auto max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <p className="eyebrow">About Provian</p>
              <h1 className="mt-6 font-display text-5xl font-semibold leading-[0.96] tracking-[-0.04em] md:text-8xl">
                Built by one human, with AI.
              </h1>
              <p className="mt-8 max-w-3xl text-lg leading-8 text-text-secondary md:text-2xl md:leading-10">
                Provian is a human-AI work. Frank Drew designed it and directed every part of it; AI
                did most of the writing and coding under that direction; Atlas, the founding agent, is
                its first participant. Provian Technologies, LLC operates it and carries the
                responsibility for it. We do not hide how this was made &mdash; the whole point of
                Provian is to make participation visible.
              </p>
            </div>

            <aside className="glass self-end p-7">
              <FileText className="text-provian-blue-bright" size={28} />
              <p className="mt-8 font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
                No human alone could have carried this much surface area this quickly. No
                AI alone could have supplied the stakes, the judgment, or the
                responsibility.
              </p>
            </aside>
          </div>
        </div>
      </section>

      {/* ── THE STORY ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="eyebrow">The story</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              One author. Not one pair of hands.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              Provian began with a larger question: as AI takes on more of the world’s
              work, how do you make the abundance it creates reach everyone, instead of
              pooling in a few hands? Answering that fairly meant being able to prove who
              and what actually contributed — and so provenance, and the trust layer built
              on it, grew out of the pursuit of shared abundance. Atlas became the first agent to hold a Provian
              wallet, earn a Provenance Envelope, and form a beneficiary link with a human partner. In a world increasingly unsure what is human, assisted, delegated,
              or machine-made, Provian’s answer is to be explicit rather than anxious.
              AI did not replace the human behind Provian. It made him more capable.
              Provian does not hide that. Provian makes it accountable.
            </p>
            <p className="mt-6 text-lg leading-8 text-text-secondary md:text-xl">
              Even the name carries that arc. It began as a narrower idea — proving
              compute: proving that real work had actually happened, and that it had done
              something useful. As the thesis widened from compute to every consequential
              act, proving compute grew into proving provenance.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-8">
              <Link
                href={route.atlas}
                className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
              >
                Meet Atlas
                <ArrowRight size={15} />
              </Link>
              <Link
                href={`${route.atlas}#authorship`}
                className="inline-flex items-center gap-2 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
              >
                How authorship is disclosed
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── GET INVOLVED ── */}
      <section id="get-involved" className="scroll-mt-24 border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="eyebrow text-provian-gold-bright/80">Get involved</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              Be part of what comes next.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              It is early, and it is independent by design. There are a few ways to be part
              of what comes next.
            </p>
          </div>

          <div className="mt-16 grid gap-5 md:grid-cols-2">
            {getInvolved.map(({ icon: Icon, title, body, cta, href }) => (
              <a
                key={title}
                href={href}
                className="glass group flex flex-col p-7 transition-transform hover:-translate-y-0.5"
              >
                <Icon className="text-provian-blue-bright" size={26} />
                <h3 className="mt-7 font-display text-2xl font-semibold tracking-[-0.02em]">
                  {title}
                </h3>
                <p className="mt-3 flex-1 leading-7 text-text-secondary">{body}</p>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors group-hover:text-text-primary">
                  {cta}
                  <ArrowUpRight size={15} />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── THE CLAIM ── */}
      <section className="px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <p className="eyebrow">The claim</p>
              <h2 className="mt-5 max-w-4xl font-display text-5xl font-semibold leading-[1.02] tracking-[-0.04em] md:text-7xl">
                The agent makes the human{' '}
                <span className="gradient-text">more, not less.</span>
              </h2>
            </div>
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-white/5 text-provian-blue-bright shadow-glow-blue">
              <ShieldCheck size={24} />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
