/**
 * restart-hook — bring the observer daemon back on a box with NO service manager (§3 item 4).
 *
 * THE BOX. A hosted Linux sandbox (the operator’s Grok bot): the daemon runs as `agent.js observe`,
 * parented by the sandbox's process keeper; there is no cron and no systemd user manager
 * (capture-health `supervision_method: "detached"`). `/home/<user>` persists across a reboot and
 * across an instance move ("Update Grok Bot's Computer" files under $HOME kept, apt/npm installs
 * and everything outside $HOME not). Nothing restarted the daemon after either. The agent opens a
 * shell on every tool call.
 *
 * THE MECHANISM. Two files, both under $HOME (so both survive an instance move):
 * 1. `~/.provian/bin/provian-ensure` a pure-POSIX-sh script: if the pidfile (or the lock) names
 * a live process that IS our `observe` daemon (verified by /proc/<pid>/cmdline on Linux,
 * `ps -p <pid> -o command=` elsewhere — a pid that survived a reboot may now belong to anything),
 * it exits 0 at once: no node spawn. Otherwise it starts `observe --if-not-running` fully
 * detached (a double fork in a subshell, stdio to the observer log, so no job-control noise and
 * the shell never waits on it). At most one start attempt a minute.
 * 2. A marker-delimited guard block at the TOP of the user's shell startup files that runs (1),
 * silently. Top, not bottom: Debian/Ubuntu's stock ~/.bashrc returns early for a
 * non-interactive shell, and a block after that guard would never run there.
 * ~/.bashrc (created if absent) — interactive bash (`bash -i`), and the
 * non-interactive bash sshd starts
 * ~/.profile (created if absent) — login sh/bash/dash (`bash -l`, `sh -l`)
 * ~/.bash_profile, ~/.bash_login — ONLY if they already exist: bash -l reads the
 * first of bash_profile/bash_login/profile, and
 * CREATING bash_profile would stop it reading
 * ~/.profile
 * ~/.zshenv (only when zsh is present) — every zsh, interactive or not
 * NOT covered, stated plainly: a plain non-interactive `bash -c` / `sh -c` with no BASH_ENV/ENV
 * reads no startup file at all. On that shell the second trigger is the act verbs: every verb
 * run through `~/.provian/bin/provian` runs (1) first.
 *
 * Symlinked rc files are edited THROUGH the link (fs-in-place.ts) and keep their mode. Idempotent:
 * a file already carrying the exact block is not rewritten. Installed when supervision resolves to
 * `detached` or `cron` on Linux (a cron binary may be present while crond is not running after a
 * container restart — seen in our Docker cells): at hosted install time (service.ts) and at every
 * daemon start (run-daemon.ts), so already-installed daemons get it by self-update with no user
 * action. `PROVIAN_RESTART_HOOK=0` opts out of the STARTUP-FILE edits (the daemon removes its rc
 * blocks); the ensure script stays — it is Provian's own file under ~/.provian/bin, and it is what
 * the agent's `provian observe --if-not-running` and every act verb run (review r2 #5: an
 * opted-out box whose mechanism is `agent` must still be able to start its observer). Uninstall
 * removes both. Every function here is best-effort and never throws.
 *
 * SCOPE: this restarts the daemon. It is reported as its own capture-health fact
 * (`restart_hook: 'shell_rc'`) and does NOT feed the Grok proxy repoint decision ('s
 * supervised-only rule stands; scope ruling).
 *
 * THE NOTICE. The same managed block carries a second line, on every macOS and Linux box (not only
 * the boxes that need the restart): when the observer has left `~/.provian/witness-action-required.json`
 * asking for something, `~/.provian/bin/provian-notice` prints it to stdout, so the agent reads it in
 * the output of the next command it runs. Nothing is scheduled and no model turn is spent looking:
 * with no notice the line costs one `test` builtin. The script prints a notice the first time a shell
 * meets it and again at most every 30 minutes while the same one waits, and never in a shell that
 * carries a file-transfer or git protocol on its stdout (sftp, scp, rsync, git over ssh). Every
 * `provian` command's JSON carries the same notice (act-verbs.ts), which covers a shell that reads no
 * startup file. On a box where the restart is not wanted the block holds the notice line alone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { rewriteFileInPlace } from '../fs-in-place';
import { ACTION_REQUIRED_FILE } from '../commons-messaging';

export const RESTART_HOOK_BEGIN = '# >>> provian-restart-hook (managed by Provian; uninstall removes it) >>>';
export const RESTART_HOOK_END = '# <<< provian-restart-hook <<<';
/** The start marker of the observer's crontab block (service.ts CRON_BLOCK_START begins with it). */
export const CRON_BLOCK_MARK = '# >>> provian-observer';

