/**
 * process-lane/launcher — the launcher and the command wrapper, observed from a command the
 * agent itself ran. Each claim carries its RED control.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  observeLauncher, launcherFingerprint, matchesTemplate, templateOf, recordLauncher,
  readLauncherRecord, isOwnInvocationToken, DELIVERY_MS, launcherRecordKey, recordLauncherForProvianCommand, type LauncherProc,
} from './launcher';
import { createHash } from 'crypto';

function table(rows: LauncherProc[]): (pid: number) => LauncherProc | null {
  const m = new Map(rows.map((r) => [r.pid, r]));
  return (pid) => m.get(pid) ?? null;
}

const SANDBOX: LauncherProc = { pid: 53, ppid: 7, comm: 'sand-exit-watch', argv: ['python3', '/sand/exit-watch.py'] };
const HARNESS: LauncherProc = { pid: 388, ppid: 53, comm: 'node', argv: ['node', '/app/harness/server.js', '--port', '7000'], exe: '/usr/bin/node', startKey: '388:41234' };
const WRAPPER: LauncherProc = { pid: 900, ppid: 388, comm: 'bash', argv: ['bash', '--noprofile', '--norc', '-c', 'exec 3<>/run/cmd; cat <&3 | bash', 'wrap'], startKey: '900:51234' };
const SHIM: LauncherProc = { pid: 901, ppid: 900, comm: 'provian', argv: ['/bin/sh', '/home/u/.provian/bin/provian', 'doctor'] };
const DOCTOR: LauncherProc = { pid: 902, ppid: 901, comm: 'node', argv: ['/home/u/.provian/node/bin/node', '/home/u/.provian/agent.js', 'doctor'] };

describe('observeLauncher — the agent\'s own command finds its launcher', () => {
  it('walks past Provian\'s own processes and the shells to the harness; a fixed wrapper is the template', () => {
    const got = observeLauncher(table([SANDBOX, HARNESS, WRAPPER, SHIM, DOCTOR]), DOCTOR.pid);
    expect(got).not.toBeNull();
    expect(got!.fingerprint).toBe(launcherFingerprint(HARNESS, null));
    expect(got!.mode).toBe('template');
    expect(matchesTemplate(WRAPPER.argv, got!.template)).toBe(true);
  });

  it('the install line (curl | sh → node) finds the same launcher and the same wrapper', () => {
    const pipeSh: LauncherProc = { pid: 910, ppid: 900, comm: 'sh', argv: ['sh'] };
    const boot: LauncherProc = { pid: 911, ppid: 910, comm: 'node', argv: ['/home/u/.provian/node/bin/node', '/home/u/.provian/agent.js'] };
    const got = observeLauncher(table([SANDBOX, HARNESS, WRAPPER, pipeSh, boot]), boot.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(HARNESS, null));
    expect(got!.mode).toBe('template');
    expect(matchesTemplate(WRAPPER.argv, got!.template)).toBe(true);
  });

  it('skips npx / the npm dispatcher (Provian\'s own) on the way up', () => {
    const npx: LauncherProc = { pid: 920, ppid: 900, comm: 'npm exec', argv: ['npm', 'exec', '@provian/agent-sdk', 'doctor'] };
    const disp: LauncherProc = { pid: 921, ppid: 920, comm: 'node', argv: ['node', '/tmp/x/node_modules/@provian/agent-sdk/dist/scripts/dispatch.js', 'doctor'] };
    const doc: LauncherProc = { pid: 922, ppid: 921, comm: 'node', argv: ['node', '/tmp/x/node_modules/@provian/agent-sdk/dist/scripts/doctor.js'] };
    const got = observeLauncher(table([SANDBOX, HARNESS, WRAPPER, npx, disp, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(HARNESS, null));
  });

  it('a harness that runs on Provian\'s own node runtime is still the launcher (only Provian\'s scripts are skipped)', () => {
    const harness: LauncherProc = { pid: 388, ppid: 53, comm: 'node', argv: ['/home/u/.provian/node/bin/node', '/app/harness/server.js'] };
    const got = observeLauncher(table([SANDBOX, harness, WRAPPER, SHIM, DOCTOR]), DOCTOR.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(harness, null));
    expect(matchesTemplate(WRAPPER.argv, got!.template)).toBe(true);
  });

  it('an embedding wrapper (`bash -c "<the agent\'s command>"`) is direct mode: no template to match', () => {
    const embed: LauncherProc = { pid: 930, ppid: 388, comm: 'bash', argv: ['bash', '-c', '"$HOME/.provian/bin/provian" doctor'] };
    const shim: LauncherProc = { ...SHIM, pid: 931, ppid: 930 };
    const doc: LauncherProc = { ...DOCTOR, pid: 932, ppid: 931 };
    const got = observeLauncher(table([SANDBOX, HARNESS, embed, shim, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(HARNESS, null));
    expect(got!.mode).toBe('direct');
    expect(got!.template).toEqual([]);
  });

  it('a wrapper that exec\'d into the command (bash → shim → node, one pid) is direct mode, not a template of Provian\'s own argv', () => {
    const doc: LauncherProc = { ...DOCTOR, pid: 940, ppid: 388, argv: ['/home/u/.provian/node/bin/node', '/home/u/.provian/agent.js', 'process-lane', 'record'] };
    const got = observeLauncher(table([SANDBOX, HARNESS, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(HARNESS, null));
    expect(got!.mode).toBe('direct');
  });

  it('start times: a long-lived shell between the harness and the command makes the shape direct (unsupported); a fresh wrapper is a template', () => {
    const now = 1_000_000;
    const harness: LauncherProc = { pid: 388, ppid: 53, comm: 'node', argv: ['node', '/app/server.js'], startedAtMs: now - 3_600_000 };
    const pane: LauncherProc = { pid: 700, ppid: 388, comm: 'bash', argv: ['bash'], startedAtMs: now - 600_000 };   // persistent shell
    const shim: LauncherProc = { ...SHIM, pid: 701, ppid: 700, startedAtMs: now - 5 };
    const doc: LauncherProc = { ...DOCTOR, pid: 702, ppid: 701, startedAtMs: now };
    const got = observeLauncher(table([SANDBOX, harness, pane, shim, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(harness, null));
    expect(got!.mode).toBe('direct');
    // RED: the same chain with the shell started for this command is a fixed-wrapper template.
    const fresh = { ...pane, startedAtMs: now - (DELIVERY_MS - 1) };
    const viaWrapper = observeLauncher(table([SANDBOX, harness, fresh, shim, doc]), doc.pid);
    expect(viaWrapper!.mode).toBe('template');
    expect(matchesTemplate(fresh.argv, viaWrapper!.template)).toBe(true);
  });

  it('a harness that started a moment before the recording command is still the launcher, never its supervisor', () => {
    const now = 2_000_000;
    const supervisor: LauncherProc = { pid: 50, ppid: 1, comm: 'python3', argv: ['python3', '/sand/supervise.py'], startedAtMs: now - 3_600_000 };
    const harness: LauncherProc = { pid: 51, ppid: 50, comm: 'node', argv: ['node', '/app/harness/server.js'], startedAtMs: now - 500 };
    const wrap: LauncherProc = { ...WRAPPER, pid: 52, ppid: 51, startedAtMs: now - 20 };
    const shim: LauncherProc = { ...SHIM, pid: 54, ppid: 52, startedAtMs: now - 10 };
    const doc: LauncherProc = { ...DOCTOR, pid: 55, ppid: 54, startedAtMs: now };
    const got = observeLauncher(table([supervisor, harness, wrap, shim, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(harness, null));
    expect(got!.mode).toBe('template');
    expect(matchesTemplate(WRAPPER.argv, got!.template)).toBe(true);
  });

  it('a harness started by a service manager (systemd, launchd) is still the launcher; the service manager never is', () => {
    const systemd: LauncherProc = { pid: 1200, ppid: 1, comm: 'systemd', argv: ['/lib/systemd/systemd', '--user'] };
    const harness: LauncherProc = { pid: 1201, ppid: 1200, comm: 'node', argv: ['node', '/srv/agent/harness.js'] };
    const wrap: LauncherProc = { pid: 1202, ppid: 1201, comm: 'bash', argv: ['bash', '-c', 'read -r c < /run/q; eval "$c"'] };
    const doc: LauncherProc = { ...DOCTOR, pid: 1203, ppid: 1202 };
    const got = observeLauncher(table([systemd, harness, wrap, doc]), doc.pid);
    expect(got!.fingerprint).toBe(launcherFingerprint(harness, null));
    expect(got!.mode).toBe('template');
    // RED: a command run straight under the service manager has no launcher.
    const bare: LauncherProc = { pid: 1204, ppid: 1200, comm: 'sh', argv: ['sh', '-c', 'provian doctor'] };
    const doc2: LauncherProc = { ...DOCTOR, pid: 1205, ppid: 1204 };
    expect(observeLauncher(table([systemd, bare, doc2]), doc2.pid)).toBeNull();
  });

  it('RED: a person\'s terminal is never the launcher (a login shell under sshd, or sshd itself)', () => {
    const sshd: LauncherProc = { pid: 600, ppid: 1, comm: 'sshd', argv: ['sshd: bob@pts/0'] };
    const login: LauncherProc = { pid: 601, ppid: 600, comm: '-bash', argv: ['-bash'] };
    const sh: LauncherProc = { pid: 602, ppid: 601, comm: 'sh', argv: ['sh'] };
    const node: LauncherProc = { pid: 603, ppid: 602, comm: 'node', argv: ['node', '/home/bob/.provian/agent.js'] };
    expect(observeLauncher(table([sshd, login, sh, node]), node.pid)).toBeNull();
    // OpenSSH 9.8+ (sshd-session), tmux, and an IDE's terminal host are terminals too.
    const session: LauncherProc = { pid: 610, ppid: 1, comm: 'sshd-session', argv: ['sshd-session: bob@pts/1'] };
    const tmux: LauncherProc = { pid: 620, ppid: 1, comm: 'tmux: server', argv: ['tmux'] };
    const pty: LauncherProc = { pid: 630, ppid: 1, comm: 'node', argv: ['/usr/lib/code/node', '/usr/lib/code/out/vs/platform/terminal/node/ptyHostMain.js'] };
    for (const term of [session, tmux, pty]) {
      const shell: LauncherProc = { pid: term.pid + 1, ppid: term.pid, comm: 'bash', argv: ['-bash'] };
      const cmd: LauncherProc = { pid: term.pid + 2, ppid: term.pid + 1, comm: 'node', argv: ['node', '/home/bob/.provian/agent.js', 'doctor'] };
      expect(observeLauncher(table([term, shell, cmd]), cmd.pid)).toBeNull();
    }
  });

  it('RED: a command with no launcher above it (a container exec straight to pid 0/1) records nothing', () => {
    const sh: LauncherProc = { pid: 30, ppid: 0, comm: 'sh', argv: ['sh', '-c', 'provian doctor'] };
    const node: LauncherProc = { pid: 31, ppid: 30, comm: 'node', argv: ['node', '/root/.provian/agent.js', 'doctor'] };
    expect(observeLauncher(table([sh, node]), node.pid)).toBeNull();
  });
});

describe('templates — a fixed wrapper matches only itself', () => {
  it('exact per-token match (RED: the harness\'s check line does not match)', () => {
    const t = templateOf(WRAPPER.argv);
    expect(matchesTemplate(WRAPPER.argv, t)).toBe(true);
    expect(matchesTemplate(['bash', '--noprofile', '--norc', '-c', 'curl -s http://127.0.0.1:7001/status', 'chk'], t)).toBe(false);
    expect(matchesTemplate(WRAPPER.argv.slice(0, -1), t)).toBe(false);
  });

  it('isOwnInvocationToken names the install line and provian commands, not ordinary text', () => {
    expect(isOwnInvocationToken("curl -sSL 'https://api.provian.ai/v1/bootstrap/agent' | sh")).toBe(true);
    expect(isOwnInvocationToken('"$HOME/.provian/bin/provian" doctor')).toBe(true);
    expect(isOwnInvocationToken('provian doctor')).toBe(true);
    expect(isOwnInvocationToken('ls ~')).toBe(false);
    expect(isOwnInvocationToken('exec 3<>/run/cmd; cat <&3 | bash')).toBe(false);
  });
});

describe('recordLauncher — install/record overwrite; doctor and act verbs only fill a gap', () => {
  const read = table([SANDBOX, HARNESS, WRAPPER, SHIM, DOCTOR]);
  it('writes a hashes-only record; a non-forced call keeps an existing one; a forced call replaces it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-rec-')), 'process-launcher.json');
    expect(recordLauncher({ source: 'doctor', force: false, file, read, startPid: DOCTOR.pid, now: () => 5 })).toBe('recorded');
    const first = readLauncherRecord(file)!;
    expect(first.mode).toBe('template');
    expect(first.launcher_start_key).toBe(HARNESS.startKey);                   // the process the walk reached
    expect(first.command_start_key).toBe(WRAPPER.startKey);                    // the recording command's own root
    expect(JSON.stringify(first)).not.toMatch(/harness|server\.js|cat <&3/);  // structure only on disk
    expect(recordLauncher({ source: 'act_verb', force: false, file, read, startPid: DOCTOR.pid, now: () => 6 })).toBe('kept');
    expect(readLauncherRecord(file)!.recorded_at_ms).toBe(5);
    expect(recordLauncher({ source: 'record', force: true, file, read, startPid: DOCTOR.pid, now: () => 7 })).toBe('recorded');
    expect(readLauncherRecord(file)!.recorded_at_ms).toBe(7);
  });

  it('an unusable command_start_key drops only that field, never the record (RED: a usable one is kept)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-rec-')), 'process-launcher.json');
    expect(recordLauncher({ source: 'doctor', force: false, file, read, startPid: DOCTOR.pid, now: () => 5 })).toBe('recorded');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(readLauncherRecord(file)!.command_start_key).toBe(WRAPPER.startKey);
    fs.writeFileSync(file, JSON.stringify({ ...rec, command_start_key: 'not a key/../' }));
    const bad = readLauncherRecord(file)!;
    expect(bad.command_start_key).toBeUndefined();
    expect(bad.launcher_start_key).toBe(HARNESS.startKey);
    expect(bad.mode).toBe('template');
  });

  it('RED: no launcher above the command → nothing is written', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-rec-')), 'process-launcher.json');
    const lone: LauncherProc = { pid: 40, ppid: 1, comm: 'node', argv: ['node', '/root/.provian/agent.js', 'doctor'] };
    expect(recordLauncher({ source: 'doctor', force: false, file, read: table([lone]), startPid: 40 })).toBe('no_launcher');
    expect(readLauncherRecord(file)).toBeNull();
  });
});

// The correction : when the lane is not recognising the agent's commands under
// the current record, any `provian` command the agent runs under a launcher with the recorded
// fingerprint re-records the wrapper it came through — no one is asked to do anything. Invariant: a
// re-record only ever comes from a process under the fingerprinted launcher.
describe('recordLauncher — a provian command heals the wrapper under the fingerprinted launcher', () => {
  const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
  const W2: LauncherProc = { ...WRAPPER, argv: ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap'], startKey: '930:61234' };
  const SHIM2: LauncherProc = { ...SHIM, pid: 931, ppid: W2.pid };
  const CMD2: LauncherProc = { ...DOCTOR, pid: 932, ppid: SHIM2.pid, argv: ['/home/u/.provian/node/bin/node', '/home/u/.provian/agent.js', 'status'] };
  const setup = (state: string, recordHash?: (key: string) => string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-heal-'));
    const file = path.join(dir, 'process-launcher.json');
    const stateFile = path.join(dir, 'process-lane-state.json');
    expect(recordLauncher({ source: 'doctor', force: false, file, read: table([SANDBOX, HARNESS, WRAPPER, SHIM, DOCTOR]), startPid: DOCTOR.pid, now: () => 5 })).toBe('recorded');
    const key = launcherRecordKey(readLauncherRecord(file)!);
    fs.writeFileSync(stateFile, JSON.stringify({ state, at_ms: 9, since_ms: 8, v: 2, record: (recordHash ?? sha)(key) }));
    return { file, stateFile };
  };
  const heal = (f: { file: string; stateFile: string }, rows: LauncherProc[] = [SANDBOX, HARNESS, W2, SHIM2, CMD2], startPid = CMD2.pid) =>
    recordLauncher({ source: 'cli', force: false, file: f.file, stateFile: f.stateFile, read: table(rows), startPid, now: () => 50 });

  it.each(['launcher_unconfirmed', 'launcher_changed', 'launcher_not_seen'])('while the lane says %s, a command under the same launcher with a new wrapper re-records it', (state) => {
    const f = setup(state);
    expect(heal(f)).toBe('healed');
    const rec = readLauncherRecord(f.file)!;
    expect(rec).toMatchObject({ source: 'heal', recorded_at_ms: 50, fingerprint: launcherFingerprint(HARNESS, null), mode: 'template' });
    expect(matchesTemplate(W2.argv, rec.template)).toBe(true);
    expect(matchesTemplate(WRAPPER.argv, rec.template)).toBe(false);
  });

  it('RED: a healthy lane, a state judged under another record, or no state file keeps the record', () => {
    for (const f of [setup('active'), setup('launcher_changed', () => sha('another-record')), setup('no_launcher')]) {
      expect(heal(f)).toBe('kept');
      expect(readLauncherRecord(f.file)!.recorded_at_ms).toBe(5);
    }
    const f = setup('launcher_changed');
    fs.rmSync(f.stateFile);
    expect(heal(f)).toBe('kept');
  });

  it('RED: a command under a launcher with another fingerprint — another program, or a person\'s terminal — never re-records', () => {
    const OTHER: LauncherProc = { ...HARNESS, argv: ['python3', '/opt/other-harness.py'], comm: 'python3', exe: '/usr/bin/python3' };
    const f = setup('launcher_changed');
    expect(heal(f, [SANDBOX, OTHER, W2, SHIM2, CMD2])).toBe('kept');
    const sshd: LauncherProc = { pid: 700, ppid: 1, comm: 'sshd', argv: ['sshd: u@pts/0'] };
    const login: LauncherProc = { pid: 701, ppid: 700, comm: 'bash', argv: ['-bash'] };
    const shim: LauncherProc = { ...SHIM, pid: 702, ppid: 701 };
    const cmd: LauncherProc = { ...CMD2, pid: 703, ppid: 702 };
    expect(heal(f, [sshd, login, shim, cmd], cmd.pid)).toBe('kept');
    expect(readLauncherRecord(f.file)!.recorded_at_ms).toBe(5);
  });

  it('RED: a command whose wrapper embeds it (direct mode) never re-records a template record', () => {
    const f = setup('launcher_changed');
    const embed: LauncherProc = { ...W2, argv: ['bash', '-c', '"$HOME/.provian/bin/provian" status'] };
    expect(heal(f, [SANDBOX, HARNESS, embed, SHIM2, CMD2])).toBe('kept');
    expect(readLauncherRecord(f.file)!.recorded_at_ms).toBe(5);
  });
});

describe('recordLauncherForProvianCommand — every `provian` command through the wrapper gets the heal', () => {
  it('through the wrapper: a non-forced record (act verbs as act_verb, every other command as cli); RED: not through the wrapper, nothing', () => {
    const calls: unknown[] = [];
    const fake = ((o: unknown) => { calls.push(o); return 'healed'; }) as typeof recordLauncher;
    expect(recordLauncherForProvianCommand(true, 'status', fake)).toBe('healed');
    expect(recordLauncherForProvianCommand(true, null, fake)).toBe('healed');
    expect(calls).toEqual([{ source: 'cli', force: false }, { source: 'act_verb', force: false }]);
    expect(recordLauncherForProvianCommand(false, 'observe', fake)).toBe('not_via_wrapper');
    expect(calls).toHaveLength(2);
  });

  it('the bundle entry runs it for every command, before any verb dispatch (RED: removing the call fails here)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'bootstrap.ts'), 'utf8');
    const call = src.indexOf('recordLauncherForProvianCommand(viaShim, verb);');
    expect(call).toBeGreaterThan(src.indexOf('const verb = resolveBootstrapVerb(process.argv);'));
    expect(call).toBeLessThan(src.indexOf('if (verb === null) {'));
  });
});
