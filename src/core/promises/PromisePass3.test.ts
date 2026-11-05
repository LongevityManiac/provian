import { describe, it, expect, beforeEach, vi } from 'vitest';

// Pass-3 (failure-path) fixes on the mobile Promise/QR surface. The relay / PE /
// corroboration deps are mocked (same pattern as PromiseCloseout.test) so these
// isolate PromiseService's parse / import / accept / reconcile logic.
//
// Findings covered:
//   #36  parseQRPayload accepts a non-string creatorAddress → .slice() crash
//   #14  a non-numeric dueDate/timestamp persists → format(new Date(bad)) crash
//   #46  validateTextField no-ops on a non-string creatorName → bypass + bloat
//   #34  acceptPromiseOffline double-signs on re-tap (no idempotency guard)
//   #29  rejecting a relay-delivered promise never leaves the creator on 'pending'

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  tryPublishAcceptance: vi.fn(async () => 'published'),
  publishCloseoutSignature: vi.fn(async () => ({ ok: true, mode: 'awaiting_counterparty' as const })),
  publishPromiseDisputed: vi.fn(async () => true),
  publishPromiseRejected: vi.fn(async () => true),
  checkPromiseStatus: vi.fn(async () => null as unknown),
  getUid: vi.fn(() => 'uidMe'),
  markRelayBacked: vi.fn(async () => undefined),
  subscribeToPromise: vi.fn(() => () => undefined),
}));

