// Shared renderer for the /privacy and /terms routes. Reads the vendored
// canonical markdown at build time and renders it with the site's prose styles.
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { loadLegalDoc, type LegalSlug } from '@/lib/legal'
import { route } from '@/lib/routes'

const OTHER: Record<LegalSlug, { label: string; href: string }> = {
  privacy: { label: 'Terms of Service', href: route.legalTerms },
  terms: { label: 'Privacy Policy', href: route.legalPrivacy },
}

export function LegalPage({ slug }: { slug: LegalSlug }) {
  const doc = loadLegalDoc(slug)
  const other = OTHER[slug]

  return (
    <div className="bg-void text-text-primary">
      <section className="relative overflow-hidden border-b border-white/10 px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-glow-blue-radial" />
        <div className="relative z-10 mx-auto max-w-4xl">
          <Link
            href={route.home}
            className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Provian
          </Link>
          <h1 className="mt-6 font-display text-4xl font-semibold leading-[1.02] tracking-[-0.03em] md:text-5xl">
            {doc.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-text-muted">
            {doc.lastUpdated && <span>Last updated: {doc.lastUpdated}</span>}
            <Link href={other.href} className="text-provian-blue-bright hover:underline">
              {other.label}
            </Link>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 md:px-10 md:py-16 lg:px-14">
        <div className="mx-auto max-w-4xl">
          <article className="prose-provian" dangerouslySetInnerHTML={{ __html: doc.html }} />
        </div>
      </section>
    </div>
  )
}