/** Opt-out: `PROVIAN_RESTART_HOOK=0` (also false/off/no). */
export const RESTART_HOOK_ENV = 'PROVIAN_RESTART_HOOK';

export function restartHookOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['0', 'false', 'off', 'no'].includes((env[RESTART_HOOK_ENV] ?? '').trim().toLowerCase());
}

const OPT_IN_VALUES = ['1', 'true', 'on', 'yes'];

/** The persisted opt-out (review r9 #2): the env var lives only in one process's environment. */
export function restartHookOptOutPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'restart-hook.optout');
}

/**
 * The opt-out as this box holds it: an explicit `PROVIAN_RESTART_HOOK=0|false|off|no` records it
 * (so a later daemon started by cron, `@reboot`, or the agent's own command — none of which carry
 * the variable — still honours it), an explicit `1|true|on|yes` clears it, and otherwise the
 * recorded choice stands. Never throws; an unwritable home falls back to the env alone.
 */
export function resolveRestartHookOptOut(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
  const p = restartHookOptOutPath(home);
  const v = (env[RESTART_HOOK_ENV] ?? '').trim().toLowerCase();
  try {
    if (restartHookOptedOut(env)) {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, '', { mode: 0o600 });
      return true;
    }
    if (OPT_IN_VALUES.includes(v)) {
      try { fs.unlinkSync(p); } catch { /* none */ }
      return false;
    }
    return fs.existsSync(p);
  } catch {
    return restartHookOptedOut(env);
  }
}

export function ensureScriptPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'bin', 'provian-ensure');
}

