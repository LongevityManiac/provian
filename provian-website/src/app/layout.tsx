import type { Metadata } from 'next'
import { Hanken_Grotesk, Source_Serif_4, JetBrains_Mono } from 'next/font/google'
import { Navigation } from '@/components/Navigation'
import { Footer } from '@/components/Footer'
import { HEAD_SCRIPT } from '@/lib/genesis'
import { ogImages } from '@/lib/og'
import './globals.css'

const hankenGrotesk = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

const OG_DESCRIPTION =
  'The Trust Layer for the Intelligence Economy. Useful work leaves a receipt you own, and the receipt mints money. Compute mints money. No one gets left behind.'

export const metadata: Metadata = {
  metadataBase: new URL('https://provian.ai'),
  title: 'Provian — Proving provenance',
  description: OG_DESCRIPTION,
  // Every page names its own trailing-slash URL as canonical ('./' resolves
  // against each route's pathname), so Google stops treating the slash and
  // no-slash forms as unclaimed duplicates.
  alternates: { canonical: './' },
  openGraph: {
    type: 'website',
    url: 'https://provian.ai',
    siteName: 'Provian',
    title: 'Provian — Proving provenance',
    description: OG_DESCRIPTION,
    images: ogImages('home'),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Provian — Proving provenance',
    description: OG_DESCRIPTION,
    images: [ogImages('home')[0].url],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${hankenGrotesk.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}>
      <head>
        <meta name="robots" content="index, follow" />
        <meta name="googlebot" content="index, follow" />
        <script dangerouslySetInnerHTML={{ __html: HEAD_SCRIPT }} />
      </head>
      <body className="font-body min-h-screen">
        <Navigation />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  )
}
