// /protocol — the Provenance Envelope as an open protocol: anyone can build a witness for any
// work that can be witnessed, whatever it runs on. Every technical line here is checked against
// the code it names: the sovereign lane (POST /v1/pe/submit-sovereign, a hardware witness over
// the exact body, verified to its scheme's pinned root, beside the agent wallet's own signature),
// the SDK observer and registerPlugin (examples/sensor-gateway), the served schema
// (GET /v1/schema/pe and @provian/agent-sdk/schema/pe), the forge witnesses (GitHub and Bitbucket
// sign their webhooks; GitLab sends a per-webhook secret token, so the grid says "verified"), the
// receive rule (a payment mints for its receiver only from a counterparty the owner has dealt
// with) and the pending-policy queue behind /proposals (a never-seen type records with no mint
// and earns from the day its row is signed).
import Link from 'next/link'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { pageMeta } from '@/lib/og'
import { EMAIL, route } from '@/lib/routes'

export const metadata = pageMeta({
  title: 'The Provenance Envelope is an open protocol — Provian',
  description:
    'Anything that can be witnessed can leave a Provenance Envelope: a laptop, an agent, a GPU, a robot arm, a soil probe, a well pump. If something other than the doer can vouch for the work, you can build the envelope.',
  card: 'protocol',
  path: '/protocol/',
})

const REPO = 'https://github.com/LongevityManiac/provian'
const SPEC = `${route.library}/pe-protocol-spec`
const BUILD_A_PE = `${REPO}/tree/master/examples/build-a-pe`
const SENSOR_GATEWAY = `${REPO}/tree/master/examples/sensor-gateway`
const SCHEMA_URL = 'https://api.provian.ai/v1/schema/pe'

const SUBSTRATES: { work: string; witness: string; how: string }[] = [
  {
    work: 'Code',
    witness: 'the code host’s verified webhook',
    how: 'GitHub · GitLab · Bitbucket',
  },
  {
    work: 'An agent’s tool calls',
    witness: 'the observer reading its session',
    how: 'session files · proxy · OTel · process lane',
  },
  {
    work: 'A GPU job',
    witness: 'attested hardware',
    how: 'hardware_witness · nvidia_cc · tpm2_quote · aws_nitro',
  },
  {
    work: 'A line on a factory floor',
    witness: 'a witness box on the line',
    how: 'a registered machine running the observer',
  },
  {
    work: 'A soil probe',
    witness: 'an observer plugin on the farm’s gateway',
    how: 'registerPlugin · examples/sensor-gateway',
  },
  {
    work: 'A well pump',
    witness: 'a meter wired to a witness, and the payment for the water',
    how: 'observer plugin · on-chain settlement',
  },
  {
    work: 'Anything you can wire a witness to',
    witness: 'yours to build',
    how: 'the spec · the schema · the examples',
  },
]

const ASKS: { who: string; ask: string }[] = [
  { who: 'Device and chip makers', ask: 'ship the witness in the box.' },
  { who: 'Firmware and embedded engineers', ask: 'wire it to what you build.' },
  { who: 'Industrial and IoT platforms', ask: 'let the work your machines do be proven.' },
  { who: 'Agent and harness builders', ask: 'let the work be witnessed where it happens.' },
]

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-provian-blue-bright">{children}</code>
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-provian-blue-bright transition-colors hover:text-text-primary"
    >
      {children}
    </a>
  )
}

