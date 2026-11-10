import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  decodePrivateRecord, encodePrivateRecord, isPrivateCollection, privateStorageId,
} from '../provenance/private-store';

// Public rule text and the aggregate reserve ratio contain no ownership links.
const publicCollections = new Set(['recourse_membership_rules_v1', 'recourse_public_resources_v1']);
const collections = [...new Set(readdirSync(__dirname)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .flatMap(name => [...readFileSync(join(__dirname, name), 'utf8')
    .matchAll(/['"](recourse_[a-z_]+_v1)['"]/g)].map(match => match[1])))];

function unprotected(names: readonly string[], predicate = isPrivateCollection): string[] {
  if (names.length === 0) throw new Error('empty_recourse_storage_inventory');
  return names.filter(name => !publicCollections.has(name) && !predicate(name));
}

describe('private recourse ownership storage', () => {
  it('protects every non-public recourse collection referenced by the actual production modules', () => {
    expect(collections.length).toBeGreaterThan(20);
    expect(unprotected(collections)).toEqual([]);
    expect(() => unprotected([])).toThrow('empty_recourse_storage_inventory');
    // A missing recovery store or a future undeclared private collection is RED.
    expect(unprotected(collections, name => name !== 'recourse_break_entitlements_v1' && isPrivateCollection(name)))
      .toEqual(['recourse_break_entitlements_v1']);
    expect(unprotected([...collections, 'recourse_unprotected_owner_links_v1']))
      .toEqual(['recourse_unprotected_owner_links_v1']);
  });

  it.each(collections.filter(name => !publicCollections.has(name)))('%s conceals identifiers and preserves exact recovery records', collection => {
    const id = 'private-owner-linked-record';
    const original = {
      identity: 'private-owner-identity', address: 'private-owner-address',
      destination: 'private-recovery-destination', amountAtomic: '987654321987654321',
      proof: { siblings: ['private-proof-sibling'], intent: 'private-owner-intent' },
    };
    const physicalId = privateStorageId(collection, id);
    const encoded = encodePrivateRecord(collection, id, original);
    expect(JSON.stringify(original)).toContain(original.identity); // Old plaintext control.
    expect(physicalId).not.toContain(id);
    for (const value of [id, original.identity, original.address, original.destination, original.amountAtomic, original.proof.siblings[0]]) {
      expect(JSON.stringify(encoded)).not.toContain(value);
    }
    expect(decodePrivateRecord(collection, physicalId, encoded, {})).toEqual({ id, data: original });
    expect(() => decodePrivateRecord(collection, privateStorageId(collection, 'another-owner'), encoded, {})).toThrow();
    expect(() => decodePrivateRecord(`${collection}_other`, physicalId, encoded, {})).toThrow();
    const corrupted = { ...encoded, body: { ...encoded.body, tag: Buffer.alloc(16) } };
    expect(() => decodePrivateRecord(collection, physicalId, corrupted, {})).toThrow();
  });
});
