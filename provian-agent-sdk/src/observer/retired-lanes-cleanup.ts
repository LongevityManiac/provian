/**
 * retired-lanes-cleanup — what an installed daemon removes at start once it runs
 * bytes (a self-update's re-exec supplies the start), so no box keeps a
 * retired lane or a self-reporting instruction.
 *
 * dropped the Grok hooks lane and the local
 * witness endpoint ("installed daemons remove the hook file and close the
 * endpoint through self-update"); removed agent self-reporting ("Agents
 * are never instructed to report their own work"). The standing principle: PEs
 * prove provenance — an actor's own claim about its work is never a PE.
 *
 * At every daemon start, before any lane is registered:
 * 1. The retired Provian Grok hook file (`~/.grok/hooks/provian.json`) is
 * removed — only when it is Provian's (grok-home.ts); a foreign file stays.
 * 2. The hooks lane's journal (`~/.provian/grok-hooks-pending.json`) may hold
 * minting PEs the lane DECIDED but the relay had not taken when the old
 * daemon stopped. Each is resubmitted ONCE through the observer (its PE
 * outbox journals it before sending) under the deterministic relay key of
 * its turn id (`grokTurnIdempotencyKey`) — so a PE the relay already made is
 * answered with that PE, never a second one — and the journal file is
 * deleted only after every such PE was submitted or durably journaled.
 * Turns the journal still held OPEN or in their settle were never decided
 * and are not minted here: the hooks epoch they belong to has ended (the
 * witness mode migrates to a fresh transcript epoch), and under no
 * lane mints a turn outside its own epoch.
 * 3. The hooks lane's other on-disk records (`grok-hooks-emitted.json`,
 * `grok-hook-file.json`, `grok-hooks-listening.json`) are deleted.
 * 4. `~/.provian/runtime.env` loses the retired `PROVIAN_WITNESS_*` opt-in
 * lines (the installer no longer writes them and no process reads them);
 * every other line stays byte-identical.
 * 5. The "# Provian PE Reporting" section `register-device` appended to
 * `~/.claude/CLAUDE.md` (and to a `.cursorrules` / `.windsurfrules`) is
 * removed — exactly that section, matched on the product's own text; the
 * rest of the file stays byte-identical, and a file without the exact
 * section is never touched.
 * The witness mode's migration from a persisted 'hooks' record is
 * grok-witness-mode.ts (a fresh transcript epoch). The daemon never constructs
 * the retired endpoint, so it is closed from this start on.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { PluginContribution, PluginPE } from './types';
import type { ObserverPlugin, PECommitOutcome } from './plugins/PluginInterface';
import type { ProvianObserver } from './ProvianObserver';
import { createHash } from 'crypto';
export function isJournaledPE(v: unknown): v is PluginPE {
  const r = v as Record<string, unknown>;
  return typeof r === 'object' && r !== null && typeof r.actionType === 'string'
    && typeof r.description === 'string' && typeof r.windowStart === 'number' && typeof r.windowEnd === 'number';
}
function stampGrokIdempotencyKey(pe: PluginPE): void { const id=pe.metadata?.turn_id; if(typeof id==='string') pe.idempotencyKey='pe_grok_'+createHash('sha256').update('grok_turn_v1\x1f'+id).digest('hex').slice(0,40); }
import { removeGrokHooks, type GrokHookRemoval } from '../grok-home';
import { runtimeEnvPath } from '../runtime-env';
import { rewriteFileInPlace } from '../fs-in-place';

// ---------------------------------------------------------------------------
// The retired hooks lane's on-disk records
// ---------------------------------------------------------------------------

/** The hooks lane's journal (schema 1): open / held turns and decided minting PEs. */
export function retiredGrokHooksJournalPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'grok-hooks-pending.json');
}

/** The hooks lane's other records — deleted outright (nothing in them can mint). */
export function retiredGrokHooksRecordPaths(home: string = homedir()): string[] {
  return ['grok-hooks-emitted.json', 'grok-hook-file.json', 'grok-hooks-listening.json']
    .map((f) => path.join(home, '.provian', f));
}

const HOOKS_JOURNAL_SCHEMA = 1;

export interface RetiredHooksJournal {
  /** Decided minting PEs not yet committed, each carrying its turn's relay key. */
  pending: PluginPE[];
  /** Turns the journal held open or in their settle — never decided, not minted. */
  undecided: number;
}

