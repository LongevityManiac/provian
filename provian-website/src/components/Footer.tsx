'use client'

import type { ComponentType } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Github, Facebook, Instagram, type LucideProps } from 'lucide-react'
import { FOOTER_NAV, PUBLIC_NAV, SOCIAL_NAV, LEGAL_NAV, EMAIL, route, usesFullChrome, isSplash } from '@/lib/routes'

// lucide has no X (formerly Twitter) brand mark, so render the X logo inline.
// Typed as LucideProps so it sits in the same icon map as the lucide icons.
function XIcon({ size = 18 }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  )
}

const SOCIAL_ICONS: Record<string, ComponentType<LucideProps>> = {
  GitHub: Github,
  X: XIcon,
  Facebook: Facebook,
  Instagram: Instagram,
}

// Privacy + Terms, shown in every footer. These URLs are what the app stores
// link to, so they must be present and stable on every page.
function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${className}`}>
      {LEGAL_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="font-mono text-xs uppercase tracking-[0.2em] text-text-muted transition-colors hover:text-text-primary"
        >
          {item.label}
        </Link>
      ))}
    </div>
  )
}

function SocialLinks({ className = '' }: { className?: string }) {
  // No accounts yet — render nothing rather than ship dead links.
  if (SOCIAL_NAV.length === 0) return null
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      {SOCIAL_NAV.map((s) => {
        const Icon = SOCIAL_ICONS[s.label]
        return (
          <a
            key={s.label}
            href={s.href}
            aria-label={s.label}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-muted transition-colors hover:text-text-primary"
          >
            <Icon size={18} />
          </a>
        )
      })}
    </div>
  )
}

export function Footer() {
  const pathname = usePathname() || '/'

  // the homepage and carries the footer.
  if (isSplash(pathname)) return null

  const fullChrome = usesFullChrome(pathname)

  // Minimal footer only on the truly-public pages (splash + /support): cross-links
  // /about, and /daemon share the staged auth gate and get the full footer (see
  // usesFullChrome), so navigation stays consistent across the site.
  if (!fullChrome) {
    return (
      <footer className="border-t border-white/10 bg-void px-6 py-10 md:px-10 lg:px-14">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.28em] text-text-muted">
                Provian
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-muted/70">
                Proving provenance
              </span>
            </div>
            <SocialLinks />
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {PUBLIC_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={`mailto:${EMAIL}`}
              className="font-mono text-xs uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-text-primary"
            >
              {EMAIL}
            </a>
            <LegalLinks />
          </nav>
        </div>
      </footer>
    )
  }

  return (
    <footer className="relative border-t border-white/10 bg-void">
      <div className="absolute inset-x-0 top-0 h-px bg-edge-top opacity-40" />
      <div className="mx-auto max-w-7xl px-6 py-16 md:px-10 lg:px-14">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr]">
          <div className="max-w-md">
            <div className="flex items-center gap-3">
              <img
                src="/provian-mark.png"
                alt=""
                className="h-9 w-9 object-contain"
              />
              <span className="font-mono text-xs uppercase tracking-[0.3em] text-text-primary/80">
                Provian
              </span>
            </div>
            <p className="mt-6 font-display text-2xl font-semibold leading-tight tracking-[-0.02em] text-text-primary">
              The Trust Layer for the Intelligence Economy.
            </p>
            <p className="mt-4 text-sm leading-6 text-text-secondary">
              Provian is an open protocol.{' '}
              <Link href={route.developers} className="text-provian-blue-bright transition-colors hover:text-text-primary">
                Help build the trust layer
              </Link>
              .
            </p>
            <a
              href={`mailto:${EMAIL}`}
              className="mt-6 inline-block font-mono text-xs uppercase tracking-[0.2em] text-provian-blue-bright transition-colors hover:text-text-primary"
            >
              {EMAIL}
            </a>
            <SocialLinks className="mt-6" />
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {FOOTER_NAV.map((col) => (
              <div key={col.heading}>
                <p className="eyebrow text-text-muted">{col.heading}</p>
                <ul className="mt-4 space-y-3">
                  {col.items.map((item) => (
                    <li key={item.label}>
                      {item.href.startsWith('mailto:') ? (
                        <a
                          href={item.href}
                          className="text-sm text-text-secondary transition-colors hover:text-text-primary"
                        >
                          {item.label}
                        </a>
                      ) : (
                        <Link
                          href={item.href}
                          className="text-sm text-text-secondary transition-colors hover:text-text-primary"
                        >
                          {item.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-white/8 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-text-muted">
            Compute mints money. No one gets left behind.
          </span>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <LegalLinks />
            <span className="font-mono text-xs text-text-muted">
              &copy; {2026} Provian
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
