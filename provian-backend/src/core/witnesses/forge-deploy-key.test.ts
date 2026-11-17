/**
 * Deploy-key proof of project control: the key the relay issues, the strict
 * project path, the exact probe invocations (fixed hosts, pinned host keys,
 * no agent, no config), the GitLab write probe (receive-pack, flush-pkt only:
 * nothing is ever written), the Bitbucket read probe with canaries, outcome
 * mapping, and the attempt lifecycle. Nothing here reaches the network: the
 * process runner and the probe runner are injected. One test runs a real local
 * `git receive-pack` to show the probe's input changes nothing.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createPrivateKey } from 'crypto';
import { execFile, execFileSync, type ExecFileException } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  BITBUCKET_CANARIES,
  DEPLOY_KEY_ATTEMPTS_COLLECTION,
  DEPLOY_KEY_ATTEMPT_TTL_MS,
  FORGE_SSH_HOSTS,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_PATH,
  PROBE_TIMEOUT_MS,
  RECEIVE_PACK_PROBE_INPUT,
  beginDeployKeyAttempt,
  buildLsRemoteInvocation,
  buildReceivePackProbeInvocation,
  classifyLsRemote,
  classifyReceivePack,
  deployKeyInstructions,
  generateDeployKey,
  httpStatusForVerifyFailure,
  normalizeProjectPath,
  probeSshOptions,
  proveDeployKeyControl,
  readReceivePackAdvertisement,
  runForgeProbe,
  sshFingerprint,
  verifyDeployKeyAttempt,
  type DeployKeyProvider,
  type ExecFileFn,
  type ProbeOutcome,
  type ProbeRequest,
  type ProbeRunner,
} from './forge-deploy-key';
import { CONNECT_TTL_MS } from './github-connect';
import { FORGE_KNOWN_HOSTS, forgeKnownHostsFile } from './forge-known-hosts';
import { fingerprintOfPrivateKey, parseOpenSshPrivateKey } from './__test-helpers__/openssh-key';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

const OID = 'a88dc8b2f9e444be41c97e4b90dc1059ca09d4d9';
const ZERO = '0'.repeat(40);
const pkt = (payload: string): string => `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`;
/** A receive-pack ref advertisement as git sends it. */
const advertisement = (refs: Array<[string, string]>): string =>
  refs.map(([oid, name], i) => pkt(i === 0 ? `${oid} ${name}\0report-status delete-refs ofs-delta\n` : `${oid} ${name}\n`)).join('') + '0000';
const err = (fields: Partial<ExecFileException>): ExecFileException => Object.assign(new Error('x'), fields);

describe('generateDeployKey', () => {
  it('is an unencrypted openssh-key-v1 ed25519 key whose public half and fingerprint match what is returned', () => {
    const key = generateDeployKey();
    const parsed = parseOpenSshPrivateKey(key.privateKeyOpenSsh);
    expect(parsed.cipher).toBe('none');
    expect(parsed.kdf).toBe('none');
    expect(parsed.keyType).toBe('ssh-ed25519');
    expect(parsed.check1.equals(parsed.check2)).toBe(true);
    expect(parsed.secret).toHaveLength(64);
    expect(parsed.secret.subarray(32).equals(parsed.publicKey)).toBe(true);
    expect([...parsed.padding]).toEqual(Array.from({ length: parsed.padding.length }, (_, i) => i + 1));

    const [type, blob, comment] = key.publicKey.split(' ');
    expect(type).toBe('ssh-ed25519');
    expect(comment).toBe('provian-deploy-key');
    expect(Buffer.from(blob, 'base64').equals(parsed.publicBlob)).toBe(true);
    expect(key.fingerprint).toBe(parsed.fingerprint);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), parsed.secret.subarray(0, 32)]);
    const derived = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
    expect(Buffer.from(String(derived.x), 'base64url').equals(parsed.publicKey)).toBe(true);
  });

  it('every attempt gets a different key', () => {
    expect(generateDeployKey().fingerprint).not.toBe(generateDeployKey().fingerprint);
  });
});