// The detailed read derives from the plain one, as the service's own does (2026-10-17).
Object.assign(relay, {
  checkPromiseStatusDetailed: vi.fn(async (...args: unknown[]) => {
    const doc = await (relay.checkPromiseStatus as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    return doc ? { kind: 'found', doc } : { kind: 'unavailable' };
  }),
  publishPromiseBroken: vi.fn(async () => true),
});
vi.mock('./PromiseRelayService', () => ({ promiseRelayService: relay }));
vi.mock('./promiseSigning', () => ({
  computePromiseDigest: vi.fn(async () => 'd'.repeat(64)),
  signHumanPromisePhase: vi.fn(async (phase: string) => `sig:${phase}`),
}));
vi.mock('./PromiseTermsVault', () => ({
  encryptTermsToSelf: vi.fn(async () => 'ciphertext'),
  decryptTermsFromSelf: vi.fn(async () => null),
  clearPromiseTermsKey: vi.fn(),
}));
vi.mock('../provenance/ProvenanceEnvelopeManager', () => ({
  default: {
    createEnvelope: vi.fn(async () => ({ envelope_id: 'pe1' })),
    getEnvelopeHashById: vi.fn(async () => null),
  },
}));
vi.mock('../provenance/CorroborationManager', () => ({
  default: { emitCorroboration: vi.fn(async () => undefined) },
}));
vi.mock('../recovery/cloud/CloudBackupV2', () => ({ hasCloudBackup: () => false }));

import PromiseService, { PromiseQRPayload } from './PromiseService';

const ME = '0xME';
const BOB = '0xBOB';

/** A well-formed v2 QR payload; `over` mutates individual fields per test. */
function qr(over: Record<string, unknown>): PromiseQRPayload {
  return {
    version: 2,
    promiseId: 'p-default',
    theyGave: 'Tamales',
    theyOwe: '50 pesos',
    who: 'Bob',
    creatorAddress: '0xCREATOR',
    creatorName: 'Alice',
    creatorSignature: 'sig',
    timestamp: 1700000000000,
    ...over,
  } as unknown as PromiseQRPayload;
}

describe('PromiseService — Pass-3 input validation', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
  });

  // ── #36 parseQRPayload typeof guard ──────────────────────────────────────
  it('#36 parseQRPayload rejects a non-string creatorAddress (would crash .slice)', () => {
    const bad = JSON.stringify({
      version: 2, promiseId: 'p1', creatorAddress: 12345,
      theyGave: 'a', theyOwe: 'b', creatorSignature: 's', timestamp: 1,
    });
    expect(PromiseService.parseQRPayload(bad)).toBeNull();
  });

  it('#36 parseQRPayload rejects an empty/missing promiseId', () => {
    const bad = JSON.stringify({
      version: 2, promiseId: '', creatorAddress: '0xabc',
      theyGave: 'a', theyOwe: 'b', creatorSignature: 's', timestamp: 1,
    });
    expect(PromiseService.parseQRPayload(bad)).toBeNull();
  });

  it('#36 parseQRPayload still accepts a valid v2 payload', () => {
    const good = JSON.stringify({
      version: 2, promiseId: 'p1', creatorAddress: '0xabc',
      theyGave: 'a', theyOwe: 'b', creatorSignature: 's', timestamp: 1,
    });
    const parsed = PromiseService.parseQRPayload(good);
    expect(parsed).not.toBeNull();
    expect(parsed!.creatorAddress).toBe('0xabc');
  });

  // ── #14 non-numeric date fields ──────────────────────────────────────────
  it('#14 parseQRPayload rejects a non-numeric dueDate', () => {
    const bad = JSON.stringify({
      version: 2, promiseId: 'p1', creatorAddress: '0xabc',
      theyGave: 'a', theyOwe: 'b', creatorSignature: 's', timestamp: 1, dueDate: 'soon',
    });
    expect(PromiseService.parseQRPayload(bad)).toBeNull();
  });

  it('#14 importPromiseFromQR rejects a non-numeric timestamp and persists NOTHING', async () => {
    const r = await PromiseService.importPromiseFromQR(qr({ promiseId: 'pbad', timestamp: 'oops' }), BOB);
    expect(r).toBeNull();
    expect(await PromiseService.getPromise('pbad')).toBeNull();
  });

  it('#14 importPromiseFromQR rejects a non-numeric dueDate', async () => {
    const r = await PromiseService.importPromiseFromQR(qr({ promiseId: 'pbad2', dueDate: 'whenever' }), BOB);
    expect(r).toBeNull();
    expect(await PromiseService.getPromise('pbad2')).toBeNull();
  });

  it('#14 importPromiseFromQR accepts a valid numeric dueDate', async () => {
    const r = await PromiseService.importPromiseFromQR(qr({ promiseId: 'pok', dueDate: 1893456000000 }), BOB);
    expect(r).not.toBeNull();
    expect(r!.dueDate).toBe(1893456000000);
    expect(r!.createdAt).toBe(1700000000000);
  });

  // ── #46 validateTextField type-check ─────────────────────────────────────
  it('#46 importPromiseFromQR throws on a non-string creatorName (no [object Object] bloat)', async () => {
    const bad = qr({ promiseId: 'pcn', creatorName: { nested: 'x' } });
    await expect(PromiseService.importPromiseFromQR(bad, BOB)).rejects.toThrow();
    // The bad record must NOT have persisted.
    expect(await PromiseService.getPromise('pcn')).toBeNull();
  });

  // ── #34 acceptPromiseOffline idempotency ─────────────────────────────────
  it('#34 acceptPromiseOffline is idempotent — a re-tap does NOT double-sign', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });

    const r1 = await PromiseService.acceptPromiseOffline(created.id, BOB, 'Bob');
    expect(r1).not.toBeNull();
    expect(r1!.promise.status).toBe('accepted');
    expect(r1!.promise.events.filter((e) => e.type === 'accepted')).toHaveLength(1);

    // Interruption + re-tap: the second call must not append a SECOND 'accepted'
    // event or re-sign over a fresh acceptedAt.
    const r2 = await PromiseService.acceptPromiseOffline(created.id, BOB, 'Bob');
    expect(r2).not.toBeNull();
    expect(r2!.promise.events.filter((e) => e.type === 'accepted')).toHaveLength(1);
    expect(r2!.signature).toBe(r1!.signature);
  });
});

// ── #29 creator-side reconcile of a relay 'rejected' status ────────────────
describe('PromiseService — Pass-3 #29 reject reconcile', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
  });

  it('leaves a pending creator promise as rejected when the relay reports rejected', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    expect(created.status).toBe('pending');

    relay.checkPromiseStatus.mockResolvedValue({
      promiseId: created.id,
      creatorUid: 'uidMe',
      creatorDeviceId: 'dev',
      signatures: { uidMe: { role: 'creator', signature: 'termsA', at: 1 } },
      closeout: {},
      status: 'rejected',
      createdAt: 1,
      updatedAt: 99,
      expiresAt: 3,
    });

    const synced = await PromiseService.syncPendingPromises();
    expect(synced).toBe(1);

    const after = await PromiseService.getPromise(created.id);
    expect(after!.status).toBe('rejected');
    expect(after!.events.some((e) => e.type === 'negotiation_rejected')).toBe(true);
  });
});
