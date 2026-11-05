'use client'

import { useEffect, useRef, type ReactNode } from 'react'

// Rises a section in as it scrolls into view. The content is visible by
// default. Only this component, running in the browser, ever hides it: on mount
// it arms a section that is still below the fold (.armed, globals.css) and
// shows it when it scrolls in. So no JavaScript, a bundle that fails to load, a
// missing IntersectionObserver, or reduced motion all leave the content plainly
// on the page, and a section already in view is never hidden at all.
export function RevealOnScroll({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    // Already on screen: leave it as it is.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return

    el.classList.add('armed')
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          timer = setTimeout(() => el.classList.add('visible'), delay)
          observer.unobserve(el)
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
    )
    observer.observe(el)

    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
      // Never leave a section armed and unwatched.
      el.classList.add('visible')
    }
  }, [delay])

  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  )
}