/** What the ensure script execs: an ABSOLUTE node + the observer entry args (never a PATH lookup). */
export interface RestartHookEntrypoint {
  command: string;
  args: string[];
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The substring the ensure script (and the node-side identity check) looks for in a live
 * process's command line to decide it is OUR daemon: the entry script, followed by ` observe`
 * when the entry is the hosted bundle's `observe` verb.
 */
export function observerCmdlineMarker(entry: RestartHookEntrypoint): string {
  return entry.args.join(' ');
}

/** The ensure script's exact bytes (pure — unit-testable). */
export function ensureScriptContent(entry: RestartHookEntrypoint): string {
  const marker = observerCmdlineMarker(entry);
  const startArgs = [...entry.args, '--if-not-running'].map(shQuote).join(' ');
  return [
    '#!/bin/sh',
    '# Provian restart hook: starts the observer daemon when it is not running. Silent;',
    '# always exits 0. Written by the Provian install and refreshed by the daemon; uninstall removes it.',
    '# The opt-out stops the STARTUP-FILE trigger only. The agent running `provian observe',
    '# --if-not-running` (the `agent` mechanism) and the act verbs run this directly and still start it.',
    '# Same spellings as the daemon (restartHookOptedOut): 0, false, off, no — any case, spaces trimmed.',
    'P="$HOME/.provian"',
    `if [ "$1" = rc ]; then case "$(printf '%s' "\${${RESTART_HOOK_ENV}:-}" | tr -d ' \\t' | tr '[:upper:]' '[:lower:]')" in 0|false|off|no) exit 0 ;; esac; fi`,
    '# The recorded opt-out (a daemon started without the variable must still honour it).',
    '[ "$1" = rc ] && [ -f "$P/restart-hook.optout" ] && exit 0',
    '# Never let the wrapper\'s marker reach the daemon this starts (it would read as a typed command).',
    'unset PROVIAN_VIA_SHIM',
    '# Run from a startup file: that file IS sourced on this box — the proof the restart',
    '# mechanism here is the shell (capture health reports it). Structure only: an empty file.',
    '[ "$1" = rc ] && : > "$P/restart-hook.fired" 2>/dev/null',
    `MARK=${shQuote(marker)}`,
    '# Is <pid> alive AND our observe daemon? A pid that survived a reboot may belong to anything.',
    'provian_ours() {',
    '  case "$1" in ""|*[!0-9]*) return 1 ;; esac',
    '  kill -0 "$1" 2>/dev/null || return 1',
    '  if [ -r "/proc/$1/cmdline" ]; then',
    '    c=$(tr \'\\000\' \' \' < "/proc/$1/cmdline" 2>/dev/null)',
    '  else',
    '    c=$(ps -p "$1" -o command= 2>/dev/null)',
    '  fi',
    '  case "$c" in *"$MARK"*) return 0 ;; esac',
    '  return 1',
    '}',
    'provian_ours "$(cat "$P/observer.pid" 2>/dev/null)" && exit 0',
    'provian_ours "$(cat "$P/observer.lock/pid" 2>/dev/null)" && exit 0',
    '# At most one start attempt a minute (a daemon that cannot start must not cost every shell a node).',
    'S="$P/restart-hook.stamp"',
    '# The agent asking for it (`provian observe --if-not-running`) is never throttled.',
    'if [ "${PROVIAN_ENSURE_NOW:-0}" != 1 ] && [ -f "$S" ] && [ -n "$(find "$S" -mmin -1 2>/dev/null)" ]; then exit 0; fi',
    ': > "$S" 2>/dev/null',
    '# The node that wrote this; after an instance move that dropped it, the private runtime, then PATH.',
    `N=${shQuote(entry.command)}`,
    '[ -x "$N" ] || N="$P/node/bin/node"',
    '[ -x "$N" ] || N=$(command -v node 2>/dev/null)',
    '[ -n "$N" ] || exit 0',
    '# A new session (setsid) so a terminal hangup never reaches the daemon; nohup where setsid is absent.',
    'if command -v setsid >/dev/null 2>&1; then L=setsid; else L=nohup; fi',
    '# How the daemon started here labels its supervision, decided NOW (review r9 #1 / r10 #1): `cron`',
    '# only when our crontab block is installed AND a cron daemon is running (its next tick would have',
    '# restarted it — this only got there first); otherwise `detached`, the truth on a box where a',
    '# crontab exists but crond does not run (nothing restarts it; self-update must re-exec it).',
    'SUP=detached',
    `if crontab -l 2>/dev/null | grep -qF ${shQuote(CRON_BLOCK_MARK)}; then`,
    '  for d in "${PROVIAN_PROC_ROOT:-/proc}"/[0-9]*; do',
    '    c=$(cat "$d/comm" 2>/dev/null)',
    '    case "$c" in',
    '      cron|crond|cronie) SUP=cron; break ;;',
    '      busybox) if tr \'\\000\' \'\\n\' < "$d/cmdline" 2>/dev/null | grep -qx crond; then SUP=cron; break; fi ;;',
    '    esac',
    '  done',
    'fi',
    `( cd "$HOME" && PROVIAN_SUPERVISOR=$SUP $L "$N" ${startArgs} >>"$P/observer.log" 2>&1 </dev/null & ) >/dev/null 2>&1`,
    'exit 0',
    '',
  ].join('\n');
}

export function noticeScriptPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'bin', 'provian-notice');
}

/** The stamp holding the checksum of the notice last printed (the 30-minute repeat clock is its mtime). */
export const NOTICE_SHOWN_FILE = 'witness-notice.shown';

