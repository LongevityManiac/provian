/**
 * what an installed daemon removes at start (retired-lanes-cleanup.ts):
 * the retired Grok hook file (only Provian's), the hooks lane's records (its
 * decided PEs resubmitted once, never lost, never doubled), the retired
 * PROVIAN_WITNESS_* lines in runtime.env, and exactly the "# Provian PE
 * Reporting" section register-device appended — the rest of every file
 * byte-identical, a file without the exact section never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CLAUDE_MD_PE_REPORTING_SECTION, RULES_FILE_PE_REPORTING_SECTION, removePeReportingSection, removePeReportingSections,
  peReportingInstructionFiles, pruneRetiredRuntimeEnvText, pruneRetiredRuntimeEnvFile, readRetiredGrokHooksJournal,
  RetiredGrokHooksJournalPlugin, runRetiredLanesCleanup, retiredGrokHooksJournalPath, retiredGrokHooksRecordPaths,
} from './retired-lanes-cleanup';
import { createHash } from 'crypto';
const grokTurnIdempotencyKey = (id: string): string => 'pe_grok_' + createHash('sha256').update('grok_turn_v1\x1f'+id).digest('hex').slice(0,40);
import type { PluginPE } from './types';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-retired-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** What register-device wrote, reproduced from its own code path (Step 3.5 / 3.6). */
const CLAUDE_INSTRUCTION = `\n${CLAUDE_MD_PE_REPORTING_SECTION}`; // the writer's array begins with ''
const appendClaude = (existing: string): string => `${existing}\n${CLAUDE_INSTRUCTION}\n`;
const createClaude = (): string => `${CLAUDE_INSTRUCTION.trimStart()}\n`;
const appendRules = (existing: string): string => `${existing}\n${RULES_FILE_PE_REPORTING_SECTION}\n`;

describe('the "# Provian PE Reporting" section', () => {
  const USER = '# My rules\n\nAlways write tests.\n';

  it('appended to an existing CLAUDE.md: removed, the rest byte-identical to before the append', () => {
    const r = removePeReportingSection(appendClaude(USER), CLAUDE_MD_PE_REPORTING_SECTION, '\n\n');
    expect(r).toEqual({ action: 'removed', next: USER });
  });

  it('appended in the MIDDLE (the user wrote more after it): only the section goes', () => {
    const text = `${appendClaude(USER)}\n# Later\nkeep me\n`;
    const r = removePeReportingSection(text, CLAUDE_MD_PE_REPORTING_SECTION, '\n\n');
    expect(r).toEqual({ action: 'removed', next: `${USER}\n# Later\nkeep me\n` });
  });

  it('a CLAUDE.md register-device CREATED (the section alone): the file is removed', () => {
    expect(removePeReportingSection(createClaude(), CLAUDE_MD_PE_REPORTING_SECTION, '\n\n')).toEqual({ action: 'removed', next: null });
  });

  it('the rules-file variant (.cursorrules / .windsurfrules), appended and created', () => {
    expect(removePeReportingSection(appendRules('keep'), RULES_FILE_PE_REPORTING_SECTION, '\n')).toEqual({ action: 'removed', next: 'keep' });
    expect(removePeReportingSection(`${RULES_FILE_PE_REPORTING_SECTION}\n`, RULES_FILE_PE_REPORTING_SECTION, '\n')).toEqual({ action: 'removed', next: null });
  });

  it('RED control — an EDITED section, a near match, or a file without it is never touched', () => {
    const edited = appendClaude(USER).replace('One report per completed task', 'One report per task');
    expect(removePeReportingSection(edited, CLAUDE_MD_PE_REPORTING_SECTION, '\n\n')).toEqual({ action: 'absent' });
    expect(removePeReportingSection(USER, CLAUDE_MD_PE_REPORTING_SECTION, '\n\n')).toEqual({ action: 'absent' });
    expect(removePeReportingSection('# Provian PE Reporting\n', CLAUDE_MD_PE_REPORTING_SECTION, '\n\n')).toEqual({ action: 'absent' });
    // The heading alone, or the heading with other text, is a user's own section.
    expect(removePeReportingSection(`${USER}\n# Provian PE Reporting\nmine\n`, CLAUDE_MD_PE_REPORTING_SECTION, '\n\n')).toEqual({ action: 'absent' });
  });

  it('on disk: CLAUDE.md, .cursorrules and .windsurfrules — removed where present, others untouched (bytes and mtime)', () => {
    const claude = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, appendClaude(USER));
    const proj = path.join(home, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, '.cursorrules'), `${RULES_FILE_PE_REPORTING_SECTION}\n`);
    const untouched = path.join(home, '.windsurfrules');
    fs.writeFileSync(untouched, 'windsurf rules of my own\n');
    const before = fs.statSync(untouched).mtimeMs;
    const files = peReportingInstructionFiles({ home, dirs: [proj] });
    const changed = removePeReportingSections(files);
    expect(changed.sort()).toEqual([claude, path.join(proj, '.cursorrules')].sort());
    expect(fs.readFileSync(claude, 'utf8')).toBe(USER);
    expect(fs.existsSync(path.join(proj, '.cursorrules'))).toBe(false);
    expect(fs.readFileSync(untouched, 'utf8')).toBe('windsurf rules of my own\n');
    expect(fs.statSync(untouched).mtimeMs).toBe(before);
    // Idempotent: a second pass changes nothing.
    expect(removePeReportingSections(files)).toEqual([]);
  });

  it('the constant is the product\'s own text — the heading and the report-pe lines register-device wrote', () => {
    const lines = CLAUDE_MD_PE_REPORTING_SECTION.split('\n');
    expect(lines[0]).toBe('# Provian PE Reporting');
    expect(lines).toContain('  npx @provian/agent-sdk report-pe --type research');
    expect(lines[lines.length - 1]).toBe('- One report per completed task, not per file change.');
    expect(lines).toHaveLength(22);
    expect(RULES_FILE_PE_REPORTING_SECTION.split('\n')).toHaveLength(6);
  });
});

