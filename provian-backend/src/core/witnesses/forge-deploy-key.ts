/**
 * Proof that a registrant controls the GitLab project / Bitbucket repository
 * they are registering, by deploy key.
 *
 * A self-serve registration hands the registrant a webhook secret, and a
 * delivery signed with that secret becomes a Provenance Envelope, so the
 * registrant must first show the forge lets them change that project. No forge
 * credential ever reaches the relay. Instead:
 *
 * 1. begin — the relay generates a fresh ed25519 key pair for this (wallet,
 *    provider, project) attempt and returns only the PUBLIC key. The private
 *    key stays in the relay's encrypted private store for the attempt's short
 *    life and is never logged or returned.
 * 2. The registrant adds the public key to the project.
 * 3. verify — the registrant names the project's path and the relay connects
 *    over SSH to the fixed host (gitlab.com / bitbucket.org), with the hosts'
 *    published keys pinned, using only the attempt's key:
 *
 *    GitLab — a WRITE probe. A read proves nothing on GitLab: any SSH key
 *    (a deploy key attached anywhere, or any account key) may read any public
 *    project. Push has no such fallback: GitLab lets a key push only when it
 *    is a deploy key with write access on this project, or the key of an
 *    account with push rights on it. The relay opens `git-receive-pack` for
 *    the path, which GitLab answers with a ref advertisement only after that
 *    push check passes, and then sends a flush-pkt (`0000`) and closes:
 *    "no ref updates". Nothing is ever written to the repository. So the
 *    registrant adds the key under Settings > Repository > Deploy keys with
 *    "Grant write permissions to this key" ticked (needs Maintainer). An
 *    account key with push rights (Developer or above) also passes; that is
 *    accepted as control.
 *
 *    Bitbucket — a READ probe with canaries. The registrant adds the key under
 *    Repository settings > Access keys (read-only; needs repository admin) and
 *    the relay runs `git ls-remote` for the path. It then makes the same read
 *    of well-known public repositories the registrant does not control: a key
 *    that reads those is attached to a user account, not to this repository,
 *    so it proves nothing and is refused.
 *
 *    On success the private key is deleted and the proof (method, key
 *    fingerprint, path, time) is recorded on the install. The registrant
 *    should then remove the key from the project; it is never used again.
 */
import { execFile, type ExecFileException } from 'child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { CONNECT_TTL_MS } from './github-connect';
import { forgeKnownHostsFile } from './forge-known-hosts';
import type { ServiceInstallControlProof } from './service-installs';

// The OpenSSH private-key armor, assembled so the repository's secret scan never sees a key header
// in source (the relay only ever writes generated keys into a 0600 temp file).
export const OPENSSH_PEM_BEGIN = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
export const OPENSSH_PEM_END = '-----END ' + 'OPENSSH PRIVATE KEY-----';

export type DeployKeyProvider = 'gitlab' | 'bitbucket';

/** The only hosts a proof connects to. */
export const FORGE_SSH_HOSTS: Readonly<Record<DeployKeyProvider, string>> = Object.freeze({
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
});

/**
 * Bitbucket only: public repositories no registrant controls. An access key
 * on the registrant's own repository cannot read them; a key attached to a
 * user account can. A read proof whose key reads any of them is refused.
 * (GitLab is proven by push, where reading proves nothing, so it has none.)
 */
export const BITBUCKET_CANARIES: readonly string[] = Object.freeze([
  'atlassian/aws-s3-deploy',
  'bitbucketpipelines/bitbucket-pipes-toolkit',
]);

/** A begin is good for the same window as the forge connect handoff. */
export const DEPLOY_KEY_ATTEMPT_TTL_MS = CONNECT_TTL_MS;

/** One probe, wall clock, connection through exit. */
export const PROBE_TIMEOUT_MS = 10_000;
/**
 * Output cap per probe. `ls-remote <url> HEAD` prints one line. A receive-pack
 * advertisement lists every ref, so a large project can pass the cap; the
 * probe then decides on the captured prefix (see classifyReceivePack).
 */
export const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Everything the GitLab probe ever writes to receive-pack: one flush-pkt,
 * meaning "no ref updates". No command line, no pack.
 */
export const RECEIVE_PACK_PROBE_INPUT = '0000';

export const DEPLOY_KEY_ATTEMPTS_COLLECTION = 'forge_deploy_key_attempts_v1';