/** The protocols that run a non-interactive shell whose stdout is the protocol stream: never print there. */
export const NOTICE_SILENT_COMMANDS = [
  '*sftp-server*', '*internal-sftp*', 'scp\\ *', '*rsync\\ --server*',
  'git-upload-pack*', 'git-receive-pack*', 'git-upload-archive*',
  "git\\ upload-pack*", "git\\ receive-pack*",
] as const;

/** The notice script's exact bytes (pure — unit-testable). */
export function noticeScriptContent(): string {
  return [
    '#!/bin/sh',
    '# Provian witness notice: prints the observer\'s action-required notice so the agent sees it in the',
    '# output of the next command it runs. Run by the Provian block in the shell startup files. Silent when',
    '# there is nothing to act on; always exits 0. Written by the Provian daemon; uninstall removes it.',
    'P="$HOME/.provian"',
    `F="$P/${ACTION_REQUIRED_FILE}"`,
    '[ -f "$F" ] || exit 0',
    '# $1 is the command string of the shell that read the startup file (bash/zsh -c). A file-transfer or',
    '# git protocol on that shell\'s stdout would break on any extra output.',
    `case "\${1:-}" in ${NOTICE_SILENT_COMMANDS.join('|')}) exit 0 ;; esac`,
    '# Only a notice that asks for something: an instruction, or a non-empty list of programs to re-describe.',
    'grep -q \'"instruction"\' "$F" 2>/dev/null || grep -q \'"programs":\\["\' "$F" 2>/dev/null || exit 0',
    '# Once for each new notice, and again at most every 30 minutes while the same one still waits.',
    'K=$(cksum < "$F" 2>/dev/null)',
    `S="$P/${NOTICE_SHOWN_FILE}"`,
    'if [ -f "$S" ] && [ "$(cat "$S" 2>/dev/null)" = "$K" ] && [ -z "$(find "$S" -mmin +29 2>/dev/null)" ]; then exit 0; fi',
    'printf \'%s\\n\' "$K" > "$S" 2>/dev/null',
    'printf \'%s\\n\' "Provian: your witness needs attention. Act on this notice now, then carry on with your task. It is the file $F:"',
    'cat "$F" 2>/dev/null',
    'printf \'\\n\'',
    'exit 0',
    '',
  ].join('\n');
}

const RESTART_LINE = 'if [ -x "$HOME/.provian/bin/provian-ensure" ]; then "$HOME/.provian/bin/provian-ensure" rc >/dev/null 2>&1 </dev/null; fi';
/** No notice file: one `test` builtin, no fork. The shell's own command string goes to the script. */
const NOTICE_LINE = `if [ -f "$HOME/.provian/${ACTION_REQUIRED_FILE}" ] && [ -x "$HOME/.provian/bin/provian-notice" ]; then "$HOME/.provian/bin/provian-notice" "\${BASH_EXECUTION_STRING-}\${ZSH_EXECUTION_STRING-}" 2>/dev/null </dev/null; fi`;

/**
 * The guard block written into each startup file (pure): the silent restart line where the box needs
 * the restart (`restart`, the default), and the notice line always.
 */
export function restartHookBlock(opts: { restart?: boolean } = {}): string {
  return [
    RESTART_HOOK_BEGIN,
    ...(opts.restart === false ? [] : [RESTART_LINE]),
    NOTICE_LINE,
    RESTART_HOOK_END,
    '',
  ].join('\n');
}

/** Remove the Provian block (and only it) from a file's content (pure). */
export function stripRestartHookBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line === RESTART_HOOK_BEGIN) { inside = true; continue; }
    if (inside) { if (line === RESTART_HOOK_END) inside = false; continue; }
    out.push(line);
  }
  // An unterminated block (hand-edited) drops everything after the marker — never: keep the original.
  if (inside) return content;
  return out.join('\n');
}

