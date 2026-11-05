/**
 * crash safety of the Grok proxy repoint once the Grok SessionStart hook
 * (which restarted a crashed daemon when Grok started) is gone.
 *
 * The repoint is durable in ~/.grok/config.toml; a daemon that is down while it is
 * there breaks Grok's model calls. So:
 * - the repoint is written only where a supervisor restarts the daemon after a
 * crash and at boot (repointSupervisedHere): launchd, systemd, cron, and the
 * Windows task only when its installed definition carries the minute restart;
 * - a JS-level crash takes the repoint with it before exiting 1
 * (installFatalHandlers), and the supervisor's restart writes it again.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { installFatalHandlers } from './run-daemon';
import { buildWindowsObserverTaskXml, windowsTaskRestartsDaemon, WINDOWS_TASK_MINUTE_TRIGGER } from './service';

describe('installFatalHandlers', () => {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    it(`${event}: the repoint is removed (onFatal) BEFORE the process exits 1, once`, () => {
      const proc = new EventEmitter();
      const order: string[] = [];
      installFatalHandlers(proc as unknown as NodeJS.Process, {
        onFatal: () => order.push('onFatal'),
        exit: (code) => order.push(`exit ${code}`),
      });
      proc.emit(event, new Error('boom'));
      proc.emit(event, new Error('again'));
      expect(order).toEqual(['onFatal', 'exit 1']);
    });
  }

  it('an onFatal that throws still exits 1 (the supervisor restarts the daemon)', () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    installFatalHandlers(proc as unknown as NodeJS.Process, { onFatal: () => { throw new Error('x'); }, exit: (c) => exits.push(c) });
    proc.emit('uncaughtException', new Error('boom'));
    expect(exits).toEqual([1]);
  });
});
