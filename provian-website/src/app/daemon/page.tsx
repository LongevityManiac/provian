import type { Metadata } from 'next'
import { Cpu, EyeOff, GitBranch, Sparkles, type LucideIcon } from 'lucide-react'
import {
  DAEMON_BETA,
  DAEMON_CUSTODY_POINTS,
  DAEMON_CUSTODY_SECTION,
  DAEMON_FORGE_NOTE,
  DAEMON_HERO,
  DAEMON_META,
  DAEMON_SETUP_SECTION,
  DAEMON_STEPS,
  DAEMON_WITNESSES,
  DAEMON_WITNESSES_SECTION,
  type DaemonWitnessIcon,
} from '@/content/daemon'

// ALL copy on this page lives in src/content/daemon.ts — the single source the
// public self-contained render (public/legal/daemon.html, via
// scripts/build-public-legal.mjs) is built from as well. Edit the copy THERE,
// then re-run `node scripts/build-public-legal.mjs`, so the two renderings
// cannot drift. This file owns presentation only.

export const metadata: Metadata = {
  title: DAEMON_META.title,
  description: DAEMON_META.description,
}

const WITNESS_ICONS: Record<DaemonWitnessIcon, LucideIcon> = {
  GitBranch,
  Sparkles,
  Cpu,
}

export default function DaemonPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── HERO ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 pb-16 pt-20 md:px-10 md:pb-20 md:pt-24 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
        <div className="relative z-10 mx-auto max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <p className="eyebrow text-provian-blue-bright/80">{DAEMON_HERO.eyebrow}</p>
              <h1 className="mt-6 font-display text-5xl font-semibold leading-[0.96] tracking-[-0.04em] md:text-8xl">
                {DAEMON_HERO.heading}
              </h1>
              <p className="mt-8 max-w-3xl text-lg leading-8 text-text-secondary md:text-2xl md:leading-10">
                {DAEMON_HERO.lede}
              </p>
            </div>

            <aside className="glass self-end p-7">
              <EyeOff className="text-provian-blue-bright" size={28} />
              <p className="mt-8 font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
                {DAEMON_HERO.aside}
              </p>
            </aside>
          </div>
        </div>
      </section>

      {/* ── WHAT IT WITNESSES ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="eyebrow">{DAEMON_WITNESSES_SECTION.eyebrow}</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              {DAEMON_WITNESSES_SECTION.heading}
            </h2>
          </div>

          <div className="mt-16 grid gap-px overflow-hidden rounded-xl bg-white/10 md:grid-cols-3">
            {DAEMON_WITNESSES.map(({ icon, title, body, aside }) => {
              const Icon = WITNESS_ICONS[icon]
              return (
                <article key={title} className="bg-surface p-8">
                  <Icon className="text-provian-gold-bright" size={26} />
                  <h3 className="mt-8 font-display text-2xl font-semibold tracking-[-0.02em]">
                    {title}
                  </h3>
                  <p className="mt-4 leading-7 text-text-secondary">{body}</p>
                  {aside && <p className="mt-4 text-sm italic leading-6 text-text-secondary">{aside}</p>}
                </article>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── SETUP ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="eyebrow text-provian-blue-bright/80">{DAEMON_SETUP_SECTION.eyebrow}</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              {DAEMON_SETUP_SECTION.heading}
            </h2>
            <p className="mt-7 max-w-3xl text-lg leading-8 text-text-secondary">
              {DAEMON_SETUP_SECTION.lede}
            </p>
          </div>

          <div className="mt-14 grid gap-5 md:grid-cols-2">
            {DAEMON_STEPS.map(({ n, title, body, cmd }) => (
              <article key={n} className="glass min-w-0 p-7">
                <span className="marker">{n}</span>
                <h3 className="mt-4 font-display text-2xl font-semibold tracking-[-0.02em]">
                  {title}
                </h3>
                <p className="mt-3 leading-7 text-text-secondary">{body}</p>
                {cmd && (
                  <pre className="mt-5 overflow-x-auto rounded-md border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm text-provian-blue-bright">
                    <code>{cmd}</code>
                  </pre>
                )}
              </article>
            ))}
          </div>

          <p className="mt-10 max-w-4xl leading-7 text-text-secondary">
            {DAEMON_FORGE_NOTE.before}{' '}
            <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-sm text-provian-blue-bright">
              {DAEMON_FORGE_NOTE.code}
            </code>{' '}
            {DAEMON_FORGE_NOTE.after}
          </p>
        </div>
      </section>

      {/* ── CUSTODY ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <p className="eyebrow">{DAEMON_CUSTODY_SECTION.eyebrow}</p>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-6xl">
              {DAEMON_CUSTODY_SECTION.heading}
            </h2>
          </div>

          <div className="glass p-8">
            <ul className="space-y-5">
              {DAEMON_CUSTODY_POINTS.map((item) => (
                <li key={item} className="flex gap-3 text-text-secondary">
                  <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-provian-blue" />
                  <span className="leading-7">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── BETA ── */}
      <section className="px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <div className="glass relative overflow-hidden p-10 md:p-14">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-glow-amber-radial" />
            <p className="eyebrow">{DAEMON_BETA.eyebrow}</p>
            <h2 className="mt-5 max-w-3xl font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
              {DAEMON_BETA.heading}
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
              {DAEMON_BETA.body.before}{' '}
              <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-sm text-provian-blue-bright">
                {DAEMON_BETA.body.code}
              </code>{' '}
              {DAEMON_BETA.body.after}
            </p>
            <a
              href={DAEMON_BETA.mailtoHref}
              className="mt-7 inline-block font-mono text-lg font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
            >
              {DAEMON_BETA.mailtoLabel}
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