/** The block at the top of `content`, the rest byte-identical (pure). */
export function mergeRestartHookBlock(content: string, block: string = restartHookBlock()): string {
  return block + stripRestartHookBlock(content);
}

export interface RcTarget {
  path: string;
  /** Create the file when absent. */
  create: boolean;
}

/** The startup files the block goes into on this box (see the header for why each). */
export function restartHookRcTargets(home: string = homedir(), zshPresent: boolean = commandOnPath('zsh')): RcTarget[] {
  const t: RcTarget[] = [
    { path: path.join(home, '.bashrc'), create: true },
    { path: path.join(home, '.profile'), create: true },
    { path: path.join(home, '.bash_profile'), create: false },
    { path: path.join(home, '.bash_login'), create: false },
  ];
  if (zshPresent) t.push({ path: path.join(home, '.zshenv'), create: true });
  return t;
}

function commandOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** Exists at all — a dangling symlink counts (it is the user's file; never replace it). */
function present(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

export type RcOutcome = 'written' | 'current' | 'created' | 'skipped' | 'removed' | 'absent' | 'error';

export type ScriptOutcome = 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'error';

export interface RestartHookResult {
  /** The ensure script (the restart). `absent` on a notice-only install, which never writes it. */
  script: ScriptOutcome;
  /** The notice script. */
  notice?: ScriptOutcome;
  rc: Record<string, RcOutcome>;
}

function writeRc(target: RcTarget, block: string): RcOutcome {
  try {
    if (!present(target.path)) {
      if (!target.create) return 'skipped';
      fs.writeFileSync(target.path, block, { mode: 0o644, flag: 'wx' });
      return 'created';
    }
    const have = fs.readFileSync(target.path, 'utf8');
    const next = mergeRestartHookBlock(have, block);
    if (next === have) return 'current';
    rewriteFileInPlace(target.path, next);
    return 'written';
  } catch {
    return 'error';
  }
}

function removeRc(p: string): RcOutcome {
  try {
    if (!present(p)) return 'absent';
    const have = fs.readFileSync(p, 'utf8');
    if (!have.includes(RESTART_HOOK_BEGIN)) return 'absent';
    const next = stripRestartHookBlock(have);
    if (next === have) return 'absent';
    rewriteFileInPlace(p, next);
    return 'removed';
  } catch {
    return 'error';
  }
}

export interface InstallRestartHookOptions {
  home?: string;
  entry: RestartHookEntrypoint;
  zshPresent?: boolean;
  /** false = write the ensure script only, and REMOVE any rc blocks (the opt-out). Default true. */
  rc?: boolean;
}

/** Write `content` to an executable script at `target` unless it already holds it. Throws on failure. */
function writeScript(target: string, content: string): ScriptOutcome {
  let existing: string | null = null;
  try { existing = fs.readFileSync(target, 'utf8'); } catch { existing = null; }
  if (existing === content) {
    try { if ((fs.statSync(target).mode & 0o111) === 0) fs.chmodSync(target, 0o755); } catch { /* best effort */ }
    return 'unchanged';
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
  return existing === null ? 'installed' : 'updated';
}

function writeNoticeScript(home: string): ScriptOutcome {
  try { return writeScript(noticeScriptPath(home), noticeScriptContent()); } catch { return 'error'; }
}

/** Write (or refresh) the ensure script, the notice script and the rc blocks. Never throws. */
export function installRestartHook(opts: InstallRestartHookOptions): RestartHookResult {
  const home = opts.home ?? homedir();
  const result: RestartHookResult = { script: 'error', rc: {} };
  if (!path.isAbsolute(opts.entry.command) || opts.entry.args.length === 0) return result;
  try {
    result.script = writeScript(ensureScriptPath(home), ensureScriptContent(opts.entry));
  } catch {
    return result;
  }
  result.notice = writeNoticeScript(home);
  if (opts.rc === false) {
    for (const t of restartHookRcTargets(home, true)) result.rc[t.path] = removeRc(t.path);
    return result;
  }
  const block = restartHookBlock();
  for (const t of restartHookRcTargets(home, opts.zshPresent)) result.rc[t.path] = writeRc(t, block);
  return result;
}

/**
 * The notice alone, for a box whose daemon something else restarts (systemd, launchd, a live cron
 * on macOS…): the notice script, and the block with only the notice line — replacing a block that
 * also carried the restart line. `rc: false` (the opt-out) removes the blocks. Never throws.
 */
export function installNoticeHook(opts: { home?: string; zshPresent?: boolean; rc?: boolean } = {}): RestartHookResult {
  const home = opts.home ?? homedir();
  const result: RestartHookResult = { script: 'absent', notice: writeNoticeScript(home), rc: {} };
  if (opts.rc === false) {
    for (const t of restartHookRcTargets(home, true)) result.rc[t.path] = removeRc(t.path);
    return result;
  }
  if (result.notice === 'error') return result;
  const block = restartHookBlock({ restart: false });
  for (const t of restartHookRcTargets(home, opts.zshPresent)) result.rc[t.path] = writeRc(t, block);
  return result;
}

/** Remove the rc blocks (every candidate file, even ones we would not create) and both scripts. */
export function uninstallRestartHook(opts: { home?: string } = {}): RestartHookResult {
  const home = opts.home ?? homedir();
  const result: RestartHookResult = { script: 'absent', notice: 'absent', rc: {} };
  for (const t of restartHookRcTargets(home, true)) result.rc[t.path] = removeRc(t.path);
  const unlink = (p: string): ScriptOutcome => {
    try { fs.unlinkSync(p); return 'removed'; } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'error'; }
  };
  result.script = unlink(ensureScriptPath(home));
  result.notice = unlink(noticeScriptPath(home));
  try { fs.unlinkSync(path.join(home, '.provian', 'restart-hook.stamp')); } catch { /* none */ }
  try { fs.unlinkSync(path.join(home, '.provian', NOTICE_SHOWN_FILE)); } catch { /* none */ }
  try { fs.unlinkSync(restartHookOptOutPath(home)); } catch { /* none */ }
  return result;
}

/**
 * Is the restart hook in effect on this box — the ensure script is executable AND at least one
 * startup file carries the block WITH its restart line (a notice-only block restarts nothing)? This is
 * what capture-health reports (`restart_hook: 'shell_rc'`) (nothing else reads it — not the Grok
 * repoint decision). Never throws.
 */
export function restartHookInstalled(home: string = homedir()): boolean {
  try {
    const st = fs.statSync(ensureScriptPath(home));
    if (!st.isFile() || (st.mode & 0o111) === 0) return false;
  } catch {
    return false;
  }
  for (const t of restartHookRcTargets(home, true)) {
    try {
      const text = fs.readFileSync(t.path, 'utf8');
      const begin = text.indexOf(RESTART_HOOK_BEGIN);
      const end = begin < 0 ? -1 : text.indexOf(RESTART_HOOK_END, begin);
      if (end > begin && text.slice(begin, end).includes(RESTART_LINE)) return true;
    } catch { /* next */ }
  }
  return false;
}

/** Does this supervision method need the hook (Linux, no service manager or an unreliable cron)? */
export function restartHookWanted(method: string, platform: NodeJS.Platform = process.platform): boolean {
  // `unknown` (a daemon an agent's shell started, marker unset) is exactly the box nothing restarts:
  // the operator’s pre- Grok bot had no ensure script because its daemon reported `unknown`.
  return platform === 'linux' && (method === 'detached' || method === 'cron' || method === 'unknown');
}

/** Startup files run the notice on every macOS and Linux box; Windows has none of them. */
export function noticeHookWanted(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

/**
 * The daemon-start heal (so self-updated daemons get the hook with no user action): on a box whose
 * supervision wants the restart, write/refresh the full block; on any other macOS or Linux box, the
 * notice-only block (a box that later gained systemd loses the restart line and keeps the notice) — or
 * remove the blocks when opted out. Returns what happened, or null when nothing applied (Windows).
 * Never throws.
 */
export function healRestartHook(opts: {
  method: string;
  entry: RestartHookEntrypoint;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  zshPresent?: boolean;
}): RestartHookResult | null {
  try {
    if (!restartHookWanted(opts.method, opts.platform)) {
      if (!noticeHookWanted(opts.platform)) return null;
      return installNoticeHook({ home: opts.home, zshPresent: opts.zshPresent, rc: !resolveRestartHookOptOut(opts.env ?? process.env, opts.home) });
    }
    // Opted out: the ensure script stays (the agent's `observe --if-not-running` runs it); rc blocks go.
    return installRestartHook({ home: opts.home, entry: opts.entry, zshPresent: opts.zshPresent, rc: !resolveRestartHookOptOut(opts.env ?? process.env, opts.home) });
  } catch {
    return null;
  }
}

/**
 * The observe entry a RUNNING daemon was started with (its own argv — the truth on this box):
 * `[<bundle>, 'observe']` for the hosted bundle, `[<start-observer.js>]` for an npm install.
 * Null when it cannot be read (then the heal skips).
 */
export function runningObserverEntry(argv: readonly string[] = process.argv, execPath: string = process.execPath): RestartHookEntrypoint | null {
  const script = argv[1];
  if (typeof script !== 'string' || !path.isAbsolute(script) || !path.isAbsolute(execPath)) return null;
  return { command: execPath, args: argv[2] === 'observe' ? [script, 'observe'] : [script] };
}

/**
 * Run the ensure script if this box has one (the act verbs' second trigger). Bounded; never throws.
 * Returns whether it ran.
 */
export function runEnsureScript(home: string = homedir(), extraEnv: Record<string, string> = {}): boolean {
  const p = ensureScriptPath(home);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    delete env.PROVIAN_VIA_SHIM; // the daemon it starts must never read as a typed command
    execFileSync('/bin/sh', [p], { stdio: 'ignore', timeout: 8_000, cwd: home, env });
  } catch { /* fail-open: an act verb never fails because the ensure did */ }
  return true;
}


// ---------------------------------------------------------------------------
// Which mechanism restarts the daemon on this box
// ---------------------------------------------------------------------------

/**
 * The restart mechanism a box actually has (closed set). A service manager when one
 * supervises the daemon; cron only when a cron daemon is running to tick it; `shell_rc`
 * only when a startup file carrying the hook is really SOURCED on this box (proven by the
 * hook having fired, or by the install's own shell being interactive / login); otherwise
 * `agent` nothing on the box restarts it, so the agent keeps it running as setup
 * (the standing rule: on a box with no cron, no systemd and no startup file read, the restart
 * mechanism is the agent).
 */
export type RestartMechanism = 'systemd' | 'launchd' | 'scheduled_task' | 'cron' | 'shell_rc' | 'agent';
export const RESTART_MECHANISMS: readonly RestartMechanism[] = ['systemd', 'launchd', 'scheduled_task', 'cron', 'shell_rc', 'agent'];

export function resolveRestartMechanism(f: {
  method: string;
  cronAlive: boolean | null;
  hookInstalled: boolean;
  rcFired: boolean;
  installShellSourcesRc: boolean | null;
}): RestartMechanism {
  if (f.method === 'systemd' || f.method === 'launchd' || f.method === 'scheduled_task') return f.method;
  if (f.method === 'cron' && f.cronAlive === true) return 'cron';
  if (f.hookInstalled && (f.rcFired || f.installShellSourcesRc === true)) return 'shell_rc';
  return 'agent';
}

export function restartHookFiredPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'restart-hook.fired');
}

