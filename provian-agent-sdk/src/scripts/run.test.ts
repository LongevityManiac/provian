import { describe, it, expect } from 'vitest';
import { parseRunArgs, buildChildEnv } from './run';
import { SESSION_OTEL_ENV_KEY } from '../observer/service';

describe('parseRunArgs', () => {
  it('splits command + args after an explicit --', () => {
    expect(parseRunArgs(['--', 'python', 'agent.py', '--serve'])).toEqual({
      command: 'python', args: ['agent.py', '--serve'],
    });
  });
  it('works without the -- separator', () => {
    expect(parseRunArgs(['./openclaw', '--serve'])).toEqual({
      command: './openclaw', args: ['--serve'],
    });
  });
  // NEGATIVE CONTROL: nothing to run → null (main() then prints usage, exit 1).
  it('returns null when there is no command', () => {
    expect(parseRunArgs([])).toBeNull();
    expect(parseRunArgs(['--'])).toBeNull();
  });
});

describe('buildChildEnv', () => {
  it('injects the OTLP endpoint when the caller has not set one', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, 4318);
    expect(env[SESSION_OTEL_ENV_KEY]).toBe('http://localhost:4318');
    expect(env.PATH).toBe('/usr/bin'); // parent env preserved
  });
  it('honors a non-default port', () => {
    const env = buildChildEnv({}, 9999);
    expect(env[SESSION_OTEL_ENV_KEY]).toBe('http://localhost:9999');
  });
  // NEGATIVE CONTROL: an explicit endpoint the caller set is NEVER overridden.
  it('does not override an endpoint the caller already set', () => {
    const env = buildChildEnv({ [SESSION_OTEL_ENV_KEY]: 'http://collector:4318' }, 4318);
    expect(env[SESSION_OTEL_ENV_KEY]).toBe('http://collector:4318');
  });
});
