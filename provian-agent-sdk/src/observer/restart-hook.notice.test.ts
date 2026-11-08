/**
 * The witness notice in the startup hook. The invariant: an agent that never runs a scheduled check
 * still sees a repair notice the next time it runs any command. Proven end to end by installing the
 * real block into a temporary HOME and running real shells that read it (bash reading ~/.bashrc, zsh
 * reading ~/.zshenv), with the RED control beside each claim: no notice → the command's output is
 * byte-identical to a run with no hook at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ACTION_REQUIRED_FILE, actionRequiredNotice } from '../commons-messaging';
import {
  NOTICE_SHOWN_FILE,
  installNoticeHook,
  noticeScriptContent,
  noticeScriptPath,
  restartHookBlock,
  uninstallRestartHook,
} from './restart-hook';

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-notice-')));
  fs.mkdirSync(path.join(home, '.provian'), { recursive: true });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const noticeFile = (): string => path.join(home, '.provian', ACTION_REQUIRED_FILE);
const writeNotice = (value: unknown): void => { fs.writeFileSync(noticeFile(), JSON.stringify(value) + '\n'); };
const INSTRUCTION = 'Your observer cannot parse the current session records. Re-describe them.';
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ZDOTDIR: home });

/** What the notice script prints (stderr). Its stdout must always stay empty. */
function runNotice(arg = ''): string {
  const r = spawnSync('/bin/sh', [noticeScriptPath(home), arg], { env: env(), encoding: 'utf8', timeout: 10_000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  return r.stderr;
}
const POINTER = 'Provian: a witness notice is waiting for you.';

const has = (bin: string): boolean => spawnSync('/bin/sh', ['-c', `command -v ${bin}`]).status === 0;

describe('the notice script (run under /bin/sh)', () => {
  beforeEach(() => { installNoticeHook({ home, zshPresent: false }); });

  it('is valid POSIX sh and executable', () => {
    expect(spawnSync('sh', ['-n'], { input: noticeScriptContent() }).status).toBe(0);
    expect(fs.statSync(noticeScriptPath(home)).mode & 0o111).not.toBe(0);
  });

  it('prints the notice when the observer asks for something, and nothing otherwise', () => {
    // RED controls first: no file, then a cleared remainder (the transcript lane leaves {"programs":[]}).
    expect(runNotice()).toBe('');
    writeNotice({ programs: [] });
    expect(runNotice()).toBe('');
    writeNotice({ instruction: INSTRUCTION, programs: ['grok'] });
    const out = runNotice();
    expect(out).toContain('Provian: your witness needs attention');
    expect(out).toContain(INSTRUCTION);
    expect(out).toContain(noticeFile());
    // A flagged program alone (no instruction) is something to act on too.
    writeNotice({ programs: ['codex'] });
    expect(runNotice()).toContain('"programs":["codex"]');
  });

  it('prints a notice in full once, again when it changes and after 30 minutes, and a pointer to it every other time', () => {
    writeNotice({ instruction: INSTRUCTION, lane: 'process' });
    expect(runNotice()).toContain(INSTRUCTION);
    // A shell whose output nobody read (an IDE probe) used the full print: the agent's next command
    // still shows where the notice is.
    const pointer = runNotice();
    expect(pointer).toContain(POINTER);
    expect(pointer).toContain(noticeFile());
    expect(pointer).not.toContain(INSTRUCTION);
    writeNotice({ instruction: `${INSTRUCTION} (changed)`, lane: 'process' });
    expect(runNotice()).toContain('(changed)');
    expect(runNotice()).toContain(POINTER);
    const stamp = path.join(home, '.provian', NOTICE_SHOWN_FILE);
    const old = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(stamp, old, old);
    expect(runNotice()).toContain('(changed)');
  });

  it('never prints in a shell carrying a file-transfer or git protocol on its stdout', () => {
    writeNotice({ instruction: INSTRUCTION });
    for (const cmd of ['/usr/lib/openssh/sftp-server', 'scp -t /tmp/x', 'rsync --server -vlogDtpre.iLsfxC . /tmp', "git-upload-pack '/repo.git'", "git-receive-pack 'r'"]) {
      expect(runNotice(cmd)).toBe('');
    }
    // RED control: an ordinary command string still gets it.
    expect(runNotice('ls -la')).toContain(INSTRUCTION);
  });
});

describe('the invariant: the next command an agent runs shows a waiting notice (real shells)', () => {
  /** A command run the way a harness runs it: its combined output, and its stdout alone. */
  const shell = (argv: string[]): { all: string; stdout: string } => {
    const r = spawnSync(argv[0], argv.slice(1), { env: env(), encoding: 'utf8', timeout: 10_000 });
    return { all: `${r.stderr}${r.stdout}`, stdout: r.stdout };
  };

  it.runIf(has('bash'))('bash reading ~/.bashrc: the notice shows with the command\'s output, before the next one; with none nothing is added', () => {
    installNoticeHook({ home, zshPresent: false });
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe(restartHookBlock({ restart: false }));
    const run = () => shell(['bash', '-i', '-c', 'echo agent-command-output']);
    expect(run().stdout).toBe('agent-command-output\n');
    expect(run().all).not.toContain('Provian');
    writeNotice({ instruction: INSTRUCTION, lane: 'process' });
    expect(run().all).toContain(INSTRUCTION);
    // The next command, and every one after it while the notice waits, still says so.
    expect(run().all).toContain(POINTER);
    // A login shell reading ~/.profile gets it too (a fresh notice, so it is shown in full again).
    writeNotice({ instruction: `${INSTRUCTION} login`, lane: 'process' });
    expect(shell(['bash', '-l', '-c', 'echo agent-command-output']).all).toContain(`${INSTRUCTION} login`);
  });

  it.runIf(has('bash'))('a shell whose stdout is data stays byte-identical while a notice waits (ssh host \'cat f\' > f)', () => {
    installNoticeHook({ home, zshPresent: false });
    const data = path.join(home, 'data.bin');
    fs.writeFileSync(data, Buffer.from([0, 1, 2, 255, 10, 13, 0x7b]));
    writeNotice({ instruction: INSTRUCTION, lane: 'process' });
    for (let i = 0; i < 2; i++) {
      const r = spawnSync('bash', ['-i', '-c', `cat '${data}'`], { env: env(), timeout: 10_000 });
      expect(Buffer.compare(r.stdout, fs.readFileSync(data))).toBe(0);
      // …and the notice is still in the command's output.
      expect(r.stderr.toString('utf8')).toMatch(/Provian:/);
    }
  });

  it.runIf(has('zsh'))('zsh -c (every zsh reads ~/.zshenv): the notice shows with the command\'s output; stdout is untouched', () => {
    installNoticeHook({ home, zshPresent: true });
    const run = () => shell(['zsh', '-c', 'echo agent-command-output']);
    expect(run().all).toBe('agent-command-output\n');
    writeNotice({ instruction: INSTRUCTION, lane: 'transcript' });
    const out = run();
    expect(out.all).toContain(INSTRUCTION);
    expect(out.stdout).toBe('agent-command-output\n');
  });

  it('never stacks blocks on a startup file holding a hand-edited, unterminated Provian block', () => {
    const rc = path.join(home, '.bashrc');
    const broken = `${restartHookBlock({ restart: false }).split('\n')[0]}\nmy own line\n`;
    fs.writeFileSync(rc, broken);
    for (let i = 0; i < 3; i++) expect(installNoticeHook({ home, zshPresent: false }).rc[rc]).toBe('skipped');
    expect(fs.readFileSync(rc, 'utf8')).toBe(broken);
  });

  it.runIf(has('bash'))('the opt-out removes the block, and uninstall removes the script: then nothing prints', () => {
    installNoticeHook({ home, zshPresent: false });
    writeNotice({ instruction: INSTRUCTION });
    installNoticeHook({ home, zshPresent: false, rc: false });
    const r = spawnSync('bash', ['-i', '-c', 'echo x'], { env: env(), encoding: 'utf8', timeout: 10_000 });
    expect(r.stdout).toBe('x\n');
    expect(r.stderr).not.toContain('Provian');
    const u = uninstallRestartHook({ home });
    expect(u.notice).toBe('removed');
    expect(fs.existsSync(noticeScriptPath(home))).toBe(false);
  });
});

describe('every provian command carries the notice (actionRequiredNotice)', () => {
  it('returns the instruction and flagged programs, and null when nothing is asked', () => {
    expect(actionRequiredNotice(home)).toBeNull();
    writeNotice({ programs: [] });
    expect(actionRequiredNotice(home)).toBeNull();
    fs.writeFileSync(noticeFile(), 'not json');
    expect(actionRequiredNotice(home)).toBeNull();
    writeNotice({ instruction: INSTRUCTION, lane: 'process', state: 'launcher_changed' });
    expect(actionRequiredNotice(home)).toEqual({ instruction: INSTRUCTION, file: noticeFile() });
    writeNotice({ programs: ['grok', 7] });
    expect(actionRequiredNotice(home)).toEqual({ programs: ['grok'], file: noticeFile() });
  });
});