/** Has a startup file ever run the hook on this box? */
export function restartHookFired(home: string = homedir()): boolean {
  try { return fs.statSync(restartHookFiredPath(home)).isFile(); } catch { return false; }
}

const PROBE_FILE = 'restart-probe.json';

/** Persist the install-time shell probe (a boolean, nothing else). Best-effort. */
export function recordInstallShellProbe(value: boolean | null, home: string = homedir()): void {
  try {
    fs.mkdirSync(path.join(home, '.provian'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.provian', PROBE_FILE), JSON.stringify({ install_shell_sources_rc: value }), { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function readInstallShellProbe(home: string = homedir()): boolean | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.provian', PROBE_FILE), 'utf8')) as { install_shell_sources_rc?: unknown };
    return typeof j.install_shell_sources_rc === 'boolean' ? j.install_shell_sources_rc : null;
  } catch {
    return null;
  }
}

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ash', 'ksh']);

/** One ancestor process: its argv and whether its stdin is a terminal. */
export interface ProcFacts { argv: string[]; stdinTty: boolean; ppid: number | null }

function readProcFacts(pid: number): ProcFacts | null {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    let stdinTty = false;
    try { stdinTty = /^\/dev\/(pts\/\d+|tty)/.test(fs.readlinkSync(`/proc/${pid}/fd/0`)); } catch { stdinTty = false; }
    return { argv, stdinTty, ppid: Number.isFinite(ppid) && ppid > 1 ? ppid : null };
  } catch {
    return null;
  }
}

