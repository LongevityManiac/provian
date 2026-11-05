'use client'

import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowRight,
  Bot,
  CircleDollarSign,
  GitCommitHorizontal,
  Mail,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react'
import { useGenesisOpen } from '@/components/GenesisGate'
import { PvtCoin } from '@/components/PvtCoin'

// How it works, as a short animated walkthrough in eight chapters (about
// 1:49). Drawn natively, not a video: every element's state is a function of
// one playhead (the chapter and the milliseconds into it), and CSS only eases
// between states (.hiw-* in globals.css). That one rule gives the rest:
//  - Before it first plays (and with no JavaScript) the stage shows chapter 1
//    finished, like a poster.
//  - With prefers-reduced-motion nothing animates; every chapter shows in its
//    final state and the chapter buttons move between them.
//  - It plays when scrolled into view and pauses when scrolled out, like the
//    hero loop; a visitor's own pause sticks.
// Chapter 7 is a Genesis surface: it comes out of the timeline at the window
// close, by the same clock as every other Genesis block (GenesisGate).

type Scene = (props: { t: number }) => ReactNode

type Chapter = {
  label: string
  ms: number
  kicker?: string
  headline?: string
  caption: string
  genesis?: boolean
  Scene: Scene
}

// The state of one element at the playhead: shown once the playhead passes
// `at` (milliseconds into the chapter).
const on = (t: number, at: number) => t >= at

// Text typed in from `at`. The untyped rest holds its space, so nothing
// around it moves while it types.
function Typed({ text, t, at, msPerChar = 28 }: { text: string; t: number; at: number; msPerChar?: number }) {
  const n = Math.max(0, Math.floor((t - at) / msPerChar))
  if (n >= text.length) return <>{text}</>
  return (
    <>
      {text.slice(0, n)}
      <span className="invisible">{text.slice(n)}</span>
    </>
  )
}

function Arrow({ t, at, className = '' }: { t: number; at: number; className?: string }) {
  return (
    <span className="hiw-in flex shrink-0 justify-center text-provian-blue-bright/70" data-on={on(t, at)}>
      <ArrowRight className={`h-[1.5em] w-[1.5em] ${className}`} strokeWidth={1.6} />
    </span>
  )
}

// A small receipt: two text lines and a hash, the shape every chapter reuses.
function MiniReceipt({ hash, className = '' }: { hash?: string; className?: string }) {
  return (
    <span
      className={`flex flex-col gap-[0.35em] rounded-[0.5em] border border-white/20 bg-surface-raised px-[0.7em] py-[0.6em] ${className}`}
    >
      <span className="h-[0.28em] w-3/4 rounded-full bg-white/25" />
      <span className="h-[0.28em] w-1/2 rounded-full bg-white/15" />
      {hash ? (
        <span className="mt-[0.15em] whitespace-nowrap font-mono text-[0.68em] text-text-secondary">{hash}</span>
      ) : null}
    </span>
  )
}

// ── 1 · Your work ────────────────────────────────────────────────────────

const ACTS: { label: string; detail: string; Icon: typeof Activity }[] = [
  { label: 'AI chat', detail: '41 turns', Icon: MessageSquare },
  { label: 'Code', detail: 'commit a3f9c1e', Icon: GitCommitHorizontal },
  { label: 'Payment', detail: 'USDC · Base', Icon: CircleDollarSign },
  { label: 'Agent task', detail: 'web_fetch', Icon: Bot },
  { label: 'Sensor', detail: '1 reading/s', Icon: Activity },
]

