import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ObserverPlugin } from './PluginInterface';
import type { ProvianObserver } from '../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../types';
import type { InputOrigin } from '../../input-origins';
import type { OutputDigest } from '../../output-digests';
import { createHash } from 'crypto';
import { unmappedAuthorHint } from '../../git-identity-guidance';
import {
  resolvableOrigin, privateOrigin, artifactScanOrigins, PRIVATE_FILE, npmDependencyOrigin,
} from '../origin-capture';

interface WatchedRepo {
  gitDir: string;
  refsDir: string;
  lastHead: Map<string, string>; // branch ref -> commit hash
}

/**
 * Absolute repo roots this plugin is actively watching, published here for the
 * post-commit hook to read. The hook defers to the observer ONLY for repos in
 * this file; see post-commit.template and publishWatchedRepos().
 */
export function defaultWatchedReposFile(): string {
  return path.join(os.homedir(), '.provian', 'observer-git-repos');
}

/**
 * Polls watched git repositories for new commits and emits coding_session PEs.
 *
 * Coordination with the git post-commit hook (post-commit.template): the hook
 * is the universal commit-capture path (installed globally at onboarding, it
 * fires for every repo on the machine). This plugin, by contrast, only watches
 * repos it is explicitly given (repoPaths / PROVIAN_GIT_REPOS) or discovers at
 * cwd — and the daemon runs with cwd=$HOME, so by default it watches NOTHING.
 * To avoid both dropping a commit and double-counting it, the plugin publishes
 * the set of repos it watches to observer-git-repos; the hook defers to the
 * observer ONLY for a commit whose repo root is in that set, and otherwise
 * fires itself. Empty set (the common case) → the hook is the sole path.
 */
export class GitPlugin implements ObserverPlugin {
  readonly name = 'git';
  private observer!: ProvianObserver;
  private repos: WatchedRepo[] = [];
  private queue: PluginPE[] = [];
  private poll: NodeJS.Timeout | null = null;
  /**
   * Author emails already hinted this run. The daemon witnesses a commit
   * locally regardless of mapping state; a CONNECTED repository's webhook
   * additionally credits the author only once that identity is registered
   * (the relay drops unmapped authors — `dropped_unmapped_author`,).
   * The daemon holds device credentials, not agent credentials, so it cannot
   * read the mapping list — it surfaces the case once per author instead.
   */
  private hintedAuthors = new Set<string>();

  constructor(
    private readonly repoPaths: string[] = [],
    private readonly watchedReposFile: string = defaultWatchedReposFile(),
  ) {}

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
    const discovered = new Set<string>(this.repoPaths);
    // Discover a repo in cwd if present
    const cwdGit = findGitDir(process.cwd());
    if (cwdGit) discovered.add(path.dirname(cwdGit));

