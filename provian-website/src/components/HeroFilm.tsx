'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Play } from 'lucide-react'

// A button that plays a film on this page: it brings the film's stage into
// view and presses its play button, so the film plays in place, inline like
// every other film on the site (Film). Once the film is playing, pressing
// again only brings it back into view.
export function WatchFilmButton({
  target,
  children,
  className = 'btn-ghost',
}: {
  // The id of the element that holds the film's stage.
  target: string
  children: ReactNode
  className?: string
}) {
  const watch = () => {
    const stage = document.getElementById(target)
    if (!stage) return
    stage.scrollIntoView({ block: 'center' })
    stage.querySelector<HTMLButtonElement>('button[data-film-play]')?.click()
  }
  return (
    <button type="button" onClick={watch} className={className}>
      <Play size={14} fill="currentColor" />
      {children}
    </button>
  )
}

// The muted loop behind the hero. The poster is the server render; the loop
// starts only when JavaScript is running and the visitor has not asked for
// reduced motion, and it pauses while it is off screen.
export function HeroLoop({ src, poster }: { src: string; poster: string }) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    video.muted = true
    const play = () => {
      video.play().catch(() => {
        // Autoplay refused (data saver, low power): the poster stays.
      })
    }
    if (typeof IntersectionObserver === 'undefined') {
      play()
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) play()
      else video.pause()
    })
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  return (
    <video
      ref={ref}
      className="absolute inset-0 h-full w-full object-cover"
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
    />
  )
}