const YourWork: Scene = ({ t }) => (
  <div className="flex w-full flex-col items-center gap-[1.4em]">
    <ul className="grid w-full grid-cols-2 gap-[0.7em] sm:grid-cols-5 sm:gap-[0.9em]">
      {ACTS.map(({ label, detail, Icon }, i) => (
        <li
          key={label}
          className={`hiw-in flex flex-col rounded-[0.7em] border border-white/15 bg-white/[0.04] p-[0.8em] sm:p-[1em] ${
            i === ACTS.length - 1 ? 'col-span-2 sm:col-span-1' : ''
          }`}
          data-on={on(t, 600 + i * 1200)}
        >
          <span className="flex items-center gap-[0.45em]">
            <Icon className="h-[1.2em] w-[1.2em] shrink-0 text-provian-blue-bright" strokeWidth={1.8} />
            <span className="font-semibold leading-tight">{label}</span>
          </span>
          <span className="sr-only"> · </span>
          <span className="mt-[0.35em] font-mono text-[0.8em] leading-snug text-text-secondary">{detail}</span>
          <span className="mt-[0.7em] border-t border-white/10 pt-[0.55em]">
            <span
              className="hiw-pop inline-flex items-center gap-[0.35em] rounded-full border border-provian-gold/45 bg-provian-gold/10 px-[0.6em] py-[0.18em] font-mono text-[0.66em] tracking-[0.16em] text-provian-gold-bright"
              data-on={on(t, 7000 + i * 350)}
            >
              <Mail className="h-[1.15em] w-[1.15em]" strokeWidth={2} />
              SEALED
            </span>
          </span>
        </li>
      ))}
    </ul>
    <p className="hiw-in font-mono text-[0.9em] tracking-[0.08em] text-text-primary/90" data-on={on(t, 9200)}>
      5 acts → 5 receipts
    </p>
  </div>
)

// ── 2 · Sealed ───────────────────────────────────────────────────────────

const RECEIPT_ROWS: [string, string][] = [
  ['action_type', 'ai_conversation'],
  ['witness_class', 'device_tier'],
  ['input_origins', 'arxiv.org · npmjs.com'],
  ['prev_hash', '0x8e1a…c42f'],
  ['signature', '0x3b7d…91e0'],
]

function DashedLink({ t, at, className = '' }: { t: number; at: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`hiw-in shrink-0 border-dashed border-provian-blue-bright/50 ${className}`}
      data-on={on(t, at)}
    />
  )
}

const Sealed: Scene = ({ t }) => (
  <div className="flex w-full flex-col items-center sm:flex-row sm:justify-center">
    <div className="flex items-center">
      <span className="hiw-in" data-on={on(t, 400)}>
        <MiniReceipt hash="0x51c0…77ab" className="opacity-50" />
      </span>
      <DashedLink t={t} at={700} className="w-[1.6em] border-t-2 sm:w-[2em]" />
      <span className="hiw-in" data-on={on(t, 1000)}>
        <MiniReceipt hash="0x8e1a…c42f" className="opacity-50" />
      </span>
    </div>
    <DashedLink t={t} at={1300} className="h-[1.4em] border-l-2 sm:h-0 sm:w-[2em] sm:border-l-0 sm:border-t-2" />
    <div
      className="hiw-in relative w-full max-w-[26em] rounded-[0.8em] border border-white/15 bg-surface-raised/90 p-[1em] shadow-glow-soft sm:p-[1.2em]"
      data-on={on(t, 1600)}
    >
      <p className="border-b border-white/10 pb-[0.6em] font-mono text-[0.7em] tracking-[0.18em] text-provian-gold-bright">
        RECEIPT · PROVENANCE ENVELOPE
      </p>
      <dl className="mt-[0.6em] space-y-[0.45em] font-mono">
        {RECEIPT_ROWS.map(([key, value], i) => (
          <div
            key={key}
            className="hiw-in flex items-baseline justify-between gap-[1em]"
            data-on={on(t, 2400 + i * 1100)}
          >
            <dt className="text-[0.74em] text-text-secondary">{key}</dt>
            <dd className="whitespace-nowrap text-right text-[0.84em] text-text-primary">
              <Typed text={value} t={t} at={2600 + i * 1100} />
            </dd>
          </div>
        ))}
      </dl>
      <p
        className="hiw-in mt-[0.8em] border-t border-white/10 pt-[0.6em] text-[0.82em] text-text-secondary"
        data-on={on(t, 7900)}
      >
        The content never leaves your device.
      </p>
      <span
        className="hiw-stamp absolute -bottom-[0.9em] right-[0.6em] rounded-[0.3em] border-2 border-provian-gold-bright px-[0.6em] py-[0.15em] font-mono text-[1em] font-semibold tracking-[0.22em] text-provian-gold-bright shadow-glow-amber backdrop-blur-sm sm:right-[1em]"
        data-on={on(t, 9100)}
      >
        SEALED
      </span>
    </div>
  </div>
)

