#!/usr/bin/env node
/**
 * The gate-handshake explainer — two presenters, one gate.
 *
 * A ~42-second diagram in motion, rendered as ONE animated SVG (CSS keyframes, no script, no audio)
 * in two themes:
 * - dark → inlined on the /gates page under the hero (src/data/gateHandshake.ts)
 * - dark + light → the provian-reference-gate README (docs/gate-handshake-{dark,light}.svg),
 * chosen by <picture> on the reader's colour scheme
 *
 * ILLUSTRATIVE. Every value on screen is read from the reference repo's illustrative contrast
 * record (provian-reference-gate/docs/illustrative-contrast.json, written by `npm run contrast`):
 * the counterparty-onboarding example run on its two fixture presenters — a fresh key and an
 * established agent — whose presentations are signed by the reference's own test issuer key and
 * checked by the same verifier a live gate uses. The record checks below refuse to render if the
 * record no longer says what the narration claims. Nothing is transcribed by hand.
 *
 * Usage (from the repo root):
 * node provian-website/scripts/build-gate-handshake.mjs [--reference-repo../provian-reference-gate]
 * The record is read from --reference-repo (default: the sibling checkout../provian-reference-gate),
 * and with --reference-repo the two README SVGs are written back there.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const refIdx = process.argv.indexOf('--reference-repo')
const refRepo = refIdx > 0 ? resolve(process.argv[refIdx + 1]) : resolve(repoRoot, '..', 'provian-reference-gate')
const RECORD_REL = 'docs/illustrative-contrast.json'
const recordBytes = readFileSync(join(refRepo, RECORD_REL))
const record = JSON.parse(recordBytes.toString('utf8'))
const recordSha = createHash('sha256').update(recordBytes).digest('hex')

// The example animated, and the five names for the end card (the reference repo's own policy names).
const SLUG = 'counterparty-onboarding'
const HEADINGS = ['Identity', 'Accountable human', 'Witnessed history', 'Standing', 'Counterparties', 'Money witnessed']

// ── Record checks: the narration must be what the record says ─────────────────────────────────
function must(cond, what) {
  if (!cond) throw new Error(`contrast record check failed: ${what}`)
}
must(record.kind === 'provian-reference-gate.illustrative-contrast.v1' && record.illustrative === true, 'an illustrative contrast record')
const NAMES = Object.fromEntries(record.examples.map((e) => [e.policy.slug, e.policy.name]))
must(JSON.stringify(Object.keys(NAMES)) === JSON.stringify(['counterparty-onboarding', 'payment-rail', 'repository-merge', 'mission-critical-action', 'sensitive-site']), 'the five worked examples, onboarding first')
const ex = record.examples.find((e) => e.policy.slug === SLUG)
const P = Object.fromEntries(record.presenters.map((p) => [p.id, p]))
must(P.fresh && P.established, 'the two fixture presenters')
const run = Object.fromEntries(ex.runs.map((r) => [r.presenter, r]))
for (const id of ['fresh', 'established']) {
  const r = run[id]
  must(r, `a ${id} run`)
  must(r.signature_check === 'valid' && r.decision.verification.local === 'valid' && r.decision.verification.replay === 'first', `${id}: key valid, presentation verified, first acceptance`)
  must(r.decision.presentation?.id === r.presentation_id && r.burn.id === r.presentation_id, `${id}: presentation id is the burn id`)
  must(r.burn.tier === 'reputation' && r.burn.onchain === false && Number.isFinite(r.burn.floor_pvt), `${id}: an illustrative reputation-tier burn`)
  must(r.decision.presentation.requester?.type === 'domain' && r.decision.presentation.requester.id === record.gate && r.decision.gate === record.gate, `${id}: challenge from the gate's own domain`)
  must(typeof r.challenge.sig === 'string' && r.challenge.sig.length > 20 && r.challenge.kid, `${id}: the challenge is signed`)
  must(JSON.stringify(r.decision.report.sections.map((s) => s.heading)) === JSON.stringify(HEADINGS), `${id}: the six report headings, in order`)
  must(r.decision.report.sections.every((s) => s.lines.length > 0), `${id}: a sentence under every heading`)
  must(r.replay.decision === 'block' && r.replay.verification?.replay === 'replayed', `${id}: the replay is refused as a replay`)
}
must(run.fresh.decision.decision === 'block' && run.fresh.decision.report.decision === 'BLOCK', 'the fresh key is blocked')
must(run.established.decision.decision === 'allow' && run.established.decision.report.decision === 'ALLOW', 'the established agent is admitted')
must(run.fresh.challenge.nonce !== run.established.challenge.nonce, 'one challenge each')

// ── Values, formatted ─────────────────────────────────────────────────────────────────────────
const short = (s, a, b) => `${s.slice(0, a)}…${s.slice(-b)}`
const RUN = { fresh: run.fresh, established: run.established }
const V = {
  domain: record.gate,
  kid: run.fresh.challenge.kid,
  nPred: ex.policy.predicates.length,
  ttlMin: Math.round((run.fresh.challenge.expires_at - run.fresh.challenge.issued_at) / 60),
  floor: run.fresh.burn.floor_pvt,
  addr: (id) => short(P[id].address, 6, 4),
  nonce: (id) => short(RUN[id].challenge.nonce, 8, 4),
  sig: (id) => short(RUN[id].challenge.sig, 6, 4),
  burn: (id) => short(RUN[id].burn.id, 8, 4),
}

/** The report line a cell shows for a heading: the line the gate ASKED (its co-signed answer) when
 *  there is one, else the first line — cut at its first clause boundary, never reworded. */
