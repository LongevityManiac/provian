/**
 * Tests for ProvianObserver.finalizeSession() output gate.
 *
 * Validates that a session producing no observable output attaches
 * null_state_flags: ['no_observable_output'] to its PE metadata, and that
 * any positive output signal suppresses the flag. The PE is always emitted
 * for chain integrity - the flag just informs the relay that minting should
 * be skipped.
 *
 * PE meter: the observer's client records each PE in this device's PE store
 * (no network), so the suite injects a capturing store and reads exactly the
 * PE the client recorded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProvianObserver } from './ProvianObserver';
import type { SessionState } from './types';
import type { ProvianCredentials } from '../scripts/credentials';
import { CapturingPeStore } from '../meter/capturing-store.test-support';

// Describe-level wrapper around the private finalizeSession. We invoke it via
// onSessionEnded, which is the only public entry point the observer exposes.
async function runFinalize(state: SessionState): Promise<Record<string, unknown>> {
  const creds: ProvianCredentials = {
    deviceKey: 'pdk_test',
    deviceSecret: 'pds_test',
    relayUrl: 'https://relay.test',
  };
  const store = new CapturingPeStore();
  const observer = new ProvianObserver({
    idleThresholdMs: 30_000,
    maxSessionMs: 15 * 60 * 1000,
    tickIntervalMs: 1000,
    plugins: [],
    relayUrl: 'https://relay.test',
    credentials: creds,
    logLevel: 'error',
    peStore: store,
  });

  await observer.onSessionEnded(state, 'idle');

  if (store.bodies.length !== 1) throw new Error(`expected one recorded PE, got ${store.bodies.length}`);
  return store.bodies[0];
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  const now = Date.now();
  return {
    active: false,
    startedAt: now - 60_000,
    lastActivityAt: now,
    accumulatedCpu: 0,
    peakMemoryMb: 0,
    networkCalls: 0,
    tokensProcessed: 0,
    pluginArtifacts: new Map(),
    inference: null,
    lineage: null,
    ...overrides,
  };
}

function getMeta(body: Record<string, unknown>): Record<string, unknown> {
  return body.metadata as Record<string, unknown>;
}

describe('ProvianObserver.finalizeSession output gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches no_observable_output when no signals are present', async () => {
    const body = await runFinalize(baseState());
    expect(body.action_type).toBe('compute_session');
    expect(getMeta(body).null_state_flags).toEqual(['no_observable_output']);
  });

  it('does NOT attach the flag when pluginArtifacts is non-empty (structured artifact)', async () => {
    const artifacts = new Map<string, Record<string, unknown>>();
    artifacts.set('GitPlugin', { commit: 'abc123' });
    const body = await runFinalize(baseState({ pluginArtifacts: artifacts }));
    expect(body.action_type).toBe('compute_session');
    expect(getMeta(body).null_state_flags).toBeUndefined();
  });

  it('DOES attach the flag for sustained CPU with no structured artifact (CPU is not a mint signal)', async () => {
    // Narrow-tier teardown: raw/sustained CPU no longer gates or weights
    // minting. A busy session that produced no recognized artifact (e.g.
    // watching video, a videoconference, a game) records for chain
    // integrity but does not mint.
    const body = await runFinalize(baseState({ accumulatedCpu: 31 }));
    expect(body.action_type).toBe('compute_session');
    expect(getMeta(body).null_state_flags).toEqual(['no_observable_output']);
  });

  it('does NOT attach the flag when networkCalls > 0 AND a structured artifact is present', async () => {
    const artifacts = new Map<string, Record<string, unknown>>();
    artifacts.set('GitPlugin', { commit: 'def456' });
    const body = await runFinalize(baseState({ networkCalls: 5, pluginArtifacts: artifacts }));
    expect(getMeta(body).null_state_flags).toBeUndefined();
  });

  it('DOES attach the flag when only networkCalls are present (network alone is chatter)', async () => {
    const body = await runFinalize(baseState({ networkCalls: 100 }));
    expect(body.action_type).toBe('compute_session');
    expect(getMeta(body).null_state_flags).toEqual(['no_observable_output']);
  });

  it('flips to inference_session and omits the flag when tokensProcessed > 0', async () => {
    const body = await runFinalize(baseState({ tokensProcessed: 1500 }));
    expect(body.action_type).toBe('inference_session');
    expect(getMeta(body).null_state_flags).toBeUndefined();
  });

  it('never attaches the flag to inference_session even with no other output', async () => {
    // Pure inference with no files / no plugin artifacts / no CPU accounting.
    const body = await runFinalize(baseState({ tokensProcessed: 500 }));
    expect(body.action_type).toBe('inference_session');
    expect(getMeta(body).null_state_flags).toBeUndefined();
  });
});