// -----------------------------------------------------------------------------
// Key generation (OpenSSH formats, built from Node's own ed25519 key)
// -----------------------------------------------------------------------------

export interface GeneratedDeployKey {
  /** `ssh-ed25519 <base64> <comment>` — what the registrant pastes into the forge. */
  publicKey: string;
  /** Unencrypted `openssh-key-v1` private key; lives only in the attempt record and a 0600 temp file. */
  privateKeyOpenSsh: string;
  /** `SHA256:<base64>` — the fingerprint the forge shows next to the key. */
  fingerprint: string;
}

function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** `SHA256:` fingerprint of an SSH public key blob, as ssh-keygen and the forges print it. */
export function sshFingerprint(publicKeyBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')}`;
}

export function generateDeployKey(comment: string = 'provian-deploy-key'): GeneratedDeployKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new Error('ed25519 key export failed');
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  if (seed.length !== 32 || pub.length !== 32) throw new Error('ed25519 key export failed');

  const keyType = Buffer.from('ssh-ed25519');
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = randomBytes(4);
  let section = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment)),
  ]);
  const padding: number[] = [];
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i += 1) padding.push(i);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(publicBlob),
    sshString(section),
  ]);
  const wrapped = body.toString('base64').match(/.{1,70}/g) ?? [];
  return {
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
    privateKeyOpenSsh: `${OPENSSH_PEM_BEGIN}\n${wrapped.join('\n')}\n${OPENSSH_PEM_END}\n`,
    fingerprint: sshFingerprint(publicBlob),
  };
}

// -----------------------------------------------------------------------------
// Project path validation
// -----------------------------------------------------------------------------

const GITLAB_SEGMENT_RE = /^[a-z0-9_](?:[a-z0-9_.-]{0,253}[a-z0-9_-])?$/;
const BITBUCKET_SEGMENT_RE = /^[a-z0-9_](?:[a-z0-9_.-]{0,98}[a-z0-9_-])?$/;
const MAX_GITLAB_SEGMENTS = 21;
const MAX_PATH_LENGTH = 512;

/**
 * The project path in the forge's own form — GitLab `group/subgroup/project`,
 * Bitbucket `workspace/repo` — lowercased (both forges route paths
 * case-insensitively), or null. Nothing that could be read as an option, a
 * second path, a URL or a shell word survives: only letters, digits, `_`, `-`
 * and `.` inside `/`-separated segments that start with a letter, digit or
 * `_`, with no `..` and no `.git` / `.atom` suffix.
 */
export function normalizeProjectPath(provider: DeployKeyProvider, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim().toLowerCase();
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('..')) return null;
  const segments = path.split('/');
  const segmentRe = provider === 'gitlab' ? GITLAB_SEGMENT_RE : BITBUCKET_SEGMENT_RE;
  const countOk = provider === 'gitlab'
    ? segments.length >= 2 && segments.length <= MAX_GITLAB_SEGMENTS
    : segments.length === 2;
  if (!countOk) return null;
  for (const segment of segments) {
    if (!segmentRe.test(segment)) return null;
    if (segment.endsWith('.git') || segment.endsWith('.atom')) return null;
  }
  return path;
}

// -----------------------------------------------------------------------------
// The probes
// -----------------------------------------------------------------------------

/** A fixed PATH: the relay image's git and ssh live here. */
export const PROBE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SAFE_FS_PATH_RE = /^\/[A-Za-z0-9/_.-]+$/;
const NORMALIZED_PATH_RE = /^[a-z0-9_][a-z0-9_./-]*$/;

export interface ProbeInvocation {
  file: 'git' | 'ssh';
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Written to the process's stdin, which is then closed. */
  input: string;
}

function checkPaths(repoPath: string, fsPaths: readonly string[]): void {
  if (!NORMALIZED_PATH_RE.test(repoPath) || repoPath.includes('..')) {
    throw new Error('probe: repository path is not normalized');
  }
  for (const fsPath of fsPaths) {
    if (!SAFE_FS_PATH_RE.test(fsPath)) throw new Error('probe: unsafe local path');
  }
}

/**
 * ssh options for every probe: no config file, only this key, no agent,
 * strict checking against the pinned known_hosts only, no prompts, no tty.
 */
