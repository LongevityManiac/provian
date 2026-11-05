/**
 * `provian process-lane record | status`.
 *
 * `record` re-records which program launches the agent's commands and the line it starts them with,
 * observed from THIS command's own process ancestry — so the agent runs it as an ordinary command
 * from its own harness (the standing instruction names it when the process lane flags a harness
 * change). Only hashes are written. `status` prints the lane's state as the observer last wrote it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { launcherRecordKey, processLaneStatePath, processLauncherPath, readLauncherRecord, recordLauncher } from '../observer/plugins/process-lane/launcher';

export { processLaneStatePath };

export function readProcessLaneState(home = os.homedir()): { state: string; at_ms: number | null; record: string | null } | null {
  try {
    const j = JSON.parse(fs.readFileSync(processLaneStatePath(home), 'utf8')) as { state?: unknown; at_ms?: unknown; record?: unknown };
    return typeof j.state === 'string' && /^[a-z_]{1,40}$/.test(j.state)
      ? { state: j.state, at_ms: typeof j.at_ms === 'number' ? j.at_ms : null, record: typeof j.record === 'string' ? j.record : null } : null;
  } catch { return null; }
}

/**
 * The lane's state as it applies NOW: a state the observer judged under an earlier launcher record (a
 * re-record — this very command's heal, — that the observer has not read yet) is
 * `starting`, never the old flag.
 */
export function currentProcessLaneState(home = os.homedir()): string | null {
  const st = readProcessLaneState(home);
  if (!st) return null;
  const rec = readLauncherRecord(processLauncherPath(home));
  if (rec && st.record !== null && st.record !== createHash('sha256').update(launcherRecordKey(rec), 'utf8').digest('hex')) return 'starting';
  return st.state;
}

const STATE_TEXT: Record<string, string> = {
  starting: 'starting — a launcher was just recorded; the observer reads it within seconds',
  active: 'active — each command your harness launches seals one PE when it completes',
  inert_other_lane: 'off — this agent has another witness lane (session files, the model proxy or OTel), which witnesses its work',
  no_launcher: 'flagged — no launcher is recorded, so none of your commands are witnessed; run "$HOME/.provian/bin/provian" process-lane record once from your own session',
  launcher_not_seen: 'flagged — no running program matches the recorded launcher; run `process-lane record` from your own harness',
  launcher_unconfirmed: 'checking — your harness is starting programs that do not start the recorded way; any provian command you run re-records it',
  launcher_changed: 'flagged — your harness changed how it starts commands; run `process-lane record` from your own harness',
  launcher_unsupported: 'not witnessing — your harness hands each command to its child itself (in its command line, or from a long-lived shell), so the process lane cannot tell your commands from its own programs and mints nothing',
  unsupported_platform: 'off — this platform has no process table the lane can read',
};

export function runProcessLaneCli(argv: readonly string[]): number {
  const sub = argv[0] ?? 'status';
  if (sub === 'record') {
    const outcome = recordLauncher({ source: 'record', force: true });
    if (outcome === 'recorded') {
      if (readLauncherRecord(processLauncherPath())?.mode === 'direct') {
        console.log(`  Recorded the program that launches your commands. ${STATE_TEXT.launcher_unsupported}.`);
        return 0;
      }
      console.log('  Recorded the program that launches your commands. The observer picks it up within seconds.');
      return 0;
    }
    console.error(outcome === 'no_launcher'
      ? '  No launcher found above this command (it was not started by a long-running program). Run it from your own harness, as an ordinary command.'
      : '  Could not write the launcher record.');
    return 1;
  }
  if (sub === 'status') {
    const rec = readLauncherRecord(processLauncherPath());
    const st = currentProcessLaneState();
    console.log(`  launcher: ${rec ? `recorded (${rec.source}, ${new Date(rec.recorded_at_ms).toISOString()})` : 'not recorded'}`);
    console.log(`  process lane: ${st ? (STATE_TEXT[st] ?? st) : 'unknown — the observer has not reported yet'}`);
    return 0;
  }
  console.error('  Usage: process-lane record | status');
  return 2;
}
