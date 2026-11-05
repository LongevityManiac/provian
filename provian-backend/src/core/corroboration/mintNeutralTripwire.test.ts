/**
 * MINT-NEUTRAL TRIPWIRE (Pass-2 #31 future-proofing).
 *
 * Product decision (2026-06-29): client-submitted peer corroboration is
 * MINT-NEUTRAL — it writes only `client_corroboration_*` markers and must NEVER
 * write `corroboration_status` (the field the PVT9 claim inlet reads to grant the
 * corroborated 1.1x tier). Promoting a client marker into corroboration_status
 * would re-open the sybil/collusion gap with no anti-collusion control.
 *
 * `client_corroboration_*` currently has ZERO readers (writer-only). The risk is
 * a FUTURE backfill/cron/admin tool that naively maps the corroboration-ish
 * marker into corroboration_status. This static tripwire fails-closed if any
 * production module references BOTH a `client_corroboration_*` field AND writes
 * `corroboration_status` — forcing a deliberate review (and an allowlist entry
 * with justification) before such a path can ship.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// provian-backend/src
const SRC_ROOT = join(__dirname, '..', '..');

// Files permitted to mention BOTH a client_corroboration_* marker AND a
// corroboration_status write. CorroborationManager legitimately does both — in
// SEPARATE functions: emitBackendCorroboration (server-driven, event-grounded)
// writes corroboration_status; applyClientCorroboration (client, mint-neutral)
// writes only client_corroboration_* markers. The second assertion below pins
// that separation so the allowlist can't hide a regression inside this file.
const ALLOWLIST = new Set<string>([
  'core/corroboration/CorroborationManager.ts',
]);

const MARKER = 'client_corroboration';
const STATUS_WRITE = /corroboration_status\s*:/; // object-literal write/update

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('mint-neutral tripwire: client_corroboration_* must not flow into corroboration_status', () => {
  it('no production module references a client_corroboration_* marker AND writes corroboration_status (except the allowlisted manager)', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length + 1);
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      if (src.includes(MARKER) && STATUS_WRITE.test(src)) {
        offenders.push(rel);
      }
    }
    // If this fails, a new code path may be promoting a mint-neutral client
    // corroboration marker into the mint-driving corroboration_status. Review it
    // against the sybil/anti-collusion analysis (OPEN_ITEMS WS-FixtureFidelity-3)
    // before allowlisting.
    expect(offenders).toEqual([]);
  });

  it('CorroborationManager.applyClientCorroboration writes client_corroboration_* but NEVER corroboration_status', () => {
    const file = join(SRC_ROOT, 'core/corroboration/CorroborationManager.ts');
    const src = readFileSync(file, 'utf8');
    const start = src.indexOf('export async function applyClientCorroboration');
    expect(start).toBeGreaterThan(-1);
    // Slice from applyClientCorroboration to the next top-level function decl.
    const rest = src.slice(start + 'export async function applyClientCorroboration'.length);
    const endRel = rest.search(/\n(export )?function |\nexport async function /);
    const body = endRel === -1 ? rest : rest.slice(0, endRel);
    expect(body).toContain(MARKER);               // it DOES record the marker
    expect(STATUS_WRITE.test(body)).toBe(false);  // it does NOT write the mint field
  });
});