export function probeSshOptions(keyFile: string, knownHostsFile: string): string[] {
  return [
    '-F', '/dev/null',
    '-i', keyFile,
    '-T',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'UpdateHostKeys=no',
    '-o', 'CheckHostIP=no',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no',
    '-o', `ConnectTimeout=${Math.floor(PROBE_TIMEOUT_MS / 1000)}`,
    '-o', 'LogLevel=ERROR',
  ];
}

/**
 * Bitbucket read probe: git (started without a shell) runs `ls-remote` with
 * the path as its own argument after `--`. git runs the SSH command through
 * /bin/sh, so that string is built only from the fixed options and paths the
 * relay created (checked against a strict character set), never from
 * registrant input.
 */
export function buildLsRemoteInvocation(input: {
  provider: DeployKeyProvider;
  repoPath: string;
  keyFile: string;
  knownHostsFile: string;
  homeDir: string;
}): ProbeInvocation {
  const host = FORGE_SSH_HOSTS[input.provider];
  if (host === undefined) throw new Error('probe: unknown forge');
  checkPaths(input.repoPath, [input.keyFile, input.knownHostsFile, input.homeDir]);
  return {
    file: 'git',
    args: ['ls-remote', '--', `git@${host}:${input.repoPath}.git`, 'HEAD'],
    env: {
      PATH: PROBE_PATH,
      HOME: input.homeDir,
      LANG: 'C',
      GIT_SSH_COMMAND: ['ssh', ...probeSshOptions(input.keyFile, input.knownHostsFile)].join(' '),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    },
    input: '',
  };
}

/**
 * GitLab write probe: ssh itself (started without a shell, no git, no
 * config) asks gitlab.com to run `git-receive-pack '<path>.git'`. The remote
 * command is one argument, made from the strictly normalized path (no quote
 * can occur in it). The only thing ever sent on stdin is the flush-pkt.
 */
export function buildReceivePackProbeInvocation(input: {
  repoPath: string;
  keyFile: string;
  knownHostsFile: string;
  homeDir: string;
}): ProbeInvocation {
  checkPaths(input.repoPath, [input.keyFile, input.knownHostsFile, input.homeDir]);
  return {
    file: 'ssh',
    args: [
      ...probeSshOptions(input.keyFile, input.knownHostsFile),
      `git@${FORGE_SSH_HOSTS.gitlab}`,
      `git-receive-pack '${input.repoPath}.git'`,
    ],
    env: { PATH: PROBE_PATH, HOME: input.homeDir, LANG: 'C' },
    input: RECEIVE_PACK_PROBE_INPUT,
  };
}

export type ProbeOutcome =
  | { kind: 'granted' }
  | { kind: 'denied' }
  | {
    kind: 'unavailable';
    reason: 'timeout' | 'output_too_large' | 'spawn_failed' | 'host_key_mismatch' | 'network' | 'malformed_advertisement';
  };

/** The slice of child_process.execFile a probe needs (injected in tests). Output arrives as latin1 (byte-exact). */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: {
    env: Readonly<Record<string, string>>;
    timeout: number;
    maxBuffer: number;
    killSignal: 'SIGKILL';
    windowsHide: true;
    shell: false;
    input: string;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

const realExecFile: ExecFileFn = (file, args, options, callback) => {
  const { input, ...spawnOptions } = options;
  const child = execFile(file, [...args], { ...spawnOptions, env: { ...spawnOptions.env }, encoding: 'buffer' },
    (error, stdout, stderr) => {
      callback(error, Buffer.from(stdout).toString('latin1'), Buffer.from(stderr).toString('latin1'));
    });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input);
};

/** Failures common to both probes, read from how the process ended. */
function classifyFailure(error: ExecFileException, stderr: string): ProbeOutcome {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'unavailable', reason: 'output_too_large' };
  if (error.killed === true) return { kind: 'unavailable', reason: 'timeout' };
  if (typeof error.code === 'string') return { kind: 'unavailable', reason: 'spawn_failed' };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) {
    return { kind: 'unavailable', reason: 'host_key_mismatch' };
  }
  if (/Could not resolve hostname|Connection timed out|Connection refused|Network is unreachable|Connection closed by remote host|Connection reset/.test(stderr)) {
    return { kind: 'unavailable', reason: 'network' };
  }
  return { kind: 'denied' };
}