export default function ProtocolPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 pb-20 pt-16 md:px-10 md:pb-24 md:pt-24 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-glow-blue-radial" />
        <div className="relative mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">Protocol</p>
          <h1 className="mt-6 max-w-5xl font-display text-[2.7rem] font-semibold leading-[0.98] tracking-[-0.04em] md:text-7xl">
            The Provenance Envelope is <span className="gradient-text">an open protocol.</span>
          </h1>
          <p className="mt-7 max-w-3xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            Anything that can be witnessed can leave one. A laptop, an agent, a GPU, a robot arm, a
            soil probe, a well pump. If something other than the doer can vouch for the work, you can
            build the envelope.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Link href={SPEC} className="btn-primary">
              Read the spec
              <ArrowRight size={16} />
            </Link>
            <a href={BUILD_A_PE} target="_blank" rel="noopener noreferrer" className="btn-ghost">
              Build a PE
              <ArrowUpRight size={16} />
            </a>
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="btn-ghost">
              Source on GitHub
              <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
      </section>

      {/* ── One rule ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">One rule</p>
          <p className="mt-6 max-w-4xl font-display text-2xl leading-[1.35] text-text-primary md:text-4xl md:leading-[1.25]">
            A PE exists when something other than the doer vouches for the work.{' '}
            <span className="gradient-text">Nobody signs their own receipt.</span>
          </p>
          <div className="mt-8 max-w-4xl space-y-6 text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            <p>
              The witness can be a machine watching, a chip with its own key, a payment on chain, a code
              host, or the counterparty who received the work. That is the whole entry requirement.
            </p>
            <p className="text-text-primary">
              The substrate doesn’t matter. The process doesn’t matter. Witnessed work is witnessed work.
            </p>
          </div>
        </div>
      </section>

      {/* ── Any substrate ── */}
      <section className="border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">Any substrate</p>
          <div className="mt-8 grid grid-cols-[1fr_auto_1fr] gap-x-4 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted md:gap-x-8 md:text-xs">
            <span>The work</span>
            <span aria-hidden className="w-5" />
            <span>Its witness</span>
          </div>
          <ul className="mt-3">
            {SUBSTRATES.map((s, i) => (
              <li
                key={s.work}
                className="grid grid-cols-[1fr_auto_1fr] items-start gap-x-4 border-t border-white/12 py-6 md:gap-x-8"
              >
                <p
                  className={`font-display text-xl font-semibold tracking-[-0.02em] md:text-3xl ${
                    i === SUBSTRATES.length - 1 ? 'text-provian-gold-bright' : ''
                  }`}
                >
                  {s.work}
                </p>
                <ArrowRight className="mt-1.5 h-5 w-5 text-provian-blue-bright md:mt-2.5" aria-hidden />
                <div>
                  <p className="text-lg leading-7 text-text-primary md:text-xl md:leading-8">{s.witness}</p>
                  <p className="mt-2 font-mono text-[11px] leading-5 tracking-[0.04em] text-text-muted">{s.how}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Build a witness ── */}
      <section id="build" className="scroll-mt-24 border-b border-white/10 bg-surface px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Build a witness</p>
          <h2 className="mt-5 font-display text-3xl font-semibold tracking-[-0.03em] md:text-5xl">
            Three ways in, all open.
          </h2>
          <ol className="mt-10 grid gap-5 lg:grid-cols-3">
            <li className="glass flex flex-col p-7 md:p-8">
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">01</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em] md:text-2xl">
                An observer plugin.
              </h3>
              <p className="mt-3 flex-1 text-base leading-7 text-text-secondary">
                Register a machine, run the observer, add a plugin for your device with{' '}
                <Code>registerPlugin</Code>. Every reading becomes an envelope on that machine, and rides
                its signed daily batch.
              </p>
              <p className="mt-5 text-sm leading-6 text-text-muted">
                <Ext href={SENSOR_GATEWAY}>examples/sensor-gateway</Ext>
              </p>
            </li>
            <li className="glass flex flex-col p-7 md:p-8">
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">02</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em] md:text-2xl">
                A hardware root.
              </h3>
              <p className="mt-3 flex-1 text-base leading-7 text-text-secondary">
                The device’s hardware signs the work with a key the doer doesn’t hold, verified against
                its scheme’s public root, and the device’s agent wallet submits it over plain HTTP. The
                wallet’s own signature alone is refused.
              </p>
              <p className="mt-5 text-sm leading-6 text-text-muted">
                <Code>POST /v1/pe/submit-sovereign</Code>
              </p>
            </li>
            <li className="glass flex flex-col p-7 md:p-8">
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-muted">03</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em] md:text-2xl">
                The world around it.
              </h3>
              <p className="mt-3 flex-1 text-base leading-7 text-text-secondary">
                A payment for the work settles on chain. A counterparty cites an output the device
                signed. Both are witnesses with no plugin at all.
              </p>
              <p className="mt-5 text-sm leading-6 text-text-muted">
                A payment mints for its receiver once the payer is a counterparty the owner has dealt
                with. A citation counts toward the producer’s record and pays nothing.
              </p>
            </li>
          </ol>
        </div>
      </section>

      {/* ── What's open ── */}
      <section className="border-b border-white/10 px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">What’s open</p>
          <ul className="mt-8 grid gap-3 text-base leading-7 text-text-secondary md:grid-cols-2">
            <li className="rounded-lg border border-white/10 bg-black/25 px-5 py-4">
              <Link href={SPEC} className="font-semibold text-provian-blue-bright transition-colors hover:text-text-primary">
                The PE Protocol Specification
              </Link>{' '}
              in the Library.
            </li>
            <li className="rounded-lg border border-white/10 bg-black/25 px-5 py-4">
              The schema: <Ext href={SCHEMA_URL}>GET /v1/schema/pe</Ext>, and{' '}
              <code className="font-mono text-text-primary">@provian/agent-sdk/schema/pe</code>.
            </li>
            <li className="rounded-lg border border-white/10 bg-black/25 px-5 py-4">
              The <Ext href="https://www.npmjs.com/package/@provian/agent-sdk">SDK</Ext>,{' '}
              <Ext href="https://www.npmjs.com/package/@provian/cli">CLI</Ext>,{' '}
              <Ext href="https://www.npmjs.com/package/@provian/mcp">MCP server</Ext> and{' '}
              <Ext href={`${REPO}/tree/master/contracts`}>contracts</Ext>, MIT.
            </li>
            <li className="rounded-lg border border-white/10 bg-black/25 px-5 py-4">
              Worked examples: <Ext href={BUILD_A_PE}>build-a-pe</Ext>,{' '}
              <Ext href={SENSOR_GATEWAY}>sensor-gateway</Ext>.
            </li>
            <li className="rounded-lg border border-white/10 bg-black/25 px-5 py-4">
              New kinds of work: witness one and it goes up for review in the open at{' '}
              <Link href="/proposals" className="text-provian-blue-bright transition-colors hover:text-text-primary">
                /proposals
              </Link>
              . It records from the first reading and earns from the day its row is signed.
            </li>
          </ul>
        </div>
      </section>

      {/* ── Who we're asking ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-20 md:px-10 md:py-24 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Who we’re asking</p>
          <ul className="mt-8 grid gap-x-10 gap-y-8 md:grid-cols-2">
            {ASKS.map((a) => (
              <li key={a.who} className="border-t border-white/15 pt-5">
                <p className="font-display text-xl font-semibold tracking-[-0.02em] md:text-2xl">{a.who}:</p>
                <p className="mt-2 text-lg leading-8 text-text-secondary">{a.ask}</p>
              </li>
            ))}
          </ul>
          <p className="mt-12 max-w-3xl text-lg leading-8 text-text-secondary">
            Start with the <Link href={SPEC} className="text-provian-blue-bright transition-colors hover:text-text-primary">spec</Link>{' '}
            and the <Ext href={`${REPO}/tree/master/examples`}>examples</Ext>. For anything deeper:{' '}
            <a href={`mailto:${EMAIL}`} className="font-mono text-provian-blue-bright transition-colors hover:text-text-primary">
              {EMAIL}
            </a>
          </p>
        </div>
      </section>

      {/* ── Why it matters ── */}
      <section className="relative overflow-hidden px-6 py-24 md:px-10 md:py-32 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] bg-glow-amber-radial" />
        <div className="relative mx-auto max-w-4xl text-center">
          <p className="eyebrow text-provian-gold-bright">Why it matters</p>
          <p className="mt-8 text-lg leading-8 text-text-secondary md:text-2xl md:leading-10">
            Every envelope belongs to whoever did the work, and witnessed work mints PVT for them. The
            woman at the well pump does work the world depends on, and right now none of it counts.{' '}
            <span className="text-text-primary">Build the witness and it does.</span>
          </p>
          <p className="mt-12 font-display text-3xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
            Compute mints money. <span className="gradient-text">No one gets left behind.</span>
          </p>
        </div>
      </section>
    </div>
  )
}