describe('normalizeProjectPath', () => {
  it('accepts the forges\' path forms and lowercases them', () => {
    expect(normalizeProjectPath('gitlab', 'Group/Sub-Group/my_project.v2')).toBe('group/sub-group/my_project.v2');
    expect(normalizeProjectPath('gitlab', '  group/project  ')).toBe('group/project');
    expect(normalizeProjectPath('bitbucket', 'My-Workspace/repo.name')).toBe('my-workspace/repo.name');
  });

  it('RED: refuses anything that could be an option, a second path, a quote, a URL or a shell word', () => {
    const bad: Array<[DeployKeyProvider, unknown]> = [
      ['gitlab', '-oProxyCommand=touch /tmp/x/repo'], ['gitlab', 'group/-x'], ['gitlab', 'group/../other'],
      ['gitlab', 'group/project.git'], ['gitlab', 'group/project.atom'], ['gitlab', 'group/project.'],
      ['gitlab', 'project'], ['gitlab', '/group/project'], ['gitlab', 'group/project/'], ['gitlab', 'group//project'],
      ['gitlab', 'group/pro ject'], ['gitlab', 'group/project;rm -rf /'], ['gitlab', 'group/$(id)'],
      ['gitlab', "group/pro'ject"], ['gitlab', 'group/pro"ject'], ['gitlab', 'https://gitlab.com/group/project'],
      ['gitlab', 'git@evil.example:group/project'], ['gitlab', 'group/project\nother/project'],
      ['gitlab', `${'g/'.repeat(21)}p`], ['gitlab', `group/${'p'.repeat(600)}`], ['gitlab', 42], ['gitlab', null],
      ['bitbucket', 'workspace/repo/extra'], ['bitbucket', 'workspace'], ['bitbucket', 'workspace/repo.git'],
      ['bitbucket', '{3d76c1e2-d4bb-4baf-a957-ad7ba71f88c2}'],
    ];
    for (const [provider, raw] of bad) expect([provider, raw, normalizeProjectPath(provider, raw)]).toEqual([provider, raw, null]);
  });
});

describe('the pinned host keys', () => {
  const published: Record<string, string[]> = {
    'gitlab.com': [
      'SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8',
      'SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw',
      'SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ',
    ],
    'bitbucket.org': [
      'SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM',
      'SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0',
      'SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E',
    ],
  };

  it('are exactly the forges\' published keys, for exactly the two fixed hosts', () => {
    expect(FORGE_KNOWN_HOSTS).toHaveLength(6);
    const byHost: Record<string, string[]> = {};
    for (const line of FORGE_KNOWN_HOSTS) {
      const [host, , blob] = line.split(' ');
      (byHost[host] ??= []).push(sshFingerprint(Buffer.from(blob, 'base64')));
    }
    expect(Object.keys(byHost).sort()).toEqual(Object.values(FORGE_SSH_HOSTS).sort());
    for (const host of Object.keys(published)) expect(byHost[host].sort()).toEqual(published[host].sort());
    expect(forgeKnownHostsFile()).toBe(`${FORGE_KNOWN_HOSTS.join('\n')}\n`);
  });

  it('RED: one changed byte in a pinned key changes its fingerprint (the comparison above can fail)', () => {
    const [host, , blob] = FORGE_KNOWN_HOSTS[1].split(' ');
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(published[host]).not.toContain(sshFingerprint(bytes));
  });
});

const files = { keyFile: '/tmp/provian-dk-abc/id_ed25519', knownHostsFile: '/tmp/provian-dk-abc/known_hosts', homeDir: '/tmp/provian-dk-abc' };
const EXPECTED_SSH_OPTIONS = [
  'BatchMode=yes', 'CheckHostIP=no', `ConnectTimeout=${PROBE_TIMEOUT_MS / 1000}`, 'ForwardAgent=no',
  'GlobalKnownHostsFile=/dev/null', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'KbdInteractiveAuthentication=no',
  'LogLevel=ERROR', 'PasswordAuthentication=no', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
  `UserKnownHostsFile=${files.knownHostsFile}`,
].sort();
const pairs = (words: readonly string[], flag: string) => words.flatMap((word, i) => (word === flag ? [words[i + 1]] : []));

describe('probeSshOptions', () => {
  it('no config file, only this key, no tty, no agent, strict checking against the pinned file only, batch mode', () => {
    const opts = probeSshOptions(files.keyFile, files.knownHostsFile);
    expect(pairs(opts, '-F')).toEqual(['/dev/null']);
    expect(pairs(opts, '-i')).toEqual([files.keyFile]);
    expect(opts).toContain('-T');
    expect(pairs(opts, '-o').sort()).toEqual(EXPECTED_SSH_OPTIONS);
  });
});

