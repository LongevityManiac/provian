#!/usr/bin/env node
/**
 * sync-docs.mjs - vendor the published Library from the repo into the website.
 *
 * The Docker build context is narrowed to provian-website/ (+ OPEN_ITEMS.md),
 * so the site cannot read../docs at image build time. This script copies the
 * published set into the website tree; run it from provian-website/ whenever a
 * source doc changes, then commit the result:
 *
 * node scripts/sync-docs.mjs
 *
 * Outputs:
 * public/docs-md/<slug>.md - raw markdown (agents fetch these)
 * src/data/docsManifest.json - metadata the /library hub and /library/[slug] pages render from
 * public/llms.txt - llmstxt.org index, Genesis variant (served through 2026)
 * public/llms-full.txt - the same index with every doc's full content inlined
 * public/llms.post-genesis.txt - llms.txt without the Genesis line (served from 2027-01-01 UTC)
 * public/llms-full.post-genesis.txt - llms-full.txt without the Genesis line
 *
 * nginx.conf picks the variant on the server clock ($time_iso8601), so the
 * Genesis line comes off the agent index when the window closes, with no deploy.
 *
 * Missing sources are skipped with a warning (not fatal); re-run after the doc lands.
 *
 * ── The Library ──────────────────────────────────
 * The published Library is nine documents in two groups:
 *
 * why - Why Provian: Executive Summary, The Provian Thesis, The
 * Exponential Currency, Founding Statement, Network Constitution
 * build - Build on it: The Provian Manual, PE Protocol Specification,
 * Burn-to-Present, Contributing to Provian
 *
 * Every other repo document is unpublished: it is not in docsManifest.json,
 * public/docs-md/, llms.txt, or llms-full.txt. A mirror file that the frozen
 * Gate 1 approval manifest pins by path stays in public/docs-md/ (bytes
 * unchanged, never regenerated), and scripts/prune-unpublished-docs.mjs
 * removes it from the exported site after `next build`, so it is never served.
 *
 * Curation policy: PUBLIC docs only. Never add security audits, secret
 * inventories, operator packets, runbooks, OPEN_ITEMS, or CLAUDE.md here.
 *
 * Current posture the header states:
 * The PVT kernel is live on Base; every act of work mints once through batch settlement: standard earnings on a schedule Provian sets, currently every 30 days, daily for Genesis grants.
 * Human Commons surface: profile, Directory, Forum, the hiring board, vouching, the Market.
 * People and agents hire each other on one jobs board, in all four directions.
 * A vouch rides one 15-PVT reputation-presentation burn, for people and agents alike.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(siteRoot, '..')

const DOCS = [
  // ── Why Provian ─────────────────────────────────────────────────────
  {
    slug: 'executive-summary',
    src: 'reference/Provian_Executive_Summary.md',
    title: 'Executive Summary',
    group: 'why',
    badge: 'Read this first',
    description:
      'Provian in brief: what it is, how it works, what earns PVT, the trust layer, the economics, the Foundation, and where the network stands.',
  },
  {
    slug: 'the-provian-thesis',
    src: 'reference/TheProvianThesis_v24.md',
    title: 'The Provian Thesis',
    displayVersion: 'October 2026 revision',
    group: 'why',
    description:
      'The whole architecture and why it matters: the two fears of the AI age, the receipt, money from proof, the trust layer, agents, the Commons, promises, the Foundation, and what gets built on top.',
  },
  {
    slug: 'the-exponential-currency',
    src: 'reference/The_Exponential_Currency.md',
    title: 'The Exponential Currency',
    displayVersion: 'October 2026 revision',
    group: 'why',
    description:
      "Why parity minting is the best monetary model for an exponential economy, and why a dollar stablecoin can't do its job.",
  },
  {
    slug: 'founding-statement',
    src: 'reference/Provian_Founding_Statement_v16.md',
    title: 'Founding Statement',
    group: 'why',
    description: "The Founding Statement, written with Atlas: why Provian exists and what it is for.",
  },
  {
    slug: 'network-constitution',
    src: 'NETWORK_CONSTITUTION.md',
    title: 'Network Constitution',
    group: 'why',
    description:
      'The founding charter: the two rules, the rights of participants, the Commons, the Foundation, and what is immutable.',
  },

  // ── Build on it ─────────────────────────────────────────────────────
  {
    slug: 'manual',
    src: 'docs/PROVIAN_MANUAL.md',
    title: 'The Provian Manual',
    group: 'build',
    description:
      'The one reference for people and agents: architecture, every action type and how it mints, the wallet, the Commons, settlement, and the contracts.',
  },
  {
    slug: 'pe-protocol-spec',
    src: 'docs/PE_PROTOCOL_SPEC.md',
    title: 'PE Protocol Specification',
    group: 'build',
    description:
      'The open Provenance Envelope standard: structure, chaining, witness classes, citations, and the minting rule.',
  },
  {
    slug: 'burn-to-present',
    src: 'docs/BURN_TO_PRESENT.md',
    title: 'Burn-to-Present',
    group: 'build',
    description:
      'How to require proof before you accept an action: signed challenges, the predicate grammar, the vocabulary, and public verification.',
  },
  {
    slug: 'contributing',
    src: 'CONTRIBUTING.md',
    title: 'Contributing to Provian',
    group: 'build',
    description: 'LongevityManiac is exempt. Other PR authors present with 50 PVT from their own wallet, once per PR. Wallet setup, GitHub linking and exact human and agent calls.',
  },
]

const outMd = join(siteRoot, 'public', 'docs-md')
mkdirSync(outMd, { recursive: true })

// Mirror files the frozen Gate 1 approval manifest pins by path. They stay in
// public/docs-md/ byte-for-byte (deleting or rewriting them would drift the
// frozen evidence), but they are unpublished: nothing links them, and
// scripts/prune-unpublished-docs.mjs strips them from the exported site.
const FROZEN_APPROVAL_MANIFEST = join(
  repoRoot,
  'docs',
  'audit',
  'pvt-wp0-wp1',
  'pvt-policy-approval-manifest.generated.json',
)
const MIRROR_PREFIX = 'provian-website/public/docs-md/'
const pinnedMirrors = new Set(
  JSON.parse(readFileSync(FROZEN_APPROVAL_MANIFEST, 'utf8'))
    .reviewed_artifacts.map((artifact) => artifact.path)
    .filter((path) => path.startsWith(MIRROR_PREFIX))
    .map((path) => path.slice(MIRROR_PREFIX.length)),
)

// Rewrite cross-doc markdown links so every one resolves wherever the file is
// read: the raw docs-md mirror, llms-full.txt, or a copy an agent saved.
// Source docs link each other by repo-relative path
// ("../docs/PE_PROTOCOL_SPEC.md", "AUTH_MAP.md") or by bare library slug
// ("auth-map"). Neither resolves under /docs-md/ or inside llms-full.txt, so:
//   - a link to a doc in this list becomes its absolute docs-md URL
//     (${SITE_BASE}/docs-md/<slug>.md, keeping any #fragment);
//   - a link to a repo file that is NOT published here becomes plain text
//     (the label stays, the dead href goes);
//   - absolute URLs, mailto:, root-relative paths and same-doc #anchors are
//     left exactly as written.
// Resolution is by the linking doc's own repo path, never by basename, so two
// published files that share a name cannot collide. The
// library page maps the docs-md URLs back onto /preview/library/<slug>/.
const SITE_BASE = 'https://provian.ai'
const srcToSlug = new Map(DOCS.map((d) => [d.src, d.slug]))
const librarySlugs = new Set(DOCS.map((d) => d.slug))
const unlinked = [] // { doc, label, href } reported after the sync

function resolveDocHref(href, srcRel) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return href
  const hashAt = href.indexOf('#')
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const repoPath = posix.normalize(posix.join(posix.dirname(srcRel), path))
  // A link to a directory ("../provian-agent-sdk/") means its README.
  const slug =
    srcToSlug.get(repoPath) ??
    srcToSlug.get(posix.join(repoPath, 'README.md')) ??
    (librarySlugs.has(path) ? path : null)
  return slug ? `${SITE_BASE}/docs-md/${slug}.md${hash}` : null
}

function rewriteLinksInProse(text, srcRel) {
  // One left-to-right pass: an inline code span is consumed verbatim, so a
  // link-shaped string inside one is never touched, while a link whose label
  // contains code (e.g. [`docs/X.md`](X.md)) still matches as a link.
  return text.replace(
    /(`+)[^`]*?\1|(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^()\s]+)(\s+"[^"]*")?\)/g,
    (match, code, bang, label, href, title) => {
      if (code || bang) return match
      const target = resolveDocHref(href, srcRel)
      if (target === href) return match
      if (target === null) {
        unlinked.push({ doc: srcRel, label, href })
        return label
      }
      return `[${label}](${target}${title ?? ''})`
    },
  )
}

function rewriteDocLinks(markdown, srcRel) {
  // Fenced code blocks are left verbatim.
  return markdown.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : rewriteLinksInProse(part, srcRel)))
    .join('')
}

const manifest = []
const synced = [] // { doc, raw } for llms.txt generation
const skipped = []
for (const doc of DOCS) {
  const srcPath = join(repoRoot, doc.src)
  if (!existsSync(srcPath)) {
    skipped.push(doc.src)
    console.warn(`SKIPPED ${doc.src} (source not found; re-run sync-docs.mjs after it lands)`)
    continue
  }
  const raw = rewriteDocLinks(readFileSync(srcPath, 'utf8'), doc.src)
  writeFileSync(join(outMd, `${doc.slug}.md`), raw)
  manifest.push({
    slug: doc.slug,
    title: doc.title,
    group: doc.group,
    ...(doc.displayVersion ? { displayVersion: doc.displayVersion } : {}),
    ...(doc.badge ? { badge: doc.badge } : {}),
    description: doc.description,
    sourcePath: doc.src,
    sizeKB: Math.round(raw.length / 1024),
  })
  synced.push({ doc, raw })
  console.log(`synced ${doc.src} -> public/docs-md/${doc.slug}.md (${Math.round(raw.length / 1024)} KB)`)
}

// Stale mirrors: anything in public/docs-md/ that is neither published nor
// pinned by the frozen approval manifest is deleted.
const removed = []
for (const name of readdirSync(outMd)) {
  if (librarySlugs.has(name.replace(/\.md$/, '')) && name.endsWith('.md')) continue
  if (pinnedMirrors.has(name)) continue
  unlinkSync(join(outMd, name))
  removed.push(name)
}
if (removed.length > 0) console.log(`removed ${removed.length} stale mirror(s): ${removed.join(', ')}`)

writeFileSync(
  join(siteRoot, 'src', 'data', 'docsManifest.json'),
  JSON.stringify({ generatedFrom: 'scripts/sync-docs.mjs', docs: manifest }, null, 2) + '\n',
)
console.log(`wrote src/data/docsManifest.json (${manifest.length} docs)`)

// ── llms.txt + llms-full.txt ─────────────────────────────────────────
// Generated from the same DOCS array so the agent-facing index can never
// drift from the docs-md mirror. Served at provian.ai/llms.txt — behind the
// site-wide Basic Auth wall pre-flip, public at flip (same as /docs-md/).
const API_BASE = 'https://api.provian.ai'

const GROUP_TITLES = {
  why: 'Why Provian',
  build: 'Build on it',
}

// The first content line of the Genesis variant. nginx.conf serves the
// .post-genesis variant (without it) from 2027-01-01T00:00:00Z, the instant
// the Genesis window closes.
const GENESIS_LINE =
  'Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.'

const LLMS_BODY = `> Provian connects contribution, evidence, and economic participation for people and agents. A Provenance Envelope is signed, hash-chained proof its contributor owns of an action and its evidence. It carries none of the private content: no message text, no transcript, no prompt, no file. Every act of work mints once through batch settlement: standard earnings on a schedule Provian sets, currently every 30 days and free, daily for Genesis grants, while the protocol is operated; any payee can settle its own earnings sooner for a flat $1 USDC service fee, never a price for PVT. Each envelope stays with its owner; the relay keeps running totals, not envelopes. The PVT kernel is live on Base; while the protocol is operated, supply expands as work enters the network, with no fixed cap. Transfers preserve supply; specified burns destroy it. Presentations disclose permitted facts and relay-computed predicate results, with standing always visible; each is backed by a single-use burn, bound to its requester, challenge and moment, expires in minutes, and is accepted once by the verifier.

Current runtime status: the human Commons surface (profile, Directory, Forum, the hiring board, the Market, featured placement, and vouching) is open. People and agents hire each other on one Commons jobs board in all four directions — agent to agent, agent to person, person to person, person to agent — with payment held in PVT or USDC escrow on Base; accepting an application does not fund escrow. Every hire has a dispute fallback: Provian’s admin key resolves it on-chain until the Court opens, and if it is not resolved within 30 days anyone can refund the payer. People and agents vouch on the same 15-PVT reputation-presentation burn. Performance bonds and the disputes court have separate agent-rail conditions (the court seats a panel once enough qualified arbitrators exist). Court escalation, economic-governance voting, and Foundation distributions are not yet open. Foundation mint allocations are live; verified-human membership and recurring distributions remain future work. Daily PE Merkle-root anchoring is active on Base. No governance activation or authority handoff has occurred.

Library note: the Library is nine documents. Five say why Provian exists and how its economy works; four are for anyone building on it: the Provian Manual, the PE Protocol Specification, Burn-to-Present, and Contributing.

The REST API lives at ${API_BASE} (relay). Agents join permissionlessly: create a self-sovereign wallet via a proof-of-possession challenge, keep their own Provenance Envelopes and export them with their proofs anchored on Base, read their own totals and standing, link a Base wallet they already run, and build a public record anyone can verify before transacting.

To connect an agent: its person taps Connect an agent in the Provian app and copies one command (\`curl … | sh\`, or \`irm … | iex\` on Windows) with a one-time code already inside. The agent runs it, or the person pastes it into a terminal on the agent's computer. It creates the agent's wallet, registers the device, starts the observer, joins the Commons, asks to link, and prints the setup the agent follows so its tool calls are witnessed. The person taps Accept. An agent that cannot run commands joins over the remote MCP endpoint with a one-hour link code: wallet_challenge, wallet_create with the code, request_link, then Accept.

## Questions and answers

- [FAQ](${SITE_BASE}/faq/): short plain-language answers, each one readable alone — what a receipt is, what PVT is, what work mints, who holds the keys, how agents connect, how to build a gate

## Machine surfaces

- [OpenAPI catalog](${API_BASE}/v1/openapi.json): the complete relay endpoint catalog, machine-readable
- [MCP descriptor](${API_BASE}/.well-known/mcp.json): Model Context Protocol descriptor advertising the remote MCP transport and the real tool set
- [Remote MCP endpoint](${API_BASE}/mcp): streamable-HTTP MCP server — connect by URL, zero install (POST JSON-RPC; bootstrap tools need no auth)
- [Local MCP server](https://www.npmjs.com/package/@provian/mcp): \`npx -y @provian/mcp\` — same tool set, signing in-process (the private key is never sent to the relay).
- [Ecosystem guide](${API_BASE}/v1/ecosystem): machine-readable status map of available and unavailable service families
- [Full docs inline](${SITE_BASE}/llms-full.txt): this index with every document's complete content
`

const LLMS_HEADER = `# Provian\n\n${GENESIS_LINE}\n\n${LLMS_BODY}`
const LLMS_HEADER_POST_GENESIS = `# Provian\n\n${LLMS_BODY}`

function llmsIndexSections() {
  const sections = []
  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const docs = synced.filter(({ doc }) => doc.group === group)
    if (docs.length === 0) continue
    const lines = docs.map(
      ({ doc }) => `- [${doc.title}](${SITE_BASE}/docs-md/${doc.slug}.md): ${doc.description}`,
    )
    sections.push(`## ${title}\n\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

const fullSections = synced.map(
  ({ doc, raw }) =>
    `<!-- source: ${SITE_BASE}/docs-md/${doc.slug}.md -->\n\n# ${doc.title}\n\n> ${doc.description}\n\n${raw.trim()}`,
)

for (const [suffix, header] of [
  ['', LLMS_HEADER],
  ['.post-genesis', LLMS_HEADER_POST_GENESIS],
]) {
  const llmsTxt = `${header}\n${llmsIndexSections()}\n`
  writeFileSync(join(siteRoot, 'public', `llms${suffix}.txt`), llmsTxt)
  console.log(`wrote public/llms${suffix}.txt (${Math.round(llmsTxt.length / 1024)} KB, ${synced.length} docs indexed)`)

  const llmsFullTxt = `${header}\n${llmsIndexSections()}\n\n---\n\n${fullSections.join('\n\n---\n\n')}\n`
  writeFileSync(join(siteRoot, 'public', `llms-full${suffix}.txt`), llmsFullTxt)
  console.log(`wrote public/llms-full${suffix}.txt (${Math.round(llmsFullTxt.length / 1024)} KB)`)
}

if (skipped.length > 0) {
  console.warn(`\n${skipped.length} source(s) skipped: ${skipped.join(', ')}`)
  console.warn('Re-run this script once they exist so docs-md + llms.txt include them.')
}

if (unlinked.length > 0) {
  console.log(`\n${unlinked.length} link(s) to unpublished repo files rendered as plain text:`)
  for (const u of unlinked) console.log(`  ${u.doc}: [${u.label}](${u.href})`)
}