// ── 3 · Minted ───────────────────────────────────────────────────────────

const SPLIT_LEGEND: { text: string; swatch: string }[] = [
  { text: '99% to whoever did the work', swatch: 'bg-provian-blue' },
  { text: '0.5% Provian', swatch: 'bg-platinum' },
  { text: '0.5% the Foundation', swatch: 'bg-provian-gold' },
]

const Minted: Scene = ({ t }) => (
  <div className="flex w-full flex-col items-center gap-[2em]">
    <div className="flex items-center justify-center gap-[0.6em] sm:gap-[1.2em]">
      <span className="hiw-in" data-on={on(t, 400)}>
        <MiniReceipt className="w-[4.6em]" />
      </span>
      <Arrow t={t} at={1000} />
      <span className="hiw-pop relative flex h-[6em] w-[6em] items-center justify-center" data-on={on(t, 1400)}>
        <svg viewBox="0 0 100 100" className="hiw-spin absolute inset-0 h-full w-full" aria-hidden>
          <circle cx="50" cy="50" r="45" fill="none" stroke="#f0bd5c" strokeWidth="3" strokeDasharray="7 6" />
        </svg>
        <span className="absolute inset-[0.7em] rounded-full border border-provian-blue/40 bg-provian-blue/10" />
        <span className="relative font-mono text-[0.85em] font-semibold tracking-[0.24em] text-provian-gold-bright">
          MINT
        </span>
      </span>
      <Arrow t={t} at={2200} />
      <span className="flex items-center gap-[0.25em]">
        {[0, 1, 2].map((i) => (
          <span key={i} className="hiw-pop" data-on={on(t, 2600 + i * 300)}>
            <PvtCoin size={40} className="h-[2.2em] w-[2.2em]" />
          </span>
        ))}
      </span>
    </div>
    <div className="w-full max-w-[40em]">
      <div className="hiw-grow flex h-[0.9em] w-full gap-[2px] overflow-hidden rounded-full" data-on={on(t, 4600)}>
        <span className="basis-0 bg-provian-blue" style={{ flexGrow: 99 }} />
        <span className="min-w-[0.35em] basis-0 bg-platinum" style={{ flexGrow: 0.5 }} />
        <span className="min-w-[0.35em] basis-0 bg-provian-gold" style={{ flexGrow: 0.5 }} />
      </div>
      <p
        className="hiw-in mt-[0.9em] text-center font-mono text-[0.76em] leading-relaxed text-text-secondary"
        data-on={on(t, 5900)}
      >
        {SPLIT_LEGEND.map((part, i) => (
          <Fragment key={part.text}>
            {i > 0 ? ' · ' : null}
            <span className="whitespace-nowrap">
              <span aria-hidden className={`mr-[0.4em] inline-block h-[0.6em] w-[0.6em] rounded-full ${part.swatch}`} />
              {part.text}
            </span>
          </Fragment>
        ))}
      </p>
    </div>
  </div>
)

// ── 4 · Evidence ─────────────────────────────────────────────────────────

const EVIDENCE: { label: string; value: string; width: string }[] = [
  { label: 'No independent source', value: '1.0×', width: '50%' },
  { label: '1 independent source', value: '1.5×', width: '75%' },
  { label: '2 independent sources', value: '2.0×', width: '100%' },
]

