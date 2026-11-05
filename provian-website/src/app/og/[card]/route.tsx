// Share cards, rendered once at build time (static export) to /og/<card>.png.
// One per page, per film and per line (src/lib/og.ts). The Genesis card carries
// the days left as of the build.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { OG_CARDS, OG_SIZE, type OgCard } from '@/lib/og'
import { GENESIS_GRANTS } from '@/lib/genesisCopy'
import { genesisDaysLeft, isGenesisOpen } from '@/lib/genesis'

export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams(): { card: string }[] {
  return Object.keys(OG_CARDS).map((card) => ({ card: `${card}.png` }))
}

const VOID = '#06080f'
const TEXT = '#e8ecf4'
const SECONDARY = '#b4bccd'
const GOLD = '#f0bd5c'
const BLUE = '#6bb3ff'

async function font(pkg: string, file: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(process.cwd(), 'node_modules', '@fontsource', pkg, 'files', file))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

async function dataUrl(publicPath: string): Promise<string> {
  const buf = await readFile(path.join(process.cwd(), 'public', publicPath))
  // Sniff the bytes: provian-mark.png is a JPEG behind a .png name.
  const type = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg'
  return `data:${type};base64,${buf.toString('base64')}`
}

function headlineSize(card: OgCard): number {
  const n = card.headline.length
  if (card.layout === 'statement') return n <= 16 ? 150 : n <= 32 ? 104 : n <= 48 ? 84 : 68
  return n <= 20 ? 104 : n <= 40 ? 78 : n <= 56 ? 66 : 56
}

export async function GET(_req: Request, { params }: { params: { card: string } }) {
  const key = params.card.replace(/\.png$/, '')
  const card = OG_CARDS[key]
  if (!card) return new Response('Not found', { status: 404 })

  const [serif, mono, mark, background] = await Promise.all([
    font('source-serif-4', 'source-serif-4-latin-600-normal.woff'),
    font('jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff'),
    dataUrl('/provian-mark.png'),
    card.image ? dataUrl(card.image) : Promise.resolve(null),
  ])

  const accent = card.gold ? GOLD : BLUE
  const statement = card.layout === 'statement'
  const genesis = card.layout === 'genesis'
  const open = isGenesisOpen()
  const days = genesisDaysLeft()

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          backgroundColor: VOID,
          color: TEXT,
          fontFamily: 'Serif',
        }}
      >
        {background ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={background}
            alt=""
            width={OG_SIZE.width}
            height={OG_SIZE.height}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : null}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            backgroundImage: background
              ? 'linear-gradient(180deg, rgba(6,8,15,0.72) 0%, rgba(6,8,15,0.55) 40%, rgba(6,8,15,0.94) 100%)'
              : 'radial-gradient(60% 70% at 50% 0%, rgba(74,158,255,0.22) 0%, rgba(6,8,15,0) 70%), radial-gradient(70% 60% at 50% 110%, rgba(232,166,52,0.22) 0%, rgba(6,8,15,0) 70%)',
          }}
        />
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            width: '100%',
            height: '100%',
            padding: '56px 64px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div
              style={{
                display: 'flex',
                fontFamily: 'Mono',
                fontSize: 22,
                letterSpacing: 6,
                textTransform: 'uppercase',
                color: accent,
              }}
            >
              {genesis && !open ? 'Genesis' : card.eyebrow}
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mark} alt="" width={44} height={44} />
              <div
                style={{
                  display: 'flex',
                  marginLeft: 14,
                  fontFamily: 'Mono',
                  fontSize: 20,
                  letterSpacing: 7,
                  textTransform: 'uppercase',
                  color: TEXT,
                }}
              >
                Provian
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: statement ? 'center' : 'flex-start',
              textAlign: statement ? 'center' : 'left',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: headlineSize(card),
                lineHeight: 1.04,
                letterSpacing: -2,
                maxWidth: 1040,
              }}
            >
              {genesis && !open ? 'Genesis closed December 31, 2026.' : card.headline}
            </div>
            {card.sub ? (
              <div
                style={{
                  display: 'flex',
                  marginTop: 26,
                  fontFamily: 'Mono',
                  fontSize: 25,
                  lineHeight: 1.4,
                  color: SECONDARY,
                  maxWidth: 980,
                }}
              >
                {card.sub}
              </div>
            ) : null}
            {genesis && open ? (
              <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 30 }}>
                {GENESIS_GRANTS.map((g, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-end' }}>
                    {i > 0 ? (
                      <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 64, color: '#5f6a80', margin: '0 18px' }}>
                        /
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 84, lineHeight: 1, color: TEXT }}>
                      {g.amount}
                    </div>
                  </div>
                ))}
                <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 28, color: SECONDARY, marginLeft: 20, marginBottom: 8 }}>
                  PVT
                </div>
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontFamily: 'Mono',
              fontSize: 20,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: SECONDARY,
            }}
          >
            <div style={{ display: 'flex' }}>
              {genesis && open ? 'Through December 31, 2026' : 'provian.ai'}
            </div>
            {genesis && open ? (
              <div
                style={{
                  display: 'flex',
                  color: VOID,
                  backgroundColor: GOLD,
                  borderRadius: 999,
                  padding: '10px 22px',
                  letterSpacing: 3,
                }}
              >
                {days === 1 ? 'Last day' : `${days} days left`}
              </div>
            ) : (
              <div style={{ display: 'flex', color: TEXT }}>Proving provenance</div>
            )}
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: 'Serif', data: serif, weight: 600, style: 'normal' },
        { name: 'Mono', data: mono, weight: 500, style: 'normal' },
      ],
    },
  )
}
