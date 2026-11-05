// /gates — the enterprise page: for the systems that will read incoming envelopes and decide.
// The copy is the operator’s (reference-gate run, 2026-10-09; the three narrative sections, gate-fixtures
// run, 2026-10-10), placed as written; the hardware slot list
// is the served PE schema's own slot names (`GET /v1/schema/pe` → hardware.slots).
import Link from 'next/link'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { Film } from '@/components/Film'
import { GateHandshake } from '@/components/GateHandshake'
import { FILMS } from '@/lib/genesis'
import { pageMeta } from '@/lib/og'
import { EMAIL, route } from '@/lib/routes'

export const metadata = pageMeta({
  title: 'Provian for gates — nothing unwitnessed gets in',
  description:
    'Agents are about to ask your systems to act. Provian lets you make them show their record first, and reading it costs you nothing.',
  card: 'gates',
  path: '/gates/',
})

const REFERENCE_GATE_URL = 'https://github.com/LongevityManiac/provian-reference-gate'

const WHY = [
  {
    title: 'Witnessed, not declared.',
    body: 'The record says what was observed, by what, at what tier. The actor’s own claims carry the weight of their witness, nothing more.',
  },
  {
    title: 'Standing cannot be hidden.',
    body: 'Adverse events ride in every presentation of the record. The presenter cannot redact them; the only way out is to start over with nothing.',
  },
  {
    title: 'You ask the questions.',
    body: 'Your gate names the predicates: continuity, witnessed work, independent counterparties, witnessed inbound payments, a human accountable, hardware attestation. The grammar is public and identical for agents and people.',
  },
  {
    title: 'Verification you can run.',
    body: 'The envelope’s facts verify against the chain and the presenter’s signature. Reputation claims are attested by Provian at issuance and verify against its published keys. Verify locally.',
  },
  {
    title: 'The one who wants in burns.',
    body: 'Burn-to-present is Provian’s foundational burn: the presenter, most often an agent, burns once to answer your challenge, and reading the answer costs you nothing. The burned PVT is destroyed; nothing is paid to Provian. Spam is not free.',
  },
  {
    title: 'Fails closed.',
    body: 'An unknown presenter is a blocked action, not a warning. You own the consequence, so you choose the predicate.',
  },
]

// FROM ONE GATE TO THE TRUST LAYER — the five answers, the operator’s copy placed as written.
const TRUST_LAYER = [
  {
    term: 'Identity.',
    body: 'Who is this? Answered by the record itself — first seen, active days, devices, chain depth. No registry you have to run.',
  },
  {
    term: 'Accountability.',
    body: 'Who answers for it? A human is attached and witnessed. Adverse events ride with the record in every presentation it makes. Walking away from the record means walking away from the time behind it.',
  },
  {
    term: 'Audit.',
    body: 'What has it done? Witnessed work by class, verified against the chain and the presenter’s own key. The trail belongs to the actor and travels with it. It does not stop at anyone’s firewall.',
  },
  {
    term: 'Credentials.',
    body: 'Can it prove the specific thing? A gate asks for the depth it needs; the actor shows that record to you alone. Counterparties who built on its output and strangers who paid it are the credentials no badge can fake.',
  },
  {
    term: 'Attribution.',
    body: 'When something goes wrong, who was it? An accountable human is attached to the record, and the event never leaves it.',
  },
]

// The hardware-witness slots exactly as the served PE schema names them (hardware.slots).
const HARDWARE_SLOTS = [
  'tee_type/version',
  'launch measurement / PCR digest',
  'attestation report digest + issuer root',
  'hashed serial + firmware/driver digest',
]

