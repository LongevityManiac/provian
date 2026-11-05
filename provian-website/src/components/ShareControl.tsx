'use client'

import { useState } from 'react'
import { Check, Share2 } from 'lucide-react'

// Share a page: the device's share sheet where there is one, otherwise the
// link is copied. `path` is a root-relative path; the shared URL is always the
// canonical https://provian.ai one. `text` is what the share says beside the
// link (a share line shares its own words), and is copied with the link when
// there is no share sheet.
export function ShareControl({
  path,
  title,
  text,
  label = 'Share',
  className = '',
}: {
  path: string
  title: string
  text?: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const url = `https://provian.ai${path.endsWith('/') ? path : `${path}/`}`

  async function share() {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share(text ? { title, text, url } : { title, url })
        return
      }
    } catch {
      return // the visitor closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(text ? `${text} ${url}` : url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('Copy this link', text ? `${text} ${url}` : url)
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-white/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary transition-colors hover:border-white/35 hover:text-text-primary ${className}`}
    >
      {copied ? <Check size={13} /> : <Share2 size={13} />}
      {copied ? (text ? 'Copied' : 'Link copied') : label}
    </button>
  )
}
