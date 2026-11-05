import type { ReactNode } from 'react'
import Link from 'next/link'
import { ShareControl } from '@/components/ShareControl'
import { LINE_ORDER } from '@/lib/lines'
import { linePath } from '@/lib/routes'

// A statement screen: one line in large serif on an empty screen, with a share
// control. The line links to its own /lines/<slug>/ page, so the line itself
// is the thing shared.
export function Statement({
  line,
  slug,
  children,
  align = 'center',
  tone = 'void',
  as: Heading = 'h2',
}: {
  line: ReactNode
  // The line's slug: its /lines/<slug>/ page, whose words the share carries.
  slug: string
  children?: ReactNode
  align?: 'center' | 'left'
  tone?: 'void' | 'surface'
  as?: 'h1' | 'h2'
}) {
  const centered = align === 'center'
  const shareText = LINE_ORDER.find((l) => l.slug === slug)?.line
  return (
    <section
      className={`relative overflow-hidden border-b border-white/10 px-6 md:px-10 lg:px-14 ${
        tone === 'surface' ? 'bg-surface' : ''
      }`}
    >
      <div
        className={`mx-auto flex min-h-[64svh] max-w-7xl flex-col justify-center py-20 ${
          centered ? 'items-center text-center' : 'items-start text-left'
        }`}
      >
        <Heading className="statement max-w-6xl">
          <Link href={linePath(slug)} className="transition-opacity hover:opacity-90">
            {line}
          </Link>
        </Heading>
        {children ? (
          <div
            className={`mt-10 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9 ${
              centered ? 'mx-auto' : ''
            }`}
          >
            {children}
          </div>
        ) : null}
        <div className="mt-8">
          <ShareControl
            path={linePath(slug)}
            title={shareText ?? 'Provian'}
            text={shareText}
            label="Share this line"
          />
        </div>
      </div>
    </section>
  )
}