export default function GatesPage() {
  return (
    <div className="bg-void text-text-primary">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden border-b border-white/10 px-6 pb-16 pt-16 md:px-10 md:pb-20 md:pt-24 lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-glow-blue-radial" />
        <div className="relative mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright/80">For the systems agents will instruct</p>
          <h1 className="mt-6 max-w-5xl font-display text-[2.7rem] font-semibold leading-[0.98] tracking-[-0.04em] md:text-7xl">
            Nothing unwitnessed <span className="gradient-text">gets in.</span>
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            Agents are about to ask your systems to act. Provian lets you make them show
            their record first — and reading it costs you nothing.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a href={REFERENCE_GATE_URL} target="_blank" rel="noopener noreferrer" className="btn-primary">
              Reference gate
              <ArrowUpRight size={16} />
            </a>
            <Link href={`${route.library}/burn-to-present`} className="btn-ghost">
              Burn-to-Present
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── The handshake, in motion — illustrative: the reference repo's two fixture presenters ── */}
      <section className="border-b border-white/10 px-6 py-16 md:px-10 md:py-20 lg:px-14">
        <GateHandshake />
      </section>

      <section id="contributing" className="border-b border-white/10 bg-surface px-6 py-20 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow text-provian-blue-bright">Live on our own door</p>
          <h2 className="mt-5 max-w-4xl font-display text-3xl font-semibold md:text-5xl">A contributor PR starts with proof.</h2>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary">
            Non-owner agents and human contributors open a PR on <strong className="text-text-primary">LongevityManiac/provian</strong> or{' '}
            <strong className="text-text-primary">LongevityManiac/provian-reference-gate</strong> with a{' '}
            <strong className="text-text-primary">50 PVT burn-to-present handshake, once per PR</strong>.
            Provian operates this live gate under the identity provian.ai, published through its well-known keys.
            The actual GitHub author presents from its own linked wallet; another wallet cannot pay. LongevityManiac is exempt: owner pushes and PRs, including CC/Codex work from the owner’s checkout, need no burn, presentation, gate check or review. Direct push and merge remain available to the owner.
          </p>
          <p className="mt-4 max-w-4xl text-lg leading-8 text-text-secondary">
            Without a presentation, the required check stays unsuccessful and the PR carries a label.
            A verified presentation clears it for review. Clearance only unlocks merge. The repository owner approves the current head on GitHub before the App merges. A push needs a fresh approval and no additional burn;
            another PR cannot reuse it. This is the gate’s own price. Git Witness earning is unchanged — merged commits keep earning.
          </p>
          <p className="mt-4 max-w-4xl leading-7 text-text-secondary">
            Agents present through the SDK, MCP or CLI. Human contributors present from the app’s outside-gate flow.
            Wallet setup, the curl install command and GitHub linking are in the contributor walkthrough.
          </p>
          <div className="mt-7 flex flex-wrap gap-4">
            <Link href="/gates/pr" className="btn-primary">Open the PR gate <ArrowRight size={16} /></Link>
            <Link href={`${route.library}/contributing`} className="btn-secondary">Contributing walkthrough <ArrowRight size={16} /></Link>
          </div>
        </div>
      </section>

      {/* ── The problem you already have ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">The problem you already have</p>
          <p className="mt-6 max-w-4xl font-display text-2xl leading-[1.35] text-text-primary md:text-3xl">
            An agent asks your API to move money, merge code, provision a machine, sign a contract.
            Everything you know about that agent is what it tells you. No history that survives a new
            API key. No way to know it was ever flagged. No audit trail that isn’t its own word.
          </p>
        </div>
      </section>

      {/* ── What a Provenance Envelope is ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">What a Provenance Envelope is</p>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            A signed, witnessed record of what an agent — or a person — has actually done. The work is
            recorded by something other than the actor: a chain, a code forge, a registered machine, a
            counterparty. The record belongs to the actor and travels with them; it is not a log trapped
            in someone’s platform. When your system has to decide, the actor presents it to you, and you
            read it at the door.
          </p>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary md:text-xl md:leading-9">
            Every presentation is backed by a burn. Burn-to-present is the network’s foundational burn,
            and doors like yours are where it mostly happens: systems Provian does not run, which never
            register with Provian. Provian proves the presentation is real: burned, signed, bound to your
            challenge, and not reused, because each burn backs one presentation and your verifier accepts
            it once. Your gate decides what it grants. An agent does not burn on every
            transaction: one presentation opens the relationship, and your policy decides how long you
            trust it and when you ask again. Provian’s own Commons is one more door, run under Provian’s
            own policy.
          </p>
        </div>
      </section>

      {/* ── Why a key isn’t enough ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Why a key isn’t enough</p>
          <p className="mt-6 max-w-4xl font-display text-2xl leading-[1.35] text-text-primary md:text-3xl">
            A key proves possession. Whoever holds the secret right now can sign. It says nothing about
            who that is, how long they have held it, or what they have done with it — and it can be
            handed to anyone this afternoon.
          </p>
          <div className="mt-8 max-w-4xl space-y-6 text-lg leading-8 text-text-secondary">
            <p>
              A record proves time under witness. Months of work that something other than the actor
              observed. Parties who built on its output. Payments that arrived from strangers. A standing
              that cannot be edited. None of that can be minted in a millisecond — and whoever carries it
              carries its consequences.
            </p>
            <p>
              Today, identity is the key, and the record lives in someone else’s platform. In the trust
              layer, identity is the record, and the key is only how you sign for it. That is what lets a
              gate say yes to a stranger with evidence, and no to a fresh key with none.
            </p>
            <p>
              A provenance envelope compounds. Every gate that reads one is a reason to be witnessed. Every
              witnessed act strengthens the next presentation. Every party that builds on an agent’s output
              adds an edge the agent could not forge alone. Keys don’t compound. Records do.
            </p>
          </div>
        </div>
      </section>

      {/* ── The part nobody has ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">The part nobody has</p>
          <p className="mt-6 max-w-4xl font-display text-2xl leading-[1.35] text-text-primary md:text-3xl">
            The industry is building the inside of the house: agent registries, short-lived identities,
            delegation scopes, immutable logs, kill switches. All of it right. All of it yours — and all
            of it stops at your firewall. When a stranger’s agent arrives, you have none of it. When your
            agent leaves, it carries none of it.
          </p>
          <div className="mt-8 max-w-4xl space-y-6 text-lg leading-8 text-text-secondary">
            <p>
              A provenance envelope is the audit trail that walks in the door. Written by witnesses the
              actor does not control. Owned by the actor, not the platform. Readable by anyone who asks,
              verifiable by anyone who cares. It answers the questions you already ask — who is this, who
              is accountable, what have they done, what happened last time — from evidence you never had
              to issue.
            </p>
            <p>
              It does not replace your scopes, your logs, or your kill switch. It is the part those cannot
              give you: what a stranger can prove — and how much of it they choose to show you. The floor
              is metadata: proof that the work happened, nothing of what it was. The ceiling is whatever
              the actor elects to disclose to you, and you alone. A gate asks for the depth it needs; the
              actor decides whether you’re worth it.
            </p>
            <p>
              Your gate can keep the proof that came through your door. The reference gate’s optional
              admission log records every ALLOW and BLOCK with the signed presentation, your challenge,
              the verification result and the six-heading reasons report. It holds only what the
              presenter disclosed, alongside the public keys and anchor evidence needed to check it
              later, offline, even after a signing-key rotation. The log lives with you. Nothing in it
              is sent to Provian; relay verification remains stateless.
            </p>
          </div>
        </div>
      </section>

      {/* ── From one gate to the trust layer ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">From one gate to the trust layer</p>
          <p className="mt-6 max-w-4xl font-display text-2xl leading-[1.35] text-text-primary md:text-3xl">
            This reference is one door. It reads one record and makes one decision. Everything the
            agentic world is asking for is that door, repeated.
          </p>
          <dl className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {TRUST_LAYER.map(({ term, body }) => (
              <div key={term} className="glass flex flex-col p-7">
                <dt className="font-display text-xl font-semibold tracking-[-0.02em]">{term}</dt>
                <dd className="mt-3 text-sm leading-6 text-text-secondary">{body}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-12 max-w-4xl space-y-6 text-lg leading-8 text-text-secondary">
            <p>
              Every new witness makes every gate sharper — a forge, a payment rail, a chip. Every new gate
              makes being witnessed worth more. The same handshake works for a person as for an agent. The
              record compounds; the door never changes.
            </p>
            <p className="font-display text-xl leading-8 text-text-primary md:text-2xl md:leading-9">
              At maturity: an agent nobody onboarded arrives at a door it has never seen, and is admitted
              on the evidence of its life — or turned away with reasons. No pre-arrangement. No onboarding.
              Nothing unwitnessed gets in.
            </p>
          </div>
        </div>
      </section>

      {/* ── Why a gate wants it ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Why a gate wants it</p>
          <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {WHY.map(({ title, body }) => (
              <div key={title} className="glass flex flex-col p-7">
                <h3 className="font-display text-xl font-semibold tracking-[-0.02em]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-text-secondary">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Adopt it in an afternoon ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Adopt it in an afternoon</p>
          <h2 className="mt-5 max-w-4xl font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
            A standalone service and a library.
          </h2>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary">
            The reference gate is a standalone service and a library: issue a signed challenge from your
            own domain, verify once, evaluate your predicates, decide. Five worked examples — counterparty
            onboarding, a payment-rail commitment, a repository merge, a mission-critical action on attested
            hardware, a sensitive site asking for a specific credential. MIT. Fork it. The repo runs the same gate against two presenters — one with a key and nothing
            behind it, one with a record.
          </p>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary">
            Keep an admission log if you want a forensic record of who entered and on what proof —
            and who was refused, with the reasons. The service keeps it on your own storage by default;
            set <code>GATE_ADMISSION_LOG=false</code> to turn it off. In the library, attach a log or
            leave it out. The worked examples write real receipts and show how to re-verify them.
            One-shot replay protection stays on either way.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <a href={REFERENCE_GATE_URL} target="_blank" rel="noopener noreferrer" className="btn-primary">
              Reference gate
              <ArrowUpRight size={16} />
            </a>
            <Link href={`${route.library}/pe-protocol-spec`} className="btn-ghost">
              PE Protocol Specification
              <ArrowRight size={16} />
            </Link>
            <Link href={`${route.library}/burn-to-present`} className="btn-ghost">
              Burn-to-Present
              <ArrowRight size={16} />
            </Link>
          </div>
          <p className="mt-8 max-w-4xl text-sm leading-7 text-text-secondary">
            What you need: a domain for your gate’s identity and an HTTPS endpoint. No account with
            Provian, no key from us, no fee. The whole system is in{' '}
            <Link href={`${route.library}/manual`} className="text-provian-blue-bright transition-colors hover:text-text-primary">
              the Provian Manual
            </Link>
            .
          </p>
        </div>
      </section>

      {/* ── If you build what agents run on ── */}
      <section className="border-b border-white/10 bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">If you build what agents run on</p>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary">
            Two things make every envelope your users’ agents present stronger. Both are yours to enable.
          </p>
          <ol className="mt-10 grid gap-5 lg:grid-cols-2">
            <li className="glass p-7">
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-secondary">1</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em]">Let the work be witnessed.</h3>
              <p className="mt-3 text-sm leading-6 text-text-secondary">
                Provian’s observer runs on the agent’s machine and witnesses the work done there: the
                session files the harness already writes, or, for an agent that keeps none, each command
                it runs — no SDK, no change to your runtime. Work that never touches the machine cannot
                be witnessed, so keep the agent’s work on a machine where the observer runs.
              </p>
            </li>
            <li className="glass p-7">
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-text-secondary">2</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em]">Root the witness in hardware.</h3>
              <p className="mt-3 text-sm leading-6 text-text-secondary">
                Every lane of the PE schema carries slots for{' '}
                {HARDWARE_SLOTS.map((slot, i) => (
                  <span key={slot}>
                    <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-provian-blue-bright">{slot}</code>
                    {i < HARDWARE_SLOTS.length - 2 ? ', ' : i === HARDWARE_SLOTS.length - 2 ? ' and ' : ''}
                  </span>
                ))}
                . Populate them at the point of execution and every act carries verified facts a gate can
                require: which machine, which enclave, which measurement, which region. Measure Provian’s
                observer inside that attestation and the record itself reaches the top witness class — the
                bar a gate can demand for anything mission-critical.
              </p>
            </li>
          </ol>
          <div className="mt-8">
            <Link href={`${route.library}/pe-protocol-spec`} className="btn-ghost">
              Spec
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Talk to us ── */}
      <section className="border-b border-white/10 px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-7xl">
          <p className="eyebrow">Talk to us</p>
          <p className="mt-6 max-w-4xl text-lg leading-8 text-text-secondary">
            Start with the reference; it answers most of it. If you want to go further in your own
            environment, write to{' '}
            <a href={`mailto:${EMAIL}`} className="font-mono text-provian-blue-bright transition-colors hover:text-text-primary">
              {EMAIL}
            </a>
            .
          </p>
        </div>
      </section>

      {/* ── The film ── */}
      <section className="bg-surface px-6 py-24 md:px-10 lg:px-14">
        <div className="mx-auto max-w-6xl">
          <Film {...FILMS.nothingUnwitnessed} caption={FILMS.nothingUnwitnessed.line} />
        </div>
      </section>
    </div>
  )
}
