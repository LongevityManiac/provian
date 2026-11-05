import { describe, it, expect } from 'vitest';
import { buildSessionOtelPublishPlan, SESSION_OTEL_ENV_KEY } from './service';

// Lever 1: the session-wide OTLP endpoint publish plan, per platform. Pure, so
// every platform's plan is checkable on any host (mirrors buildWindowsObserverTaskXml).

describe('buildSessionOtelPublishPlan', () => {
  const ENDPOINT = 'http://localhost:4318';

  it('macOS: launchctl setenv of the endpoint ONLY (never OTEL_SERVICE_NAME)', () => {
    const plan = buildSessionOtelPublishPlan(4318, 'darwin', '/Users/me');
    expect(plan.platform).toBe('darwin');
    expect(plan.endpoint).toBe(ENDPOINT);
    expect(plan.commands).toEqual([
      { command: 'launchctl', args: ['setenv', SESSION_OTEL_ENV_KEY, ENDPOINT] },
    ]);
    expect(plan.files).toEqual([]);
    // A service-name would mislabel every emitter on the box — must not appear.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('OTEL_SERVICE_NAME');
  });

  it('Linux: systemctl --user set-environment + login-persistent environment.d file', () => {
    const plan = buildSessionOtelPublishPlan(4318, 'linux', '/home/me');
    expect(plan.commands).toEqual([
      { command: 'systemctl', args: ['--user', 'set-environment', `${SESSION_OTEL_ENV_KEY}=${ENDPOINT}`] },
    ]);
    expect(plan.files).toEqual([
      { path: '/home/me/.config/environment.d/provian-otel.conf', content: `${SESSION_OTEL_ENV_KEY}=${ENDPOINT}\n` },
    ]);
  });

  it('Windows: setx persists to the user registry', () => {
    const plan = buildSessionOtelPublishPlan(4318, 'win32', 'C:\\Users\\me');
    expect(plan.commands).toEqual([
      { command: 'setx', args: [SESSION_OTEL_ENV_KEY, ENDPOINT] },
    ]);
    expect(plan.files).toEqual([]);
  });

  it('honors a non-default port', () => {
    const plan = buildSessionOtelPublishPlan(9999, 'darwin', '/Users/me');
    expect(plan.endpoint).toBe('http://localhost:9999');
    expect(plan.commands[0].args).toContain('http://localhost:9999');
  });

  // NEGATIVE CONTROL: an unsupported platform produces NO commands and NO files,
  // so publishSessionOtelEndpoint reports published:false rather than silently
  // "succeeding" — the honest fallback to `npx @provian/agent-sdk run`.
  it('unknown platform: empty plan (no commands, no files), directs to `npx @provian/agent-sdk run`', () => {
    const plan = buildSessionOtelPublishPlan(4318, 'aix', '/home/me');
    expect(plan.commands).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.note).toContain('npx @provian/agent-sdk run');
  });
});