const Evidence: Scene = ({ t }) => (
  <div className="w-full max-w-[44em]">
    <ul className="space-y-[1.1em]">
      {EVIDENCE.map((row, i) => (
        <li
          key={row.label}
          className="hiw-in grid grid-cols-[1fr_auto] items-center gap-x-[1em] gap-y-[0.4em] sm:grid-cols-[11em_1fr_auto]"
          data-on={on(t, 700 + i * 2000)}
        >
          <span className="col-span-2 text-[0.95em] text-text-primary/90 sm:col-span-1">{row.label}</span>
          <span className="h-[1.1em] rounded-full bg-white/[0.06]">
            <span
              className="hiw-grow block h-full rounded-full bg-ascent-h"
              style={{ width: row.width }}
              data-on={on(t, 900 + i * 2000)}
            />
          </span>
          <span
            className="hiw-in w-[3.2em] text-right font-mono text-[1.15em] font-medium text-provian-gold-bright"
            data-on={on(t, 1800 + i * 2000)}
          >
            {row.value}
          </span>
        </li>
      ))}
    </ul>
    <p className="hiw-in mt-[1.6em] max-w-[34em] text-[0.88em] leading-relaxed text-text-secondary" data-on={on(t, 7200)}>
      A source counts when something other than you witnessed it and it belongs to someone else.
    </p>
  </div>
)

// ── 5 · Prove it ─────────────────────────────────────────────────────────

const ProveIt: Scene = ({ t }) => (
  <div className="flex w-full flex-col items-center gap-[1.4em]">
    <div className="flex flex-col items-center gap-[0.6em] sm:flex-row sm:gap-[1.4em]">
      <span className="flex items-center">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="flex items-center">
            {i > 0 ? (
              <span aria-hidden className="hiw-in w-[0.7em] border-t-2 border-dashed border-provian-blue-bright/50" data-on={on(t, 300 + i * 300)} />
            ) : null}
            <span className="hiw-in" data-on={on(t, 300 + i * 300)}>
              <MiniReceipt className="w-[2.6em]" />
            </span>
          </span>
        ))}
      </span>
      <Arrow t={t} at={2600} className="rotate-90 sm:rotate-0" />
      <span className="hiw-in flex flex-col items-center gap-[0.3em]" data-on={on(t, 3000)}>
        <svg viewBox="0 0 40 56" className="hiw-flicker h-[3.2em] w-[2.3em]" aria-hidden>
          <defs>
            <linearGradient id="hiwFlame" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#d4913a" />
              <stop offset="0.55" stopColor="#f0bd5c" />
              <stop offset="1" stopColor="#F5F7FB" />
            </linearGradient>
          </defs>
          <path d="M20 2 C24 14 36 22 36 36 A16 16 0 0 1 4 36 C4 26 12 22 14 12 C17 18 18 20 20 22 C21 14 20 8 20 2 Z" fill="url(#hiwFlame)" />
          <path d="M20 30 C23 35 27 38 27 43 A7 7 0 0 1 13 43 C13 38 17 35 20 30 Z" fill="#06080f" fillOpacity="0.35" />
        </svg>
        <span className="whitespace-nowrap font-mono text-[0.72em] tracking-[0.12em] text-provian-gold-bright">burn &amp; present</span>
      </span>
      <Arrow t={t} at={4800} className="rotate-90 sm:rotate-0" />
      <span className="hiw-in relative h-[7.6em] w-[6.6em]" data-on={on(t, 5300)}>
        <span className="absolute inset-0 rounded-t-full border-2 border-b-0 border-platinum-deep/70" />
        <span className="absolute inset-x-[0.45em] bottom-0 top-[0.45em] overflow-hidden rounded-t-full bg-provian-blue/10">
          <span className="absolute inset-0 flex items-center justify-center whitespace-nowrap font-mono text-[0.86em] font-semibold text-provian-blue-bright">
            ✓ verified
          </span>
          <span className="hiw-door-l absolute inset-y-0 left-0 w-1/2 border-r border-white/20 bg-surface-highlight" data-on={on(t, 6800)} />
          <span className="hiw-door-r absolute inset-y-0 right-0 w-1/2 border-l border-white/20 bg-surface-highlight" data-on={on(t, 6800)} />
        </span>
      </span>
    </div>
    <p className="hiw-in font-mono text-[0.8em] tracking-[0.06em] text-text-secondary" data-on={on(t, 8600)}>
      signed · bound to them · expires in minutes
    </p>
  </div>
)

