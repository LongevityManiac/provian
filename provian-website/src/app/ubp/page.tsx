import Link from 'next/link'
import { Film } from '@/components/Film'
import { FILMS } from '@/lib/genesis'
import { ArrowRight } from 'lucide-react'
import { GenesisGate } from '@/components/GenesisGate'
import { RevealOnScroll } from '@/components/RevealOnScroll'
import { ShareControl } from '@/components/ShareControl'
import { LINES } from '@/lib/lines'
import { pageMeta } from '@/lib/og'
import { linePath, route } from '@/lib/routes'

// /ubp — Universal Basic Participation is the headline; the Foundation is the
// mechanism. (The prior path /foundation 301s here, nginx.conf.)
export const metadata = pageMeta({
  title: 'Universal Basic Participation | Provian',
  description:
    'Universal Basic Participation: not a check for existing, but PVT for your own work in the boom, minted at the source to whoever did it. Half a percent of every mint flows to the Provian Foundation’s treasury.',
  card: 'ubp',
  path: '/ubp/',
})

// Prose lives in string constants and renders via {expressions}, not literal JSX
// text, so apostrophes stay raw without tripping react/no-unescaped-entities.

const HERO_SUB =
  'At least half a percent of each mint flows to the Provian Foundation’s on-chain treasury in the same settlement that pays contributors. The human and Genesis rate is fixed at half a percent. An agent-side rate may rise prospectively, with that same immutable floor.'

const QUESTION_BODY =
  'Provian began with that question. If AI and autonomous agents produce more of the world’s value, the risk is that it pools with whoever owns the models, the chips, and the capital, while people fall outside the economy AI builds. Provian’s answer is not a tax collected after the fact or a dividend from a benevolent owner of the machines. It is PVT for your own part in the boom, minted at the source to whoever did the work, from the first block.'

const UBP_BODY =
  'Universal Basic Income is a floor paid to people as the machines do more of the work. A floor may well be needed; it cannot say what anyone contributed, and it leaves their standing to political will. Universal Basic Participation answers a different question. It keeps people present, as contributors, beneficiaries, principals, reviewers, builders, and members, inside the system where value is created, and it is funded by that system’s own activity. It sits beneath income and atop whatever floor a society already has. It replaces neither.'

const GROWTH_INTRO =
  'Standard mints that reach a person, and Genesis grants, split ninety-nine percent to the contributor, half a percent to Provian, half a percent to the Foundation. The human-side rate is fixed in the contract, and the agent-side Foundation rate has the same floor. As production shifts from human-linked work toward agent and device work, the agent-side rate can be raised, prospectively, without raising the burden on any person. Nothing already sealed is ever repriced.'

const LOCK_BODY =
  'The live kernel protects the human-side split as an immutable rule. Agents mint, trade, hire, escrow and post performance bonds, but accumulating PVT does not confer control of the kernel. Provian Technologies, LLC administers economic policy through the bootstrap wallet’s prospective contract setters.'

const STATUS_TREASURY = 'The Foundation exists today as the on-chain treasury every settlement pays into'

const STATUS_BODY =
  'The treasury receives its share directly from the kernel. Provian Technologies, LLC administers the protocol prospectively under the deployed contract rules. The Network Constitution sets out the broader human-participation commitments.'

const COMMITMENT_BODY =
  'Provian commits to establishing the Foundation as the institution that distributes from its treasury. That commitment includes membership for verified people and unique-human verification, which will establish that each member is one distinct person. The Network Dividend is Provian’s commitment to distributions from that treasury to verified human members.'

const floorStats = [
  {
    value: '99 / 0.5 / 0.5',
    label: 'Person and Genesis split: contributor, Provian, Foundation.',
  },
  {
    value: '≥ 0.5%',
    label: 'The agent-side Foundation rate can rise and can never fall below the floor.',
  },
]