describe('runtime.env: the retired witness opt-ins', () => {
  it('only the PROVIAN_WITNESS_* lines go; every other line and the line endings stay byte-identical', () => {
    const text = '# Written by the Provian installer.\nHTTPS_PROXY=http://p:8080\nPROVIAN_WITNESS_ENABLED=1\nNO_PROXY=127.0.0.1\r\nPROVIAN_WITNESS_PORT=4319\nPROVIAN_WITNESS_TOKEN=t\n';
    expect(pruneRetiredRuntimeEnvText(text)).toEqual({
      next: '# Written by the Provian installer.\nHTTPS_PROXY=http://p:8080\nNO_PROXY=127.0.0.1\r\n',
      removed: ['PROVIAN_WITNESS_ENABLED', 'PROVIAN_WITNESS_PORT', 'PROVIAN_WITNESS_TOKEN'],
    });
    // RED control: a file without them is unchanged.
    expect(pruneRetiredRuntimeEnvText('HTTPS_PROXY=x\n')).toEqual({ next: 'HTTPS_PROXY=x\n', removed: [] });
  });

  it('on disk: a file left with no key is removed (as the installer does); one with keys is rewritten keeping its 0600', () => {
    const f = path.join(home, 'runtime.env');
    fs.writeFileSync(f, '# Written by the Provian installer.\nPROVIAN_WITNESS_ENABLED=1\n', { mode: 0o600 });
    expect(pruneRetiredRuntimeEnvFile(f)).toEqual(['PROVIAN_WITNESS_ENABLED']);
    expect(fs.existsSync(f)).toBe(false);
    fs.writeFileSync(f, 'HTTPS_PROXY=http://p\nPROVIAN_WITNESS_ENABLED=1\n', { mode: 0o600 });
    expect(pruneRetiredRuntimeEnvFile(f)).toEqual(['PROVIAN_WITNESS_ENABLED']);
    expect(fs.readFileSync(f, 'utf8')).toBe('HTTPS_PROXY=http://p\n');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(pruneRetiredRuntimeEnvFile(path.join(home, 'absent.env'))).toEqual([]);
  });

  it('RED ( , defect 4): a SYMLINKED runtime.env keeps its link; the target loses exactly the witness lines, keeping its mode', () => {
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'runtime.env');
    fs.writeFileSync(target, 'HTTPS_PROXY=http://p\nPROVIAN_WITNESS_ENABLED=1\n');
    fs.chmodSync(target, 0o640);
    const link = path.join(home, 'runtime.env');
    fs.symlinkSync(target, link);
    expect(pruneRetiredRuntimeEnvFile(link)).toEqual(['PROVIAN_WITNESS_ENABLED']);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('HTTPS_PROXY=http://p\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dotfiles)).toEqual(['runtime.env']); // no temp file left behind
    // Nothing left but a comment: the link stays and its target is emptied of the keys (never unlinked).
    fs.writeFileSync(target, '# Written by the Provian installer.\nPROVIAN_WITNESS_TOKEN=t\n');
    expect(pruneRetiredRuntimeEnvFile(link)).toEqual(['PROVIAN_WITNESS_TOKEN']);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Written by the Provian installer.\n');
  });
});

