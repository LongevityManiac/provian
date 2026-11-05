'use client'

import { useEffect, useState } from 'react'

// The Vision page's chapter list: sticky beside the text on a wide screen, a
// fold-out list above it on a phone. The current chapter is marked as the
// reader scrolls. With no JavaScript it is a plain list of anchor links.
export function ChapterNav({ chapters }: { chapters: { id: string; title: string }[] }) {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      { rootMargin: '-25% 0px -65% 0px' },
    )
    for (const c of chapters) {
      const el = document.getElementById(c.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [chapters])

  const list = (
    <ol className="space-y-1">
      {chapters.map((c, i) => (
        <li key={c.id}>
          <a
            href={`#${c.id}`}
            aria-current={active === c.id ? 'true' : undefined}
            className={`flex gap-3 rounded-lg px-3 py-1.5 text-sm leading-6 transition-colors ${
              active === c.id
                ? 'bg-white/8 text-text-primary'
                : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
            }`}
          >
            <span className="marker w-6 shrink-0 pt-0.5">{String(i + 1).padStart(2, '0')}</span>
            <span>{c.title}</span>
          </a>
        </li>
      ))}
    </ol>
  )

  return (
    <>
      <nav aria-label="Chapters" className="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100svh-7rem)] lg:overflow-y-auto">
        <p className="eyebrow px-3 pb-3">Chapters</p>
        {list}
      </nav>
      <details className="glass sticky top-[4.6rem] z-30 bg-void/95 backdrop-blur-xl lg:hidden">
        <summary className="cursor-pointer list-none px-4 py-3 font-mono text-xs uppercase tracking-[0.22em] text-provian-gold-bright">
          Chapters
          {active ? (
            <span className="ml-3 normal-case tracking-normal text-text-secondary">
              {chapters.find((c) => c.id === active)?.title}
            </span>
          ) : null}
        </summary>
        <div className="max-h-[60svh] overflow-y-auto px-1 pb-3">{list}</div>
      </details>
    </>
  )
}