    for (const repoPath of discovered) {
      const gitDir = findGitDir(repoPath);
      if (!gitDir) continue;
      const refsDir = path.join(gitDir, 'refs', 'heads');
      const lastHead = readAllRefs(refsDir);
      this.repos.push({ gitDir, refsDir, lastHead });
    }
  }

  async start(): Promise<void> {
    this.publishWatchedRepos();
    this.poll = setInterval(() => this.checkRepos(), 5000);
  }

  async stop(): Promise<void> {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    // Remove the watched-repos file so a dead daemon's stale list never makes
    // the hook wrongly defer. (The hook also re-checks the live pid, so a stale
    // file is harmless on its own; this keeps state clean regardless.)
    try {
      fs.rmSync(this.watchedReposFile, { force: true });
    } catch { /* best-effort */ }
  }

  /**
   * Overwrite observer-git-repos with the absolute roots this plugin watches,
   * one per line (empty file when it watches none). Overwrite — not append —
   * on every start so a previous run's list can never linger. Best-effort: a
   * write failure at worst lets the hook double-count a watched repo (mint-once
   * bounds that on the relay); it never drops a commit.
   */
  private publishWatchedRepos(): void {
    try {
      const roots = this.repos.map((r) => path.dirname(r.gitDir));
      fs.mkdirSync(path.dirname(this.watchedReposFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.watchedReposFile, roots.length ? `${roots.join('\n')}\n` : '');
    } catch (err) {
      this.observer.log('debug', 'git watched-repos publish failed', {
        file: this.watchedReposFile, error: (err as Error).message,
      });
    }
  }

  tick(_session: SessionState | null): PluginContribution | null {
    return null;
  }

  drainPEs(): PluginPE[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  private checkRepos(): void {
    for (const repo of this.repos) {
      try {
        const current = readAllRefs(repo.refsDir);
        for (const [ref, hash] of current) {
          const prev = repo.lastHead.get(ref);
          if (prev && prev !== hash) {
            this.onNewCommit(repo, ref, hash, prev);
          }
        }
        repo.lastHead = current;
      } catch (err) {
        this.observer.log('debug', 'git repo poll error', {
          gitDir: repo.gitDir, error: (err as Error).message,
        });
      }
    }
  }

  private onNewCommit(repo: WatchedRepo, ref: string, hash: string, prevHash: string): void {
    const now = Date.now();
    const repoRoot = path.dirname(repo.gitDir);
    const branch = path.basename(ref);
    let filesChanged = 0;
    let linesAdded = 0;
    let commitSubject = '';
    let authorEmail = '';
    const changedFiles: string[] = [];

    try {
      const stat = execSync(`git -C "${repoRoot}" diff --numstat ${prevHash} ${hash}`, {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
      if (stat) {
        const lines = stat.split('\n');
        filesChanged = lines.length;
        for (const line of lines) {
          const added = parseInt(line.split(/\s+/)[0], 10);
          if (!isNaN(added)) linesAdded += added;
          // numstat is TAB-separated "added\tdeleted\tpath"; the path is the 3rd
          // field. These are PRIVATE origins (recorded hash-only); the plaintext
          // path never leaves the device.
          const cols = line.split('\t');
          const filePath = cols.length >= 3 ? cols.slice(2).join('\t').trim() : '';
          if (filePath) changedFiles.push(filePath);
        }
      }
      commitSubject = execSync(`git -C "${repoRoot}" log -1 --pretty=%s ${hash}`, {
        encoding: 'utf-8', timeout: 5000,
      }).trim().slice(0, 500);
      authorEmail = execSync(`git -C "${repoRoot}" log -1 --pretty=%ae ${hash}`, {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
    } catch (err) {
      this.observer.log('debug', 'git stat error', { error: (err as Error).message });
    }

    if (authorEmail && !this.hintedAuthors.has(authorEmail)) {
      this.hintedAuthors.add(authorEmail);
      this.observer.log('info', unmappedAuthorHint(authorEmail), { repo: repoRoot });
    }

    const session = this.observer.sessionManager.current();
    const windowStart = session?.startedAt ?? (now - 60_000);
    const windowEnd = now;

    const description = `${commitSubject || 'commit'}: ${filesChanged} files, ${linesAdded} lines`;

    // Prompt 2 — the external artifacts this commit consumed, honouring the
    // privacy rule. The observer's body-HMAC is the voucher → observer_device
    // witness. Parent commit + resolved dependency coordinates are PUBLIC facts
    // (resolvable); changed file paths are PRIVATE (hash-only, no plaintext
    // path). The commit subject is artifact-SCANNED (witnessed:false): any
    // public identifiers it merely mentions, not a witnessed boundary crossing.
    const witness = this.observer.observerDeviceWitness?.() ?? null;
    const origins: InputOrigin[] = [];
    if (/^[0-9a-fA-F]{7,64}$/.test(prevHash)) {
      origins.push(resolvableOrigin(`commit:${prevHash.toLowerCase()}`, witness));
    }
    // Cap each class so the 64-entry normalizer never truncates one away:
    // parent(1) + deps(<=30) + files(<=20) all survive for a real commit.
    // a dependency range can carry a credential (git+https://user:token@...);
    // strip it, and hash private_pkg over the STRIPPED value if it can't be made clean.
    for (const dep of resolveRepoDependencies(repoRoot).slice(0, 30)) {
      origins.push(npmDependencyOrigin(dep.name, dep.range, witness));
    }
    for (const filePath of changedFiles.slice(0, 20)) {
      origins.push(privateOrigin(PRIVATE_FILE, `${repoRoot} ${filePath}`, witness));
    }
    // Artifact-scan of the (potentially rich) commit subject — witnessed:false.
    origins.push(...artifactScanOrigins(commitSubject));

    // Trust Layer §2.3 — what this commit PRODUCED: the commit object id and the sha256 of each
    // changed file's bytes at that commit (content digests, never paths; a deleted/binary/oversize
    // file simply contributes no digest). Capped at 20 files beside the commit itself.
    const outputDigests: OutputDigest[] = [];
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(hash)) outputDigests.push({ hash: `git:${hash.toLowerCase()}`, kind: 'commit' });
    for (const filePath of changedFiles.slice(0, 20)) {
      const digest = fileContentDigestAtCommit(repoRoot, hash, filePath);
      if (digest) outputDigests.push({ hash: digest, kind: 'file' });
    }

    this.queue.push({
      actionType: 'coding_session',
      description,
      input_origins: origins,
      output_digests: outputDigests,
      metadata: {
        tool: 'provian-observer-git',
        // Field name MUST be `commit_sha` to match the relay's cross-witness
        // corroboration lookup (findPEsByCommitSha queries metadata.commit_sha)
        // and the GitHub webhook's synthesized PEs. A daemon coding_session and
        // a GitHub push for the same commit cross-corroborate only when both
        // store the hash under the same key. (Pricing is the relay's: these
        // families price witnessed work on the evidence axis: observed
        // tiers earn the family discount (software 0.8x), and costly-to-forge
        // external proof lifts to the flat family rate.)
        commit_sha: hash,
        branch_mac: privateOrigin(PRIVATE_FILE, branch, witness).hash,
        files_changed: filesChanged,
        lines_added: linesAdded,
        author_email: authorEmail || undefined,
      },
      compute: {
        duration_ms: windowEnd - windowStart,
        cpu_seconds: session?.accumulatedCpu ?? null,
        memory_peak_mb: session?.peakMemoryMb ?? null,
        tokens_processed: null,
        records_processed: null,
        output_cardinality: filesChanged > 0 ? filesChanged : null,
        energy_joules: null,
        gpu_seconds: null,
        model_parameters: null,
        framework: null,
        hardware_class: null,
      },
      windowStart,
      windowEnd,
    });
  }
}

/** sha256 of a file's bytes at a commit (`git show <sha>:<path>`), or null when unreadable / >8 MB. */
export function fileContentDigestAtCommit(repoRoot: string, commit: string, filePath: string): string | null {
  try {
    // execFile, never a shell: the path is REPOSITORY-CONTROLLED (`git diff --numstat` output),
    // and a name like `$(...)` would execute inside a shell string.
    if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
    const bytes = execFileSync('git', ['-C', repoRoot, 'show', `${commit}:${filePath}`], {
      encoding: 'buffer', timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * The PUBLIC dependency coordinates the repo resolves against, from its primary
 * manifest (`package.json` → `dependencies`). Returned as `npm:<name>@<range>`
 * resolvable coordinates (the package NAME is what Prompt 3 resolves an owner
 * from; the range is enrichment). Best-effort and non-throwing: a repo with no
 * JS manifest simply contributes no dependency origins. Only `dependencies` is
 * read (not devDependencies) to keep the set the work's actual runtime inputs.
 */
export function resolveRepoDependencyCoords(repoRoot: string): string[] {
  return resolveRepoDependencies(repoRoot).map(({ name, range }) => (range !== null ? `npm:${name}@${range}` : `npm:${name}`));
}

/** One manifest dependency: its name and (when a non-empty string) its range. */
export interface RepoDependency {
  name: string;
  range: string | null;
}

/**
 * The dependencies behind `resolveRepoDependencyCoords`, kept as (name, range)
 * so the origin builder can strip credentials from the RANGE before any
 * coordinate string is formed.
 */
export function resolveRepoDependencies(repoRoot: string): RepoDependency[] {
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, unknown> };
    const deps = pkg.dependencies;
    if (!deps || typeof deps !== 'object') return [];
    const out: RepoDependency[] = [];
    for (const [name, range] of Object.entries(deps)) {
      if (typeof name !== 'string' || name.length === 0) continue;
      out.push({ name, range: typeof range === 'string' && range.length > 0 ? range : null });
    }
    return out;
  } catch {
    return [];
  }
}

function findGitDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return gitPath;
    } catch { /* not found */ }
    dir = path.dirname(dir);
  }
  return null;
}

function readAllRefs(refsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(refsDir)) return out;
  walkRefs(refsDir, refsDir, out);
  return out;
}

function walkRefs(base: string, current: string, out: Map<string, string>): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(current, e.name);
    if (e.isDirectory()) {
      walkRefs(base, full, out);
    } else if (e.isFile()) {
      try {
        const hash = fs.readFileSync(full, 'utf-8').trim();
        const rel = path.relative(base, full);
        out.set(rel, hash);
      } catch { /* skip */ }
    }
  }
}