// ── 6 · Your agents ──────────────────────────────────────────────────────

function Node({ name, t, at, accent }: { name: string; t: number; at: number; accent: string }) {
  return (
    <span
      className={`hiw-pop flex h-[5em] w-[5em] shrink-0 items-center justify-center rounded-full border-2 bg-surface-raised font-display text-[1.15em] font-semibold sm:h-[5.6em] sm:w-[5.6em] ${accent}`}
      data-on={on(t, at)}
    >
      {name}
    </span>
  )
}

const YourAgents: Scene = ({ t }) => (
  <div className="flex w-full max-w-[40em] flex-col items-center gap-[1.2em]">
    <div className="flex w-full items-center">
      <Node name="You" t={t} at={400} accent="border-provian-gold/70 shadow-glow-amber" />
      <span className="hiw-in relative mx-[0.4em] h-[4.2em] flex-1" data-on={on(t, 1500)}>
        <span className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-provian-blue-bright/55" />
        <span className="absolute inset-x-0 top-0 text-center font-mono text-[0.7em] tracking-[0.12em] text-text-secondary">
          beneficiary link
        </span>
        <span className="hiw-in absolute inset-0" data-on={on(t, 2400)}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="hiw-travel absolute top-1/2 -mt-[0.75em]"
              style={{ animationDelay: `${i * 0.9}s` }}
            >
              <PvtCoin size={24} className="h-[1.5em] w-[1.5em]" />
            </span>
          ))}
        </span>
      </span>
      <Node name="Agent" t={t} at={900} accent="border-provian-blue/70 shadow-glow-blue" />
    </div>
    <div className="grid w-full grid-cols-2 gap-[1em]">
      <p className="hiw-in font-mono text-[1em] font-medium text-provian-gold-bright" data-on={on(t, 5000)}>
        4/5 to you
      </p>
      <p className="hiw-in text-right font-mono text-[0.8em] text-text-secondary" data-on={on(t, 5800)}>
        1/5 stays with the agent
      </p>
    </div>
    <span
      className="hiw-in inline-flex items-center gap-[0.6em] rounded-full border border-provian-blue/40 bg-provian-blue/10 py-[0.35em] pl-[0.45em] pr-[0.9em] text-[0.85em] text-text-primary"
      data-on={on(t, 7200)}
    >
      <span aria-hidden className="relative h-[1.1em] w-[2em] rounded-full bg-provian-blue">
        <span className="absolute right-[0.15em] top-[0.15em] h-[0.8em] w-[0.8em] rounded-full bg-white" />
      </span>
      Linked · end it anytime
    </span>
  </div>
)

// ── 7 · Take part ────────────────────────────────────────────────────────

const GENESIS_STEPS: [string, string][] = [
  ['Create your wallet', 'A 75 PVT grant.'],
  ['Install the desktop app', 'A 25 PVT grant for each computer.'],
  ['Give your agent its own wallet', 'Its own 75 PVT grant. Four fifths of its work comes to you.'],
  ['Use it', 'Send, swap and receive on Base. Already hold a wallet? Prove it from Earn.'],
]