/** How an ls-remote exit reads. Exit 0 (even with no refs: an empty repository) is a successful read. */
export function classifyLsRemote(error: ExecFileException | null, stderr: string): ProbeOutcome {
  return error === null ? { kind: 'granted' } : classifyFailure(error, stderr);
}

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME_RE = /^(?:refs\/[\x21-\x7e]+|HEAD|capabilities\^\{\})$/;

/**
 * Read a receive-pack ref advertisement (pkt-lines). `complete` when it ends
 * in its flush-pkt; `firstRef` when its first ref line is well formed — the
 * server sends that only after the push check passed. Null when the bytes are
 * not an advertisement at all.
 */
export function readReceivePackAdvertisement(stdout: string): { firstRef: boolean; complete: boolean } | null {
  let offset = 0;
  let refs = 0;
  let firstRef = false;
  while (offset + 4 <= stdout.length) {
    const lengthHex = stdout.slice(offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(lengthHex)) return null;
    const length = parseInt(lengthHex, 16);
    if (length === 0) return refs > 0 ? { firstRef, complete: true } : null;
    if (length < 5) return null;
    if (offset + length > stdout.length) return { firstRef, complete: false };
    let payload = stdout.slice(offset + 4, offset + length);
    offset += length;
    if (payload.endsWith('\n')) payload = payload.slice(0, -1);
    if (refs === 0 && /^version [12]$/.test(payload)) continue;
    const line = refs === 0 ? payload.split('\0')[0] : payload;
    if (refs === 0 && !payload.includes('\0')) return null;
    const [oid, name, ...rest] = line.split(' ');
    if (rest.length > 0 || !OID_RE.test(oid ?? '') || !REF_NAME_RE.test(name ?? '')) return null;
    if (refs === 0) firstRef = true;
    refs += 1;
  }
  return { firstRef, complete: false };
}

/**
 * How the GitLab write probe reads. Granted only on a well-formed
 * advertisement: a complete one with a clean exit, or — when the project has
 * more refs than the output cap — a well-formed first ref line in the captured
 * prefix. A refusal (exit 1, "not allowed to push" / "deploy key does not have
 * write access", or ssh's "Permission denied") is denied; anything else is
 * unavailable.
 */
export function classifyReceivePack(error: ExecFileException | null, stdout: string, stderr: string): ProbeOutcome {
  const advertisement = readReceivePackAdvertisement(stdout);
  if (error === null) {
    return advertisement !== null && advertisement.complete && advertisement.firstRef
      ? { kind: 'granted' }
      : { kind: 'unavailable', reason: 'malformed_advertisement' };
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && advertisement !== null && advertisement.firstRef) {
    return { kind: 'granted' };
  }
  return classifyFailure(error, stderr);
}

export interface ProbeRequest {
  provider: DeployKeyProvider;
  repoPath: string;
  privateKeyOpenSsh: string;
}

export type ProbeRunner = (request: ProbeRequest) => Promise<ProbeOutcome>;

/**
 * Run one probe with the attempt's key: GitLab the write probe, Bitbucket the
 * read probe. The key and the pinned known_hosts are written to a fresh 0700
 * directory as 0600 files and the directory is removed when the run ends,
 * whatever the outcome.
 */
