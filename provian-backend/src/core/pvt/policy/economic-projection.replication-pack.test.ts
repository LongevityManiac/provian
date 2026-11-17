/**
 * The projected (current) attestation tier of a sealed row. A stored Replication Pack lifts a row
 * to `software_verified` only when it is whole: input, output and pack hashes each a SHA-256 digest
 * (the one validator, `replication-pack.ts`). A row SEALED at a tier keeps that tier whatever its
 * stored pack says: the projection never goes below the sealed record tier, and the seal and its
 * snapshot are never rewritten.
 */
import { describe, it, expect } from '@jest/globals';
import type { PEHistoryDocument } from '../../../pe-history';
import { ATTESTATION_HORIZON_CUT_LINE_MS, computeRecordSnapshot, hashRecordEconomicSnapshot } from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { currentAttestationTier } from './economic-projection';
import { hasCompleteReplicationPackHashes, isReplicationPackHash } from './replication-pack';

const RECORDED = ATTESTATION_HORIZON_CUT_LINE_MS + 60_000;
const D = (c: string) => `sha256:${c.repeat(64)}`;
const WHOLE = { input_hash: D('1'), output_hash: `0x${'2'.repeat(64)}`, pack_hash: '3'.repeat(64), model_id: 'provider/model/1', model_checkpoint_hash: null };

function sealedAt(tier: 'software' | 'software_verified', pack: unknown): PEHistoryDocument {
  const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe-1', economicActorId: 'user-1', actionType: 'compute_session', recordedAtMs: RECORDED,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false, attestationTier: tier,
    linkageState: 'unlinked', evidenceState: 'verified', canonicalEventId: 'compute_session:lineage-1',
    selfReferencing: false, sharedBeneficialOwnership: false, pairChurnDetected: false,
    sessionLineageId: 'lineage-1', genesisReservation: null,
  });
  return {
    peId: 'pe-1', userId: 'user-1', actionType: 'compute_session', timestamp: RECORDED,
    attestationDepth: tier, attestation_verified: true, mint_status: 'eligible', mint_disposition: 'eligible',
    record_points_atomic: snapshot.recordPointsAtomic, replication_pack: pack,
    corroboration_status: 'none', corroboration_received_at: null,
    economic_snapshot: snapshot, economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
  } as unknown as PEHistoryDocument;
}

describe('the projected tier of a row carrying a replication pack', () => {
  it('control: a whole pack on a row sealed at software projects software_verified (the lift is reachable)', () => {
    expect(currentAttestationTier(sealedAt('software', WHOLE))).toBe('software_verified');
    expect(currentAttestationTier(sealedAt('software', null))).toBe('software');
  });

  const incomplete: readonly [string, Record<string, unknown>][] = [
    ['no pack_hash (input + output + model_id only)', { ...WHOLE, pack_hash: undefined }],
    ['a null pack_hash', { ...WHOLE, pack_hash: null }],
    ['a pack_hash that is not a digest', { ...WHOLE, pack_hash: 'yes' }],
    ['an input_hash that is not a digest', { ...WHOLE, input_hash: 'x' }],
    ['an output_hash that is not a digest', { ...WHOLE, output_hash: 'y' }],
    ['a short digest', { ...WHOLE, pack_hash: '3'.repeat(63) }],
  ];
  it('the violating population is not empty', () => { expect(incomplete.length).toBeGreaterThan(0); });
  for (const [name, pack] of incomplete) {
    it(`RED: ${name} lifts nothing — the row projects at its sealed tier`, () => {
      expect(currentAttestationTier(sealedAt('software', pack))).toBe('software');
    });
  }

  it('a row sealed at software_verified keeps that tier whatever its stored pack says (sealed values never change)', () => {
    for (const [, pack] of incomplete) expect(currentAttestationTier(sealedAt('software_verified', pack))).toBe('software_verified');
    expect(currentAttestationTier(sealedAt('software_verified', null))).toBe('software_verified');
  });
});

describe('the pack validator is the one device-act uses', () => {
  it('accepts exactly a 64-hex digest, bare or prefixed', () => {
    for (const ok of [D('a'), `0x${'b'.repeat(64)}`, 'C'.repeat(64)]) expect(isReplicationPackHash(ok)).toBe(true);
    for (const bad of ['', 'x', 'a'.repeat(63), 'a'.repeat(65), `sha256:${'g'.repeat(64)}`, 7, null, undefined]) expect(isReplicationPackHash(bad)).toBe(false);
    expect(hasCompleteReplicationPackHashes(WHOLE)).toBe(true);
    expect(hasCompleteReplicationPackHashes(null)).toBe(false);
    expect(hasCompleteReplicationPackHashes({ input_hash: D('1'), output_hash: D('2') })).toBe(false);
  });
});
