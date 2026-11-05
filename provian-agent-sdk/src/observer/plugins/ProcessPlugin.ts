import * as fs from 'fs';
import { execSync } from 'child_process';
import { platform } from 'os';
import type { ObserverPlugin } from './PluginInterface';
import type { ProvianObserver } from '../ProvianObserver';
import type { PluginContribution, SessionState } from '../types';

interface ProcSnapshot {
  cpuSeconds: number;   // cumulative user+sys CPU seconds
  rssMb: number;        // current resident set size in MB
  ts: number;           // timestamp in ms
}

const NUM_CORES = require('os').cpus()?.length || 1;

/**
 * Reads process stats (CPU, memory) for the target PID or own process group
 * and feeds session boundary detection. Always active - contributes telemetry,
 * never generates its own PE.
 */
export class ProcessPlugin implements ObserverPlugin {
  readonly name = 'process';
  private observer!: ProvianObserver;
  private targetPid!: number;
  private last: ProcSnapshot | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
    this.targetPid = observer.getTargetPid();
  }

  async start(): Promise<void> {
    // first sample establishes baseline
    this.last = this.sample();
    this.sampleTimer = setInterval(() => this.onSample(), 1000);
  }

  async stop(): Promise<void> {
    if (this.sampleTimer) { clearInterval(this.sampleTimer); this.sampleTimer = null; }
  }

  tick(_session: SessionState | null): PluginContribution | null {
    return null;
  }

  private onSample(): void {
    const snap = this.sample();
    if (!snap) return;

    if (!this.last) { this.last = snap; return; }

    const dtSec = Math.max((snap.ts - this.last.ts) / 1000, 0.001);
    const cpuDelta = Math.max(snap.cpuSeconds - this.last.cpuSeconds, 0);
    const cpuLoad = cpuDelta / dtSec / NUM_CORES;

    const event = this.observer.sessionManager.tick({
      cpuLoad,
      rssMb: snap.rssMb,
      now: snap.ts,
    });

    if (this.observer.sessionManager.current()) {
      this.observer.sessionManager.addCpuSeconds(cpuDelta);
    }

    if (event.type === 'session_ended') {
      void this.observer.onSessionEnded(event.state, event.reason);
    }

    this.last = snap;
  }

  private sample(): ProcSnapshot | null {
    try {
      const p = platform();
      if (p === 'linux') return this.sampleLinux();
      if (p === 'darwin') return this.sampleDarwin();
      // Fallback: use process.resourceUsage / memoryUsage
      return this.sampleNode();
    } catch {
      return this.sampleNode();
    }
  }

  private sampleLinux(): ProcSnapshot | null {
    const statPath = `/proc/${this.targetPid}/stat`;
    const statusPath = `/proc/${this.targetPid}/status`;
    if (!fs.existsSync(statPath)) return this.sampleNode();
    try {
      const stat = fs.readFileSync(statPath, 'utf-8');
      const rparen = stat.lastIndexOf(')');
      const rest = stat.slice(rparen + 2).split(/\s+/);
      // Fields after the comm: state=0, ... utime=11, stime=12 (0-indexed in rest)
      const utime = parseInt(rest[11], 10);
      const stime = parseInt(rest[12], 10);
      const clkTck = 100; // sysconf(_SC_CLK_TCK) is 100 on all common Linux
      const cpuSeconds = (utime + stime) / clkTck;

      let rssMb = 0;
      if (fs.existsSync(statusPath)) {
        const status = fs.readFileSync(statusPath, 'utf-8');
        const m = status.match(/VmRSS:\s+(\d+)\s*kB/);
        if (m) rssMb = parseInt(m[1], 10) / 1024;
      }
      return { cpuSeconds, rssMb, ts: Date.now() };
    } catch {
      return this.sampleNode();
    }
  }

  private sampleDarwin(): ProcSnapshot | null {
    try {
      const out = execSync(`ps -o rss=,time= -p ${this.targetPid}`, {
        encoding: 'utf-8', timeout: 2000,
      }).trim();
      // Output: "  12345   00:01:23.45"
      const parts = out.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return this.sampleNode();
      const rssKb = parseInt(parts[0], 10);
      const cpuSeconds = parseCpuTime(parts[1]);
      return { cpuSeconds, rssMb: rssKb / 1024, ts: Date.now() };
    } catch {
      return this.sampleNode();
    }
  }

  private sampleNode(): ProcSnapshot {
    const ru = process.resourceUsage();
    const mem = process.memoryUsage();
    return {
      cpuSeconds: (ru.userCPUTime + ru.systemCPUTime) / 1_000_000,
      rssMb: mem.rss / (1024 * 1024),
      ts: Date.now(),
    };
  }
}

function parseCpuTime(s: string): number {
  // Forms: "MM:SS.HH" or "HH:MM:SS.HH"
  const parts = s.split(':').map(x => parseFloat(x));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}
