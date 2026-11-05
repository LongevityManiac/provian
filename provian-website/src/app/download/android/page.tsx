// /download/android — Android APK distribution page.
//
// The signed release APK is served next to this page at /download/<file>.apk
// (nginx sets the application/vnd.android.package-archive type + forces a
// download). The binary is not committed to git. Build it via
// scripts/build-android-release.sh, which keeps signing secrets out of argv/logs,
// publish it with provian-website/scripts/publish-android-apk.sh, and stamp the
// values that script prints. Every site build fetches the APK named by VERSION and
// APK_SHA256 below from the release bucket and refuses to build if it is missing
// or its size or hash differ (scripts/release-apk.mjs reads these constants).
import type { Metadata } from 'next'
import Link from 'next/link'
import { Download, ShieldCheck, ArrowLeft, Fingerprint } from 'lucide-react'
import { EMAIL, route } from '@/lib/routes'

export const metadata: Metadata = {
  title: 'Download Provian for Android (APK)',
  description:
    'Install the Provian Android app directly from the signed APK. Includes the SHA-256 checksum, version, and sideload instructions.',
}

// ── Launch APK facts (keep in sync with the built artifact) ──────────────────
const VERSION = '1.0.0'
const VERSION_CODE = 90
const APK_FILE = `provian-wallet-${VERSION}.apk`
const APK_URL = `/download/${APK_FILE}`
const APK_SHA256 = '8d0e93aba7afe5d42da6297f1802766c81ce0221ecc25311a4ff204384a4f972'
const APK_SIZE = '181,707,487 bytes (≈173 MB)'
const MIN_ANDROID = 'Android 7.0 (Nougat) or later'
const PACKAGE = 'com.provian.wallet'
// Launch signing key; matches /.well-known/assetlinks.json.
const SIGNING_SHA256 =
  'CB:E7:BD:D0:0C:32:EF:85:97:78:B1:99:D5:1E:B7:15:90:D1:D0:DD:10:0E:2E:CB:55:93:D9:DD:8A:F4:63:5A'

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Download the APK',
    body: 'Tap the button above and let the download finish. It is a large file (~170 MB), so use Wi-Fi if you can.',
  },
  {
    title: 'Open the downloaded file',
    body: `Tap the download notification, or open Files / Downloads and tap ${APK_FILE}.`,
  },
  {
    title: 'Allow this one source',
    body: 'Android will say the app can’t be installed because installing unknown apps from this source isn’t allowed. Tap Settings, then turn on “Allow from this source” for your browser or Files app. You are permitting this one app, not weakening the whole phone.',
  },
  {
    title: 'Install, then open Provian',
    body: 'Go back and tap Install. When it finishes, open Provian and create your wallet.',
  },
]

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">{label}</p>
      <p className="mt-1 break-all font-mono text-sm text-text-secondary">{value}</p>
    </div>
  )
}

export default function DownloadAndroidPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />

      <section className="relative z-10 mx-auto max-w-4xl px-6 pb-28 pt-28 md:px-10 md:pt-36">
        <Link
          href={route.download}
          className="inline-flex items-center gap-2 text-sm font-semibold text-provian-blue-bright transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={15} />
          Get the app
        </Link>

        <p className="eyebrow mt-6 text-provian-blue-bright/80">Android · Direct APK</p>
        <h1 className="mt-4 max-w-3xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.04em] md:text-6xl">
          Install Provian on Android.
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl">
          Provian for Android installs straight from a signed APK &mdash; no store account
          needed. {MIN_ANDROID}.
        </p>

        <div className="mt-10">
          <a href={APK_URL} className="btn-primary" rel="noopener noreferrer" download>
            Download the APK
            <Download size={16} />
          </a>
          <p className="mt-3 font-mono text-xs text-text-muted">
            {APK_FILE} · v{VERSION} · {APK_SIZE}
          </p>
        </div>

        {/* Desktop → phone bridge: scan to open this page on the Android device.
            Hidden on phones (they are already on the device). */}
        <div className="glass mt-8 hidden items-center gap-6 p-6 md:flex">
          <img
            src="/download/qr-android.svg"
            alt="QR code that links to this Android download page"
            width={128}
            height={128}
            className="h-32 w-32 shrink-0 rounded-lg bg-white p-2"
          />
          <div>
            <p className="font-display text-lg font-semibold text-text-primary">On a computer?</p>
            <p className="mt-1.5 max-w-md leading-7 text-text-secondary">
              Scan this code with your Android phone&rsquo;s camera to open this page on the
              device, then tap Download.
            </p>
          </div>
        </div>

        {/* Verify the download — checksum + signing fingerprint. */}
        <div className="glass mt-12 p-7 md:p-9">
          <div className="flex items-center gap-2.5">
            <ShieldCheck size={18} className="text-provian-blue-bright" />
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">Verify your download</h2>
          </div>
          <p className="mt-3 leading-7 text-text-secondary">
            Before you install, confirm the file is exactly what we published. On a Mac or Linux
            machine, run <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-sm text-provian-blue-bright">shasum -a 256 {APK_FILE}</code> (or
            <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-sm text-provian-blue-bright"> sha256sum</code>) and check it matches:
          </p>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="SHA-256" value={APK_SHA256} />
            <Field label="Size" value={APK_SIZE} />
            <Field label="Version" value={`${VERSION} (versionCode ${VERSION_CODE})`} />
            <Field label="Package" value={PACKAGE} />
          </div>
          <div className="mt-6 flex items-start gap-2.5 border-t border-white/8 pt-5">
            <Fingerprint size={17} className="mt-0.5 shrink-0 text-text-muted" />
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">
                Signing certificate (SHA-256)
              </p>
              <p className="mt-1 break-all font-mono text-sm text-text-secondary">{SIGNING_SHA256}</p>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                This is the same key pinned in our Android App Links file
                (<code className="font-mono text-xs">/.well-known/assetlinks.json</code>), so promise links
                open the app you installed.
              </p>
            </div>
          </div>
        </div>

        {/* Sideload instructions. */}
        <div className="glass mt-12 p-7 md:p-9">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">How to install</h2>
          <ol className="mt-6 space-y-6">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="marker mt-1 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <p className="font-display text-lg font-semibold text-text-primary">{step.title}</p>
                  <p className="mt-1.5 leading-7 text-text-secondary">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <p className="mt-10 text-sm leading-7 text-text-muted">
          Trouble installing? Email{' '}
          <a
            href={`mailto:${EMAIL}`}
            className="text-provian-blue-bright transition-colors hover:text-text-primary"
          >
            {EMAIL}
          </a>
          .
        </p>
      </section>
    </div>
  )
}
