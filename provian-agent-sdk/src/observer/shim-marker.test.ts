/**
 * review r2 #1 — the wrapper's `PROVIAN_VIA_SHIM` marker describes the command the agent
 * typed; it must never reach a daemon a verb spawns (`configure` / `repair` restart the observer).
 * A daemon that inherited it read itself as a second `observe` request, found its own pid
 * "running", logged "is running" and exited — no daemon, a pidfile naming a dead pid.
 */
import { describe, expect, it } from 'vitest';
import { takeShimMarker, SHIM_ENV } from '../provian-shim';
import { detachedChildEnv } from './service';

describe('the wrapper marker never reaches a spawned daemon', () => {
  it('takeShimMarker reads the marker once and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [SHIM_ENV]: '1', KEEP: 'x' };
    expect(takeShimMarker(env)).toBe(true);
    expect(env[SHIM_ENV]).toBeUndefined();
    expect(env.KEEP).toBe('x');
    expect(takeShimMarker(env)).toBe(false); // gone: a second read (or a child) sees nothing
    expect(takeShimMarker({ [SHIM_ENV]: '0' })).toBe(false);
  });

  it('a detached daemon is spawned without the marker, even if the parent still carries it', () => {
    const parent: NodeJS.ProcessEnv = { [SHIM_ENV]: '1', PATH: '/usr/bin' };
    const child = detachedChildEnv(parent, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, 'detached');
    expect(child[SHIM_ENV]).toBeUndefined();
    expect(child.PATH).toBe('/usr/bin');
    expect(child.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
    expect(child.PROVIAN_SUPERVISOR).toBe('detached');
    expect(parent[SHIM_ENV]).toBe('1'); // the parent's own env is not mutated
    // An explicit env entry cannot smuggle it back in either.
    expect(detachedChildEnv({}, { [SHIM_ENV]: '1' }, 'cron')[SHIM_ENV]).toBeUndefined();
  });
});
