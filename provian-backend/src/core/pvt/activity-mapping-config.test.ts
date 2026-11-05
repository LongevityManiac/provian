/**
 * Independent kill switch for the permanent activity-mapping layer.
 * Proves it is separate from Genesis and defaults ON.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { isActivityMappingEnabled, isActivityMappingForcedOff } from './activity-mapping-config';

describe('activity-mapping kill switch', () => {
  const OLD = process.env.ACTIVITY_MAPPING_FORCE_OFF;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ACTIVITY_MAPPING_FORCE_OFF;
    else process.env.ACTIVITY_MAPPING_FORCE_OFF = OLD;
  });

  it('defaults ON when no config doc exists (standing capability)', async () => {
    delete process.env.ACTIVITY_MAPPING_FORCE_OFF;
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await isActivityMappingEnabled(db)).toBe(true);
  });

  it('honors an explicit runtime pause ({ enabled: false })', async () => {
    delete process.env.ACTIVITY_MAPPING_FORCE_OFF;
    const db = createFakeFirestore();
    db.collection('system_config').doc('activity_mapping').set({ enabled: false });
    expect(await isActivityMappingEnabled(db as unknown as Firestore)).toBe(false);
  });

  it('stays ON when the config doc exists but does not disable', async () => {
    delete process.env.ACTIVITY_MAPPING_FORCE_OFF;
    const db = createFakeFirestore();
    db.collection('system_config').doc('activity_mapping').set({ note: 'hi' });
    expect(await isActivityMappingEnabled(db as unknown as Firestore)).toBe(true);
  });

  it('is hard-killed by the deploy-level env force-off regardless of Firestore', async () => {
    process.env.ACTIVITY_MAPPING_FORCE_OFF = 'true';
    expect(isActivityMappingForcedOff()).toBe(true);
    const db = createFakeFirestore();
    db.collection('system_config').doc('activity_mapping').set({ enabled: true });
    expect(await isActivityMappingEnabled(db as unknown as Firestore)).toBe(false);
  });

  it('fails closed (skips) when the config read throws (Unknown = Block)', async () => {
    delete process.env.ACTIVITY_MAPPING_FORCE_OFF;
    const throwingDb = {
      collection: () => ({ doc: () => ({ get: async () => { throw new Error('firestore down'); } }) }),
    } as unknown as Firestore;
    expect(await isActivityMappingEnabled(throwingDb)).toBe(false);
  });
});