function cellText(report, heading) {
  const s = report.sections.find((x) => x.heading === heading)
  const line = s.lines.find((l) => l.source === 'answer') ?? s.lines[0]
  let t = line.text
  const cut = t.search(/ — |: (?=[a-z])/)
  if (heading !== 'Standing' && cut > 0) t = t.slice(0, cut) + '.'
  if (heading === 'Standing') t = t.split('. ')[0].replace(/\.?$/, '.')
  return t
}

/** Greedy word wrap by an average glyph width (viewBox units). */
function wrap(s, maxChars) {
  const out = []
  let cur = ''
  for (const w of s.split(' ')) {
    if (cur && (cur + ' ' + w).length > maxChars) { out.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) out.push(cur)
  return out
}

// ── Themes ────────────────────────────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    panel: '#0c1020', edge: 'rgba(255,255,255,0.10)', card: 'rgba(255,255,255,0.035)', cardEdge: 'rgba(255,255,255,0.09)',
    primary: '#e8ecf4', secondary: '#949eb4', muted: '#7c869c',
    blue: '#6bb3ff', blueTint: 'rgba(74,158,255,0.14)', gold: '#f0bd5c', goldTint: 'rgba(232,166,52,0.14)',
    red: '#f87171', redTint: 'rgba(248,113,113,0.14)', line: 'rgba(255,255,255,0.16)',
  },
  light: {
    panel: '#ffffff', edge: 'rgba(12,16,32,0.14)', card: 'rgba(12,16,32,0.03)', cardEdge: 'rgba(12,16,32,0.10)',
    primary: '#0c1020', secondary: '#475166', muted: '#5d6779',
    blue: '#1f6fd1', blueTint: 'rgba(31,111,209,0.10)', gold: '#9a6410', goldTint: 'rgba(184,126,26,0.12)',
    red: '#c2362f', redTint: 'rgba(194,54,47,0.10)', line: 'rgba(12,16,32,0.22)',
  },
}

// ── Geometry (viewBox units; 560 wide) ────────────────────────────────────────────────────────
const W = 560
const T = 42 // seconds per loop
const GATE = { x: 205, y: 42, w: 150, h: 58 }
const LEFT = { x: 20, y: 116, w: 170, h: 58 }
const RIGHT = { x: 370, y: 116, w: 170, h: 58 }
const BASE = { x: 225, y: 186, w: 110, h: 34 }
const LANE_Y = GATE.y + GATE.h / 2
const COL = { fresh: { x: 36, w: 236 }, established: { x: 290, w: 236 } }
const CAP_X = W / 2
const ROW = 19

