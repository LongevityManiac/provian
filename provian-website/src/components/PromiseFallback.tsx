'use client'

// Platform-aware "get the app" block for the /p promise share-link fallback.
// Renders BOTH app targets on the server (so no-JS / crawlers see everything),
// then emphasises the one that matches the visitor's device once JS runs.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Smartphone, ArrowUpRight } from 'lucide-react'
import { route } from '@/lib/routes'
import { PendingStoreCard } from '@/components/PendingStoreCard'

type Platform = 'ios' | 'android' | 'other'

export function PromiseFallback() {
  const [platform, setPlatform] = useState<Platform>('other')

  useEffect(() => {
    const ua = navigator.userAgent || ''
    if (/iPhone|iPad|iPod/i.test(ua)) setPlatform('ios')
    else if (/Android/i.test(ua)) setPlatform('android')
    else setPlatform('other')
  }, [])

  // Order the two CTAs so the matching platform is primary. Desktop / unknown
  // shows both with equal weight.
  return (
    <div className="mt-10">
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <PendingStoreCard
          platform="ios_app_store"
          className={`glass w-full p-6 sm:max-w-sm${platform === 'android' ? ' order-last' : ''}`}
        />
        <Link
          href={route.downloadAndroid}
          className={platform === 'ios' ? 'btn-ghost w-full sm:w-auto' : 'btn-primary w-full sm:w-auto'}
        >
          <Smartphone size={16} />
          Download for Android
        </Link>
      </div>
      <p className="mt-5 text-sm leading-6 text-text-muted">
        Already have Provian? Open this link on your phone and it launches the app
        automatically. The promise terms are encrypted for its parties; the relay
        stores the signed promise state and ciphertext.
      </p>
      <Link
        href={route.download}
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-provian-blue-bright hover:text-text-primary"
      >
        All the ways to get Provian
        <ArrowUpRight size={14} />
      </Link>
    </div>
  )
}