const TakePart: Scene = ({ t }) => (
  <div className="w-full max-w-[48em] self-start sm:self-center">
    <p className="hiw-in text-[0.98em] leading-snug text-text-primary/90" data-on={on(t, 1000)}>
      Through December 31, 2026. Grants run up to 500 PVT per wallet, and real work mints on top.
    </p>
    <ol className="mt-[1em] space-y-[0.6em] sm:mt-[1.3em] sm:space-y-[0.75em]">
      {GENESIS_STEPS.map(([title, body], i) => (
        <li
          key={title}
          className="hiw-in flex gap-[0.8em] border-t border-white/10 pt-[0.55em] sm:pt-[0.7em]"
          data-on={on(t, 2500 + i * 2200)}
        >
          <span className="w-[1em] shrink-0 font-mono text-[1.1em] font-medium leading-snug text-provian-gold-bright">
            {i + 1}
          </span>
          <span className="text-[0.92em] leading-snug text-text-secondary">
            <span className="font-semibold text-text-primary">{title}:</span> {body}
          </span>
        </li>
      ))}
    </ol>
  </div>
)

// ── 8 · Provian ──────────────────────────────────────────────────────────

const ProvianEnd: Scene = ({ t }) => (
  <div className="flex flex-col items-center text-center">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src="/logos/provian-256.png"
      alt=""
      width={256}
      height={256}
      loading="lazy"
      className="hiw-pop h-[7em] w-[7em] [-webkit-mask-image:radial-gradient(closest-side,#000_62%,transparent)] [mask-image:radial-gradient(closest-side,#000_62%,transparent)]"
      data-on={on(t, 300)}
    />
    <p
      className="hiw-in mt-[0.6em] bg-gradient-to-b from-platinum to-platinum-deep bg-clip-text pl-[0.34em] font-mono text-[2.2em] font-medium tracking-[0.34em] text-transparent"
      data-on={on(t, 1300)}
    >
      PROVIAN
    </p>
    <p
      className="hiw-in mt-[0.7em] font-display text-[1.5em] font-semibold leading-tight tracking-[-0.02em]"
      data-on={on(t, 2600)}
    >
      Compute mints money. <span className="gradient-text">No one gets left behind.</span>
    </p>
    <p className="hiw-in mt-[1em] font-mono text-[0.85em] tracking-[0.14em] text-text-secondary" data-on={on(t, 3800)}>
      provian.ai
    </p>
  </div>
)

// The copy is final; carry it verbatim.
const CHAPTERS: Chapter[] = [
  {
    label: 'Your work',
    ms: 15_000,
    kicker: '01 · YOUR WORK',
    headline: 'The work you do with AI leaves proof',
    caption:
      'You and your AI already do real work every day: conversations, code, payments, agent tasks. Provian turns each act into proof.',
    Scene: YourWork,
  },
  {
    label: 'Sealed',
    ms: 13_000,
    kicker: '02 · SEALED',
    headline: 'Every act leaves a receipt',
    caption:
      'Each act leaves a receipt: a signed record, chained to the one before it. It carries the facts of the work. The content never leaves your device.',
    Scene: Sealed,
  },
  {
    label: 'Minted',
    ms: 12_000,
    kicker: '03 · MINTED',
    headline: 'Witnessed work mints PVT',
    caption:
      'Witnessed work mints PVT on Base. 99% goes to whoever did the work, half a percent to Provian and half a percent to the Foundation, fixed in the contract.',
    Scene: Minted,
  },
  {
    label: 'Evidence',
    ms: 12_000,
    kicker: '04 · EVIDENCE',
    headline: 'Better evidence mints more',
    caption:
      'Every receipt mints. The more independent people and systems the work touched, the more it mints.',
    Scene: Evidence,
  },
  {
    label: 'Prove it',
    ms: 16_000,
    kicker: '05 · PROVE IT',
    headline: 'A gate asks. Your agent proves.',
    caption:
      'Mostly it is your agent, at a gate outside Provian: a merchant, an API, another agent. It burns a little PVT to present its record, and the gate checks the proof itself. You can too.',
    Scene: ProveIt,
  },
  {
    label: 'Your agents',
    ms: 12_500,
    kicker: '06 · YOUR AGENTS',
    headline: 'Your agents earn for you',
    caption:
      'Give your agent a wallet of its own and link it to you. Four fifths of what its work mints comes to you, and you can end the link at any time.',
    Scene: YourAgents,
  },
  {
    label: 'Take part',
    ms: 20_000,
    kicker: '07 · TAKE PART',
    headline: 'Genesis is open',
    caption:
      'Genesis is open through December 31, 2026. Grants run up to 500 PVT per wallet, real work mints on top, and the last day pays exactly what the first day paid.',
    genesis: true,
    Scene: TakePart,
  },
  {
    label: 'Provian',
    ms: 8_000,
    caption: 'Compute mints money. No one gets left behind.',
    Scene: ProvianEnd,
  },
]

