import { describe, it, expect, beforeEach, vi } from 'vitest';

// C3 end-to-end: a promise created on device A, shared via the E2E-encrypted
// link, imports byte-faithfully on device B's PromiseService. The relay/PE/
// corroboration deps are mocked (as in PromiseCloseout.test) so this isolates
// the create → encrypt-link → decrypt → import round trip.

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  publishCloseoutSignature: vi.fn(async () => ({ ok: true, mode: 'awaiting_counterparty' as const })),
  publishPromiseDisputed: vi.fn(async () => true),
  checkPromiseStatus: vi.fn(),
  getUid: vi.fn(() => 'uidMe'),
  subscribeToPromise: vi.fn(() => () => undefined),
}));

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

import PromiseService from './PromiseService';

const ME = '0xAlice';

describe('PromiseService — remote share-link import (C3)', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
  });

  it('round-trips a created promise through the share link to an identical record', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales',
      theyOwe: '50 pesos',
      who: 'Bob',
      direction: 'owed_to_me',
      dueDate: 1893456000000,
      creatorAddress: ME,
      creatorName: 'Alice',
    });

    const { universalUrl } = await PromiseService.buildShareLink(created);
    const url = new URL(universalUrl);
    const d = url.searchParams.get('d')!;
    const k = new URLSearchParams(url.hash.slice(1)).get('k')!;

    // Simulate device B: nothing stored locally.
    await PromiseService.deleteAllPromises();
    expect(await PromiseService.getPromise(created.id)).toBeNull();

    const imported = await PromiseService.importPromiseFromShareLink(d, k, '0xBob');
    expect(imported).not.toBeNull();

    // The terms survived the encrypt → link → decrypt → import round trip.
    expect(imported!.id).toBe(created.id);
    expect(imported!.theyGave).toBe('Tamales');
    expect(imported!.theyOwe).toBe('50 pesos');
    expect(imported!.dueDate).toBe(1893456000000);
    expect(imported!.creatorAddress).toBe(ME);
    expect(imported!.creatorSignature).toBe(created.creatorSignature);
    // Imported from the counterparty's perspective.
    expect(imported!.direction).toBe('owed_to_me');
    expect(imported!.status).toBe('pending');
  });

  it('rejects a tampered link (wrong key) — no import, fail closed', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Coffee', theyOwe: '20 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    const { universalUrl } = await PromiseService.buildShareLink(created);
    const d = new URL(universalUrl).searchParams.get('d')!;
    await PromiseService.deleteAllPromises();

    // A different (wrong) key must not decrypt.
    const wrong = await PromiseService.buildShareLink(created);
    const wrongK = new URLSearchParams(new URL(wrong.universalUrl).hash.slice(1)).get('k')!;

    await expect(PromiseService.importPromiseFromShareLink(d, wrongK, '0xBob')).rejects.toThrow();
    expect(await PromiseService.getPromise(created.id)).toBeNull();
  });
});
