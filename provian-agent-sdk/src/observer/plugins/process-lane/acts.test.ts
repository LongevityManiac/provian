/**
 * process-lane/acts — the money-safety core of the fourth lane.
 *
 * Every claim here ships with its RED negative control, per the standing
 * doctrine (a guard observed only green proves nothing): each exclusion test
 * also feeds the SAME tracker a command that MUST seal, so a tracker hard-wired
 * to seal nothing (or everything) fails. The empty-population and
 * unreachable-branch shapes are named explicitly.
 */

import { describe, it, expect } from 'vitest';
import { ProcessActTracker, extractOrigins, type ActLedger, type SealedAct } from './acts';
import type { ProcEntry, ProcSnapshot } from './snapshot';

const OBSERVER_PID = 100;
const AGENT_RUNTIME_PID = 200; // long-lived, present at baseline — not the daemon, not an act root

function proc(pid: number, ppid: number, argv: string[], bytesWritten: number | null = 0): ProcEntry {
  return { pid, ppid, startKey: `${pid}:s`, argv, bytesWritten };
}

function snap(atMs: number, entries: ProcEntry[]): ProcSnapshot {
  const procs = new Map<string, ProcEntry>();
  for (const e of entries) procs.set(e.startKey, e);
  return { atMs, procs };
}

class FakeLedger implements ActLedger {
  readonly minted = new Set<string>();
  readonly serviced = new Set<string>();
  hasMinted(k: string): boolean { return this.minted.has(k); }
  recordMinted(k: string): void { this.minted.add(k); }
  isServiced(i: string): boolean { return this.serviced.has(i); }
  recordServiced(i: string): void { this.serviced.add(i); }
}

function tracker(ledger: ActLedger, identify: (e: { argv?: readonly string[] }) => string | null = () => null) {
  return new ProcessActTracker(
    {
      observerPid: OBSERVER_PID,
      deviceId: 'dev-test',
      witness: null,
      identifyProgram: (e) => identify(e),
      maxActMs: 5_000,
      sealGraceMs: 100,
      respawnThreshold: 2,
      serviceWindowMs: 10_000,
    },
    ledger,
  );
}

/** Baseline: the daemon (100) and the long-lived agent runtime (200) already running. */
const BASELINE = [proc(OBSERVER_PID, 1, ['node', 'observer']), proc(AGENT_RUNTIME_PID, 1, ['agent-runtime'])];

/** Drive the tracker to completion of a single command and return what sealed. */
function runAndSeal(t: ProcessActTracker, command: ProcEntry[], now = 1000): SealedAct[] {
  t.observe(snap(now, BASELINE));                                   // baseline
  t.observe(snap(now + 100, [...BASELINE, ...command]));            // command starts
  t.observe(snap(now + 200, BASELINE));                             // command tree exits
  t.observe(snap(now + 400, BASELINE));                             // grace (100ms) elapsed → seal
  return t.drainSealed();
}

describe('ProcessActTracker — one PE per completed command ', () => {
  it('seals exactly one act for a command that runs and completes', () => {
    const sealed = runAndSeal(tracker(new FakeLedger()), [proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'echo hi'])]);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].processCount).toBe(1);
    expect(sealed[0].turnId.startsWith('pl:')).toBe(true);
  });

  it('RED control: a command still running (never completed) seals NOTHING', () => {
    const t = tracker(new FakeLedger());
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'sleep'])]));
    t.observe(snap(1300, [...BASELINE, proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'sleep'])])); // still alive
    expect(t.drainSealed()).toHaveLength(0); // the seal path is not hard-wired green
  });

  it('folds a same-poll child even when its PID is LOWER than its parent (PID wraparound) — one act', () => {
    // RED control for the topological fold: root and child both appear in ONE
    // poll, and the child carries a LOWER pid than its parent (a long-lived VM wrapped its PID
    // space). A pid-ordered admit would examine the child first, find no owned parent, and root a
    // SECOND act → two PEs for one command (over-mint). Topological admission keeps it to one.
    const t = tracker(new FakeLedger());
    const root = proc(60000, AGENT_RUNTIME_PID, ['sh', '-c', 'work']); // high pid (near wrap)
    const child = proc(12, 60000, ['curl', 'https://api.example.com']); // wrapped LOW pid, parent = root
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, root, child])); // both new in the same poll, child.pid < root.pid
    t.observe(snap(1200, BASELINE));                    // both exit
    t.observe(snap(1400, BASELINE));                    // grace → seal
    const sealed = t.drainSealed();
    expect(sealed).toHaveLength(1);        // ONE command, one PE (not two)
    expect(sealed[0].processCount).toBe(2);
  });

  it('a command that spawns many children is ONE act, not many', () => {
    const t = tracker(new FakeLedger());
    const root = proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'build']);
    const kids = [proc(301, 300, ['cc', 'a.c']), proc(302, 301, ['ld', 'a.o']), proc(303, 300, ['cc', 'b.c'])];
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, root]));
    t.observe(snap(1150, [...BASELINE, root, ...kids])); // 50-process-build shape, in miniature
    t.observe(snap(1200, BASELINE));                      // whole tree exits
    t.observe(snap(1400, BASELINE));                      // grace → seal
    const sealed = t.drainSealed();
    expect(sealed).toHaveLength(1);
    expect(sealed[0].processCount).toBe(4); // root + 3 children, one act
  });
});

