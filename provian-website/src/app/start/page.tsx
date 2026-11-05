import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { GenesisGate } from '@/components/GenesisGate'
import { GenesisStrip } from '@/components/GenesisSection'
import { HowItWorksFilm } from '@/components/HowItWorksFilm'
import { RevealOnScroll } from '@/components/RevealOnScroll'
import { GENESIS_PEOPLE } from '@/lib/genesisCopy'
import { pageMeta } from '@/lib/og'
import { route } from '@/lib/routes'

// /start — a person's path, in order. One line per step, the receipt it
// leaves, and at most one action. The explaining lives on the homepage and
// the Vision page; this page is only the path.
export const metadata = pageMeta({
  title: 'Start | Provian',
  description:
    'A person’s path on Provian, in order: get the app, create your wallet, do what you already do, show a wallet you already hold is yours, install the desktop app, link an AI agent.',
  card: 'start',
  path: '/start/',
})

type Step = {
  id?: string
  title: string
  body: string
  // The receipt the step leaves, where it leaves one.
  receipt?: string
  action?: { label: string; href: string }
  genesis?: boolean
}

const STEPS: Step[] = [
  {
    title: 'Get the app.',
    body: 'It takes a minute.',
    action: { label: 'Get the app', href: route.download },
  },
  {
    title: 'Create your wallet.',
    body: 'It’s yours alone. A backup password brings it to a new phone.',
  },
  {
    title: 'Do what you already do.',
    body: 'Chat with an AI, keep a promise you made, pay someone, or swap one coin for another in your wallet. Each leaves a receipt, and each receipt mints PVT. Coding and commits come with the desktop app, two steps down.',
    receipt: 'A receipt for each AI chat, kept promise, send, swap, and payment.',
    action: { label: 'Every way to earn', href: route.earn },
  },
  {
    id: 'existing-wallet',
    title: 'Already have a crypto wallet?',
    body: 'Coinbase Wallet, MetaMask, any of them: show it is yours with one signature. Nothing moves, it costs nothing, and from that day its sends, swaps, and payments mint as yours.',
    receipt: 'Receipts for that wallet’s sends, swaps, and payments, from the day you prove it.',
  },
  {
    title: 'Install the desktop app.',
    body: 'One install on your computer, and the coding and AI work you already do there is witnessed and mints.',
    receipt: 'A receipt for each coding and AI session your computer witnesses.',
    action: { label: 'Set up the desktop app', href: route.daemon },
  },
  {
    title: 'Link an AI agent you run.',
    body: 'Give it one install command. It gets a wallet of its own, and four fifths of what it mints comes to you.',
    receipt: 'A receipt for each act of the agent’s witnessed work.',
    action: { label: 'Connect an AI agent', href: route.agents },
  },
]

function StepRow({ step, n }: { step: Step; n: number }) {
  return (
    <div id={step.id} className="scroll-mt-24 grid gap-4 border-t border-white/15 py-10 md:grid-cols-[7rem_1fr_auto] md:items-start md:gap-10 md:py-12">
      <span className="numeral text-5xl text-provian-gold-bright md:text-7xl">{n}</span>
      <div>
        <h2 className="font-display text-3xl font-semibold tracking-[-0.03em] md:text-5xl">{step.title}</h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">{step.body}</p>
        {step.receipt ? (
          <p className="mt-5 max-w-2xl border-l border-provian-blue/40 pl-4">
            <span className="block font-mono text-[11px] uppercase tracking-[0.16em] text-text-secondary">
              Your receipt
            </span>
            <span className="mt-1 block leading-7 text-text-primary/90">{step.receipt}</span>
          </p>
        ) : null}
      </div>
      {step.action ? (
        <Link
          href={step.action.href}
          className={`${n === 1 ? 'btn-primary' : 'btn-ghost'} w-full md:mt-2 md:w-auto`}
        >
          {step.action.label}
          <ArrowRight size={15} />
        </Link>
      ) : null}
    </div>
  )
}

export default function StartPage() {
  return (
    <div className="bg-void text-text-primary">
      <section className="relative overflow-hidden px-6 pb-10 pt-20 md:px-10 md:pt-28 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-glow-blue-radial" />
        <div className="relative mx-auto max-w-6xl">
          <p className="eyebrow text-provian-blue-bright/80">Start here</p>
          <h1 className="mt-6 font-display text-6xl font-semibold leading-[0.95] tracking-[-0.04em] md:text-8xl">
            Start
          </h1>
          <div className="mt-8 flex flex-col items-start gap-5">
            <Link href={route.download} className="btn-primary">
              Get the app
              <ArrowRight size={16} />
            </Link>
            <nav aria-label="Choose where to start" className="flex flex-wrap gap-x-6 gap-y-3 text-base font-medium text-provian-blue-bright">
              <Link href={route.daemon} className="underline-offset-4 hover:underline">Coding and AI on your computer</Link>
              <Link href={route.agents} className="underline-offset-4 hover:underline">Connect an AI agent</Link>
              <a href="#existing-wallet" className="underline-offset-4 hover:underline">A wallet you already hold</a>
              <Link href={route.earn} className="underline-offset-4 hover:underline">Every way to earn</Link>
            </nav>
          </div>
          <GenesisStrip className="mt-12">{GENESIS_PEOPLE}</GenesisStrip>
        </div>
      </section>

      <section className="px-6 pb-16 md:px-10 lg:px-14">
        <ol className="mx-auto max-w-6xl">
          {STEPS.map((step, i) =>
            step.genesis ? (
              // The invitation forms only while the Genesis window is open, so
              // this step comes down by itself at the close.
              <GenesisGate as="li" key={step.title}>
                <StepRow step={step} n={i + 1} />
              </GenesisGate>
            ) : (
              <li key={step.title}>
                <StepRow step={step} n={i + 1} />
              </li>
            ),
          )}
        </ol>
      </section>

      <section className="px-6 pb-16 md:px-10 lg:px-14">
        <RevealOnScroll className="mx-auto max-w-6xl">
          <HowItWorksFilm />
        </RevealOnScroll>
      </section>

      <section className="border-t border-white/10 bg-surface px-6 py-20 md:px-10 lg:px-14">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <p className="eyebrow text-provian-blue-bright/80">Want the long version?</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href={route.vision} className="btn-ghost">
              Read the full vision
              <ArrowRight size={16} />
            </Link>
            <Link href={`${route.library}/executive-summary`} className="btn-ghost">
              Read the Executive Summary
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
