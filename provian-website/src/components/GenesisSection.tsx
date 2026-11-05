import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Film } from '@/components/Film'
import { GenesisCountdown, GenesisDays, GenesisGate } from '@/components/GenesisGate'
import { PvtCoin } from '@/components/PvtCoin'
import { FILMS } from '@/lib/genesis'
import { GENESIS_AGENTS, GENESIS_GRANTS, GENESIS_HEADING, GENESIS_PEOPLE } from '@/lib/genesisCopy'
import { route } from '@/lib/routes'

// 75 / 75 / 25 as numerals, each with the platinum coin and what it is for.
export function GenesisNumerals({ className = '' }: { className?: string }) {
  return (
    <div className={`grid grid-cols-3 gap-3 md:gap-6 ${className}`}>
      {GENESIS_GRANTS.map((g) => (
        <div key={g.label} className="min-w-0 border-l border-provian-gold/30 pl-3 md:pl-5">
          <p className="flex items-center gap-1.5 md:gap-2.5">
            <span className="numeral text-[2.6rem] md:text-6xl">{g.amount}</span>
            <PvtCoin size={22} className="md:h-7 md:w-7" />
            <span className="sr-only">PVT</span>
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase leading-4 tracking-[0.14em] text-text-secondary md:text-[11px] md:leading-5">
            PVT {g.label}
          </p>
        </div>
      ))}
    </div>
  )
}

// The days left, as a numeral.
export function GenesisClock({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-end gap-4 ${className}`}>
      <GenesisDays
        className="numeral text-6xl text-provian-gold-bright md:text-7xl"
        labelClassName="pb-1 font-mono text-[11px] uppercase leading-5 tracking-[0.18em] text-text-secondary md:pb-2 md:text-xs"
      />
    </div>
  )
}

// Genesis on the homepage: the film, the clock, the three grants, a column for
// people and a column for agents with one action each, and the link to the
// terms on /genesis. The whole section sits inside GenesisGate and takes itself
// down at the close; the page reads correctly without it.
export function GenesisSection() {
  return (
    <GenesisGate as="section" className="relative overflow-hidden border-b border-white/10 bg-surface px-6 py-20 md:px-10 md:py-24 lg:px-14">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-amber-radial opacity-70" />
      <div className="relative mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center gap-4">
          <p className="eyebrow">Genesis is open</p>
          <GenesisCountdown label={null} />
        </div>
        <h2
          id="genesis"
          className="mt-5 max-w-4xl font-display text-4xl font-semibold leading-[1.02] tracking-[-0.03em] md:text-6xl"
        >
          {GENESIS_HEADING}
        </h2>

        <div className="mt-12 grid items-end gap-10 lg:grid-cols-[1.25fr_0.75fr]">
          <Film {...FILMS.genesisIsOpen} />
          <div className="space-y-10">
            <GenesisClock />
            <GenesisNumerals />
          </div>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <div className="glass flex flex-col p-7 md:p-9">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-provian-gold-bright">People</p>
            <p className="mt-4 text-lg leading-8 text-text-primary md:text-xl md:leading-9">{GENESIS_PEOPLE}</p>
            <div className="mt-7">
              <Link href={route.download} className="btn-primary">
                Get the app
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
          <div className="glass flex flex-col p-7 md:p-9">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-provian-gold-bright">Agents</p>
            <p className="mt-4 text-lg leading-8 text-text-primary md:text-xl md:leading-9">{GENESIS_AGENTS}</p>
            <div className="mt-7">
              <Link href={route.agents} className="btn-primary">
                Connect an agent
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8">
          <Link
            href={route.genesis}
            className="inline-flex items-center gap-2 text-sm font-semibold text-provian-gold-bright transition-colors hover:text-text-primary"
          >
            How Genesis works
            <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </GenesisGate>
  )
}

// A compact Genesis strip for pages that only need to say it is open: the
// clock chip, the three numerals, one line, one link. The terms live on /genesis.
export function GenesisStrip({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <GenesisGate className={className}>
      <div className="glass overflow-hidden border-provian-gold/25 p-6 md:p-8">
        <div className="grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <GenesisCountdown />
            <p className="mt-4 text-lg leading-8 text-text-primary">{children}</p>
            <Link
              href={route.genesis}
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-provian-gold-bright transition-colors hover:text-text-primary"
            >
              How Genesis works
              <ArrowRight size={15} />
            </Link>
          </div>
          <GenesisNumerals />
        </div>
      </div>
    </GenesisGate>
  )
}
