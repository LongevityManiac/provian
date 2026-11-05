import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * Fetch the installer's pinned Node22 from official archives, verify the checksum
 * carried by the signed daemon bundle, and install it atomically in ~/.provian.
 * Version/hash pins and layout match the shell/PowerShell installer preludes.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawnSync as realSpawnSync, type SpawnSyncReturns } from 'child_process';

/** Pinned Node. MUST equal `BOOTSTRAP_NODE_VERSION` in the backend prelude. */
export const PROVIAN_NODE_VERSION = 'v22.23.2';

/** Pinned SHA-256 per `<os>-<arch>`. MUST equal `BOOTSTRAP_NODE_SHA256` in the backend prelude. */
export const PROVIAN_NODE_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  'darwin-x64': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
  'linux-arm64': '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30',
  'linux-x64': 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
  'win-arm64': 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3',
  'win-x64': '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
};

/** A failed fetch is retried no sooner than this (a restart loop must not re-download 40 MB a minute). */
export const NODE_FETCH_RETRY_MS = 6 * 60 * 60 * 1000;

/** Records the last fetch attempt, for the retry bound. */
export const NODE_FETCH_MARKER = 'node-fetch.json';

export interface NodeDistTarget {
  /** `<os>-<arch>` key into PROVIAN_NODE_SHA256. */
  key: string;
  /** Archive file name on nodejs.org/dist/<version>/. */
  file: string;
  kind: 'tar.gz' | 'zip';
}

/** The official archive for this platform, or null when Provian pins none (pure). */
export function nodeDistTarget(platform: NodeJS.Platform, arch: string, version: string = PROVIAN_NODE_VERSION): NodeDistTarget | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!a) return null;
  if (platform === 'darwin' || platform === 'linux') {
    return { key: `${platform}-${a}`, file: `node-${version}-${platform}-${a}.tar.gz`, kind: 'tar.gz' };
  }
  if (platform === 'win32') {
    return { key: `win-${a}`, file: `node-${version}-win-${a}.zip`, kind: 'zip' };
  }
  return null;
}

/**
 * Where the installer's Node lives on this platform (pure). Mirrors the
 * prelude's layout, so a Windows box healed by either finds the other's.
 */
export function provianNodeBin(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = PROVIAN_NODE_VERSION,
): string {
  const root = path.join(home, '.provian', 'node');
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    return path.join(root, `node-${version}-win-${a}`, 'node.exe');
  }
  return path.join(root, 'bin', 'node');
}

type SpawnSyncFn = (cmd: string, args: string[], opts: Record<string, unknown>) => SpawnSyncReturns<Buffer | string>;

export interface FetchProvianNodeDeps {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  /** Download `url` to `dest`. Default: curl (honours HTTPS_PROXY, as the prelude does), else fetch. */
  download?: (url: string, dest: string) => Promise<void>;
  /** Extract `archive` into the empty directory `dir` the way the prelude does. */
  extract?: (archive: string, dir: string, kind: NodeDistTarget['kind']) => void;
  /** Does the node binary at `p` pass the store-capability probe? */
  probe: (p: string) => boolean;
  log?: (line: string) => void;
  /** Ignore the retry bound (an explicit operator verb). */
  force?: boolean;
  /** Test seam: the pinned hashes (default PROVIAN_NODE_SHA256). */
  pins?: Readonly<Record<string, string>>;
}

export type FetchProvianNodeResult =
  | { outcome: 'installed'; bin: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string };

function readMarker(file: string): { at_ms?: number; outcome?: string } | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as { at_ms?: number; outcome?: string }; } catch { return null; }
}

