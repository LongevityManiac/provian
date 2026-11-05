import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  CHAIN_RECORD_RUN_LEASE_COLLECTION,
  CHAIN_RECORD_RUN_LEASE_DOCUMENT,
  CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT,
  CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT,
  CHAIN_RECORD_AUXILIARY_CUTOVER_DOCUMENT,
  CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION,
  CHAIN_RECORD_DISCOVERY_CUTOVER_DOCUMENT,
  acquireChainRecordRunLease,
  releaseChainRecordRunLease,
  finishChainRecordRun,
  CHAIN_RECORD_RUN_LEASE_TTL_MS,
} from './chain-record-run-lease';
import { SCHEDULED_REQUEST_DEADLINE_MS } from '../../instance-health';
import { readFileSync } from 'fs';
import path from 'path';

const TTL = CHAIN_RECORD_RUN_LEASE_TTL_MS;

describe('chain-record single-run lease', () => {
  let db: FakeFirestore;
  const fs = () => db as unknown as Firestore;
  const lease = () => db.store.get(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_RUN_LEASE_DOCUMENT}`) as
    { owner: string; expires_at_ms: number } | undefined;
  const activateDiscovery = () => db.store.set(`${CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION}/${CHAIN_RECORD_DISCOVERY_CUTOVER_DOCUMENT}`,
    { schema_version: 'chain-record-discovery-cutover/v1', active: true, not_before_ms: 0, activated_at_ms: 0, proof_sha256: 'a'.repeat(64) });

  beforeEach(() => { db = createFakeFirestore(); });

  it('covers the handler deadline with the platform margin, without the retired hour-long hold', () => {
    const deploy = readFileSync(path.resolve(__dirname, '../../../deploy-env.sh'), 'utf8');
    const timeout = deploy.match(/^\s+--timeout=(\d+)\s*$/m);
    if (!timeout) throw new Error('deploy_service_timeout_missing');
    expect(TTL).toBe(SCHEDULED_REQUEST_DEADLINE_MS + 60_000);
    expect(TTL).toBe(Number(timeout[1]) * 1000);
    expect(TTL).toBeLessThan(60 * 60 * 1000);
  });

  it('does not make the response available until the real lease release completes', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    let finishRelease!: () => void;
    const blocked = new Promise<void>((resolve) => { finishRelease = resolve; });
    let responded = false;
    let releasing = false;
    const result = finishChainRecordRun(async () => ({ processed: 1 }), async () => {
      releasing = true;
      await blocked;
      await releaseChainRecordRunLease(fs(), { workerId: 'a', nowMs: 2_000 });
    }).then((body) => { responded = true; return body; });
    await Promise.resolve();
    await Promise.resolve();
    expect(releasing).toBe(true); // The negative control actually reached cleanup.
    expect(responded).toBe(false);
    expect(lease()?.expires_at_ms).toBe(1_000 + TTL);
    finishRelease();
    expect(await result).toEqual({ processed: 1 });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 2_001, leaseTtlMs: TTL })).toBe(true);
  });

  it('releases failed work before the caller can handle its error', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    await expect(finishChainRecordRun(async () => { throw new Error('work_failed'); },
      () => releaseChainRecordRunLease(fs(), { workerId: 'a', nowMs: 2_000 }))).rejects.toThrow('work_failed');
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 2_001, leaseTtlMs: TTL })).toBe(true);
  });

  it('a failed release cannot be reported as a successful request', async () => {
    await expect(finishChainRecordRun(async () => ({ processed: 1 }),
      async () => { throw new Error('release_failed'); })).rejects.toThrow('release_failed');
  });

  it('the first run takes the lease', async () => {
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL })).toBe(true);
    expect(lease()).toMatchObject({ owner: 'a', expires_at_ms: 1_000 + TTL });
  });

  it('NEGATIVE CONTROL: a second run while the first still holds a live lease is refused', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 1_000 + 13 * 60_000, leaseTtlMs: TTL })).toBe(false);
    expect(lease()?.owner).toBe('a');
  });

  it('an expired lease (the holder crashed) is taken over', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 1_000 + TTL + 1, leaseTtlMs: TTL })).toBe(true);
    expect(lease()?.owner).toBe('b');
  });

  it('a released lease lets the next run in at once', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    await releaseChainRecordRunLease(fs(), { workerId: 'a', nowMs: 2_000 });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 2_001, leaseTtlMs: TTL })).toBe(true);
  });

  it('RED: a run whose lease was taken over after expiry cannot release the new holder', async () => {
    await acquireChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000, leaseTtlMs: TTL });
    await acquireChainRecordRunLease(fs(), { workerId: 'b', nowMs: 1_000 + TTL + 1, leaseTtlMs: TTL });
    await releaseChainRecordRunLease(fs(), { workerId: 'a', nowMs: 1_000 + TTL + 2 });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'c', nowMs: 1_000 + TTL + 3, leaseTtlMs: TTL })).toBe(false);
    expect(lease()?.owner).toBe('b');
  });
  it('discovery continues on successive five-minute ticks while the independent drain is still running', async () => {
    activateDiscovery();
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'drain', nowMs: 1_000, leaseTtlMs: TTL, workload: 'drain' })).toBe(true);
    for (const nowMs of [1_001, 301_001, 601_001]) {
      const params = { workerId: `discovery_${nowMs}`, nowMs, leaseTtlMs: TTL, workload: 'discovery' as const };
      expect(await acquireChainRecordRunLease(fs(), params)).toBe(true);
      // A concurrent discovery still cannot scan the same range.
      expect(await acquireChainRecordRunLease(fs(), { ...params, workerId: 'competitor' })).toBe(false);
      await releaseChainRecordRunLease(fs(), { ...params, nowMs: nowMs + 273_000 });
    }
    expect(lease()?.owner).toBe('drain');
    expect(lease()?.expires_at_ms).toBe(1_000 + TTL);
  });
  it('discovery honors an older combined run until release/expiry and cannot release its owner', async () => {
    activateDiscovery();
    await acquireChainRecordRunLease(fs(), { workerId: 'legacy', nowMs: 1_000, leaseTtlMs: TTL });
    const params = { workerId: 'discovery', nowMs: 2_000, leaseTtlMs: TTL, workload: 'discovery' as const };
    expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
    expect(db.store.has(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT}`)).toBe(false);
    await releaseChainRecordRunLease(fs(), params);
    expect(lease()?.expires_at_ms).toBe(1_000 + TTL);
    expect(await acquireChainRecordRunLease(fs(), { ...params, nowMs: 1_001 + TTL })).toBe(true);
    // Stale discovery cleanup cannot release its replacement.
    expect(await acquireChainRecordRunLease(fs(), { ...params, workerId: 'new', nowMs: 1_002 + 2 * TTL })).toBe(true);
    await releaseChainRecordRunLease(fs(), { ...params, nowMs: 1_003 + 2 * TTL });
    expect(await acquireChainRecordRunLease(fs(), { ...params, nowMs: 1_004 + 2 * TTL })).toBe(false);
  });
  it('missing, paused, premature and unproven cutovers cannot acquire discovery', async () => {
    const params = { workerId: 'new', nowMs: 10_000, leaseTtlMs: TTL, workload: 'discovery' as const };
    expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
    for (const invalid of [{ active: false }, { not_before_ms: 20_000 }, { activated_at_ms: 20_000 },
      { activated_at_ms: -1 }, { proof_sha256: '' }, { not_before_ms: NaN }]) {
      activateDiscovery();
      const key = `${CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION}/${CHAIN_RECORD_DISCOVERY_CUTOVER_DOCUMENT}`;
      db.store.set(key, { ...db.store.get(key), ...invalid });
      expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
      expect(db.store.has(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT}`)).toBe(false);
    }
    activateDiscovery();
    db.store.set(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_RUN_LEASE_DOCUMENT}`, { owner: 'unknown' });
    expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
    db.store.delete(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_RUN_LEASE_DOCUMENT}`);
    activateDiscovery(); expect(await acquireChainRecordRunLease(fs(), params)).toBe(true);
  });
  it('auxiliary work stays held until a proved old-request drain cutover', async () => {
    const params = { workerId: 'aux', nowMs: 10_000, leaseTtlMs: TTL, workload: 'auxiliary' as const };
    const key = `${CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION}/${CHAIN_RECORD_AUXILIARY_CUTOVER_DOCUMENT}`;
    const valid = { schema_version: 'chain-record-auxiliary-cutover/v1', active: true,
      not_before_ms: 1_000, activated_at_ms: 2_000, proof_sha256: 'b'.repeat(64) };
    expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
    for (const bad of [{ active: false }, { not_before_ms: 20_000 }, { activated_at_ms: 20_000 },
      { activated_at_ms: 0 }, { proof_sha256: '' }, { not_before_ms: NaN }]) {
      db.store.set(key, { ...valid, ...bad });
      expect(await acquireChainRecordRunLease(fs(), params)).toBe(false);
      expect(db.store.has(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT}`)).toBe(false);
    }
    db.store.set(key, valid); expect(await acquireChainRecordRunLease(fs(), params)).toBe(true);
    expect(await acquireChainRecordRunLease(fs(), { ...params, workerId: 'competitor' })).toBe(false);
    await releaseChainRecordRunLease(fs(), { ...params, nowMs: 11_000 });
    expect(await acquireChainRecordRunLease(fs(), { ...params, workerId: 'new', nowMs: 11_001 })).toBe(true);
    await releaseChainRecordRunLease(fs(), { ...params, nowMs: 11_002 });
    expect(await acquireChainRecordRunLease(fs(), { ...params, workerId: 'competitor', nowMs: 11_003 })).toBe(false);
  });
  it('a long auxiliary run cannot consume Base drain or discovery cadence', async () => {
    activateDiscovery();
    db.store.set(`${CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION}/${CHAIN_RECORD_AUXILIARY_CUTOVER_DOCUMENT}`,
      { schema_version: 'chain-record-auxiliary-cutover/v1', active: true, not_before_ms: 0, activated_at_ms: 0, proof_sha256: 'b'.repeat(64) });
    expect(await acquireChainRecordRunLease(fs(), { workerId: 'aux', nowMs: 1_000, leaseTtlMs: TTL, workload: 'auxiliary' })).toBe(true);
    for (const nowMs of [1_001, 301_001, 601_001]) {
      for (const workload of ['drain', 'discovery'] as const) {
        const params = { workerId: workload, nowMs, leaseTtlMs: TTL, workload };
        expect(await acquireChainRecordRunLease(fs(), params)).toBe(true);
        await releaseChainRecordRunLease(fs(), { ...params, nowMs: nowMs + 240_000 });
      }
    }
    expect(db.store.get(`${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT}`)?.owner).toBe('aux');
    const server = readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
    const baseRoute = server.split("app.post('/v1/internal/scheduler/chain-record',")[1].split("app.post('/v1/internal/scheduler/chain-record-auxiliary',")[0];
    expect(baseRoute).toContain('runChainRecordWatcherCycle');
    expect(baseRoute).not.toMatch(/runChainRecordProvenOutboundScan|runChainRecordMultichainScan|runSolanaChainRecordCycle/);
  });

  it('never replaces an unknown or malformed own lease', async () => {
    const key = `${CHAIN_RECORD_RUN_LEASE_COLLECTION}/${CHAIN_RECORD_RUN_LEASE_DOCUMENT}`;
    for (const malformed of [{ owner: 'unknown' }, { schema_version: 'chain-record-run-lease/v1', owner: 'old', expires_at_ms: NaN }]) {
      db.store.set(key, malformed);
      expect(await acquireChainRecordRunLease(fs(), { workerId: 'new', nowMs: 10_000, leaseTtlMs: TTL })).toBe(false);
      expect(db.store.get(key)).toEqual(malformed);
    }
  });

});
