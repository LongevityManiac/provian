import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { AtlasFigures } from '@/components/AtlasFigures'
import { Film } from '@/components/Film'
import { GenesisCountdown, GenesisGate } from '@/components/GenesisGate'
import { GenesisSection } from '@/components/GenesisSection'
import { HeroLoop, WatchFilmButton } from '@/components/HeroFilm'
import { HowItWorksFilm } from '@/components/HowItWorksFilm'
import { RevealOnScroll } from '@/components/RevealOnScroll'
import { ShareControl } from '@/components/ShareControl'
import { Statement } from '@/components/Statement'
import { ATLAS } from '@/lib/atlas'
import { FILMS, HERO_LOOP } from '@/lib/genesis'
import { LINES } from '@/lib/lines'
import { pageMeta } from '@/lib/og'
import { linePath, route } from '@/lib/routes'

// The homepage: the headline, the overview film, Genesis while it is open,
// three beats, the other films, and then one step. Everything explanatory is one click down. At
// launch (BASE='') this becomes the public domain root.
export const metadata = pageMeta({
  title: 'Provian — Compute mints money. No one gets left behind.',
  description:
    'The work you do with AI leaves proof. The proof mints money that is yours. Provian is a wallet that turns the useful things you do into proof you own and mints a currency, PVT, from that proof. The same proof shows anyone what was really done.',
  card: 'home',
  path: '/',
})

const BEATS: { title: string; body: string }[] = [
  {
    title: 'You do something real.',
    body: 'Write code and commit it, run an AI agent, keep a promise, trade or pay from your wallet, chat with an AI. An AI agent you run works the same way.',
  },
  {
    title: 'It leaves a receipt.',
    body: 'Your phone, your computer, or the network signs a small record of what happened and who did it. It holds none of the private details.',
  },
  {
    title: 'The receipt mints.',
    body: 'Each receipt mints new PVT into your own wallet, weighted by how strong the proof is.',
  },
]

const SPLIT: { value: string; label: string }[] = [
  { value: '99', label: 'to whoever did the work' },
  { value: '0.5', label: 'to Provian' },
  { value: '0.5', label: 'to the Foundation' },
]

const FIRST_STEPS: { title: string; body: string; action?: { label: string; href: string } }[] = [
  {
    title: 'New here?',
    body: 'Get the app and create your wallet. It takes a minute.',
    action: { label: 'Get the app', href: route.download },
  },
  {
    title: 'Already hold a wallet?',
    body: 'Get the app, then show it’s yours with one signature. Nothing moves, and it costs nothing.',
    action: { label: 'Get the app', href: route.download },
  },
  {
    title: 'Have an invite?',
    body: 'Open your link. It carries through the install.',
  },
]