function writeMarker(file: string, outcome: string, reason: string, atMs: number): void {
  try { fs.writeFileSync(file, `${JSON.stringify({ at_ms: atMs, outcome, reason, version: PROVIAN_NODE_VERSION })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

async function defaultDownload(url: string, dest: string, _spawnSync: SpawnSyncFn = realSpawnSync): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
}

function defaultExtract(archive: string, dir: string, kind: NodeDistTarget['kind'], spawnSync: SpawnSyncFn = realSpawnSync): void {
  // POSIX: the prelude's `tar -xzf … --strip-components=1`. Windows: the bsdtar
  // shipped with Windows 10+ reads zip; the prelude's Expand-Archive layout.
  const args = kind === 'tar.gz' ? ['-xzf', archive, '-C', dir, '--strip-components=1'] : ['-xf', archive, '-C', dir];
  const r = spawnSync('tar', args, { stdio: 'ignore', timeout: 300_000 });
  if (r.status !== 0) throw new Error('could not unpack the Node.js archive');
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Fetch, verify, probe and install the pinned Node into `~/.provian/node`.
 * Fail-closed at every step: an unpinned platform, a download error, a hash
 * mismatch, an unpack error or a binary that fails the store probe leaves the
 * existing `~/.provian/node` (if any) untouched. Installs by staging beside it
 * and renaming, so a reader never sees a half-written runtime. Never throws.
 */
export async function fetchProvianNode(deps: FetchProvianNodeDeps): Promise<FetchProvianNodeResult> {
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const provianDir = path.join(home, '.provian');
  const marker = path.join(provianDir, NODE_FETCH_MARKER);

  const target = nodeDistTarget(platform, arch);
  const expected = target ? (deps.pins ?? PROVIAN_NODE_SHA256)[target.key] : undefined;
  if (!target || !expected) return { outcome: 'skipped', reason: `no pinned Node.js for ${platform}-${arch}` };

  if (!deps.force) {
    const last = readMarker(marker);
    if (last && last.outcome === 'failed' && typeof last.at_ms === 'number' && now() - last.at_ms < NODE_FETCH_RETRY_MS) {
      return { outcome: 'skipped', reason: 'the last Node.js download failed less than 6 hours ago' };
    }
  }

  const finalDir = path.join(provianDir, 'node');
  const stamp = `${process.pid}-${now()}`;
  const staging = path.join(provianDir, `node.staging-${stamp}`);
  const archive = path.join(provianDir, `node.download-${stamp}.${target.kind}`);
  const fail = (reason: string): FetchProvianNodeResult => {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(archive, { force: true }); } catch { /* ok */ }
    writeMarker(marker, 'failed', reason, now());
    return { outcome: 'failed', reason };
  };

  try {
    fs.mkdirSync(provianDir, { recursive: true, mode: 0o700 });
    const url = `https://nodejs.org/dist/${PROVIAN_NODE_VERSION}/${target.file}`;
    log(`[observer] node runtime: downloading Node.js ${PROVIAN_NODE_VERSION} (${target.file}) into ~/.provian/node`);
    try {
      await (deps.download ?? ((u, d) => defaultDownload(u, d)))(url, archive);
    } catch (err) {
      return fail(`download failed (${(err as Error).message})`);
    }
    let actual: string;
    try { actual = sha256File(archive); } catch { return fail('download missing'); }
    if (actual !== expected) return fail(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);

    fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
    try {
      (deps.extract ?? ((a, d, k) => defaultExtract(a, d, k)))(archive, staging, target.kind);
    } catch (err) {
      return fail((err as Error).message);
    }
    try { fs.rmSync(archive, { force: true }); } catch { /* ok */ }

    // The staged binary, at the layout the prelude writes.
    const stagedBin = provianNodeBin(home, platform, arch).replace(finalDir, staging);
    if (!fs.existsSync(stagedBin) || !deps.probe(stagedBin)) return fail('the downloaded Node.js cannot read the harness stores');

    // POSIX swaps the whole ~/.provian/node (a running binary's directory can be
    // renamed). Windows keeps one version-named subdir per build, so only that
    // subdir moves in and a running older build (whose directory Windows will not
    // let us rename) is left where it is.
    const from = platform === 'win32' ? path.dirname(stagedBin) : staging;
    const to = platform === 'win32' ? path.dirname(provianNodeBin(home, platform, arch)) : finalDir;
    if (platform === 'win32') fs.mkdirSync(finalDir, { recursive: true });
    const old = fs.existsSync(to) ? path.join(provianDir, `node.old-${stamp}`) : null;
    if (old) fs.renameSync(to, old);
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (old) { try { fs.renameSync(old, to); } catch { /* ok */ } }
      return fail(`could not install (${(err as Error).message})`);
    }
    if (old) { try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* ok */ } }
    if (platform === 'win32') { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ok */ } }

    const bin = provianNodeBin(home, platform, arch);
    writeMarker(marker, 'installed', 'ok', now());
    log(`[observer] node runtime: installed Node.js ${PROVIAN_NODE_VERSION} at ${bin} (checksum verified)`);
    return { outcome: 'installed', bin };
  } catch (err) {
    return fail(`unexpected error (${(err as Error).message})`);
  }
}
