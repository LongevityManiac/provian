'use client'

import { useRef, useState } from 'react'
import { Play } from 'lucide-react'

// A film stage: the poster with one play button, no browser chrome until the
// visitor presses play. Nothing downloads before that (the <video> is only
// mounted on play), and it never plays with sound on its own.
export function Film({
  src,
  poster,
  title,
  seconds,
  caption,
  className = '',
  rounded = true,
}: {
  src: string
  poster: string
  title: string
  seconds?: number
  caption?: string
  className?: string
  rounded?: boolean
}) {
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  return (
    <figure className={className}>
      <div
        className={`relative aspect-video w-full overflow-hidden bg-black ${
          rounded ? 'rounded-2xl border border-white/10 shadow-[0_0_60px_rgba(74,158,255,0.12)]' : ''
        }`}
      >
        {playing ? (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full"
            src={src}
            poster={poster}
            controls
            autoPlay
            playsInline
            aria-label={title}
            title={title}
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            data-film-play=""
            aria-label={`Play ${title}`}
            className="group absolute inset-0 h-full w-full"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
            <span className="absolute inset-0 bg-gradient-to-b from-void/55 via-transparent to-void/30" />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/40 bg-void/50 text-text-primary backdrop-blur-md transition-all duration-300 group-hover:scale-105 group-hover:border-white/80 group-hover:bg-provian-blue/30 md:h-20 md:w-20">
                <Play size={26} className="translate-x-0.5" fill="currentColor" />
              </span>
            </span>
            {/* The label sits at the top: the films carry their own captions low in the frame. */}
            <span className="absolute inset-x-0 top-0 flex items-center justify-between gap-4 p-4 text-left font-mono text-[11px] uppercase tracking-[0.2em] text-text-primary/90 md:p-6">
              <span>{title}</span>
              {seconds ? <span className="shrink-0">{seconds} s</span> : null}
            </span>
          </button>
        )}
      </div>
      {caption ? (
        <figcaption className="mt-4 max-w-3xl text-base leading-7 text-text-secondary md:text-lg">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  )
}