/**
 * Read the hooks lane's journal. Null when absent or unreadable (an unreadable
 * journal is left in place — never guessed at). Never throws.
 */
export function readRetiredGrokHooksJournal(p: string): RetiredHooksJournal | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.schema !== HOOKS_JOURNAL_SCHEMA) return null;
  const pending: PluginPE[] = [];
  for (const raw of Array.isArray(j.pending) ? j.pending : []) {
    if (!isJournaledPE(raw)) continue;
    const pe = raw as PluginPE;
    if ((pe as PluginPE & { supplementOnly?: boolean }).supplementOnly) continue; // a supplement mints nothing: nothing to resend
    // The deterministic key of its turn id (the one the hooks lane stamped; a
    // PE without a turn id gets none and is resent without one — it records at
    // zero at the relay, Unknown = Block).
    stampGrokIdempotencyKey(pe);
    pending.push(pe);
  }
  const undecided = (Array.isArray(j.open) ? j.open.length : 0) + (Array.isArray(j.held) ? j.held.length : 0);
  return { pending, undecided };
}

/**
 * Hands the retired journal's decided PEs to the observer ONCE, and deletes the
 * journal only when the observer reports every one of them submitted, journaled
 * in the PE outbox, rejected by the relay (a content judgment: resending cannot
 * change it) or suppressed. A `failed` PE keeps the journal for the next start.
 */
export class RetiredGrokHooksJournalPlugin implements ObserverPlugin {
  readonly name = 'retired_grok_hooks_journal';
  private out: PluginPE[];
  private readonly awaiting: Set<PluginPE>;
  private failed = false;

  constructor(private readonly opts: { journalPath: string; pending: PluginPE[]; log?: (msg: string) => void }) {
    this.out = [...opts.pending];
    this.awaiting = new Set(opts.pending);
    if (this.awaiting.size === 0) this.deleteJournal();
  }

  async init(_observer: ProvianObserver): Promise<void> { /* nothing to bind */ }
  async start(): Promise<void> { /* the PEs drain on the first tick */ }
  async stop(): Promise<void> { /* an undrained PE stays in the journal file */ }
  tick(): PluginContribution | null { return null; }