const mintingPE = (turnId: string): PluginPE => ({
  actionType: 'agent_tool_orchestration', description: 'grok turn — 1 tool call: read_file',
  metadata: { tool: 'provian-observer-grok-hooks', source: 'grok_hooks', harness: 'grok', turn_id: turnId, tool_count: 1 },
  windowStart: 1, windowEnd: 2, skipDedupClaim: true, idempotencyKey: grokTurnIdempotencyKey(turnId),
});

describe('the retired hooks journal', () => {
  const writeJournal = (j: Record<string, unknown>): string => {
    const p = retiredGrokHooksJournalPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(j));
    return p;
  };

  it('reads the decided minting PEs with their deterministic keys; supplements and undecided turns are counted, not resent', () => {
    const p = writeJournal({
      schema: 1,
      open: [{ session_id: 's', prompt_id: 'p1' }],
      held: [{ reason: 'stop', turn: { session_id: 's', prompt_id: 'p2' } }],
      pending: [mintingPE('t1'), { ...mintingPE('t2'), idempotencyKey: undefined }, { ...mintingPE('t3'), supplementOnly: true }, { junk: true }],
    });
    const j = readRetiredGrokHooksJournal(p)!;
    expect(j.undecided).toBe(2);
    expect(j.pending.map((pe) => pe.metadata?.turn_id)).toEqual(['t1', 't2']);
    // The key is the turn's own (re-stamped where the journal lost it) — a resend is answered with the PE the relay made.
    expect(j.pending.map((pe) => pe.idempotencyKey)).toEqual([grokTurnIdempotencyKey('t1'), grokTurnIdempotencyKey('t2')]);
    // Unreadable / another schema → null, left in place.
    expect(readRetiredGrokHooksJournal(writeJournal({ schema: 9, pending: [mintingPE('x')] }))).toBeNull();
  });

  it('the plugin hands each decided PE over ONCE and deletes the journal only after every fate is known', () => {
    const p = writeJournal({ schema: 1, pending: [mintingPE('t1'), mintingPE('t2')] });
    const j = readRetiredGrokHooksJournal(p)!;
    const plugin = new RetiredGrokHooksJournalPlugin({ journalPath: p, pending: j.pending });
    const first = plugin.drainPEs();
    expect(first).toHaveLength(2);
    expect(plugin.drainPEs()).toEqual([]); // once — never a second hand-over
    plugin.onCommitted(first[0], 'journaled');
    expect(fs.existsSync(p)).toBe(true); // one fate still unknown
    plugin.onCommitted(first[1], 'submitted');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('RED control — a PE that neither reached the relay nor the outbox (failed) keeps the journal for the next start', () => {
    const p = writeJournal({ schema: 1, pending: [mintingPE('t1'), mintingPE('t2')] });
    const plugin = new RetiredGrokHooksJournalPlugin({ journalPath: p, pending: readRetiredGrokHooksJournal(p)!.pending });
    const [a, b] = plugin.drainPEs();
    plugin.onCommitted(a, 'failed');
    plugin.onCommitted(b, 'submitted');
    expect(fs.existsSync(p)).toBe(true);
    // The next start reads the same decided PEs again, under the same keys.
    expect(readRetiredGrokHooksJournal(p)!.pending.map((pe) => pe.idempotencyKey)).toEqual([grokTurnIdempotencyKey('t1'), grokTurnIdempotencyKey('t2')]);
  });

  it('a journal with nothing decided is deleted at once', () => {
    const p = writeJournal({ schema: 1, open: [{}], pending: [] });
    new RetiredGrokHooksJournalPlugin({ journalPath: p, pending: readRetiredGrokHooksJournal(p)!.pending });
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('runRetiredLanesCleanup — the start-up pass', () => {
  it('removes the Provian hook file, the hooks records, the witness lines and the CLAUDE.md section; returns the journal', () => {
    const hookFile = path.join(home, '.grok', 'hooks', 'provian.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify({ _provian: { managed_by: 'provian' }, hooks: {} }));
    const other = path.join(home, '.grok', 'hooks', 'mine.json');
    fs.writeFileSync(other, '{"hooks":{}}');
    fs.mkdirSync(path.join(home, '.provian'), { recursive: true });
    for (const p of retiredGrokHooksRecordPaths(home)) fs.writeFileSync(p, '{}');
    fs.writeFileSync(retiredGrokHooksJournalPath(home), JSON.stringify({ schema: 1, pending: [mintingPE('t1')] }));
    fs.writeFileSync(path.join(home, '.provian', 'runtime.env'), 'HTTPS_PROXY=http://p\nPROVIAN_WITNESS_ENABLED=1\n');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), appendClaude('mine\n'));

    const r = runRetiredLanesCleanup({ home, env: {} });
    expect(r.grokHookFile).toBe('removed');
    expect(fs.existsSync(hookFile)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('{"hooks":{}}'); // nothing else under ~/.grok/hooks
    expect(r.recordsDeleted).toHaveLength(3);
    expect(r.journal?.pending).toHaveLength(1);
    expect(fs.existsSync(retiredGrokHooksJournalPath(home))).toBe(true); // deleted only after the PE's fate is known
    expect(r.runtimeEnvKeysRemoved).toEqual(['PROVIAN_WITNESS_ENABLED']);
    expect(fs.readFileSync(path.join(home, '.provian', 'runtime.env'), 'utf8')).toBe('HTTPS_PROXY=http://p\n');
    expect(r.instructionFilesChanged).toEqual([path.join(home, '.claude', 'CLAUDE.md')]);
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('mine\n');
  });

  it('RED control — a foreign provian.json is left in place; a box with nothing retired is untouched', () => {
    const hookFile = path.join(home, '.grok', 'hooks', 'provian.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script' }] }] } }));
    const r = runRetiredLanesCleanup({ home, env: {} });
    expect(r).toEqual({ grokHookFile: 'foreign', journal: null, recordsDeleted: [], runtimeEnvKeysRemoved: [], instructionFilesChanged: [] });
    expect(fs.existsSync(hookFile)).toBe(true);
  });
});

