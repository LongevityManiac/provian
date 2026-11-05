/**
 * WS4 — PE durability + atomic entity co-write (generatePE mechanism).
 *
 * Guards Security Invariant #5 (append-only, hash-chained, verifiable PEs) under
 * crash + failure conditions. These tests exercise the REAL generatePE + REAL
 * advanceChainTipAtomic against the in-memory fake Firestore (which now buffers
 * transaction writes and rolls them back on failure, matching real Firestore).
 *
 * What is locked down (PE METER, 2026-10-03 — the relay stores no readable PE):
 *  1. The act's transient intake (act record + accrual inputs + the PE sealed to
 *     its owner) is written INSIDE the chain-tip transaction, so the act is
 *     durable the moment generatePE resolves — even if pricing never runs
 *     (process crash). No false success; the chain tip never points at an act
 *     the relay cannot price.
 *  2. A deterministic replay never advances the chain twice: a staged act is
 *     priced on the retry, a priced act is left alone.
 *  3. atomicEntityWrite commits the entity in the SAME transaction as the
 *     intake + tip advance: both land, or — when the entity write throws —
 *     NEITHER lands and the chain tip does not advance (fail-closed rollback).
 */
import { describe, it, expect } from '@jest/globals';
import { generatePE, type GeneratePEParams } from './pe-utils';
import type { AgentBankDeps } from './types';
import { advanceChainTipAtomic } from '../../pe-chain-validator';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const PE_COLL = 'meter_relay_acts_v1';
const TIP = (agentId: string) => `pe_chain_tips/${agentId}`;
const PE = (peId: string) => `${PE_COLL}/${peId}`;

const baseParams: GeneratePEParams = {
  walletId: 'wallet_1',
  agentId: 'agent_x',
  actorAddress: '0xAGENT',
  actionType: 'escrow_created',
  metadata: { foo: 1 },
};

/**
 * deps whose accrual never seals through the meter (the stub never reports an outcome) — the act
 * stays staged, which is exactly the state a process that died before pricing leaves behind.
 */
function makeNonFlushingDeps(db: FakeFirestore) {
  const accrual: Array<Record<string, unknown>> = [];
  const deps = {
    db,
    cache: {},
    peBuffer: { enqueue: () => { throw new Error('a readable PE was enqueued'); } },
    recordPEAccrual: async (p: Record<string, unknown>) => { accrual.push(p); },
  } as unknown as AgentBankDeps;
  return { deps, accrual };
}

function peDocsIn(db: FakeFirestore): string[] {
  return [...db.store.keys()].filter((k) => k.startsWith(`${PE_COLL}/`));
}