describe('GitLab write probe: buildReceivePackProbeInvocation', () => {
  it('runs ssh itself (no git, no shell) to gitlab.com with one remote command: git-receive-pack for the path', () => {
    const inv = buildReceivePackProbeInvocation({ repoPath: 'group/sub/project', ...files });
    expect(inv.file).toBe('ssh');
    expect(inv.args).toEqual([...probeSshOptions(files.keyFile, files.knownHostsFile), 'git@gitlab.com', "git-receive-pack 'group/sub/project.git'"]);
    expect(inv.env).toEqual({ PATH: PROBE_PATH, HOME: files.homeDir, LANG: 'C' });
  });

  it('stdin carries exactly one flush-pkt — never a ref update — for every path', () => {
    expect(RECEIVE_PACK_PROBE_INPUT).toBe('0000');
    for (const repoPath of ['group/project', 'a/b/c/d', 'x_1/y.z-2']) {
      const inv = buildReceivePackProbeInvocation({ repoPath, ...files });
      expect(inv.input).toBe('0000');
      // The argument vector names the service and the path, and nothing an ssh or git side could read as a refspec.
      expect(inv.args.slice(-2)).toEqual(['git@gitlab.com', `git-receive-pack '${repoPath}.git'`]);
      expect(inv.args.join(' ')).not.toMatch(/refs\/|:refs|\+|--force|--delete|--mirror|push/);
    }
  });

  it('RED: refuses an unnormalized path (no quote can reach the remote command) and unsafe local paths', () => {
    for (const repoPath of ["a/b'; rm -rf /'", 'Group/Project', '-x/y', 'a/../b', 'a b/c']) {
      expect(() => buildReceivePackProbeInvocation({ repoPath, ...files })).toThrow(/not normalized/);
    }
    expect(() => buildReceivePackProbeInvocation({ repoPath: 'a/b', ...files, keyFile: '/tmp/a b/k' })).toThrow(/unsafe local path/);
  });
});