// The report beat sets the card's height: six headings, each cell the report's own line, wrapped.
const CARD_Y = 238
const CELL_CHARS = 37
const LINE = 13
const REPORT_ROWS = []
let reportY = CARD_Y + 52
for (const h of HEADINGS) {
  const cells = { fresh: wrap(cellText(run.fresh.decision.report, h), CELL_CHARS), established: wrap(cellText(run.established.decision.report, h), CELL_CHARS) }
  REPORT_ROWS.push({ heading: h, y: reportY, cells })
  reportY += 14 + Math.max(cells.fresh.length, cells.established.length) * LINE + 8
}
const DECISION_Y = reportY + 14
const CARD = { x: 20, y: CARD_Y, w: 520, h: DECISION_Y + 30 - CARD_Y }
// Captions sit in the card's lower half: the beats before and after the report fill only its top,
// and the report beat carries no caption.
const CAP1 = CARD.y + CARD.h - 74 // one caption line
const CAP2 = [CAP1 - 15, CAP1 + 15] // two caption lines
const H = CARD.y + CARD.h + 20

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function render(themeName) {
  const C = THEMES[themeName]
  const css = []
  let k = 0

  // An element visible in `windows` ([t0, t1] seconds). `base` is its state with motion reduced —
  // the report beat, the one frame that carries the whole story.
  function anim(windows, { base = 0, move = null, fade = 0.35 } = {}) {
    const name = `gh-k${k++}`
    const pct = (t) => `${((Math.max(0, Math.min(T, t)) / T) * 100).toFixed(3)}%`
    const stops = [[0, 0]]
    for (const [a, b] of windows) {
      const fin = Math.min(a + fade, b)
      stops.push([a, 0], [fin, 1], [Math.max(b - fade, fin), 1], [b, 0])
    }
    stops.push([T, 0])
    css.push(`@keyframes ${name}-o{${stops.map(([t, o]) => `${pct(t)}{opacity:${o}}`).join('')}}`)
    let animation = `${name}-o ${T}s linear infinite`
    if (move) {
      const [[x0, y0], [x1, y1], t0, t1] = move
      css.push(`@keyframes ${name}-m{0%{transform:translate(${x0}px,${y0}px)}${pct(t0)}{transform:translate(${x0}px,${y0}px)}${pct(t1)}{transform:translate(${x1}px,${y1}px)}100%{transform:translate(${x1}px,${y1}px)}}`)
      animation += `,${name}-m ${T}s ease-in-out infinite`
    }
    css.push(`.${name}{opacity:${base};animation:${animation}}`)
    return `gh-a ${name}`
  }

  const text = (x, y, s, { size = 13, cls = 'gh-mono', fill = C.primary, weight = 400, anchor = 'start' } = {}) =>
    `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`
  const check = (x, y, ok) => {
    const c = ok ? C.blue : C.red
    const t = ok ? C.blueTint : C.redTint
    const d = ok ? 'M-3 0.2 L-0.9 2.4 L3.1 -2.2' : 'M-2.4 -2.4 L2.4 2.4 M2.4 -2.4 L-2.4 2.4'
    return `<g transform="translate(${x} ${y})"><circle r="6.5" fill="${t}" stroke="${c}" stroke-width="1"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>`
  }
  const node = (b, title, sub) =>
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${C.card}" stroke="${C.cardEdge}"/>` +
    text(b.x + 14, b.y + 25, title, { size: 15, cls: 'gh-disp', weight: 600 }) +
    text(b.x + 14, b.y + 44, sub, { size: 11, fill: C.secondary })
  const pill = (b, title, sub) =>
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" fill="${C.card}" stroke="${C.cardEdge}"/>` +
    text(b.x + b.w / 2, b.y + 15, title, { size: 12, cls: 'gh-disp', weight: 600, anchor: 'middle' }) +
    text(b.x + b.w / 2, b.y + 28, sub, { size: 9.5, fill: C.secondary, anchor: 'middle' })
  const glow = (b, color, tint, windows, base = 0, rx = 12) =>
    `<rect class="${anim(windows, { base })}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${tint}" stroke="${color}" stroke-width="1.5"/>`
  const packet = (label, from, to, t0, t1, color, tint) => {
    const w = label.length * 6.2 + 16
    return `<g class="${anim([[t0 - 0.25, t1 + 0.3]], { move: [from, to, t0, t1], fade: 0.2 })}">` +
      `<rect x="${-w / 2}" y="-10" width="${w}" height="20" rx="10" fill="${tint}" stroke="${color}"/>` +
      text(0, 3.8, label, { size: 10, fill: color, anchor: 'middle' }) + '</g>'
  }
  // A packet on the lane between one agent and the gate.
  const lane = (label, side, toGate, t0, t1, color = C.blue, tint = C.blueTint) => {
    const w = label.length * 6.2 + 16
    const agentEdge = side === 'fresh' ? LEFT.x + w / 2 : RIGHT.x + RIGHT.w - w / 2
    const gateEdge = side === 'fresh' ? GATE.x - 6 - w / 2 : GATE.x + GATE.w + 6 + w / 2
    const a = [agentEdge, LANE_Y]
    const g = [gateEdge, LANE_Y]
    return toGate ? packet(label, a, g, t0, t1, color, tint) : packet(label, g, a, t0, t1, color, tint)
  }
  const burnDrop = (label, side, t0, t1) => {
    const b = side === 'fresh' ? LEFT : RIGHT
    const w = label.length * 6.2 + 16
    return packet(label, [b.x + b.w / 2, b.y + b.h + 12], [side === 'fresh' ? BASE.x - 6 - w / 2 : BASE.x + BASE.w + 6 + w / 2, BASE.y + BASE.h / 2], t0, t1, C.gold, C.goldTint)
  }
  const group = (windows, body, base = 0) => `<g class="${anim(windows, { base })}">${body}</g>`
  const caption = (lines, windows, base = 0) => group(windows, lines.join(''), base)
  const capLine = (y, s, opts = {}) => text(CAP_X, y, s, { size: 24, cls: 'gh-disp', weight: 600, anchor: 'middle', ...opts })
  // Two-column card rows: key + value per presenter.
  const colTitle = (id, s, color, y = CARD.y + 28) => text(COL[id].x, y, s, { size: 13.5, cls: 'gh-disp', weight: 600, fill: color })
  // Monospace glyphs are ~0.6 em wide: a key must fit its 84-unit slot and a value must end inside its
  // column, or the render refuses (a row that spills into the other presenter's column misreads).
  const colRow = (id, i, key, value, opts = {}) => {
    const y = CARD.y + 56 + i * ROW
    must(String(key).length * 11 * 0.6 <= 76, `card key "${key}" fits its slot`)
    must(84 + String(value).length * (opts.size ?? 12) * 0.6 <= COL[id].w - 4, `card value "${value}" fits its column`)
    return text(COL[id].x, y, key, { size: 11, fill: C.muted }) + text(COL[id].x + 84, y, value, { size: 12, ...opts })
  }
  const both = (fn) => fn('fresh') + fn('established')

  // ── Beats ──────────────────────────────────────────────────────────────────────────────────
  const B = []
  const STAGE = [[0, 37.2]]

  B.push(group(STAGE,
    text(20, 28, `Illustrative · ${SLUG} · fixture presenters, test issuer key`, { size: 10.5, fill: C.muted }) +
    `<path d="M${LEFT.x + LEFT.w / 2} ${LEFT.y} V${LANE_Y} H${GATE.x}" fill="none" stroke="${C.line}" stroke-dasharray="3 5"/>` +
    `<path d="M${RIGHT.x + RIGHT.w / 2} ${RIGHT.y} V${LANE_Y} H${GATE.x + GATE.w}" fill="none" stroke="${C.line}" stroke-dasharray="3 5"/>` +
    node(LEFT, P.fresh.label, V.addr('fresh')) +
    node(GATE, 'Gate', V.domain) +
    node(RIGHT, P.established.label, V.addr('established')) +
    pill(BASE, 'Base', 'burns') +
    `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="14" fill="${C.card}" stroke="${C.cardEdge}"/>`,
    1))
  // The column divider: short above the captions, full height under the report.
  B.push(group([[0.6, 22.0], [33.4, 37.2]], `<line x1="${W / 2}" y1="${CARD.y + 14}" x2="${W / 2}" y2="${CARD.y + 170}" stroke="${C.cardEdge}"/>`))
  B.push(group([[22.4, 33.0]], `<line x1="${W / 2}" y1="${CARD.y + 14}" x2="${W / 2}" y2="${CARD.y + CARD.h - 14}" stroke="${C.cardEdge}"/>`, 1))

  // Highlights.
  B.push(glow(LEFT, C.blue, C.blueTint, [[0.2, 4.0], [10.6, 15.8], [33.4, 35.2]]))
  B.push(glow(RIGHT, C.blue, C.blueTint, [[0.2, 4.0], [10.6, 15.8], [33.4, 35.2]]))
  B.push(glow(GATE, C.gold, C.goldTint, [[4.4, 10.2]]))
  B.push(glow(GATE, C.blue, C.blueTint, [[16.2, 22.0]]))
  B.push(glow(GATE, C.red, C.redTint, [[35.2, 37.2]]))
  B.push(glow(BASE, C.gold, C.goldTint, [[11.4, 13.6]], 0, BASE.h / 2))

  // 1. Two agents arrive at the same gate.
  B.push(lane('asks to act', 'fresh', true, 1.0, 2.6))
  B.push(lane('asks to act', 'established', true, 1.0, 2.6))
  B.push(group([[0.6, 4.0]], both((id) =>
    colTitle(id, P[id].label, C.blue) +
    colRow(id, 0, 'presenter', V.addr(id)) +
    colRow(id, 1, 'asks', 'to act, first time') +
    colRow(id, 2, 'at', V.domain))))
  B.push(caption([capLine(CAP1, 'Two agents. Same door.')], [[0.2, 4.0]]))

  // 2. One signed challenge each, from the gate's own domain.
  B.push(lane('challenge', 'fresh', false, 4.8, 6.4, C.gold, C.goldTint))
  B.push(lane('challenge', 'established', false, 4.8, 6.4, C.gold, C.goldTint))
  B.push(group([[5.2, 10.2]], both((id) =>
    colTitle(id, 'Signed challenge', C.gold) +
    colRow(id, 0, 'audience', V.domain) +
    colRow(id, 1, 'key', `${V.kid} · well-known`) +
    colRow(id, 2, 'challenge', V.nonce(id)) +
    colRow(id, 3, 'asks', `${V.nPred} questions`) +
    colRow(id, 4, 'expires', `${V.ttlMin} min`) +
    colRow(id, 5, 'signature', `Ed25519 ${V.sig(id)}`))))
  B.push(caption([capLine(CAP2[0], 'A signed challenge —'), capLine(CAP2[1], 'from the gate’s own domain.')], [[4.4, 10.2]]))

  // 3. Both burn and present.
  B.push(burnDrop(`−${V.floor} PVT`, 'fresh', 10.8, 12.2))
  B.push(burnDrop(`−${V.floor} PVT`, 'established', 10.8, 12.2))
  B.push(lane('presentation', 'fresh', true, 13.8, 15.2))
  B.push(lane('presentation', 'established', true, 13.8, 15.2))
  B.push(group([[11.2, 15.8]], both((id) =>
    colTitle(id, 'Burn, then present', C.gold) +
    colRow(id, 0, 'tier', RUN[id].burn.tier) +
    colRow(id, 1, 'burn', `${RUN[id].burn.floor_pvt} PVT floor`) +
    colRow(id, 2, 'burn id', V.burn(id)) +
    colRow(id, 3, '', '= presentation id', { fill: C.secondary }))))
  B.push(group([[13.8, 15.8]], both((id) => colRow(id, 5, 'presents', `token for ${V.nonce(id).slice(0, 8)}…`, { fill: C.blue }))))
  B.push(caption([capLine(CAP1, 'Both burn to present.')], [[10.6, 15.8]]))

  // 4. Both verify. A key check stops here.
  const verRow = (id, i, label, ok, t0) => group([[t0, 22.0]],
    text(COL[id].x, CARD.y + 56 + i * ROW, label, { size: 11, fill: C.muted }) +
    check(COL[id].x + 82, CARD.y + 52 + i * ROW, ok) +
    text(COL[id].x + 96, CARD.y + 56 + i * ROW, ok ? 'valid' : 'invalid', { size: 12, fill: ok ? C.blue : C.red, weight: 600 }))
  B.push(group([[16.4, 22.0]], both((id) => colTitle(id, 'Verification', C.blue))))
  for (const id of ['fresh', 'established']) {
    const v = RUN[id].decision.verification
    B.push(verRow(id, 0, 'issuer sig', v.local === 'valid', 16.8))
    B.push(verRow(id, 1, 'presenter', RUN[id].signature_check === 'valid', 17.4))
    B.push(verRow(id, 2, 'challenge', v.local === 'valid', 18.0))
    B.push(group([[18.6, 22.0]], colRow(id, 3, 'acceptance', v.replay)))
  }
  B.push(caption([capLine(CAP2[0], 'Both keys valid.'), capLine(CAP2[1], 'Both presentations verified.')], [[16.2, 19.6]]))
  B.push(caption([capLine(CAP1, 'A key check stops here.', { fill: C.gold })], [[19.8, 22.0]]))

  // 5. The gate asks its questions. Left: the report, BLOCK. Right: the report, ALLOW.
  const REP = [22.4, 33.0]
  B.push(group([REP], both((id) => colTitle(id, `${P[id].label} — the report`, C.primary)), 1))
  REPORT_ROWS.forEach(({ heading, y, cells }, i) => {
    const t0 = 22.8 + i * 0.7
    for (const id of ['fresh', 'established']) {
      B.push(group([[t0, REP[1]]],
        text(COL[id].x, y, heading.toUpperCase(), { size: 9.5, fill: C.muted, cls: 'gh-sans', weight: 600 }) +
        cells[id].map((l, j) => text(COL[id].x, y + 14 + j * LINE, l, { size: 11.5, cls: 'gh-sans' })).join(''),
        1))
    }
  })
  const dy = DECISION_Y
  for (const id of ['fresh', 'established']) {
    const rep = RUN[id].decision.report
    const ok = rep.decision === 'ALLOW'
    const color = ok ? C.blue : C.red
    const tint = ok ? C.blueTint : C.redTint
    const why = ok ? rep.reasons[0].split(',')[0] + '.' : `${rep.reasons.length} questions answered no.`
    B.push(group([[27.2, REP[1]]],
      `<rect x="${COL[id].x}" y="${dy - 16}" width="70" height="24" rx="12" fill="${tint}" stroke="${color}"/>` +
      text(COL[id].x + 35, dy, rep.decision, { size: 12, fill: color, weight: 700, anchor: 'middle' }) +
      wrap(why, 26).map((l, j) => text(COL[id].x + 80, dy - 4 + j * 13, l, { size: 11, cls: 'gh-sans', fill: C.secondary })).join(''),
      1))
  }

  // 6. Replay from either: Refused.
  B.push(lane('same presentation', 'fresh', true, 33.6, 34.8))
  B.push(lane('same presentation', 'established', true, 33.6, 34.8))
  B.push(group([[33.4, 37.2]], both((id) =>
    colTitle(id, 'The same presentation, again', C.blue) +
    colRow(id, 0, 'token', V.burn(id)) +
    colRow(id, 1, '', '= presentation id', { fill: C.secondary }))))
  B.push(group([[35.2, 37.2]], both((id) =>
    colRow(id, 2, 'answer', RUN[id].replay.report.decision, { fill: C.red, weight: 600 }) +
    colRow(id, 3, 'acceptance', RUN[id].replay.verification.replay, { fill: C.red }))))
  B.push(caption([capLine(CAP1, 'Refused.', { fill: C.red, weight: 700 })], [[35.2, 37.2]]))

  // End card.
  const names = Object.values(NAMES)
  B.push(group([[37.6, 41.8]],
    text(CAP_X, 220, 'Nothing unwitnessed gets in.', { size: 30, cls: 'gh-disp', weight: 700, anchor: 'middle' }) +
    text(CAP_X, 262, 'Five worked examples', { size: 11.5, fill: C.muted, anchor: 'middle' }) +
    names.map((n, i) => text(CAP_X, 294 + i * 29, n, { size: 19, cls: 'gh-disp', weight: 500, fill: n === NAMES[SLUG] ? C.gold : C.primary, anchor: 'middle' })).join('') +
    text(CAP_X, 466, 'Fork the reference gate.', { size: 23, cls: 'gh-disp', weight: 600, fill: C.blue, anchor: 'middle' }) +
    text(CAP_X, 492, 'github.com/LongevityManiac/provian-reference-gate', { size: 11.5, fill: C.muted, anchor: 'middle' })))

  const SANS = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
  const style =
    `.gh-disp{font-family:var(--font-display, ${SANS})}.gh-sans{font-family:var(--font-body, ${SANS})}` +
    `.gh-mono{font-family:var(--font-mono, ${MONO})}` +
    css.join('') +
    '@media (prefers-reduced-motion: reduce){.gh-a{animation:none!important}}' +
    '.gh-paused .gh-a{animation-play-state:paused!important}'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="gh-title gh-desc">` +
    `<title id="gh-title">The reference-gate handshake, illustrated: two presenters, one gate</title>` +
    `<desc id="gh-desc">${esc(TRANSCRIPT.join(' '))}</desc>` +
    `<style>${style}</style>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="${C.panel}" stroke="${C.edge}"/>` +
    B.join('') +
    '</svg>'
  )
}

// The same story in words: the SVG's <desc>, the page's step list, and the reduced-motion read.
const reportWords = (id) => {
  const rep = RUN[id].decision.report
  return `${P[id].label} — ${rep.sections.map((s) => `${s.heading}: ${s.lines.map((l) => l.text).join(' ')}`).join(' ')} ${rep.decision}: ${rep.reasons.join(' ')}`
}
const TRANSCRIPT = [
  `Two agents. Same door. A fresh key (${P.fresh.address}) and an established agent (${P.established.address}) each ask the gate at ${V.domain} to act for the first time — the ${NAMES[SLUG].toLowerCase()} example. Illustrative: fixture presenters, presentations signed by the reference's test issuer key.`,
  `A signed challenge — from the gate's own domain. One each: ${run.fresh.challenge.nonce.slice(0, 16)}… and ${run.established.challenge.nonce.slice(0, 16)}…, signed with key ${V.kid}, ${V.nPred} questions, expiring after ${V.ttlMin} minutes.`,
  `Both burn to present. Each presentation stands for a ${V.floor} PVT burn at the reputation tier; the burn id is the presentation id (illustrative: no transaction on chain).`,
  `Both keys valid. Both presentations verified. The issuer's signature, the presenter's key and the challenge check out for both; first acceptance. A key check stops here.`,
  reportWords('fresh'),
  reportWords('established'),
  `Replay from either: Refused. The same presentation sent again is ${run.fresh.replay.verification.replay} for both.`,
  `Nothing unwitnessed gets in. ${Object.values(NAMES).join(', ')}. Fork the reference gate.`,
]

