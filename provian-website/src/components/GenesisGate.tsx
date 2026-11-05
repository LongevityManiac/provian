'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { GENESIS_CLOSED_CLASS, GENESIS_WINDOW_END_MS, genesisDaysLeft, isGenesisOpen } from '@/lib/genesis'

// True while the Genesis window is open. Starts true (the window is open at
// build time), re-checks after hydration, and flips at the close without a
// reload.
export function useGenesisOpen(): boolean {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    // The closed state is one switch: the class on <html> shows every
    // [data-genesis-closed] block, and `open` unmounts every gate. A page left
    // open across the close flips both together, with no reload.
    const close = () => {
      document.documentElement.classList.add(GENESIS_CLOSED_CLASS)
      setOpen(false)
    }
    if (!isGenesisOpen()) {
      close()
      return
    }
    let t: ReturnType<typeof setTimeout>
    const arm = () => {
      const left = GENESIS_WINDOW_END_MS - Date.now()
      if (left <= 0) {
        close()
        return
      }
      // setTimeout cannot hold more than about 24.8 days; re-arm until the close.
      t = setTimeout(arm, Math.min(2_147_000_000, left))
    }
    arm()
    return () => clearTimeout(t)
  }, [])
  return open
}

// Wraps any Genesis surface. Server-rendered visible (the window is open at
// build time); the pre-paint script in the root layout hides [data-genesis]
// the moment the window closes, and this gate also unmounts its children after
// hydration, so a page built before the close shows no Genesis after it.
export function GenesisGate({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'span' | 'section' | 'li'
}) {
  const open = useGenesisOpen()
  if (!open) return null
  return (
    <Tag data-genesis="" className={className}>
      {children}
    </Tag>
  )
}

// The inverse gate: what a page shows once Genesis has closed. Server-rendered
// but hidden ([data-genesis-closed] in globals.css) until the pre-paint script
// marks <html> genesis-closed, so the closed state paints with the page and no
// deploy is needed. data-nosnippet keeps the not-yet-true text out of search
// snippets while the window is open.
export function GenesisClosed({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-genesis-closed="" data-nosnippet="" className={className}>
      {children}
    </div>
  )
}

// "Genesis · N days left". The number is computed in the visitor's browser (a
// static page cannot know today's date), so the server render carries the
// label alone and the count appears on hydration. It removes itself at the
// close together with its GenesisGate parent.
export function GenesisCountdown({
  className = '',
  label = 'Genesis',
}: {
  className?: string
  label?: string | null
}) {
  const [days, setDays] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setDays(genesisDaysLeft())
    tick()
    const t = setInterval(tick, 60_000)
    return () => clearInterval(t)
  }, [])
  const count = days === null ? null : days === 1 ? 'last day' : `${days} days left`
  return (
    <span className={`chip-gold ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-provian-gold-bright" />
      {label}
      {label && count ? <span aria-hidden>·</span> : null}
      {count ?? (label ? null : 'Open')}
    </span>
  )
}

// The clock as a numeral: the days left over a label, and "Last day" on the
// last day.
export function GenesisDays({ className = '', labelClassName = '' }: { className?: string; labelClassName?: string }) {
  const [days, setDays] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setDays(genesisDaysLeft())
    tick()
    const t = setInterval(tick, 60_000)
    return () => clearInterval(t)
  }, [])
  const last = days === 1
  return (
    <>
      <span className={className} suppressHydrationWarning>
        {days === null ? '—' : last ? 'Last' : days}
      </span>
      <span className={labelClassName}>
        {last ? 'day' : 'days left'}
        <br />
        through December 31, 2026
      </span>
    </>
  )
}