describe('WS4 generatePE — PE durability (no false success / recoverable)', () => {
  it('stages the act durably in the txn even when pricing never completes', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);

    const res = await generatePE(deps, { ...baseParams });

    // The act IS durable: its intake was committed inside the chain-tip transaction.
    const intake = db.store.get(PE(res.peId));
    expect(intake).toBeDefined();
    expect((intake!.act as Record<string, unknown>).pe_hash).toBe(res.peHash);
    expect((intake!.act as Record<string, unknown>).prev_hash).toBe('0x0000');

    // The chain tip points at exactly this act's hash, and no readable envelope exists.
    const tip = db.store.get(TIP(baseParams.agentId));
    expect(tip!.hash).toBe(res.peHash);
    expect([...db.store.keys()].some((k) => k.startsWith('provenance_envelopes/'))).toBe(false);
  });

  it('a pricing failure on a best-effort emitter leaves the intake for the replay sweep', async () => {
    const db = createFakeFirestore();
    const deps = {
      db,
      cache: {},
      peBuffer: { enqueue: () => {} },
      recordPEAccrual: async () => { throw new Error('pricing down'); },
    } as unknown as AgentBankDeps;

    const res = await generatePE(deps, { ...baseParams });
    await new Promise((r) => setImmediate(r));

    expect(db.store.get(PE(res.peId))).toBeDefined();
    expect(db.store.get(`pe_accrual_failures/${res.peId}`)).toBeDefined();
  });

  it('replays a deterministic PE after a post-write crash without advancing the chain twice', async () => {
    const db = createFakeFirestore();
    const { deps, accrual } = makeNonFlushingDeps(db);
    const params: GeneratePEParams = {
      ...baseParams,
      peIdOverride: 'pe_watcher_event_1',
      timestampOverride: 1234,
      awaitAccrual: true,
    };

    const first = await generatePE(deps, params);
    const firstTip = db.store.get(TIP(baseParams.agentId));
    const second = await generatePE(deps, params);

    expect(second).toEqual(first);
    expect(db.store.get(TIP(baseParams.agentId))).toEqual(firstTip);
    expect(peDocsIn(db)).toEqual([PE('pe_watcher_event_1')]);
    // A still-staged act is priced on the retry: pricing is idempotent on the act key and this is
    // how a crash after durability but before economic acknowledgement heals.
    expect(accrual).toHaveLength(2);
  });

  it('a deterministic replay of an act already priced neither advances the chain nor prices again', async () => {
    const db = createFakeFirestore();
    const { deps, accrual } = makeNonFlushingDeps(db);
    const params: GeneratePEParams = {
      ...baseParams,
      peIdOverride: 'pe_watcher_event_2',
      timestampOverride: 1234,
      awaitAccrual: true,
    };
    const first = await generatePE(deps, params);
    // Simulate the meter commit: the act key replaces the intake.
    const act = db.store.get(PE('pe_watcher_event_2'))!.act as Record<string, unknown>;
    db.store.delete(PE('pe_watcher_event_2'));
    db.store.set('meter_act_keys_v1/pe_watcher_event_2', {
      actor_id: baseParams.agentId, timestamp: act.timestamp, prev_hash: act.prev_hash, pe_hash: act.pe_hash,
    });
    const firstTip = db.store.get(TIP(baseParams.agentId));

    const second = await generatePE(deps, params);

    expect(second).toEqual(first);
    expect(db.store.get(TIP(baseParams.agentId))).toEqual(firstTip);
    expect(accrual).toHaveLength(1);
    expect(peDocsIn(db)).toEqual([]);
  });

  it('rejects reuse of a deterministic PE id for different canonical content', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);
    await generatePE(deps, {
      ...baseParams,
      peIdOverride: 'pe_watcher_collision',
      timestampOverride: 1234,
    });
    await expect(generatePE(deps, {
      ...baseParams,
      actionType: 'send',
      peIdOverride: 'pe_watcher_collision',
      timestampOverride: 1234,
    })).rejects.toThrow('deterministic_pe_id_collision');
  });
});

describe('PE meter — a speech act under a pass records its pass + entity ids (no stored PE)', () => {
  it('stages speech_window_acts_v1 in the tip transaction; RED: an act with no pass writes none', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);
    const burnId = 'b'.repeat(64);
    const res = await generatePE(deps, {
      ...baseParams,
      actionType: 'commons_post_created',
      metadata: { post_id: 'post_1', content_hash: 'x'.repeat(64) },
      speechWindow: { burnId, burnAmountAtomic: '15' },
    });
    const rec = db.store.get(`speech_window_acts_v1/${res.peId}`);
    expect(rec).toMatchObject({
      pe_id: res.peId, burn_id: burnId, action_type: 'commons_post_created',
      refs: { post_id: 'post_1', want_id: null, job_id: null, vote_id: null },
    });
    // Identifiers only: never the act's content.
    expect(JSON.stringify(rec)).not.toContain('content_hash');

    const plain = await generatePE(deps, { ...baseParams });
    expect(db.store.has(`speech_window_acts_v1/${plain.peId}`)).toBe(false);
  });
});

