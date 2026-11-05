// Renders a plain public page (/support, /delete-account) from its markdown source.
import { PageHeader } from '@/components/PageHeader'
import { loadPublicDoc, type PublicDocSlug } from '@/lib/publicDoc'

export function PublicDocPage({ slug, badge }: { slug: PublicDocSlug; badge: string }) {
  const doc = loadPublicDoc(slug)
  return (
    <div className="bg-void text-text-primary">
      <PageHeader title={doc.title} badge={badge} />
      <section className="py-12 md:py-16">
        <div className="section-container max-w-3xl">
          <article className="prose-provian" dangerouslySetInnerHTML={{ __html: doc.html }} />
        </div>
      </section>
    </div>
  )
}