describe('ProcessActTracker — only the agent\'s acts mint ', () => {
  it('never seals the daemon\'s own process tree', () => {
    const t = tracker(new FakeLedger());
    // A child of the observer (a self-update helper, say) plus a real agent command.
    const daemonChild = proc(101, OBSERVER_PID, ['node', 'self-update']);
    const agentCmd = proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'work']);
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, daemonChild, agentCmd]));
    t.observe(snap(1200, BASELINE)); // both exit
    t.observe(snap(1400, BASELINE)); // grace
    const sealed = t.drainSealed();
    // RED control baked in: the agent command DID seal, so the exclusion is not excluding everything.
    expect(sealed).toHaveLength(1);
    expect(sealed[0].processCount).toBe(1); // only the agent command's tree, never the daemon child
  });

  it('a process already running at baseline is never a command root', () => {
    const t = tracker(new FakeLedger());
    // 250 is present in the FIRST snapshot → infrastructure, never minted even when it exits.
    const preexisting = proc(250, 1, ['some-service']);
    t.observe(snap(1000, [...BASELINE, preexisting]));
    t.observe(snap(1100, [...BASELINE, preexisting, proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'work'])]));
    t.observe(snap(1200, [...BASELINE])); // both 250 and 300 gone
    t.observe(snap(1400, [...BASELINE]));
    const sealed = t.drainSealed();
    expect(sealed).toHaveLength(1); // only the NEW command (300); the baseline process never sealed
  });

  it('excludes a program a described lane already witnesses ', () => {
    const ledger = new FakeLedger();
    // identifyProgram claims any command whose argv0 is "claude" (Atlas on its session files).
    const identify = (e: { argv?: readonly string[] }) => (e.argv?.[0] === 'claude' ? 'claude-code' : null);
    const t = tracker(ledger, identify);
    const witnessed = proc(300, AGENT_RUNTIME_PID, ['claude', 'chat']);
    const unwitnessed = proc(310, AGENT_RUNTIME_PID, ['sh', '-c', 'curl https://api.example.com']);
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, witnessed, unwitnessed]));
    t.observe(snap(1200, BASELINE));
    t.observe(snap(1400, BASELINE));
    const sealed = t.drainSealed();
    // The witnessed program sealed NOTHING here; the unwitnessed one sealed (RED control).
    expect(sealed).toHaveLength(1);
    expect(sealed[0].origins.length).toBeGreaterThan(0); // from the unwitnessed command's URL
  });
});