describe('WS4 generatePE — PE + entity atomicity (both land or neither)', () => {
  it('commits the entity in the SAME transaction as the PE (both land)', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);
    const entityRef = db.collection('test_entities').doc('ent_1');

    const res = await generatePE(deps, {
      ...baseParams,
      atomicEntityWrite: (txn, peId) => {
        txn.set(entityRef as never, { id: 'ent_1', pe_id: peId });
      },
    });

    const peDoc = db.store.get(PE(res.peId));
    const entity = db.store.get('test_entities/ent_1');
    expect(peDoc).toBeDefined();
    expect(entity).toBeDefined();
    // The entity references the exact PE that was committed alongside it.
    expect(entity!.pe_id).toBe(res.peId);
  });

  it('rolls BOTH back when the entity write throws (neither lands; tip not advanced)', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);

    await expect(
      generatePE(deps, {
        ...baseParams,
        atomicEntityWrite: () => { throw new Error('entity write failed'); },
      }),
    ).rejects.toThrow('entity write failed');

    // No intake, no chain-tip advance.
    expect(peDocsIn(db)).toHaveLength(0);
    expect(db.store.get(TIP(baseParams.agentId))).toBeUndefined();
  });

  it('rolls the entity back when the PE write itself fails (other direction)', async () => {
    // Force the PE-document write inside the txn to fail.
    const db = createFakeFirestore({ failTxnWriteTo: PE_COLL });
    const { deps } = makeNonFlushingDeps(db);
    const entityRef = db.collection('test_entities').doc('ent_2');

    await expect(
      generatePE(deps, {
        ...baseParams,
        atomicEntityWrite: (txn, peId) => {
          txn.set(entityRef as never, { id: 'ent_2', pe_id: peId });
        },
      }),
    ).rejects.toThrow(/Injected transaction write failure/);

    expect(peDocsIn(db)).toHaveLength(0);
    expect(db.store.get('test_entities/ent_2')).toBeUndefined();
    expect(db.store.get(TIP(baseParams.agentId))).toBeUndefined();
  });

  it('a rolled-back attempt leaves the chain pristine: the next PE still links to genesis', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);

    await expect(
      generatePE(deps, {
        ...baseParams,
        atomicEntityWrite: () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');

    // The failed attempt did NOT advance the tip, so the next PE is still the
    // genesis-linked head of the chain (no phantom prev_hash gap).
    const res2 = await generatePE(deps, { ...baseParams });
    expect(res2.prevHash).toBe('0x0000');
    expect(db.store.get(TIP(baseParams.agentId))!.hash).toBe(res2.peHash);
    expect((db.store.get(PE(res2.peId))!.act as Record<string, unknown>).prev_hash).toBe('0x0000');
  });
});

describe('WS4 generatePE — async co-write is rejected fail-closed', () => {
  it('throws (and commits nothing) when atomicEntityWrite is async', async () => {
    const db = createFakeFirestore();
    const { deps } = makeNonFlushingDeps(db);

    await expect(
      generatePE(deps, {
        ...baseParams,
        // TypeScript's void-return rule ALLOWS this async fn to satisfy the
        // `=> void` param (the footgun). The runtime guard must reject it,
        // because an awaited write would escape the transaction.
        atomicEntityWrite: async () => { /* mistakenly async */ },
      }),
    ).rejects.toThrow(/must be synchronous/);

    expect(peDocsIn(db)).toHaveLength(0);
    expect(db.store.get(TIP(baseParams.agentId))).toBeUndefined();
  });

  it('advanceChainTipAtomic rejects an async coWrites directly', async () => {
    const db = createFakeFirestore();
    await expect(
      advanceChainTipAtomic(
        db as never,
        'agent_y',
        () => 'hash_y',
        undefined,
        // async coWrites — must be rejected before commit.
        (async () => { /* mistakenly async */ }) as never,
      ),
    ).rejects.toThrow(/must be synchronous/);
    // The tip did not advance.
    expect(db.store.get(TIP('agent_y'))).toBeUndefined();
  });
});

describe('WS4 generatePE — co-writes are pure on transaction retry', () => {
  it('a contention retry chains off the COMMITTED tip, not the first (discarded) attempt', async () => {
    const COMPETING_HASH = 'competing_tip_hash_deadbeef';
    const db = createFakeFirestore({
      retryFirstTxn: {
        beforeRetry: (store) => {
          // A competing writer advanced the chain tip between the discarded first
          // attempt and the committed retry.
          store.set(TIP(baseParams.agentId), { hash: COMPETING_HASH, user_id: baseParams.agentId });
        },
      },
    });
    const { deps } = makeNonFlushingDeps(db);
    const entityRef = db.collection('test_entities').doc('ent_retry');

    const res = await generatePE(deps, {
      ...baseParams,
      atomicEntityWrite: (txn, peId) => {
        txn.set(entityRef as never, { id: 'ent_retry', pe_id: peId });
      },
    });

    // The committed PE chained off the COMPETING tip (the retry's read), not
    // genesis (the discarded attempt's read) — coWrites rebuilt from live ctx.
    const peDoc = db.store.get(PE(res.peId))!.act as Record<string, unknown>;
    expect(res.prevHash).toBe(COMPETING_HASH);
    expect(peDoc.prev_hash).toBe(COMPETING_HASH);
    expect(peDoc.pe_hash).toBe(res.peHash);
    // The advanced tip equals the committed PE hash; the discarded attempt left
    // nothing extra (exactly one PE doc, one entity).
    expect(db.store.get(TIP(baseParams.agentId))!.hash).toBe(res.peHash);
    expect(peDocsIn(db)).toHaveLength(1);
    expect(db.store.get('test_entities/ent_retry')!.pe_id).toBe(res.peId);
  });
});
