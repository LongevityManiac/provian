// /lines — the share lines, each linking to its own page.
import Link from 'next/link'
import { LINE_ORDER } from '@/lib/lines'
import { pageMeta } from '@/lib/og'
import { linePath } from '@/lib/routes'

export const metadata = pageMeta({
  title: 'Lines | Provian',
  description: 'Provian in five lines.',
  card: 'line-compute-mints-money',
  path: '/lines/',
})

export default function LinesPage() {
  return (
    <div className="bg-void px-6 pb-24 pt-20 text-text-primary md:px-10 md:pt-28 lg:px-14">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow text-provian-blue-bright/80">Lines</p>
        <ul className="mt-10">
          {LINE_ORDER.map((line) => (
            <li key={line.slug} className="border-t border-white/10 py-12 md:py-16">
              <Link href={linePath(line.slug)} className="group block">
                <span className="block font-display text-4xl font-semibold leading-[1.05] tracking-[-0.03em] transition-colors group-hover:text-provian-blue-bright md:text-6xl">
                  {line.line}
                </span>
                <span className="mt-5 block max-w-3xl text-lg leading-8 text-text-secondary">{line.sentence}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
