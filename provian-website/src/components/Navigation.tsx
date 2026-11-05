'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowUpRight, ChevronDown, Menu, X } from 'lucide-react'
import { PRIMARY_NAV, MORE_NAV, PUBLIC_NAV, EMAIL, route, usesFullChrome, isSplash } from '@/lib/routes'
import { GenesisCountdown, GenesisGate } from '@/components/GenesisGate'

function Wordmark({ href }: { href: string }) {
  return (
    <Link href={href} className="group flex shrink-0 items-center gap-3 whitespace-nowrap">
      <span className="relative inline-flex h-8 w-8 items-center justify-center">
        <span className="absolute inset-0 rounded-md bg-glow-blue-radial opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100" />
        <img
          src="/provian-mark.png"
          alt=""
          className="h-8 w-8 object-contain"
        />
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-mono text-xs uppercase tracking-[0.3em] text-text-primary/80 transition-colors group-hover:text-text-primary">
          Provian
        </span>
        <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-text-secondary">
          Proving provenance
        </span>
      </span>
    </Link>
  )
}

export function Navigation() {
  const pathname = usePathname() || '/'
  const [open, setOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  // Close the "More" dropdown on outside click or Escape.
  useEffect(() => {
    if (!moreOpen) return
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  // Collapse both menus on navigation.
  useEffect(() => {
    setMoreOpen(false)
    setOpen(false)
  }, [pathname])

  // homepage and carries the header.
  if (isSplash(pathname)) return null

  const fullChrome = usesFullChrome(pathname)

  // Truly-public pages (the splash and /support) keep a minimal, public-safe
  // header that cross-links ONLY the other public pages — never the gated
  // /preview/* routes — so an unauthenticated visitor hits no dead ends.
  // /download, /about, and /daemon sit behind the same gate as the staged site,
  // so they get the full primary nav (see usesFullChrome).
  if (!fullChrome) {
    return (
      <header className="sticky top-0 z-50 border-b border-white/10 bg-void/85 backdrop-blur-xl transition-all duration-300">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4 md:px-10 lg:px-14">
          <Wordmark href={route.splash} />
          <nav className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-5">
            {PUBLIC_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  pathname === item.href
                    ? 'bg-white/10 text-text-primary'
                    : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                }`}
              >
                {item.label}
              </Link>
            ))}
            <a
              href={`mailto:${EMAIL}`}
              className="hidden font-mono text-xs uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-provian-blue-bright sm:inline"
            >
              {EMAIL}
            </a>
          </nav>
        </div>
      </header>
    )
  }

  const isActive = (href: string) =>
    pathname === href || pathname === `${href}/` || (href !== route.home && pathname.startsWith(`${href}/`))

  const itemClass = (active: boolean) =>
    `whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
      active ? 'bg-white/10 text-text-primary shadow-sm' : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
    }`

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-void/85 backdrop-blur-xl transition-all duration-300">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4 md:px-8 xl:px-14">
        <Wordmark href={route.home} />

        {/* Nothing in this row may wrap: every item is whitespace-nowrap, and
            the row only appears once there is room for it (lg). */}
        <nav className="hidden items-center gap-1 lg:flex xl:gap-2">
          {/* Genesis leads in gold with the days left, and removes itself at the close. */}
          <GenesisGate as="span" className="contents">
            <Link
              href={route.genesis}
              className={`mr-1 inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-semibold transition-all duration-200 ${
                isActive(route.genesis)
                  ? 'border-provian-gold/60 bg-provian-gold/15 text-provian-gold-bright'
                  : 'border-provian-gold/30 bg-provian-gold/5 text-provian-gold-bright hover:border-provian-gold/60 hover:bg-provian-gold/10'
              }`}
            >
              Genesis
              <GenesisCountdown label={null} className="border-0 bg-transparent px-0 py-0" />
            </Link>
          </GenesisGate>

          {PRIMARY_NAV.map((item) => (
            <Link key={item.href} href={item.href} className={itemClass(isActive(item.href))}>
              {item.label}
            </Link>
          ))}

          {/* "More": one short list. */}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-haspopup="true"
              className={`inline-flex items-center gap-1.5 ${itemClass(MORE_NAV.some((i) => isActive(i.href)))}`}
            >
              More
              <ChevronDown
                size={14}
                className={`transition-transform duration-200 ${moreOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {moreOpen && (
              <ul className="absolute right-0 top-full mt-3 min-w-[190px] space-y-1 rounded-2xl border border-white/15 bg-void p-3 shadow-2xl shadow-black/60 animate-fade-in">
                {MORE_NAV.map((item) => (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      className={`block whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive(item.href)
                          ? 'bg-white/10 font-medium text-text-primary'
                          : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Link href={route.download} className="btn-primary ml-1 shrink-0 px-4 py-2 text-sm shadow-glow-blue">
            Get the app
            <ArrowUpRight size={15} />
          </Link>
        </nav>

        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/15 text-text-primary transition-colors hover:bg-white/5 lg:hidden"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open && (
        <nav className="max-h-[calc(100svh-4.5rem)] overflow-y-auto border-t border-white/10 bg-void px-6 py-5 animate-fade-in lg:hidden">
          <GenesisGate>
            <Link
              href={route.genesis}
              onClick={() => setOpen(false)}
              className="mb-2 flex items-center justify-between rounded-lg border border-provian-gold/30 bg-provian-gold/5 px-3 py-2.5 text-base font-semibold text-provian-gold-bright"
            >
              Genesis
              <GenesisCountdown label={null} className="border-0 bg-transparent px-0 py-0" />
            </Link>
          </GenesisGate>
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`block rounded-lg px-3 py-2.5 text-base font-medium transition-colors ${
                isActive(item.href) ? 'bg-white/10 text-text-primary' : 'text-text-secondary hover:bg-white/5'
              }`}
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-3 border-t border-white/10 pt-3">
            {MORE_NAV.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`block rounded-lg px-3 py-2 text-base font-medium transition-colors ${
                  isActive(item.href) ? 'bg-white/10 text-text-primary' : 'text-text-secondary hover:bg-white/5'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <Link href={route.download} onClick={() => setOpen(false)} className="btn-primary mt-4 w-full">
            Get the app
            <ArrowUpRight size={15} />
          </Link>
        </nav>
      )}
    </header>
  )
}