function clock(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function HowItWorksFilm({ className = '' }: { className?: string }) {
  const genesisOpen = useGenesisOpen()
  const chapters = useMemo(() => (genesisOpen ? CHAPTERS : CHAPTERS.filter((c) => !c.genesis)), [genesisOpen])
  const total = useMemo(() => chapters.reduce((sum, c) => sum + c.ms, 0), [chapters])

  // The playhead lives in a ref (the frame loop writes it every frame) and a
  // counter re-renders from it.
  const pos = useRef({ i: 0, t: 0 })
  const started = useRef(false)
  const userPaused = useRef(false)
  const inView = useRef(false)
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  const [, render] = useReducer((n: number) => n + 1, 0)
  const [playing, setPlaying] = useState(false)
  const [reduced, setReduced] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  const last = chapters.length - 1
  const i = Math.min(pos.current.i, last)
  const chapter = chapters[i]
  const ended = started.current && i === last && pos.current.t >= chapter.ms
  // Before the first play, and always under reduced motion, every chapter
  // shows finished.
  const t = reduced || !started.current ? Number.POSITIVE_INFINITY : pos.current.t
  const elapsed = started.current
    ? chapters.slice(0, i).reduce((sum, c) => sum + c.ms, 0) + Math.min(pos.current.t, chapter.ms)
    : 0

  // Reduced motion: no playback at all.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const apply = () => {
      setReduced(mq.matches)
      if (mq.matches) setPlaying(false)
    }
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])

  // A Genesis close mid-visit shortens the timeline under the playhead.
  useEffect(() => {
    if (pos.current.i > chapters.length - 1) {
      pos.current = { i: chapters.length - 1, t: chapters[chapters.length - 1].ms }
      setPlaying(false)
      render()
    }
  }, [chapters])

  // The frame loop.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let prev = performance.now()
    const step = (now: number) => {
      const dt = Math.min(now - prev, 250)
      prev = now
      const list = chaptersRef.current
      const p = pos.current
      const next = p.t + dt
      if (next < list[p.i].ms) {
        pos.current = { i: p.i, t: next }
      } else if (p.i < list.length - 1) {
        pos.current = { i: p.i + 1, t: 0 }
      } else {
        pos.current = { i: p.i, t: list[p.i].ms }
        setPlaying(false)
        render()
        return
      }
      render()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const atEnd = useCallback(() => {
    const list = chaptersRef.current
    const p = pos.current
    return started.current && p.i >= list.length - 1 && p.t >= list[list.length - 1].ms
  }, [])

  // Plays on its own only from where it is, never past the end, never after
  // the visitor paused it.
  const autoplay = useCallback(() => {
    if (userPaused.current || atEnd() || document.hidden) return
    if (!started.current) {
      started.current = true
      pos.current = { i: 0, t: 0 }
    }
    setPlaying(true)
  }, [atEnd])

  // In view: play. Out of view or tab hidden: pause.
  useEffect(() => {
    const el = stageRef.current
    if (!el || reduced || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.5) {
          inView.current = true
          autoplay()
        } else if (entry.intersectionRatio < 0.2) {
          inView.current = false
          setPlaying(false)
        }
      },
      { threshold: [0, 0.2, 0.5] },
    )
    io.observe(el)
    const onVisibility = () => {
      if (document.hidden) setPlaying(false)
      else if (inView.current) autoplay()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced, autoplay])

  const toggle = () => {
    if (reduced) return
    if (playing) {
      userPaused.current = true
      setPlaying(false)
      return
    }
    if (!started.current || atEnd()) {
      started.current = true
      pos.current = { i: 0, t: 0 }
    }
    userPaused.current = false
    setPlaying(true)
    render()
  }

  const jump = (j: number) => {
    started.current = true
    pos.current = { i: j, t: 0 }
    if (!reduced) {
      userPaused.current = false
      setPlaying(true)
    }
    render()
  }

  const Scene = chapter.Scene
  const hasHeader = Boolean(chapter.kicker || chapter.headline)

  return (
    <figure className={`hiw ${className}`} aria-label="How Provian works">
      <div
        ref={stageRef}
        aria-hidden
        className={`hiw-stage relative aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-[0_0_60px_rgba(74,158,255,0.12)] sm:aspect-video ${
          playing ? '' : 'hiw-paused'
        }`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-glow-blue-radial" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-glow-amber-radial opacity-60" />
        <div
          key={i}
          className="hiw-scene relative flex h-full flex-col p-[1.6em] sm:p-[2.2em]"
        >
          {hasHeader ? (
            <div className="shrink-0">
              <p className="hiw-in font-mono text-[0.76em] tracking-[0.24em] text-provian-gold-bright" data-on={on(t, 0)}>
                {chapter.kicker}
              </p>
              <h3
                className="hiw-in mt-[0.4em] max-w-[22em] font-display text-[1.9em] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary sm:text-[2.4em]"
                data-on={on(t, 150)}
              >
                {chapter.headline}
              </h3>
            </div>
          ) : null}
          <div className={`flex min-h-0 flex-1 items-center justify-center ${hasHeader ? 'pt-[1.2em]' : ''}`}>
            <Scene t={t} />
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {reduced ? null : (
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggle}
              aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/25 bg-void/50 text-text-primary transition-colors hover:border-white/60 hover:bg-provian-blue/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-provian-blue-bright"
            >
              {playing ? (
                <Pause size={18} fill="currentColor" />
              ) : ended ? (
                <RotateCcw size={18} />
              ) : (
                <Play size={18} className="translate-x-px" fill="currentColor" />
              )}
            </button>
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(total / 1000)}
              aria-valuenow={Math.round(elapsed / 1000)}
              aria-valuetext={`${clock(elapsed)} of ${clock(total)}`}
              className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
            >
              <div className="absolute inset-y-0 left-0 bg-ascent-h" style={{ width: `${(elapsed / total) * 100}%` }} />
              {chapters.slice(1).map((c, k) => {
                const at = chapters.slice(0, k + 1).reduce((sum, x) => sum + x.ms, 0)
                return <span key={c.label} className="absolute inset-y-0 w-0.5 bg-void" style={{ left: `${(at / total) * 100}%` }} />
              })}
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums text-text-secondary">
              {clock(elapsed)} / {clock(total)}
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {chapters.map((c, j) => (
            <button
              key={c.label}
              type="button"
              onClick={() => jump(j)}
              aria-label={`Chapter ${j + 1}: ${c.label}`}
              aria-current={j === i ? 'step' : undefined}
              {...(c.genesis ? { 'data-genesis': '' } : {})}
              className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-provian-blue-bright ${
                j === i
                  ? 'border-provian-blue/70 bg-provian-blue/15 text-text-primary'
                  : 'border-white/15 text-text-secondary hover:border-white/35 hover:text-text-primary'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <figcaption aria-live="polite" className="mt-5 max-w-3xl text-base leading-7 text-text-secondary md:text-lg">
        {chapter.caption}
      </figcaption>
    </figure>
  )
}