// ── Write ─────────────────────────────────────────────────────────────────────────────────────
const dark = render('dark')
const light = render('light')
const site = join(repoRoot, 'provian-website', 'src', 'data', 'gateHandshake.ts')
writeFileSync(site,
  `// GENERATED by provian-website/scripts/build-gate-handshake.mjs from provian-reference-gate/${RECORD_REL}\n` +
  `// (sha256 ${recordSha}). Illustrative: fixture presenters, test issuer key.\n` +
  `// Do not edit by hand; re-run the script.\n\n` +
  `export const GATE_HANDSHAKE_EXAMPLE = ${JSON.stringify(SLUG)}\n\n` +
  `export const GATE_HANDSHAKE_TRANSCRIPT: readonly string[] = ${JSON.stringify(TRANSCRIPT, null, 2)}\n\n` +
  `export const GATE_HANDSHAKE_SVG: string = ${JSON.stringify(dark)}\n`)
console.log(`wrote ${site} (${dark.length} bytes of SVG) from record sha256 ${recordSha.slice(0, 12)}…`)

if (refIdx > 0) {
  mkdirSync(join(refRepo, 'docs'), { recursive: true })
  writeFileSync(join(refRepo, 'docs', 'gate-handshake-dark.svg'), dark + '\n')
  writeFileSync(join(refRepo, 'docs', 'gate-handshake-light.svg'), light + '\n')
  console.log(`wrote ${join(refRepo, 'docs')}/gate-handshake-{dark,light}.svg`)
}