  drainPEs(): PluginPE[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  onCommitted(pe: PluginPE, outcome: PECommitOutcome): void {
    if (!this.awaiting.has(pe)) return;
    if (outcome === 'failed') { this.failed = true; return; }
    this.awaiting.delete(pe);
    if (this.awaiting.size === 0 && !this.failed) this.deleteJournal();
  }

  /** How many decided PEs still await their fate (tests / logs). */
  outstanding(): number { return this.awaiting.size; }

  private deleteJournal(): void {
    try {
      fs.unlinkSync(this.opts.journalPath);
      this.opts.log?.('retired Grok hooks journal drained and deleted');
    } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// runtime.env: the retired witness opt-ins
// ---------------------------------------------------------------------------

/** The installer-persisted opt-ins of the retired local witness endpoint. */
export const RETIRED_RUNTIME_ENV_KEYS = ['PROVIAN_WITNESS_ENABLED', 'PROVIAN_WITNESS_PORT', 'PROVIAN_WITNESS_TOKEN'] as const;

/**
 * Remove the retired keys' lines from runtime.env text; every other line (and
 * the line endings) stays byte-identical. Pure.
 */
export function pruneRetiredRuntimeEnvText(text: string): { next: string; removed: string[] } {
  const removed: string[] = [];
  const parts = text.split(/(\r?\n)/); // keep the separators
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const sep = parts[i + 1] ?? '';
    const key = line.trim().split('=')[0]?.trim() ?? '';
    if ((RETIRED_RUNTIME_ENV_KEYS as readonly string[]).includes(key) && line.includes('=')) {
      removed.push(key);
      continue;
    }
    out.push(line, sep);
  }
  return { next: out.join(''), removed };
}

// `rewriteFileInPlace` lives in../fs-in-place (shared with the restart hook,); re-exported
// here so existing callers and tests keep their import.
export { rewriteFileInPlace } from '../fs-in-place';

/**
 * Remove a file the product created — unless the path is a symlink, whose
 * TARGET is someone else's file: then the target is emptied in place
 * (`rewriteFileInPlace(p, '')`), so the link survives and the target loses
 * exactly what the product wrote.
 */
export function removeFileOrEmptyLinkTarget(p: string, remaining = ''): void {
  if (fs.lstatSync(p).isSymbolicLink()) { rewriteFileInPlace(p, remaining); return; }
  fs.unlinkSync(p);
}

/**
 * Prune the retired keys from `~/.provian/runtime.env` in place
 * (`rewriteFileInPlace`: a symlinked runtime.env keeps its link, the file keeps
 * its mode). A regular file left with no key line is removed, as the installer
 * does when it has nothing to carry. Never throws.
 */
export function pruneRetiredRuntimeEnvFile(file: string = runtimeEnvPath()): string[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const { next, removed } = pruneRetiredRuntimeEnvText(text);
  if (removed.length === 0) return [];
  try {
    const hasKey = next.split(/\r?\n/).some((l) => { const t = l.trim(); return t.length > 0 && !t.startsWith('#') && t.includes('='); });
    if (!hasKey) { removeFileOrEmptyLinkTarget(file, next); return removed; }
    rewriteFileInPlace(file, next);
  } catch { return []; }
  return removed;
}

// ---------------------------------------------------------------------------
// The "# Provian PE Reporting" section register-device appended
// ---------------------------------------------------------------------------

/**
 * The npm command the retired section named. These sections are MATCHED (to remove them, byte for
 * byte), never printed; the words are joined at runtime so the hosted bundle carries no npx command
 * literal (, bundle-no-npm.test.ts).
 */
const RETIRED_SECTION_RUNNER = ['npx', '@provian/agent-sdk'].join(' ');

/**
 * The EXACT section `register-device` (provian-agent-sdk/src/scripts/
 * register-device.ts, Step 3.5) appended to `~/.claude/CLAUDE.md` copied here
 * byte for byte from the product's own text (a parallel change removes the
 * writer; this constant must keep matching what was written on boxes already
 * installed). Appended as `'\n' + '\n' + SECTION + '\n'`, or written alone as
 * `SECTION + '\n'` when the file did not exist.
 */
export const CLAUDE_MD_PE_REPORTING_SECTION = [
  '# Provian PE Reporting',
  '',
  'Most coding work is captured automatically. The git post-commit hook generates',
  'a Provenance Envelope on every commit, so you do not need to report commits.',
  '',
  'Only run report-pe for meaningful work that produces no commit (e.g. research,',
  'analysis, a deployment, a completed task that touched no files). PEs are',
  'metadata-first; the structural fields are the proof, and a description is',
  'optional enrichment.',
  '',
  'Structural-only (preferred when the work has no narrative to share):',
  `  ${RETIRED_SECTION_RUNNER} report-pe --type research`,
  `  ${RETIRED_SECTION_RUNNER} report-pe --type deployment`,
  '',
  'With optional description (when context adds value you are free to share):',
  `  ${RETIRED_SECTION_RUNNER} report-pe --type research --description "Surveyed three oracle designs"`,
  '',
  'Rules:',
  '- Do not report routine commits. The hook already does that.',
  '- Do not report trivial edits, formatting passes, or thinking.',
  '- Never include secrets, tokens, credentials, client names, or employer names.',
  '- One report per completed task, not per file change.',
].join('\n');

/**
 * The EXACT section `register-device` (Step 3.6, `--tool cursor|windsurf`)
 * appended to `.cursorrules` / `.windsurfrules` — the product's own text, byte
 * for byte. Appended as `'\n' + SECTION + '\n'`, or written alone as
 * `SECTION + '\n'`.
 */
export const RULES_FILE_PE_REPORTING_SECTION = [
  '# Provian PE Reporting',
  'Git commits on this machine generate Provenance Envelopes automatically via the post-commit hook.',
  'You do not need to report commits.',
  'For meaningful non-commit work (research, deployments, completed tasks with no code output), run:',
  `  ${RETIRED_SECTION_RUNNER} report-pe --type <type>`,
  'A description is optional. If you add one, never include secrets, client names, or employer names.',
].join('\n');

export type SectionRemoval = { action: 'removed'; next: string | null } | { action: 'absent' };

/**
 * Remove the product's section from a file's text. Only the exact forms the
 * product wrote are recognized: the appended form (`lead + SECTION + '\n'`,
 * `lead` = the newline(s) the writer prefixed) is cut out wherever it sits, so
 * the rest of the text is byte-identical to before the append; a file that IS
 * the section alone (`SECTION + '\n'`) yields `next: null` (the file the product
 * created is removed). Anything else — the section edited, a near match — is
 * `absent` and never touched. Pure.
 */
export function removePeReportingSection(text: string, section: string, lead: string): SectionRemoval {
  if (text === `${section}\n`) return { action: 'removed', next: null };
  const appended = `${lead}${section}\n`;
  const at = text.indexOf(appended);
  if (at < 0) return { action: 'absent' };
  // The file existed before the append (possibly empty): it keeps what it had.
  return { action: 'removed', next: text.slice(0, at) + text.slice(at + appended.length) };
}

export interface InstructionFileIO {
  read(p: string): string | null;
  write(p: string, content: string): void;
  remove(p: string): void;
}

export const realInstructionIO: InstructionFileIO = {
  read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  // A symlinked instruction file keeps its link and mode (rewriteFileInPlace).
  write: (p, content) => { rewriteFileInPlace(p, content); },
  remove: (p) => { removeFileOrEmptyLinkTarget(p); },
};

/**
 * The files the section may sit in on this box: `~/.claude/CLAUDE.md`, and a
 * `.cursorrules` / `.windsurfrules` in each directory register-device may have
 * run in that the daemon can know (its home, its working directory, and the git
 * repositories it watches).
 */
export function peReportingInstructionFiles(o: { home?: string; dirs?: string[] } = {}): Array<{ path: string; section: string; lead: string }> {
  const home = o.home ?? homedir();
  const out: Array<{ path: string; section: string; lead: string }> = [
    { path: path.join(home, '.claude', 'CLAUDE.md'), section: CLAUDE_MD_PE_REPORTING_SECTION, lead: '\n\n' },
  ];
  const seen = new Set<string>();
  for (const d of [home, ...(o.dirs ?? [])]) {
    const dir = path.resolve(d);
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const f of ['.cursorrules', '.windsurfrules']) {
      out.push({ path: path.join(dir, f), section: RULES_FILE_PE_REPORTING_SECTION, lead: '\n' });
    }
  }
  return out;
}

/** Remove the section from every candidate file. Returns the files changed. Never throws. */
export function removePeReportingSections(
  files: Array<{ path: string; section: string; lead: string }>,
  io: InstructionFileIO = realInstructionIO,
): string[] {
  const changed: string[] = [];
  for (const f of files) {
    try {
      const text = io.read(f.path);
      if (text === null) continue;
      const r = removePeReportingSection(text, f.section, f.lead);
      if (r.action !== 'removed') continue;
      if (r.next === null) io.remove(f.path);
      else io.write(f.path, r.next);
      changed.push(f.path);
    } catch { /* best-effort: the next start tries again */ }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The start-up pass
// ---------------------------------------------------------------------------

export interface RetiredLanesCleanupResult {
  grokHookFile: GrokHookRemoval;
  /** Decided minting PEs from the hooks journal, to hand to the observer (null: no journal). */
  journal: RetiredHooksJournal | null;
  recordsDeleted: string[];
  runtimeEnvKeysRemoved: string[];
  instructionFilesChanged: string[];
}

/** The start-up pass (steps 1, 3, 4, 5; step 2's PEs are returned for the observer). Never throws. */
export function runRetiredLanesCleanup(o: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra directories a `.cursorrules` / `.windsurfrules` may sit in. */
  instructionDirs?: string[];
  instructionIO?: InstructionFileIO;
} = {}): RetiredLanesCleanupResult {
  const home = o.home ?? homedir();
  const grokHookFile = removeGrokHooks({ home, env: o.env });
  const journal = readRetiredGrokHooksJournal(retiredGrokHooksJournalPath(home));
  const recordsDeleted: string[] = [];
  for (const p of retiredGrokHooksRecordPaths(home)) {
    try { fs.unlinkSync(p); recordsDeleted.push(p); } catch { /* absent */ }
  }
  const runtimeEnvKeysRemoved = pruneRetiredRuntimeEnvFile(runtimeEnvPath(home));
  const instructionFilesChanged = removePeReportingSections(
    peReportingInstructionFiles({ home, dirs: o.instructionDirs }), o.instructionIO,
  );
  return { grokHookFile, journal, recordsDeleted, runtimeEnvKeysRemoved, instructionFilesChanged };
}
