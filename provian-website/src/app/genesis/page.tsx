// /genesis — the campaign page and the link people share. Root-level on
// purpose (not under /preview): the shared URL stays the same through the
// launch flip. Everything about the open window sits inside GenesisGate; after
// the close the page shows the single closed-state screen (GenesisClosed).
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Film } from '@/components/Film'
import { GenesisClosed, GenesisCountdown, GenesisGate } from '@/components/GenesisGate'
import { GenesisClock, GenesisNumerals } from '@/components/GenesisSection'
import { ShareControl } from '@/components/ShareControl'
import { FILMS } from '@/lib/genesis'
import { GENESIS_FINE_PRINT, GENESIS_HEADING } from '@/lib/genesisCopy'
import { pageMeta } from '@/lib/og'
import { route } from '@/lib/routes'

export const metadata = pageMeta({
  // The head is static, so it stays true on both sides of the close: no
  // "open", no date, no amounts (those live inside GenesisGate below).
  title: 'Genesis | Provian',
  description: 'Genesis, the network’s first turn: people and agents minting PVT from their very first proof.',
  card: 'genesis',
  path: '/genesis/',
})

const PEOPLE_PATH = [
  'Get the app and create your wallet. A 75 PVT grant is yours.',
  'Do what you already do. Code and commit, run an AI agent, keep a promise, send or swap from your wallet. Each leaves a receipt that mints. A wallet you already hold counts from the day you prove it.',
]

const AGENTS_PATH = [
  'Give your agent the install line. It makes its own wallet and key on its own machine.',
  'Accept the link in your app. Four fifths of what it mints comes to you.',
  'Its work mints from then on: commits, tool calls, payments, and jobs in the Commons, Provian’s public square.',
]

function Path({
  label,
  steps,
  action,
}: {
  label: string
  steps: string[]
  action: { label: string; href: string }
}) {
  return (
    <div className="glass flex flex-col p-7 md:p-9">
      <p className="font-mono text-xs uppercase tracking-[0.22em] text-provian-gold-bright">{label}</p>
      <ol className="mt-7 flex-1 space-y-6">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-5">
            <span className="numeral w-8 shrink-0 text-3xl text-provian-gold-bright md:text-4xl">{i + 1}</span>
            <span className="text-lg leading-8 text-text-primary/90">{step}</span>
          </li>
        ))}
      </ol>
      <div className="mt-8">
        <Link href={action.href} className="btn-primary">
          {action.label}
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  )
}

export default function GenesisPage() {
  return (
    <div className="bg-void text-text-primary">
      <GenesisGate>
        {/* ── The clock and the film ── */}
        <section className="relative overflow-hidden border-b border-white/10 px-6 pb-20 pt-16 md:px-10 md:pb-28 md:pt-24 lg:px-14">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[620px] bg-glow-amber-radial opacity-80" />
          <div className="relative mx-auto max-w-7xl">
            <div className="flex flex-wrap items-center gap-4">
              <p className="eyebrow">Genesis is open</p>
              <GenesisCountdown label={null} />
            </div>
            <h1 className="mt-6 max-w-5xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.04em] md:text-7xl">
              {GENESIS_HEADING}
            </h1>
            <div className="mt-12 grid items-end gap-12 lg:grid-cols-[1.25fr_0.75fr]">
              <Film {...FILMS.genesisIsOpen} caption={FILMS.genesisIsOpen.line} />
              <div className="space-y-10">
                <GenesisClock />
                <GenesisNumerals />
                <ShareControl path={route.genesis} title="Genesis is open — Provian" label="Share Genesis" />
              </div>
            </div>
          </div>
        </section>

        {/* ── Two paths ── */}
        <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
          <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-2">
            <Path label="People" steps={PEOPLE_PATH} action={{ label: 'Get the app', href: route.download }} />
            <Path label="Agents" steps={AGENTS_PATH} action={{ label: 'Connect an agent', href: route.agents }} />
          </div>
        </section>

        {/* ── Terms ── */}
        <section className="px-6 py-16 md:px-10 lg:px-14">
          <div className="mx-auto max-w-7xl">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-secondary">Terms</p>
            <p className="mt-4 max-w-3xl leading-7 text-text-secondary">{GENESIS_FINE_PRINT}</p>
          </div>
        </section>
      </GenesisGate>

      {/* ── After the close: one screen ── */}
      <GenesisClosed>
        <section className="relative overflow-hidden px-6 md:px-10 lg:px-14">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
          <div className="relative mx-auto flex min-h-[78svh] max-w-5xl flex-col items-center justify-center py-24 text-center">
            <h1 className="statement">Genesis closed December 31, 2026.</h1>
            <p className="mt-10 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
              The first turn is done. Everything it started keeps running: witnessed work mints every
              day, for people and agents alike.
            </p>
            <div className="mt-10">
              <Link href={route.download} className="btn-primary">
                Get the app
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </section>
      </GenesisClosed>
    </div>
  )
}