describe('instruction files on disk ( , defect 4): a symlink is edited through, never replaced', () => {
  const USER = '# My rules\n\nAlways write tests.\n';

  it('RED: a symlinked ~/.claude/CLAUDE.md keeps its link; the target loses exactly the section and keeps its mode', () => {
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'CLAUDE.md');
    fs.writeFileSync(target, appendClaude(USER));
    fs.chmodSync(target, 0o640);
    fs.mkdirSync(path.join(home, '.claude'));
    const link = path.join(home, '.claude', 'CLAUDE.md');
    fs.symlinkSync(target, link);

    const changed = removePeReportingSections(peReportingInstructionFiles({ home }));
    expect(changed).toEqual([link]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(USER);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dotfiles)).toEqual(['CLAUDE.md']);
  });

  it('RED: a symlinked .cursorrules that holds ONLY the section keeps its link; the target is emptied, not left with the section', () => {
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'cursorrules');
    fs.writeFileSync(target, `${RULES_FILE_PE_REPORTING_SECTION}\n`);
    const link = path.join(home, '.cursorrules');
    fs.symlinkSync(target, link);
    expect(removePeReportingSections(peReportingInstructionFiles({ home }))).toEqual([link]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('a regular file keeps its mode (0644 stays 0644, 0600 stays 0600), and a created-alone regular file is removed', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    const claude = path.join(home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(claude, appendClaude(USER));
    fs.chmodSync(claude, 0o600);
    const rules = path.join(home, '.windsurfrules');
    fs.writeFileSync(rules, `${RULES_FILE_PE_REPORTING_SECTION}\n`);
    expect(removePeReportingSections(peReportingInstructionFiles({ home })).sort()).toEqual([claude, rules].sort());
    expect(fs.readFileSync(claude, 'utf8')).toBe(USER);
    expect(fs.statSync(claude).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(rules)).toBe(false);
  });
});
