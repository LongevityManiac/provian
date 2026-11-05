/**
 * Every observer start uses the checksum-verified installer Node 22. System Node,
 * even with SQLite support, is only a launcher. Old service units heal on startup
 * through the signed bundle and are re-pointed to the private runtime. Failed
 * fetches stop startup; a one-shot guard prevents re-exec loops.
 */

import * as path from 'path';
import { homedir } from 'os';
import { spawnSync as realSpawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import { sqliteAvailability } from './plugins/transcript/record-store';
import { fetchProvianNode, provianNodeBin, PROVIAN_NODE_VERSION, type FetchProvianNodeResult } from './provian-node';

/**
 * The store-capable Node the installer provides: the bootstrap prelude's fetch,
 * or the daemon's own (provian-node.ts,) — the same pinned build at the
 * same place. POSIX: `~/.provian/node/bin/node` (the sh prelude extracts with
 * `--strip-components=1`). Windows: the version-named subdir the PowerShell
 * prelude's Expand-Archive leaves (before, this named the POSIX path on
 * Windows too, so a Windows daemon never found the runtime it had been given).
 */
export const PROVIAN_NODE_BIN = provianNodeBin(homedir());

/** Set on a re-exec'd child so a still-dark candidate can never loop. */
export const SELFHEAL_GUARD_ENV = 'PROVIAN_NODE_SELFHEAL_REEXEC';

/**
 * Set on a re-exec'd child to the node it was healed FROM, so the healed
 * daemon can re-point the service units still baked with that node.
 */
export const SELFHEAL_FROM_ENV = 'PROVIAN_NODE_SELFHEAL_FROM';

/**
 * The EXACT capability the store reader needs, as a one-liner for probing an
 * arbitrary node binary: require('node:sqlite') resolves AND exposes a
 * DatabaseSync function. Mirrors `sqliteAvailability()` and the shell prelude's
 * probe (they live in three packages that cannot cross-import).
 */
export const STORE_CAPABILITY_PROBE_JS =
  'const m=require("node:sqlite");if(typeof m.DatabaseSync!=="function")process.exit(1)';

export const INSTALLER_NODE_PROBE_JS = STORE_CAPABILITY_PROBE_JS + `;if(process.version!==${JSON.stringify(PROVIAN_NODE_VERSION)})process.exit(1)`;

export function nodeBinaryIsInstallerRuntime(nodePath: string, spawnSync: SpawnSyncFn = realSpawnSync): boolean {
  try { return spawnSync(nodePath, ['-e', INSTALLER_NODE_PROBE_JS], {stdio: 'ignore', timeout: 5000}).status === 0; } catch { return false; }
}

/** Whether THIS running runtime can read the SQLite store (in-process, cheap). */
export function currentRuntimeCanReadStore(): boolean {
  return sqliteAvailability().available;
}

type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => SpawnSyncReturns<Buffer | string>;

/**
 * Probe an arbitrary node binary for the store capability, by running it. Used
 * to confirm a candidate `~/.provian/node` is actually capable before baking or
 * re-execing onto it — never trust a path's existence alone.
 */
export function nodeBinaryCanReadStore(
  nodePath: string,
  spawnSync: SpawnSyncFn = realSpawnSync,
): boolean {
  try {
    const r = spawnSync(nodePath, ['-e', STORE_CAPABILITY_PROBE_JS], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface StoreCapableNodeDeps {
  currentExecPath?: string;
  currentCanRead?: boolean;
  candidateBin?: string;
  exists?: (p: string) => boolean;
  probeBinary?: (nodePath: string) => boolean;
}

/** Select only the installer path for every service, repair and wrapper. */
export function resolveStoreCapableNodeBin(deps: StoreCapableNodeDeps = {}): string {
  // Always bake the installer path, including before the async installer fetch.
  // A missing runtime must fail setup/start; never persist a system-Node fallback.
  return deps.candidateBin ?? PROVIAN_NODE_BIN;
}

export interface NodeSelfHealInputs {
  /** Can the CURRENT runtime read the store? */
  currentCanRead: boolean;
  /** The current runtime's node binary path. */
  currentExecPath: string;
  /** Did we already re-exec once this chain (loop guard)? */
  alreadyReexeced: boolean;
  /** A capable-node candidate on disk, or null if none exists. */
  candidateBin: string | null;
  /** Does that candidate actually pass the store-capability probe? */
  candidateCanRead: boolean;
  /**
   * the candidate path was just re-installed with a capable build (the
   * running runtime WAS a stale ~/.provian/node, e.g. the v22.11.0 pin). The same
   * path now names a different binary, so re-exec onto it is a real move; the
   * loop guard still bounds it to once.
   */
  candidateReplaced?: boolean;
}

export interface NodeSelfHealDecision {
  action: 'none' | 'reexec';
  /** Set when action === 'reexec': the node binary to re-exec under. */
  nodeBin?: string;
  /** One plain sentence for the log. */
  reason: string;
}

/**
 * Layer B (pure core) — decide whether a running daemon should re-exec onto a
 * capable node. Every "no" branch is explicit so the negative controls (loop
 * guard, no-candidate, candidate-is-current, candidate-also-dark) are testable.
 */
export function decideNodeSelfHeal(inputs: NodeSelfHealInputs): NodeSelfHealDecision {
  if (inputs.currentCanRead && !inputs.candidateReplaced &&
      path.resolve(inputs.currentExecPath) === path.resolve(inputs.candidateBin ?? PROVIAN_NODE_BIN)) {
    return { action: 'none', reason: 'already running the installer runtime' };
  }
  if (inputs.alreadyReexeced) {
    return { action: 'none', reason: 'already re-exec\'d once; not looping onto another node' };
  }
  if (!inputs.candidateBin) {
    return {
      action: 'none',
      reason: 'this runtime cannot read the transcript store and no ~/.provian/node is installed to heal onto — re-run the Provian setup command to install one',
    };
  }
  if (path.resolve(inputs.candidateBin) === path.resolve(inputs.currentExecPath) && !inputs.candidateReplaced) {
    return { action: 'none', reason: 'the only candidate node is the current (incapable) runtime' };
  }
  if (!inputs.candidateCanRead) {
    return { action: 'none', reason: 'the candidate ~/.provian/node also cannot read the transcript store' };
  }
  return {
    action: 'reexec',
    nodeBin: inputs.candidateBin,
    reason: 're-execing under the pinned installer Node 22 in ~/.provian/node',
  };
}

export interface SelfHealDriverDeps {
  currentCanRead?: boolean;
  currentExecPath?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  candidateBin?: string;
  exists?: (p: string) => boolean;
  probeBinary?: (nodePath: string) => boolean;
  spawnSync?: SpawnSyncFn;
  exit?: (code: number) => never;
  log?: (line: string) => void;
  /** the candidate path was just re-installed (see NodeSelfHealInputs). */
  candidateReplaced?: boolean;
}

/**
 * Layer B (driver) — gather inputs, decide, and if the decision is `reexec`,
 * run the SAME argv under the capable node and exit with its status. The current
 * (dark) process becomes a thin supervisor for the child's lifetime, which keeps
 * launchd `KeepAlive` / systemd `Restart` satisfied without a service re-bake.
 *
 * Returns only when NO re-exec happens (the caller then starts the observer
 * normally; if still dark, the capture-health alarm reports it). When it does
 * re-exec it never returns — it calls `exit`.
 */
export function selfHealNodeRuntimeIfNeeded(deps: SelfHealDriverDeps = {}): void {
  const currentExecPath = deps.currentExecPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const alreadyReexeced = env[SELFHEAL_GUARD_ENV] === '1';
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const probeBinary = deps.probeBinary ?? ((p: string) => nodeBinaryIsInstallerRuntime(p, deps.spawnSync));
  const log = deps.log ?? ((line: string) => console.log(line));

  const candidatePath = deps.candidateBin ?? PROVIAN_NODE_BIN;
  const candidateExists = exists(candidatePath);
  const candidateBin = candidateExists ? candidatePath : null;
  // Only probe a candidate that exists and is not the current runtime (unless
  // that path was just re-installed with a capable build).
  const candidateCanRead =
    candidateBin !== null && (deps.candidateReplaced || path.resolve(candidateBin) !== path.resolve(currentExecPath))
      ? probeBinary(candidateBin)
      : false;

  const decision = decideNodeSelfHeal({
    currentCanRead: deps.currentCanRead ?? (currentRuntimeCanReadStore() && process.version === PROVIAN_NODE_VERSION),
    currentExecPath,
    alreadyReexeced,
    candidateBin,
    candidateCanRead,
    candidateReplaced: deps.candidateReplaced === true,
  });

  if (decision.action === 'none') {
    // Announce only the actionable dark case; the healthy case stays quiet.
    if (!(deps.currentCanRead ?? (currentRuntimeCanReadStore() && process.version === PROVIAN_NODE_VERSION))) {
      log(`[observer] node self-heal: ${decision.reason}`);
    }
    return;
  }

  const nodeBin = decision.nodeBin as string;
  log(`[observer] ${decision.reason} (${nodeBin})`);
  const spawnSync = deps.spawnSync ?? realSpawnSync;
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
  const argv = deps.argv ?? process.argv.slice(1); // script + its args
  const res = spawnSync(nodeBin, argv, {
    stdio: 'inherit',
    env: { ...env, [SELFHEAL_GUARD_ENV]: '1', [SELFHEAL_FROM_ENV]: currentExecPath },
  });
  exit(res.status ?? 1);
}

export interface EnsureNodeRuntimeDeps extends SelfHealDriverDeps {
  /** The fetch (default: provian-node.ts's verified fetch of the pinned build). */
  fetchNode?: () => Promise<FetchProvianNodeResult>;
}

/** Fetch the pinned runtime if needed, then re-exec before any capture starts. */
export async function ensureStoreCapableNodeRuntime(deps: EnsureNodeRuntimeDeps = {}): Promise<void> {
  const currentCanRead = deps.currentCanRead ?? (currentRuntimeCanReadStore() && process.version === PROVIAN_NODE_VERSION);
  const env = deps.env ?? process.env;
  const currentExecPath = deps.currentExecPath ?? process.execPath;
  const candidate = deps.candidateBin ?? PROVIAN_NODE_BIN;
  const onInstaller = path.resolve(candidate) === path.resolve(currentExecPath);
  if (env[SELFHEAL_GUARD_ENV] === '1' && !(currentCanRead && onInstaller)) {
    throw new Error('Installer Node 22 handover failed; refusing a runtime loop or system-Node capture');
  }
  if (currentCanRead && onInstaller) {
    selfHealNodeRuntimeIfNeeded({ ...deps, currentCanRead });
    return;
  }
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const probeBinary = deps.probeBinary ?? ((p: string) => nodeBinaryIsInstallerRuntime(p, deps.spawnSync));
  const log = deps.log ?? ((line: string) => console.log(line));
  const usable = path.resolve(candidate) !== path.resolve(currentExecPath) && exists(candidate) && probeBinary(candidate);
  let probed = usable;
  let replaced = false;
  if (!usable) {
    log('[observer] node runtime: the pinned installer Node 22 is missing or stale; fetching the runtime the installer provides');
    const fetched = await (deps.fetchNode ?? (() => fetchProvianNode({ probe: probeBinary, log })))();
    if (fetched.outcome !== 'installed') throw new Error(`Installer Node 22 unavailable: ${fetched.reason}`);
    probed = fetched.outcome === 'installed';
    // The running runtime WAS the (stale) ~/.provian/node: its path now names the new build.
    replaced = probed && path.resolve(candidate) === path.resolve(currentExecPath);
  }
  // Layer B decides and re-execs; the candidate was just probed, so it is not probed twice.
  selfHealNodeRuntimeIfNeeded({ ...deps, currentCanRead, currentExecPath, candidateBin: candidate, exists, probeBinary: () => probed, log, candidateReplaced: replaced });
}

/** Prepare the private runtime before a service/wrapper is installed from any SDK entry. */
export async function ensureInstallerNodeAvailable(): Promise<string> {
  if (fs.existsSync(PROVIAN_NODE_BIN) && nodeBinaryIsInstallerRuntime(PROVIAN_NODE_BIN)) return PROVIAN_NODE_BIN;
  const result = await fetchProvianNode({probe: nodeBinaryIsInstallerRuntime});
  if (result.outcome !== 'installed') throw new Error(`Installer Node 22 unavailable: ${result.reason}`);
  return result.bin;
}
