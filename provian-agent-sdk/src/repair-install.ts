/**
 * repair-install — the restore verb for a device whose Provian install broke
 * while its IDENTITY stayed intact.
 *
 * The Atlas Mac mini is the motivating case, and it is not exotic: the wallet,
 * keystore, device credentials and session were all perfectly fine; what died
 * was the runnable artifact the launchd plist and the git hook pointed at. The
 * agent had a valid identity and no way to use it.
 *
 * Re-running onboarding is the WRONG remedy for that — it mints a new wallet
 * and orphans the agent's PE chain. What is needed is narrower: re-point the
 * long-lived hooks at an artifact that exists, and say plainly whether they now
 * resolve. That is all this does. It never touches credentials, never creates a
 * wallet, never submits a PE.
 */

import { checkBakedTargets, extractScriptPaths, resolveRuntimeTarget, realProbe } from './observer/runtime-install';
import { ensureInstallerNodeAvailable, resolveStoreCapableNodeBin } from './observer/node-runtime-heal';
import { enableOpenClawOtel } from './harness-otel-config';
import { removeGrokHooks, type GrokHookRemoval } from './grok-home';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export interface RepairOutcome {
  runtimeKind: 'bundle' | 'package';
  runtimeRoot: string;
  serviceMethod: string;
  hookPath: string | null;
  hookAction: string | null;
  /** Baked paths that still do not resolve AFTER the repair. Empty = healthy. */
  stillBroken: string[];
  /** Whether the harness's own OTel exporter was switched on by this run. */
  otelExporter: 'enabled' | 'already_enabled' | 'unavailable';
  /** The RETIRED Grok Build hook file (`~/.grok/hooks/provian.json`,): removed when Provian's. */
  grokHooks: GrokHookRemoval;
  notes: string[];
}

export interface RepairDeps {
  installService: (o: { env?: Record<string, string>; entrypoint?: { command: string; args: string[] } }) => { method: string };
  installGlobalHook: () => { hookPath: string; action: string; merged: string[] };
  otlpPort: number;
  execPath?: string;
  /** Retired Grok hook-file removal (injectable for tests). Default: the real removal. */
  removeGrokHooks?: () => GrokHookRemoval;
}

/** The artifacts whose baked paths decide whether this machine can capture. */
export function installedArtifactPaths(home: string = homedir()): string[] {
  return [
    path.join(home, 'Library', 'LaunchAgents', 'ai.provian.observer.plist'),
    path.join(home, '.config', 'systemd', 'user', 'provian-observer.service'),
    path.join(home, '.provian', 'hooks', 'post-commit'),
  ];
}

export function readBakedPaths(
  artifacts: string[],
  read: (p: string) => string | null = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
): string[] {
  const out = new Set<string>();
  for (const a of artifacts) {
    const content = read(a);
    if (content === null) continue;
    for (const p of extractScriptPaths(content)) out.add(p);
  }
  return [...out];
}

/**
 * Re-bake the service and the global git hook against a real runtime artifact,
 * then VERIFY. The verification is the point: a repair that reports success
 * without re-reading what it wrote is the same class of mistake as the original
 * install, which also believed it had succeeded.
 */
export async function repairInstall(deps: RepairDeps): Promise<RepairOutcome> {
  const notes: string[] = [];
  const target = resolveRuntimeTarget({ bundlePath: process.env.PROVIAN_BUNDLE_PATH });
  // Repair prepares and bakes the pinned installer runtime, even on system Node26.
  if (!deps.execPath) await ensureInstallerNodeAvailable();
  const execPath = deps.execPath ?? resolveStoreCapableNodeBin();

  const svc = deps.installService({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${deps.otlpPort}` },
    entrypoint: { command: execPath, args: target.observerArgs },
  });

  let hookPath: string | null = null;
  let hookAction: string | null = null;
  try {
    const r = deps.installGlobalHook();
    hookPath = r.hookPath;
    hookAction = r.action;
    if (r.merged.length) notes.push(`merged prior global hooks: ${r.merged.join(', ')}`);
  } catch (err) {
    notes.push(`git hook not installed: ${(err as Error).message}`);
  }

  // The SECOND witness. An endpoint is an address, not an exporter: OpenClaw
  // ships `diagnostics-otel` OFF, so the push path was dead even though the
  // receiver was listening. captureContent stays explicitly false.
  let otelExporter: RepairOutcome['otelExporter'] = 'unavailable';
  try {
    const otel = enableOpenClawOtel();
    if (otel.changed) {
      otelExporter = 'enabled';
      notes.push(`OpenClaw OTel exporter enabled (backup: ${otel.backupPath}) — restart OpenClaw for it to take effect`);
    } else if (otel.reason === 'already_enabled') {
      otelExporter = 'already_enabled';
    } else if (otel.reason !== 'no_config') {
      notes.push(`OpenClaw OTel exporter not enabled: ${otel.reason}`);
    }
  } catch (err) {
    notes.push(`OpenClaw OTel exporter not enabled: ${(err as Error).message}`);
  }

  // the Grok hooks lane is retired. Remove the hook file an earlier
  // install wrote — only ever Provian's own; a foreign provian.json is reported,
  // never touched. (Grok is witnessed by its one lane: session files, proxy, OTel or the process lane.)
  const grokHooks: GrokHookRemoval = (deps.removeGrokHooks ?? (() => removeGrokHooks()))();
  if (grokHooks === 'foreign') notes.push('~/.grok/hooks/provian.json is not Provian\'s; left in place');
  if (grokHooks === 'error') notes.push('the retired Provian Grok hook file could not be removed');

  // Re-read what we just wrote and resolve every path it names.
  const baked = readBakedPaths(installedArtifactPaths());
  const health = checkBakedTargets(baked, realProbe);
  if (baked.length === 0) notes.push('no baked script paths found after repair — nothing was installed');

  return {
    runtimeKind: target.kind,
    runtimeRoot: target.root,
    serviceMethod: svc.method,
    hookPath,
    hookAction,
    stillBroken: health.broken,
    otelExporter,
    grokHooks,
    notes,
  };
}

export function renderRepairOutcome(o: RepairOutcome): { lines: string[]; exitCode: number } {
  const lines = [
    '',
    `  Runtime artifact: ${o.runtimeKind} — ${o.runtimeRoot}`,
    `  Observer service: reinstalled (${o.serviceMethod})`,
    o.hookPath ? `  git commit hook: ${o.hookAction} at ${o.hookPath}` : '  git commit hook: not installed',
    `  harness OTel exporter: ${o.otelExporter}`,
    `  retired Grok hook file: ${o.grokHooks}`,
  ];
  for (const n of o.notes) lines.push(`  note: ${n}`);
  if (o.stillBroken.length > 0) {
    lines.push('');
    lines.push('  STILL BROKEN — these baked paths do not resolve:');
    for (const p of o.stillBroken) lines.push(`    ${p}`);
    return { lines, exitCode: 1 };
  }
  lines.push('');
  lines.push('  Every baked path resolves. The observer can restart and the git hook can fire.');
  return { lines, exitCode: 0 };
}