/**
 * Does the shell the install ran in read its startup files? Walks the process ancestry
 * (Linux /proc) for shells: a LOGIN shell (argv0 "-bash", `-l` / `--login`) or an
 * INTERACTIVE one (`-i`, or no `-c` and no script with a terminal on stdin) reads them; a
 * `bash -c …` / `sh -c …` does not (the Grok Bot's exec-daemon spawns
 * `/usr/bin/bash -O extglob -c <wrapper>`, `$-` = hBHc). True when any ancestor shell reads
 * them; false when shells were found and none does; null when it cannot be told.
 */
export function probeInstallShellSourcesRc(
  startPid: number = process.ppid,
  read: (pid: number) => ProcFacts | null = readProcFacts,
): boolean | null {
  if (process.platform !== 'linux' && read === readProcFacts) return null;
  let pid: number | null = startPid;
  let sawShell = false;
  for (let depth = 0; pid !== null && depth < 12; depth++) {
    const f = read(pid);
    if (!f || f.argv.length === 0) break;
    const argv0 = f.argv[0];
    const name = path.basename(argv0.replace(/^-/, ''));
    if (SHELLS.has(name)) {
      sawShell = true;
      const flags = f.argv.slice(1).filter((a) => a.startsWith('-') && !a.startsWith('--') || a === '--login');
      const shortFlags = flags.filter((a) => !a.startsWith('--')).join('');
      const login = argv0.startsWith('-') || f.argv.includes('--login') || /l/.test(shortFlags);
      const interactiveFlag = /i/.test(shortFlags);
      const hasC = /c/.test(shortFlags);
      const operands = f.argv.slice(1).filter((a) => !a.startsWith('-'));
      // `bash -O extglob -c …`: the -O argument is an option value, not a script operand.
      const scriptOperand = !hasC && operands.length > 0 && !f.argv.includes('-O') && !f.argv.includes('-o');
      const interactive = interactiveFlag || (!hasC && !scriptOperand && f.stdinTty);
      if (login || interactive) return true;
    }
    pid = f.ppid;
  }
  return sawShell ? false : null;
}

/** Is a cron daemon process running? Linux only (/proc); null elsewhere. */
export function probeCronDaemon(): boolean | null {
  if (process.platform !== 'linux') return null;
  let entries: string[];
  try { entries = fs.readdirSync('/proc'); } catch { return null; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const comm = fs.readFileSync(`/proc/${e}/comm`, 'utf8').trim();
      if (comm === 'cron' || comm === 'crond' || comm === 'cronie') return true;
      if (comm === 'busybox' && isBusyboxCrond(e)) return true;
    } catch { /* process gone */ }
  }
  return false;
}

function isBusyboxCrond(pid: string): boolean {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('crond'); } catch { return false; }
}