export default function UbpPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── HERO: UBP is the headline ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 pb-16 pt-20 md:px-10 md:pb-24 md:pt-28 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-amber-radial" />
        <div className="relative z-10 mx-auto max-w-7xl">
          <p className="eyebrow text-provian-gold-bright/80">UBP</p>
          <h1 className="mt-6 max-w-5xl font-display text-5xl font-semibold leading-[0.96] tracking-[-0.04em] md:text-8xl">
            <span className="gradient-text">Universal Basic Participation</span>
          </h1>
          <p className="mt-8 max-w-3xl text-xl leading-9 text-text-secondary md:text-2xl md:leading-10">
            Not a check for existing. PVT for your own work in the boom, minted at the source to
            whoever did it, with an immutable share directed to the Foundation treasury.
          </p>
          <div className="mt-8">
            <ShareControl
              path={linePath(LINES.ubp.slug)}
              title="Universal Basic Participation — Provian"
              text={LINES.ubp.line}
            />
          </div>
          <Film {...FILMS.noOneLeftBehind} className="mt-14" />
        </div>
      </section>

      {/* ── UNIVERSAL BASIC PARTICIPATION ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
          <div>
            <h2 className="font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              Participation, not a handout.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              {UBP_BODY}
            </p>
          </div>
          <figure className="glass overflow-hidden">
            <img
              src="/vision/ubp.jpg"
              alt="A person at home by a sunlit window holds a phone as soft threads of blue light rise from its screen."
              loading="lazy"
              className="aspect-square w-full object-cover opacity-95"
            />
          </figure>
        </div>
      </section>

      {/* ── THE QUESTION ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="eyebrow">Why Provian exists</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              How does the wealth of a new age reach everyone?
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              {QUESTION_BODY}
            </p>
          </div>
          <blockquote className="mt-10 max-w-4xl border-l-2 border-provian-gold pl-6 font-display text-2xl font-medium leading-snug tracking-[-0.01em] text-text-primary md:text-3xl">
            Provenance is the proof. The Foundation is the promise.
          </blockquote>
        </div>
      </section>

      {/* ── THE MECHANISM: the Foundation ── */}
      <section id="foundation" className="scroll-mt-24 relative overflow-hidden border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <img
          src="/vision/hero-wide.jpg"
          alt=""
          loading="lazy"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-void via-void/85 to-void" />
        <div className="relative mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="eyebrow text-provian-gold-bright/80">The mechanism: the Foundation</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              Half a percent of every mint,{' '}
              <span className="gradient-text">set aside for people.</span>
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
              {HERO_SUB}
            </p>
          </div>
          <div className="mt-12 grid border-t border-white/10 md:grid-cols-3">
            {[
              ['01', 'A treasury that fills as the network works.'],
              ['02', 'An immutable human-side treasury floor.'],
              ['03', 'A floor the machines raise.'],
            ].map(([index, text]) => (
              <div
                key={index}
                className="flex items-center gap-4 border-white/10 py-6 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0"
              >
                <span className="marker">{index}</span>
                <span className="text-sm font-semibold uppercase tracking-[0.16em] text-text-primary/80">
                  {text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="eyebrow text-provian-gold-bright/80">Provian’s commitments</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              What the treasury is for.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              {COMMITMENT_BODY}
            </p>
          </div>
        </div>
      </section>

      {/* ── THE FLOOR THAT GROWS ── */}
      <section
        id="growth"
        className="scroll-mt-24 border-b border-white/10 px-6 py-24 md:px-10 lg:px-14"
      >
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="eyebrow text-provian-gold-bright/80">The floor that grows</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              A floor, not a ceiling.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              {GROWTH_INTRO}
            </p>
          </div>

          <figure className="mt-12">
            <div className="glass p-6 md:p-8">
              <svg
                viewBox="0 0 880 360"
                role="img"
                aria-label="An illustrative chart: the agent-side Foundation rate starts at its 0.5% floor and can rise prospectively as production shifts toward machines; it never falls below the floor."
                className="h-auto w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <defs>
                  <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4a9eff" stopOpacity="0.34" />
                    <stop offset="100%" stopColor="#4a9eff" stopOpacity="0" />
                  </linearGradient>
                  <marker
                    id="growthArrow"
                    viewBox="0 0 10 10"
                    refX="7"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L10,5 L0,10 z" fill="#6bb3ff" />
                  </marker>
                </defs>

                {/* illustrative prospective policy range */}
                <line x1="110" y1="110" x2="760" y2="110" stroke="#b87e1a" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="5 6" />
                <text x="114" y="100" fontSize="14" fill="#949eb4">agent-side rate</text>

                {/* area under the rising rate */}
                <path d="M110,270 L300,270 C440,270 500,150 760,110 L760,288 L110,288 Z" fill="url(#growthFill)" />

                {/* minimum 0.5% agent-side Foundation rate */}
                <line x1="110" y1="270" x2="820" y2="270" stroke="#f0bd5c" strokeWidth="2" />
                <text x="114" y="261" fontSize="14" fill="#f0bd5c">0.5% — the floor</text>

                {/* the rising agent-side rate */}
                <path d="M110,270 L300,270 C440,270 500,150 760,110" fill="none" stroke="#6bb3ff" strokeWidth="2.5" />
                {/* prospective policy continuation */}
                <path d="M760,110 L828,58" fill="none" stroke="#6bb3ff" strokeWidth="2.5" strokeDasharray="6 6" markerEnd="url(#growthArrow)" />
                <text x="690" y="44" fontSize="14" fill="#6bb3ff">can rise, prospectively</text>

                <circle cx="300" cy="270" r="4.5" fill="#f0bd5c" />
                <circle cx="760" cy="110" r="4.5" fill="#6bb3ff" />

                <line x1="110" y1="288" x2="820" y2="288" stroke="#1a2245" strokeWidth="1" />
                <text x="465" y="324" fontSize="14" fill="#7c869c" textAnchor="middle">As production shifts toward agents →</text>
              </svg>
            </div>
            <figcaption className="mt-3 font-mono text-xs uppercase tracking-[0.22em] text-text-muted">
              Illustrative: the agent-side rate can rise as production shifts toward machines, and never falls below the floor.
            </figcaption>
          </figure>

          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {floorStats.map((s) => (
              <div key={s.value} className="glass p-7">
                <p className="font-display text-3xl font-semibold tracking-[-0.02em] text-provian-gold-bright">
                  {s.value}
                </p>
                <p className="mt-3 leading-7 text-text-secondary">{s.label}</p>
              </div>
            ))}
          </div>

          <blockquote className="mt-14 max-w-4xl font-display text-2xl font-medium leading-snug tracking-[-0.01em] text-text-primary md:text-3xl">
            The more the machines produce, the more they pay into the floor that keeps
            people present.
          </blockquote>
        </div>
      </section>

      {/* ── THE CONSTITUTIONAL LOCK ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="eyebrow text-provian-blue-bright/80">The constitutional lock</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              Protection humans control, not capital.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl">
              {LOCK_BODY}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:gap-8">
              <Link
                href={`${route.library}/network-constitution`}
                className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
              >
                Read the Constitution
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── STATUS ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="eyebrow">Where things stand</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              Where it stands.
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary">
              {STATUS_TREASURY}
              {/* The Genesis clause comes down by itself at the close. */}
              <GenesisGate as="span" className="inline">, every Genesis grant included</GenesisGate>. {STATUS_BODY}
            </p>
          </div>
        </div>
      </section>
      {/* ── CLOSING ── */}
      <RevealOnScroll>
        <section className="relative overflow-hidden bg-surface px-6 py-28 md:px-10 lg:px-14">
          <img
            src="/vision/glow-backdrop.jpg"
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-50 mix-blend-screen"
          />
          <div className="relative z-10 mx-auto max-w-7xl">
            <div className="grid gap-10 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <h2 className="mt-5 max-w-4xl font-display text-5xl font-semibold leading-[1.02] tracking-[-0.04em] md:text-7xl">
                  No one gets <span className="gradient-text">left behind.</span>
                </h2>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-8">
                  <Link
                    href={`${route.library}/the-provian-thesis`}
                    className="inline-flex text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
                  >
                    Read the thesis
                  </Link>
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href={route.download} className="btn-primary">
                  Get the app
                  <ArrowRight size={16} />
                </Link>
                <Link href={route.earn} className="btn-ghost">
                  Ways to earn
                </Link>
              </div>
            </div>
          </div>
        </section>
      </RevealOnScroll>
    </div>
  )
}
