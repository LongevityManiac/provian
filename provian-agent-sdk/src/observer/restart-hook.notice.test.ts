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

function runNotice(arg = ''): string {
  const r = spawnSync('/bin/sh', [noticeScriptPath(home), arg], { env: env(), encoding: 'utf8', timeout: 10_000 });
  expect(r.status).toBe(0);
  return r.stdout;
}

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

  it('prints a notice once, again when it changes, and again after 30 minutes while it still waits', () => {
    writeNotice({ instruction: INSTRUCTION, lane: 'process' });
    expect(runNotice()).toContain(INSTRUCTION);
    expect(runNotice()).toBe('');
    writeNotice({ instruction: `${INSTRUCTION} (changed)`, lane: 'process' });
    expect(runNotice()).toContain('(changed)');
    expect(runNotice()).toBe('');
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
  it.runIf(has('bash'))('bash reading ~/.bashrc: the notice precedes the command output; with none the output is untouched', () => {
    installNoticeHook({ home, zshPresent: false });
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe(restartHookBlock({ restart: false }));
    const run = (): string => spawnSync('bash', ['-i', '-c', 'echo agent-command-output'], { env: env(), encoding: 'utf8', timeout: 10_000 }).stdout;
    expect(run()).toBe('agent-command-output\n');
    writeNotice({ instruction: INSTRUCTION, lane: 'process' });
    const out = run();
    expect(out).toContain(INSTRUCTION);
    expect(out.endsWith('agent-command-output\n')).toBe(true);
    expect(out.indexOf(INSTRUCTION)).toBeLessThan(out.indexOf('agent-command-output'));
    // A login shell reading ~/.profile gets it too (a fresh notice, so it is shown again).
    writeNotice({ instruction: `${INSTRUCTION} login`, lane: 'process' });
    const login = spawnSync('bash', ['-l', '-c', 'echo agent-command-output'], { env: env(), encoding: 'utf8', timeout: 10_000 }).stdout;
    expect(login).toContain(`${INSTRUCTION} login`);
  });

  it.runIf(has('zsh'))('zsh -c (every zsh reads ~/.zshenv): the notice precedes the command output; with none the output is untouched', () => {
    installNoticeHook({ home, zshPresent: true });
    const run = (): string => spawnSync('zsh', ['-c', 'echo agent-command-output'], { env: env(), encoding: 'utf8', timeout: 10_000 }).stdout;
    expect(run()).toBe('agent-command-output\n');
    writeNotice({ instruction: INSTRUCTION, lane: 'transcript' });
    const out = run();
    expect(out).toContain(INSTRUCTION);
    expect(out.endsWith('agent-command-output\n')).toBe(true);
  });

  it.runIf(has('bash'))('the opt-out removes the block, and uninstall removes the script: then nothing prints', () => {
    installNoticeHook({ home, zshPresent: false });
    writeNotice({ instruction: INSTRUCTION });
    installNoticeHook({ home, zshPresent: false, rc: false });
    const out = spawnSync('bash', ['-i', '-c', 'echo x'], { env: env(), encoding: 'utf8', timeout: 10_000 }).stdout;
    expect(out).toBe('x\n');
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