describe('ProcessActTracker — the VM runtime\'s background services never mint ', () => {
  it('excludes a persistent (never-completing) service', () => {
    const t = tracker(new FakeLedger());
    const service = proc(400, AGENT_RUNTIME_PID, ['node', 'scheduler-job']);
    const command = proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'work']);
    t.observe(snap(1000, BASELINE));
    t.observe(snap(1100, [...BASELINE, service, command]));
    t.observe(snap(1300, [...BASELINE, service])); // the command exits; the service runs on
    t.observe(snap(1500, [...BASELINE, service])); // grace → the command seals
    // Past maxActMs (5000) the still-running service is recognised persistent and dropped.
    t.observe(snap(1000 + 6000, [...BASELINE, service]));
    const sealed = t.drainSealed();
    expect(sealed).toHaveLength(1);                 // only the transient command (RED control)
    expect(sealed.every((a) => a.processCount === 1)).toBe(true);
  });

  it('excludes a fast-respawning identity after the threshold, and marks it serviced', () => {
    const ledger = new FakeLedger();
    const t = tracker(ledger);
    t.observe(snap(1000, BASELINE));
    // First instance opens and exits quickly.
    t.observe(snap(1050, [...BASELINE, proc(300, AGENT_RUNTIME_PID, ['node', 'cron-job'])]));
    t.observe(snap(1080, BASELINE)); // exits (within grace, not yet sealed)
    // Second instance of the SAME identity (same parent + argv0) opens — a relaunch.
    t.observe(snap(1090, [...BASELINE, proc(310, AGENT_RUNTIME_PID, ['node', 'cron-job'])]));
    t.observe(snap(1120, BASELINE)); // exits
    t.observe(snap(1400, BASELINE)); // grace elapses for both
    const sealed = t.drainSealed();
    expect(sealed).toHaveLength(0);                 // the supervised job never minted
    expect(ledger.serviced.size).toBeGreaterThan(0); // and the identity is remembered as a service
  });

  it('a back-to-back loop (each instance exits in the SAME poll the next starts) is a service after its first instance', () => {
    // The shape seen on a hosted sandbox (2026-10-21): a baseline shell loop runs `sleep 2` again the
    // moment the last one exits, so every poll shows one exit and one new instance together. The
    // relaunch must be counted even then; before the fix it never was, and every instance minted.
    const ledger = new FakeLedger();
    const t = tracker(ledger);
    const LOOP_PID = 327;
    const base = [...BASELINE, proc(LOOP_PID, AGENT_RUNTIME_PID, ['bash', '-c', 'while :; do sleep 2; done'])];
    t.observe(snap(1000, base));
    let sealedCount = 0;
    for (let i = 0; i < 120; i++) {
      t.observe(snap(1000 + (i + 1) * 2000, [...base, proc(1000 + i, LOOP_PID, ['sleep', '2'])]));
      sealedCount += t.drainSealed().length;
    }
    // RED control in the same tracker: a real command the agent runtime starts still seals.
    const now = 1000 + 122 * 2000;
    t.observe(snap(now, [...base, proc(5000, AGENT_RUNTIME_PID, ['git', 'commit'])]));
    t.observe(snap(now + 50, base));
    t.observe(snap(now + 400, base));
    const command = t.drainSealed();
    expect(sealedCount).toBeLessThanOrEqual(1);       // at most the declared first instance, never 120
    expect(ledger.serviced.size).toBeGreaterThan(0);  // the loop's identity is remembered as a service
    expect(command).toHaveLength(1);                  // the agent's command is unaffected
  });
});

describe('ProcessActTracker — mint-once on the daemon\'s own record ', () => {
  it('does not re-seal an act whose key the ledger already minted', () => {
    const ledger = new FakeLedger();
    const first = runAndSeal(tracker(ledger), [proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'work'])]);
    expect(first).toHaveLength(1);
    ledger.recordMinted(first[0].key); // the plugin records on commit
    // A second tracker (a restart) sees the SAME command invocation again.
    const second = runAndSeal(tracker(ledger), [proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'work'])]);
    expect(second).toHaveLength(0); // mint-once held across the restart
  });

  it('a restart re-baselines, so an in-flight command present at restart mints nothing', () => {
    const ledger = new FakeLedger();
    const t = tracker(ledger);
    // The command is ALREADY running when this (restarted) tracker takes its baseline.
    const running = proc(300, AGENT_RUNTIME_PID, ['sh', '-c', 'long']);
    t.observe(snap(1000, [...BASELINE, running])); // baseline includes the in-flight command
    t.observe(snap(1100, BASELINE));               // it exits
    t.observe(snap(1300, BASELINE));               // grace
    expect(t.drainSealed()).toHaveLength(0);       // never minted (it was baseline, not a new command)
  });
});

describe('extractOrigins — destinations observed in the command line ', () => {
  it('records a public URL as a resolvable domain origin', () => {
    const origins = extractOrigins(['curl', 'https://api.example.com/v1/x'], null);
    expect(origins.some((o) => o.origin_identifier === 'domain:api.example.com')).toBe(true);
  });

  it('records a bare public host and an scp-style git remote', () => {
    const origins = extractOrigins(['git', 'clone', 'git@github.com:owner/repo.git'], null);
    expect(origins.some((o) => o.origin_identifier === 'domain:github.com')).toBe(true);
  });

  it('RED control: a loopback / private host adds NOTHING (it is not publicly resolvable)', () => {
    expect(extractOrigins(['curl', 'http://localhost:8080/x'], null)).toHaveLength(0);
    expect(extractOrigins(['psql', 'db.internal'], null)).toHaveLength(0);
  });

  it('empty population: no argv tokens yields no origins (named, not vacuous)', () => {
    expect(extractOrigins([], null)).toHaveLength(0);
    expect(extractOrigins(['echo', 'hello'], null)).toHaveLength(0);
  });
});
