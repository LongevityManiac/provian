export function PageHeader({
  title,
  subtitle,
  badge,
  heroImage,
}: {
  title: string
  subtitle?: string
  badge?: string
  heroImage?: string
}) {
  return (
    <div className="relative">
      {heroImage && (
        <div className="absolute inset-0 h-[50vh] overflow-hidden">
          <img
            src={heroImage}
            alt=""
            className="w-full h-full object-cover opacity-30"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-void/60 via-void/80 to-void" />
        </div>
      )}
      <div className={`relative ${heroImage ? 'pt-40 pb-20' : 'pt-32 pb-16'} section-container`}>
        {badge && (
          <div className="inline-block px-3 py-1 rounded-full text-xs font-mono text-provian-blue border border-provian-blue/30 bg-provian-blue/5 mb-6 uppercase tracking-wider">
            {badge}
          </div>
        )}
        <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold text-text-primary tracking-tight leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-6 text-lg md:text-xl text-text-secondary max-w-3xl leading-relaxed">
            {subtitle}
          </p>
        )}
        <div className="glow-line mt-12" />
      </div>
    </div>
  )
}