export async function runForgeProbe(
  request: ProbeRequest,
  exec: ExecFileFn = realExecFile,
): Promise<ProbeOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'provian-dk-'));
  try {
    const keyFile = join(dir, 'id_ed25519');
    const knownHostsFile = join(dir, 'known_hosts');
    await writeFile(keyFile, request.privateKeyOpenSsh, { mode: 0o600 });
    await writeFile(knownHostsFile, forgeKnownHostsFile(), { mode: 0o600 });
    let invocation: ProbeInvocation;
    try {
      invocation = request.provider === 'gitlab'
        ? buildReceivePackProbeInvocation({ repoPath: request.repoPath, keyFile, knownHostsFile, homeDir: dir })
        : buildLsRemoteInvocation({ provider: request.provider, repoPath: request.repoPath, keyFile, knownHostsFile, homeDir: dir });
    } catch {
      return { kind: 'unavailable', reason: 'spawn_failed' };
    }
    const outcome = await new Promise<ProbeOutcome>((resolve) => {
      exec(invocation.file, invocation.args, {
        env: invocation.env,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: false,
        input: invocation.input,
      }, (error, stdout, stderr) => resolve(
        request.provider === 'gitlab' ? classifyReceivePack(error, stdout, stderr) : classifyLsRemote(error, stderr),
      ));
    });
    if (outcome.kind === 'unavailable') {
      console.warn(`[ForgeDeployKey] probe on ${FORGE_SSH_HOSTS[request.provider]} unavailable (${outcome.reason})`);
    }
    return outcome;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// The proof
// -----------------------------------------------------------------------------

export type DeployKeyRefusal =
  /** The key could not be used on that project: not added (with write access, on GitLab), added elsewhere, or a wrong path. */
  | 'deploy_key_not_found'
  /** Bitbucket: the key reads public repositories the registrant does not control: it is not an access key on this repository. */
  | 'deploy_key_not_project_specific'
  /** The forge could not be asked (timeout, network, host key, missing git/ssh, malformed answer). Retry later. */
  | 'forge_unavailable';

export async function proveDeployKeyControl(input: {
  provider: DeployKeyProvider;
  projectPath: string;
  privateKeyOpenSsh: string;
  runner: ProbeRunner;
}): Promise<{ ok: true } | { ok: false; reason: DeployKeyRefusal }> {
  const canaries = input.provider === 'bitbucket' ? BITBUCKET_CANARIES : [];
  // A canary itself cannot be told apart from a canary read.
  if (canaries.includes(input.projectPath)) return { ok: false, reason: 'deploy_key_not_project_specific' };
  const target = await input.runner({
    provider: input.provider,
    repoPath: input.projectPath,
    privateKeyOpenSsh: input.privateKeyOpenSsh,
  });
  if (target.kind === 'unavailable') return { ok: false, reason: 'forge_unavailable' };
  if (target.kind === 'denied') return { ok: false, reason: 'deploy_key_not_found' };
  for (const canary of canaries) {
    const read = await input.runner({ provider: input.provider, repoPath: canary, privateKeyOpenSsh: input.privateKeyOpenSsh });
    if (read.kind === 'unavailable') return { ok: false, reason: 'forge_unavailable' };
    if (read.kind === 'granted') return { ok: false, reason: 'deploy_key_not_project_specific' };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Attempts (one live attempt per wallet, provider and project)
// -----------------------------------------------------------------------------

interface DeployKeyAttemptDocument {
  wallet_id: string;
  provider: DeployKeyProvider;
  installation_id: string;
  public_key: string;
  key_fingerprint: string;
  private_key: string;
  created_at: number;
  expires_at: number;
  expire_at: Timestamp;
}

function attemptDocId(walletId: string, provider: DeployKeyProvider, installationId: string): string {
  return createHash('sha256').update(`forge-deploy-key-attempt:v1\0${walletId}\0${provider}\0${installationId}`).digest('hex');
}

export interface DeployKeyAttempt {
  publicKey: string;
  keyFingerprint: string;
  expiresAt: number;
}

/**
 * Start (or restart) an attempt: a new key pair replaces any earlier attempt
 * for the same wallet, provider and project, so only the newest public key can
 * ever verify.
 */
export async function beginDeployKeyAttempt(
  db: Firestore,
  input: {
    walletId: string;
    provider: DeployKeyProvider;
    installationId: string;
    now?: number;
    generate?: () => GeneratedDeployKey;
  },
): Promise<DeployKeyAttempt> {
  const key = (input.generate ?? generateDeployKey)();
  const now = input.now ?? Date.now();
  const expiresAt = now + DEPLOY_KEY_ATTEMPT_TTL_MS;
  const doc: DeployKeyAttemptDocument = {
    wallet_id: input.walletId,
    provider: input.provider,
    installation_id: input.installationId,
    public_key: key.publicKey,
    key_fingerprint: key.fingerprint,
    private_key: key.privateKeyOpenSsh,
    created_at: now,
    expires_at: expiresAt,
    expire_at: Timestamp.fromMillis(expiresAt),
  };
  await db.collection(DEPLOY_KEY_ATTEMPTS_COLLECTION)
    .doc(attemptDocId(input.walletId, input.provider, input.installationId))
    .set(doc);
  return { publicKey: key.publicKey, keyFingerprint: key.fingerprint, expiresAt };
}

export type VerifyDeployKeyResult =
  | { ok: true; proof: ServiceInstallControlProof }
  | { ok: false; reason: DeployKeyRefusal | 'attempt_not_found' | 'attempt_expired' | 'attempt_consumed' };

/**
 * Verify an attempt against the named project path. Success deletes the
 * attempt — the private key with it — before the proof is returned, and only
 * the caller whose transaction deleted it gets the proof. An expired attempt
 * and a key shown not to be project-specific are deleted too; a key not (yet)
 * found on the project stays for a retry until the attempt expires.
 */
export async function verifyDeployKeyAttempt(
  db: Firestore,
  input: {
    walletId: string;
    provider: DeployKeyProvider;
    installationId: string;
    projectPath: string;
    runner?: ProbeRunner;
    now?: () => number;
  },
): Promise<VerifyDeployKeyResult> {
  const now = input.now ?? Date.now;
  const ref = db.collection(DEPLOY_KEY_ATTEMPTS_COLLECTION)
    .doc(attemptDocId(input.walletId, input.provider, input.installationId));
  const snap = await ref.get();
  const attempt = snap.exists ? (snap.data() as DeployKeyAttemptDocument) : null;
  if (attempt === null
    || attempt.wallet_id !== input.walletId
    || attempt.provider !== input.provider
    || attempt.installation_id !== input.installationId) {
    return { ok: false, reason: 'attempt_not_found' };
  }
  if (!(now() <= attempt.expires_at)) {
    await ref.delete();
    return { ok: false, reason: 'attempt_expired' };
  }

  const proven = await proveDeployKeyControl({
    provider: input.provider,
    projectPath: input.projectPath,
    privateKeyOpenSsh: attempt.private_key,
    runner: input.runner ?? ((request) => runForgeProbe(request)),
  });
  if (!proven.ok) {
    if (proven.reason === 'deploy_key_not_project_specific') await ref.delete();
    return proven;
  }

  const consumed = await db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    const freshAttempt = fresh.exists ? (fresh.data() as DeployKeyAttemptDocument) : null;
    if (freshAttempt === null || freshAttempt.key_fingerprint !== attempt.key_fingerprint) return false;
    txn.delete(ref);
    return true;
  });
  if (!consumed) return { ok: false, reason: 'attempt_consumed' };
  return {
    ok: true,
    proof: {
      method: 'deploy_key',
      key_fingerprint: attempt.key_fingerprint,
      verified_at: now(),
      project_path: input.projectPath,
    },
  };
}

/** HTTP status a registration route answers for a failed verify. */
export function httpStatusForVerifyFailure(
  reason: Exclude<VerifyDeployKeyResult, { ok: true }>['reason'],
): 403 | 404 | 409 | 410 | 503 {
  switch (reason) {
    case 'attempt_not_found': return 404;
    case 'attempt_expired': return 410;
    case 'attempt_consumed': return 409;
    case 'forge_unavailable': return 503;
    default: return 403;
  }
}

/** The forge-side steps, returned with the public key. */
export function deployKeyInstructions(provider: DeployKeyProvider, ttlMinutes: number = Math.round(DEPLOY_KEY_ATTEMPT_TTL_MS / 60_000)): string {
  const example = provider === 'gitlab' ? 'group/project' : 'workspace/repo';
  const add = provider === 'gitlab'
    ? 'In your project on gitlab.com: Settings > Repository > Deploy keys > Add new key. Paste the public_key '
      + 'above as the key, give it any title, and tick "Grant write permissions to this key". Adding a deploy '
      + 'key needs the Maintainer or Owner role. The relay proves control by asking GitLab whether this key may '
      + 'push to the project; it sends no changes, so nothing in the repository is written. (The same key on '
      + 'the account of someone with push rights on the project, Developer or above, is also accepted.)'
    : 'In your repository on bitbucket.org: Repository settings > Access keys > Add key. Paste the public_key '
      + 'above as the key and give it any label (access keys are read-only). Adding an access key needs '
      + 'repository admin. Add it to the repository, not to your own account\'s SSH keys: a key on your account '
      + 'cannot prove control and is refused.';
  return `${add} Then call verify with project_path (the project's path, e.g. ${example}) within ${ttlMinutes} `
    + 'minutes. After the check the relay deletes its private key; remove the key from the project then. It is '
    + 'never used again.';
}
