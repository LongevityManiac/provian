import { describe, expect, it } from 'vitest';
import { supervisionLines, AGENT_KEEPS_OBSERVER_RUNNING, AGENT_SCHEDULES_OBSERVER } from './bootstrap-flow';

const BUNDLE = { command: '/root/.provian/node/bin/node', args: ['/root/.provian/agent.js', 'observe'] };

describe('supervisionLines — the install states truthfully which mechanism restarts the observer (D;)', () => {
  it('a service manager or a running cron supervises it (no scheduled task is asked of the agent)', () => {
    for (const [m, at, mech] of [['cron', 'crontab', 'cron'], ['systemd', '/u/p.service', 'systemd'], ['launchd', '/l/p.plist', 'launchd']] as const) {
      expect(supervisionLines(m, at, BUNDLE, mech)).not.toContain(AGENT_SCHEDULES_OBSERVER);
    }
  });

  it('a service manager or a running cron supervises it', () => {
    expect(supervisionLines('cron', 'crontab', BUNDLE, 'cron')).toBe('  Observer supervised by cron (crontab): restarted within a minute if it stops, and at boot.\n');
    expect(supervisionLines('systemd', '/u/provian-observer.service', BUNDLE, 'systemd')).toBe('  Observer supervised by systemd (/u/provian-observer.service).\n');
  });

  it('shell_rc: a startup file this box really reads restarts it — nothing to run', () => {
    const out = supervisionLines('detached', undefined, BUNDLE, 'shell_rc');
    expect(out).toContain('the next shell that reads your startup files');
    expect(out).toContain('nothing to run');
    expect(out).not.toContain('Keep the Provian observer running');
    expect(out).not.toContain(AGENT_SCHEDULES_OBSERVER);
  });

  it("agent : no cron, no systemd, no startup file read — the agent is told, as setup, to keep it running", () => {
    const out = supervisionLines('detached', undefined, BUNDLE, 'agent');
    expect(out).toContain("That is the agent's job.");
    expect(out).toContain('Setup for the agent:');
    expect(out).toContain(AGENT_KEEPS_OBSERVER_RUNNING(''/* shape */).split(' — ')[0]); // "Keep the Provian observer running"
    expect(out).toContain('observe --if-not-running`.');
    // A scheduled run of that command is how the agent does it, and it keeps one it has.
    expect(out).toContain(`  ${AGENT_SCHEDULES_OBSERVER}\n`);
    expect(AGENT_SCHEDULES_OBSERVER).toContain('If you have one, keep it; never remove it.');
    expect(out).not.toContain('nothing to run');
    // Setup, never reporting work.
    expect(out.toLowerCase()).not.toMatch(/report (your|its) work|submit/);
  });

  it('a crontab with no running cron daemon is NOT cron supervision — it says so and falls to the real mechanism', () => {
    const out = supervisionLines('cron', 'crontab', BUNDLE, 'agent');
    expect(out).toContain('no running cron daemon');
    expect(out).toContain('Setup for the agent:');
    expect(out).not.toContain('restarted within a minute');
  });

  it('RED control: the pre- shell_rc claim ("the next shell that opens starts it again") appears for no mechanism', () => {
    for (const m of ['shell_rc', 'agent', 'cron'] as const) {
      expect(supervisionLines('detached', undefined, BUNDLE, m)).not.toContain('the next shell that opens starts it again');
    }
  });

  it("the setup sentence is the operator’s, verbatim around the command", () => {
    expect(AGENT_KEEPS_OBSERVER_RUNNING('X')).toBe("Keep the Provian observer running — if it isn't, run `X`.");
  });
});