describe('Bitbucket read probe: buildLsRemoteInvocation', () => {
  it('runs git (no shell) with the path as its own argument after --, only HEAD, closed environment', () => {
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    try {
      const inv = buildLsRemoteInvocation({ provider: 'bitbucket', repoPath: 'workspace/repo', ...files });
      expect(inv.file).toBe('git');
      expect(inv.args).toEqual(['ls-remote', '--', 'git@bitbucket.org:workspace/repo.git', 'HEAD']);
      expect(inv.input).toBe('');
      expect(Object.keys(inv.env).sort()).toEqual([
        'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT',
        'HOME', 'LANG', 'PATH', 'SSH_ASKPASS',
      ]);
      expect(inv.env).toMatchObject({ PATH: PROBE_PATH, HOME: files.homeDir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' });
      expect(JSON.stringify(inv.env)).not.toContain('agent.sock');
      const ssh = inv.env.GIT_SSH_COMMAND.split(' ');
      expect(ssh[0]).toBe('ssh');
      expect(pairs(ssh, '-o').sort()).toEqual(EXPECTED_SSH_OPTIONS);
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = before;
    }
  });

  it('RED: refuses an unnormalized path, an unknown forge, and local paths that could break the ssh command', () => {
    for (const repoPath of ['Workspace/Repo', '-x/y', 'a/../b', 'a b/c', 'a;b/c']) {
      expect(() => buildLsRemoteInvocation({ provider: 'bitbucket', repoPath, ...files })).toThrow(/not normalized/);
    }
    expect(() => buildLsRemoteInvocation({ provider: 'github' as DeployKeyProvider, repoPath: 'a/b', ...files })).toThrow(/unknown forge/);
    for (const keyFile of ['/tmp/a b/k', '/tmp/a;rm/k', 'relative/k', '/tmp/$(id)/k']) {
      expect(() => buildLsRemoteInvocation({ provider: 'bitbucket', repoPath: 'a/b', ...files, keyFile })).toThrow(/unsafe local path/);
    }
  });
});

describe('readReceivePackAdvertisement / classifyReceivePack', () => {
  it('a complete advertisement with a clean exit is granted — including an empty repository\'s', () => {
    expect(classifyReceivePack(null, advertisement([[OID, 'refs/heads/main'], [OID, 'refs/tags/v1']]), '')).toEqual({ kind: 'granted' });
    expect(classifyReceivePack(null, advertisement([[ZERO, 'capabilities^{}']]), '')).toEqual({ kind: 'granted' });
    expect(classifyReceivePack(null, pkt('version 1\n') + advertisement([[OID, 'refs/heads/main']]), '')).toEqual({ kind: 'granted' });
  });

  it('RED: a clean exit without a well-formed advertisement proves nothing', () => {
    for (const stdout of [
      '', '0000', 'Welcome to GitLab, @someone!\n', pkt('not an oid refs/heads/main\0caps\n') + '0000',
      pkt(`${OID} refs/heads/main\n`) + '0000', // first line without capabilities
      pkt(`${OID} refs/heads/main\0caps\n`), // no closing flush
      pkt(`${OID} main\0caps\n`) + '0000', 'zzzz',
    ]) {
      expect([stdout, classifyReceivePack(null, stdout, '')]).toEqual([stdout, { kind: 'unavailable', reason: 'malformed_advertisement' }]);
    }
  });

  it('GitLab\'s and ssh\'s refusals are denied', () => {
    expect(classifyReceivePack(err({ code: 1 }), '', 'remote: ERROR: This deploy key does not have write access to this project.')).toEqual({ kind: 'denied' });
    expect(classifyReceivePack(err({ code: 1 }), '', 'remote: ERROR: You are not allowed to push code to this project.')).toEqual({ kind: 'denied' });
    expect(classifyReceivePack(err({ code: 1 }), '', 'remote: ERROR: The project you were looking for could not be found or you don\'t have permission to view it.')).toEqual({ kind: 'denied' });
    expect(classifyReceivePack(err({ code: 255 }), '', 'git@gitlab.com: Permission denied (publickey).')).toEqual({ kind: 'denied' });
  });

  it('a project with more refs than the cap: granted on a well-formed first ref line, else unavailable', () => {
    const big = advertisement(Array.from({ length: 3000 }, (_, i) => [OID, `refs/heads/b${i}`] as [string, string]));
    const prefix = big.slice(0, PROBE_MAX_OUTPUT_BYTES);
    expect(big.length).toBeGreaterThan(PROBE_MAX_OUTPUT_BYTES);
    expect(classifyReceivePack(err({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), prefix, '')).toEqual({ kind: 'granted' });
    expect(classifyReceivePack(err({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'x'.repeat(PROBE_MAX_OUTPUT_BYTES), ''))
      .toEqual({ kind: 'unavailable', reason: 'output_too_large' });
    expect(classifyReceivePack(err({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), big.slice(0, 20), ''))
      .toEqual({ kind: 'unavailable', reason: 'output_too_large' });
    expect(readReceivePackAdvertisement(prefix)).toEqual({ firstRef: true, complete: false });
  });

  it('timeouts, spawn failures, host-key mismatches and network errors are unavailable', () => {
    expect(classifyReceivePack(err({ killed: true, signal: 'SIGKILL' }), '', '')).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(classifyReceivePack(err({ code: 'ENOENT' }), '', '')).toEqual({ kind: 'unavailable', reason: 'spawn_failed' });
    expect(classifyReceivePack(err({ code: 255 }), '', 'Host key verification failed.')).toEqual({ kind: 'unavailable', reason: 'host_key_mismatch' });
    expect(classifyReceivePack(err({ code: 255 }), '', 'ssh: Could not resolve hostname gitlab.com')).toEqual({ kind: 'unavailable', reason: 'network' });
  });
});

describe('classifyLsRemote (Bitbucket)', () => {
  it('maps each way a run ends', () => {
    expect(classifyLsRemote(null, '')).toEqual({ kind: 'granted' });
    expect(classifyLsRemote(err({ code: 128 }), 'git@bitbucket.org: Permission denied (publickey).')).toEqual({ kind: 'denied' });
    expect(classifyLsRemote(err({ killed: true, signal: 'SIGKILL' }), '')).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(classifyLsRemote(err({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '')).toEqual({ kind: 'unavailable', reason: 'output_too_large' });
    expect(classifyLsRemote(err({ code: 'ENOENT' }), '')).toEqual({ kind: 'unavailable', reason: 'spawn_failed' });
    expect(classifyLsRemote(err({ code: 128 }), 'Host key verification failed.')).toEqual({ kind: 'unavailable', reason: 'host_key_mismatch' });
  });
});

/**
 * GitLab's SSH side, at the process level: what GitLab answers for each service
 * and key. Any known key may READ (upload-pack) a public project; only a
 * deploy key with write access, or an account key with push rights, may open
 * receive-pack — the rule a read proof cannot see.
 */
function fakeGitLabSsh(keys: Record<string, { kind: 'deploy_read' | 'deploy_write' | 'account_push' | 'account_read' }>) {
  const seen: Array<{ file: string; args: readonly string[]; input: string }> = [];
  const exec: ExecFileFn = (file, args, opts, callback) => {
    seen.push({ file, args, input: opts.input });
    const keyFile = args[args.indexOf('-i') + 1];
    const key = keys[fingerprintOfPrivateKey(readFileSync(keyFile, 'utf8'))];
    const command = args[args.length - 1];
    if (!key) {
      callback(err({ code: 255 }), '', 'git@gitlab.com: Permission denied (publickey).\n');
      return;
    }
    const service = command.split(' ')[0];
    const mayPush = key.kind === 'deploy_write' || key.kind === 'account_push';
    if (service === 'git-upload-pack' || (service === 'git-receive-pack' && mayPush)) {
      callback(null, advertisement([[OID, 'refs/heads/main']]), '');
      return;
    }
    const message = key.kind.startsWith('deploy')
      ? 'remote: ERROR: This deploy key does not have write access to this project.\n'
      : 'remote: ERROR: You are not allowed to push code to this project.\n';
    callback(err({ code: 1 }), '', message);
  };
  return { exec, seen };
}

describe('runForgeProbe', () => {
  it('GitLab: a READ-ONLY deploy key is denied (it could read; it may not push)', async () => {
    const key = generateDeployKey();
    const gl = fakeGitLabSsh({ [key.fingerprint]: { kind: 'deploy_read' } });
    expect(await runForgeProbe({ provider: 'gitlab', repoPath: 'group/project', privateKeyOpenSsh: key.privateKeyOpenSsh }, gl.exec))
      .toEqual({ kind: 'denied' });
  });

  it('GitLab: a deploy key with write access is granted; an account key with push rights too; read-only accounts and unknown keys are denied', async () => {
    const write = generateDeployKey();
    const account = generateDeployKey();
    const reader = generateDeployKey();
    const stranger = generateDeployKey();
    const gl = fakeGitLabSsh({
      [write.fingerprint]: { kind: 'deploy_write' },
      [account.fingerprint]: { kind: 'account_push' },
      [reader.fingerprint]: { kind: 'account_read' },
    });
    const probe = (k: { privateKeyOpenSsh: string }) =>
      runForgeProbe({ provider: 'gitlab', repoPath: 'group/project', privateKeyOpenSsh: k.privateKeyOpenSsh }, gl.exec);
    expect(await probe(write)).toEqual({ kind: 'granted' });
    expect(await probe(account)).toEqual({ kind: 'granted' });
    expect(await probe(reader)).toEqual({ kind: 'denied' });
    expect(await probe(stranger)).toEqual({ kind: 'denied' });
    // Every GitLab probe was ssh → receive-pack, and wrote only the flush-pkt.
    expect(gl.seen.map((s) => [s.file, s.args[s.args.length - 1], s.input]))
      .toEqual(Array(4).fill(['ssh', "git-receive-pack 'group/project.git'", '0000']));
  });

  it('RED: GitLab: a clean exit that is not a receive-pack advertisement proves nothing (the GitLab run is read as a write probe)', async () => {
    const exec: ExecFileFn = (_file, _args, _opts, callback) => { callback(null, 'Welcome to GitLab, @someone!\n', ''); };
    expect(await runForgeProbe({ provider: 'gitlab', repoPath: 'group/project', privateKeyOpenSsh: generateDeployKey().privateKeyOpenSsh }, exec))
      .toEqual({ kind: 'unavailable', reason: 'malformed_advertisement' });
  });

  it('hands the process a 0600 key file and the pinned known_hosts, the timeout, the cap, no shell — and removes them afterwards', async () => {
    const key = generateDeployKey();
    const seen: Array<{ dir: string; key: string; keyMode: number; knownHosts: string; khMode: number; dirMode: number; opts: Parameters<ExecFileFn>[2] }> = [];
    const exec: ExecFileFn = (_file, args, opts, callback) => {
      const keyFile = args[args.indexOf('-i') + 1];
      const knownHostsFile = String(pairs(args, '-o').find((o) => o.startsWith('UserKnownHostsFile='))).slice('UserKnownHostsFile='.length);
      seen.push({
        dir: dirname(keyFile), key: readFileSync(keyFile, 'utf8'), keyMode: statSync(keyFile).mode & 0o777,
        knownHosts: readFileSync(knownHostsFile, 'utf8'), khMode: statSync(knownHostsFile).mode & 0o777,
        dirMode: statSync(dirname(keyFile)).mode & 0o777, opts,
      });
      callback(null, advertisement([[OID, 'refs/heads/main']]), '');
    };
    expect(await runForgeProbe({ provider: 'gitlab', repoPath: 'group/project', privateKeyOpenSsh: key.privateKeyOpenSsh }, exec)).toEqual({ kind: 'granted' });
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.key).toBe(key.privateKeyOpenSsh);
    expect([s.keyMode, s.khMode, s.dirMode]).toEqual([0o600, 0o600, 0o700]);
    expect(s.knownHosts).toBe(forgeKnownHostsFile());
    expect(s.opts).toMatchObject({ timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_OUTPUT_BYTES, killSignal: 'SIGKILL', shell: false, windowsHide: true, input: '0000' });
    expect(existsSync(s.dir)).toBe(false);
  });

  it('Bitbucket probes with git ls-remote and an empty stdin', async () => {
    const calls: Array<[string, readonly string[], string]> = [];
    const exec: ExecFileFn = (file, args, opts, callback) => { calls.push([file, args, opts.input]); callback(null, '', ''); };
    expect(await runForgeProbe({ provider: 'bitbucket', repoPath: 'workspace/repo', privateKeyOpenSsh: generateDeployKey().privateKeyOpenSsh }, exec))
      .toEqual({ kind: 'granted' });
    expect(calls).toEqual([['git', ['ls-remote', '--', 'git@bitbucket.org:workspace/repo.git', 'HEAD'], '']]);
  });

  it('RED: a run that hits the timeout is unavailable — and the key file is still removed', async () => {
    let dir = '';
    const exec: ExecFileFn = (_file, args, _opts, callback) => {
      dir = dirname(args[args.indexOf('-i') + 1]);
      callback(err({ killed: true, signal: 'SIGKILL' }), '', '');
    };
    expect(await runForgeProbe({ provider: 'gitlab', repoPath: 'group/project', privateKeyOpenSsh: generateDeployKey().privateKeyOpenSsh }, exec))
      .toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
  });

  it('RED: an unnormalized path never reaches a process', async () => {
    const exec = jest.fn<ExecFileFn>();
    for (const provider of ['gitlab', 'bitbucket'] as const) {
      expect(await runForgeProbe({ provider, repoPath: "a/b'x", privateKeyOpenSsh: generateDeployKey().privateKeyOpenSsh }, exec))
        .toEqual({ kind: 'unavailable', reason: 'spawn_failed' });
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('the GitLab probe\'s input against a real git receive-pack (local, no network)', () => {
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  let root = '';
  let repo = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'provian-rp-'));
    repo = join(root, 'r.git');
    const work = join(root, 'w');
    execFileSync('git', ['init', '-q', '--bare', repo], { env: gitEnv });
    execFileSync('git', ['init', '-q', work], { env: gitEnv });
    execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: gitEnv });
    execFileSync('git', ['-C', work, 'push', '-q', repo, 'HEAD:refs/heads/main'], { env: gitEnv });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const refs = () => execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(objectname) %(refname)'], { env: gitEnv }).toString();
  const receivePack = (input: string) => new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile('git', ['receive-pack', repo], { env: gitEnv, encoding: 'buffer', timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) =>
      resolve({ error, stdout: Buffer.from(stdout).toString('latin1'), stderr: Buffer.from(stderr).toString('latin1') }));
    child.stdin?.end(input);
  });

  it('advertises, exits cleanly, reads as granted, and leaves every ref exactly as it was', async () => {
    const before = refs();
    expect(before).toContain('refs/heads/main');
    const run = await receivePack(RECEIVE_PACK_PROBE_INPUT);
    expect(classifyReceivePack(run.error, run.stdout, run.stderr)).toEqual({ kind: 'granted' });
    expect(refs()).toBe(before);
  });

  it('RED control: an input carrying a ref update DOES change the repository (so the check above can fail)', async () => {
    const before = refs();
    const oid = before.split(' ')[0];
    await receivePack(pkt(`${oid} ${ZERO} refs/heads/main\0report-status\n`) + '0000');
    expect(refs()).not.toBe(before);
  });
});

/** A forge stand-in at the probe level: GitLab answers the write probe, Bitbucket the read probe. */
function fakeForge() {
  const keys = new Map<string, Map<string, 'read' | 'write'>>(); // `${provider}:${path}` -> fingerprint -> access
  const accountKeys = new Map<string, Set<string>>(); // fingerprint -> paths its account may push to
  const publicProjects = new Set<string>(BITBUCKET_CANARIES.map((x) => `bitbucket:${x}`));
  const calls: ProbeRequest[] = [];
  let unavailableFor: string | null = null;
  const runner: ProbeRunner = async (request) => {
    calls.push(request);
    const where = `${request.provider}:${request.repoPath}`;
    if (unavailableFor === where) return { kind: 'unavailable', reason: 'network' };
    const fp = fingerprintOfPrivateKey(request.privateKeyOpenSsh);
    const access = keys.get(where)?.get(fp);
    if (request.provider === 'gitlab') {
      return access === 'write' || accountKeys.get(fp)?.has(request.repoPath) ? { kind: 'granted' } : { kind: 'denied' };
    }
    if (access !== undefined) return { kind: 'granted' };
    if (accountKeys.has(fp) && publicProjects.has(where)) return { kind: 'granted' };
    return { kind: 'denied' };
  };
  return {
    runner,
    calls,
    addKey(provider: DeployKeyProvider, path: string, fingerprint: string, access: 'read' | 'write' = provider === 'gitlab' ? 'write' : 'read') {
      const k = `${provider}:${path}`;
      if (!keys.has(k)) keys.set(k, new Map());
      keys.get(k)!.set(fingerprint, access);
    },
    addAccountKey(fingerprint: string, pushPaths: string[] = []) { accountKeys.set(fingerprint, new Set(pushPaths)); },
    makePublic(provider: DeployKeyProvider, path: string) { publicProjects.add(`${provider}:${path}`); },
    failFor(provider: DeployKeyProvider, path: string) { unavailableFor = `${provider}:${path}`; },
  };
}

describe('proveDeployKeyControl', () => {
  const key = generateDeployKey();
  const prove = (provider: DeployKeyProvider, projectPath: string, runner: ProbeRunner) =>
    proveDeployKeyControl({ provider, projectPath, privateKeyOpenSsh: key.privateKeyOpenSsh, runner });

  it('GitLab: a write deploy key on the project proves control with one probe — no canary', async () => {
    const forge = fakeForge();
    forge.addKey('gitlab', 'group/project', key.fingerprint, 'write');
    expect(await prove('gitlab', 'group/project', forge.runner)).toEqual({ ok: true });
    expect(forge.calls.map((c) => c.repoPath)).toEqual(['group/project']);
  });

  it('RED: GitLab: a READ-ONLY deploy key proves nothing', async () => {
    const forge = fakeForge();
    forge.addKey('gitlab', 'group/project', key.fingerprint, 'read');
    expect(await prove('gitlab', 'group/project', forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
  });

  it('GitLab: an account key with push rights on the project is accepted as control; one without is not', async () => {
    const forge = fakeForge();
    forge.addAccountKey(key.fingerprint, ['group/project']);
    expect(await prove('gitlab', 'group/project', forge.runner)).toEqual({ ok: true });
    expect(await prove('gitlab', 'someone-else/public-project', forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
  });

  it('Bitbucket: an access key on exactly that repository, unable to read the canaries, proves control', async () => {
    const forge = fakeForge();
    forge.addKey('bitbucket', 'workspace/repo', key.fingerprint);
    expect(await prove('bitbucket', 'workspace/repo', forge.runner)).toEqual({ ok: true });
    expect(forge.calls.map((c) => c.repoPath)).toEqual(['workspace/repo', ...BITBUCKET_CANARIES]);
  });

  it('RED: Bitbucket: a key on the registrant\'s own account reads a public repository it does not control — refused by the canary', async () => {
    const forge = fakeForge();
    forge.makePublic('bitbucket', 'someone/repo');
    forge.addAccountKey(key.fingerprint);
    expect(await prove('bitbucket', 'someone/repo', forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_project_specific' });
  });

  it('RED: a key on a different project is not found', async () => {
    const forge = fakeForge();
    forge.addKey('bitbucket', 'workspace/other', key.fingerprint);
    expect(await prove('bitbucket', 'workspace/repo', forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
  });

  it('RED: a forge that cannot be asked — for the project or a canary — proves nothing', async () => {
    const forge = fakeForge();
    forge.addKey('bitbucket', 'workspace/repo', key.fingerprint);
    forge.failFor('bitbucket', BITBUCKET_CANARIES[1]);
    expect(await prove('bitbucket', 'workspace/repo', forge.runner)).toEqual({ ok: false, reason: 'forge_unavailable' });
    const down = fakeForge();
    down.failFor('gitlab', 'group/project');
    expect(await prove('gitlab', 'group/project', down.runner)).toEqual({ ok: false, reason: 'forge_unavailable' });
  });

  it('a Bitbucket canary itself cannot be proven', async () => {
    const forge = fakeForge();
    expect(await prove('bitbucket', BITBUCKET_CANARIES[0], forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_project_specific' });
    expect(forge.calls).toHaveLength(0);
  });
});

describe('attempts', () => {
  const WALLET = 'wallet_1';
  const PROJECT_ID = '4242';
  const PATH = 'group/project';
  let db: FakeFirestore;
  let clock: number;
  const now = () => clock;
  beforeEach(() => { db = createFakeFirestore(); clock = 1_000_000; });

  const attemptRows = () => [...db.store.entries()].filter(([k]) => k.startsWith(`${DEPLOY_KEY_ATTEMPTS_COLLECTION}/`)).map(([, v]) => v);
  const begin = (walletId = WALLET) => beginDeployKeyAttempt(db as never, { walletId, provider: 'gitlab', installationId: PROJECT_ID, now: clock });
  const verify = (runner: ProbeRunner, walletId = WALLET, projectPath = PATH) =>
    verifyDeployKeyAttempt(db as never, { walletId, provider: 'gitlab', installationId: PROJECT_ID, projectPath, runner, now });

  it('the attempt window is the forge connect window', () => {
    expect(DEPLOY_KEY_ATTEMPT_TTL_MS).toBe(CONNECT_TTL_MS);
  });

  it('begin stores the private key server-side only and returns the public key; success deletes it and returns the proof', async () => {
    const attempt = await begin();
    expect(attempt.expiresAt).toBe(clock + DEPLOY_KEY_ATTEMPT_TTL_MS);
    expect(attemptRows()).toHaveLength(1);
    const row = attemptRows()[0] as Record<string, unknown>;
    expect(row.public_key).toBe(attempt.publicKey);
    expect(fingerprintOfPrivateKey(String(row.private_key))).toBe(attempt.keyFingerprint);
    expect(JSON.stringify(attempt)).not.toContain('PRIVATE KEY');

    const forge = fakeForge();
    forge.addKey('gitlab', PATH, attempt.keyFingerprint);
    clock += 60_000;
    expect(await verify(forge.runner)).toEqual({
      ok: true,
      proof: { method: 'deploy_key', key_fingerprint: attempt.keyFingerprint, verified_at: clock, project_path: PATH },
    });
    expect(attemptRows()).toHaveLength(0);
    expect(await verify(forge.runner)).toEqual({ ok: false, reason: 'attempt_not_found' });
  });

  it('RED: an expired attempt is refused and deleted, and the forge is never asked', async () => {
    const attempt = await begin();
    const forge = fakeForge();
    forge.addKey('gitlab', PATH, attempt.keyFingerprint);
    clock += DEPLOY_KEY_ATTEMPT_TTL_MS + 1;
    expect(await verify(forge.runner)).toEqual({ ok: false, reason: 'attempt_expired' });
    expect(attemptRows()).toHaveLength(0);
    expect(forge.calls).toHaveLength(0);
  });

  it('at the expiry instant the attempt still verifies', async () => {
    const attempt = await begin();
    const forge = fakeForge();
    forge.addKey('gitlab', PATH, attempt.keyFingerprint);
    clock += DEPLOY_KEY_ATTEMPT_TTL_MS;
    expect((await verify(forge.runner)).ok).toBe(true);
  });

  it('RED: another wallet cannot use this wallet\'s attempt', async () => {
    const attempt = await begin();
    const forge = fakeForge();
    forge.addKey('gitlab', PATH, attempt.keyFingerprint);
    expect(await verify(forge.runner, 'wallet_intruder')).toEqual({ ok: false, reason: 'attempt_not_found' });
    expect(attemptRows()).toHaveLength(1);
  });

  it('a key not yet usable on the project (absent, or read-only on GitLab) leaves the attempt for a retry', async () => {
    const attempt = await begin();
    const forge = fakeForge();
    expect(await verify(forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
    forge.addKey('gitlab', PATH, attempt.keyFingerprint, 'read');
    expect(await verify(forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
    expect(attemptRows()).toHaveLength(1);
    forge.addKey('gitlab', PATH, attempt.keyFingerprint, 'write');
    expect((await verify(forge.runner)).ok).toBe(true);
  });

  it('RED: begin again replaces the key — the earlier public key can no longer verify', async () => {
    const first = await begin();
    const second = await begin();
    expect(second.keyFingerprint).not.toBe(first.keyFingerprint);
    expect(attemptRows()).toHaveLength(1);
    const forge = fakeForge();
    forge.addKey('gitlab', PATH, first.keyFingerprint);
    expect(await verify(forge.runner)).toEqual({ ok: false, reason: 'deploy_key_not_found' });
    forge.addKey('gitlab', PATH, second.keyFingerprint);
    expect((await verify(forge.runner)).ok).toBe(true);
  });

  it('RED: an attempt replaced while its proof ran is not consumed by the stale proof', async () => {
    const attempt = await begin();
    const forge = fakeForge();
    forge.addKey('gitlab', PATH, attempt.keyFingerprint);
    let replaced = false;
    const racing: ProbeRunner = async (request) => {
      if (!replaced) { replaced = true; await begin(); }
      return forge.runner(request);
    };
    expect(await verify(racing)).toEqual({ ok: false, reason: 'attempt_consumed' });
    expect(attemptRows()).toHaveLength(1);
  });

  it('maps failures to statuses', () => {
    expect(httpStatusForVerifyFailure('attempt_not_found')).toBe(404);
    expect(httpStatusForVerifyFailure('attempt_expired')).toBe(410);
    expect(httpStatusForVerifyFailure('attempt_consumed')).toBe(409);
    expect(httpStatusForVerifyFailure('forge_unavailable')).toBe(503);
    expect(httpStatusForVerifyFailure('deploy_key_not_found')).toBe(403);
    expect(httpStatusForVerifyFailure('deploy_key_not_project_specific')).toBe(403);
  });

  it('instructions: GitLab needs write permission (Maintainer), writes nothing, and both say the key is deleted and should be removed', () => {
    const gl = deployKeyInstructions('gitlab');
    expect(gl).toContain('Settings > Repository > Deploy keys');
    expect(gl).toContain('tick "Grant write permissions to this key"');
    expect(gl).toContain('Maintainer');
    expect(gl).toContain('nothing in the repository is written');
    expect(gl).toContain('Developer or above');
    expect(gl).toContain('the relay deletes its private key; remove the key from the project');
    const bb = deployKeyInstructions('bitbucket');
    expect(bb).toContain('Repository settings > Access keys');
    expect(bb).toContain('repository admin');
    expect(bb).toContain('read-only');
    expect(bb).toContain('the relay deletes its private key; remove the key from the project');
    expect(bb).toContain(`${Math.round(DEPLOY_KEY_ATTEMPT_TTL_MS / 60_000)} minutes`);
  });
});

const _outcomes: ProbeOutcome[] = [{ kind: 'granted' }, { kind: 'denied' }, { kind: 'unavailable', reason: 'timeout' }];
void _outcomes;