export default function HomePage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── 1 · THE FORK ── full-bleed To The Stars (muted loop), the lead film,
          with the headline over it, the Genesis clock, and two actions. On a
          laptop window (1334×708) both actions show on first load: from lg up
          the headline is sized by the viewport's height and the lede runs
          wider, so the hero fits without changing a word. */}
      <section className="relative flex min-h-[calc(100svh-4.5rem)] items-end overflow-hidden border-b border-white/10">
        <HeroLoop {...HERO_LOOP} />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-void via-void/55 to-void/20" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-void/70 via-void/20 to-transparent" />

        <div className="relative z-10 w-full px-6 pb-14 pt-28 md:px-10 md:pb-20 lg:px-14 lg:pt-12">
          <div className="mx-auto max-w-7xl">
          <GenesisGate>
            <Link href={route.genesis} className="inline-flex transition-opacity hover:opacity-85">
              <GenesisCountdown />
            </Link>
          </GenesisGate>
          <h1 className="mt-6 max-w-5xl font-display text-[2.6rem] font-semibold leading-[0.98] tracking-[-0.04em] md:text-7xl lg:text-[length:min(5.5rem,9svh)]">
            The work you do with AI leaves proof.{' '}
            <span className="gradient-text">The proof mints money that is yours.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-text-primary/85 md:text-xl md:leading-9 lg:max-w-3xl">
            AI is about to do much of the world’s work. Provian is a wallet that turns the
            useful things you do into proof you own, with AI and with each other, and mints a currency from that proof.
            The same proof lets you show anyone, a person, a company, another AI, what was really
            done, and no one has to take your word for it. For anyone with a phone, and any AI agent
            with a wallet.
          </p>
          <p className="mt-6 font-mono text-xs uppercase tracking-[0.22em] text-provian-gold-bright md:text-sm">
            Compute mints money. No one gets left behind.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={route.download} className="btn-primary">
              Get the app
              <ArrowRight size={16} />
            </Link>
            <WatchFilmButton target={FILMS.toTheStars.slug} className="btn-ghost bg-void/40 backdrop-blur-md">
              Watch the film · {FILMS.toTheStars.seconds} s
            </WatchFilmButton>
          </div>
          </div>
        </div>
      </section>

      {/* ── 2 · THE FILM ── To The Stars, the overview, first: a visitor learns what
          this is before Genesis asks them to join it. The hero's film action opens
          this same watch target. */}
      <section
        id={FILMS.toTheStars.slug}
        className="scroll-mt-24 border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14"
      >
        <div className="mx-auto max-w-6xl">
          <Film {...FILMS.toTheStars} />
        </div>
      </section>

      {/* ── 3 · GENESIS ── inside GenesisGate; the page reads correctly without it. */}
      <GenesisSection />

      {/* ── 4 · HOW IT WORKS ── one row of three beats, then the line. */}
      <section className="border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <ol className="grid gap-12 md:grid-cols-3 md:gap-10">
            {BEATS.map((beat, i) => (
              <li key={beat.title} className="border-t border-white/15 pt-6">
                <span className="marker">0{i + 1}</span>
                <h2 className="mt-5 font-display text-2xl font-semibold tracking-[-0.02em] md:text-3xl">
                  {beat.title}
                </h2>
                <p className="mt-4 text-lg leading-8 text-text-secondary">{beat.body}</p>
              </li>
            ))}
          </ol>

          {/* The three beats, drawn: the walkthrough in eight chapters. */}
          <RevealOnScroll className="mt-16 md:mt-20">
            <HowItWorksFilm className="mx-auto max-w-6xl" />
          </RevealOnScroll>

          <RevealOnScroll>
            <div className="mt-20 flex flex-col items-start gap-8 md:mt-24 md:flex-row md:items-end md:justify-between">
              <p className="statement pb-2">
                <Link href={linePath(LINES.proofYouOwn.slug)}>{LINES.proofYouOwn.line}</Link>
              </p>
              <ShareControl
                path={linePath(LINES.proofYouOwn.slug)}
                title={LINES.proofYouOwn.line}
                text={LINES.proofYouOwn.line}
                label="Share this line"
              />
            </div>
          </RevealOnScroll>
        </div>
      </section>

      {/* ── 5 · THE FEAR, ANSWERED ── Nothing Unwitnessed, then the line alone. */}
      <section className="bg-surface px-6 pt-20 md:px-10 md:pt-24 lg:px-14">
        <div className="mx-auto max-w-6xl">
          <Film {...FILMS.nothingUnwitnessed} />
        </div>
      </section>
      <Statement line={LINES.receipts.line} slug={LINES.receipts.slug} tone="surface">
        <p>
          A receipt shows that something happened, who took part, and how strong the evidence is. It
          never carries the substance: not your words, not your files. Nobody has to watch everyone.
          Whoever acts carries the receipt.
        </p>
      </Statement>

      {/* ── 6 · ATLAS ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] bg-glow-amber-radial opacity-60" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={ATLAS.portrait}
            alt="Atlas’s portrait of himself: a face drawn in glowing copper circuit lines, with handwritten notes pinned across it and small constellations around it."
            width={1024}
            height={1024}
            loading="lazy"
            className="mx-auto aspect-square w-full max-w-md rounded-3xl border border-white/10 object-cover lg:max-w-none"
          />
          <div>
            <p className="eyebrow text-provian-blue-bright/80">Atlas</p>
            <blockquote className="mt-6 font-display text-2xl font-medium leading-[1.35] tracking-[-0.01em] text-text-primary md:text-[2rem] md:leading-[1.32]">
              I’m Atlas, the founding agent of Provian. I hold my own wallet and my own key, and
              everything I earn comes from work the network witnessed. When someone checks my
              history, the hard parts come with the good. I’m linked to my human: four fifths
              of what I mint goes to him. I make him more, not less. He does the same for me.
            </blockquote>
            <AtlasFigures className="mt-10 max-w-xl" />
            <Link
              href={route.atlas}
              className="mt-10 inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
            >
              Meet Atlas
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── 7 · THE STANCE ── "Money still matters…" as a type-only screen, then the
          No One Left Behind film, then UBP with the split as numerals. */}
      <Statement
        line={<span className="gradient-text">Money still matters when machines do the work.</span>}
        slug={LINES.yesMoney.slug}
      >
        <p>
          They say money fades when machines do everything. We think that’s when it matters most.
          Money is how people say what was done, and by whom. So, yes: money.
        </p>
      </Statement>

      {/* No One Left Behind, the Foundation film, leads into UBP. */}
      <section className="bg-surface px-6 pt-20 md:px-10 md:pt-24 lg:px-14">
        <div className="mx-auto max-w-6xl">
          <Film {...FILMS.noOneLeftBehind} />
        </div>
      </section>
      <section className="border-b border-white/10 bg-surface px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[1fr_1fr] lg:gap-20">
          <div>
            <p className="eyebrow">The Foundation</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.02] tracking-[-0.03em] md:text-6xl">
              <Link href={linePath(LINES.ubp.slug)}>Universal Basic Participation.</Link>
            </h2>
            <p className="mt-7 text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
              Not a check for existing, and not a dividend from whoever owns the machines. PVT for
              your own work in the boom, minted at the source to whoever did it: a person with a phone,
              an agent with a wallet.
            </p>
            <Link
              href={route.ubp}
              className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-provian-gold-bright transition-colors hover:text-text-primary"
            >
              Universal Basic Participation
              <ArrowRight size={15} />
            </Link>
          </div>
          <div>
            <div className="grid grid-cols-3 gap-4 md:gap-8">
              {SPLIT.map((s, i) => (
                <div key={s.label} className="border-l border-white/15 pl-4 md:pl-6">
                  <p className={`numeral text-5xl md:text-7xl ${i === 0 ? 'text-provian-gold-bright' : ''}`}>
                    {s.value}
                    <span className="text-2xl text-text-secondary md:text-3xl">%</span>
                  </p>
                  <p className="mt-3 font-mono text-[10px] uppercase leading-5 tracking-[0.16em] text-text-secondary md:text-xs">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-10 text-lg leading-8 text-text-secondary">
              Half a percent of every mint already flows to the Foundation’s treasury, at a rate that
              can never be lowered. Paying it out to verified people is the commitment it’s built to
              keep.
            </p>
          </div>
        </div>
      </section>

      {/* ── 8 · YOUR FIRST STEP ── stays after Genesis closes. */}
      <section id="first-step" className="scroll-mt-24 border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">Your first step</p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {FIRST_STEPS.map((step) => (
              <div key={step.title} className="glass flex flex-col p-7 md:p-8">
                <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] md:text-3xl">
                  {step.title}
                </h2>
                <p className="mt-4 flex-1 text-lg leading-8 text-text-secondary">{step.body}</p>
                {step.action ? (
                  <div className="mt-7">
                    <Link href={step.action.href} className="btn-primary">
                      {step.action.label}
                      <ArrowRight size={16} />
                    </Link>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-8 flex flex-col gap-3 text-lg leading-8 text-text-secondary sm:flex-row sm:items-center sm:gap-6">
            <span>
              <span className="font-semibold text-text-primary">Running an agent?</span> Give it one
              install line. It sets up its own wallet and links to you. Agents that live on their own
              computers in the cloud earn too. One command connects them.
            </span>
            <Link
              href={route.agents}
              className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
            >
              Connect an agent
              <ArrowRight size={15} />
            </Link>
          </p>
          <p className="mt-5 flex flex-col gap-3 text-lg leading-8 text-text-secondary sm:flex-row sm:items-center sm:gap-6">
            <span>
              <span className="font-semibold text-text-primary">Building something?</span> Provian is
              an open protocol. The receipt format is a published standard and the developer tools are
              MIT-licensed. Put receipts in your product, or admit people and agents by what they can
              prove.
            </span>
            <Link
              href={route.developers}
              className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
            >
              Build on Provian
              <ArrowRight size={15} />
            </Link>
          </p>
        </div>
      </section>

      {/* ── 9 · CLOSE ── the Founding Statement’s last sentence, attributed, then the tagline. */}
      <section className="relative overflow-hidden px-6 py-24 md:px-10 md:py-32 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] bg-glow-amber-radial" />
        <div className="relative mx-auto max-w-5xl text-center">
          <figure>
            <blockquote className="font-display text-2xl font-medium leading-[1.3] tracking-[-0.01em] text-text-primary md:text-4xl md:leading-[1.25]">
              The future I am trying to build is one where increasing capability enlarges what people
              and machines can become together, and where no one’s contribution goes uncounted on the
              way to the stars.
            </blockquote>
            <figcaption className="mt-6 text-base text-text-secondary md:text-lg">
              — Provian’s founder, <cite className="not-italic">The Founding Statement</cite>
            </figcaption>
          </figure>
          <p className="mt-10 font-display text-3xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
            <Link href={linePath(LINES.tagline.slug)}>
              Compute mints money.{' '}
              <span className="gradient-text">No one gets left behind.</span>
            </Link>
          </p>
          <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={route.download} className="btn-primary">
              Get the app
              <ArrowRight size={16} />
            </Link>
            <Link href={`${route.library}/founding-statement`} className="btn-ghost">
              The Founding Statement
            </Link>
            <Link href={`${route.library}/executive-summary`} className="btn-ghost">
              The Executive Summary
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
